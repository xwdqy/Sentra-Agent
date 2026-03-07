import { config, getStageTimeoutMs } from '../../config/index.js';
import logger from '../../logger/index.js';
import { chatCompletion } from '../../openai/client.js';
import { HistoryStore } from '../../history/store.js';
import { parseFunctionCalls } from '../../utils/fc.js';
import { getRunCancelMeta } from '../../bus/runCancel.js';
import { compactMessages } from '../utils/messages.js';
import { emitRunEvent } from '../utils/events.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { XMLParser } from 'fast-xml-parser';

const cancelXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false
});

function formatReason(reason) {
  if (Array.isArray(reason) && reason.length > 0) {
    return reason.join('; ');
  }
  return '';
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'');
}

function extractTextFromProtocolXml(raw) {
  const s = String(raw || '').trim();
  if (!s || !s.startsWith('<')) return '';
  const getText = (node) => {
    if (node == null) return '';
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
    if (Array.isArray(node)) return node.map((it) => getText(it)).join('');
    if (typeof node === 'object') {
      if (typeof node['#text'] === 'string') return node['#text'];
      let out = '';
      for (const [k, v] of Object.entries(node)) {
        if (k === '#text') continue;
        out += getText(v);
      }
      return out;
    }
    return '';
  };
  const collectByTag = (node, tagName, out) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) collectByTag(item, tagName, out);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === '#text') continue;
      if (String(k).toLowerCase() === tagName) {
        const t = decodeXmlEntities(getText(v).trim());
        if (t) out.push(t);
      }
      collectByTag(v, tagName, out);
    }
  };
  try {
    const parsed = cancelXmlParser.parse(`<root>${s}</root>`);
    const root = parsed && typeof parsed === 'object' ? parsed.root : null;
    const texts = [];
    collectByTag(root, 'text', texts);
    if (texts.length > 0) return texts.join('\n').trim();
    const previews = [];
    collectByTag(root, 'preview_text', previews);
    if (previews.length > 0) return previews.join('\n').trim();
  } catch { }
  return '';
}

function normalizeRuntimeObjectiveText(signal) {
  const direct = String(signal?.objective || signal?.latestUserObjective || '').trim();
  if (direct) return direct;
  const xmlRaw = String(signal?.objectiveXml || signal?.latestUserObjectiveXml || '').trim();
  if (!xmlRaw) return '';
  return extractTextFromProtocolXml(xmlRaw);
}

function buildCancelledEvaluation(summary, baseEval = null) {
  const base = (baseEval && typeof baseEval === 'object') ? baseEval : {};
  return {
    ...base,
    success: false,
    incomplete: true,
    cancelled: true,
    nextAction: 'cancelled',
    completionLevel: 'cancelled',
    summary: String(summary || '').trim(),
    feedbackUsedCount: Number(base.feedbackUsedCount || 0),
    feedbackEvidence: Array.isArray(base.feedbackEvidence) ? base.feedbackEvidence.slice(0, 6) : [],
  };
}

export async function emitCancelledTerminalEvents({
  runId,
  exec,
  summary,
  adaptiveRoundsUsed = 0,
  evaluation = null
}) {
  const safeExec = (exec && typeof exec === 'object')
    ? exec
    : { used: [], attempted: 0, succeeded: 0, successRate: 0 };
  const cancelMeta = getRunCancelMeta(runId) || {};
  const finalSummary = String(cancelMeta.reason || summary || '').trim() || 'Run cancelled by upstream request.';
  const cancelledEval = buildCancelledEvaluation(finalSummary, evaluation);
  const controlToolResult = {
    type: 'tool_result',
    aiName: 'runtime__control',
    stepId: 'runtime_cancelled',
    plannedStepIndex: -1,
    executionIndex: -1,
    reason: 'runtime_cancelled',
    runtimeControl: 'cancelled',
    resultStream: true,
    resultStatus: 'final',
    result: {
      success: true,
      code: 'RUN_CANCELLED',
      provider: 'system',
      data: {
        controlEvent: 'cancelled',
        synthetic: true,
        toolCalls: 0,
        noReplySuggested: true,
        runtimeTool: {
          name: 'runtime__control',
          action: 'cancel'
        },
        summary: finalSummary,
        reason: String(cancelMeta.reason || finalSummary || ''),
        source: String(cancelMeta.source || ''),
        decision: String(cancelMeta.decision || ''),
        latestUserObjective: String(cancelMeta.latestUserObjective || ''),
        latestUserObjectiveXml: String(cancelMeta.latestUserObjectiveXml || ''),
        userIntentText: String(cancelMeta.userIntentText || cancelMeta.latestUserObjective || '')
      }
    }
  };
  emitRunEvent(runId, controlToolResult);
  await HistoryStore.append(runId, controlToolResult);

  emitRunEvent(runId, { type: 'done', exec: safeExec, cancelled: true });
  await HistoryStore.append(runId, { type: 'done', exec: safeExec, cancelled: true });

  const completedEv = {
    type: 'completed',
    exec: safeExec,
    evaluation: cancelledEval,
    finalAction: 'cancelled',
    adaptiveRoundsUsed: Number.isFinite(Number(adaptiveRoundsUsed)) ? Math.max(0, Math.floor(Number(adaptiveRoundsUsed))) : 0,
    summaryPending: true,
    resultStream: true,
    resultStatus: 'cancelled',
    cancelled: true
  };
  emitRunEvent(runId, completedEv);
  await HistoryStore.append(runId, completedEv);

  try { await HistoryStore.setSummary(runId, finalSummary); } catch { }
  emitRunEvent(runId, { type: 'summary', summary: finalSummary, cancelled: true, finalAction: 'cancelled' });
  await HistoryStore.append(runId, { type: 'summary', summary: finalSummary, cancelled: true, finalAction: 'cancelled' });
}

export function normalizeRuntimeSignalAction(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'cancel') return 'cancel';
  if (s === 'replan') return 'replan';
  if (s === 'supplement') return 'supplement';
  if (s === 'append') return 'append';
  if (s === 'ignore') return 'ignore';
  if (s === 'cancel_only') return 'cancel';
  if (s === 'cancel_and_restart' || s === 'restart') return 'replan';
  if (s === 'continue' || s === 'none') return 'ignore';
  return '';
}

export function buildRuntimeSignalDecisionArtifacts({ signal, decision, phase = 'loop', stepIndex = -1 } = {}) {
  const signalTs = Number(signal?.ts || 0);
  const effectiveTs = Number.isFinite(signalTs) && signalTs > 0 ? signalTs : Date.now();
  const objectiveText = normalizeRuntimeObjectiveText(signal);
  const objectiveXml = String(signal?.objectiveXml || signal?.latestUserObjectiveXml || '').trim();
  const generationRaw = Number(signal?.generation ?? signal?.context?.generation ?? 0);
  const signalSeqRaw = Number(signal?.signalSeq ?? signal?.context?.signalSeq ?? 0);
  const generation = Number.isFinite(generationRaw) && generationRaw > 0 ? Math.floor(generationRaw) : 0;
  const signalSeq = Number.isFinite(signalSeqRaw) && signalSeqRaw > 0 ? Math.floor(signalSeqRaw) : 0;
  const source = String(signal?.source || '');
  const signalReason = String(signal?.reason || '');
  const action = normalizeRuntimeSignalAction(decision?.action) || 'ignore';
  const reason = String(decision?.reason || signalReason).trim();

  const receivedEvent = {
    type: 'runtime_signal_received',
    phase,
    stepIndex,
    signalTs: effectiveTs,
    source,
    reason: signalReason,
    message: objectiveText,
    userObjective: objectiveText,
    generation,
    signalSeq,
    ...(objectiveXml ? { objectiveXml } : {}),
  };
  const decisionEvent = {
    type: 'runtime_signal_decision',
    phase,
    stepIndex,
    signalTs: effectiveTs,
    action,
    reason,
    message: objectiveText,
    userObjective: objectiveText,
    generation,
    signalSeq,
    ...(objectiveXml ? { objectiveXml } : {}),
  };
  const runtimeDirective = action === 'ignore'
    ? null
    : {
      action,
      reason,
      message: objectiveText,
      userObjective: objectiveText,
      userIntentText: objectiveText,
      ...(objectiveXml ? { objectiveXml } : {}),
      ...(generation > 0 ? { generation } : {}),
      ...(signalSeq > 0 ? { signalSeq } : {}),
      source,
      ts: effectiveTs,
    };

  return {
    signalTs,
    objectiveText,
    source,
    signalReason,
    action,
    reason,
    receivedEvent,
    decisionEvent,
    runtimeDirective
  };
}

async function decideRuntimeSignalActionByLLM({ runId, signal, objective, plan, context = {} }) {
  const prompt = await loadPrompt('runtime_signal_judge');
  const overlays = (context?.promptOverlays || context?.overlays || {});
  const overlayGlobal = overlays.global?.system || overlays.global || '';
  const overlaySignal = overlays.runtime_signal?.system || overlays.runtime_signal || '';
  const sys = composeSystem(prompt.system, [overlayGlobal, overlaySignal].filter(Boolean).join('\n\n'));
  const stepBrief = (Array.isArray(plan?.steps) ? plan.steps : [])
    .slice(0, 12)
    .map((s, i) => `${i + 1}. ${String(s?.aiName || '').trim()} | ${String(s?.stepId || '').trim()} | ${String(formatReason(s?.reason)).trim()}`)
    .join('\n');
  const signalObjective = normalizeRuntimeObjectiveText(signal);
  const signalText = signalObjective;
  const signalObjectiveXml = String(signal?.objectiveXml || signal?.latestUserObjectiveXml || '').trim();
  const signalMeta = JSON.stringify({
    source: String(signal?.source || ''),
    reason: String(signal?.reason || ''),
    decision: String(signal?.decision || ''),
    actionHint: String(signal?.actionHint || ''),
    objective: signalObjective,
    objectiveXml: signalObjectiveXml,
    ts: Number(signal?.ts || Date.now())
  });
  const userTpl = prompt.user || [
    'Objective:',
    '{{objective}}',
    '',
    'Signal message:',
    '{{signalText}}',
    '',
    'Signal meta:',
    '{{signalMeta}}',
    '',
    'Current plan brief:',
    '{{stepBrief}}',
    '',
    'Return exactly one <sentra-tools> with invoke name="runtime_signal_decision".'
  ].join('\n');
  const userMsg = renderTemplate(userTpl, { objective: String(objective || ''), signalText, signalMeta, stepBrief });
  const messages = compactMessages([
    { role: 'system', content: sys },
    { role: 'user', content: userMsg }
  ]);
  const res = await chatCompletion({
    messages,
    temperature: 0,
    timeoutMs: Math.max(3000, Math.min(30000, Number(getStageTimeoutMs('judge') || 8000)))
  });
  const content = String(res?.choices?.[0]?.message?.content || '');
  const calls = parseFunctionCalls(content, {});
  const call = calls.find((c) => String(c.name || '') === 'runtime_signal_decision') || calls[0];
  const args = (call && typeof call.arguments === 'object') ? call.arguments : {};
  const action = normalizeRuntimeSignalAction(args.action || args.decision);
  const reason = String(args.reason || '').trim();
  return {
    action: action || 'ignore',
    reason,
    raw: content,
  };
}

export async function resolveRuntimeSignalAction({ runId, signal, objective, plan, context = {} }) {
  if (!signal || typeof signal !== 'object') return { action: 'ignore', reason: '' };
  const signalText = normalizeRuntimeObjectiveText(signal);
  if (!signalText) return { action: 'ignore', reason: '' };
  const directAction = normalizeRuntimeSignalAction(
    signal?.action || signal?.actionHint || signal?.decision || ''
  );
  if (directAction) {
    return {
      action: directAction,
      reason: String(signal?.reason || signal?.reasonCode || '').trim()
    };
  }
  try {
    return await decideRuntimeSignalActionByLLM({ runId, signal, objective, plan, context });
  } catch (e) {
    if (config.flags.enableVerboseSteps) {
      logger.warn?.('runtime_signal_judge failed, fallback ignore', { label: 'RUN', runId, error: String(e) });
    }
    return { action: 'ignore', reason: '' };
  }
}

export async function pollAndHandleRuntimeSignal({
  runId,
  objective,
  plan,
  context = {},
  phase = 'loop',
  stepIndex = -1,
  runtimeSignalCursorTs = 0,
  runtimeSignalGeneration = 0,
  runtimeSignalSeq = 0,
  readLatestRuntimeUserSignal,
  resolveRuntimeSignalAction,
  buildRuntimeSignalDecisionArtifacts,
  emitRunEvent,
  appendHistory,
  isExecutionActive,
  markRunCancelled,
  isHardStopAction,
  abortRunRequests
}) {
  const baseCursorTs = Number.isFinite(Number(runtimeSignalCursorTs)) ? Number(runtimeSignalCursorTs) : 0;
  const baseGeneration = Number.isFinite(Number(runtimeSignalGeneration)) ? Number(runtimeSignalGeneration) : 0;
  const baseSignalSeq = Number.isFinite(Number(runtimeSignalSeq)) ? Number(runtimeSignalSeq) : 0;
  const done = (patch = {}) => ({
    runtimeSignalCursorTs: baseCursorTs,
    runtimeSignalGeneration: baseGeneration,
    runtimeSignalSeq: baseSignalSeq,
    runtimeDirective: null,
    stopRequested: false,
    hardStopRequested: false,
    ...patch
  });
  const emitIgnored = async (nextCursorTs, reasonCode, signal) => {
    try {
      const ignoredEvent = {
        type: 'runtime_signal_ignored',
        phase,
        stepIndex,
        signalTs: Number(signal?.ts || Date.now()),
        reasonCode: String(reasonCode || ''),
        runIdMismatch: String(signal?.runId || ''),
        generation: Number(signal?.generation ?? signal?.context?.generation ?? 0) || 0,
        signalSeq: Number(signal?.signalSeq ?? signal?.context?.signalSeq ?? 0) || 0,
        source: String(signal?.source || ''),
      };
      emitRunEvent(runId, ignoredEvent);
      await appendHistory(runId, ignoredEvent);
    } catch { }
    return nextCursorTs;
  };

  if (!isExecutionActive()) {
    return done();
  }

  const signal = await readLatestRuntimeUserSignal(runId, baseCursorTs);
  if (!signal) {
    return done();
  }

  const signalTs = Number(signal?.ts || 0);
  const nextCursorTs = (Number.isFinite(signalTs) && signalTs > baseCursorTs) ? signalTs : baseCursorTs;
  if (!isExecutionActive()) {
    return done({ runtimeSignalCursorTs: nextCursorTs });
  }

  const signalRunId = String(signal?.runId || '').trim();
  if (signalRunId && signalRunId !== String(runId || '').trim()) {
    const cursor = await emitIgnored(nextCursorTs, 'run_id_mismatch', signal);
    return done({ runtimeSignalCursorTs: cursor });
  }

  const signalGenerationRaw = Number(signal?.generation ?? signal?.context?.generation ?? 0);
  let nextGeneration = baseGeneration;
  if (Number.isFinite(signalGenerationRaw) && signalGenerationRaw > 0) {
    const signalGeneration = Math.floor(signalGenerationRaw);
    if (baseGeneration > 0 && signalGeneration < baseGeneration) {
      const cursor = await emitIgnored(nextCursorTs, 'stale_generation', signal);
      return done({ runtimeSignalCursorTs: cursor });
    }
    if (signalGeneration > nextGeneration) {
      nextGeneration = signalGeneration;
    }
  }

  const signalSeqRaw = Number(signal?.signalSeq ?? signal?.context?.signalSeq ?? 0);
  const baseSeqForCurrentGeneration = nextGeneration > baseGeneration ? 0 : baseSignalSeq;
  if (Number.isFinite(signalSeqRaw) && signalSeqRaw > 0 && baseSeqForCurrentGeneration > 0) {
    const signalSeq = Math.floor(signalSeqRaw);
    if (signalSeq <= baseSeqForCurrentGeneration) {
      const cursor = await emitIgnored(nextCursorTs, 'duplicate_or_reordered_signal_seq', signal);
      return done({
        runtimeSignalCursorTs: cursor,
        runtimeSignalGeneration: nextGeneration,
        runtimeSignalSeq: baseSignalSeq
      });
    }
  }

  const decision = await resolveRuntimeSignalAction({ runId, signal, objective, plan, context });
  if (!isExecutionActive()) {
    return done({
      runtimeSignalCursorTs: nextCursorTs,
      runtimeSignalGeneration: nextGeneration,
      runtimeSignalSeq: baseSignalSeq
    });
  }

  const artifacts = buildRuntimeSignalDecisionArtifacts({ signal, decision, phase, stepIndex });
  const objectiveText = artifacts.objectiveText;
  const nextSignalSeq = Number.isFinite(signalSeqRaw) && signalSeqRaw > 0
    ? Math.max(baseSeqForCurrentGeneration, Math.floor(signalSeqRaw))
    : baseSignalSeq;
  if (!objectiveText) {
    return done({
      runtimeSignalCursorTs: nextCursorTs,
      runtimeSignalGeneration: nextGeneration,
      runtimeSignalSeq: nextSignalSeq
    });
  }

  emitRunEvent(runId, artifacts.receivedEvent);
  await appendHistory(runId, artifacts.receivedEvent);
  emitRunEvent(runId, artifacts.decisionEvent);
  await appendHistory(runId, artifacts.decisionEvent);

  const action = artifacts.action;
  const runtimeDirective = artifacts.runtimeDirective;
  if (!runtimeDirective || action === 'ignore') {
    return done({
      runtimeSignalCursorTs: nextCursorTs,
      runtimeSignalGeneration: nextGeneration,
      runtimeSignalSeq: nextSignalSeq
    });
  }

  const source = artifacts.source;
  if (action === 'cancel') {
      markRunCancelled(runId, {
        ts: runtimeDirective.ts,
        reason: runtimeDirective.reason || 'Runtime signal requested cancellation.',
        source: runtimeDirective.source || 'runtime_signal_judge',
        decision: 'cancel_only',
        latestUserObjective: objectiveText || '',
        latestUserObjectiveXml: String(runtimeDirective.objectiveXml || ''),
        userIntentText: objectiveText || '',
        cancelledBy: String(signal?.context?.userId || '')
      });
  }

  let hardStopRequested = false;
  let stopRequested = false;
  if (isHardStopAction(action)) {
    hardStopRequested = true;
    stopRequested = true;
    if (action === 'replan') {
      try {
        abortRunRequests(runId, runtimeDirective.reason || 'Runtime signal requested replan.', {
          source: source || 'runtime_signal_judge',
          decision: 'cancel_and_restart',
          ts: runtimeDirective.ts,
          latestUserObjective: objectiveText || '',
          latestUserObjectiveXml: String(runtimeDirective.objectiveXml || ''),
          userIntentText: objectiveText || '',
        });
      } catch { }
    }
  } else if (action === 'supplement') {
    stopRequested = true;
  }

  return done({
    runtimeSignalCursorTs: nextCursorTs,
    runtimeSignalGeneration: nextGeneration,
    runtimeSignalSeq: nextSignalSeq,
    runtimeDirective,
    stopRequested,
    hardStopRequested
  });
}

export async function readLatestRuntimeUserSignal(runId, sinceTs = 0) {
  const rid = String(runId || '').trim();
  if (!rid) return null;
  let hist = [];
  try {
    hist = await HistoryStore.list(rid, 0, -1);
  } catch {
    return null;
  }
  const signals = (Array.isArray(hist) ? hist : [])
    .filter((h) => h && h.type === 'user_runtime_signal')
    .filter((h) => {
      const ts = Number(h?.ts || 0);
      return Number.isFinite(ts) && ts > Number(sinceTs || 0);
    });
  if (!signals.length) return null;
  signals.sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
  return signals[signals.length - 1] || null;
}
