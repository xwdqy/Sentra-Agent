type AnyRecord = Record<string, unknown>;
const ACTION_RESULT_MAX_STRING_CHARS = 320;
const ACTION_RESULT_MAX_ARRAY_ITEMS = 8;
const ACTION_RESULT_MAX_OBJECT_KEYS = 24;
const ACTION_RESULT_MAX_DEPTH = 4;

export type RuntimeProtocolKind =
  | 'none'
  | 'tool_gate'
  | 'action_request'
  | 'step_state'
  | 'workspace_diff'
  | 'assistant_delivery'
  | 'feedback_cycle'
  | 'orchestrator_state';
export const RUNTIME_PROTOCOL_KINDS: ReadonlySet<RuntimeProtocolKind> = new Set<RuntimeProtocolKind>([
  'none',
  'tool_gate',
  'action_request',
  'step_state',
  'workspace_diff',
  'assistant_delivery',
  'feedback_cycle',
  'orchestrator_state'
]);

export type RuntimeActionRequestRecord = {
  runId: string;
  stepId: string;
  stepIndex: number | null;
  plannedStepIndex: number | null;
  executionIndex: number | null;
  attemptNo: number | null;
  aiName: string;
  executor: string;
  actionRef: string;
  args: Record<string, unknown> | null;
};

export type RuntimeStepStateRecord = {
  runId: string;
  stepId: string;
  stepIndex: number | null;
  aiName: string;
  executor: string;
  actionRef: string;
  from: string;
  to: string;
  reasonCode: string;
  reason: string;
  attemptNo: number | null;
  resultCode: string;
};

export type RuntimeToolGateRecord = {
  need: boolean | null;
  selectedCount: number | null;
  totalCount: number | null;
  selectedTools: string[];
  skippedCount: number | null;
  summary: string;
};

export type RuntimeActionResultRecord = {
  runId: string;
  stepId: string;
  stepIndex: number | null;
  plannedStepIndex: number | null;
  executionIndex: number | null;
  attemptNo: number | null;
  aiName: string;
  executor: string;
  actionRef: string;
  ok: boolean | null;
  code: string;
  statusCode: string;
  errorClass: string;
  retryable: boolean | null;
  message: string;
  inputArgs: Record<string, unknown> | null;
  outputProvider: string;
  outputData: Record<string, unknown> | null;
  evidence: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  metrics: Record<string, unknown> | null;
};

export type RuntimeWorkspaceDiffRecord = {
  runId: string;
  stepId: string;
  stepIndex: number | null;
  aiName: string;
  stepKey: string;
  effect: string;
  added: number;
  changed: number;
  removed: number;
  totalDelta: number;
  comparedAt: number | null;
  rootDir: string;
  paths: string[];
};

export type RuntimeAssistantDeliveryRecord = {
  runId: string;
  phase: string;
  noReply: boolean | null;
  delivered: boolean | null;
  contentLength: number;
  contentPreview: string;
  ts: number | null;
  stage: string;
};

export type RuntimeFeedbackCycleRecord = {
  runId: string;
  phase: string;
  round: number | null;
  waitMode: string;
  interrupted: boolean | null;
  flushAcked: boolean | null;
  batchCount: number | null;
  responseCount: number | null;
  flushedCount: number | null;
  reason: string;
  ts: number | null;
};

export type RuntimeOrchestratorStateRecord = {
  runId: string;
  state: string;
  status: string;
  reasonCode: string;
  note: string;
  childRunCount: number | null;
  ts: number | null;
};

export type RuntimeProtocolConsumeResult =
  | { kind: 'none' }
  | { kind: 'tool_gate'; record: RuntimeToolGateRecord }
  | { kind: 'action_request'; record: RuntimeActionRequestRecord }
  | { kind: 'step_state'; record: RuntimeStepStateRecord }
  | { kind: 'workspace_diff'; record: RuntimeWorkspaceDiffRecord }
  | { kind: 'assistant_delivery'; record: RuntimeAssistantDeliveryRecord }
  | { kind: 'feedback_cycle'; record: RuntimeFeedbackCycleRecord }
  | { kind: 'orchestrator_state'; record: RuntimeOrchestratorStateRecord };

export type RuntimeProtocolSnapshot = {
  toolGate: RuntimeToolGateRecord | null;
  counters: {
    toolGate: number;
    actionRequest: number;
    stepState: number;
    actionResult: number;
    workspaceDiff: number;
    assistantDelivery: number;
    feedbackCycle: number;
    orchestratorState: number;
  };
  latestStepStateByStepKey: Record<string, string>;
  latestStepDetailByStepKey: Record<string, {
    runId: string;
    stepId: string;
    stepIndex: number | null;
    aiName: string;
    executor: string;
    actionRef: string;
    from: string;
    to: string;
    reasonCode: string;
    reason: string;
    attemptNo: number | null;
    resultCode: string;
  }>;
  latestActionResultByStepKey: Record<string, {
    runId: string;
    stepId: string;
    stepIndex: number | null;
    plannedStepIndex: number | null;
    executionIndex: number | null;
    attemptNo: number | null;
    aiName: string;
    executor: string;
    actionRef: string;
    ok: boolean | null;
    code: string;
    statusCode: string;
    errorClass: string;
    retryable: boolean | null;
    message: string;
    inputArgs: Record<string, unknown> | null;
    outputProvider: string;
    outputData: Record<string, unknown> | null;
    evidence: Record<string, unknown>[];
    artifacts: Record<string, unknown>[];
    metrics: Record<string, unknown> | null;
  }>;
  latestWorkspaceDiffByStepKey: Record<string, {
    runId: string;
    stepId: string;
    stepIndex: number | null;
    aiName: string;
    stepKey: string;
    effect: string;
    added: number;
    changed: number;
    removed: number;
    totalDelta: number;
    comparedAt: number | null;
    rootDir: string;
    paths: string[];
  }>;
  assistantDeliveries: Array<{
    runId: string;
    phase: string;
    noReply: boolean | null;
    delivered: boolean | null;
    contentLength: number;
    contentPreview: string;
    ts: number | null;
    stage: string;
  }>;
  feedbackCycles: Array<{
    runId: string;
    phase: string;
    round: number | null;
    waitMode: string;
    interrupted: boolean | null;
    flushAcked: boolean | null;
    batchCount: number | null;
    responseCount: number | null;
    flushedCount: number | null;
    reason: string;
    ts: number | null;
  }>;
  latestOrchestratorState: {
    runId: string;
    state: string;
    status: string;
    reasonCode: string;
    note: string;
    childRunCount: number | null;
    ts: number | null;
  } | null;
  terminalOutcomes: Array<{
    stepKey: string;
    runId: string;
    stepId: string;
    stepIndex: number | null;
    aiName: string;
    executor: string;
    actionRef: string;
    state: string;
    reasonCode: string;
    reason: string;
    attemptNo: number | null;
    resultCode: string;
  }>;
};

function toText(value: unknown): string {
  return String(value ?? '').trim();
}

function toIntOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toObjectOrNull(value: unknown): AnyRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AnyRecord;
}

function compactValue(value: unknown, depth = ACTION_RESULT_MAX_DEPTH): unknown {
  if (depth < 0) return null;
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > ACTION_RESULT_MAX_STRING_CHARS
      ? value.slice(0, ACTION_RESULT_MAX_STRING_CHARS)
      : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, ACTION_RESULT_MAX_ARRAY_ITEMS)) {
      out.push(compactValue(item, depth - 1));
    }
    return out;
  }
  const obj = value as AnyRecord;
  const keys = Object.keys(obj).slice(0, ACTION_RESULT_MAX_OBJECT_KEYS);
  const out: AnyRecord = {};
  for (const key of keys) {
    out[key] = compactValue(obj[key], depth - 1);
  }
  return out;
}

function compactObjectOrNull(value: unknown, depth = ACTION_RESULT_MAX_DEPTH): AnyRecord | null {
  const obj = toObjectOrNull(value);
  if (!obj) return null;
  const compacted = compactValue(obj, depth);
  return toObjectOrNull(compacted);
}

function compactObjectArray(value: unknown, limit = ACTION_RESULT_MAX_ARRAY_ITEMS): AnyRecord[] {
  const src = Array.isArray(value) ? value : [];
  const out: AnyRecord[] = [];
  for (const item of src.slice(0, limit)) {
    const compacted = compactObjectOrNull(item, 3);
    if (!compacted) continue;
    out.push(compacted);
  }
  return out;
}

function normalizeActionRequestRecord(raw: unknown): RuntimeActionRequestRecord | null {
  const obj = toObjectOrNull(raw);
  if (!obj || toText(obj.type) !== 'action_request') return null;
  const action = toObjectOrNull(obj.action);
  const input = toObjectOrNull(obj.input);
  const args = toObjectOrNull(input?.args);
  return {
    runId: toText(obj.runId),
    stepId: toText(obj.stepId),
    stepIndex: toIntOrNull(obj.stepIndex),
    plannedStepIndex: toIntOrNull(obj.plannedStepIndex),
    executionIndex: toIntOrNull(obj.executionIndex),
    attemptNo: toIntOrNull(obj.attemptNo),
    aiName: toText(action?.aiName),
    executor: toText(action?.executor),
    actionRef: toText(action?.actionRef),
    args
  };
}

function normalizeStepStateRecord(raw: unknown): RuntimeStepStateRecord | null {
  const obj = toObjectOrNull(raw);
  if (!obj || toText(obj.type) !== 'step_state') return null;
  return {
    runId: toText(obj.runId),
    stepId: toText(obj.stepId),
    stepIndex: toIntOrNull(obj.stepIndex),
    aiName: toText(obj.aiName),
    executor: toText(obj.executor),
    actionRef: toText(obj.actionRef),
    from: toText(obj.from).toLowerCase(),
    to: toText(obj.to).toLowerCase(),
    reasonCode: toText(obj.reasonCode),
    reason: toText(obj.reason),
    attemptNo: toIntOrNull(obj.attemptNo),
    resultCode: toText(obj.resultCode)
  };
}

function normalizeToolGateRecord(raw: unknown): RuntimeToolGateRecord | null {
  const obj = toObjectOrNull(raw);
  if (!obj || toText(obj.type) !== 'tool_gate') return null;
  const selectedToolsRaw = Array.isArray(obj.selectedTools) ? obj.selectedTools : [];
  const selectedTools = selectedToolsRaw
    .map((x) => toText(x))
    .filter(Boolean);
  return {
    need: typeof obj.need === 'boolean' ? obj.need : null,
    selectedCount: toIntOrNull(obj.selectedCount),
    totalCount: toIntOrNull(obj.totalCount),
    selectedTools,
    skippedCount: toIntOrNull(obj.skippedCount),
    summary: toText(obj.summary)
  };
}

function normalizeActionResultRecord(raw: unknown): RuntimeActionResultRecord | null {
  const obj = toObjectOrNull(raw);
  if (!obj || toText(obj.type) !== 'tool_result') return null;
  const actionResult = toObjectOrNull(obj.actionResult);
  if (!actionResult) return null;
  const action = toObjectOrNull(actionResult.action);
  const status = toObjectOrNull(actionResult.status);
  const input = toObjectOrNull(actionResult.input);
  const output = toObjectOrNull(actionResult.output);
  const stepIndex = toIntOrNull(obj.plannedStepIndex ?? obj.stepIndex ?? action?.stepIndex);
  const plannedStepIndex = toIntOrNull(obj.plannedStepIndex);
  const okRaw = actionResult.ok;
  const retryableRaw = actionResult.retryable;
  const statusCode = toText(status?.code ?? actionResult.code);
  const inputArgs = compactObjectOrNull(input?.args, 3);
  const outputData = compactObjectOrNull(output?.data, 3);
  const evidence = compactObjectArray(actionResult.evidence, 10);
  const artifacts = compactObjectArray(actionResult.artifacts, 10);
  const metrics = compactObjectOrNull(actionResult.metrics, 2);
  return {
    runId: toText(obj.runId),
    stepId: toText(obj.stepId ?? action?.stepId),
    stepIndex,
    plannedStepIndex,
    executionIndex: toIntOrNull(obj.executionIndex),
    attemptNo: toIntOrNull(obj.attemptNo),
    aiName: toText(obj.aiName ?? action?.aiName),
    executor: toText(obj.executor ?? action?.executor),
    actionRef: toText(obj.actionRef ?? action?.actionRef),
    ok: typeof okRaw === 'boolean' ? okRaw : (typeof status?.success === 'boolean' ? status.success : null),
    code: toText(actionResult.code ?? statusCode),
    statusCode,
    errorClass: toText(actionResult.errorClass),
    retryable: typeof retryableRaw === 'boolean' ? retryableRaw : null,
    message: toText(status?.message),
    inputArgs,
    outputProvider: toText(output?.provider),
    outputData,
    evidence,
    artifacts,
    metrics
  };
}

function normalizeWorkspaceDiffRecord(raw: unknown): RuntimeWorkspaceDiffRecord | null {
  const obj = toObjectOrNull(raw);
  if (!obj) return null;
  const type = toText(obj.type).toLowerCase();
  if (type !== 'workspace_diff' && type !== 'runtime_workspace_diff') return null;

  const summary = toObjectOrNull(obj.summary);
  const stepId = toText(obj.stepId);
  const stepIndex = toIntOrNull(obj.stepIndex);
  const stepKeyRaw = toText(obj.stepKey);
  const stepKey = stepKeyRaw || buildStepKey(stepId, stepIndex);
  const totalDelta = toIntOrNull(summary?.totalDelta ?? obj.totalDelta);
  const added = toIntOrNull(summary?.added ?? obj.added);
  const changed = toIntOrNull(summary?.changed ?? obj.changed);
  const removed = toIntOrNull(summary?.removed ?? obj.removed);
  const comparedAt = toIntOrNull(obj.comparedAt ?? summary?.comparedAt);
  const paths = Array.isArray(obj.paths)
    ? obj.paths.map((x) => toText(x)).filter(Boolean).slice(0, ACTION_RESULT_MAX_ARRAY_ITEMS * 2)
    : [];
  const effectText = toText(obj.effect).toLowerCase();
  const effect = effectText || ((Number(totalDelta || 0) > 0) ? 'changed' : 'no_effect');

  return {
    runId: toText(obj.runId),
    stepId,
    stepIndex,
    aiName: toText(obj.aiName),
    stepKey,
    effect,
    added: Number.isFinite(Number(added)) ? Number(added) : 0,
    changed: Number.isFinite(Number(changed)) ? Number(changed) : 0,
    removed: Number.isFinite(Number(removed)) ? Number(removed) : 0,
    totalDelta: Number.isFinite(Number(totalDelta)) ? Number(totalDelta) : 0,
    comparedAt,
    rootDir: toText(obj.rootDir),
    paths
  };
}

function normalizeAssistantDeliveryRecord(raw: unknown): RuntimeAssistantDeliveryRecord | null {
  const obj = toObjectOrNull(raw);
  if (!obj || toText(obj.type).toLowerCase() !== 'assistant_delivery') return null;
  const meta = toObjectOrNull(obj.meta);
  const content = toText(obj.content);
  const contentLengthRaw = toIntOrNull(obj.contentLength);
  const contentLength = contentLengthRaw != null
    ? Math.max(0, contentLengthRaw)
    : content.length;
  const preview = content
    ? content.slice(0, ACTION_RESULT_MAX_STRING_CHARS)
    : '';
  return {
    runId: toText(obj.runId),
    phase: toText(obj.phase),
    noReply: typeof obj.noReply === 'boolean' ? obj.noReply : null,
    delivered: typeof obj.delivered === 'boolean' ? obj.delivered : null,
    contentLength,
    contentPreview: preview,
    ts: toIntOrNull(obj.ts),
    stage: toText(meta?.stage)
  };
}

function normalizeFeedbackCycleRecord(raw: unknown): RuntimeFeedbackCycleRecord | null {
  const obj = toObjectOrNull(raw);
  if (!obj) return null;
  const phase = toText(obj.type).toLowerCase();
  if (phase !== 'feedback_wait' && phase !== 'feedback_received' && phase !== 'feedback_flush_done') return null;
  return {
    runId: toText(obj.runId),
    phase,
    round: toIntOrNull(obj.round),
    waitMode: toText(obj.waitMode),
    interrupted: typeof obj.interrupted === 'boolean' ? obj.interrupted : null,
    flushAcked: typeof obj.flushAcked === 'boolean' ? obj.flushAcked : null,
    batchCount: toIntOrNull(obj.batchCount),
    responseCount: toIntOrNull(obj.responseCount),
    flushedCount: toIntOrNull(obj.flushedCount),
    reason: toText(obj.reason),
    ts: toIntOrNull(obj.ts)
  };
}

function normalizeOrchestratorStateRecord(raw: unknown): RuntimeOrchestratorStateRecord | null {
  const obj = toObjectOrNull(raw);
  if (!obj || toText(obj.type).toLowerCase() !== 'orchestrator_state') return null;
  const state = toText(obj.state).toLowerCase();
  const status = toText(obj.status).toLowerCase();
  if (!state && !status) return null;
  return {
    runId: toText(obj.runId),
    state: state || status,
    status: status || state,
    reasonCode: toText(obj.reasonCode),
    note: toText(obj.note),
    childRunCount: toIntOrNull(obj.childRunCount),
    ts: toIntOrNull(obj.ts)
  };
}

function buildStepKey(stepId: string, stepIndex: number | null): string {
  if (stepId) return `sid:${stepId}`;
  if (stepIndex != null) return `idx:${stepIndex}`;
  return '';
}

export class McpRuntimeProtocolTracker {
  private actionByStepId = new Map<string, RuntimeActionRequestRecord>();
  private actionByStepIndex = new Map<number, RuntimeActionRequestRecord>();
  private latestStepStateByStepKey = new Map<string, RuntimeStepStateRecord>();
  private latestActionResultByStepKey = new Map<string, RuntimeActionResultRecord>();
  private latestWorkspaceDiffByStepKey = new Map<string, RuntimeWorkspaceDiffRecord>();
  private assistantDeliveries: RuntimeAssistantDeliveryRecord[] = [];
  private feedbackCycles: RuntimeFeedbackCycleRecord[] = [];
  private latestOrchestratorState: RuntimeOrchestratorStateRecord | null = null;
  private toolGate: RuntimeToolGateRecord | null = null;
  private counters = {
    toolGate: 0,
    actionRequest: 0,
    stepState: 0,
    actionResult: 0,
    workspaceDiff: 0,
    assistantDelivery: 0,
    feedbackCycle: 0,
    orchestratorState: 0
  };

  consume(raw: unknown): RuntimeProtocolConsumeResult {
    const toolGate = normalizeToolGateRecord(raw);
    if (toolGate) {
      this.toolGate = toolGate;
      this.counters.toolGate += 1;
      return { kind: 'tool_gate', record: toolGate };
    }

    const actionRequest = normalizeActionRequestRecord(raw);
    if (actionRequest) {
      if (actionRequest.stepId) this.actionByStepId.set(actionRequest.stepId, actionRequest);
      if (actionRequest.stepIndex != null) this.actionByStepIndex.set(actionRequest.stepIndex, actionRequest);
      this.counters.actionRequest += 1;
      return { kind: 'action_request', record: actionRequest };
    }

    const stepState = normalizeStepStateRecord(raw);
    if (stepState) {
      const key = buildStepKey(stepState.stepId, stepState.stepIndex);
      if (key) this.latestStepStateByStepKey.set(key, stepState);
      this.counters.stepState += 1;
      return { kind: 'step_state', record: stepState };
    }

    const workspaceDiff = normalizeWorkspaceDiffRecord(raw);
    if (workspaceDiff) {
      const key = workspaceDiff.stepKey || buildStepKey(workspaceDiff.stepId, workspaceDiff.stepIndex);
      if (key) {
        this.latestWorkspaceDiffByStepKey.set(key, {
          ...workspaceDiff,
          stepKey: key
        });
      }
      this.counters.workspaceDiff += 1;
      return { kind: 'workspace_diff', record: workspaceDiff };
    }

    const assistantDelivery = normalizeAssistantDeliveryRecord(raw);
    if (assistantDelivery) {
      this.assistantDeliveries.push(assistantDelivery);
      const max = ACTION_RESULT_MAX_ARRAY_ITEMS * 8;
      if (this.assistantDeliveries.length > max) {
        this.assistantDeliveries.splice(0, this.assistantDeliveries.length - max);
      }
      this.counters.assistantDelivery += 1;
      return { kind: 'assistant_delivery', record: assistantDelivery };
    }

    const feedbackCycle = normalizeFeedbackCycleRecord(raw);
    if (feedbackCycle) {
      this.feedbackCycles.push(feedbackCycle);
      const max = ACTION_RESULT_MAX_ARRAY_ITEMS * 8;
      if (this.feedbackCycles.length > max) {
        this.feedbackCycles.splice(0, this.feedbackCycles.length - max);
      }
      this.counters.feedbackCycle += 1;
      return { kind: 'feedback_cycle', record: feedbackCycle };
    }

    const orchestratorState = normalizeOrchestratorStateRecord(raw);
    if (orchestratorState) {
      this.latestOrchestratorState = orchestratorState;
      this.counters.orchestratorState += 1;
      return { kind: 'orchestrator_state', record: orchestratorState };
    }

    return { kind: 'none' };
  }

  ingestToolResult(raw: unknown): boolean {
    const actionResult = normalizeActionResultRecord(raw);
    if (!actionResult) return false;
    const key = buildStepKey(actionResult.stepId, actionResult.stepIndex);
    if (key) {
      this.latestActionResultByStepKey.set(key, actionResult);
    }
    this.counters.actionResult += 1;
    return true;
  }

  matchToolResult(evLike: unknown): { aiName: string; args: Record<string, unknown> | null } | null {
    const obj = toObjectOrNull(evLike);
    if (!obj) return null;
    const stepId = toText(obj.stepId);
    const plannedStepIndex = toIntOrNull(obj.plannedStepIndex);
    const stepIndex = toIntOrNull(obj.stepIndex);

    let req: RuntimeActionRequestRecord | null = null;
    if (stepId && this.actionByStepId.has(stepId)) {
      req = this.actionByStepId.get(stepId) || null;
    }
    if (!req && plannedStepIndex != null && this.actionByStepIndex.has(plannedStepIndex)) {
      req = this.actionByStepIndex.get(plannedStepIndex) || null;
    }
    if (!req && stepIndex != null && this.actionByStepIndex.has(stepIndex)) {
      req = this.actionByStepIndex.get(stepIndex) || null;
    }
    if (!req) return null;

    return {
      aiName: req.aiName,
      args: req.args
    };
  }

  snapshot(): RuntimeProtocolSnapshot {
    const latestStepStateByStepKey: Record<string, string> = {};
    const latestStepDetailByStepKey: Record<string, {
      runId: string;
      stepId: string;
      stepIndex: number | null;
      aiName: string;
      executor: string;
      actionRef: string;
      from: string;
      to: string;
      reasonCode: string;
      reason: string;
      attemptNo: number | null;
      resultCode: string;
    }> = {};
    const latestActionResultByStepKey: Record<string, {
      runId: string;
      stepId: string;
      stepIndex: number | null;
      plannedStepIndex: number | null;
      executionIndex: number | null;
      attemptNo: number | null;
      aiName: string;
      executor: string;
      actionRef: string;
      ok: boolean | null;
      code: string;
      statusCode: string;
      errorClass: string;
      retryable: boolean | null;
      message: string;
      inputArgs: Record<string, unknown> | null;
      outputProvider: string;
      outputData: Record<string, unknown> | null;
      evidence: Record<string, unknown>[];
      artifacts: Record<string, unknown>[];
      metrics: Record<string, unknown> | null;
    }> = {};
    const latestWorkspaceDiffByStepKey: Record<string, {
      runId: string;
      stepId: string;
      stepIndex: number | null;
      aiName: string;
      stepKey: string;
      effect: string;
      added: number;
      changed: number;
      removed: number;
      totalDelta: number;
      comparedAt: number | null;
      rootDir: string;
      paths: string[];
    }> = {};
    const assistantDeliveries: Array<{
      runId: string;
      phase: string;
      noReply: boolean | null;
      delivered: boolean | null;
      contentLength: number;
      contentPreview: string;
      ts: number | null;
      stage: string;
    }> = [];
    const feedbackCycles: Array<{
      runId: string;
      phase: string;
      round: number | null;
      waitMode: string;
      interrupted: boolean | null;
      flushAcked: boolean | null;
      batchCount: number | null;
      responseCount: number | null;
      flushedCount: number | null;
      reason: string;
      ts: number | null;
    }> = [];
    const terminalOutcomes: Array<{
      stepKey: string;
      runId: string;
      stepId: string;
      stepIndex: number | null;
      aiName: string;
      executor: string;
      actionRef: string;
      state: string;
      reasonCode: string;
      reason: string;
      attemptNo: number | null;
      resultCode: string;
    }> = [];
    for (const [key, state] of this.latestStepStateByStepKey.entries()) {
      latestStepStateByStepKey[key] = state.to || '';
      latestStepDetailByStepKey[key] = {
        runId: state.runId,
        stepId: state.stepId,
        stepIndex: state.stepIndex,
        aiName: state.aiName,
        executor: state.executor,
        actionRef: state.actionRef,
        from: state.from,
        to: state.to,
        reasonCode: state.reasonCode,
        reason: state.reason,
        attemptNo: state.attemptNo,
        resultCode: state.resultCode
      };
      if (state.to === 'succeeded' || state.to === 'failed' || state.to === 'finalized') {
        terminalOutcomes.push({
          stepKey: key,
          runId: state.runId,
          stepId: state.stepId,
          stepIndex: state.stepIndex,
          aiName: state.aiName,
          executor: state.executor,
          actionRef: state.actionRef,
          state: state.to,
          reasonCode: state.reasonCode,
          reason: state.reason,
          attemptNo: state.attemptNo,
          resultCode: state.resultCode
        });
      }
    }
    for (const [key, result] of this.latestActionResultByStepKey.entries()) {
      latestActionResultByStepKey[key] = {
        runId: result.runId,
        stepId: result.stepId,
        stepIndex: result.stepIndex,
        plannedStepIndex: result.plannedStepIndex,
        executionIndex: result.executionIndex,
        attemptNo: result.attemptNo,
        aiName: result.aiName,
        executor: result.executor,
        actionRef: result.actionRef,
        ok: result.ok,
        code: result.code,
        statusCode: result.statusCode,
        errorClass: result.errorClass,
        retryable: result.retryable,
        message: result.message,
        inputArgs: result.inputArgs,
        outputProvider: result.outputProvider,
        outputData: result.outputData,
        evidence: result.evidence,
        artifacts: result.artifacts,
        metrics: result.metrics
      };
    }
    for (const [key, diff] of this.latestWorkspaceDiffByStepKey.entries()) {
      latestWorkspaceDiffByStepKey[key] = {
        runId: diff.runId,
        stepId: diff.stepId,
        stepIndex: diff.stepIndex,
        aiName: diff.aiName,
        stepKey: diff.stepKey || key,
        effect: diff.effect,
        added: diff.added,
        changed: diff.changed,
        removed: diff.removed,
        totalDelta: diff.totalDelta,
        comparedAt: diff.comparedAt,
        rootDir: diff.rootDir,
        paths: Array.isArray(diff.paths) ? diff.paths.slice(0, ACTION_RESULT_MAX_ARRAY_ITEMS * 2) : []
      };
    }
    for (const item of this.assistantDeliveries.slice(-ACTION_RESULT_MAX_ARRAY_ITEMS * 8)) {
      assistantDeliveries.push({
        runId: item.runId,
        phase: item.phase,
        noReply: item.noReply,
        delivered: item.delivered,
        contentLength: item.contentLength,
        contentPreview: item.contentPreview,
        ts: item.ts,
        stage: item.stage
      });
    }
    for (const item of this.feedbackCycles.slice(-ACTION_RESULT_MAX_ARRAY_ITEMS * 8)) {
      feedbackCycles.push({
        runId: item.runId,
        phase: item.phase,
        round: item.round,
        waitMode: item.waitMode,
        interrupted: item.interrupted,
        flushAcked: item.flushAcked,
        batchCount: item.batchCount,
        responseCount: item.responseCount,
        flushedCount: item.flushedCount,
        reason: item.reason,
        ts: item.ts
      });
    }
    return {
      toolGate: this.toolGate,
      counters: { ...this.counters },
      latestStepStateByStepKey,
      latestStepDetailByStepKey,
      latestActionResultByStepKey,
      latestWorkspaceDiffByStepKey,
      assistantDeliveries,
      feedbackCycles,
      latestOrchestratorState: this.latestOrchestratorState
        ? {
          runId: this.latestOrchestratorState.runId,
          state: this.latestOrchestratorState.state,
          status: this.latestOrchestratorState.status,
          reasonCode: this.latestOrchestratorState.reasonCode,
          note: this.latestOrchestratorState.note,
          childRunCount: this.latestOrchestratorState.childRunCount,
          ts: this.latestOrchestratorState.ts
        }
        : null,
      terminalOutcomes
    };
  }
}

export default {
  McpRuntimeProtocolTracker
};
