import crypto from 'node:crypto';
import { HistoryStore } from '../../history/store.js';
import { loadRuntimeRunCheckpointSnapshot } from './runtime_persistence_controller.js';

function toText(value) {
  return String(value == null ? '' : value).trim();
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : Math.trunc(fallback);
}

function normalizeStepIndex(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return -1;
  return Math.max(-1, Math.trunc(n));
}

function isTerminalRunStatus(status) {
  const s = toText(status).toLowerCase();
  return s === 'completed' || s === 'cancelled' || s === 'failed';
}

function normalizePlanStepForSignature(step = {}, index = 0) {
  const item = (step && typeof step === 'object') ? step : {};
  const dependsOnStepIds = Array.isArray(item.dependsOnStepIds)
    ? item.dependsOnStepIds.map((x) => toText(x)).filter(Boolean)
    : [];
  return {
    index,
    stepId: toText(item.stepId),
    aiName: toText(item.aiName),
    executor: toText(item.executor),
    actionRef: toText(item.actionRef),
    dependsOnStepIds,
  };
}

export function buildPlanSignature(plan = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const normalizedSteps = steps.map((step, index) => normalizePlanStepForSignature(step, index));
  const payload = JSON.stringify({
    version: 1,
    steps: normalizedSteps
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function iterateHistoryEvents(history = []) {
  const src = Array.isArray(history) ? history : [];
  const out = [];
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const type = toText(item.type);
    if (type === 'tool_result_group' && Array.isArray(item.events)) {
      for (const sub of item.events) {
        if (!sub || typeof sub !== 'object') continue;
        out.push({
          ...sub,
          type: 'tool_result',
          ts: Number.isFinite(Number(sub.ts)) ? Number(sub.ts) : toInt(item.ts, 0)
        });
      }
      continue;
    }
    out.push(item);
  }
  return out;
}

function normalizeUsedEntryFromToolResult(ev = {}) {
  const result = (ev.result && typeof ev.result === 'object') ? ev.result : {};
  const actionResult = (ev.actionResult && typeof ev.actionResult === 'object') ? ev.actionResult : {};
  const metrics = (actionResult.metrics && typeof actionResult.metrics === 'object') ? actionResult.metrics : {};
  const action = (actionResult.action && typeof actionResult.action === 'object') ? actionResult.action : {};
  const success = actionResult.ok === true || result.success === true;
  const code = toText(actionResult.code || result.code || '');
  const elapsedMsRaw = Number(metrics.elapsedMs);
  const elapsedMs = Number.isFinite(elapsedMsRaw)
    ? Math.max(0, Math.trunc(elapsedMsRaw))
    : Math.max(0, toInt(ev.elapsedMs, 0));
  const stepIndex = normalizeStepIndex(ev.stepIndex ?? ev.plannedStepIndex);
  const executionIndex = normalizeStepIndex(ev.executionIndex);
  const attemptNo = Math.max(0, toInt(ev.attemptNo, 0));
  return {
    aiName: toText(ev.aiName || action.aiName),
    executor: toText(ev.executor || action.executor),
    stepId: toText(ev.stepId),
    stepIndex,
    executionIndex,
    attemptNo,
    elapsedMs,
    success,
    code,
  };
}

const TERMINAL_STEP_STATE_SET = new Set([
  'succeeded',
  'failed',
  'finalized',
  'cancelled',
  'skipped',
  'replanned',
]);

function isTerminalStepState(state) {
  return TERMINAL_STEP_STATE_SET.has(toText(state).toLowerCase());
}

function normalizeCheckpointIndexKey(key) {
  const raw = toText(key);
  if (!raw) return '';
  if (/^-?\d+$/.test(raw)) return String(Math.max(-1, Math.trunc(Number(raw))));
  return raw;
}

function mergeUsedEntries(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const executionIndex = normalizeStepIndex(entry.executionIndex);
    const stepIndex = normalizeStepIndex(entry.stepIndex);
    const attemptNo = Math.max(0, toInt(entry.attemptNo, 0));
    const code = toText(entry.code);
    const key = executionIndex >= 0
      ? `e:${executionIndex}`
      : `s:${stepIndex}:a:${attemptNo}:c:${code}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push({
      ...entry,
      executionIndex,
      stepIndex,
      attemptNo
    });
  };
  for (const item of primary) push(item);
  for (const item of secondary) push(item);
  merged.sort((a, b) => {
    const ea = normalizeStepIndex(a.executionIndex);
    const eb = normalizeStepIndex(b.executionIndex);
    if (ea >= 0 && eb >= 0) return ea - eb;
    if (ea >= 0) return -1;
    if (eb >= 0) return 1;
    const sa = normalizeStepIndex(a.stepIndex);
    const sb = normalizeStepIndex(b.stepIndex);
    return sa - sb;
  });
  return merged;
}

function extractResumeDataFromStepRuntimeIndex(stepRuntimeIndex = {}, totalSteps = 0) {
  const source = (stepRuntimeIndex && typeof stepRuntimeIndex === 'object' && !Array.isArray(stepRuntimeIndex))
    ? stepRuntimeIndex
    : {};
  const finishedIndices = new Set();
  const unfinishedIndices = new Set();
  const preFinalizedIndices = new Set();
  const usedEntries = [];
  const retryAvailableByStep = {};
  const stepStateByStepIndex = {};
  let maxExecutionIndex = -1;
  const normalized = {};

  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (!rawValue || typeof rawValue !== 'object') continue;
    const key = normalizeCheckpointIndexKey(rawKey);
    if (!key) continue;
    const value = { ...rawValue };
    const keyStepIndex = /^-?\d+$/.test(key) ? normalizeStepIndex(key) : -1;
    const stepIndex = normalizeStepIndex(value.stepIndex);
    const resolvedStepIndex = stepIndex >= 0 ? stepIndex : keyStepIndex;
    const state = toText(value.state).toLowerCase();
    const executionIndex = normalizeStepIndex(value.executionIndex);
    const attemptNo = Math.max(0, toInt(value.attemptNo, 0));
    const resultCode = toText(value.resultCode);
    const availableAt = Math.max(0, toInt(value.availableAt, 0));
    const success = (typeof value.success === 'boolean')
      ? value.success
      : (state === 'succeeded' || state === 'finalized');
    const elapsedMs = Math.max(0, toInt(value.elapsedMs, 0));

    normalized[key] = {
      ...value,
      stepIndex: resolvedStepIndex,
      state,
      executionIndex,
      attemptNo,
      availableAt,
      resultCode,
      success,
      elapsedMs,
      updatedAt: toInt(value.updatedAt, 0)
    };

    if (resolvedStepIndex >= 0 && resolvedStepIndex < totalSteps) {
      if (isTerminalStepState(state)) {
        finishedIndices.add(resolvedStepIndex);
      } else {
        unfinishedIndices.add(resolvedStepIndex);
      }
      const stepKey = String(resolvedStepIndex);
      const prevStepState = stepStateByStepIndex[stepKey];
      const prevUpdatedAt = Math.max(0, toInt(prevStepState?.updatedAt, 0));
      if (!prevStepState || toInt(value.updatedAt, 0) >= prevUpdatedAt) {
        stepStateByStepIndex[stepKey] = {
          state,
          reasonCode: toText(value.reasonCode),
          resultCode,
          attemptNo,
          executionIndex,
          availableAt,
          success,
          updatedAt: toInt(value.updatedAt, 0)
        };
      }
      if (state === 'retrying' && availableAt > 0) {
        retryAvailableByStep[stepKey] = availableAt;
      }
    }
    if (resolvedStepIndex >= 0 && resolvedStepIndex < totalSteps && state === 'finalized') {
      preFinalizedIndices.add(resolvedStepIndex);
    }
    if (executionIndex >= 0) {
      maxExecutionIndex = Math.max(maxExecutionIndex, executionIndex);
      usedEntries.push({
        aiName: toText(value.aiName),
        executor: toText(value.executor),
        stepId: toText(value.stepId),
        stepIndex: resolvedStepIndex,
        executionIndex,
        attemptNo,
        elapsedMs,
        success,
        code: resultCode,
      });
    }
  }

  return {
    finishedIndices,
    unfinishedIndices,
    preFinalizedIndices,
    usedEntries,
    retryAvailableByStep,
    stepStateByStepIndex,
    maxExecutionIndex,
    stepRuntimeIndex: normalized
  };
}

export async function buildResumeSeedFromCheckpoint({
  runId,
  plan,
  startIndex = 0,
  retrySteps = null
} = {}) {
  const rid = toText(runId);
  const safePlan = (plan && typeof plan === 'object') ? plan : {};
  const steps = Array.isArray(safePlan.steps) ? safePlan.steps : [];
  const totalSteps = steps.length;
  const normalizedStartIndex = Math.max(0, toInt(startIndex, 0));
  if (!rid || totalSteps <= 0) {
    return { enabled: false, reason: 'invalid_run_or_plan' };
  }
  if (retrySteps && typeof retrySteps === 'object' && typeof retrySteps.size === 'number' && retrySteps.size > 0) {
    return { enabled: false, reason: 'retry_mode' };
  }
  if (normalizedStartIndex > 0) {
    return { enabled: false, reason: 'non_zero_start_index' };
  }

  const checkpoint = await loadRuntimeRunCheckpointSnapshot({ runId: rid });
  if (!checkpoint || typeof checkpoint !== 'object') {
    return { enabled: false, reason: 'checkpoint_not_found' };
  }
  if (isTerminalRunStatus(checkpoint.status)) {
    return { enabled: false, reason: 'checkpoint_terminal' };
  }

  const planSignature = buildPlanSignature(safePlan);
  const checkpointPlanSignature = toText(checkpoint.planSignature);
  if (checkpointPlanSignature && checkpointPlanSignature !== planSignature) {
    return { enabled: false, reason: 'plan_signature_mismatch' };
  }
  const checkpointTotalSteps = toInt(checkpoint.totalSteps, 0);
  if (checkpointTotalSteps > 0 && checkpointTotalSteps !== totalSteps) {
    return { enabled: false, reason: 'plan_total_steps_mismatch' };
  }

  const finishedIndices = new Set();
  const unfinishedIndices = new Set();
  const preFinalizedIndices = new Set();
  let usedEntries = [];
  let maxExecutionIndex = toInt(checkpoint.lastExecutionIndex, -1);
  let stepRuntimeIndex = {};
  const retryAvailableByStep = {};
  const stepStateByStepIndex = {};

  const checkpointIndexData = extractResumeDataFromStepRuntimeIndex(checkpoint.stepRuntimeIndex, totalSteps);
  stepRuntimeIndex = checkpointIndexData.stepRuntimeIndex;
  for (const idx of checkpointIndexData.finishedIndices) finishedIndices.add(idx);
  for (const idx of checkpointIndexData.unfinishedIndices) unfinishedIndices.add(idx);
  for (const idx of checkpointIndexData.preFinalizedIndices) preFinalizedIndices.add(idx);
  usedEntries = mergeUsedEntries(usedEntries, checkpointIndexData.usedEntries);
  maxExecutionIndex = Math.max(maxExecutionIndex, checkpointIndexData.maxExecutionIndex);
  for (const [key, value] of Object.entries(checkpointIndexData.retryAvailableByStep || {})) {
    if (!key) continue;
    retryAvailableByStep[key] = Math.max(0, toInt(value, 0));
  }
  for (const [key, value] of Object.entries(checkpointIndexData.stepStateByStepIndex || {})) {
    if (!key || !value || typeof value !== 'object') continue;
    stepStateByStepIndex[key] = value;
  }

  const needHistoryFallback = finishedIndices.size === 0 || usedEntries.length === 0;
  if (needHistoryFallback) {
    const history = await HistoryStore.list(rid, 0, -1);
    const events = iterateHistoryEvents(history);
    const fallbackUsedEntries = [];
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const type = toText(ev.type);

      if (type === 'action_request') {
        const execIdx = normalizeStepIndex(ev.executionIndex);
        if (execIdx >= 0) maxExecutionIndex = Math.max(maxExecutionIndex, execIdx);
        continue;
      }

      if (type === 'step_state') {
        const idx = normalizeStepIndex(ev.stepIndex ?? ev.plannedStepIndex);
        if (idx < 0 || idx >= totalSteps) continue;
        const to = toText(ev.to).toLowerCase();
        if (to === 'finalized') preFinalizedIndices.add(idx);
        if (isTerminalStepState(to)) {
          finishedIndices.add(idx);
          unfinishedIndices.delete(idx);
        } else {
          unfinishedIndices.add(idx);
        }
        continue;
      }

      if (type === 'tool_result') {
        const idx = normalizeStepIndex(ev.stepIndex ?? ev.plannedStepIndex);
        if (idx >= 0 && idx < totalSteps) {
          finishedIndices.add(idx);
          unfinishedIndices.delete(idx);
        }
        const execIdx = normalizeStepIndex(ev.executionIndex);
        if (execIdx >= 0) maxExecutionIndex = Math.max(maxExecutionIndex, execIdx);
        fallbackUsedEntries.push(normalizeUsedEntryFromToolResult(ev));
        continue;
      }
    }
    usedEntries = mergeUsedEntries(usedEntries, fallbackUsedEntries);
  }

  // Fallback cursor-based resume: if detailed runtime index/history is unavailable,
  // recover execution cursor from checkpoint lastCompletedStepIndex to avoid replay.
  if (finishedIndices.size === 0 && usedEntries.length === 0) {
    const checkpointLastCompleted = toInt(checkpoint.lastCompletedStepIndex, -1);
    if (checkpointLastCompleted >= normalizedStartIndex && checkpointLastCompleted < totalSteps) {
      for (let i = normalizedStartIndex; i <= checkpointLastCompleted && i < totalSteps; i++) {
        finishedIndices.add(i);
        unfinishedIndices.delete(i);
      }
    }
  }

  const resumedFinishedIndices = Array.from(finishedIndices)
    .filter((idx) => idx >= normalizedStartIndex && idx < totalSteps)
    .sort((a, b) => a - b);
  const resumedUnfinishedIndices = Array.from(unfinishedIndices)
    .filter((idx) => idx >= normalizedStartIndex && idx < totalSteps)
    .sort((a, b) => a - b);
  if (resumedFinishedIndices.length === 0 && resumedUnfinishedIndices.length === 0 && usedEntries.length === 0) {
    return { enabled: false, reason: 'no_resume_seed_from_checkpoint' };
  }

  const resumedPreFinalizedIndices = Array.from(preFinalizedIndices)
    .filter((idx) => idx >= normalizedStartIndex && idx < totalSteps)
    .sort((a, b) => a - b);
  const firstPendingIndex = (() => {
    for (let i = normalizedStartIndex; i < totalSteps; i++) {
      if (!finishedIndices.has(i)) return i;
    }
    return -1;
  })();
  const resumeCursorIndex = firstPendingIndex >= 0
    ? firstPendingIndex
    : (resumedUnfinishedIndices.length > 0 ? resumedUnfinishedIndices[0] : normalizedStartIndex);
  const succeeded = usedEntries.filter((x) => x && x.success === true).length;
  const attempted = usedEntries.length;
  const nextExecutionIndex = Math.max(0, maxExecutionIndex + 1);

  return {
    enabled: true,
    reason: 'resume_from_checkpoint',
    planSignature,
    checkpointPlanSignature,
    checkpointStage: toText(checkpoint.stage),
    checkpointStatus: toText(checkpoint.status),
    finishedIndices: resumedFinishedIndices,
    unfinishedIndices: resumedUnfinishedIndices,
    resumeCursorIndex,
    preFinalizedIndices: resumedPreFinalizedIndices,
    usedEntries,
    stepRuntimeIndex,
    retryAvailableByStep,
    stepStateByStepIndex,
    attempted,
    succeeded,
    nextExecutionIndex,
    runtimeSignalCursorTs: toInt(checkpoint.runtimeSignalCursorTs, 0),
    runtimeSignalGeneration: toInt(checkpoint.runtimeSignalGeneration, 0),
    runtimeSignalSeq: toInt(checkpoint.runtimeSignalSeq, 0),
    lastCompletedStepIndex: toInt(checkpoint.lastCompletedStepIndex, -1),
    lastCompletedStepId: toText(checkpoint.lastCompletedStepId),
  };
}

export default {
  buildPlanSignature,
  buildResumeSeedFromCheckpoint
};
