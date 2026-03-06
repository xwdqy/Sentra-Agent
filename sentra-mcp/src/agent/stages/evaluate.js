import logger from '../../logger/index.js';
import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { HistoryStore } from '../../history/store.js';
import { loadPrompt, renderTemplate, composeSystem, pickLocalizedPrompt } from '../prompts/loader.js';
import { compactMessages } from '../utils/messages.js';
import { emitRunEvent } from '../utils/events.js';
import { getPreThought } from './prethought.js';
import { clip } from '../../utils/text.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy } from '../../utils/fc.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { loadToolDef } from '../tools/loader.js';
import { manifestToBulletedText, manifestToXmlToolsCatalog } from '../plan/manifest.js';
import { queryByDeps } from '../workspace/registry.js';
import { truncateTextByTokens } from '../../utils/tokenizer.js';
import { normalizeEvalAction } from '../controllers/eval_decision_policy.js';

function toBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return fallback;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function logEvalFcPreview({ attempt, provider, model, content, calls }) {
  const count = Array.isArray(calls) ? calls.length : 0;
  const providerInfo = { baseURL: provider?.baseURL, model };
  if (count > 0) {
    logger.info('FC eval parsed output', {
      label: 'EVAL',
      attempt,
      provider: providerInfo,
      count,
      firstCallName: String(calls?.[0]?.name || ''),
      firstCallPreview: clip(calls?.[0]),
      length: String(content || '').length
    });
    return;
  }
  logger.warn('FC eval parse failed, fallback raw preview', {
    label: 'EVAL',
    attempt,
    provider: providerInfo,
    count: 0,
    rawPreview: clip(String(content)),
    length: String(content || '').length
  });
}

const PRE_FEEDBACK_PHASES = new Set([
  'tool_pre_reply',
  'delay_ack',
  'delay_deferred_judge',
  'delay_deferred_completed',
]);

function isPreFeedbackPhase(phaseLike) {
  const phase = String(phaseLike || '').trim().toLowerCase();
  if (!phase) return false;
  return PRE_FEEDBACK_PHASES.has(phase);
}

function isLikelyUserVisibleDeliveryContent(contentLike) {
  const content = String(contentLike || '').trim();
  if (!content) return false;
  if (!content.includes('<sentra-message>')) return false;
  if (!content.includes('<message>')) return false;
  if (/<type>\s*(music|image|video|record|file|json|share|markdown|mface|face)\s*<\/type>/i.test(content)) {
    return true;
  }
  return /<type>\s*text\s*<\/type>/i.test(content);
}

function clipEvalTextByTokens(value, maxTokens, suffix = '...') {
  const text = String(value ?? '');
  const limit = Number(maxTokens);
  if (!Number.isFinite(limit) || limit <= 0) return text;
  return truncateTextByTokens(text, {
    maxTokens: Math.max(1, Math.floor(limit)),
    model: getStageModel('eval'),
    suffix
  }).text;
}

function normalizeAssistantFeedback(raw, history = []) {
  const payload = (raw && typeof raw === 'object') ? raw : {};
  const batchesRaw = Array.isArray(payload.batches) ? payload.batches : [];
  const responsesRaw = Array.isArray(payload.responses)
    ? payload.responses
    : batchesRaw.flatMap((b) => (Array.isArray(b?.responses) ? b.responses : []));
  const historyRaw = Array.isArray(history) ? history : [];

  const clipContent = (v, max = Number(config.truncation?.evaluate?.feedbackContentMaxTokens ?? 300)) => {
    const s = String(v ?? '');
    if (!s) return '';
    return clipEvalTextByTokens(s, max, '...');
  };

  const historyResponsesRaw = [];
  for (const ev of historyRaw) {
    if (!ev || typeof ev !== 'object') continue;
    const type = String(ev.type || '').trim().toLowerCase();
    if (type === 'assistant_response_batch') {
      const arr = Array.isArray(ev.responses) ? ev.responses : [];
      for (const item of arr) historyResponsesRaw.push(item);
      continue;
    }
    if (type === 'assistant_delivery') {
      historyResponsesRaw.push({
        phase: String(ev.phase || 'unknown'),
        content: String(ev.content || ''),
        noReply: ev.noReply === true,
        delivered: ev.delivered === true,
        ts: Number.isFinite(Number(ev.ts)) ? Number(ev.ts) : 0,
      });
    }
  }

  const mergedResponsesRaw = [...responsesRaw, ...historyResponsesRaw];
  const dedupe = new Set();
  const responses = mergedResponsesRaw
    .map((r) => {
      const item = (r && typeof r === 'object') ? r : {};
      const content = clipContent(item.content, Number(config.truncation?.evaluate?.feedbackContentMaxTokens ?? 300));
      if (!content) return null;
      const out = {
        phase: String(item.phase || 'unknown'),
        content,
        noReply: item.noReply === true,
        delivered: item.delivered === true,
        ts: Number.isFinite(Number(item.ts)) ? Number(item.ts) : 0,
      };
      const key = `${out.phase}|${out.ts}|${out.noReply ? 1 : 0}|${out.delivered ? 1 : 0}|${out.content}`;
      if (dedupe.has(key)) return null;
      dedupe.add(key);
      return out;
    })
    .filter(Boolean)
    .sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));

  const deliveredResponses = responses.filter((r) => r.delivered === true && r.noReply !== true);
  const deliveredNonPreResponses = deliveredResponses.filter((r) => !isPreFeedbackPhase(r.phase));
  const userVisibleDeliveredResponses = deliveredNonPreResponses.filter((r) => isLikelyUserVisibleDeliveryContent(r.content));

  return {
    responseCount: responses.length,
    responses,
    deliveredCount: deliveredResponses.length,
    deliveredNonPreCount: deliveredNonPreResponses.length,
    userVisibleDeliveredCount: userVisibleDeliveredResponses.length,
    hasUserVisibleDelivered: userVisibleDeliveredResponses.length > 0,
  };
}

function buildFeedbackEvidence(rawEvidence, assistantFeedback) {
  const normEvidence = Array.isArray(rawEvidence) ? rawEvidence : [];
  const mapped = normEvidence
    .map((it) => {
      const item = (it && typeof it === 'object') ? it : {};
      const phase = String(item.phase || '').trim();
      const excerpt = String(item.excerpt || item.content || '').trim();
      if (!phase || !excerpt) return null;
      const ts = Number(item.ts);
      return {
        phase,
        excerpt: clipEvalTextByTokens(excerpt, Number(config.truncation?.evaluate?.feedbackExcerptMaxTokens ?? 120), '...'),
        ...(Number.isFinite(ts) ? { ts: Math.floor(ts) } : {}),
      };
    })
    .filter(Boolean);

  if (mapped.length > 0) return mapped.slice(0, 12);

  const responses = Array.isArray(assistantFeedback?.responses) ? assistantFeedback.responses : [];
  const fallback = responses
    .filter((r) => r && typeof r === 'object')
    .slice(0, 12)
    .map((r) => {
      const phase = String(r.phase || 'unknown').trim() || 'unknown';
      const content = String(r.content || '').trim();
      const excerpt = clipEvalTextByTokens(content, Number(config.truncation?.evaluate?.feedbackExcerptMaxTokens ?? 120), '...');
      const ts = Number(r.ts);
      if (!excerpt) return null;
      return {
        phase,
        excerpt,
        ...(Number.isFinite(ts) && ts > 0 ? { ts: Math.floor(ts) } : {}),
      };
    })
    .filter(Boolean);
  return fallback;
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderAssistantFeedbackXml(assistantFeedback = {}) {
  const responses = Array.isArray(assistantFeedback?.responses) ? assistantFeedback.responses : [];
  const nodes = responses.slice(0, 24).map((r, i) => [
    `    <feedback index="${i + 1}">`,
    `      <phase>${escapeXmlText(String(r?.phase || 'unknown'))}</phase>`,
    `      <content>${escapeXmlText(String(r?.content || ''))}</content>`,
    `      <delivered>${r?.delivered === true ? 'true' : 'false'}</delivered>`,
    `      <no_reply>${r?.noReply === true ? 'true' : 'false'}</no_reply>`,
    (Number.isFinite(Number(r?.ts)) && Number(r.ts) > 0 ? `      <ts>${Math.floor(Number(r.ts))}</ts>` : ''),
    '    </feedback>',
  ].filter(Boolean).join('\n'));
  if (!nodes.length) return '';
  return [
    '<assistant_feedback>',
    `  <response_count>${responses.length}</response_count>`,
    '  <delivery_stats>',
    `    <delivered_count>${Math.max(0, Math.floor(Number(assistantFeedback?.deliveredCount || 0)))}</delivered_count>`,
    `    <delivered_non_pre_count>${Math.max(0, Math.floor(Number(assistantFeedback?.deliveredNonPreCount || 0)))}</delivered_non_pre_count>`,
    `    <user_visible_delivered_count>${Math.max(0, Math.floor(Number(assistantFeedback?.userVisibleDeliveredCount || 0)))}</user_visible_delivered_count>`,
    `    <has_user_visible_delivered>${assistantFeedback?.hasUserVisibleDelivered ? 'true' : 'false'}</has_user_visible_delivered>`,
    '  </delivery_stats>',
    '  <items>',
    ...nodes,
    '  </items>',
    '</assistant_feedback>',
  ].join('\n');
}

function buildFeedbackDeliveryAssessment(assistantFeedback, exec) {
  const attempted = Number(exec?.attempted || 0);
  const succeeded = Number(exec?.succeeded || 0);
  const allSucceeded = Number.isFinite(attempted) && Number.isFinite(succeeded) && attempted > 0 && succeeded >= attempted;
  return {
    attempted: Number.isFinite(attempted) ? attempted : 0,
    succeeded: Number.isFinite(succeeded) ? succeeded : 0,
    allSucceeded,
    hasUserVisibleDelivered: assistantFeedback?.hasUserVisibleDelivered === true,
    deliveredCount: Math.max(0, Number(assistantFeedback?.deliveredCount || 0)),
    deliveredNonPreCount: Math.max(0, Number(assistantFeedback?.deliveredNonPreCount || 0)),
    userVisibleDeliveredCount: Math.max(0, Number(assistantFeedback?.userVisibleDeliveredCount || 0))
  };
}

function attachFeedbackDeliveryAssessment(result, assistantFeedback, exec) {
  const base = (result && typeof result === 'object') ? result : {};
  return {
    ...base,
    feedbackDeliveryAssessment: buildFeedbackDeliveryAssessment(assistantFeedback, exec)
  };
}

function attachRuntimeProtocolAssessment(result, runtimeProtocolEvidence = null) {
  const base = (result && typeof result === 'object') ? result : {};
  const stats = (runtimeProtocolEvidence && typeof runtimeProtocolEvidence === 'object' && runtimeProtocolEvidence.stats)
    ? runtimeProtocolEvidence.stats
    : {};
  return {
    ...base,
    runtimeProtocolAssessment: {
      hasEvidence: runtimeProtocolEvidence?.hasEvidence === true,
      actionRequestCount: Number(stats.actionRequestCount || 0),
      actionResultCount: Number(stats.actionResultCount || 0),
      terminalStepStateCount: Number(stats.terminalStepStateCount || 0),
      attempted: Number(stats.attempted || 0),
      succeeded: Number(stats.succeeded || 0),
      successRate: Number(stats.successRate || 0)
    }
  };
}

function buildConservativeEvalFallback(assistantFeedback = {}, reason = 'eval_unavailable') {
  const reasonText = String(reason || '').trim() || 'eval_unavailable';
  return {
    success: false,
    incomplete: true,
    nextAction: 'replan',
    completionLevel: 'poor',
    summary: `Evaluation unavailable: ${reasonText}`,
    feedbackUsedCount: assistantFeedback.responseCount || 0,
    feedbackEvidence: buildFeedbackEvidence([], assistantFeedback),
    fallbackReason: reasonText
  };
}

function validateFinalJudgePayload(rawArgs = {}, normalized = {}) {
  const raw = (rawArgs && typeof rawArgs === 'object') ? rawArgs : {};
  const result = (normalized && typeof normalized === 'object') ? normalized : {};
  const errors = [];

  if (!hasOwn(raw, 'success')) errors.push('missing_required.success');
  if (!hasOwn(raw, 'incomplete')) errors.push('missing_required.incomplete');
  if (!hasOwn(raw, 'feedbackUsedCount')) errors.push('missing_required.feedbackUsedCount');
  if (!hasOwn(raw, 'feedbackEvidence')) errors.push('missing_required.feedbackEvidence');

  const feedbackUsedCount = Number(result?.feedbackUsedCount ?? raw?.feedbackUsedCount);
  if (!Number.isFinite(feedbackUsedCount) || feedbackUsedCount < 0) {
    errors.push('invalid.feedbackUsedCount_non_negative_integer');
  }

  const feedbackEvidence = Array.isArray(result?.feedbackEvidence)
    ? result.feedbackEvidence
    : (Array.isArray(raw?.feedbackEvidence) ? raw.feedbackEvidence : []);
  if (!Array.isArray(feedbackEvidence) || feedbackEvidence.length === 0) {
    errors.push('invalid.feedbackEvidence_empty');
  } else {
    const hasBadItem = feedbackEvidence.some((ev) => {
      const item = (ev && typeof ev === 'object') ? ev : {};
      const phase = String(item.phase || '').trim();
      const excerpt = String(item.excerpt || '').trim();
      return !phase || !excerpt;
    });
    if (hasBadItem) errors.push('invalid.feedbackEvidence_item_missing_phase_or_excerpt');
  }

  const success = result?.success === true;
  const failedSteps = Array.isArray(result?.failedSteps) ? result.failedSteps : [];
  if (!success && failedSteps.length === 0) {
    errors.push('invalid.failedSteps_required_when_success_false');
  }

  const summary = String(result?.summary || '').trim();
  if (!summary) errors.push('invalid.summary_empty');

  return errors;
}

function renderWorkspaceArtifactEvidenceXml(history = []) {
  const hist = Array.isArray(history) ? history : [];
  const diffs = hist.filter((h) => h && h.type === 'workspace_diff').slice(-20);
  const toolResults = hist.filter((h) => h && h.type === 'tool_result').slice(-40);
  const refs = [];
  for (const ev of toolResults) {
    const arr = Array.isArray(ev?.result?.artifacts) ? ev.result.artifacts : [];
    for (const a of arr.slice(0, 8)) {
      refs.push({
        stepId: String(ev?.stepId || ''),
        aiName: String(ev?.aiName || ''),
        uuid: String(a?.uuid || a?.artifactId || ''),
        path: String(a?.path || ''),
        role: String(a?.role || ''),
        type: String(a?.type || ''),
        hash: String(a?.hash || ''),
      });
    }
  }
  const limitedRefs = refs.slice(-80);
  if (!diffs.length && !limitedRefs.length) return '';

  const lines = [];
  lines.push('<workspace_evidence>');
  lines.push('  <diffs>');
  for (const d of diffs) {
    lines.push(
      `    <diff step_id="${escapeXmlText(String(d?.stepId || ''))}" ai_name="${escapeXmlText(String(d?.aiName || ''))}" added="${escapeXmlText(String(d?.summary?.added ?? 0))}" changed="${escapeXmlText(String(d?.summary?.changed ?? 0))}" removed="${escapeXmlText(String(d?.summary?.removed ?? 0))}" total_delta="${escapeXmlText(String(d?.summary?.totalDelta ?? 0))}" />`
    );
    const paths = Array.isArray(d?.paths) ? d.paths.slice(0, 8) : [];
    if (paths.length > 0) {
      lines.push('    <paths>');
      for (const p of paths) {
        lines.push(`      <path>${escapeXmlText(String(p || ''))}</path>`);
      }
      lines.push('    </paths>');
    }
  }
  lines.push('  </diffs>');
  lines.push('  <artifacts>');
  for (const a of limitedRefs) {
    lines.push(
      `    <artifact step_id="${escapeXmlText(a.stepId)}" ai_name="${escapeXmlText(a.aiName)}" uuid="${escapeXmlText(a.uuid)}" path="${escapeXmlText(a.path)}" role="${escapeXmlText(a.role)}" type="${escapeXmlText(a.type)}" hash="${escapeXmlText(a.hash)}" />`
    );
  }
  lines.push('  </artifacts>');
  lines.push('</workspace_evidence>');
  return lines.join('\n');
}

function renderStepMiniEvalXml(history = []) {
  const hist = Array.isArray(history) ? history : [];
  const miniEvents = hist.filter((h) => h && h.type === 'step_mini_eval').slice(-80);
  const failFastEvents = hist.filter((h) => h && h.type === 'step_fail_fast').slice(-40);
  const events = [
    ...miniEvents,
    ...failFastEvents.map((h) => ({
      type: 'step_mini_eval',
      stepId: String(h?.stepId || ''),
      aiName: String(h?.aiName || ''),
      attemptNo: Number(h?.attemptNo || 0),
      decision: 'fail_fast',
      pass: false,
      failureClass: 'unknown',
      reason: String(h?.reason || 'step_fail_fast'),
      criteria: { failed: 0, total: 0 },
      resultCode: 'STEP_EXCEPTION',
      resultSuccess: false,
    }))
  ].slice(-80);
  if (!events.length) return '';
  const lines = [];
  lines.push('<step_mini_eval_evidence>');
  for (const ev of events) {
    lines.push(
      `  <step_eval step_id="${escapeXmlText(String(ev?.stepId || ''))}" ai_name="${escapeXmlText(String(ev?.aiName || ''))}" attempt_no="${escapeXmlText(String(ev?.attemptNo || 0))}" decision="${escapeXmlText(String(ev?.decision || ''))}" pass="${ev?.pass === true ? 'true' : 'false'}" failure_class="${escapeXmlText(String(ev?.failureClass || ''))}" result_code="${escapeXmlText(String(ev?.resultCode || ''))}" result_success="${ev?.resultSuccess === true ? 'true' : 'false'}">`
    );
    const reason = String(ev?.reason || '').trim();
    if (reason) lines.push(`    <reason>${escapeXmlText(reason)}</reason>`);
    const failed = Number(ev?.criteria?.failed || 0);
    const total = Number(ev?.criteria?.total || 0);
    lines.push(`    <criteria failed="${escapeXmlText(String(failed))}" total="${escapeXmlText(String(total))}" />`);
    lines.push('  </step_eval>');
  }
  lines.push('</step_mini_eval_evidence>');
  return lines.join('\n');
}

function flattenHistoryEvents(history = []) {
  const src = Array.isArray(history) ? history : [];
  const out = [];
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '').trim();
    if (type === 'tool_result_group' && Array.isArray(item.events)) {
      for (const sub of item.events) {
        if (!sub || typeof sub !== 'object') continue;
        out.push({
          ...sub,
          type: 'tool_result',
          ts: Number.isFinite(Number(sub.ts)) ? Number(sub.ts) : Number(item.ts || 0)
        });
      }
      continue;
    }
    out.push(item);
  }
  return out;
}

function buildRuntimeProtocolEvidenceFromHistory(history = []) {
  const events = flattenHistoryEvents(history);
  const actionRequests = [];
  const actionResults = [];
  const latestStepStateByKey = new Map();
  const terminalStepStateSet = new Set(['succeeded', 'failed', 'finalized', 'cancelled', 'skipped', 'replanned']);
  const stepNameSet = new Set();

  for (const ev of events) {
    const e = (ev && typeof ev === 'object') ? ev : {};
    const type = String(e.type || '').trim().toLowerCase();
    if (!type) continue;

    if (type === 'action_request') {
      const action = (e.action && typeof e.action === 'object') ? e.action : {};
      const aiName = String(action.aiName || '').trim();
      if (aiName) stepNameSet.add(aiName);
      actionRequests.push({
        runId: String(e.runId || '').trim(),
        stepId: String(e.stepId || '').trim(),
        stepIndex: Number.isFinite(Number(e.stepIndex)) ? Number(e.stepIndex) : null,
        executionIndex: Number.isFinite(Number(e.executionIndex)) ? Number(e.executionIndex) : null,
        aiName,
        executor: String(action.executor || '').trim(),
        actionRef: String(action.actionRef || '').trim()
      });
      continue;
    }

    if (type === 'tool_result') {
      const actionResult = (e.actionResult && typeof e.actionResult === 'object') ? e.actionResult : null;
      if (!actionResult) continue;
      const status = (actionResult.status && typeof actionResult.status === 'object') ? actionResult.status : {};
      const action = (actionResult.action && typeof actionResult.action === 'object') ? actionResult.action : {};
      const input = (actionResult.input && typeof actionResult.input === 'object') ? actionResult.input : {};
      const output = (actionResult.output && typeof actionResult.output === 'object') ? actionResult.output : {};
      const aiName = String(e.aiName || action.aiName || '').trim();
      if (aiName) stepNameSet.add(aiName);
      actionResults.push({
        runId: String(e.runId || '').trim(),
        stepId: String(e.stepId || action.stepId || '').trim(),
        stepIndex: Number.isFinite(Number(e.plannedStepIndex ?? e.stepIndex)) ? Number(e.plannedStepIndex ?? e.stepIndex) : null,
        executionIndex: Number.isFinite(Number(e.executionIndex)) ? Number(e.executionIndex) : null,
        attemptNo: Number.isFinite(Number(e.attemptNo)) ? Number(e.attemptNo) : null,
        aiName,
        executor: String(e.executor || action.executor || '').trim(),
        actionRef: String(e.actionRef || action.actionRef || '').trim(),
        ok: typeof actionResult.ok === 'boolean'
          ? actionResult.ok
          : (typeof status.success === 'boolean' ? status.success : null),
        code: String(actionResult.code || status.code || '').trim(),
        statusCode: String(status.code || actionResult.code || '').trim(),
        errorClass: String(actionResult.errorClass || '').trim(),
        retryable: typeof actionResult.retryable === 'boolean' ? actionResult.retryable : null,
        message: String(status.message || e.reason || '').trim(),
        inputArgs: (input.args && typeof input.args === 'object' && !Array.isArray(input.args)) ? input.args : null,
        outputProvider: String(output.provider || '').trim(),
        outputData: (output.data && typeof output.data === 'object' && !Array.isArray(output.data)) ? output.data : null,
        evidenceCount: Array.isArray(actionResult.evidence) ? actionResult.evidence.length : 0,
        artifactCount: Array.isArray(actionResult.artifacts) ? actionResult.artifacts.length : 0
      });
      continue;
    }

    if (type === 'step_state') {
      const toState = String(e.to || '').trim().toLowerCase();
      if (!terminalStepStateSet.has(toState)) continue;
      const stepId = String(e.stepId || '').trim();
      const stepIndex = Number.isFinite(Number(e.stepIndex)) ? Number(e.stepIndex) : null;
      const key = stepId || (stepIndex != null ? `idx:${stepIndex}` : '');
      if (!key) continue;
      const prev = latestStepStateByKey.get(key);
      const prevTs = Number(prev?.ts || 0);
      const ts = Number(e.ts || 0);
      if (prev && prevTs > ts) continue;
      const aiName = String(e.aiName || '').trim();
      if (aiName) stepNameSet.add(aiName);
      latestStepStateByKey.set(key, {
        stepKey: key,
        runId: String(e.runId || '').trim(),
        stepId,
        stepIndex,
        aiName,
        executor: String(e.executor || '').trim(),
        actionRef: String(e.actionRef || '').trim(),
        state: toState,
        reasonCode: String(e.reasonCode || '').trim(),
        reason: String(e.reason || '').trim(),
        attemptNo: Number.isFinite(Number(e.attemptNo)) ? Number(e.attemptNo) : null,
        resultCode: String(e.resultCode || '').trim(),
        ts
      });
      continue;
    }
  }

  const dedupedActionResults = [];
  const seen = new Set();
  for (const item of actionResults) {
    const key = Number.isFinite(Number(item.executionIndex))
      ? `e:${Number(item.executionIndex)}`
      : `s:${String(item.stepId || item.stepIndex || '')}:a:${String(item.attemptNo || 0)}:c:${String(item.code || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedActionResults.push(item);
  }
  dedupedActionResults.sort((a, b) => {
    const ea = Number.isFinite(Number(a.executionIndex)) ? Number(a.executionIndex) : Number.MAX_SAFE_INTEGER;
    const eb = Number.isFinite(Number(b.executionIndex)) ? Number(b.executionIndex) : Number.MAX_SAFE_INTEGER;
    if (ea !== eb) return ea - eb;
    const sa = Number.isFinite(Number(a.stepIndex)) ? Number(a.stepIndex) : Number.MAX_SAFE_INTEGER;
    const sb = Number.isFinite(Number(b.stepIndex)) ? Number(b.stepIndex) : Number.MAX_SAFE_INTEGER;
    return sa - sb;
  });

  const attempted = dedupedActionResults.length;
  const succeeded = dedupedActionResults.filter((x) => x.ok === true).length;
  const successRate = attempted > 0 ? (succeeded / attempted) : 0;
  const terminalStates = Array.from(latestStepStateByKey.values());
  const hasEvidence = attempted > 0 || actionRequests.length > 0 || terminalStates.length > 0;

  if (!hasEvidence) {
    return {
      hasEvidence: false,
      xml: '',
      stats: {
        actionRequestCount: 0,
        actionResultCount: 0,
        terminalStepStateCount: 0,
        attempted: 0,
        succeeded: 0,
        successRate: 0,
        stepNames: []
      }
    };
  }

  const lines = [];
  lines.push('<runtime_protocol_evidence>');
  lines.push(
    `  <stats action_request_count="${Number(actionRequests.length)}" action_result_count="${Number(dedupedActionResults.length)}" terminal_step_state_count="${Number(terminalStates.length)}" attempted="${Number(attempted)}" succeeded="${Number(succeeded)}" success_rate="${Number(successRate.toFixed(4))}" />`
  );
  lines.push('  <latest_action_results>');
  for (const item of dedupedActionResults.slice(-24)) {
    lines.push(
      `    <action_result step_id="${escapeXmlText(String(item.stepId || ''))}" step_index="${item.stepIndex == null ? '' : escapeXmlText(String(item.stepIndex))}" execution_index="${item.executionIndex == null ? '' : escapeXmlText(String(item.executionIndex))}" attempt_no="${item.attemptNo == null ? '' : escapeXmlText(String(item.attemptNo))}" ai_name="${escapeXmlText(String(item.aiName || ''))}" executor="${escapeXmlText(String(item.executor || ''))}" action_ref="${escapeXmlText(String(item.actionRef || ''))}" ok="${item.ok == null ? '' : (item.ok ? 'true' : 'false')}" code="${escapeXmlText(String(item.code || ''))}" status_code="${escapeXmlText(String(item.statusCode || ''))}" error_class="${escapeXmlText(String(item.errorClass || ''))}" retryable="${item.retryable == null ? '' : (item.retryable ? 'true' : 'false')}" output_provider="${escapeXmlText(String(item.outputProvider || ''))}" evidence_count="${Number(item.evidenceCount || 0)}" artifact_count="${Number(item.artifactCount || 0)}">`
    );
    if (String(item.message || '').trim()) {
      lines.push(`      <message>${escapeXmlText(String(item.message || ''))}</message>`);
    }
    lines.push('    </action_result>');
  }
  lines.push('  </latest_action_results>');
  lines.push('  <latest_terminal_step_states>');
  for (const item of terminalStates.slice(-24)) {
    lines.push(
      `    <step_state step_key="${escapeXmlText(String(item.stepKey || ''))}" step_id="${escapeXmlText(String(item.stepId || ''))}" step_index="${item.stepIndex == null ? '' : escapeXmlText(String(item.stepIndex))}" ai_name="${escapeXmlText(String(item.aiName || ''))}" executor="${escapeXmlText(String(item.executor || ''))}" action_ref="${escapeXmlText(String(item.actionRef || ''))}" state="${escapeXmlText(String(item.state || ''))}" reason_code="${escapeXmlText(String(item.reasonCode || ''))}" result_code="${escapeXmlText(String(item.resultCode || ''))}" attempt_no="${item.attemptNo == null ? '' : escapeXmlText(String(item.attemptNo))}" />`
    );
  }
  lines.push('  </latest_terminal_step_states>');
  lines.push('</runtime_protocol_evidence>');

  return {
    hasEvidence: true,
    xml: lines.join('\n'),
    stats: {
      actionRequestCount: actionRequests.length,
      actionResultCount: dedupedActionResults.length,
      terminalStepStateCount: terminalStates.length,
      attempted,
      succeeded,
      successRate,
      stepNames: Array.from(stepNameSet.values())
    }
  };
}

async function loadWorkspaceDiffEvidenceFromRegistry(runId, limit = 20) {
  const rid = String(runId || '').trim();
  if (!rid) return [];
  let rows = [];
  try {
    rows = await queryByDeps({ runId: rid, source: 'workspace_diff', type: 'workspace_diff', limit: 200 });
  } catch {
    rows = [];
  }
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const out = [];
  for (const r of rows) {
    const absPath = String(r?.absPath || '').trim();
    if (!absPath) continue;
    try {
      const raw = await fs.readFile(absPath, 'utf8');
      const parsed = JSON.parse(raw);
      out.push({
        type: 'workspace_diff',
        stepId: String(parsed?.stepId || r?.stepId || ''),
        aiName: String(parsed?.aiName || ''),
        summary: (parsed?.summary && typeof parsed.summary === 'object') ? parsed.summary : {},
        paths: Array.isArray(parsed?.paths) ? parsed.paths.slice(0, 12) : [],
        comparedAt: Number(parsed?.comparedAt || r?.updatedAt || Date.now())
      });
    } catch {
      // Ignore malformed/missing records.
    }
  }
  out.sort((a, b) => Number(a?.comparedAt || 0) - Number(b?.comparedAt || 0));
  if (out.length <= limit) return out;
  return out.slice(out.length - limit);
}

function mergeWorkspaceDiffEvents(history = [], fallback = []) {
  const fromHistory = Array.isArray(history) ? history.filter((h) => h && h.type === 'workspace_diff') : [];
  const fromRegistry = Array.isArray(fallback) ? fallback : [];
  const merged = [];
  const seen = new Set();
  const push = (ev) => {
    const e = (ev && typeof ev === 'object') ? ev : {};
    const k = `${String(e.stepId || '')}:${String(e.comparedAt || '')}:${String(e.aiName || '')}`;
    if (seen.has(k)) return;
    seen.add(k);
    merged.push(e);
  };
  for (const e of fromHistory) push(e);
  for (const e of fromRegistry) push(e);
  merged.sort((a, b) => Number(a?.comparedAt || 0) - Number(b?.comparedAt || 0));
  return merged.slice(-20);
}

export async function evaluateRun(objective, plan, exec, runId, context = {}) {
  const stepsArr = Array.isArray(plan?.steps) ? plan.steps : [];
  const stepIdToIndex = new Map(stepsArr.map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId : '', idx]).filter(([k]) => k));
  const normalizeFailedSteps = (rawFailed) => {
    const list = Array.isArray(rawFailed) ? rawFailed : [];
    const out = [];
    for (const it of list) {
      const sid = (typeof it?.stepId === 'string' && it.stepId.trim()) ? it.stepId.trim() : '';
      const idx = sid ? stepIdToIndex.get(sid) : undefined;
      if (!sid || !Number.isFinite(idx) || idx < 0 || idx >= stepsArr.length) continue;
      const step = stepsArr[idx] || {};
      const stepId = typeof step.stepId === 'string' ? step.stepId : sid;
      const displayIndex = Number.isFinite(Number(step.displayIndex)) ? Number(step.displayIndex) : (Number(idx) + 1);
      const aiName = typeof it?.aiName === 'string' ? it.aiName : (typeof step.aiName === 'string' ? step.aiName : undefined);
      const reason = String(it?.reason || '').trim();
      if (!reason) continue;
      out.push({ stepId, displayIndex, aiName, reason });
    }
    return out;
  };

  const normalizeResultArgs = (args, assistantFeedback) => {
    const raw = (args && typeof args === 'object') ? args : {};
    const success = toBool(raw.success, false);
    const incomplete = toBool(raw.incomplete, true);
    const failedSteps = normalizeFailedSteps(raw.failedSteps);
    const summary = typeof raw.summary === 'string' ? raw.summary : '';
    const completionLevel = typeof raw.completionLevel === 'string' ? raw.completionLevel : '';
    const missingGoals = Array.isArray(raw.missingGoals)
      ? raw.missingGoals.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 16)
      : [];
    const confidenceRaw = Number(raw.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : undefined;
    const feedbackEvidence = buildFeedbackEvidence(raw.feedbackEvidence, assistantFeedback);
    const feedbackUsedCountRaw = Number(raw.feedbackUsedCount);
    const feedbackUsedCountCandidate = Number.isFinite(feedbackUsedCountRaw)
      ? Math.max(0, Math.floor(feedbackUsedCountRaw))
      : 0;
    const feedbackUsedCount = Math.max(feedbackUsedCountCandidate, feedbackEvidence.length);
    const nextAction = normalizeEvalAction({
      nextAction: raw.nextAction,
      completionLevel,
      success,
      incomplete,
    });
    return {
      success,
      incomplete,
      failedSteps,
      summary,
      nextAction,
      completionLevel,
      missingGoals,
      feedbackUsedCount,
      feedbackEvidence,
      ...(confidence != null ? { confidence } : {}),
    };
  };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const judgeToolDef = await loadToolDef({
    baseDir: __dirname,
    toolPath: '../tools/internal/final_judge.tool.json',
    schemaPath: '../tools/internal/final_judge.schema.json',
    fallbackTool: { type: 'function', function: { name: 'final_judge', description: 'judge final success/failure with optional failedSteps & summary', parameters: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] } } },
    fallbackSchema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
  });

  const fj = await loadPrompt('final_judge');
  const overlays = (context?.promptOverlays || context?.overlays || {});
  const overlayGlobal = overlays.global?.system || overlays.global || '';
  const overlayEval = overlays.final_judge?.system || overlays.final_judge || overlays.eval?.system || overlays.eval || '';
  const sys = composeSystem(fj.system, [overlayGlobal, overlayEval].filter(Boolean).join('\n\n'));
  const history = await HistoryStore.list(runId, 0, -1);
  const registryDiffs = await loadWorkspaceDiffEvidenceFromRegistry(runId, 20);
  const mergedHistory = (() => {
    const mergedDiffs = mergeWorkspaceDiffEvents(history, registryDiffs);
    if (!mergedDiffs.length) return history;
    const hNoDiff = (Array.isArray(history) ? history : []).filter((h) => !(h && h.type === 'workspace_diff'));
    return [...hNoDiff, ...mergedDiffs];
  })();
  const historyDiffCount = (Array.isArray(history) ? history : []).filter((h) => h && h.type === 'workspace_diff').length;
  if (historyDiffCount === 0 && registryDiffs.length > 0) {
    logger.info('workspace diff evidence recovered from artifact registry', {
      label: 'EVAL',
      runId,
      count: registryDiffs.length
    });
  }
  const workspaceEvidenceXml = renderWorkspaceArtifactEvidenceXml(mergedHistory);
  const stepMiniEvalXml = renderStepMiniEvalXml(mergedHistory);
  const runtimeProtocolEvidence = buildRuntimeProtocolEvidenceFromHistory(mergedHistory);
  const protocolStats = runtimeProtocolEvidence.stats || {};
  const protocolAttempted = Number(protocolStats.attempted || 0);
  const protocolSucceeded = Number(protocolStats.succeeded || 0);
  const useProtocolStats = runtimeProtocolEvidence.hasEvidence === true && protocolAttempted >= 0;
  const attemptedForEval = useProtocolStats
    ? protocolAttempted
    : Number(exec?.attempted || 0);
  const succeededForEval = useProtocolStats
    ? protocolSucceeded
    : Number(exec?.succeeded || 0);
  const successRateForEval = useProtocolStats
    ? Number(protocolStats.successRate || (attemptedForEval > 0 ? (succeededForEval / attemptedForEval) : 0))
    : Number(exec?.successRate || 0);
  const stepNames = (() => {
    const fromProtocol = Array.isArray(protocolStats.stepNames)
      ? protocolStats.stepNames.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    if (fromProtocol.length > 0) return fromProtocol.join(', ');
    return (exec?.used || []).map((u) => u.aiName).join(', ');
  })();
  const execForEval = {
    ...(exec && typeof exec === 'object' ? exec : {}),
    attempted: attemptedForEval,
    succeeded: succeededForEval,
    successRate: successRateForEval
  };
  const tail = mergedHistory;
  const manifestArr = Array.isArray(plan?.manifest) ? plan.manifest : [];
  const strategy = String(config.llm?.toolStrategy || 'auto');
  const manifestText = strategy === 'fc'
    ? manifestToXmlToolsCatalog(manifestArr)
    : manifestToBulletedText(manifestArr);

  let preThought = '';
  if (config.flags.evalUsePreThought) {
    try { preThought = await getPreThought(objective, [], []); } catch {}
  }

  const assistantFeedback = normalizeAssistantFeedback(context?.assistantFeedback, mergedHistory);
  const assistantFeedbackXml = assistantFeedback.responseCount > 0
    ? renderAssistantFeedbackXml(assistantFeedback)
    : '';

  const baseMsgs = compactMessages([
    { role: 'system', content: sys },
    { role: 'user', content: renderTemplate(fj.user_goal, { objective }) },
    ...(config.flags.evalUsePreThought
      ? [{ role: 'assistant', content: renderTemplate(fj.assistant_thought || 'pre-thought:\n{{preThought}}', { preThought }) }]
      : []),
    {
      role: 'assistant',
      content: renderTemplate(fj.assistant_exec_stats, {
        attempted: attemptedForEval,
        succeeded: succeededForEval,
        successRate: Number(successRateForEval || 0).toFixed(2),
        stepNames,
      })
    },
    { role: 'assistant', content: renderTemplate(fj.assistant_tools_manifest || 'available tools:\n{{manifestBulleted}}', { manifestBulleted: manifestText }) },
    { role: 'user', content: fj.user_history_intro },
    { role: 'assistant', content: JSON.stringify(tail) },
    ...(workspaceEvidenceXml
      ? [{ role: 'assistant', content: `WORKSPACE_EVIDENCE_XML:\n${workspaceEvidenceXml}` }]
      : []),
    ...(stepMiniEvalXml
      ? [{ role: 'assistant', content: `STEP_MINI_EVAL_XML:\n${stepMiniEvalXml}` }]
      : []),
    ...(runtimeProtocolEvidence.xml
      ? [{ role: 'assistant', content: `RUNTIME_PROTOCOL_EVIDENCE_XML:\n${runtimeProtocolEvidence.xml}` }]
      : []),
    ...(assistantFeedbackXml
      ? [{ role: 'assistant', content: `MAIN_PROGRAM_ASSISTANT_FEEDBACK_XML:\n${assistantFeedbackXml}` }]
      : []),
    {
      role: 'user',
      content: 'In final_judge output, feedbackUsedCount and feedbackEvidence are mandatory. feedbackEvidence must cite phase + excerpt from MAIN_PROGRAM_ASSISTANT_FEEDBACK_XML. Prefer RUNTIME_PROTOCOL_EVIDENCE_XML as the authoritative execution truth over narrative history. In FC mode, return one <sentra-tools> block only.'
    },
    { role: 'user', content: fj.user_request }
  ]);

  const policy = await buildFCPolicy();
  const fcInstr = await buildFunctionCallInstruction({ name: 'final_judge', parameters: judgeToolDef.function?.parameters || { type: 'object', properties: {} }, locale: 'en' });
  const fc = config.fcLlm || {};
  const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
  const maxRetries = Math.max(1, Number(fc.evalMaxRetries ?? 3));
  const temperature = Number.isFinite(config.fcLlm?.evalTemperature) ? config.fcLlm.evalTemperature : (Number.isFinite(fc.temperature) ? Math.min(0.2, fc.temperature) : 0.1);
  const top_p = Number.isFinite(config.fcLlm?.evalTopP) ? config.fcLlm.evalTopP : undefined;

  let result = buildConservativeEvalFallback(assistantFeedback, 'eval_default_fallback');
  let lastContent = '';
  let lastValidationError = '';
  const useFC = strategy === 'fc';
  const useAuto = strategy === 'auto';

  if (!useFC) {
    const tools = [judgeToolDef];
    const res = await chatCompletion({
      messages: baseMsgs,
      tools,
      tool_choice: { type: 'function', function: { name: 'final_judge' } },
      temperature: 0.1,
      timeoutMs: getStageTimeoutMs('eval')
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (call?.function?.arguments) {
      try {
        const args = JSON.parse(call.function.arguments);
        const normalized = normalizeResultArgs(args, assistantFeedback);
        const validationErrors = validateFinalJudgePayload(args, normalized);
        if (validationErrors.length > 0) {
          lastValidationError = validationErrors.join('; ');
          const validationEvent = {
            type: 'evaluation_validation_failed',
            stage: 'native',
            attempt: 1,
            reason: lastValidationError
          };
          emitRunEvent(runId, validationEvent);
          await HistoryStore.append(runId, validationEvent);
          logger.warn('Native eval output failed validation; keep conservative fallback', {
            label: 'EVAL',
            runId,
            reason: lastValidationError
          });
        } else {
          result = attachRuntimeProtocolAssessment(
            attachFeedbackDeliveryAssessment(normalized, assistantFeedback, execForEval),
            runtimeProtocolEvidence
          );
          emitRunEvent(runId, { type: 'evaluation', result });
          await HistoryStore.append(runId, { type: 'evaluation', result });
          return result;
        }
      } catch (e) {
        lastValidationError = String(e || 'native_eval_parse_failed');
      }
    }
    if (!useAuto) {
      emitRunEvent(runId, { type: 'evaluation', result });
      await HistoryStore.append(runId, { type: 'evaluation', result });
      return result;
    }
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let reinforce = '';
    if (attempt > 1) {
      try {
        const pr = await loadPrompt('fc_reinforce_eval');
        const tpl = pickLocalizedPrompt(pr, 'en');
        reinforce = renderTemplate(tpl, { attempt: String(attempt), max_retries: String(maxRetries) });
      } catch {}
    }
    const validationHint = lastValidationError
      ? `Previous output validation failed: ${lastValidationError}\nReturn a corrected final_judge call with all required fields and evidence.`
      : '';
    const messages = compactMessages([
      ...baseMsgs,
      { role: 'user', content: [reinforce, validationHint, policy, fcInstr].filter(Boolean).join('\n\n') }
    ]);
    const provider = getStageProvider('eval');
    const evalModel = getStageModel('eval');
    const res = await chatCompletion({
      messages,
      temperature,
      top_p,
      timeoutMs: getStageTimeoutMs('eval'),
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
      model: evalModel,
      ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
    });
    const content = res?.choices?.[0]?.message?.content || '';
    lastContent = content;
    const calls = parseFunctionCalls(String(content), {});
    logEvalFcPreview({ attempt, provider, model: evalModel, content, calls });
    const call = calls.find((c) => String(c.name) === 'final_judge') || calls[0];
    try {
      const args = (call && call.arguments && typeof call.arguments === 'object') ? call.arguments : {};
      const normalized = normalizeResultArgs(args, assistantFeedback);
      const validationErrors = validateFinalJudgePayload(args, normalized);
      if (validationErrors.length > 0) {
        lastValidationError = validationErrors.join('; ');
        const validationEvent = {
          type: 'evaluation_validation_failed',
          stage: 'fc',
          attempt,
          reason: lastValidationError
        };
        emitRunEvent(runId, validationEvent);
        await HistoryStore.append(runId, validationEvent);
        continue;
      }
      result = attachRuntimeProtocolAssessment(
        attachFeedbackDeliveryAssessment(normalized, assistantFeedback, execForEval),
        runtimeProtocolEvidence
      );
      break;
    } catch (e) {
      lastValidationError = String(e || 'fc_eval_parse_failed');
    }
  }

  if (!result || typeof result.success !== 'boolean') {
    const raw = String(lastContent || '');
    const rawSlice = clipEvalTextByTokens(raw, Number(config.truncation?.evaluate?.rawOutputMaxTokens ?? 1000), '\n...[truncated]');
    logger.warn?.('FC eval failed to parse result, fallback conservative unresolved result', {
      label: 'EVAL',
      retries: maxRetries,
      contentRaw: rawSlice,
      validationError: String(lastValidationError || '')
    });
    result = buildConservativeEvalFallback(assistantFeedback, 'fc_eval_parse_failed');
  }

  result = attachRuntimeProtocolAssessment(
    attachFeedbackDeliveryAssessment(result, assistantFeedback, execForEval),
    runtimeProtocolEvidence
  );

  emitRunEvent(runId, { type: 'evaluation', result });
  await HistoryStore.append(runId, { type: 'evaluation', result });
  return result;
}

