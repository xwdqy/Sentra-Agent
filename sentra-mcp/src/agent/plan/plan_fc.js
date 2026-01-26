import logger from '../../logger/index.js';
import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { z } from 'zod';
import { buildPlanningManifest, manifestToBulletedText, manifestToXmlToolsCatalog } from './manifest.js';
import { rerankManifest } from './router.js';
import { getPreThought } from '../stages/prethought.js';
import { upsertPlanMemory, searchPlanMemories } from '../../memory/index.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { compactMessages } from '../utils/messages.js';
import { clip } from '../../utils/text.js';
import { buildPlanFunctionCallInstruction, parseFunctionCalls, buildFCPolicy, buildFunctionCallInstruction, formatSentraResult } from '../../utils/fc.js';
import { HistoryStore } from '../../history/store.js';
import { isRunCancelled } from '../../bus/runCancel.js';

function now() { return Date.now(); }

// zod schema for emit_plan arguments decoded from FC <sentra-tools>
// reason 最终仍要求是 string[]，但为了避免模型偶尔输出纯字符串
// 直接导致整份计划被丢弃，这里用 preprocess 把 string 自动收敛为 [string]。
const PlanStepSchema = z.object({
  aiName: z.string().min(1),
  reason: z.preprocess(
    (v) => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') {
        const t = v.trim();
        return t ? [t] : [];
      }
      return [];
    },
    z.array(z.string()).default([]),
  ),
  nextStep: z.string().optional().default(''),
  draftArgs: z.record(z.any()).optional().default({}),
  dependsOn: z.array(z.number()).optional(),
});

const EmitPlanSchema = z.object({
  overview: z.string().optional(),
  steps: z.array(PlanStepSchema).optional().default([]),
  // Backward compatibility: some models may still nest steps under plan.steps
  plan: z.object({ steps: z.array(PlanStepSchema).optional().default([]) }).partial().optional(),
}).passthrough();

/**
 * 规范化 reason：仅支持数组格式
 * - 数组：过滤并清理每项
 * - 其他：返回空数组（不兼容旧字符串格式）
 */
function normalizeReason(reason) {
  if (Array.isArray(reason)) {
    return reason.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim());
  }
  // 不再兼容字符串格式，直接返回空数组
  return [];
}

// no bootstrap fallback; rely on retries

async function generateSinglePlan({
  baseMessages,
  allowedAiNames,
  fc,
  planningTemp,
  top_p,
  maxRetries,
  policyText,
  planInstrText,
  model,
}) {
  const validNames = new Set(allowedAiNames || []);
  let steps = [];
  let lastContent = '';
  let lastSchemaErrors = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let reinforce = '';
    if (attempt > 1) {
      // 若上轮存在结构化 schema 错误，优先使用 FC 规划修复提示（英文），
      // 携带错误详情与上一轮的 <sentra-tools> 原始片段，引导模型按协议重写 emit_plan。
      if (Array.isArray(lastSchemaErrors) && lastSchemaErrors.length > 0) {
        try {
          const pfFix = await loadPrompt('fc_plan_fix');
          const tplFix = pfFix.en || pfFix.user || pfFix.zh;
          reinforce = renderTemplate(tplFix, {
            errors: JSON.stringify(lastSchemaErrors || [], null, 2),
            previous_xml: String(lastContent || '').slice(0, 4000),
          });
        } catch {}
      }

      // 若没有结构化错误信息可用，则退回到通用强化提示
      if (!reinforce) {
        try {
          const pfRe = await loadPrompt('fc_reinforce_plan');
          const tplRe = pfRe.en || pfRe.zh;
          reinforce = renderTemplate(tplRe, {
            allowed_list: (allowedAiNames || []).join(', ') || '(none)',
            attempt: String(attempt),
            max_retries: String(maxRetries),
          });
        } catch {}
      }
    }
    const attemptMessages = attempt === 1
      ? baseMessages
      : compactMessages([
          ...baseMessages,
          { role: 'user', content: reinforce },
          { role: 'user', content: [policyText, planInstrText].join('\n\n') },
        ]);

    const planModel = model || getStageModel('plan');
    const provider = getStageProvider('plan');
    const resp = await chatCompletion({
      messages: attemptMessages,
      temperature: planningTemp,
      top_p,
      timeoutMs: getStageTimeoutMs('plan'),
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
      model: planModel,
      ...(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0 ? { max_tokens: fc.maxTokens } : { omitMaxTokens: true })
    });
    const content = resp?.choices?.[0]?.message?.content || '';
    lastContent = content;
    const calls = parseFunctionCalls(String(content), {});
    const call = calls.find((c) => String(c.name) === 'emit_plan') || calls[0];
    let candidate = [];
    try {
      const rawArgs = call?.arguments || {};
      let parsed = {};
      try {
        const zres = EmitPlanSchema.safeParse(rawArgs);
        if (!zres.success) {
          const issues = zres.error?.issues || [];
          logger.warn?.('FC emit_plan schema 校验失败，将回退到空计划', {
            label: 'PLAN',
            errors: issues.map((it) => ({ path: it.path, message: it.message })) || [],
          });
          lastSchemaErrors = issues;
          parsed = {};
        } else {
          parsed = zres.data;
          lastSchemaErrors = null;
        }
      } catch {
        parsed = rawArgs || {};
        lastSchemaErrors = null;
      }

      // 新协议：优先使用顶层 steps；兼容旧协议：如果 steps 为空但存在 plan.steps，则回退使用 plan.steps
      const topSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
      const legacySteps = Array.isArray(parsed?.plan?.steps) ? parsed.plan.steps : [];
      const stepsArr = topSteps.length ? topSteps : legacySteps;

      candidate = stepsArr.map((s) => ({
        aiName: s?.aiName,
        reason: normalizeReason(s?.reason),
        nextStep: s?.nextStep || '',
        draftArgs: s?.draftArgs || {},
        dependsOn: Array.isArray(s?.dependsOn) ? s.dependsOn : undefined,
      }));
    } catch {}

    const filtered = validNames.size ? candidate.filter((s) => s.aiName && validNames.has(s.aiName)) : candidate;

    // 若 emit_plan 产出了步骤，但全部因 aiName 不在允许列表而被过滤，则构造“伪 schema 错误”
    // 交给 fc_plan_fix 提示词使用，用于显式提醒模型不要发明 schedule_progress / timer 等非法工具名。
    if (
      filtered.length === 0 &&
      candidate.length > 0 &&
      validNames.size > 0 &&
      (allowedAiNames || []).length > 0
    ) {
      const invalidIssues = [];
      const invalidNames = [];
      for (let idx = 0; idx < candidate.length; idx++) {
        const name = candidate[idx]?.aiName;
        if (typeof name === 'string' && name && !validNames.has(name)) {
          invalidNames.push(name);
          invalidIssues.push({
            path: ['steps', idx, 'aiName'],
            message: `aiName "${name}" is not in allowed list: ${(allowedAiNames || []).join(', ')}. You MUST choose aiName strictly from this allowed list and MUST NOT invent new tool names (for example schedule_* or timer). Any scheduling / time-delay semantics must be expressed via a schedule field inside draftArgs of a valid tool, not as a separate scheduling tool.`,
          });
        }
      }
      if (invalidIssues.length > 0) {
        logger.warn?.('FC emit_plan 产出的步骤全部使用了不在允许列表中的 aiName，将视为规划错误', {
          label: 'PLAN',
          invalidAiNames: invalidNames,
          allowedAiNames,
        });
        lastSchemaErrors = invalidIssues;
      }
    }

    if (filtered.length > 0 || (allowedAiNames || []).length === 0) {
      steps = filtered;
      break;
    }
  }
  return { steps, raw: lastContent };
}

async function selectBestPlan({ objective, manifest, candidates, context }) {
  try {
    const pa = await loadPrompt('plan_audit');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayAudit = overlays.audit?.system || overlays.plan_audit?.system || overlays.audit || overlays.plan_audit || '';
    const sys = composeSystem(pa.system, [overlayGlobal, overlayAudit].filter(Boolean).join('\n\n'));
    const manifestText = manifestToXmlToolsCatalog(Array.isArray(manifest) ? manifest : []);
    const candidatesList = candidates.map((c, i) => `#${i}: ${clip(c.steps, 1200)}`).join('\n');
    const base = compactMessages([
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
    // 构造 select_plan 函数调用指令（FC sentra-tools）
    const selectPlanSchema = {
      type: 'object',
      properties: {
        best: { type: 'integer', minimum: 0 },
        reason: { type: 'string' },
        scores: {
          type: 'object',
          properties: {
            executability: { type: 'number', minimum: 0, maximum: 1 },
            robustness: { type: 'number', minimum: 0, maximum: 1 },
            goal_fit: { type: 'number', minimum: 0, maximum: 1 },
            minimality: { type: 'number', minimum: 0, maximum: 1 },
            dependency_clarity: { type: 'number', minimum: 0, maximum: 1 },
            efficiency: { type: 'number', minimum: 0, maximum: 1 }
          },
          additionalProperties: true
        },
        notes: { type: 'string' }
      },
      required: ['best'],
      additionalProperties: true
    };
    const policyText = await buildFCPolicy();
    const instr = await buildFunctionCallInstruction({ name: 'select_plan', parameters: selectPlanSchema, locale: 'zh-CN' });
    const messages = compactMessages([...base, { role: 'user', content: [policyText, instr].join('\n\n') }]);

    const fc = config.fcLlm || {};
    const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
    const planModel = getStageModel('plan');
    const provider = getStageProvider('plan');
    const resp = await chatCompletion({
      messages,
      temperature: Number.isFinite(fc.planTemperature) ? fc.planTemperature : Math.max(0.1, ((Number.isFinite(fc.temperature) ? fc.temperature : (config.llm.temperature ?? 0.2)) - 0.1)),
      timeoutMs: getStageTimeoutMs('plan'),
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
      model: planModel,
      ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
    });
    const content = resp?.choices?.[0]?.message?.content || '';
    const calls = parseFunctionCalls(String(content), {});
    const call = calls.find((c) => String(c.name) === 'select_plan') || calls[0];
    let idx = 0; let reason = '';
    try {
      const parsed = call?.arguments || {};
      idx = Number(parsed?.best);
      reason = String(parsed?.reason || '');
    } catch {}
    if (!Number.isFinite(idx)) idx = 0;
    idx = Math.max(0, Math.min(candidates.length - 1, idx));
    return { index: idx, audit: reason };
  } catch (e) {
    logger.warn?.('FC 多计划审核失败，回退到候选#0', { label: 'PLAN', error: String(e) });
    return { index: 0, audit: '' };
  }
}

export async function generatePlanViaFC(objective, mcpcore, context = {}, conversation) {
  let manifest = buildPlanningManifest(mcpcore);
  const usePT = !!config.flags?.planUsePreThought;
  const preThought = usePT ? (await getPreThought(objective, manifest, conversation)) : '';

  // Judge 白名单过滤：如果 Judge 已经明确选择了需要调用的工具，则优先收敛到这部分工具。
  // 目的：减少规划阶段看到全量工具导致的“污染/跑偏”，并提升速度与稳定性。
  try {
    const judgeToolNames = (context?.judge && Array.isArray(context.judge.toolNames))
      ? context.judge.toolNames
      : (Array.isArray(context?.judgeToolNames) ? context.judgeToolNames : []);
    const judgeToolSet = new Set((judgeToolNames || []).filter(Boolean));
    if (judgeToolSet.size > 0) {
      const filtered = (manifest || []).filter((m) => m && m.aiName && judgeToolSet.has(m.aiName));
      if (filtered.length > 0) {
        manifest = filtered;
      }
      if (config.flags.enableVerboseSteps) {
        logger.info('FC 规划：Judge 白名单过滤', { label: 'PLAN', selectedCount: judgeToolSet.size, manifestCount: manifest.length });
      }
    }
  } catch (e) {
    logger.warn?.('FC 规划：Judge 白名单过滤失败（忽略并继续）', { label: 'PLAN', error: String(e) });
  }

  // 中文：在 FC 规划前执行工具重排序（仅使用 objective）
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
          logger.info('FC 规划前重排序Top工具', { label: 'RERANK', top: tops });
        }
      }
    }
  } catch (e) {
    logger.warn?.('FC 规划前重排序失败（忽略并继续）', { label: 'RERANK', error: String(e) });
  }
  const allowedAiNames = (manifest || []).map((m) => m.aiName).filter(Boolean);
  if (config.flags.enableVerboseSteps) {
    logger.info('FC 规划：允许工具数量', { label: 'PLAN', allowedCount: allowedAiNames.length });
  }

  // 历史规划参考
  let planMemoryMsgs = [];
  if (config.memory?.enable) {
    try {
      const mems = await searchPlanMemories({ objective });
      if (Array.isArray(mems) && mems.length) {
        const lines = mems.map((m, idx) => `#${idx + 1} (score=${m.score.toFixed(2)}):\n${m.text}`).join('\n\n');
        planMemoryMsgs.push({ role: 'assistant', content: `历史规划参考:\n${lines}` });
        if (config.flags.enableVerboseSteps) {
          logger.info('检索到历史规划参考', { label: 'MEM', hits: mems.length, topScore: Number(mems[0]?.score?.toFixed?.(2) || 0), minScore: config.memory.minScore });
        }
      }
    } catch {}
  }

  const ep = await loadPrompt('emit_plan');
  const overlays = (context?.promptOverlays || context?.overlays || {});
  const overlayGlobal = overlays.global?.system || overlays.global || '';
  const overlayPlan = overlays.plan?.system || overlays.emit_plan?.system || overlays.plan || overlays.emit_plan || '';
  const sys = [
    composeSystem(ep.system, [overlayGlobal, overlayPlan].filter(Boolean).join('\n\n')),
    ep.concurrency_hint || ''
  ].filter(Boolean).join('\n\n');
  const policyText = await buildFCPolicy();
  const planInstrText = await buildPlanFunctionCallInstruction({ allowedAiNames, locale: 'zh-CN' });
  
  // 从相同 runId 复用执行历史（Sentra XML），避免在上游拼接历史
  let historyMessages = [];
  try {
    const runId = context?.runId;
    if (runId) {
      const history = await HistoryStore.list(runId, 0, -1);
      const toolResults = (history || []).filter(h => h.type === 'tool_result');
      if (toolResults.length > 0) {
        const xml = toolResults.map(h => formatSentraResult({
          stepIndex: Number(h.plannedStepIndex ?? h.stepIndex ?? 0),
          aiName: h.aiName,
          reason: h.reason,
          args: h.args || {},
          result: h.result || {}
        })).join('\n\n');
        if (xml.trim()) {
          historyMessages.push({ role: 'assistant', content: xml });
        }
      }
    }
  } catch {}
  const messages = compactMessages([
    { role: 'system', content: sys },
    ...(Array.isArray(conversation) ? conversation : []),
    ...historyMessages,
    { role: 'user', content: renderTemplate(ep.user_goal, { objective }) },
    ...(usePT ? [{ role: 'assistant', content: renderTemplate(ep.assistant_thought, { preThought: preThought || '' }) }] : []),
    { role: 'assistant', content: renderTemplate(ep.assistant_manifest, { manifestBulleted: manifestToXmlToolsCatalog(manifest) }) },
    ...planMemoryMsgs,
    { role: 'user', content: ep.user_request },
    { role: 'user', content: [policyText, planInstrText].join('\n\n') },
  ]);

  const fc = config.fcLlm || {};
  const planningTemp = Number.isFinite(config.fcLlm?.planTemperature)
    ? config.fcLlm.planTemperature
    : Math.max(0.1, ((Number.isFinite(fc.temperature) ? fc.temperature : (config.llm.temperature ?? 0.2)) - 0.1));
  const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
  const maxRetries = Math.max(1, Number(fc.planMaxRetries ?? 3));
  const top_p = Number.isFinite(config.fcLlm?.planTopP) ? config.fcLlm.planTopP : undefined;

  const runId = context?.runId;

  let steps = [];
  let lastContent = '';

  // 规划模型列表：
  // - 若 PLAN_FC_MODEL 配置了多个模型（逗号分隔），则对每个模型各生成一份候选计划
  // - 若仅配置 1 个或未配置，则退化为单模型单计划（不再使用单模型 K 变体采样）
  const planModelsRaw = Array.isArray(fc.planModels) ? fc.planModels : [];
  const planModels = planModelsRaw.filter((m) => typeof m === 'string' && m.trim());
  const uniqueModels = Array.from(new Set(planModels));

  // 若未显式配置 PLAN_FC_MODEL，则使用阶段默认模型（getStageModel('plan')）
  const fallbackModel = getStageModel('plan');
  if (uniqueModels.length <= 1) {
    const modelName = uniqueModels[0] || fallbackModel;
    if (runId && isRunCancelled(runId)) {
      if (config.flags.enableVerboseSteps) {
        logger.info('FC 规划：运行已取消，跳过单模型规划', { label: 'PLAN', runId });
      }
      return { manifest, steps: [] };
    }

    const one = await generateSinglePlan({
      baseMessages: messages,
      allowedAiNames,
      fc,
      planningTemp,
      top_p,
      maxRetries,
      policyText,
      planInstrText,
      model: modelName,
    });
    steps = Array.isArray(one.steps) ? one.steps : [];
    lastContent = one.raw || '';

    if (runId && isRunCancelled(runId)) {
      if (config.flags.enableVerboseSteps) {
        logger.info('FC 规划：单模型规划完成后运行被取消，返回空计划', { label: 'PLAN', runId });
      }
      return { manifest, steps: [] };
    }
  } else {
    if (runId && isRunCancelled(runId)) {
      if (config.flags.enableVerboseSteps) {
        logger.info('FC 多模型规划：运行已取消，跳过规划', { label: 'PLAN', runId });
      }
      return { manifest, steps: [] };
    }

    if (config.flags.enableVerboseSteps) {
      logger.info('FC 多模型规划：开始为每个模型生成候选计划', { label: 'PLAN', models: uniqueModels });
    }

    const tasks = uniqueModels.map((modelName) => {
      const t0 = now();
      return generateSinglePlan({
        baseMessages: messages,
        allowedAiNames,
        fc,
        planningTemp,
        top_p,
        maxRetries,
        policyText,
        planInstrText,
        model: modelName,
      })
        .then((res) => ({ ok: true, res, model: modelName, ms: now() - t0 }))
        .catch((err) => ({ ok: false, res: null, model: modelName, ms: now() - t0, error: String(err || '') }));
    });

    const results = await Promise.all(tasks);

    if (runId && isRunCancelled(runId)) {
      if (config.flags.enableVerboseSteps) {
        logger.info('FC 多模型规划：规划过程中检测到运行已取消，返回空计划', { label: 'PLAN', runId });
      }
      return { manifest, steps: [] };
    }

    const candidates = results
      .filter((r) => r.ok && r.res && Array.isArray(r.res.steps) && r.res.steps.length > 0)
      .map((r) => ({
        steps: Array.isArray(r.res.steps) ? r.res.steps : [],
        raw: r.res.raw || '',
        model: r.model,
      }));

    if (config.flags.enableVerboseSteps) {
      logger.info('FC 多模型规划：生成候选数量', {
        label: 'PLAN',
        totalModels: uniqueModels.length,
        candidates: candidates.length,
      });
    }

    if (candidates.length === 0) {
      // 若所有模型均未产出有效步骤，则回退到主模型单次规划
      const primaryModel = uniqueModels[0] || fallbackModel;
      const one = await generateSinglePlan({
        baseMessages: messages,
        allowedAiNames,
        fc,
        planningTemp,
        top_p,
        maxRetries,
        policyText,
        planInstrText,
        model: primaryModel,
      });
      steps = Array.isArray(one.steps) ? one.steps : [];
      lastContent = one.raw || '';
    } else if (candidates.length === 1) {
      steps = candidates[0].steps;
      lastContent = candidates[0].raw;
    } else {
      const pick = await selectBestPlan({ objective, manifest, candidates, context });
      const idx = Math.max(0, Math.min(candidates.length - 1, Number(pick.index) || 0));
      const best = candidates[idx];
      if (config.flags.enableVerboseSteps) {
        logger.info('FC 多模型规划：选择候选', {
          label: 'PLAN',
          index: idx,
          model: best.model,
          audit: clip(String(pick.audit || ''), 360),
        });
      }
      steps = best.steps;
      lastContent = best.raw;
      try {
        if (context?.runId) {
          await HistoryStore.append(context.runId, {
            type: 'plan_audit',
            mode: 'fc',
            candidates: candidates.length,
            chosenIndex: idx,
            chosenModel: best.model,
            reason: String(pick.audit || ''),
          });
        }
      } catch {}
    }
  }

  if (steps.length === 0) {
    const raw = String(lastContent || '');
    const rawSlice = raw.length > 4000 ? `${raw.slice(0, 4000)}…[truncated ${raw.length - 4000}]` : raw;
    if (config.flags.enableVerboseSteps || !selected) {
      logger.info('FC 计划候选选择优（select_plan）结果', {
        label: 'PLAN',
        retries: maxRetries,
        allowedCount: allowedAiNames.length,
        provider: { baseURL: provider.baseURL, model: planModel },
        contentRaw: rawSlice,
      });
    }
  }
  if (config.flags.enableVerboseSteps) {
    logger.info(`规划生成(FC): 共 ${steps.length} 步`, { label: 'PLAN', stepsPreview: clip(steps) });
  }

  // 记忆
  if (config.memory?.enable) {
    try { await upsertPlanMemory({ runId: context?.runId || 'unknown', objective, plan: { steps } }); } catch {}
  }

  return { manifest, steps };
}

export default { generatePlanViaFC };
