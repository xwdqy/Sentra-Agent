function toText(value) {
  return String(value ?? '').trim();
}

export const MINI_EVAL_DECISION = Object.freeze({
  pass: 'pass',
  retrySame: 'retry_same',
  retryRegen: 'retry_regen',
  replan: 'replan',
  failFast: 'fail_fast',
});

const MINI_EVAL_DECISION_SET = new Set(Object.values(MINI_EVAL_DECISION));
const MINI_EVAL_RETRY_SET = new Set([
  MINI_EVAL_DECISION.retrySame,
  MINI_EVAL_DECISION.retryRegen
]);
const MINI_EVAL_STOP_SET = new Set([
  MINI_EVAL_DECISION.replan,
  MINI_EVAL_DECISION.failFast
]);

export const RESULT_CODE = Object.freeze({
  cooldownActive: 'COOLDOWN_ACTIVE'
});

export const MINI_EVAL_REASON_CODE = Object.freeze({
  retrySame: 'mini_eval_retry_same',
  retryRegen: 'mini_eval_retry_regen',
  replan: 'mini_eval_replan',
  failFast: 'mini_eval_fail_fast',
  skippedPass: 'mini_eval_skipped_pass'
});

export const STEP_REASON_CODE = Object.freeze({
  stepReady: 'step_ready',
  stepDispatchStart: 'step_dispatch_start',
  runCancelled: 'run_cancelled',
  runtimeRedirected: 'runtime_redirected',
  upstreamFailed: 'upstream_failed',
  toolNotFound: 'tool_not_found',
  unsupportedSandboxAction: 'unsupported_sandbox_action',
  toolResultSuccess: 'tool_result_success',
  toolResultFailed: 'tool_result_failed',
  stepException: 'step_exception',
  runCancelledFinalize: 'run_cancelled_finalize',
  executePlanFinalize: 'execute_plan_finalize',
});

export const NO_TOOL_REASON_CODE = Object.freeze({
  defaultNoInvocation: 'no_tool_invocation_required',
  judgeNoTools: 'judge_no_tools',
  emptyPlan: 'empty_plan',
  emptyDirectToolsPlan: 'empty_direct_tools_plan',
});

export const RUNTIME_REASON_CODE = Object.freeze({
  runCancelled: 'run_cancelled',
  runFinished: 'run_finished',
});

export function normalizeMiniEvalDecision(value, fallback = '') {
  const normalized = toText(value).toLowerCase();
  if (MINI_EVAL_DECISION_SET.has(normalized)) return normalized;
  const fb = toText(fallback).toLowerCase();
  return MINI_EVAL_DECISION_SET.has(fb) ? fb : '';
}

export function isMiniEvalRetryDecision(value) {
  const normalized = normalizeMiniEvalDecision(value);
  return MINI_EVAL_RETRY_SET.has(normalized);
}

export function isMiniEvalStopDecision(value) {
  const normalized = normalizeMiniEvalDecision(value);
  return MINI_EVAL_STOP_SET.has(normalized);
}

export function isCooldownResultCode(value) {
  return toText(value).toUpperCase() === RESULT_CODE.cooldownActive;
}

export function miniEvalDecisionToReasonCode(decision, fallback = '') {
  const normalized = normalizeMiniEvalDecision(decision);
  if (normalized === MINI_EVAL_DECISION.retrySame) return MINI_EVAL_REASON_CODE.retrySame;
  if (normalized === MINI_EVAL_DECISION.retryRegen) return MINI_EVAL_REASON_CODE.retryRegen;
  if (normalized === MINI_EVAL_DECISION.replan) return MINI_EVAL_REASON_CODE.replan;
  if (normalized === MINI_EVAL_DECISION.failFast) return MINI_EVAL_REASON_CODE.failFast;
  if (normalized === MINI_EVAL_DECISION.pass) return MINI_EVAL_REASON_CODE.skippedPass;
  return toText(fallback);
}

export default {
  MINI_EVAL_DECISION,
  MINI_EVAL_REASON_CODE,
  STEP_REASON_CODE,
  NO_TOOL_REASON_CODE,
  RUNTIME_REASON_CODE,
  RESULT_CODE,
  normalizeMiniEvalDecision,
  isMiniEvalRetryDecision,
  isMiniEvalStopDecision,
  isCooldownResultCode,
  miniEvalDecisionToReasonCode
};
