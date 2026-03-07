import { clip } from '../../utils/text.js';
import {
  TERMINAL_RUNTIME_ACTION,
  isTerminalRuntimeStep
} from '../../runtime/terminal/spec.js';
import { classifyFailureByCode } from './failure_policy.js';

function toText(value) {
  return String(value ?? '').trim();
}

function normalizeExecutorLike(step = {}) {
  const s = (step && typeof step === 'object') ? step : {};
  const ex = toText(s.executor).toLowerCase();
  if (ex) return ex;
  return isTerminalRuntimeStep(s) ? 'sandbox' : 'mcp';
}

function normalizeActionRef(step = {}) {
  const action = toText(step?.actionRef || step?.action).toLowerCase();
  if (action) return action;
  return isTerminalRuntimeStep(step) ? TERMINAL_RUNTIME_ACTION : '';
}

function inferEvidenceFromMcpData(data) {
  if (data == null) return [];
  if (typeof data === 'string') {
    const text = toText(data);
    if (!text) return [];
    return [{
      kind: 'text',
      excerpt: clip(text, 500),
      chars: text.length
    }];
  }
  if (Array.isArray(data)) {
    return [{
      kind: 'json_array',
      size: data.length
    }];
  }
  if (typeof data === 'object') {
    return [{
      kind: 'json_object',
      keys: Object.keys(data).slice(0, 24)
    }];
  }
  return [{
    kind: 'primitive',
    value: data
  }];
}

function normalizeEvidenceList(actionResult = {}, result = {}) {
  if (Array.isArray(actionResult?.evidence) && actionResult.evidence.length) {
    return actionResult.evidence;
  }
  if (Array.isArray(result?.evidence) && result.evidence.length) {
    return result.evidence;
  }
  return inferEvidenceFromMcpData(result?.data);
}

function normalizeArtifactsList(actionResult = {}, result = {}) {
  if (Array.isArray(actionResult?.artifacts)) return actionResult.artifacts;
  if (Array.isArray(result?.artifacts)) return result.artifacts;
  if (Array.isArray(result?.data?.artifacts)) return result.data.artifacts;
  return [];
}

export function normalizeActionOutcome({
  result = {},
  actionResult = null
} = {}) {
  const payload = (result && typeof result === 'object') ? result : {};
  const action = (actionResult && typeof actionResult === 'object') ? actionResult : {};
  const protocolOk = (typeof action.ok === 'boolean') ? action.ok : undefined;
  const resultOk = (payload.success === true) ? true : (payload.success === false ? false : undefined);
  const success = (typeof protocolOk === 'boolean') ? protocolOk : (resultOk === true);
  const code = toText(action.code || payload.code || (success ? 'OK' : 'UNKNOWN'));
  const inferredFailure = classifyFailureByCode(code, { success, emptyClass: 'unknown' });
  const errorClass = toText(action.errorClass || inferredFailure.errorClass);
  const retryable = (typeof action.retryable === 'boolean') ? action.retryable : inferredFailure.retryable;
  const message = toText(action?.status?.message || payload.message || payload.error || '');
  return {
    success,
    code,
    errorClass,
    retryable,
    message,
    evidence: normalizeEvidenceList(action, payload),
    artifacts: normalizeArtifactsList(action, payload),
    provider: toText(action?.output?.provider || payload.provider || ''),
    data: (action?.output && typeof action.output === 'object' && 'data' in action.output)
      ? action.output.data
      : (payload?.data ?? null)
  };
}

export function buildActionResultFromMcp({
  step = {},
  args = {},
  result = {},
  elapsedMs = 0
} = {}) {
  const payload = (result && typeof result === 'object') ? result : {};
  const success = payload.success === true;
  const code = toText(payload.code || 'UNKNOWN');
  const failure = classifyFailureByCode(code, { success, emptyClass: 'unknown' });
  const artifactsRaw = Array.isArray(payload?.artifacts)
    ? payload.artifacts
    : (Array.isArray(payload?.data?.artifacts) ? payload.data.artifacts : []);
  const evidence = Array.isArray(payload?.evidence) && payload.evidence.length
    ? payload.evidence
    : inferEvidenceFromMcpData(payload?.data);
  return {
    ok: success,
    code,
    errorClass: failure.errorClass,
    retryable: failure.retryable,
    action: {
      executor: normalizeExecutorLike(step),
      actionRef: normalizeActionRef(step) || toText(step?.aiName),
      aiName: toText(step?.aiName),
      stepId: toText(step?.stepId)
    },
    status: {
      success,
      code,
      message: toText(payload.message || payload.error || '')
    },
    input: { args: (args && typeof args === 'object') ? args : {} },
    output: {
      provider: toText(payload.provider || ''),
      data: payload?.data ?? null
    },
    evidence,
    artifacts: artifactsRaw,
    metrics: {
      elapsedMs: Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : 0
    }
  };
}

export function buildActionResultFromTerminal({
  step = {},
  args = {},
  result = {},
  elapsedMs = 0
} = {}) {
  const payload = (result && typeof result === 'object') ? result : {};
  const success = payload.success === true;
  const code = toText(payload.code || 'UNKNOWN');
  const failure = classifyFailureByCode(code, { success, emptyClass: 'unknown' });
  const terminal = (payload?.data && typeof payload.data === 'object' && payload.data.terminal && typeof payload.data.terminal === 'object')
    ? payload.data.terminal
    : {};
  const outputText = toText(terminal.output);
  const evidence = [{
    kind: 'terminal',
    command: toText(terminal.command || args?.command || ''),
    executionMode: toText(terminal.executionMode || ''),
    exitCode: Number.isFinite(Number(terminal.exitCode)) ? Number(terminal.exitCode) : null,
    outputExcerpt: clip(outputText, 700),
    outputChars: outputText.length
  }];

  return {
    ok: success,
    code,
    errorClass: failure.errorClass,
    retryable: failure.retryable,
    action: {
      executor: 'sandbox',
      actionRef: normalizeActionRef(step) || TERMINAL_RUNTIME_ACTION,
      aiName: toText(step?.aiName),
      stepId: toText(step?.stepId)
    },
    status: {
      success,
      code,
      message: toText(payload.message || payload.error || '')
    },
    input: { args: (args && typeof args === 'object') ? args : {} },
    output: {
      provider: 'runtime_terminal',
      data: payload?.data ?? null
    },
    evidence,
    artifacts: Array.isArray(payload?.artifacts) ? payload.artifacts : [],
    metrics: {
      elapsedMs: Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : 0
    }
  };
}

export default {
  normalizeActionOutcome,
  buildActionResultFromMcp,
  buildActionResultFromTerminal
};
