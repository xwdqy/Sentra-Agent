import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import logger from '../../logger/index.js';
import { chatCompletion } from '../../openai/client.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy, formatSentraResult } from '../../utils/fc.js';
import { clip } from '../../utils/text.js';
import { manifestToXmlToolsCatalog } from '../plan/manifest.js';
import { buildSelectedSkillsInstructionsText } from '../../skills/index.js';
import { HistoryStore } from '../../history/store.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function buildToolHistoryXml(runId) {
  if (!runId) return '';
  try {
    const history = await HistoryStore.list(runId, 0, -1);
    const results = history.filter((h) => h.type === 'tool_result');
    if (results.length === 0) return '';
    const limit = 4;
    const tail = results.slice(-limit);
    const blocks = tail.map((h) => {
      const plannedStepIndex = Number(h.plannedStepIndex);
      const stepIndex = Number.isFinite(plannedStepIndex) ? plannedStepIndex : 0;
      return formatSentraResult({
        stepIndex,
        aiName: String(h.aiName || ''),
        reason: Array.isArray(h.reason) ? h.reason : (typeof h.reason === 'string' ? h.reason : ''),
        args: h.args || {},
        result: h.result || {},
      });
    });
    return blocks.join('\n\n');
  } catch {
    return '';
  }
}

async function buildToolHistoryXmlForStep({ runId, stepIndex, planSteps }) {
  if (!runId) return '';
  const stepsArr = Array.isArray(planSteps) ? planSteps : [];
  const idx = Number(stepIndex);
  const deps0 = Array.isArray(stepsArr[idx]?.dependsOn) ? stepsArr[idx].dependsOn : [];
  const depSet = new Set();
  const q = [];
  for (const d0 of deps0) {
    const d = Number(d0);
    if (Number.isInteger(d) && d >= 0 && d < stepsArr.length && d !== idx) {
      depSet.add(d);
      q.push(d);
    }
  }
  while (q.length) {
    const cur = q.shift();
    const deps = Array.isArray(stepsArr[cur]?.dependsOn) ? stepsArr[cur].dependsOn : [];
    for (const d0 of deps) {
      const d = Number(d0);
      if (!Number.isInteger(d) || d < 0 || d >= stepsArr.length || d === cur) continue;
      if (!depSet.has(d)) {
        depSet.add(d);
        q.push(d);
      }
    }
  }

  try {
    const history = await HistoryStore.list(runId, 0, -1);
    const results = history.filter((h) => h.type === 'tool_result');
    if (results.length === 0) return '';

    const latestByPlanned = new Map();
    for (const h of results) {
      const p = Number(h.plannedStepIndex);
      if (!Number.isFinite(p)) continue;
      latestByPlanned.set(p, h);
    }

    const last = results[results.length - 1];
    const mustInclude = new Set();
    if (last && Number.isFinite(Number(last.plannedStepIndex))) {
      mustInclude.add(Number(last.plannedStepIndex));
    }

    const want = depSet.size > 0
      ? Array.from(new Set([...depSet, ...mustInclude])).sort((a, b) => a - b)
      : [];

    const picked = [];
    if (want.length) {
      for (const p of want) {
        const h = latestByPlanned.get(p);
        if (h) picked.push(h);
      }
    }

    if (picked.length === 0) {
      return await buildToolHistoryXml(runId);
    }

    const blocks = picked.map((h) => {
      const plannedStepIndex = Number(h.plannedStepIndex);
      const sidx = Number.isFinite(plannedStepIndex) ? plannedStepIndex : 0;
      return formatSentraResult({
        stepIndex: sidx,
        aiName: String(h.aiName || ''),
        reason: Array.isArray(h.reason) ? h.reason : (typeof h.reason === 'string' ? h.reason : ''),
        args: h.args || {},
        result: h.result || {},
      });
    });
    return blocks.join('\n\n');
  } catch {
    return '';
  }
}

export async function stepReflect({
  runId,
  objective,
  phase,
  stepIndex,
  step,
  planSteps,
  manifest,
  context,
}) {
  try {
    const enabled = Boolean(config.flags?.enableStepReflection);
    if (!enabled) return null;

    const selectedSkills = Array.isArray(context?.selectedSkills) ? context.selectedSkills : [];

    const pr = await loadPrompt('step_reflection_fc');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayReflection = overlays.reflection?.system || overlays.step_reflection?.system || overlays.reflection || overlays.step_reflection || '';
    const sys = composeSystem(pr.system, [overlayGlobal, overlayReflection].filter(Boolean).join('\n\n'));

    const availableTools = manifestToXmlToolsCatalog(Array.isArray(manifest) ? manifest : []);
    const recentXml = await buildToolHistoryXmlForStep({ runId, stepIndex, planSteps });

    const stepsArr = Array.isArray(planSteps) ? planSteps : [];
    const totalSteps = stepsArr.length;
    const plannedSteps = stepsArr.map((s, idx) => {
      const a = String(s?.aiName || '');
      const n = String(s?.nextStep || '');
      return `${idx + 1}. ${a}${n ? ` -> ${n}` : ''}`;
    }).join('\n');
    const remainingSteps = stepsArr.slice(Math.max(0, Number(stepIndex) + 1)).map((s, idx) => {
      const a = String(s?.aiName || '');
      const n = String(s?.nextStep || '');
      const realIndex = Number(stepIndex) + 2 + idx;
      return `${realIndex}. ${a}${n ? ` -> ${n}` : ''}`;
    }).join('\n') || '(none)';

    const reason = Array.isArray(step?.reason) ? step.reason.join('; ') : String(step?.reason || '');
    const nextStep = String(step?.nextStep || '');
    const draftArgs = step?.draftArgs ? JSON.stringify(step.draftArgs, null, 2) : '{}';

    const skillsText = buildSelectedSkillsInstructionsText({ selected: selectedSkills });

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const schemaPath = path.resolve(__dirname, '../tools/internal/step_reflect.schema.json');
    let schema = { type: 'object', properties: { action: { type: 'string' }, rationale: { type: 'string' } }, required: ['action', 'rationale'] };
    try {
      const raw = await fs.readFile(schemaPath, 'utf-8');
      schema = JSON.parse(raw);
    } catch (e) {
      logger.warn?.('StepReflection: 无法读取 step_reflect schema，使用默认', { label: 'REFLECTION', error: String(e) });
    }

    const policy = await buildFCPolicy({ locale: 'zh-CN' });
    const instr = await buildFunctionCallInstruction({ name: 'step_reflect', parameters: schema, locale: 'zh-CN' });

    const messages = [
      { role: 'system', content: sys },
      { role: 'user', content: renderTemplate(pr.user_context, {
        objective: objective || '无明确目标',
        phase: phase || 'before_step',
        stepIndex: String(stepIndex),
        aiName: String(step?.aiName || ''),
        reason,
        nextStep,
        draftArgs,
        totalSteps: String(totalSteps),
        plannedSteps: plannedSteps || '(none)',
        remainingSteps,
        recentResults: recentXml || '(none)',
        availableTools,
      }) },
      ...(skillsText ? [{ role: 'user', content: skillsText }] : []),
      { role: 'user', content: [policy, instr, pr.user_request].filter(Boolean).join('\n\n') }
    ];

    const provider = getStageProvider('reflection');
    const model = getStageModel('reflection');

    const res = await chatCompletion({
      messages,
      temperature: 0.2,
      timeoutMs: getStageTimeoutMs('reflection'),
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
      model,
      ...(Number.isFinite(Number(config.fcLlm?.maxTokens)) && Number(config.fcLlm.maxTokens) > 0
        ? { max_tokens: Number(config.fcLlm.maxTokens) }
        : { omitMaxTokens: true })
    });

    const content = res?.choices?.[0]?.message?.content || '';
    if (config.flags.enableVerboseSteps) {
      logger.info('StepReflection: 模型响应', {
        label: 'REFLECTION',
        runId,
        stepIndex,
        phase,
        provider: { baseURL: provider.baseURL, model },
        contentPreview: clip(String(content))
      });
    }

    const calls = parseFunctionCalls(String(content), {});
    const call = calls.find((c) => String(c.name) === 'step_reflect') || calls[0];
    if (!call || String(call.name) !== 'step_reflect') return null;

    const args = call.arguments || {};
    if (!args || typeof args !== 'object') return null;

    return {
      action: String(args.action || ''),
      rationale: String(args.rationale || ''),
      args_patch: (args.args_patch && typeof args.args_patch === 'object') ? args.args_patch : null,
      replace_step: (args.replace_step && typeof args.replace_step === 'object') ? args.replace_step : null,
      insert_steps: Array.isArray(args.insert_steps) ? args.insert_steps : null,
      replan_objective: typeof args.replan_objective === 'string' ? args.replan_objective : '',
      confidence: Number.isFinite(Number(args.confidence)) ? Number(args.confidence) : null,
      _raw: args,
    };
  } catch (e) {
    try { logger.warn?.('StepReflection: 调用失败（跳过）', { label: 'REFLECTION', runId, stepIndex, phase, error: String(e) }); } catch {}
    return null;
  }
}
