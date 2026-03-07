import logger from '../../logger/index.js';
import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { z } from 'zod';
import { buildPlanningManifest, manifestToBulletedText, manifestToXmlToolsCatalog } from './manifest.js';
import { rerankManifest } from './router.js';
import { getPreThought } from '../stages/prethought.js';
import { loadPrompt, renderTemplate, composeSystem, pickLocalizedPrompt } from '../prompts/loader.js';
import { compactMessages } from '../utils/messages.js';
import { clip } from '../../utils/text.js';
import { buildPlanFunctionCallInstruction, parseFunctionCalls, buildFCPolicy, buildFunctionCallInstruction, formatSentraResult } from '../../utils/fc.js';
import { HistoryStore } from '../../history/store.js';
import { isRunCancelled } from '../../bus/runCancel.js';
import { mapAndFilterPlanSteps } from '../controllers/plan_step_controller.js';
import {
  TERMINAL_RUNTIME_AI_NAME,
  pinTerminalRuntimeInManifest
} from '../../runtime/terminal/spec.js';

function now() { return Date.now(); }
function isTimeoutLikeErrorText(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('abort') ||
    text.includes('aborted')
  );
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// zod schema for emit_plan arguments decoded from FC <sentra-tools>
const PlanStepSchema = z.object({
  stepId: z.string().min(1),
  executor: z.enum(['mcp', 'sandbox']).optional(),
  actionRef: z.string().optional(),
  aiName: z.string().optional().default(''),
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
  dependsOnStepIds: z.array(z.string()).optional(),
});

const EmitPlanSchema = z.object({
  overview: z.string().optional(),
  steps: z.array(PlanStepSchema).optional().default([]),
}).passthrough();

// no bootstrap fallback; rely on retries

function buildAdaptiveEvalContextForPlan(previousEval) {
  const ev = (previousEval && typeof previousEval === 'object') ? previousEval : null;
  if (!ev) return null;
  const missingGoals = Array.isArray(ev.missingGoals)
    ? ev.missingGoals.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const failedSteps = Array.isArray(ev.failedSteps)
    ? ev.failedSteps
      .map((x) => {
        const item = (x && typeof x === 'object') ? x : {};
        const stepId = String(item.stepId || '').trim();
        const aiName = String(item.aiName || '').trim();
        const reason = String(item.reason || '').trim();
        if (!stepId && !aiName && !reason) return null;
        const displayIndexRaw = Number(item.displayIndex);
        return {
          ...(stepId ? { stepId } : {}),
          ...(aiName ? { aiName } : {}),
          ...(Number.isFinite(displayIndexRaw) ? { displayIndex: Math.floor(displayIndexRaw) } : {}),
          ...(reason ? { reason } : {}),
        };
      })
      .filter(Boolean)
    : [];
  return {
    success: ev.success === true,
    incomplete: ev.incomplete === true,
    nextAction: String(ev.nextAction || '').trim().toLowerCase() || undefined,
    completionLevel: String(ev.completionLevel || '').trim().toLowerCase() || undefined,
    summary: String(ev.summary || '').trim(),
    missingGoals,
    failedSteps,
  };
}

function buildResultForAdaptiveHistory(item = {}) {
  const result = (item?.result && typeof item.result === 'object') ? item.result : {};
  const actionResult = (item?.actionResult && typeof item.actionResult === 'object') ? item.actionResult : {};
  const evidence = Array.isArray(actionResult?.evidence) && actionResult.evidence.length
    ? actionResult.evidence
    : (Array.isArray(result?.evidence) ? result.evidence : []);
  const out = {
    success: result.success === true,
    code: String(result.code || ''),
    provider: String(result.provider || actionResult?.output?.provider || '')
  };
  if (evidence.length > 0) {
    out.data = { evidence: evidence.slice(0, 6) };
  } else if (typeof result?.message === 'string' && result.message.trim()) {
    out.data = { message: result.message.trim().slice(0, 360) };
  }
  return out;
}

function buildAdaptivePlanningMessages({ context = {}, toolResults = [] }) {
  const roundRaw = Number(context?.adaptiveRound || 0);
  const adaptiveRound = Number.isFinite(roundRaw) ? Math.max(0, Math.floor(roundRaw)) : 0;
  const previousEvalCtx = buildAdaptiveEvalContextForPlan(context?.previousEval);
  if (adaptiveRound <= 0 && !previousEvalCtx) return [];

  const evalPayload = previousEvalCtx || {
    success: undefined,
    incomplete: undefined,
    nextAction: String(context?.adaptiveAction || '').trim().toLowerCase() || undefined,
    completionLevel: undefined,
    summary: '',
    missingGoals: [],
    failedSteps: [],
  };

  const messages = [];
  const list = Array.isArray(toolResults) ? toolResults : [];
  for (const h of list) {
    const item = (h && typeof h === 'object') ? h : {};
    const xml = formatSentraResult({
      stepIndex: Number(item.plannedStepIndex ?? item.stepIndex ?? 0),
      stepId: item?.stepId,
      aiName: item.aiName,
      reason: item.reason,
      args: item.args || {},
      result: buildResultForAdaptiveHistory(item),
    });
    if (!String(xml || '').trim()) continue;
    messages.push({ role: 'user', content: xml });
    messages.push({
      role: 'assistant',
      content:
        `<sentra-message><chat_type>system_task</chat_type><message><segment index="1"><type>text</type><data><text>Recorded tool result for replanning context. step_id=${escapeXmlText(item?.stepId || '')}; tool=${escapeXmlText(item?.aiName || '')}.</text></data></segment></message></sentra-message>`
    });
  }

  const missingGoals = Array.isArray(evalPayload.missingGoals) ? evalPayload.missingGoals : [];
  const failedSteps = Array.isArray(evalPayload.failedSteps) ? evalPayload.failedSteps : [];
  const missingXml = missingGoals
    .map((g, idx) => `    <goal index="${idx + 1}">${escapeXmlText(g)}</goal>`)
    .join('\n');
  const failedXml = failedSteps
    .map((s, idx) => [
      `    <step index="${idx + 1}">`,
      `      <step_id>${escapeXmlText(s?.stepId || '')}</step_id>`,
      `      <ai_name>${escapeXmlText(s?.aiName || '')}</ai_name>`,
      `      <display_index>${escapeXmlText(s?.displayIndex ?? '')}</display_index>`,
      `      <reason>${escapeXmlText(s?.reason || '')}</reason>`,
      '    </step>'
    ].join('\n'))
    .join('\n');

  const evalXml = [
    '<sentra-adaptive-eval>',
    `  <run_id>${escapeXmlText(context?.runId || 'unknown')}</run_id>`,
    `  <adaptive_round>${adaptiveRound}</adaptive_round>`,
    `  <success>${escapeXmlText(evalPayload.success ?? '')}</success>`,
    `  <incomplete>${escapeXmlText(evalPayload.incomplete ?? '')}</incomplete>`,
    `  <next_action>${escapeXmlText(evalPayload.nextAction || '')}</next_action>`,
    `  <completion_level>${escapeXmlText(evalPayload.completionLevel || '')}</completion_level>`,
    `  <summary>${escapeXmlText(evalPayload.summary || '')}</summary>`,
    '  <missing_goals>',
    missingXml,
    '  </missing_goals>',
    '  <failed_steps>',
    failedXml,
    '  </failed_steps>',
    '</sentra-adaptive-eval>',
    '<root>Replan from these result-history messages. Reuse already successful outputs. Fix failed steps by reason. Only add missing goals; do not repeat completed deliverables.</root>'
  ].join('\n');

  messages.push({ role: 'user', content: evalXml });
  return compactMessages(messages);
}

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
  signal,
}) {
  const validNames = new Set(allowedAiNames || []);
  let steps = [];
  let lastContent = '';
  let lastSchemaErrors = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let reinforce = '';
    if (attempt > 1) {
      if (Array.isArray(lastSchemaErrors) && lastSchemaErrors.length > 0) {
        try {
          const pfFix = await loadPrompt('fc_plan_fix');
          const tplFix = pickLocalizedPrompt(pfFix, 'en') || pfFix.user || '';
          reinforce = renderTemplate(tplFix, {
            errors: JSON.stringify(lastSchemaErrors || [], null, 2),
            previous_xml: String(lastContent || '').slice(0, 4000),
          });
        } catch { }
      }

      if (!reinforce) {
        try {
          const pfRe = await loadPrompt('fc_reinforce_plan');
          const tplRe = pickLocalizedPrompt(pfRe, 'en');
          reinforce = renderTemplate(tplRe, {
            allowed_list: (allowedAiNames || []).join(', ') || '(none)',
            attempt: String(attempt),
            max_retries: String(maxRetries),
          });
        } catch { }
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
      signal,
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
    let rawCandidate = [];
    try {
      const rawArgs = call?.arguments || {};
      let parsed = {};
      try {
        const zres = EmitPlanSchema.safeParse(rawArgs);
        if (!zres.success) {
          const issues = zres.error?.issues || [];
          logger.warn?.('FC emit_plan schema validation failed', {
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

      const stepsArr = Array.isArray(parsed?.steps) ? parsed.steps : [];
      rawCandidate = Array.isArray(stepsArr) ? stepsArr : [];
      candidate = mapAndFilterPlanSteps(stepsArr, {
        allowedMcpAiNamesSet: validNames
      });
    } catch { }
    const filtered = candidate;

    if (
      filtered.length === 0 &&
      Array.isArray(rawCandidate) &&
      rawCandidate.length > 0 &&
      validNames.size > 0 &&
      (allowedAiNames || []).length > 0
    ) {
      const invalidIssues = [];
      const invalidNames = [];
      for (let idx = 0; idx < rawCandidate.length; idx++) {
        const name = rawCandidate[idx]?.aiName;
        if (typeof name === 'string' && name && !validNames.has(name)) {
          invalidNames.push(name);
          invalidIssues.push({
            path: ['steps', idx, 'aiName'],
            message: `aiName "${name}" is not in allowed list: ${(allowedAiNames || []).join(', ')}. You MUST choose aiName strictly from this allowed list and MUST NOT invent new tool names.`,
          });
        }
      }
      if (invalidIssues.length > 0) {
        logger.warn?.('FC emit_plan schema has invalid aiName values; forcing allowed list', {
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
    if (!config.planner?.auditEnable) {
      return { index: 0, audit: 'audit disabled' };
    }
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
    const instr = await buildFunctionCallInstruction({ name: 'select_plan', parameters: selectPlanSchema, locale: 'en' });
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
    } catch { }
    if (!Number.isFinite(idx)) idx = 0;
    idx = Math.max(0, Math.min(candidates.length - 1, idx));
    return { index: idx, audit: reason };
  } catch (e) {
    logger.warn?.('FC plan generation failed; fallback to default candidate 0', { label: 'PLAN', error: String(e) });
    return { index: 0, audit: '' };
  }
}

export async function generatePlanViaFC(objective, mcpcore, context = {}, conversation) {
  let manifest = pinTerminalRuntimeInManifest(buildPlanningManifest(mcpcore), { insertIfMissing: true });
  let rerankScoreByAiName = {};
  const externalReasons = Array.isArray(context?.externalReasons)
    ? context.externalReasons
      .map((x) => String(x || '').trim())
      .filter(Boolean)
    : [];
  const usePT = !!config.flags?.planUsePreThought;
  const preThought = usePT ? (await getPreThought(objective, manifest, conversation)) : '';

  const nowMs = () => Date.now();

  try {
    const judgeToolNames = (context?.judge && Array.isArray(context.judge.toolNames))
      ? context.judge.toolNames
      : (Array.isArray(context?.judgeToolNames) ? context.judgeToolNames : []);
    const judgeToolSet = new Set((judgeToolNames || []).filter(Boolean));
    const reservedAiNames = new Set([TERMINAL_RUNTIME_AI_NAME]);
    if (judgeToolSet.size > 0) {
      const filtered = (manifest || []).filter((m) => m && m.aiName && (judgeToolSet.has(m.aiName) || reservedAiNames.has(m.aiName)));
      if (filtered.length > 0) {
        manifest = pinTerminalRuntimeInManifest(filtered, { insertIfMissing: true });
      }
      if (config.flags.enableVerboseSteps) {
        logger.info('FC plan: judge tool whitelist applied', {
          label: 'PLAN',
          selectedCount: judgeToolSet.size,
          manifestCount: manifest.length
        });
      }
    }
  } catch (e) {
    logger.warn?.('FC plan: judge whitelist filtering failed', { label: 'PLAN', error: String(e) });
  }

  // Rerank tools by objective when enabled
  try {
    if (objective && (config.rerank?.enable !== false)) {
      const tRerank0 = nowMs();
      if (config.flags.enableVerboseSteps) {
        logger.info('FC rerank begin', {
          label: 'RERANK',
          hasExternalReasons: externalReasons.length > 0,
          externalReasonCount: externalReasons.length
        });
      }
      const ranked = await rerankManifest({
        manifest,
        objective,
        externalReasons
      });
      if (config.flags.enableVerboseSteps) {
        logger.info('FC rerank end', { label: 'RERANK', ms: nowMs() - tRerank0 });
      }
      if (Array.isArray(ranked?.manifest) && ranked.manifest.length) {
        manifest = pinTerminalRuntimeInManifest(ranked.manifest, { insertIfMissing: true });
        if (Array.isArray(ranked?.details) && ranked.details.length) {
          rerankScoreByAiName = Object.fromEntries(
            ranked.details
              .filter((d) => d && typeof d.aiName === 'string' && d.aiName.trim())
              .map((d) => [String(d.aiName).trim(), {
                final: Number(d.final || 0),
                intent: Number(d.intent || 0),
                trust: Number(d.trust || 0),
                relevance: Number(d.relevance || 0),
                probability: Number(d.probability || 0),
                keywordHitRatio: Number(d.keywordHitRatio || 0),
                regexHitRatio: Number(d.regexHitRatio || 0),
                rank: Number(d.rank || 0)
              }])
          );
        }
        if (config.flags.enableVerboseSteps) {
          const tools = manifest.map((x) => x.aiName).filter(Boolean);
          logger.info('FC rerank allowed tools', { label: 'RERANK', tools, total: tools.length });
        }
      }
    }
  } catch (e) {
    logger.warn?.('FC rerank failed', { label: 'RERANK', error: String(e) });
  }

  try {
    if (Array.isArray(manifest) && manifest.length > 0 && rerankScoreByAiName && typeof rerankScoreByAiName === 'object') {
      manifest = manifest.map((m, idx) => {
        if (!m || !m.aiName) return m;
        const key = String(m.aiName).trim();
        const rr = (key && Object.prototype.hasOwnProperty.call(rerankScoreByAiName, key))
          ? rerankScoreByAiName[key]
          : null;
        if (!rr || typeof rr !== 'object') return m;
        const rankRaw = Number(rr.rank);
        const rank = (Number.isFinite(rankRaw) && rankRaw > 0) ? Math.floor(rankRaw) : (idx + 1);
        return {
          ...m,
          rerank: {
            rank,
            probability: Number(rr.probability || 0),
            final: Number(rr.final || 0),
            intent: Number(rr.intent || 0),
            relevance: Number(rr.relevance || 0),
            trust: Number(rr.trust || 0)
          }
        };
      });
    }
  } catch { }

  manifest = pinTerminalRuntimeInManifest(manifest, { insertIfMissing: true });

  const allowedAiNames = (manifest || []).map((m) => m.aiName).filter(Boolean);
  if (config.flags.enableVerboseSteps) {
    logger.info('FC allowed tools prepared', { label: 'PLAN', allowedCount: allowedAiNames.length });
  }

  const tPrompt0 = nowMs();
  if (config.flags.enableVerboseSteps) {
    logger.info('FC emit_plan prompt build begin', { label: 'PLAN' });
  }
  const ep = await loadPrompt('emit_plan');
  if (config.flags.enableVerboseSteps) {
    logger.info('FC emit_plan prompt build end', { label: 'PLAN', ms: nowMs() - tPrompt0 });
  }
  const overlays = (context?.promptOverlays || context?.overlays || {});
  const overlayGlobal = overlays.global?.system || overlays.global || '';
  const overlayPlan = overlays.plan?.system || overlays.emit_plan?.system || overlays.plan || overlays.emit_plan || '';
  const sys = [
    composeSystem(ep.system, [overlayGlobal, overlayPlan].filter(Boolean).join('\n\n')),
    ep.concurrency_hint || ''
  ].filter(Boolean).join('\n\n');
  const policyText = await buildFCPolicy();
  const planInstrText = await buildPlanFunctionCallInstruction({ allowedAiNames, locale: 'en' });

  let historyMessages = [];
  let toolResultsForAdaptive = [];
  try {
    const runId = context?.runId;
    if (runId) {
      const tHist0 = nowMs();
      if (config.flags.enableVerboseSteps) {
        logger.info('FC historyStore.list begin', { label: 'HISTORY', runId });
      }
      const history = await HistoryStore.list(runId, 0, -1);
      if (config.flags.enableVerboseSteps) {
        logger.info('FC historyStore.list end', { label: 'HISTORY', runId, ms: nowMs() - tHist0, items: Array.isArray(history) ? history.length : 0 });
      }
      toolResultsForAdaptive = (history || []).filter(h => h.type === 'tool_result');
      if (toolResultsForAdaptive.length > 0) {
        for (const h of toolResultsForAdaptive) {
          const xml = formatSentraResult({
            stepIndex: Number(h.plannedStepIndex ?? h.stepIndex ?? 0),
            stepId: h?.stepId,
            aiName: h.aiName,
            reason: h.reason,
            args: h.args || {},
            result: buildResultForAdaptiveHistory(h)
          });
          if (!String(xml || '').trim()) continue;
          historyMessages.push({ role: 'user', content: xml });
          historyMessages.push({
            role: 'assistant',
            content:
              `<sentra-message><chat_type>system_task</chat_type><message><segment index="1"><type>text</type><data><text>Recorded tool result for replanning context. step_id=${escapeXmlText(h?.stepId || '')}; tool=${escapeXmlText(h?.aiName || '')}.</text></data></segment></message></sentra-message>`
          });
        }
      }
    }
  } catch { }
  const adaptivePlanningMsgs = buildAdaptivePlanningMessages({ context, toolResults: [] });
  const messages = compactMessages([
    { role: 'system', content: sys },
    ...(Array.isArray(conversation) ? conversation : []),
    ...historyMessages,
    ...adaptivePlanningMsgs,
    { role: 'user', content: renderTemplate(ep.user_goal, { objective }) },
    ...(usePT ? [{ role: 'assistant', content: renderTemplate(ep.assistant_thought, { preThought: preThought || '' }) }] : []),
    { role: 'assistant', content: renderTemplate(ep.assistant_manifest, { manifestBulleted: manifestToXmlToolsCatalog(manifest) }) },
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

  const planModelsRaw = Array.isArray(fc.planModels) ? fc.planModels : [];
  const planModels = planModelsRaw.filter((m) => typeof m === 'string' && m.trim());
  const uniqueModels = Array.from(new Set(planModels));

  const fallbackModel = getStageModel('plan');
  if (uniqueModels.length <= 1) {
    const modelName = uniqueModels[0] || fallbackModel;
    if (runId && isRunCancelled(runId)) {
      if (config.flags.enableVerboseSteps) {
        logger.info('FC plan aborted because run was cancelled (single-model path)', { label: 'PLAN', runId });
      }
      return { manifest, steps: [], rerankScoreByAiName };
    }

    const isValid = (x) => Array.isArray(x?.steps) && x.steps.length > 0;
    const tPlan0 = nowMs();
    if (config.flags.enableVerboseSteps) {
      logger.info('FC plan begin', { label: 'PLAN', mode: 'race2', model: modelName });
    }
    const tasks = [0, 1].map((i) => {
      const controller = new AbortController();
      const t0 = nowMs();
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
        signal: controller.signal,
      })
        .then((res) => ({ ok: true, res, i, ms: nowMs() - t0 }))
        .catch((err) => ({ ok: false, res: null, i, ms: nowMs() - t0, error: String(err || '') }));
    });

    let pick = await Promise.race(tasks);
    if (!pick?.ok || !isValid(pick?.res)) {
      const isTimeoutLike = isTimeoutLikeErrorText(pick?.error);
      if (isTimeoutLike) {
        if (config.flags.enableVerboseSteps) {
          logger.warn?.('FC plan race first pick timeout/abort; skip waiting peer and return no-tool plan', {
            label: 'PLAN',
            error: String(pick?.error || '')
          });
        }
      } else {
        const otherIndex = 1 - (Number(pick?.i) || 0);
        const waitPeerMs = Math.max(
          1000,
          Math.min(15000, Math.floor(Number(getStageTimeoutMs('plan') || 8000) * 0.1))
        );
        try {
          const other = await Promise.race([
            tasks[otherIndex],
            new Promise((resolve) => setTimeout(
              () => resolve({ ok: false, res: null, i: otherIndex, ms: waitPeerMs, error: `PEER_WAIT_TIMEOUT_${waitPeerMs}` }),
              waitPeerMs
            ))
          ]);
          if (other?.ok && isValid(other?.res)) {
            pick = other;
          } else if (config.flags.enableVerboseSteps) {
            logger.warn?.('FC plan race peer did not produce valid plan in wait window', {
              label: 'PLAN',
              waitPeerMs,
              peerError: String(other?.error || '')
            });
          }
        } catch { }
      }
    }

    const one = pick?.ok ? (pick?.res || {}) : {};
    if (config.flags.enableVerboseSteps) {
      logger.info('FC plan end', {
        label: 'PLAN',
        mode: 'race2',
        model: modelName,
        ms: nowMs() - tPlan0,
        picked: Number.isInteger(pick?.i) ? pick.i : -1,
        pickedMs: Number.isFinite(pick?.ms) ? pick.ms : -1,
        steps: Array.isArray(one?.steps) ? one.steps.length : 0,
      });
    }
    steps = Array.isArray(one?.steps) ? one.steps : [];
    lastContent = one?.raw || '';

    if (runId && isRunCancelled(runId)) {
      if (config.flags.enableVerboseSteps) {
        logger.info('FC plan cancelled after race completion; returning empty steps', { label: 'PLAN', runId });
      }
      return { manifest, steps: [], rerankScoreByAiName };
    }
  } else {
    if (runId && isRunCancelled(runId)) {
      if (config.flags.enableVerboseSteps) {
        logger.info('FC plan aborted because run was cancelled (multi-model path)', { label: 'PLAN', runId });
      }
      return { manifest, steps: [], rerankScoreByAiName };
    }

    if (config.flags.enableVerboseSteps) {
      logger.info('FC multi-model plan begin', { label: 'PLAN', models: uniqueModels });
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

    if (config.flags.enableVerboseSteps) {
      const summary = (results || []).map((r) => ({ model: r.model, ok: !!r.ok, ms: r.ms })).slice(0, 20);
      logger.info('FC multi-model planning complete', { label: 'PLAN', totalModels: uniqueModels.length, summary });
    }

    if (runId && isRunCancelled(runId)) {
      if (config.flags.enableVerboseSteps) {
        logger.info('FC multi-model plan cancelled before candidate selection', { label: 'PLAN', runId });
      }
      return { manifest, steps: [], rerankScoreByAiName };
    }

    const candidates = results
      .filter((r) => r.ok && r.res && Array.isArray(r.res.steps) && r.res.steps.length > 0)
      .map((r) => ({
        steps: Array.isArray(r.res.steps) ? r.res.steps : [],
        raw: r.res.raw || '',
        model: r.model,
      }));

    if (config.flags.enableVerboseSteps) {
      logger.info('FC multi-model candidate summary', {
        label: 'PLAN',
        totalModels: uniqueModels.length,
        candidates: candidates.length,
      });
    }

    if (candidates.length === 0) {
      const hasTimeoutLikeFailure = results.some((r) => !r?.ok && isTimeoutLikeErrorText(r?.error));
      if (hasTimeoutLikeFailure) {
        if (config.flags.enableVerboseSteps) {
          logger.warn?.('FC multi-model produced no candidates with timeout/abort failures; skip extra fallback and return no-tool plan', {
            label: 'PLAN',
            totalModels: uniqueModels.length
          });
        }
        steps = [];
        lastContent = '';
      } else {
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
      }
    } else if (candidates.length === 1) {
      steps = candidates[0].steps;
      lastContent = candidates[0].raw;
    } else {
      const tPick0 = nowMs();
      if (config.flags.enableVerboseSteps) {
        logger.info('FC selectBestPlan begin', { label: 'PLAN', candidates: candidates.length });
      }
      const pick = await selectBestPlan({ objective, manifest, candidates, context });
      if (config.flags.enableVerboseSteps) {
        logger.info('FC selectBestPlan end', { label: 'PLAN', candidates: candidates.length, ms: nowMs() - tPick0 });
      }
      const idx = Math.max(0, Math.min(candidates.length - 1, Number(pick.index) || 0));
      const best = candidates[idx];
      if (config.flags.enableVerboseSteps) {
        logger.info('FC selectBestPlan chose candidate', {
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
      } catch { }
    }
  }

  if (steps.length === 0) {
    const raw = String(lastContent || '');
    const rawSlice = raw.length > 4000 ? `${raw.slice(0, 4000)}...[truncated ${raw.length - 4000}]` : raw;
    const stageProvider = getStageProvider('plan');
    const stageModel = getStageModel('plan');
    logger.warn?.('FC plan produced no valid steps', {
      label: 'PLAN',
      retries: maxRetries,
      allowedCount: allowedAiNames.length,
      provider: {
        baseURL: stageProvider?.baseURL || '',
        model: stageModel || ''
      },
      contentRaw: rawSlice,
    });
  }
  if (config.flags.enableVerboseSteps) {
    logger.info('FC plan generated', { label: 'PLAN', stepsCount: steps.length, stepsPreview: clip(steps) });
  }

  return { manifest, steps, rerankScoreByAiName };
}

export default { generatePlanViaFC };
