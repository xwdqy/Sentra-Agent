import {
  persistRuntimeRunFinal,
  persistRuntimeRunStart,
  persistRuntimeStateTransition
} from './runtime_persistence_controller.js';

export function createRuntimeContext({
  runId,
  objective,
  context = {},
  registerRunStart,
  injectConcurrencyOverlay
}) {
  const ctx0 = (context && typeof context === 'object') ? context : {};
  registerRunStart({
    runId,
    channelId: ctx0.channelId,
    identityKey: ctx0.identityKey,
    objective
  });
  const ctx = injectConcurrencyOverlay({ runId, objective, context: ctx0 });
  return { ctx0, ctx };
}

export async function emitRunStart({
  runId,
  objective,
  context,
  sanitizeContextForLog,
  emitRunEvent,
  historyStore
}) {
  const sanitizedCtx = sanitizeContextForLog(context);
  emitRunEvent(runId, { type: 'start', objective, context: sanitizedCtx });
  await historyStore.append(runId, { type: 'start', objective, context: sanitizedCtx });
  await persistRuntimeRunStart({
    runId,
    objective,
    context,
    source: 'runtime_orchestrator.emitRunStart'
  });
  return sanitizedCtx;
}

export async function cleanupRuntimeRun({
  runId,
  sub,
  isRunCancelled,
  markRunFinished,
  removeRun,
  closeRunEvents,
  clearRunCancelled,
  context = {},
  objective = ''
}) {
  const cancelled = isRunCancelled(runId);
  await persistRuntimeRunFinal({
    runId,
    context,
    objective,
    status: cancelled ? 'cancelled' : 'completed',
    reasonCode: cancelled ? 'run_cancelled' : 'run_finished',
    source: 'runtime_orchestrator.cleanupRuntimeRun'
  });
  try { markRunFinished(runId, { cancelled }); } catch { }
  try { removeRun(runId); } catch { }
  try { await sub?.return?.(); } catch { }
  try { closeRunEvents(runId); } catch { }
  try { clearRunCancelled(runId); } catch { }
}

export async function runFeedbackEvaluationRound({
  runId,
  objective,
  plan,
  exec,
  context = {},
  round = 1,
  sinceTs = 0,
  adaptiveRoundsUsed = 0,
  maxAdaptiveRounds = 1,
  waitForAssistantFeedbackBatches,
  runEvaluateStage,
  normalizeEvalAction,
  emitRunEvent,
  historyStore
}) {
  const currentRound = Number.isFinite(Number(round)) ? Math.max(1, Math.floor(Number(round))) : 1;
  const baseSinceTs = Number.isFinite(Number(sinceTs)) ? Number(sinceTs) : 0;
  const resolveFeedbackWaitTimeoutMs = () => {
    const sources = [
      context?.feedbackWaitTimeoutMs,
      context?.runtimeFeedbackWaitTimeoutMs,
      context?.runtime?.feedbackWaitTimeoutMs,
      context?.runtime?.feedback_wait_timeout_ms
    ];
    for (const candidate of sources) {
      const n = Number(candidate);
      if (!Number.isFinite(n) || n <= 0) continue;
      return Math.floor(n);
    }
    return undefined;
  };
  const feedbackWaitTimeoutMs = resolveFeedbackWaitTimeoutMs();
  const extractBatches = (x) => (Array.isArray(x?.batches) ? x.batches : []);
  const extractResponses = (x) => (Array.isArray(x?.responses) ? x.responses : []);
  await persistRuntimeStateTransition({
    runId,
    context,
    to: 'DRAINING',
    reasonCode: 'feedback_evaluation_round_start',
    source: 'runtime_orchestrator.runFeedbackEvaluationRound',
    objective,
    generation: Number(exec?.runtimeSignalGeneration || 0),
    signalSeq: Number(exec?.runtimeSignalSeq || 0),
    note: `round=${currentRound}`
  });

  emitRunEvent(runId, {
    type: 'feedback_wait',
    round: currentRound,
    sinceTs: baseSinceTs,
    requireFlushAck: true,
    waitMode: 'flush_ack_blocking'
  });
  await historyStore.append(runId, {
    type: 'feedback_wait',
    round: currentRound,
    sinceTs: baseSinceTs,
    requireFlushAck: true,
    waitMode: 'flush_ack_blocking'
  });

  const waitedFeedback = await waitForAssistantFeedbackBatches(runId, {
    sinceTs: baseSinceTs,
    round: currentRound,
    ...(Number.isFinite(Number(feedbackWaitTimeoutMs))
      ? { timeoutMs: Number(feedbackWaitTimeoutMs) }
      : {})
  });
  const feedbackBatches = extractBatches(waitedFeedback);
  const feedbackResponses = extractResponses(waitedFeedback);
  const nextSinceTs = feedbackBatches.reduce((acc, b) => {
    const ts = Number(b?.ts || 0);
    return Number.isFinite(ts) && ts > acc ? ts : acc;
  }, baseSinceTs);

  const feedbackEvent = {
    type: 'feedback_received',
    round: currentRound,
    interrupted: waitedFeedback?.interrupted === true,
    flushAcked: !!waitedFeedback?.flushDone,
    batchCount: feedbackBatches.length,
    responseCount: feedbackResponses.length,
    waitMode: 'flush_ack_blocking',
    sinceTs: nextSinceTs
  };
  emitRunEvent(runId, feedbackEvent);
  await historyStore.append(runId, feedbackEvent);

  const evalObj = await runEvaluateStage({
    objective,
    plan,
    exec,
    runId,
    context,
    assistantFeedback: {
      interrupted: waitedFeedback?.interrupted === true,
      batches: feedbackBatches,
      responses: feedbackResponses
    }
  });

  const finalAction = normalizeEvalAction(evalObj);
  const canAdaptive = finalAction !== 'perfect' && adaptiveRoundsUsed < maxAdaptiveRounds;
  const evalDecision = {
    type: 'eval_decision',
    round: currentRound,
    action: finalAction,
    adaptiveRoundsUsed,
    maxAdaptiveRounds,
    canAdaptive,
    summary: String(evalObj?.summary || ''),
    success: evalObj?.success === true,
    incomplete: evalObj?.incomplete === true,
    feedbackUsedCount: Number(evalObj?.feedbackUsedCount || 0),
    feedbackEvidence: Array.isArray(evalObj?.feedbackEvidence) ? evalObj.feedbackEvidence.slice(0, 6) : [],
  };
  emitRunEvent(runId, evalDecision);
  await historyStore.append(runId, evalDecision);
  await persistRuntimeStateTransition({
    runId,
    context,
    to: 'RUNNING',
    reasonCode: 'feedback_evaluation_round_end',
    source: 'runtime_orchestrator.runFeedbackEvaluationRound',
    objective,
    generation: Number(exec?.runtimeSignalGeneration || 0),
    signalSeq: Number(exec?.runtimeSignalSeq || 0),
    note: `round=${currentRound},action=${String(finalAction || '')}`
  });

  return {
    evalObj,
    finalAction,
    canAdaptive,
    nextSinceTs,
    waitedFeedback,
    feedbackBatches,
    feedbackResponses
  };
}
