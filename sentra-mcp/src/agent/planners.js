import { v4 as uuidv4 } from 'uuid';
import { newStepId } from '../utils/stepIds.js';
import { config, getStageTimeoutMs } from '../config/index.js';
import logger from '../logger/index.js';
import { chatCompletion } from '../openai/client.js';
import { HistoryStore } from '../history/store.js';
import { ok, fail } from '../utils/result.js';
import { summarizeToolHistory } from './summarizer.js';
import { clip } from '../utils/text.js';
import { timeParser } from '../utils/timing.js';
// 规划期与工具清单相关的辅助函数
import { buildPlanningManifest, manifestToBulletedText, buildToolContextSystem } from './plan/manifest.js';
import { buildDependentContextText } from './plan/history.js';
import { loadPrompt, renderTemplate, composeSystem } from './prompts/loader.js';
// 向量记忆：规划/工具检索与写入
import { upsertPlanMemory, upsertToolMemory, searchPlanMemories } from '../memory/index.js';
// 消息和事件工具
import { compactMessages, normalizeConversation } from './utils/messages.js';
import { emitRunEvent, wait, normKey } from './utils/events.js';
import { RunEvents } from '../bus/runEvents.js';
import { generatePlanViaFC } from './plan/plan_fc.js';
import { rerankManifest } from './plan/router.js';
// 各阶段逻辑
import { judgeToolNecessity } from './stages/judge.js';
import { judgeToolNecessityFC } from './stages/judge_fc.js';
import { getPreThought } from './stages/prethought.js';
import { generateToolArgs, validateArgs, fixToolArgs } from './stages/arggen.js';
import { evaluateRun } from './stages/evaluate.js';
import { checkTaskCompleteness } from './stages/reflection.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolDef } from './tools/loader.js';
import { isRunCancelled, clearRunCancelled } from '../bus/runCancel.js';
import { registerRunStart, markRunFinished, removeRun, buildConcurrencyOverlay } from '../bus/runRegistry.js';
import { parseFunctionCalls } from '../utils/fc.js';

function now() { return Date.now(); }

function isPlanPatchEnabled() {
  const s1 = String(config.runner?.enablePlanPatch ?? '').trim().toLowerCase();
  const s2 = String(process.env.ENABLE_PLAN_PATCH ?? '').trim().toLowerCase();
  return s1 === '1' || s1 === 'true' || s1 === 'yes' || s1 === 'on' || s2 === '1' || s2 === 'true' || s2 === 'yes' || s2 === 'on';
}

function normalizePlanStepIds(plan) {
  const p = (plan && typeof plan === 'object') ? plan : { steps: [], manifest: [] };
  const steps = Array.isArray(p.steps) ? p.steps : [];
  const withIds = steps.map((s) => {
    const step = (s && typeof s === 'object') ? s : {};
    const sid = (typeof step.stepId === 'string' && step.stepId.trim()) ? step.stepId.trim() : newStepId();
    return { ...step, stepId: sid };
  });
  const idToIndex = new Map(withIds.map((s, idx) => [s.stepId, idx]));
  const finalSteps = withIds.map((s, idx0) => {
    const rest = s;
    const depsIdsRaw = Array.isArray(rest.dependsOnStepIds) ? rest.dependsOnStepIds : [];
    const cleanedIds = depsIdsRaw
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean)
      .filter((x) => idToIndex.has(x))
      .filter((x) => x !== rest.stepId);
    const uniq = Array.from(new Set(cleanedIds));
    const displayIndex = Number.isFinite(Number(rest.displayIndex)) ? Number(rest.displayIndex) : (idx0 + 1);
    return { ...rest, displayIndex, dependsOnStepIds: uniq.length ? uniq : undefined };
  });

  return { ...p, steps: finalSteps };
}

function mergeGlobalOverlay(context, overlayText) {
  if (!overlayText) return context;
  const ctx0 = (context && typeof context === 'object') ? context : {};
  const po0 = (ctx0.promptOverlays && typeof ctx0.promptOverlays === 'object') ? ctx0.promptOverlays : {};
  const existingGlobal = po0.global;
  const existingSystem = (existingGlobal && typeof existingGlobal === 'object')
    ? (existingGlobal.system || '')
    : (existingGlobal ? String(existingGlobal) : '');
  const mergedSystem = [existingSystem, overlayText].filter(Boolean).join('\n\n');
  const nextGlobal = (existingGlobal && typeof existingGlobal === 'object')
    ? { ...existingGlobal, system: mergedSystem }
    : { system: mergedSystem };
  return { ...ctx0, promptOverlays: { ...po0, global: nextGlobal } };
}

function injectConcurrencyOverlay({ runId, objective, context }) {
  const cid = context?.channelId != null ? String(context.channelId) : '';
  const ik = context?.identityKey != null ? String(context.identityKey) : '';
  if (!cid && !ik) return context;
  const overlay = buildConcurrencyOverlay({ runId, channelId: cid, identityKey: ik, objective });
  return mergeGlobalOverlay(context, overlay);
}

/**
 * 规范化 reason：仅支持数组格式
 * - 数组：过滤并清理每项
 * - 其他：返回空数组（不兼容旧字符串格式）
 */
function normalizeReason(reason) {
  if (Array.isArray(reason)) {
    return reason.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim());
  }

  return [];
}

function shouldTriggerPlanPatch({ result, triggerMode } = {}) {
  const mode = String(triggerMode || '').trim().toLowerCase();
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (!result || typeof result !== 'object') return false;
  if (result.success === false) return true;
  if (result.success === true) return false;
  const code = String(result.code || '').toUpperCase();
  if (code && code !== 'OK' && code !== 'SUCCESS') return true;
  return false;
}

function isResultOk(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.success === false) return false;
  if (result.success === true) return true;
  const code = String(result.code || '').toUpperCase();
  if (!code) return true;
  return code === 'OK' || code === 'SUCCESS';
}

function applyDisplayIndex(steps) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s && typeof s === 'object') {
      s.displayIndex = i + 1;
    }
  }
}

function buildStepIdIndexMap(steps) {
  return new Map((steps || []).map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId : '', idx]).filter(([k]) => k));
}

function sanitizeDependsOnStepIds(step, steps) {
  const m = buildStepIdIndexMap(steps);
  const ids = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
  const cleaned = ids.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).filter((x) => m.has(x));
  const uniq = Array.from(new Set(cleaned));
  step.dependsOnStepIds = uniq.length ? uniq : undefined;
}

function computeDependsOnIndicesFromStep({ step, steps, selfIndex }) {
  const m = buildStepIdIndexMap(steps);
  const out = [];
  if (Array.isArray(step?.dependsOnStepIds) && step.dependsOnStepIds.length) {
    for (const sid of step.dependsOnStepIds) {
      const idx = m.get(sid);
      if (Number.isInteger(idx) && idx >= 0 && idx !== selfIndex) out.push(idx);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function canTargetPending(targetIdx, currentIdx) {
  return Number.isFinite(targetIdx) && targetIdx > currentIdx;
}

function guardPlanPatchOps(ops) {
  const out = [];
  for (const op of (Array.isArray(ops) ? ops : [])) {
    const kind = String(op?.op || '').trim();
    if (!kind) continue;
    if (kind === 'append') {
      const steps = Array.isArray(op?.steps) ? op.steps : [];
      if (steps.length === 0) continue;
      out.push({ op: 'append', steps });
    } else if (kind === 'replace') {
      const targetStepId = typeof op?.targetStepId === 'string' ? op.targetStepId.trim() : '';
      const step = op?.step;
      if (!targetStepId || !step) continue;
      out.push({ op: 'replace', targetStepId, step });
    } else if (kind === 'delete') {
      const targetStepId = typeof op?.targetStepId === 'string' ? op.targetStepId.trim() : '';
      if (!targetStepId) continue;
      out.push({ op: 'delete', targetStepId });
    }
  }
  return out;
}

function normalizePlanPatchStepInput(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  return {
    stepId: typeof s.stepId === 'string' && s.stepId.trim() ? s.stepId.trim() : newStepId(),
    displayIndex: Number.isFinite(Number(s.displayIndex)) ? Number(s.displayIndex) : undefined,
    aiName: typeof s.aiName === 'string' ? s.aiName : '',
    reason: normalizeReason(s.reason),
    draftArgs: (s.draftArgs && typeof s.draftArgs === 'object') ? s.draftArgs : {},
    dependsOnStepIds: Array.isArray(s.dependsOnStepIds)
      ? s.dependsOnStepIds.map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
      : undefined,
    nextStep: typeof s.nextStep === 'string' ? s.nextStep : '',
    skip: s.skip === true,
  };
}

/**
 * 构建依赖图：找出所有依赖某些步骤的下游步骤
 * @param {Array} steps - 计划步骤数组
 * @param {Array<number>} sourceIndices - 源步骤索引数组
 * @returns {Set<number>} 包含源步骤和所有下游依赖步骤的索引集合
 */
function buildDependencyChain(steps, sourceIndices) {
  const result = new Set(sourceIndices);
  const total = steps.length;
  const stepIdToIdx = new Map((steps || []).map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId : '', idx]).filter(([k]) => k));

  // 递归查找下游依赖
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < total; i++) {
      if (result.has(i)) continue; // 已在结果集中

      const step = steps[i];
      const depsIds = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
      const depsIdx = depsIds
        .map((sid) => (typeof sid === 'string' ? stepIdToIdx.get(sid.trim()) : undefined))
        .filter((x) => Number.isInteger(x));

      // 如果该步骤依赖任何已在结果集中的步骤，则添加到结果集
      if (depsIdx.some((d) => result.has(d))) {
        result.add(i);
        changed = true;
      }
    }
  }

  return result;
}

/**
 * 格式化 reason 数组为字符串（用于显示、日志）
 * - 数组：用 '; ' 连接
 * - 其他：返回空字符串
 */
function formatReason(reason) {
  if (Array.isArray(reason) && reason.length > 0) {
    return reason.join('; ');
  }
  return '';
}

// 判断某个工具在使用 schedule 参数时，是否允许“立即执行 + 延迟发送”模式
// 规则：
// - 若在 SCHEDULE_IMMEDIATE_AI_DENYLIST 中，始终视为不允许（仅到点再执行）
// - 若 allowlist 为空，则默认不启用立即执行（保持兼容）
// - 若在 SCHEDULE_IMMEDIATE_AI_ALLOWLIST 中且不在 denylist 中，则启用立即执行
function isImmediateScheduleAllowed(aiName) {
  if (!aiName) return false;
  const schedCfg = config.schedule || {};
  const allow = Array.isArray(schedCfg.immediateAllowlist)
    ? schedCfg.immediateAllowlist
    : (schedCfg.immediateAllowlist ? [schedCfg.immediateAllowlist] : []);
  const deny = Array.isArray(schedCfg.immediateDenylist)
    ? schedCfg.immediateDenylist
    : (schedCfg.immediateDenylist ? [schedCfg.immediateDenylist] : []);

  if (deny.includes(aiName)) return false;
  if (allow.length === 0) return false;
  return allow.includes(aiName);
}

// 清理 context 以供日志记录：省略 promptOverlays 等大字段
function sanitizeContextForLog(context) {
  if (!context || typeof context !== 'object') return context;
  const { promptOverlays, overlays, ...rest } = context;
  const sanitized = { ...rest };
  if (promptOverlays || overlays) {
    sanitized.promptOverlays = '<omitted>';
  }
  return sanitized;
}

// 时间意图现在完全交由模型自行理解与决策，不再在 planner 中做额外的 TimeParser 预判断。

// 多计划生成（native tools 模式）——单次生成一个候选
async function generateSingleNativePlan({ messages, tools, allowedAiNames, temperature, model }) {
  const res = await chatCompletion({
    messages,
    tools,
    tool_choice: { type: 'function', function: { name: 'emit_plan' } },
    temperature,
    timeoutMs: getStageTimeoutMs('plan'),
    model,
  });
  const call = res.choices?.[0]?.message?.tool_calls?.[0];
  let parsed; try { parsed = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { parsed = {}; }
  const stepsArr = Array.isArray(parsed?.steps) ? parsed.steps : [];
  let rawSteps = stepsArr.map((s) => ({
    stepId: (typeof s?.stepId === 'string' && s.stepId.trim()) ? s.stepId.trim() : newStepId(),
    aiName: s?.aiName,
    reason: normalizeReason(s?.reason),
    nextStep: s?.nextStep || '',
    draftArgs: s?.draftArgs || {},
    dependsOnStepIds: Array.isArray(s?.dependsOnStepIds) ? s.dependsOnStepIds : undefined
  }));
  // 过滤未知工具
  const validNames = new Set(allowedAiNames || []);
  const steps = (validNames.size ? rawSteps.filter((s) => s.aiName && validNames.has(s.aiName)) : rawSteps);
  const removedUnknown = steps.length < rawSteps.length;
  return { steps, removedUnknown, parsed };
}

// 候选计划审核与选择（使用 reasoner 模型 + JSON 提示）
async function selectBestNativePlan({ objective, manifest, candidates, context }) {
  try {
    const pa = await loadPrompt('plan_audit');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayAudit = overlays.audit?.system || overlays.plan_audit?.system || overlays.audit || overlays.plan_audit || '';
    const sys = composeSystem(pa.system, [overlayGlobal, overlayAudit].filter(Boolean).join('\n\n'));
    const manifestText = manifestToBulletedText(Array.isArray(manifest) ? manifest : []);
    const candidatesList = candidates.map((c, i) => `#${i}: ${clip(c.steps, 1200)}`).join('\n');
    const baseMsgs = compactMessages([
      { role: 'system', content: sys },
      { role: 'user', content: renderTemplate(pa.user_goal, { objective }) },
      { role: 'assistant', content: renderTemplate(pa.assistant_manifest, { manifestBulleted: manifestText }) },
      { role: 'user', content: renderTemplate(pa.user_candidates, { candidatesList }) },
      { role: 'user', content: pa.user_request },
    ]);

    // 审核开关：关闭时直接选择 #0
    if (!config.planner?.auditEnable) {
      return { index: 0, audit: 'audit disabled' };
    }

    // 定义 select_plan 工具（Native tools 模式）
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const selectPlanTool = await loadToolDef({
      baseDir: __dirname,
      toolPath: './tools/internal/select_plan.tool.json',
      schemaPath: './tools/internal/select_plan.schema.json',
      fallbackTool: {
        type: 'function',
        function: {
          name: 'select_plan',
          description: '从多份候选计划中选出最佳方案并说明理由',
          parameters: { type: 'object', properties: {} }
        }
      },
      fallbackSchema: {
        type: 'object',
        properties: {
          best: { type: 'integer', minimum: 0 },
          reason: { type: 'string' }
        },
        required: ['best'],
        additionalProperties: true
      }
    });
    const tools = [selectPlanTool];
    const temperature = Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1);
    const res = await chatCompletion({
      messages: baseMsgs,
      tools,
      tool_choice: { type: 'function', function: { name: 'select_plan' } },
      temperature,
      timeoutMs: getStageTimeoutMs('plan')
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    let parsed; try { parsed = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { parsed = {}; }
    let idx = Number(parsed?.best);
    let reason = String(parsed?.reason || '');
    if (!Number.isFinite(idx)) idx = 0;
    idx = Math.max(0, Math.min(candidates.length - 1, idx));
    return { index: idx, audit: reason };
  } catch (e) {
    logger.warn?.('Native 多计划审核失败，回退到候选#0', { label: 'PLAN', error: String(e) });
    return { index: 0, audit: '' };
  }
}

export async function generatePlan(objective, mcpcore, context = {}, conversation) {
  const strategy = String(config.llm?.toolStrategy || 'auto');
  let removedUnknown = false;
  let parsed;
  if (strategy === 'fc') {
    return generatePlanViaFC(objective, mcpcore, context, conversation);
  }
  let manifest = buildPlanningManifest(mcpcore);

  // 先进行一次“预思考”，可配置关闭该步骤
  const usePT = !!config.flags?.planUsePreThought;
  const preThought = usePT ? (await getPreThought(objective, manifest, conversation)) : '';

  // 重排序：仅使用 objective
  try {
    if (objective && (config.rerank?.enable !== false)) {
      const ranked = await rerankManifest({
        manifest,
        objective,
        candidateK: config.rerank?.candidateK,
        topN: config.rerank?.topN
      });
      if (Array.isArray(ranked?.manifest) && ranked.manifest.length) {
        manifest = ranked.manifest;
        if (config.flags.enableVerboseSteps) {
          const tops = manifest.slice(0, Math.min(5, manifest.length)).map(x => x.aiName);
          logger.info('规划前重排序Top工具', { label: 'RERANK', top: tops });
        }
      }
    }
  } catch (e) {
    logger.warn?.('规划前重排序失败（忽略并继续）', { label: 'RERANK', error: String(e) });
  }

  // 枚举合法 aiName，限制模型只能选择清单内工具（此时 manifest 已是 Top-N）
  // 如果上游传入了 judgeToolNames，则优先使用它做白名单过滤，减少规划期“污染/跑偏”。
  const allowedAiNamesAll = (manifest || []).map((m) => m.aiName).filter(Boolean);
  const judgeToolNames = (context?.judge && Array.isArray(context.judge.toolNames))
    ? context.judge.toolNames
    : (Array.isArray(context?.judgeToolNames) ? context.judgeToolNames : []);

  const judgeToolSet = new Set((judgeToolNames || []).filter(Boolean));
  const allowedByJudge = (judgeToolSet.size > 0)
    ? allowedAiNamesAll.filter((n) => judgeToolSet.has(n))
    : [];
  const allowedAiNames = (judgeToolSet.size > 0 && allowedByJudge.length > 0)
    ? allowedByJudge
    : allowedAiNamesAll;

  if (judgeToolSet.size > 0) {
    // 同步缩减 manifest，保证后续 allowedAiNames 与 manifest 一致
    const filtered = (manifest || []).filter((m) => m && m.aiName && judgeToolSet.has(m.aiName));
    if (filtered.length > 0) {
      manifest = filtered;
    }
  }
  const validNames = new Set(allowedAiNames || []);

  // force LLM to emit a plan via function call (schema/tool loaded from JSON via loader)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const emitPlanTool = await loadToolDef({
    baseDir: __dirname,
    toolPath: './tools/internal/emit_plan.tool.json',
    schemaPath: './tools/internal/emit_plan.schema.json',
    mutateSchema: (schema) => {
      const aiNameProp = schema?.properties?.steps?.items?.properties?.aiName;
      if (aiNameProp && Array.isArray(allowedAiNames)) aiNameProp.enum = allowedAiNames;
    },
    fallbackTool: {
      type: 'function',
      function: {
        name: 'emit_plan',
        description: '产出工具执行顺序的 JSON 计划。每一步仅包含一个工具(aiName)与draftArgs(仅需包含必填字段)。',
        parameters: { type: 'object', properties: {} }
      }
    },
    fallbackSchema: {
      type: 'object',
      properties: {
        overview: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: { aiName: { type: 'string' } },
            required: ['aiName']
          }
        }
      },
      required: ['steps']
    },
  });
  const tools = [emitPlanTool];
  // 加载 emit_plan 提示模板，构造消息
  const ep = await loadPrompt('emit_plan');
  const overlays = (context?.promptOverlays || context?.overlays || {});
  const overlayGlobal = overlays.global?.system || overlays.global || '';
  const overlayPlan = overlays.plan?.system || overlays.emit_plan?.system || overlays.plan || overlays.emit_plan || '';
  const sys = [
    composeSystem(ep.system, [overlayGlobal, overlayPlan].filter(Boolean).join('\n\n')),
    ep.concurrency_hint || ''
  ].filter(Boolean).join('\n\n');
  // 检索历史规划记忆（相似目标的成功计划），作为参考上下文
  let planMemoryMsgs = [];
  if (config.memory?.enable) {
    const mems = await searchPlanMemories({ objective });
    if (Array.isArray(mems) && mems.length) {
      const lines = mems.map((m, idx) => `#${idx + 1} (score=${m.score.toFixed(2)}):\n${m.text}`).join('\n\n');
      planMemoryMsgs.push({ role: 'assistant', content: `历史规划参考:\n${lines}` });
      if (config.flags.enableVerboseSteps) {
        logger.info('检索到历史规划参考', { label: 'MEM', hits: mems.length, topScore: Number(mems[0]?.score?.toFixed?.(2) || 0), minScore: config.memory.minScore });
      }
    }
  }
  const conv = normalizeConversation(conversation);
  // 生成 base messages（供单/多候选共用）
  const baseMessages = compactMessages([
    { role: 'system', content: sys },
    ...conv,
    { role: 'user', content: renderTemplate(ep.user_goal, { objective }) },
    ...(usePT ? [
      { role: 'assistant', content: renderTemplate(ep.assistant_thought, { preThought: preThought || '' }) },
    ] : []),
    { role: 'assistant', content: renderTemplate(ep.assistant_manifest, { manifestBulleted: manifestToBulletedText(manifest) }) },
    ...planMemoryMsgs,
    { role: 'user', content: ep.user_request }
  ]);

  const planModelsRaw = Array.isArray(config.plan?.models) ? config.plan.models : [];
  const planModels = planModelsRaw.filter((m) => typeof m === 'string' && m.trim());
  const uniquePlanModels = Array.from(new Set(planModels)).slice(0, 5);
  const planModel = String(config.plan?.model || config.llm?.model || 'grok-4.1');

  // allowedAiNames 已在上文声明，直接复用
  const enableMulti = !!config.planner?.multiEnable && Number(config.planner?.multiCandidates || 0) > 1;
  let steps = [];
  if (enableMulti) {
    if (uniquePlanModels.length > 1) {
      const candidatesByModel = [];
      for (const m of uniquePlanModels) {
        try {
          const one = await generateSingleNativePlan({
            messages: baseMessages,
            tools,
            allowedAiNames,
            temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1),
            model: m,
          });
          if (Array.isArray(one?.steps) && one.steps.length > 0) {
            candidatesByModel.push({ steps: one.steps || [], removedUnknown: !!one.removedUnknown, parsed: one.parsed, model: m });
          }
        } catch { }
      }
      if (candidatesByModel.length === 0) {
        const one = await generateSingleNativePlan({ messages: baseMessages, tools, allowedAiNames, temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1), model: planModel });
        steps = one.steps || [];
        removedUnknown = !!one.removedUnknown;
        parsed = one.parsed;
      } else if (candidatesByModel.length === 1) {
        steps = candidatesByModel[0].steps || [];
        removedUnknown = !!candidatesByModel[0].removedUnknown;
        parsed = candidatesByModel[0].parsed;
      } else {
        const pick = await selectBestNativePlan({ objective, manifest, candidates: candidatesByModel, context });
        const idx = Math.max(0, Math.min(candidatesByModel.length - 1, Number(pick.index) || 0));
        const best = candidatesByModel[idx];
        steps = best.steps || [];
        removedUnknown = !!best.removedUnknown;
        parsed = best.parsed;
        if (config.flags.enableVerboseSteps) {
          logger.info('Native 多模型规划：选择候选', { label: 'PLAN', index: idx, model: best.model, audit: clip(String(pick.audit || ''), 360) });
        }
        try {
          if (context?.runId) {
            await HistoryStore.append(context.runId, { type: 'plan_audit', mode: 'native', candidates: candidatesByModel.length, chosenIndex: idx, chosenModel: best.model, reason: String(pick.audit || '') });
          }
        } catch { }
      }
    } else {
      const K = Math.max(2, Math.min(5, Number(config.planner.multiCandidates || 3)));
      const half = Math.ceil(K / 2);
      const minWait = Math.max(0, Number(config.planner?.candidateMinTimeoutMs ?? 3000));
      const maxWait = Math.max(minWait, Number(config.planner?.candidateMaxTimeoutMs ?? 25000));
      const factor = Number.isFinite(config.planner?.candidateTimeFactor) ? Number(config.planner.candidateTimeFactor) : 1.25;
      const extra = 1 + 0.25 * (K - half);
      const queue = [];
      const resolvers = [];
      function push(x) { const r = resolvers.shift(); if (r) r(x); else queue.push(x); }
      function next() { if (queue.length) return Promise.resolve(queue.shift()); return new Promise(res => resolvers.push(res)); }
      const startedAt = now();
      let finished = 0;
      const done = [];
      let deadline = 0;

      const tasks = [];
      for (let i = 0; i < K; i++) {
        const diversifyHint = `多方案生成：这是变体 #${i + 1}。请提供与其它变体差异明显且可执行的计划，步骤不超过 ${Math.max(1, Number(config.planner?.maxSteps || 8))} 步。`;
        const msgs = compactMessages([...baseMessages, { role: 'user', content: diversifyHint }]);
        const t0 = now();
        const p = generateSingleNativePlan({ messages: msgs, tools, allowedAiNames, temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1 + Math.min(0.3, 0.03 * i)), model: planModel })
          .then((res) => ({ ok: true, res, i, ms: now() - t0 }))
          .catch(() => ({ ok: false, res: null, i, ms: now() - t0 }))
          .then((r) => { push(r); return r; });
        tasks.push(p);
      }

      while (finished < K) {
        let waiter;
        if (deadline > 0) {
          const remain = Math.max(0, deadline - now());
          waiter = Promise.race([next(), new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remain))]);
        } else {
          waiter = next();
        }
        const evt = await waiter;
        if (evt && evt.timeout) break;
        if (!evt) break;
        finished += 1;
        if (evt.ok && evt.res && Array.isArray(evt.res.steps) && evt.res.steps.length > 0) done.push(evt);
        if (done.length === half && deadline === 0) {
          const mean = done.reduce((s, x) => s + Number(x.ms || 0), 0) / Math.max(1, done.length);
          const waitMs = Math.max(minWait, Math.min(maxWait, mean * factor * extra));
          if (config.flags.enableVerboseSteps) {
            logger.info('Native 多计划：达到50%完成阈值，进入动态等待', { label: 'PLAN', K, half, meanMs: Math.round(mean), waitMs: Math.round(waitMs) });
          }
          deadline = now() + waitMs;
        }
      }

      const candidates = done
        .map((d) => ({ steps: Array.isArray(d.res.steps) ? d.res.steps : [], removedUnknown: !!d.res.removedUnknown, parsed: d.res.parsed }))
        .filter((c) => c.steps.length > 0);
      if (config.flags.enableVerboseSteps) {
        logger.info('Native 多计划：生成候选数量', { label: 'PLAN', count: candidates.length });
      }
      if (candidates.length === 0) {
        // 回退到单次生成
        const one = await generateSingleNativePlan({ messages: baseMessages, tools, allowedAiNames, temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1), model: planModel });
        steps = one.steps || [];
        removedUnknown = !!one.removedUnknown;
        parsed = one.parsed;
      } else if (candidates.length === 1) {
        steps = candidates[0].steps || [];
        removedUnknown = !!candidates[0].removedUnknown;
        parsed = candidates[0].parsed;
      } else {
        const pick = await selectBestNativePlan({ objective, manifest, candidates, context });
        const idx = Math.max(0, Math.min(candidates.length - 1, Number(pick.index) || 0));
        steps = candidates[idx].steps || [];
        removedUnknown = !!candidates[idx].removedUnknown;
        parsed = candidates[idx].parsed;
        if (config.flags.enableVerboseSteps) {
          logger.info('Native 多计划：选择候选', { label: 'PLAN', index: idx, audit: clip(String(pick.audit || ''), 360) });
        }
        try {
          if (context?.runId) {
            await HistoryStore.append(context.runId, { type: 'plan_audit', mode: 'native', candidates: candidates.length, chosenIndex: idx, reason: String(pick.audit || '') });
          }
        } catch { }
      }
    }
  } else {
    // 原有单计划路径
    const isValid = (x) => Array.isArray(x?.steps) && x.steps.length > 0;
    const temperature = Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1);
    const t0 = now();
    if (config.flags.enableVerboseSteps) {
      logger.info('Native 规划：LLM plan begin', { label: 'PLAN', mode: 'race2', model: planModel });
    }
    const tasks = [0, 1].map((i) => {
      const ti = now();
      return generateSingleNativePlan({ messages: baseMessages, tools, allowedAiNames, temperature, model: planModel })
        .then((res) => ({ ok: true, res, i, ms: now() - ti }))
        .catch((err) => ({ ok: false, res: null, i, ms: now() - ti, error: String(err || '') }));
    });

    let pick = await Promise.race(tasks);
    if (!pick?.ok || !isValid(pick?.res)) {
      try {
        const other = await tasks[1 - (Number(pick?.i) || 0)];
        if (other?.ok && isValid(other?.res)) {
          pick = other;
        }
      } catch { }
    }

    const one = pick?.ok ? (pick?.res || {}) : {};
    if (config.flags.enableVerboseSteps) {
      logger.info('Native 规划：LLM plan end', {
        label: 'PLAN',
        mode: 'race2',
        model: planModel,
        ms: now() - t0,
        picked: Number.isInteger(pick?.i) ? pick.i : -1,
        pickedMs: Number.isFinite(pick?.ms) ? pick.ms : -1,
        steps: Array.isArray(one?.steps) ? one.steps.length : 0,
      });
    }
    steps = one.steps || [];
    removedUnknown = !!one.removedUnknown;
    parsed = one.parsed;
  }
  // Auto fallback to function_call planning when native tool-call produced empty plan
  if (strategy === 'auto' && steps.length === 0) {
    try {
      const alt = await generatePlanViaFC(objective, mcpcore, context, conversation);
      if (Array.isArray(alt?.steps) && alt.steps.length) {
        steps = alt.steps;
      }
    } catch (e) {
      logger.warn?.('FC 规划回退失败（忽略）', { label: 'PLAN', error: String(e) });
    }
  }

  // 若剔除未知工具后为空或发生剔除，触发一次严格重规划（仅允许 allowedAiNames）
  if (steps.length === 0 || removedUnknown) {
    try {
      if (config.flags.enableVerboseSteps) {
        const allSteps = Array.isArray(parsed?.steps)
          ? parsed.steps
          : [];
        const dropped = allSteps.filter((s) => !validNames.has(s?.aiName)).map((s) => s?.aiName);
        logger.warn?.('触发严格重规划：上次计划包含未知工具或为空', { label: 'PLAN', dropped, allowedAiNames });
      }
      const replanMessages2 = compactMessages([
        { role: 'system', content: sys },
        { role: 'user', content: renderTemplate(ep.user_goal, { objective }) },
        ...(usePT ? [
          { role: 'assistant', content: renderTemplate(ep.assistant_thought, { preThought: preThought || '' }) },
        ] : []),
        { role: 'assistant', content: renderTemplate(ep.assistant_manifest, { manifestBulleted: manifestToBulletedText(manifest) }) },
        { role: 'assistant', content: '严格约束：只能从以下 aiName 中选择，并且每步仅包含一个工具。若无合适工具可输出空计划。可选 aiName 列表:\n' + (allowedAiNames.join(', ')) },
        { role: 'user', content: ep.user_request }
      ]);
      const re2 = await chatCompletion({
        messages: replanMessages2,
        tools,
        tool_choice: { type: 'function', function: { name: 'emit_plan' } },
        temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1),
        timeoutMs: getStageTimeoutMs('plan'),
        model: planModel
      });
      const rcall2 = re2.choices?.[0]?.message?.tool_calls?.[0];
      let reparsed2; try { reparsed2 = rcall2?.function?.arguments ? JSON.parse(rcall2.function.arguments) : {}; } catch { reparsed2 = {}; }
      const stepsArr2 = Array.isArray(reparsed2?.steps) ? reparsed2.steps : [];
      let rsteps2 = stepsArr2.map((s) => ({
        stepId: (typeof s?.stepId === 'string' && s.stepId.trim()) ? s.stepId.trim() : newStepId(),
        aiName: s?.aiName,
        reason: normalizeReason(s?.reason),
        nextStep: s?.nextStep || '',
        draftArgs: s?.draftArgs || {},
        dependsOnStepIds: Array.isArray(s?.dependsOnStepIds) ? s.dependsOnStepIds : undefined
      }));
      const rfiltered2 = rsteps2.filter((s) => s.aiName && validNames.has(s.aiName));
      steps = rfiltered2;
    } catch (e) {
      logger.warn?.('严格重规划异常（忽略）', { label: 'PLAN', error: String(e) });
    }
  }

  // 依赖校验（stepId-only）：
  // - dependsOnStepIds 只能引用“前序步骤”的 stepId（保证无环）
  // - 禁止自依赖
  // - 依赖 stepId 必须存在
  const validateDependsOnStepIds = (arr) => {
    const stepIdToIndex = new Map((arr || []).map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId.trim() : '', idx]).filter(([k]) => k));
    let invalid = false;
    for (let i = 0; i < (arr || []).length; i++) {
      const s = arr[i] || {};
      const sid = typeof s?.stepId === 'string' ? s.stepId.trim() : '';
      const raw = Array.isArray(s?.dependsOnStepIds) ? s.dependsOnStepIds : [];
      const cleaned = [];
      for (const d of raw) {
        const depId = typeof d === 'string' ? d.trim() : '';
        if (!depId) { invalid = true; continue; }
        if (depId === sid) { invalid = true; continue; }
        const di = stepIdToIndex.get(depId);
        if (!Number.isInteger(di)) { invalid = true; continue; }
        if (di >= i) { invalid = true; continue; }
        cleaned.push(depId);
      }
      const uniq = Array.from(new Set(cleaned));
      s.dependsOnStepIds = uniq.length ? uniq : undefined;
    }
    return { ok: !invalid, invalidRefs: invalid };
  };

  let vres = validateDependsOnStepIds(steps);
  if (!vres.ok) {
    logger.warn?.('规划依赖校验未通过（dependsOnStepIds），尝试一次重规划', { label: 'PLAN', invalidRefs: vres.invalidRefs });
    // 一次性重规划：追加严格依赖约束
    const replanMessages = compactMessages([
      { role: 'system', content: sys },
      { role: 'user', content: renderTemplate(ep.user_goal, { objective }) },
      ...(usePT ? [
        { role: 'assistant', content: renderTemplate(ep.assistant_thought, { preThought: preThought || '' }) },
      ] : []),
      { role: 'assistant', content: renderTemplate(ep.assistant_manifest, { manifestBulleted: manifestToBulletedText(manifest) }) },
      { role: 'assistant', content: '上一个计划的 dependsOnStepIds 存在无效引用/自依赖/引用非前序步骤的问题。请重新生成一个满足以下严格约束的计划：\n1) 每一步的 dependsOnStepIds 只能引用前序步骤（在 steps 数组中排在当前步之前）的 stepId；\n2) 禁止自依赖；\n3) 若不需要依赖请省略 dependsOnStepIds 字段；\n4) 每一步必须提供唯一的 stepId；\n5) 仅输出必需字段并符合 emit_plan 的 JSON 结构。' },
      { role: 'user', content: ep.user_request }
    ]);
    const re = await chatCompletion({
      messages: replanMessages,
      tools,
      tool_choice: { type: 'function', function: { name: 'emit_plan' } },
      temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1),
      timeoutMs: getStageTimeoutMs('plan'),
      model: planModel
    });
    const rcall = re.choices?.[0]?.message?.tool_calls?.[0];
    let reparsed; try { reparsed = rcall?.function?.arguments ? JSON.parse(rcall.function.arguments) : {}; } catch { reparsed = {}; }
    const stepsArr = Array.isArray(reparsed?.steps) ? reparsed.steps : [];
    let rsteps = stepsArr.map((s) => ({
      stepId: (typeof s?.stepId === 'string' && s.stepId.trim()) ? s.stepId.trim() : newStepId(),
      aiName: s?.aiName,
      reason: normalizeReason(s?.reason),
      nextStep: s?.nextStep || '',
      draftArgs: s?.draftArgs || {},
      dependsOnStepIds: Array.isArray(s?.dependsOnStepIds) ? s.dependsOnStepIds : undefined
    }));
    // 过滤未知工具
    const rfiltered = rsteps.filter((s) => s.aiName && validNames.has(s.aiName));
    rsteps = rfiltered;
    const v2 = validateDependsOnStepIds(rsteps);
    if (v2.ok) {
      steps = rsteps;
      logger.info('重规划成功，依赖校验通过', { label: 'PLAN', steps: steps.length });
    } else {
      logger.warn?.('重规划仍未通过依赖校验，将执行兜底修正', { label: 'PLAN' });
      // 兜底修正：移除全部 dependsOnStepIds，避免运行期死锁
      steps = (steps || []).map((s) => ({ ...s, dependsOnStepIds: undefined }));
    }
  }

  if (config.flags.enableVerboseSteps) {
    logger.info(`规划生成: 共 ${steps.length} 步`, { label: 'PLAN', stepsPreview: clip(steps) });
  }

  // 记忆：保存本次规划（目标与步骤概览），供后续相似任务参考
  if (config.memory?.enable) {
    try { await upsertPlanMemory({ runId: context?.runId || 'unknown', objective, plan: { steps } }); } catch { }
  }

  return { manifest, steps };
}

export async function executePlan(runId, objective, mcpcore, plan, opts = {}) {
  // We'll build a per-step tool schema to reduce ambiguity
  const recentResults = Array.isArray(opts.seedRecent) ? [...opts.seedRecent] : [];
  const context = opts.context || {};
  const startIndex = Math.max(0, Number(opts.startIndex) || 0);
  // 中文：重试模式 - 仅执行指定的失败步骤
  const retrySteps = Array.isArray(opts.retrySteps) ? new Set(opts.retrySteps.map(Number)) : null;
  const enablePlanPatchHook = isPlanPatchEnabled() && !retrySteps;
  const triggerMode = String(config.runner?.planPatchTriggerMode || process.env.PLAN_PATCH_TRIGGER_MODE || 'on_error');
  const maxPatches = 12;
  const maxPlanPatchCalls = 40;
  let appliedPatches = 0;
  let planPatchCalls = 0;
  let stopRequested = false;
  let pauseForPlanPatch = false;
  let pendingPlanPatch = null;
  const retryBudgetByStepId = new Map();
  const initialPlanSnapshot = enablePlanPatchHook
    ? JSON.parse(JSON.stringify(plan && typeof plan === 'object' ? plan : { manifest: [], steps: [] }))
    : null;
  const used = [];
  let succeeded = 0;
  const conv = normalizeConversation(opts.conversation);

  // 重试模式下，跟踪已执行步骤的成功/失败状态，用于智能跳过依赖失败的步骤
  const stepStatus = new Map(); // stepIndex -> { success: boolean, reason: string }

  let total = plan.steps.length;
  const maxConc = Math.max(1, Number(config.planner?.maxConcurrency ?? 3));
  const finished = new Set();
  const started = new Set();
  const delayUntil = new Map(); // stepIndex -> epochMs when it becomes schedulable
  const runningByTool = new Map(); // aiName -> count
  const runningByProvider = new Map(); // providerKey -> count

  // 中文：全局执行计数器，记录实际执行顺序（按完成时间）
  let nextExecutionIndex = 0;

  // 工具元信息（provider 等）及并发上限
  const toolList = mcpcore.getAvailableTools();
  const toolMeta = new Map(toolList.map((t) => [t.aiName, { provider: t.provider || 'local' }]));
  // 中文：详细工具表（含 meta），用于在事件中继承插件 meta
  const toolMetaMap = new Map((mcpcore.getAvailableToolsDetailed?.() || []).map((t) => [t.aiName, t.meta || {}]));
  const toolConcDefault = Math.max(1, Number(config.planner?.toolConcurrencyDefault || 1));
  const provConcDefault = Math.max(1, Number(config.planner?.providerConcurrencyDefault || 4));
  const toolOverride = config.planner?.toolConcurrency || {};
  const provOverride = config.planner?.providerConcurrency || {};
  const getToolLimit = (aiName) => Number(toolOverride[normKey(aiName)] ?? toolConcDefault);
  const getProvLimit = (provLabel) => Number(provOverride[normKey(provLabel)] ?? provConcDefault);

  let depsArr = [];
  let revDepsArr = [];
  let groupOf = [];
  let groups = [];
  let groupPending = new Map();
  let nextGroupToFlush = 0;
  const groupBuffers = new Map();
  const groupArgsBuffers = new Map();

  const forceFlushAllBuffersAsSingleEvents = () => {
    for (const [, buf] of groupArgsBuffers.entries()) {
      for (const [, ev] of buf.entries()) {
        emitRunEvent(runId, ev);
      }
    }
    for (const [, buf] of groupBuffers.entries()) {
      for (const [, ev] of buf.entries()) {
        emitRunEvent(runId, ev);
      }
    }
    groupArgsBuffers.clear();
    groupBuffers.clear();
  };

  const rebuildGroupingState = () => {
    total = plan.steps.length;
    depsArr = plan.steps.map((s, idx) => computeDependsOnIndicesFromStep({ step: s, steps: plan.steps, selfIndex: idx }));
    revDepsArr = Array.from({ length: total }, () => []);
    for (let i = 0; i < total; i++) {
      for (const d of depsArr[i]) revDepsArr[d].push(i);
    }
    const undirected = Array.from({ length: total }, () => new Set());
    for (let i = 0; i < total; i++) {
      for (const d of depsArr[i]) { undirected[i].add(d); undirected[d].add(i); }
    }
    groupOf = new Array(total).fill(null);
    groups = [];
    for (let i = 0; i < total; i++) {
      if (groupOf[i] !== null) continue;
      const gid = groups.length;
      const nodes = [];
      const q = [i];
      groupOf[i] = gid;
      while (q.length) {
        const u = q.shift();
        nodes.push(u);
        for (const v of undirected[u]) {
          if (groupOf[v] === null) {
            groupOf[v] = gid;
            q.push(v);
          }
        }
      }
      groups.push({ id: gid, nodes, flushed: false });
    }
    groupPending = new Map(groups.map((g) => {
      const remaining = (g.nodes || []).filter((idx) => !finished.has(idx)).length;
      return [g.id, remaining];
    }));
    nextGroupToFlush = 0;
    groupArgsBuffers.clear();
    groupBuffers.clear();
    for (const s of (plan.steps || [])) {
      sanitizeDependsOnStepIds(s, plan.steps);
    }
    applyDisplayIndex(plan.steps);
  };

  rebuildGroupingState();

  const buildPlanPatchContext = async (atIndex) => {
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    const currentStep = steps[Number(atIndex)] || {};
    const dependsOnStepIds = Array.isArray(currentStep?.dependsOnStepIds) ? currentStep.dependsOnStepIds : [];
    const planStepIdToIdx = buildStepIdIndexMap(steps);

    const dependencyChain = new Set();
    const addDependencies = (stepIdx) => {
      if (dependencyChain.has(stepIdx)) return;
      dependencyChain.add(stepIdx);
      const step = steps[stepIdx] || {};
      const deps = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
      for (const sid of deps) {
        const k = typeof sid === 'string' ? sid.trim() : '';
        const idx = planStepIdToIdx.get(k);
        if (Number.isFinite(idx) && idx >= 0 && idx < Number(atIndex)) {
          addDependencies(idx);
        }
      }
    };

    for (const sid of dependsOnStepIds) {
      const k = typeof sid === 'string' ? sid.trim() : '';
      const idx = planStepIdToIdx.get(k);
      if (Number.isFinite(idx) && idx >= 0 && idx < Number(atIndex)) {
        addDependencies(idx);
      }
    }

    const allowed = new Set();
    for (let i = 0; i < Number(atIndex); i++) {
      if (dependencyChain.size > 0) {
        if (dependencyChain.has(i)) allowed.add(i);
      } else {
        allowed.add(i);
      }
    }

    const keepTypes = new Set(['tool_result', 'arggen_error', 'tool_error', 'retry_begin', 'retry_done', 'plan_patch']);
    const hist = await HistoryStore.list(runId, 0, -1);
    const filtered = (Array.isArray(hist) ? hist : []).filter((h) => keepTypes.has(String(h?.type || '')));

    const lastToolByIndex = new Map();
    for (const h of filtered) {
      if (h.type !== 'tool_result') continue;
      const idx = Number(h.plannedStepIndex);
      if (!Number.isFinite(idx)) continue;
      if (!allowed.has(idx)) continue;
      lastToolByIndex.set(idx, h);
    }

    const toolCtx = Array.from(lastToolByIndex.keys())
      .sort((a, b) => a - b)
      .map((idx) => lastToolByIndex.get(idx))
      .filter(Boolean);

    const metaCtx = filtered.filter((h) => h.type !== 'tool_result');
    const historyContext = [...metaCtx, ...toolCtx];
    return { toolCtx, historyContext };
  };

  const maybeProcessPendingPlanPatch = async () => {
    if (!enablePlanPatchHook) return;
    if (!pauseForPlanPatch) return;
    if (!pendingPlanPatch) return;
    if (planPatchCalls >= maxPlanPatchCalls) { pauseForPlanPatch = false; pendingPlanPatch = null; return; }
    if (appliedPatches >= maxPatches) { pauseForPlanPatch = false; pendingPlanPatch = null; return; }

    const { atIndex, atStepId, aiName, lastResult, trigger } = pendingPlanPatch;
    pauseForPlanPatch = false;
    pendingPlanPatch = null;

    let patch;
    let toolCtx = [];
    let historyContext = [];
    try {
      const built = await buildPlanPatchContext(atIndex);
      toolCtx = built.toolCtx;
      historyContext = built.historyContext;
    } catch { }

    try {
      const { maybePlanPatch } = await import('./stages/plan_patch.js');
      planPatchCalls += 1;
      patch = await maybePlanPatch({
        runId,
        objective,
        plan,
        currentIndex: atIndex,
        lastResult,
        mcpcore,
        conversation: conv,
        context,
        initialPlan: initialPlanSnapshot,
        recentContext: toolCtx,
        historyContext,
        trigger,
      });
    } catch (e) {
      logger.warn?.('PlanPatch invocation failed (ignored)', { label: 'PLAN_PATCH', runId, error: String(e) });
      return;
    }

    const action = String(patch?.action || 'continue');
    const isComplete = patch?.isComplete === true;
    if (action === 'stop' || isComplete) {
      stopRequested = true;
      const patchEvent = { type: 'plan_patch', action: 'stop', reason: String(patch?.reason || ''), atIndex, atStepId, isComplete };
      emitRunEvent(runId, patchEvent);
      await HistoryStore.append(runId, patchEvent);
      return;
    }
    if (action !== 'patch') return;

    const ops = guardPlanPatchOps(patch?.operations);
    if (!ops.length) return;

    forceFlushAllBuffersAsSingleEvents();

    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    const stepIdToIdx = buildStepIdIndexMap(steps);
    const currentBudget = retryBudgetByStepId.has(atStepId) ? retryBudgetByStepId.get(atStepId) : 1;
    let consumedRetryBudget = false;

    for (const op of ops) {
      if (op.op === 'append') {
        const rawNewSteps = (op.steps || []);
        const newSteps = [];
        let retryAppendedForThisFailure = false;
        for (const x of rawNewSteps) {
          const rawAiName = String(x?.aiName || '');
          const isSameToolAsFail = rawAiName === String(aiName);
          const rawDepends = Array.isArray(x?.dependsOnStepIds)
            ? x.dependsOnStepIds.map((d) => (typeof d === 'string' ? d.trim() : '')).filter(Boolean)
            : [];
          const retryDepends = isSameToolAsFail
            ? Array.from(new Set([atStepId, ...rawDepends]))
            : rawDepends;
          const isRetry = isSameToolAsFail && retryDepends.includes(atStepId);
          if (isRetry && currentBudget <= 0) continue;
          if (isRetry && retryAppendedForThisFailure) continue;
          const s0 = normalizePlanPatchStepInput(x);
          if (isRetry) {
            s0.dependsOnStepIds = retryDepends;
            retryAppendedForThisFailure = true;
            consumedRetryBudget = true;
          }
          s0.stepId = newStepId();
          newSteps.push(s0);
        }
        for (const ns of newSteps) {
          steps.push(ns);
        }
      } else if (op.op === 'replace') {
        const targetIdx = stepIdToIdx.get(op.targetStepId);
        if (!canTargetPending(targetIdx, atIndex)) continue;
        if (started.has(targetIdx) || finished.has(targetIdx)) continue;
        const current = steps[targetIdx];
        if (!current || current.skip === true) continue;
        const next = normalizePlanPatchStepInput(op.step);
        current.aiName = next.aiName;
        current.reason = next.reason;
        current.draftArgs = next.draftArgs;
        current.dependsOnStepIds = next.dependsOnStepIds;
        current.nextStep = next.nextStep;
        current.skip = false;
      } else if (op.op === 'delete') {
        const targetIdx = stepIdToIdx.get(op.targetStepId);
        if (!canTargetPending(targetIdx, atIndex)) continue;
        if (started.has(targetIdx) || finished.has(targetIdx)) continue;
        const current = steps[targetIdx];
        if (!current) continue;
        current.skip = true;
      }
    }

    if (consumedRetryBudget && currentBudget > 0) {
      retryBudgetByStepId.set(atStepId, currentBudget - 1);
    }
    appliedPatches += 1;

    plan.steps = steps;
    total = steps.length;
    await HistoryStore.setPlan(runId, plan);
    const patchEvent = { type: 'plan_patch', action: 'patch', reason: String(patch?.reason || ''), operations: ops, atIndex, atStepId };
    emitRunEvent(runId, patchEvent);
    await HistoryStore.append(runId, patchEvent);

    rebuildGroupingState();
  };

  const topoOrderForGroup = (gid) => {
    const nodes = groups[gid]?.nodes || [];
    const inSet = new Set(nodes);
    const indeg = new Map();
    for (const u of nodes) indeg.set(u, 0);
    for (const u of nodes) {
      for (const d of depsArr[u]) if (inSet.has(d)) indeg.set(u, indeg.get(u) + 1);
    }
    const q = nodes.filter((u) => indeg.get(u) === 0).sort((a, b) => a - b);
    const out = [];
    while (q.length) {
      const u = q.shift();
      out.push(u);
      for (const v of revDepsArr[u]) {
        if (inSet.has(v)) {
          indeg.set(v, indeg.get(v) - 1);
          if (indeg.get(v) === 0) { q.push(v); q.sort((a, b) => a - b); }
        }
      }
    }
    if (out.length !== nodes.length) {
      const seen = new Set(out);
      const remain = nodes.filter((x) => !seen.has(x)).sort((a, b) => a - b);
      return out.concat(remain);
    }
    return out;
  };
  const buildDependsNote = (i) => {
    const depOnIdx = depsArr[i] || [];
    const depByIdx = revDepsArr[i] || [];
    const depOn = depOnIdx
      .map((idx) => ({ idx, stepId: plan.steps[idx]?.stepId, displayIndex: plan.steps[idx]?.displayIndex }))
      .filter((x) => typeof x.stepId === 'string' && x.stepId);
    const depBy = depByIdx
      .map((idx) => ({ idx, stepId: plan.steps[idx]?.stepId, displayIndex: plan.steps[idx]?.displayIndex }))
      .filter((x) => typeof x.stepId === 'string' && x.stepId);
    if (depOn.length === 0 && depBy.length === 0) return '无依赖关系';
    const parts = [];
    if (depOn.length) parts.push(`依赖步骤: ${depOn.map((x) => `${x.stepId}(#${Number(x.displayIndex || (x.idx + 1))})`).join(', ')}`);
    if (depBy.length) parts.push(`被步骤依赖: ${depBy.map((x) => `${x.stepId}(#${Number(x.displayIndex || (x.idx + 1))})`).join(', ')}`);
    return parts.join('；');
  };

  const buildDependsOnStepIds = (i) => {
    const ids = Array.isArray(plan.steps?.[i]?.dependsOnStepIds) ? plan.steps[i].dependsOnStepIds : [];
    return ids.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  };

  const buildDependedByStepIds = (i) => {
    const idxs = revDepsArr[i] || [];
    return idxs.map((j) => plan.steps?.[j]?.stepId).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  };

  // 结果流完成态：确保“最后一次 tool_result / tool_result_group”携带 resultStatus='final'
  // 约束：只对最后一个结果事件标记 final，避免多个事件同时被认为是最终完成。
  let finalResultEmitted = false;

  // 孤立步骤结果缓冲：由调度器在确认是否为最后一步时决定 progress/final
  const isolatedResultBuffers = new Map(); // plannedStepIndex -> ev
  const flushIsolatedResultIfAny = (plannedStepIndex, finalHint) => {
    try {
      const ev = isolatedResultBuffers.get(plannedStepIndex);
      if (!ev) return;
      const shouldFinal = !!finalHint && !finalResultEmitted;
      emitRunEvent(runId, {
        ...ev,
        resultStream: true,
        resultStatus: shouldFinal ? 'final' : 'progress'
      });
      if (shouldFinal) finalResultEmitted = true;
      isolatedResultBuffers.delete(plannedStepIndex);
    } catch { }
  };

  const emitToolResultGrouped = (ev, plannedStepIndex) => {
    if (isRunCancelled(runId)) return;
    const gid = groupOf[plannedStepIndex];
    if (gid === null || gid === undefined) {
      // 孤立步骤：先缓冲，由调度器在确认是否“最后一步”时决定 progress/final
      isolatedResultBuffers.set(plannedStepIndex, ev);
      return;
    }
    if (!groupBuffers.has(gid)) groupBuffers.set(gid, new Map());
    // 若同一步骤多次重试，仅保留最新一次结果
    groupBuffers.get(gid).set(plannedStepIndex, ev);
  };
  const emitArgsGrouped = (argsEv, plannedStepIndex) => {
    if (isRunCancelled(runId)) return;
    const gid = groupOf[plannedStepIndex];
    if (gid === null || gid === undefined) {
      // 孤立步骤：args 事件即时发送
      emitRunEvent(runId, argsEv);
      return;
    }
    if (!groupArgsBuffers.has(gid)) groupArgsBuffers.set(gid, new Map());
    groupArgsBuffers.get(gid).set(plannedStepIndex, argsEv);
  };
  const flushGroupIfReady = (gid, { finalHint, force } = {}) => {
    if (gid === null || gid === undefined) return;
    const g = groups.find((x) => x.id === gid);
    if (!g || g.flushed) return false;
    const left = groupPending.get(gid) || 0;
    if (!force && left > 0) return false;
    const order = topoOrderForGroup(gid);
    const orderStepIds = order.map((idx) => {
      const sid = plan?.steps?.[idx]?.stepId;
      return (typeof sid === 'string' && sid.trim()) ? sid.trim() : `step_${idx}`;
    });
    const buf = groupBuffers.get(gid) || new Map();
    const bufArgs = groupArgsBuffers.get(gid) || new Map();

    // 先合并并发送 args_group（若存在）
    const argsItems = [];
    for (const idx of order) {
      const a = bufArgs.get(idx);
      if (a) argsItems.push(a);
    }
    if (!isRunCancelled(runId) && argsItems.length > 0) {
      const argsGroupEvent = {
        type: 'args_group',
        groupId: gid,
        groupSize: (g.nodes?.length || 0),
        orderStepIds,
        items: argsItems,
      };
      emitRunEvent(runId, argsGroupEvent);
    }

    // 再按拓扑顺序一次性发送 tool_result_group
    const resultEvents = [];
    for (const idx of order) {
      const ev = buf.get(idx);
      if (ev) resultEvents.push(ev);
    }
    if (!isRunCancelled(runId) && resultEvents.length > 0) {
      const shouldFinal = !!finalHint && !finalResultEmitted;
      const resultGroupEvent = {
        type: 'tool_result_group',
        groupId: gid,
        groupSize: (g.nodes?.length || 0),
        orderStepIds,
        events: resultEvents,
        resultStream: true,
        resultStatus: shouldFinal ? 'final' : 'progress',
        groupFlushed: true,
      };
      emitRunEvent(runId, resultGroupEvent);
      if (shouldFinal) finalResultEmitted = true;
    }

    groupBuffers.delete(gid);
    groupArgsBuffers.delete(gid);
    g.flushed = true;
    return true;
  };

  const flushReadyGroupsInOrder = ({ force = false, finalGroupId = null } = {}) => {
    while (nextGroupToFlush < groups.length) {
      const g = groups[nextGroupToFlush];
      if (!g) break;
      const gid = g.id;
      const left = groupPending.get(gid) || 0;
      if (!force && left > 0) break;
      const shouldMarkFinal = finalGroupId !== null && finalGroupId !== undefined && gid === finalGroupId;
      const flushed = flushGroupIfReady(gid, { finalHint: shouldMarkFinal, force: true });
      if (!flushed) break;
      nextGroupToFlush += 1;
    }
  };

  const flushAllOnCancel = () => {
    try {
      for (const [idx, ev] of isolatedResultBuffers.entries()) {
        try {
          emitRunEvent(runId, { ...ev, resultStream: true, resultStatus: 'progress' });
        } catch { }
      }
      isolatedResultBuffers.clear();
    } catch { }
    try {
      flushReadyGroupsInOrder({ force: true, finalGroupId: null });
    } catch { }
  };
  // 中文：标记已完成的步骤
  if (retrySteps) {
    // 重试模式：标记所有非重试步骤为已完成
    for (let i = 0; i < total; i++) {
      if (!retrySteps.has(i)) {
        finished.add(i);
        // 减少组内待完成计数
        const gid = groupOf[i];
        if (gid !== null && gid !== undefined && groupPending.has(gid)) {
          groupPending.set(gid, Math.max(0, (groupPending.get(gid) || 0) - 1));
        }
      }
    }
  } else {
    // 正常模式：认为 startIndex 之前的步骤已完成
    for (let i = 0; i < Math.min(startIndex, total); i++) finished.add(i);
    for (let i = 0; i < Math.min(startIndex, total); i++) {
      const gid = groupOf[i];
      if (gid !== null && gid !== undefined && groupPending.has(gid)) {
        groupPending.set(gid, Math.max(0, (groupPending.get(gid) || 0) - 1));
      }
    }
  }

  // 单步执行器：保持原有逻辑
  const executeSingleStep = async (i) => {
    const step = plan.steps[i];
    const aiName = step.aiName;
    const draftArgs = step.draftArgs || {};
    const stepId = step?.stepId;
    const stepStart = now();

    // 若运行已被上游标记为取消，则跳过实际工具调用，避免继续浪费资源
    if (isRunCancelled(runId)) {
      const elapsed = now() - stepStart;
      const depOnStepIds = buildDependsOnStepIds(i);
      const depByStepIds = buildDependedByStepIds(i);
      const gid = groupOf[i];
      const res = {
        success: false,
        code: 'RUN_CANCELLED',
        data: null,
        message: '运行已被取消，跳过此步骤'
      };
      const ev = {
        type: 'tool_result',
        plannedStepIndex: i,
        stepId,
        executionIndex: nextExecutionIndex++,
        aiName,
        reason: formatReason(step.reason),
        nextStep: step.nextStep || '',
        args: draftArgs,
        result: res,
        elapsedMs: elapsed,
        dependsOnStepIds: depOnStepIds,
        dependedByStepIds: depByStepIds,
        dependsNote: buildDependsNote(i),
        groupId: (gid ?? null),
        groupSize: (gid != null && groups[gid]?.nodes?.length) ? groups[gid].nodes.length : 1,
        toolMeta: {},
      };
      emitToolResultGrouped(ev, i);
      await HistoryStore.append(runId, ev);
      if (config.flags.enableVerboseSteps) {
        logger.info?.('步骤在运行取消后被跳过', { label: 'STEP', stepIndex: i, aiName });
      }
      if (retrySteps) {
        stepStatus.set(i, { success: false, reason: res.message });
      }
      return { usedEntry: { aiName, elapsedMs: elapsed, success: false, code: res.code }, succeeded: 0 };
    }

    // 重试模式下，检查依赖步骤是否失败
    if (retrySteps) {
      const deps = depsArr[i] || [];
      const failedDeps = deps.filter((d) => {
        const status = stepStatus.get(Number(d));
        return status && !status.success;
      });

      if (failedDeps.length > 0) {
        // 依赖步骤失败，跳过此步骤以避免浪费
        const elapsed = now() - stepStart;
        const failedDepReasons = failedDeps.map(d => {
          const st = stepStatus.get(d);
          return `步骤${d}(${plan.steps[d]?.aiName}): ${st?.reason || '失败'}`;
        }).join('; ');
        const res = {
          success: false,
          code: 'SKIP_UPSTREAM_FAILED',
          data: null,
          message: `跳过：上游依赖步骤失败 - ${failedDepReasons}`
        };

        stepStatus.set(i, { success: false, reason: res.message });

        const depOnStepIds = buildDependsOnStepIds(i);
        const depByStepIds = buildDependedByStepIds(i);
        const gid = groupOf[i];
        const ev = {
          type: 'tool_result',
          plannedStepIndex: i,
          stepId,
          executionIndex: nextExecutionIndex++,
          aiName,
          reason: formatReason(step.reason),
          nextStep: step.nextStep || '',
          args: draftArgs,
          result: res,
          elapsedMs: elapsed,
          dependsOnStepIds: depOnStepIds,
          dependedByStepIds: depByStepIds,
          dependsNote: buildDependsNote(i),
          groupId: (gid ?? null),
          groupSize: (gid != null && groups[gid]?.nodes?.length) ? groups[gid].nodes.length : 1,
          toolMeta: {},
        };
        emitToolResultGrouped(ev, i);
        await HistoryStore.append(runId, ev);

        if (config.flags.enableVerboseSteps) {
          logger.info(`跳过步骤（上游失败）`, {
            label: 'STEP',
            stepIndex: i,
            aiName,
            failedDeps: failedDepReasons
          });
        }

        return { usedEntry: { aiName, elapsedMs: elapsed, success: false, code: res.code }, succeeded: 0 };
      }
    }

    const manifestItem = plan.manifest?.find((m) => m.aiName === aiName);
    if (!manifestItem) {
      const elapsed = now() - stepStart;
      const res = { success: false, code: 'NOT_FOUND', data: null, message: `Unknown aiName: ${aiName}` };
      // 中文：未知工具也参与“组”缓冲；事件携带依赖说明与组信息
      const depOnStepIds = buildDependsOnStepIds(i);
      const depByStepIds = buildDependedByStepIds(i);
      const gid = groupOf[i];
      const ev = {
        type: 'tool_result',
        plannedStepIndex: i,  // 计划阶段的步骤索引
        stepId,
        executionIndex: nextExecutionIndex++,  // 实际执行顺序（按完成时间）
        aiName,
        reason: formatReason(step.reason),
        nextStep: step.nextStep || '',
        args: step.draftArgs || {},
        result: res,
        elapsedMs: elapsed,
        dependsOnStepIds: depOnStepIds,
        dependedByStepIds: depByStepIds,
        dependsNote: buildDependsNote(i),
        groupId: (gid ?? null),
        groupSize: (gid != null && groups[gid]?.nodes?.length) ? groups[gid].nodes.length : 1,
        toolMeta: {},
      };
      if (!isRunCancelled(runId)) {
        emitToolResultGrouped(ev, i);
        await HistoryStore.append(runId, ev);
      }
      if (config.flags.enableVerboseSteps) logger.warn?.('跳过未知工具步骤', { label: 'STEP', aiName });
      return { usedEntry: { aiName, elapsedMs: elapsed, success: res.success, code: res.code }, succeeded: 0 };
    }

    if (config.flags.enableVerboseSteps) {
      logger.info(`执行第${i + 1}/${plan.steps.length}步`, { label: 'STEP', aiName, reason: formatReason(step.reason), nextStep: step.nextStep || '', draftArgs: clip(draftArgs) });
    }

    // 获取工具完整定义
    let currentToolFull = mcpcore.getAvailableTools().find((t) => t.aiName === aiName) || {
      description: manifestItem?.description || '',
      inputSchema: manifestItem?.inputSchema || { type: 'object', properties: {} }
    };
    const schema = currentToolFull.inputSchema || manifestItem?.inputSchema || { type: 'object', properties: {} };

    // 生成参数（包含复用逻辑）
    // 重试模式下禁用参数复用，强制重新生成，避免复用之前失败的参数
    const isRetryMode = retrySteps !== null;
    let toolArgs = draftArgs;
    let reused = false;
    try {
      const argsResult = await generateToolArgs({
        runId,
        stepIndex: i,
        objective,
        step,
        currentToolFull,
        manifestItem,
        conv,
        totalSteps: plan.steps.length,
        context,
        disableReuse: isRetryMode  // 重试时禁用复用
      });
      toolArgs = argsResult.toolArgs;
      reused = argsResult.reused;
    } catch (e) {
      emitRunEvent(runId, { type: 'arggen_error', stepIndex: i, stepId, aiName, error: String(e) });
      await HistoryStore.append(runId, { type: 'arggen_error', stepIndex: i, stepId, aiName, error: String(e) });
      logger.warn?.('参数生成失败，使用草案参数', { label: 'ARGGEN', aiName, error: String(e) });
    }

    // 参数校验
    const validateResult = await validateArgs({ schema, toolArgs, aiName });
    let ajvValid = validateResult.valid;
    let ajvErrors = validateResult.errors;
    toolArgs = validateResult.args;

    // 参数纠错（如果校验失败）
    if (!ajvValid) {
      toolArgs = await fixToolArgs({
        runId,
        stepIndex: i,
        objective,
        step,
        currentToolFull,
        schema,
        ajvErrors,
        toolArgs,
        draftArgs,
        totalSteps: plan.steps.length,
        context
      });
    }

    if (config.flags.enableVerboseSteps) logger.info(`参数确定`, { label: 'ARGS', aiName, toolArgsPreview: clip(toolArgs) });

    let scheduleArgValue = null;
    const schemaHasSchedule = !!(currentToolFull?.inputSchema?.properties?.schedule);
    const scheduleArgPresent = !!(
      schemaHasSchedule &&
      toolArgs &&
      Object.prototype.hasOwnProperty.call(toolArgs, 'schedule') &&
      toolArgs.schedule
    );
    if (scheduleArgPresent) {
      scheduleArgValue = toolArgs.schedule;
      try {
        const cloned = { ...toolArgs };
        delete cloned.schedule;
        toolArgs = cloned;
      } catch { }
    }

    // 将最终用于调用的参数写入历史，并通过事件总线实时分发
    try {
      const depOnStepIds = buildDependsOnStepIds(i);
      const depByStepIds = buildDependedByStepIds(i);
      const gidA = groupOf[i];
      const argsEv = {
        type: 'args',
        stepIndex: i,
        plannedStepIndex: i,
        stepId,
        aiName,
        args: toolArgs,
        reused,
        dependsOnStepIds: depOnStepIds,
        dependedByStepIds: depByStepIds,
        dependsNote: buildDependsNote(i),
        groupId: (gidA ?? null),
        groupSize: (gidA != null && groups[gidA]?.nodes?.length) ? groups[gidA].nodes.length : 1,
      };
      if (!isRunCancelled(runId)) {
        emitArgsGrouped(argsEv, i);
        await HistoryStore.append(runId, argsEv);
      }
    } catch { }

    // === schedule 延迟反馈机制：仅当插件 schema 中定义了 schedule 参数时启用 ===
    let delayMs = 0;
    let scheduleDetected = false;
    let scheduleText = '';
    let scheduleParsed = null;
    let scheduleMode = 'none'; // 'immediate_exec' | 'delayed_exec' | 'none'

    if (scheduleArgPresent && scheduleArgValue) {
      scheduleDetected = true;
      try {
        // 统一提取文本与语言
        const rawSchedule = scheduleArgValue;
        scheduleText = typeof rawSchedule === 'string'
          ? rawSchedule
          : (rawSchedule.when || rawSchedule.text || '');
        const lang = typeof rawSchedule === 'object' ? rawSchedule.language : undefined;

        // 1) 优先使用 ArgGen/Plan 阶段已经解析好的 targetISO（若存在）
        let targetISO = (typeof rawSchedule === 'object' && rawSchedule.targetISO)
          ? String(rawSchedule.targetISO)
          : '';
        let timezone = (typeof rawSchedule === 'object' && rawSchedule.timezone)
          ? String(rawSchedule.timezone)
          : undefined;
        let targetMs = NaN;

        if (targetISO) {
          const ts = Date.parse(targetISO);
          if (Number.isFinite(ts) && ts > 0) {
            targetMs = ts;
            // 构造一个最小的 scheduleParsed 结构，便于后续统一使用 parsedISO/timezone
            scheduleParsed = {
              parsedISO: targetISO,
              timezone,
              parsedDateTime: null,
            };
          }
        }

        // 2) 若缺少有效 targetISO，则回退到基于文本的时间解析
        if (!Number.isFinite(targetMs) || targetMs <= 0) {
          const parsed = timeParser.parseTimeExpression(scheduleText, {
            language: lang || (scheduleText.match(/[\u4e00-\u9fa5]/) ? 'zh' : 'en'),
          });
          if (parsed.success && parsed.parsedDateTime) {
            scheduleParsed = parsed;
            const tm = parsed.parsedDateTime.toMillis
              ? parsed.parsedDateTime.toMillis()
              : Date.parse(parsed.parsedDateTime);
            if (Number.isFinite(tm) && tm > 0) {
              targetMs = tm;
            }
          }
        }

        if (Number.isFinite(targetMs) && targetMs > 0) {
          const nowMs = Date.now();
          delayMs = Math.max(0, targetMs - nowMs);
          if (delayMs > 0) {
            const immediateAllowed = isImmediateScheduleAllowed(aiName);
            scheduleMode = immediateAllowed ? 'immediate_exec' : 'delayed_exec';
            logger.info?.('Schedule 延迟反馈启用', {
              label: 'SCHEDULE',
              aiName,
              scheduleText,
              delayMs,
              targetISO: scheduleParsed?.parsedISO || targetISO || null,
              scheduleMode,
            });
          }
        }
      } catch (e) {
        logger.warn?.('Schedule 解析失败，忽略延迟反馈', { label: 'SCHEDULE', aiName, error: String(e) });
      }
    }

    let res;
    let elapsed;
    if (scheduleDetected && delayMs > 0) {
      const scheduleEvent = {
        type: 'tool_choice',
        stepIndex: i,
        aiName,
        reason: formatReason(step.reason),
        status: 'scheduled',
        // message 留空，由上层主逻辑通过 schedule_progress 结果和上下文自行生成自然语言回复
        message: undefined,
        delayMs,
        // 透传用于延迟队列执行或延迟发送的参数，供上层记录和后续 worker 使用
        args: toolArgs,
        schedule: {
          text: scheduleText,
          targetISO: scheduleParsed?.parsedISO,
          timezone: scheduleParsed?.timezone,
          mode: scheduleMode !== 'none' ? scheduleMode : undefined,
        },
        scheduleMode: scheduleMode !== 'none' ? scheduleMode : undefined,
      };
      try {
        emitRunEvent(runId, scheduleEvent);
        await HistoryStore.append(runId, scheduleEvent);
        logger.info?.('Schedule 延迟反馈: 已记录调度事件', {
          label: 'SCHEDULE',
          aiName,
          delayMs,
          targetISO: scheduleParsed?.parsedISO,
          scheduleMode,
        });
      } catch { }

      if (scheduleMode === 'delayed_exec') {
        // 仅对不允许立即执行的工具采用“到点再执行”的旧语义：返回占位结果，实际执行交给延迟队列
        res = {
          success: true,
          code: 'SCHEDULED',
          data: {
            scheduled: true,
            delayMs,
            schedule: {
              text: scheduleText,
              targetISO: scheduleParsed?.parsedISO,
              timezone: scheduleParsed?.timezone,
            },
          },
        };
        elapsed = now() - stepStart;
      }
    }

    if (!res) {
      // 无 schedule、delayMs 为 0，或启用了“立即执行 + 延迟发送”模式：正常执行工具
      res = await mcpcore.callByAIName(aiName, toolArgs, { runId, stepIndex: i });
      elapsed = now() - stepStart;
    }
    // update rolling context and Redis history
    recentResults.push({ aiName, args: toolArgs, result: res, data: res.data });
    const limit = Math.max(1, Number(config.flags?.recentContextLimit ?? 5));
    if (recentResults.length > limit) recentResults.shift();

    // 中文：结果事件携带依赖信息与插件 meta；组内缓冲，组完成后按拓扑序统一发送
    const depOnStepIds = buildDependsOnStepIds(i);
    const depByStepIds = buildDependedByStepIds(i);
    const gid = groupOf[i];
    const toolMetaInherited = (toolMetaMap.get(aiName) || manifestItem?.meta || currentToolFull?.meta || {});
    const ev = {
      type: 'tool_result',
      plannedStepIndex: i,  // 计划阶段的步骤索引
      stepId,
      executionIndex: nextExecutionIndex++,  // 实际执行顺序（按完成时间）
      aiName,
      reason: formatReason(step.reason),
      nextStep: step.nextStep || '',
      args: toolArgs,
      result: res,
      elapsedMs: elapsed,
      dependsOnStepIds: depOnStepIds,
      dependedByStepIds: depByStepIds,
      dependsNote: buildDependsNote(i),
      groupId: (gid ?? null),
      groupSize: (gid != null && groups[gid]?.nodes?.length) ? groups[gid].nodes.length : 1,
      toolMeta: toolMetaInherited,
    };
    if (!(scheduleDetected && delayMs > 0 && scheduleMode === 'delayed_exec' && res?.success && res?.code === 'SCHEDULED')) {
      ev.completion = {
        state: 'completed',
        mustAnswerFromResult: true,
        instruction: 'Tool execution has finished for this step. Answer the user based on the tool result and extracted files/resources.'
      };
    }
    if (scheduleDetected && delayMs > 0 && scheduleMode === 'delayed_exec') {
      ev.schedule = {
        text: scheduleText,
        targetISO: scheduleParsed?.parsedISO,
        timezone: scheduleParsed?.timezone,
        delayMs,
        mode: scheduleMode,
      };
      ev.scheduleMode = scheduleMode;
    }
    if (!isRunCancelled(runId)) {
      emitToolResultGrouped(ev, i);
      await HistoryStore.append(runId, ev);
    }

    if (enablePlanPatchHook && !stopRequested) {
      const ok2 = isResultOk(res);
      const trigger = shouldTriggerPlanPatch({ result: res, triggerMode })
        ? `tool_result ok=${String(ok2)} success=${String(res?.success)} code=${String(res?.code || '')}`
        : '';
      if (!ok2 && trigger && !pauseForPlanPatch && appliedPatches < maxPatches && planPatchCalls < maxPlanPatchCalls) {
        pauseForPlanPatch = true;
        pendingPlanPatch = {
          atIndex: i,
          atStepId: stepId,
          aiName,
          lastResult: ev,
          trigger,
        };
      }
    }
    if (config.memory?.enable && res?.success) {
      await upsertToolMemory({ runId, stepIndex: i, aiName, objective, reason: formatReason(step.reason), args: toolArgs, result: res, success: true });
    }
    if (config.flags.enableVerboseSteps) logger.info('执行结果', { label: 'RESULT', aiName, success: res.success, code: res.code, dataPreview: clip(res?.data) });

    // 冷却命中：返回调度级延迟重排信息
    if (!res.success && res.code === 'COOLDOWN_ACTIVE') {
      const remainMs = Number(res.remainMs || (res.ttl ? res.ttl * 1000 : (config.planner?.cooldownDefaultMs || 1000)));
      const jitter = Math.floor(100 + Math.random() * 200);
      const requeueMs = Math.max(200, remainMs + jitter);
      return { usedEntry: { aiName, elapsedMs: elapsed, success: res.success, code: res.code }, succeeded: 0, requeueMs };
    }

    // 重试模式下记录执行状态
    if (retrySteps) {
      stepStatus.set(i, {
        success: res.success,
        reason: res.success ? '成功' : (res.message || res.error || `失败: ${res.code}`)
      });
    }

    return { usedEntry: { aiName, elapsedMs: elapsed, success: res.success, code: res.code }, succeeded: res.success ? 1 : 0 };
  };

  const isReady = (i) => {
    // 重试模式：只执行指定的重试步骤
    if (retrySteps && !retrySteps.has(i)) return false;
    // 正常模式：不执行起点之前的步骤
    if (!retrySteps && i < startIndex) return false;
    if (started.has(i) || finished.has(i)) return false;
    const due = delayUntil.get(i) || 0; if (due && now() < due) return false;
    const aiName = plan.steps[i]?.aiName;
    const prov = toolMeta.get(aiName)?.provider || 'local';
    const toolLim = getToolLimit(aiName);
    const provLim = getProvLimit(prov);
    const tRun = runningByTool.get(aiName) || 0;
    const pRun = runningByProvider.get(normKey(prov)) || 0;
    if (tRun >= toolLim) return false;
    if (pRun >= provLim) return false;
    // 使用预先归一化的 depsArr 作为依赖来源（来自 dependsOnStepIds 的 stepId->index 映射）
    const deps = depsArr[i] || [];
    if (!deps.length) return true;
    for (const idx of deps) {
      if (!finished.has(idx)) return false;
    }
    return true;
  };

  const inFlight = new Map(); // i -> Promise
  const track = (i, p) => p.finally(() => { inFlight.delete(i); });

  while (finished.size < plan.steps.length) {
    if (isRunCancelled(runId)) {
      if (config.flags.enableVerboseSteps) {
        logger.info?.('执行计划检测到取消信号，提前结束调度', { label: 'RUN', runId });
      }
      flushAllOnCancel();
      break;
    }
    if (pauseForPlanPatch) {
      if (inFlight.size === 0) {
        await maybeProcessPendingPlanPatch();
      } else {
        await Promise.race([...inFlight.values()]);
      }
      continue;
    }
    if (stopRequested) {
      if (inFlight.size === 0) {
        break;
      }
      await Promise.race([...inFlight.values()]);
      continue;
    }

    for (let i = startIndex; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      if (s && s.skip === true && !finished.has(i)) {
        finished.add(i);
        const isFinalStep = finished.size >= plan.steps.length;
        flushIsolatedResultIfAny(i, isFinalStep);
        const gid2 = groupOf[i];
        if (gid2 !== null && gid2 !== undefined && groupPending.has(gid2)) {
          groupPending.set(gid2, Math.max(0, (groupPending.get(gid2) || 0) - 1));
          const finalGid = isFinalStep && groups.length ? groups[groups.length - 1].id : null;
          flushReadyGroupsInOrder({ force: false, finalGroupId: finalGid });
        }
      }
    }

    // 尝试补满并发槽位
    for (let i = startIndex; i < plan.steps.length && inFlight.size < maxConc; i++) {
      if (isReady(i)) {
        started.add(i);
        const aiName = plan.steps[i]?.aiName;
        const prov = toolMeta.get(aiName)?.provider || 'local';
        runningByTool.set(aiName, (runningByTool.get(aiName) || 0) + 1);
        const provKey = normKey(prov);
        runningByProvider.set(provKey, (runningByProvider.get(provKey) || 0) + 1);

        const p = track(i, executeSingleStep(i).then((r) => {
          // 释放并发占位
          runningByTool.set(aiName, Math.max(0, (runningByTool.get(aiName) || 1) - 1));
          runningByProvider.set(provKey, Math.max(0, (runningByProvider.get(provKey) || 1) - 1));

          if (r?.requeueMs > 0) {
            // 调度级延迟重排：不标记完成，设置最早可调度时间
            // 孤立步骤：仍需把本次结果作为 progress 发出（例如 COOLDOWN_ACTIVE），避免“无反馈”。
            flushIsolatedResultIfAny(i, false);
            delayUntil.set(i, now() + r.requeueMs);
            started.delete(i);
            if (r?.usedEntry) used.push(r.usedEntry);
            return;
          }
          finished.add(i);
          const isFinalStep = finished.size >= plan.steps.length;
          flushIsolatedResultIfAny(i, isFinalStep);
          // 中文：更新组内剩余计数并在组完成时统一刷新实时事件
          const gid2 = groupOf[i];
          if (gid2 !== null && gid2 !== undefined && groupPending.has(gid2)) {
            groupPending.set(gid2, Math.max(0, (groupPending.get(gid2) || 0) - 1));
            const finalGid = isFinalStep && groups.length ? groups[groups.length - 1].id : null;
            flushReadyGroupsInOrder({ force: false, finalGroupId: finalGid });
          }
          if (r?.usedEntry) used.push(r.usedEntry);
          if (r?.succeeded) succeeded += r.succeeded;
        }).catch((e) => {
          // 释放并发占位
          runningByTool.set(aiName, Math.max(0, (runningByTool.get(aiName) || 1) - 1));
          runningByProvider.set(provKey, Math.max(0, (runningByProvider.get(provKey) || 1) - 1));
          finished.add(i);
          const isFinalStep = finished.size >= plan.steps.length;
          flushIsolatedResultIfAny(i, isFinalStep);
          // 中文：异常也视为完成，避免组刷新被阻塞
          const gid2 = groupOf[i];
          if (gid2 !== null && gid2 !== undefined && groupPending.has(gid2)) {
            groupPending.set(gid2, Math.max(0, (groupPending.get(gid2) || 0) - 1));
            const finalGid = isFinalStep && groups.length ? groups[groups.length - 1].id : null;
            flushReadyGroupsInOrder({ force: false, finalGroupId: finalGid });
          }
          logger.warn?.('并行执行异常', { label: 'STEP', index: i, error: String(e) });
        }));
        inFlight.set(i, p);
      }
    }

    if (inFlight.size === 0) {
      // 若有延迟中的任务，等待最近的到期时间后继续调度
      let minWait = Infinity;
      for (const [idx, ts] of delayUntil.entries()) {
        if (idx < startIndex || finished.has(idx)) continue;
        const w = (ts || 0) - now();
        if (w > 0) minWait = Math.min(minWait, w);
      }
      if (Number.isFinite(minWait) && minWait !== Infinity) {
        await wait(minWait);
        continue;
      }
      // 无可执行项且没有运行中的任务：可能存在循环依赖/无效 dependsOnStepIds
      if (finished.size < plan.steps.length) {
        logger.warn?.('无可执行步骤，可能存在循环依赖/无效 dependsOnStepIds，强制跳过剩余步骤', { label: 'PLAN' });
        for (let i = startIndex; i < plan.steps.length; i++) {
          if (!finished.has(i)) {
            finished.add(i);
            // 组计数归零，便于 flush
            const gid = groupOf[i];
            if (gid !== null && gid !== undefined && groupPending.has(gid)) {
              groupPending.set(gid, Math.max(0, (groupPending.get(gid) || 0) - 1));
            }
          }
        }
        // 强制刷新所有已无待完成步数的组
        const finalGid = groups.length ? groups[groups.length - 1].id : null;
        flushReadyGroupsInOrder({ force: true, finalGroupId: finalGid });
      }
      break;
    }

    // 等待任意一个任务结束以继续调度
    await Promise.race([...inFlight.values()]);
  }

  const attempted = used.length;
  const successRate = attempted ? succeeded / attempted : 0;
  // 兜底：循环结束后，若仍有未刷新的组（理论上不应发生），统一刷新
  if (isRunCancelled(runId)) {
    flushAllOnCancel();
  } else {
    const finalGid = groups.length ? groups[groups.length - 1].id : null;
    flushReadyGroupsInOrder({ force: true, finalGroupId: finalGid });
  }
  return { used, attempted, succeeded, successRate };
}

export async function planThenExecute({ objective, context = {}, mcpcore, conversation, forceNeedTools = false }) {
  const runId = uuidv4();
  const ctx0 = (context && typeof context === 'object') ? context : {};
  registerRunStart({ runId, channelId: ctx0.channelId, identityKey: ctx0.identityKey, objective });
  const ctx = injectConcurrencyOverlay({ runId, objective, context: ctx0 });
  try {
    await HistoryStore.append(runId, { type: 'start', objective, context: sanitizeContextForLog(ctx) });

    // 步骤1：构建工具清单
    let manifest0 = buildPlanningManifest(mcpcore);

    // 步骤2：判断是否需要工具（使用原始工具列表）
    const judgeFunc = (config.llm?.toolStrategy || 'auto') === 'fc' ? judgeToolNecessityFC : judgeToolNecessity;
    const judge = forceNeedTools
      ? { need: true, summary: 'forced_need_tools=true', toolNames: [], ok: true, forced: true }
      : await judgeFunc(objective, manifest0, conversation, ctx);
    const toolPreReplySingleSkipTools = Array.isArray(config.flags?.toolPreReplySingleSkipTools)
      ? config.flags.toolPreReplySingleSkipTools
      : [];
    await HistoryStore.append(runId, {
      type: 'judge',
      need: judge.need,
      summary: judge.summary,
      toolNames: judge.toolNames,
      ok: judge.ok !== false,
      toolPreReplySingleSkipTools
    });
    if (judge && judge.ok === false) {
      const plan = { manifest: manifest0, steps: [] };
      const plan2 = normalizePlanStepIds(plan);
      await HistoryStore.setPlan(runId, plan2);
      await HistoryStore.append(runId, { type: 'plan', plan: plan2 });
      const exec = { used: [], attempted: 0, succeeded: 0, successRate: 0 };
      await HistoryStore.append(runId, { type: 'done', exec });
      const summary = String(judge.summary || 'Judge阶段失败');
      try { await HistoryStore.setSummary(runId, summary); } catch { }
      await HistoryStore.append(runId, { type: 'summary', summary });
      return fail('JUDGE_FAILED', 'JUDGE_FAILED', { runId, plan: plan2, exec, eval: { success: false, summary }, summary });
    }
    if (!judge.need) {
      const plan = { manifest: manifest0, steps: [] };
      const plan2 = normalizePlanStepIds(plan);
      await HistoryStore.setPlan(runId, plan2);
      await HistoryStore.append(runId, { type: 'plan', plan: plan2 });
      const exec = { used: [], attempted: 0, succeeded: 0, successRate: 1 };
      const evalObj = { success: true, summary: '判定无需调用工具，直接完成。' };
      await HistoryStore.append(runId, { type: 'done', exec });
      const summary = '本次任务判定无需调用工具。';
      await HistoryStore.setSummary(runId, summary);
      await HistoryStore.append(runId, { type: 'summary', summary });
      return ok({ runId, plan: plan2, exec, eval: evalObj, summary });
    }

    const planRaw = await generatePlan(objective, mcpcore, { ...ctx, runId, judge }, conversation);
    const plan = normalizePlanStepIds(planRaw);
    await HistoryStore.setPlan(runId, plan);
    await HistoryStore.append(runId, { type: 'plan', plan });

    const exec = await executePlan(runId, objective, mcpcore, plan, { conversation, context: ctx });
    const enableEval = config.flags?.enableEval !== false;
    let evalObj = null;
    if (enableEval) {
      evalObj = await evaluateRun(objective, plan, exec, runId, ctx);
    }

    // Global repair loop (circuit breaker): limit the number of repair cycles
    const enableRepair = !(config.runner?.enableRepair === false);
    const maxRepairs = enableRepair ? Math.max(0, Number(config.runner?.maxRepairs ?? 1)) : 0;
    let repairs = 0;
    while (enableEval && evalObj && !evalObj.success && repairs < maxRepairs) {
      // 收集所有失败的步骤（不只是第一个）
      const failedSteps = Array.isArray(evalObj.failedSteps) && evalObj.failedSteps.length
        ? evalObj.failedSteps.filter((f) => typeof f?.stepId === 'string' && f.stepId.trim())
        : [];
      if (failedSteps.length === 0) break;

      // 提取失败步骤的索引（仅用于内部执行；身份以 stepId 为准）
      const stepIdToIndex = new Map((plan.steps || []).map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId : '', idx]).filter(([k]) => k));
      const failedIndices = Array.from(new Set(failedSteps.map((f) => {
        const sid = typeof f?.stepId === 'string' ? f.stepId.trim() : '';
        const idx = sid ? stepIdToIndex.get(sid) : undefined;
        return Number.isFinite(idx) ? idx : NaN;
      }).filter((x) => Number.isFinite(x)))).sort((a, b) => a - b);

      // 构建依赖链：找出所有依赖失败步骤的下游步骤
      const retryChain = buildDependencyChain(plan.steps, failedIndices);
      const retryIndices = Array.from(retryChain).sort((a, b) => a - b);

      // 构建成功步骤的上下文（所有成功的步骤结果）
      const history = await HistoryStore.list(runId, 0, -1);
      const prior = history
        .filter((h) => h.type === 'tool_result' && Number(h.result?.success) === 1)
        .map((h) => ({ aiName: h.aiName, args: h.args, result: h.result, data: h.result?.data }));

      // 记录重试事件
      await HistoryStore.append(runId, {
        type: 'retry_begin',
        failedSteps: failedSteps.map((f) => ({ stepId: f.stepId, displayIndex: f.displayIndex, aiName: f.aiName, reason: f.reason })),
        repairIndex: repairs + 1
      });

      if (config.flags.enableVerboseSteps) {
        logger.info('开始重试失败步骤及其依赖链', {
          label: 'RETRY',
          originalFailed: failedIndices,
          retryChain: retryIndices,
          chainSize: retryIndices.length,
          failedSteps: failedSteps.map((f) => `stepId=${f.stepId} displayIndex=${f.displayIndex} (${f.aiName}): ${f.reason}`)
        });
      }

      // 重试失败步骤及其所有下游依赖步骤
      const retryExec = await executePlan(runId, objective, mcpcore, plan, {
        retrySteps: retryIndices,  // 执行失败步骤 + 依赖它们的步骤
        seedRecent: prior,
        conversation,
        context
      });

      await HistoryStore.append(runId, {
        type: 'retry_done',
        failedSteps: failedSteps.map((f) => ({ stepId: f.stepId, displayIndex: f.displayIndex, aiName: f.aiName, reason: f.reason })),
        repairIndex: repairs + 1,
        exec: retryExec
      });

      // 重试后，需要从 history 中重新统计全局的 exec（因为 retryExec 只包含重试步骤）
      const updatedHistory = await HistoryStore.list(runId, 0, -1);
      const allToolResults = updatedHistory.filter((h) => h.type === 'tool_result');
      const globalUsed = allToolResults.map((h) => ({
        aiName: h.aiName,
        args: h.args,
        result: h.result
      }));
      const globalSucceeded = allToolResults.filter((h) => Number(h.result?.success) === 1).length;
      const globalExec = {
        used: globalUsed,
        attempted: allToolResults.length,
        succeeded: globalSucceeded,
        successRate: allToolResults.length ? globalSucceeded / allToolResults.length : 0
      };
      exec = globalExec;

      evalObj = await evaluateRun(objective, plan, exec, runId, ctx);
      repairs++;
    }

    await HistoryStore.append(runId, { type: 'done', exec });

    // 总结步骤，支持失败反馈
    const enableSummary = config.flags?.enableSummary !== false;
    const summaryResult = enableSummary
      ? await summarizeToolHistory(runId, '', ctx)
      : { success: true, summary: '' };

    if (enableSummary && !summaryResult.success && config.flags.enableVerboseSteps) {
      logger.warn('总结步骤失败', {
        label: 'RUN',
        runId,
        error: summaryResult.error,
        attempts: summaryResult.attempts
      });
    }

    // 向后兼容：返回 summary 字符串
    const summary = summaryResult.summary || '';

    const okres = ok({
      runId,
      plan,
      exec,
      eval: evalObj,
      summary,
      summaryResult  // 附加完整的总结结果
    });
    if (config.flags.enableVerboseSteps) {
      logger.info('Run completed', { label: 'RUN', runId, attempted: exec.attempted, succeeded: exec.succeeded, successRate: exec.successRate });
    }
    return okres;
  } finally {
    const cancelled = isRunCancelled(runId);
    try { markRunFinished(runId, { cancelled }); } catch { }
    try { removeRun(runId); } catch { }
    try { clearRunCancelled(runId); } catch { }
  }
}

// 流式执行：通过 RunEvents 推送（同时持久化到 HistoryStore），以 JSON 事件逐步产出
// 事件类型包括：start, judge, plan, args, tool_result, retry_begin, retry_done, evaluation, done, summary
export async function* planThenExecuteStream({ objective, context = {}, mcpcore, conversation, pollIntervalMs = 200, forceNeedTools = false }) {
  const runId = uuidv4();
  const sub = RunEvents.subscribe(runId);
  const ctx0 = (context && typeof context === 'object') ? context : {};
  registerRunStart({ runId, channelId: ctx0.channelId, identityKey: ctx0.identityKey, objective });
  const ctx = injectConcurrencyOverlay({ runId, objective, context: ctx0 });

  // Producer: run the workflow in background while emitting events
  (async () => {
    try {
      // Start
      const sanitizedCtx = sanitizeContextForLog(ctx);
      emitRunEvent(runId, { type: 'start', objective, context: sanitizedCtx });
      await HistoryStore.append(runId, { type: 'start', objective, context: sanitizedCtx });

      // 步骤1：构建工具清单
      let manifest0 = buildPlanningManifest(mcpcore);

      // 步骤2：判断是否需要工具（使用原始工具列表）
      const judgeFunc = (config.llm?.toolStrategy || 'auto') === 'fc' ? judgeToolNecessityFC : judgeToolNecessity;
      const judge = forceNeedTools
        ? { need: true, summary: 'forced_need_tools=true', toolNames: [], ok: true, forced: true }
        : await judgeFunc(objective, manifest0, conversation, ctx);
      const toolPreReplySingleSkipTools = Array.isArray(config.flags?.toolPreReplySingleSkipTools)
        ? config.flags.toolPreReplySingleSkipTools
        : [];
      emitRunEvent(runId, {
        type: 'judge',
        need: judge.need,
        summary: judge.summary,
        toolNames: judge.toolNames,
        ok: judge.ok !== false,
        forced: !!judge.forced,
        toolPreReplySingleSkipTools
      });
      await HistoryStore.append(runId, {
        type: 'judge',
        need: judge.need,
        summary: judge.summary,
        toolNames: judge.toolNames,
        ok: judge.ok !== false,
        forced: !!judge.forced,
        toolPreReplySingleSkipTools
      });
      if (judge && judge.ok === false) {
        const plan0 = { manifest: manifest0, steps: [] };
        const plan = normalizePlanStepIds(plan0);
        await HistoryStore.setPlan(runId, plan);
        emitRunEvent(runId, { type: 'plan', plan });
        await HistoryStore.append(runId, { type: 'plan', plan });
        const exec = { used: [], attempted: 0, succeeded: 0, successRate: 0 };
        emitRunEvent(runId, { type: 'done', exec });
        await HistoryStore.append(runId, { type: 'done', exec });
        const summary = String(judge.summary || 'Judge阶段失败');
        try { await HistoryStore.setSummary(runId, summary); } catch { }
        emitRunEvent(runId, { type: 'summary', summary });
        await HistoryStore.append(runId, { type: 'summary', summary });
        return;
      }
      if (!judge.need) {
        const plan0 = { manifest: manifest0, steps: [] };
        const plan = normalizePlanStepIds(plan0);
        await HistoryStore.setPlan(runId, plan);
        emitRunEvent(runId, { type: 'plan', plan });
        await HistoryStore.append(runId, { type: 'plan', plan });
        const exec = { used: [], attempted: 0, succeeded: 0, successRate: 1 };
        emitRunEvent(runId, { type: 'done', exec });
        await HistoryStore.append(runId, { type: 'done', exec });
        const summary = '本次任务判定无需调用工具。';
        try { await HistoryStore.setSummary(runId, summary); } catch { }
        emitRunEvent(runId, { type: 'summary', summary });
        await HistoryStore.append(runId, { type: 'summary', summary });
        return;
      }

      // Plan (after judge)
      const planRaw = await generatePlan(objective, mcpcore, { ...ctx, runId, judge }, conversation);
      const plan = normalizePlanStepIds(planRaw);
      await HistoryStore.setPlan(runId, plan);
      emitRunEvent(runId, { type: 'plan', plan });
      await HistoryStore.append(runId, { type: 'plan', plan });

      // Execute concurrently (existing executor emits args/tool_result events)
      const exec = await executePlan(runId, objective, mcpcore, plan, { conversation, context: ctx });

      // 若运行在执行阶段被取消，则跳过后续评估/补救/总结，直接发出 cancelled 结束事件
      if (isRunCancelled(runId)) {
        if (config.flags.enableVerboseSteps) {
          logger.info('Run cancelled after executePlan, skip evaluation/reflection/summary', { label: 'RUN', runId });
        }
        const summary = '本次运行已被上游取消，仅保留已完成的工具结果，不再继续评估与总结。';
        emitRunEvent(runId, { type: 'cancelled', exec, summary, cancelled: true });
        await HistoryStore.append(runId, { type: 'cancelled', exec, summary, cancelled: true });
        return;
      }

      // Evaluate
      const enableEval = config.flags?.enableEval !== false;
      let evalObj = null;
      if (enableEval) {
        evalObj = await evaluateRun(objective, plan, exec, runId, ctx); // evaluation event emitted inside
      }

      // Retry loop if enabled and within global limits
      const enableRepair = !(config.runner?.enableRepair === false);
      const maxRepairs = enableRepair ? Math.max(0, Number(config.runner?.maxRepairs ?? 1)) : 0;
      let repairs = 0;
      while (enableEval && evalObj && !evalObj.success && repairs < maxRepairs) {
        // 收集所有失败的步骤
        const failedSteps = Array.isArray(evalObj.failedSteps) && evalObj.failedSteps.length
          ? evalObj.failedSteps.filter((f) => typeof f?.stepId === 'string' && f.stepId.trim())
          : [];
        if (failedSteps.length > 0) {
          // 提取失败步骤的索引（仅用于内部执行；身份以 stepId 为准）
          const stepIdToIndex = new Map((plan.steps || []).map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId : '', idx]).filter(([k]) => k));
          const failedIndices = Array.from(new Set(failedSteps.map((f) => {
            const sid = typeof f?.stepId === 'string' ? f.stepId.trim() : '';
            const idx = sid ? stepIdToIndex.get(sid) : undefined;
            return Number.isFinite(idx) ? idx : NaN;
          }).filter((x) => Number.isFinite(x)))).sort((a, b) => a - b);

          // 构建依赖链：找出所有依赖失败步骤的下游步骤
          const retryChain = buildDependencyChain(plan.steps, failedIndices);
          const retryIndices = Array.from(retryChain).sort((a, b) => a - b);

          // 构建成功步骤的上下文
          const history = await HistoryStore.list(runId, 0, -1);
          const prior = history
            .filter((h) => h.type === 'tool_result' && Number(h.result?.success) === 1)
            .map((h) => ({ aiName: h.aiName, args: h.args, result: h.result, data: h.result?.data }));

          emitRunEvent(runId, {
            type: 'retry_begin',
            failedSteps: failedSteps.map((f) => ({ stepId: f.stepId, displayIndex: f.displayIndex, aiName: f.aiName, reason: f.reason }))
          });
          await HistoryStore.append(runId, {
            type: 'retry_begin',
            failedSteps: failedSteps.map((f) => ({ stepId: f.stepId, displayIndex: f.displayIndex, aiName: f.aiName, reason: f.reason }))
          });

          if (config.flags.enableVerboseSteps) {
            logger.info('开始重试失败步骤及其依赖链', {
              label: 'RETRY',
              originalFailed: failedIndices,
              retryChain: retryIndices,
              chainSize: retryIndices.length,
              failedSteps: failedSteps.map((f) => `stepId=${f.stepId} displayIndex=${f.displayIndex} (${f.aiName}): ${f.reason}`)
            });
          }

          // 重试失败步骤及其所有下游依赖步骤
          const retryExec = await executePlan(runId, objective, mcpcore, plan, {
            retrySteps: retryIndices,  // 执行失败步骤 + 依赖它们的步骤
            seedRecent: prior,
            conversation,
            context
          });

          emitRunEvent(runId, {
            type: 'retry_done',
            failedSteps: failedSteps.map((f) => ({ stepId: f.stepId, displayIndex: f.displayIndex, aiName: f.aiName, reason: f.reason })),
            exec: retryExec
          });
          await HistoryStore.append(runId, {
            type: 'retry_done',
            failedSteps: failedSteps.map((f) => ({ stepId: f.stepId, displayIndex: f.displayIndex, aiName: f.aiName, reason: f.reason })),
            exec: retryExec
          });

          // 重试后，需要从 history 中重新统计全局的 exec（因为 retryExec 只包含重试步骤）
          const updatedHistory = await HistoryStore.list(runId, 0, -1);
          const allToolResults = updatedHistory.filter((h) => h.type === 'tool_result');
          const globalUsed = allToolResults.map((h) => ({
            aiName: h.aiName,
            args: h.args,
            result: h.result
          }));
          const globalSucceeded = allToolResults.filter((h) => Number(h.result?.success) === 1).length;
          const globalExec = {
            used: globalUsed,
            attempted: allToolResults.length,
            succeeded: globalSucceeded,
            successRate: allToolResults.length ? globalSucceeded / allToolResults.length : 0
          };
          exec = globalExec;

          evalObj = await evaluateRun(objective, plan, exec, runId, ctx);
        }
        repairs++;
      }

      // Done + summary
      emitRunEvent(runId, { type: 'done', exec });
      await HistoryStore.append(runId, { type: 'done', exec });

      // Reflection：基于 evaluation 的 incomplete 字段判断是否需要补充遗漏的操作
      // success 表示已执行步骤是否成功，incomplete 表示任务是否有遗漏步骤
      const shouldReflect = enableEval && config.flags.enableReflection && evalObj?.incomplete === true;
      if (!config.flags.enableReflection) {
        if (config.flags.enableVerboseSteps) {
          logger.info('Reflection: 未启用 enableReflection，跳过完整性检查', { label: 'REFLECTION', runId });
        }
      } else if (enableEval && evalObj?.incomplete === false) {
        if (config.flags.enableVerboseSteps) {
          logger.info('Reflection: evaluation 判定任务完整，跳过完整性检查', {
            label: 'REFLECTION',
            runId,
            evalSuccess: evalObj?.success,
            evalIncomplete: false,
            evalSummary: evalObj?.summary?.slice(0, 100)
          });
        }
      } else if (shouldReflect) {
        if (config.flags.enableVerboseSteps) {
          logger.info('Reflection: evaluation 判定任务不完整，开始完整性检查', {
            label: 'REFLECTION',
            runId,
            evalSuccess: evalObj?.success,
            evalIncomplete: true,
            evalSummary: evalObj?.summary?.slice(0, 200)
          });
        }
        try {
          const reflection = await checkTaskCompleteness(runId, objective, plan.manifest, ctx);

          emitRunEvent(runId, {
            type: 'reflection',
            isComplete: reflection.isComplete,
            analysis: reflection.analysis,
            missingsCount: reflection.missings?.length || 0,
            supplementsCount: reflection.supplements?.length || 0
          });
          await HistoryStore.append(runId, {
            type: 'reflection',
            isComplete: reflection.isComplete,
            analysis: reflection.analysis,
            missings: reflection.missings,
            supplements: reflection.supplements
          });

          if (config.flags.enableVerboseSteps) {
            logger.info('Reflection: 完整性检查完成', {
              label: 'REFLECTION',
              runId,
              isComplete: reflection.isComplete,
              missingsCount: reflection.missings?.length || 0,
              supplementsCount: reflection.supplements?.length || 0
            });
          }

          // 如果任务不完整且有补充建议，生成并执行补充计划
          if (!reflection.isComplete && Array.isArray(reflection.supplements) && reflection.supplements.length > 0) {
            const maxSupplements = Math.max(1, config.flags.reflectionMaxSupplements || 3);
            const limitedSupplements = reflection.supplements.slice(0, maxSupplements);

            if (config.flags.enableVerboseSteps) {
              logger.info('Reflection: 开始生成补充计划', {
                label: 'REFLECTION',
                runId,
                supplementsCount: limitedSupplements.length,
                supplements: limitedSupplements.map(s => s.operation)
              });
            }

            // 提取已完成的工具执行历史（用于补充计划的上下文）
            const history = await HistoryStore.list(runId, 0, -1);
            const completedTools = history
              .filter((h) => h.type === 'tool_result')
              .map((h, idx) => ({
                stepIndex: idx,
                aiName: h.aiName,
                args: h.args,
                result: h.result,
                success: Number(h.result?.success) === 1
              }));

            // 构建已完成步骤的描述（包含完整的 args 和 result，不截断）
            const completedStepsDesc = completedTools.length > 0
              ? `\n\n【已完成的步骤】（补充计划应基于这些结果继续，不要重复执行）：\n${completedTools.map((t, i) => {
                const argsStr = JSON.stringify(t.args);
                const resultStr = JSON.stringify(t.result);
                const statusIcon = t.success ? ' ✓' : ' ✗';
                return `${i}. ${t.aiName}${statusIcon}:\n   参数: ${argsStr}\n   结果: ${resultStr}`;
              }).join('\n')}`
              : '';

            // 构建补充操作的描述（用于重排序）
            const supplementsDesc = limitedSupplements.map((s, i) => `${i + 1}. ${s.operation}：${s.reason}`).join('\n');

            // 构建补充目标（强调这是补充操作，不是重新开始；历史由规划器按 runId 内部加载）
            const supplementObjective = `${objective}\n\n【需要补充的操作】（仅基于当前运行历史补充以下遗漏的关键操作）：\n${supplementsDesc}`;

            // 生成补充计划（不拼接历史；由规划器基于 runId 内部加载）
            const supplementConversation = Array.isArray(conversation) ? conversation : [];

            const supplementPlan = await generatePlan(supplementObjective, mcpcore, {
              ...ctx,
              runId,
              isReflectionSupplement: true,
              originalPlan: plan,
              completedSteps: completedTools
            }, supplementConversation);

            if (Array.isArray(supplementPlan?.steps) && supplementPlan.steps.length > 0) {
              // 清理 dependsOnStepIds：补充计划独立执行，不应引用原计划的 stepId
              supplementPlan.steps = supplementPlan.steps.map(s => {
                const { dependsOnStepIds, ...rest } = s;
                return { ...rest, dependsOnStepIds: undefined };
              });

              emitRunEvent(runId, {
                type: 'reflection_plan',
                plan: supplementPlan,
                supplementsCount: supplementPlan.steps.length
              });
              await HistoryStore.append(runId, {
                type: 'reflection_plan',
                plan: supplementPlan
              });

              if (config.flags.enableVerboseSteps) {
                logger.info('Reflection: 补充计划生成成功', {
                  label: 'REFLECTION',
                  runId,
                  stepsCount: supplementPlan.steps.length,
                  steps: supplementPlan.steps.map(s => `${s.aiName}: ${formatReason(s.reason)}`)
                });
              }

              // 执行补充计划（继承之前的工具上下文）
              const history = await HistoryStore.list(runId, 0, -1);
              const prior = history
                .filter((h) => h.type === 'tool_result' && Number(h.result?.success) === 1)
                .map((h) => ({ aiName: h.aiName, args: h.args, result: h.result, data: h.result?.data }));

              const supplementExec = await executePlan(runId, supplementObjective, mcpcore, supplementPlan, {
                seedRecent: prior,
                conversation,
                context: ctx
              });

              emitRunEvent(runId, {
                type: 'reflection_exec',
                exec: supplementExec
              });
              await HistoryStore.append(runId, {
                type: 'reflection_exec',
                exec: supplementExec
              });

              // 更新全局 exec 统计（包含补充执行的结果）
              const updatedHistory = await HistoryStore.list(runId, 0, -1);
              const allToolResults = updatedHistory.filter((h) => h.type === 'tool_result');
              const globalUsed = allToolResults.map((h) => ({
                aiName: h.aiName,
                args: h.args,
                result: h.result
              }));
              const globalSucceeded = allToolResults.filter((h) => Number(h.result?.success) === 1).length;
              exec = {
                used: globalUsed,
                attempted: allToolResults.length,
                succeeded: globalSucceeded,
                successRate: allToolResults.length ? globalSucceeded / allToolResults.length : 0
              };

              if (config.flags.enableVerboseSteps) {
                logger.info('Reflection: 补充执行完成', {
                  label: 'REFLECTION',
                  runId,
                  supplementAttempted: supplementExec.attempted,
                  supplementSucceeded: supplementExec.succeeded,
                  globalAttempted: exec.attempted,
                  globalSucceeded: exec.succeeded
                });
              }
            } else {
              if (config.flags.enableVerboseSteps) {
                logger.warn('Reflection: 补充计划生成失败或为空', {
                  label: 'REFLECTION',
                  runId
                });
              }
            }
          }
        } catch (e) {
          logger.error('Reflection: 完整性检查或补充执行异常', {
            label: 'REFLECTION',
            runId,
            error: String(e)
          });
          // Reflection 失败不应阻止总结，继续执行
        }
      }

      const enableSummary = config.flags?.enableSummary !== false;
      emitRunEvent(runId, {
        type: 'completed',
        exec,
        evaluation: enableEval ? evalObj : null,
        summaryPending: enableSummary,
        resultStream: true,
        resultStatus: 'final'
      });
      await HistoryStore.append(runId, {
        type: 'completed',
        exec,
        evaluation: enableEval ? evalObj : null,
        summaryPending: enableSummary,
        resultStream: true,
        resultStatus: 'final'
      });

      if (enableSummary) {
        // 总结步骤，支持失败反馈
        const summaryResult = await summarizeToolHistory(runId, '', ctx);

        if (!summaryResult.success && config.flags.enableVerboseSteps) {
          logger.warn('总结步骤失败', {
            label: 'RUN',
            runId,
            error: summaryResult.error,
            attempts: summaryResult.attempts
          });
        }

        // 向后兼容：发送 summary 字符串
        const summary = summaryResult.summary || '';
        try { await HistoryStore.setSummary(runId, summary); } catch { }

        // 发送总结事件，包含失败信息
        emitRunEvent(runId, {
          type: 'summary',
          summary,
          success: summaryResult.success,
          error: summaryResult.error,
          attempts: summaryResult.attempts
        });
        await HistoryStore.append(runId, {
          type: 'summary',
          summary,
          success: summaryResult.success,
          error: summaryResult.error,
          attempts: summaryResult.attempts
        });
      }
    } catch (e) {
      emitRunEvent(runId, { type: 'done', error: String(e) });
      await HistoryStore.append(runId, { type: 'done', error: String(e) });
    } finally {
      const cancelled = isRunCancelled(runId);
      try { markRunFinished(runId, { cancelled }); } catch { }
      try { removeRun(runId); } catch { }
      try { await sub.return?.(); } catch { }
      try { RunEvents.close(runId); } catch { }
      try { clearRunCancelled(runId); } catch { }
    }
  })();

  try {
    for await (const ev of sub) {
      yield ev;
      if (ev?.type === 'completed' || ev?.type === 'summary' || ev?.type === 'cancelled') break;
    }
  } finally {
    const cancelled = isRunCancelled(runId);
    try { markRunFinished(runId, { cancelled }); } catch { }
    try { removeRun(runId); } catch { }
    try { await sub.return?.(); } catch { }
    try { RunEvents.close(runId); } catch { }
    try { clearRunCancelled(runId); } catch { }
  }
}

export async function* planThenExecuteStreamToolsXml({ objective, toolsXml, context = {}, mcpcore, conversation }) {
  const runId = uuidv4();
  const sub = RunEvents.subscribe(runId);
  const ctx0 = (context && typeof context === 'object') ? context : {};
  registerRunStart({ runId, channelId: ctx0.channelId, identityKey: ctx0.identityKey, objective });
  const ctx = injectConcurrencyOverlay({ runId, objective, context: ctx0 });

  (async () => {
    try {
      const sanitizedCtx = sanitizeContextForLog(ctx);
      emitRunEvent(runId, { type: 'start', objective, context: sanitizedCtx });
      await HistoryStore.append(runId, { type: 'start', objective, context: sanitizedCtx });

      let manifest0 = buildPlanningManifest(mcpcore);

      const judge = { need: true, summary: 'direct_tools_xml', toolNames: [], ok: true, forced: true };
      const toolPreReplySingleSkipTools = Array.isArray(config.flags?.toolPreReplySingleSkipTools)
        ? config.flags.toolPreReplySingleSkipTools
        : [];
      emitRunEvent(runId, {
        type: 'judge',
        need: true,
        summary: judge.summary,
        toolNames: judge.toolNames,
        ok: true,
        forced: true,
        toolPreReplySingleSkipTools
      });
      await HistoryStore.append(runId, {
        type: 'judge',
        need: true,
        summary: judge.summary,
        toolNames: judge.toolNames,
        ok: true,
        forced: true,
        toolPreReplySingleSkipTools
      });

      const rawToolsXml = String(toolsXml || '').trim();
      const calls = parseFunctionCalls(rawToolsXml, { format: (config.fcLlm?.format || 'sentra') });
      const steps = (Array.isArray(calls) ? calls : [])
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          stepId: newStepId(),
          aiName: String(c.name || '').trim(),
          reason: ['direct_tools_xml'],
          nextStep: '',
          draftArgs: (c.arguments && typeof c.arguments === 'object') ? c.arguments : {},
          dependsOnStepIds: undefined
        }))
        .filter((s) => s.aiName);

      const plan0 = { manifest: manifest0, steps };
      const plan = normalizePlanStepIds(plan0);
      await HistoryStore.setPlan(runId, plan);
      emitRunEvent(runId, { type: 'plan', plan });
      await HistoryStore.append(runId, { type: 'plan', plan });

      const exec = await executePlan(runId, objective, mcpcore, plan, { conversation, context: ctx });

      if (isRunCancelled(runId)) {
        const summary = '本次运行已被上游取消（用户改主意），仅保留已完成的工具结果，不再继续评估与总结。';
        try { await HistoryStore.setSummary(runId, summary); } catch { }
        emitRunEvent(runId, { type: 'done', exec, cancelled: true });
        await HistoryStore.append(runId, { type: 'done', exec, cancelled: true });
        emitRunEvent(runId, { type: 'summary', summary, cancelled: true });
        await HistoryStore.append(runId, { type: 'summary', summary, cancelled: true });
        return;
      }

      const enableEval = config.flags?.enableEval !== false;
      let evalObj = null;
      if (enableEval) {
        evalObj = await evaluateRun(objective, plan, exec, runId, ctx);
      }

      emitRunEvent(runId, { type: 'done', exec });
      await HistoryStore.append(runId, { type: 'done', exec });

      const enableSummary = config.flags?.enableSummary !== false;
      emitRunEvent(runId, {
        type: 'completed',
        exec,
        evaluation: enableEval ? evalObj : null,
        summaryPending: enableSummary,
        resultStream: true,
        resultStatus: 'final'
      });
      await HistoryStore.append(runId, {
        type: 'completed',
        exec,
        evaluation: enableEval ? evalObj : null,
        summaryPending: enableSummary,
        resultStream: true,
        resultStatus: 'final'
      });

      if (enableSummary) {
        const summaryResult = await summarizeToolHistory(runId, '', ctx);
        const summary = summaryResult.summary || '';
        try { await HistoryStore.setSummary(runId, summary); } catch { }
        emitRunEvent(runId, {
          type: 'summary',
          summary,
          success: summaryResult.success,
          error: summaryResult.error,
          attempts: summaryResult.attempts
        });
        await HistoryStore.append(runId, {
          type: 'summary',
          summary,
          success: summaryResult.success,
          error: summaryResult.error,
          attempts: summaryResult.attempts
        });
      }
    } catch (e) {
      emitRunEvent(runId, { type: 'done', error: String(e) });
      await HistoryStore.append(runId, { type: 'done', error: String(e) });
    } finally {
      const cancelled = isRunCancelled(runId);
      try { markRunFinished(runId, { cancelled }); } catch { }
      try { removeRun(runId); } catch { }
      try { await sub.return?.(); } catch { }
      try { RunEvents.close(runId); } catch { }
      try { clearRunCancelled(runId); } catch { }
    }
  })();

  try {
    for await (const ev of sub) {
      yield ev;
      if (ev?.type === 'completed' || ev?.type === 'summary') break;
    }
  } finally {
    const cancelled = isRunCancelled(runId);
    try { markRunFinished(runId, { cancelled }); } catch { }
    try { removeRun(runId); } catch { }
    try { await sub.return?.(); } catch { }
    try { RunEvents.close(runId); } catch { }
    try { clearRunCancelled(runId); } catch { }
  }
}

export default { generatePlan, executePlan, evaluateRun, planThenExecute, planThenExecuteStream };
