export type RuntimeProtocolEvent = Record<string, unknown>;

export const SKILLS_RUNTIME_ACTION = 'runtime__skills_reply';
export const SKILLS_RUNTIME_STEP_ID = 'skills_reply_dispatch';
export const SKILLS_RUNTIME_EXECUTOR = 'skills';
export const SKILLS_RUNTIME_RESULT_CODE = 'SKILLS_DISPATCHED';
export const SKILLS_RUNTIME_OUTCOME_CODE = Object.freeze({
  completed: 'SKILLS_REPLY_COMPLETED',
  failed: 'SKILLS_REPLY_FAILED',
  deferred: 'SKILLS_REPLY_DEFERRED',
  empty: 'SKILLS_REPLY_EMPTY',
  noReply: 'SKILLS_REPLY_NO_REPLY'
} as const);

type VirtualDispatchSpec = {
  runId?: string;
  objective?: string;
  aiName: string;
  stepId: string;
  executor: string;
  actionRef?: string;
  args?: Record<string, unknown>;
  resultCode?: string;
  reason?: string;
  summary?: string;
};

type VirtualDispatchFinalSpec = {
  runId?: string;
  aiName: string;
  stepId: string;
  executor: string;
  actionRef?: string;
  success: boolean;
  resultCode: string;
  reasonCode?: string;
  reason?: string;
  attemptNo?: number;
  plannedStepIndex?: number;
  stepIndex?: number;
  executionIndex?: number;
  inputArgs?: Record<string, unknown>;
  outputData?: Record<string, unknown>;
  outputProvider?: string;
  evidence?: Array<Record<string, unknown>>;
  artifacts?: Array<Record<string, unknown>>;
  metrics?: Record<string, unknown>;
  errorClass?: string;
  retryable?: boolean;
};

function toText(value: unknown): string {
  return String(value ?? '').trim();
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.trunc(fallback);
  return Math.trunc(n);
}

export function buildVirtualDispatchStartEvents(spec: VirtualDispatchSpec): RuntimeProtocolEvent[] {
  const aiName = toText(spec.aiName);
  const stepId = toText(spec.stepId);
  const executor = toText(spec.executor);
  const actionRef = toText(spec.actionRef || aiName) || aiName;
  const runId = toText(spec.runId);
  const objective = toText(spec.objective);
  const resultCode = toText(spec.resultCode || 'DISPATCHED');
  const reason = toText(spec.reason || 'virtual dispatch');
  const summary = toText(spec.summary || reason);
  const args = toObject(spec.args);

  return [
    {
      type: 'tool_gate',
      runId,
      ok: true,
      need: false,
      forced: true,
      summary,
      selectedCount: 1,
      totalCount: 1,
      selectedTools: [aiName],
      skippedCount: 0
    },
    {
      type: 'action_request',
      runId,
      stepId,
      stepIndex: 0,
      plannedStepIndex: 0,
      executionIndex: 0,
      attemptNo: 1,
      action: {
        aiName,
        executor,
        actionRef
      },
      input: { args },
      objective
    },
    {
      type: 'step_state',
      runId,
      stepId,
      stepIndex: 0,
      plannedStepIndex: 0,
      aiName,
      executor,
      actionRef,
      from: 'planned',
      to: 'running',
      reasonCode: 'virtual_dispatch_start',
      reason,
      attemptNo: 1,
      resultCode: ''
    }
  ];
}

export function buildSkillsDispatchProtocolEvents({
  runId = '',
  objective = '',
  args = {}
}: {
  runId?: string;
  objective?: string;
  args?: Record<string, unknown>;
} = {}): RuntimeProtocolEvent[] {
  return buildVirtualDispatchStartEvents({
    runId,
    objective,
    aiName: SKILLS_RUNTIME_ACTION,
    stepId: SKILLS_RUNTIME_STEP_ID,
    executor: SKILLS_RUNTIME_EXECUTOR,
    actionRef: SKILLS_RUNTIME_ACTION,
    args,
    resultCode: SKILLS_RUNTIME_RESULT_CODE,
    reason: 'skills path selected',
    summary: 'execution_path_skills'
  });
}

export function buildVirtualDispatchFinalEvents(spec: VirtualDispatchFinalSpec): RuntimeProtocolEvent[] {
  const runId = toText(spec.runId);
  const aiName = toText(spec.aiName);
  const stepId = toText(spec.stepId);
  const executor = toText(spec.executor);
  const actionRef = toText(spec.actionRef || aiName) || aiName;
  const success = spec.success === true;
  const resultCode = toText(spec.resultCode || (success ? 'COMPLETED' : 'FAILED'));
  const reason = toText(spec.reason || 'virtual dispatch finalized');
  const reasonCode = toText(spec.reasonCode || '');
  const plannedStepIndex = toInt(spec.plannedStepIndex, 0);
  const stepIndex = toInt(spec.stepIndex, plannedStepIndex);
  const executionIndex = toInt(spec.executionIndex, 0);
  const attemptNo = toInt(spec.attemptNo, 1);
  const inputArgs = toObject(spec.inputArgs);
  const outputData = toObject(spec.outputData);
  const outputProvider = toText(spec.outputProvider || 'runtime_skills') || 'runtime_skills';
  const evidenceRaw = Array.isArray(spec.evidence) ? spec.evidence : [];
  const evidence = evidenceRaw
    .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
    .map((x) => toObject(x));
  const artifactsRaw = Array.isArray(spec.artifacts) ? spec.artifacts : [];
  const artifacts = artifactsRaw
    .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
    .map((x) => toObject(x));
  const metrics = toObject(spec.metrics);
  const errorClass = toText(spec.errorClass || (success ? '' : 'tool_failure'));
  const retryable = spec.retryable === true;
  const stateDone = success ? 'succeeded' : 'failed';
  const reasonCodeDone = reasonCode || (success ? 'virtual_dispatch_done' : 'virtual_dispatch_failed');
  return [
    {
      type: 'tool_result',
      runId,
      stepId,
      plannedStepIndex,
      stepIndex,
      executionIndex,
      aiName,
      executor,
      actionRef,
      reason,
      result: {
        success,
        code: resultCode,
        provider: outputProvider,
        data: {
          ...outputData,
          source: 'skills_virtual_dispatch',
          reasonCode: reasonCodeDone,
          reason
        }
      },
      actionResult: {
        ok: success,
        code: resultCode,
        errorClass,
        retryable,
        action: {
          executor,
          actionRef,
          aiName,
          stepId
        },
        status: {
          success,
          code: resultCode,
          message: reason
        },
        input: { args: inputArgs },
        output: {
          provider: outputProvider,
          data: {
            ...outputData,
            reasonCode: reasonCodeDone,
            reason
          }
        },
        evidence: [
          {
            kind: 'skills_dispatch',
            reasonCode: reasonCodeDone,
            reason
          },
          ...evidence
        ],
        artifacts,
        metrics: {
          elapsedMs: Number.isFinite(Number(metrics.elapsedMs)) ? Number(metrics.elapsedMs) : 0,
          ...metrics
        }
      }
    },
    {
      type: 'step_state',
      runId,
      stepId,
      stepIndex,
      plannedStepIndex,
      aiName,
      executor,
      actionRef,
      from: 'running',
      to: stateDone,
      reasonCode: reasonCodeDone,
      reason,
      attemptNo,
      resultCode
    },
    {
      type: 'step_state',
      runId,
      stepId,
      stepIndex,
      plannedStepIndex,
      aiName,
      executor,
      actionRef,
      from: stateDone,
      to: 'finalized',
      reasonCode: reasonCode ? `${reasonCode}_finalized` : 'virtual_dispatch_finalized',
      reason,
      attemptNo,
      resultCode
    }
  ];
}

export function buildSkillsDispatchFinalEvents({
  runId = '',
  success = true,
  resultCode = '',
  reasonCode = '',
  reason = '',
  inputArgs = {},
  outputData = {},
  outputProvider = 'runtime_skills',
  evidence = [],
  artifacts = [],
  metrics = {},
  errorClass = '',
  retryable = false
}: {
  runId?: string;
  success?: boolean;
  resultCode?: string;
  reasonCode?: string;
  reason?: string;
  inputArgs?: Record<string, unknown>;
  outputData?: Record<string, unknown>;
  outputProvider?: string;
  evidence?: Array<Record<string, unknown>>;
  artifacts?: Array<Record<string, unknown>>;
  metrics?: Record<string, unknown>;
  errorClass?: string;
  retryable?: boolean;
} = {}): RuntimeProtocolEvent[] {
  return buildVirtualDispatchFinalEvents({
    runId,
    aiName: SKILLS_RUNTIME_ACTION,
    stepId: SKILLS_RUNTIME_STEP_ID,
    executor: SKILLS_RUNTIME_EXECUTOR,
    actionRef: SKILLS_RUNTIME_ACTION,
    success,
    resultCode: resultCode || (success ? SKILLS_RUNTIME_OUTCOME_CODE.completed : SKILLS_RUNTIME_OUTCOME_CODE.failed),
    reasonCode,
    reason,
    inputArgs,
    outputData,
    outputProvider,
    evidence,
    artifacts,
    metrics,
    errorClass,
    retryable
  });
}

export default {
  SKILLS_RUNTIME_ACTION,
  SKILLS_RUNTIME_STEP_ID,
  SKILLS_RUNTIME_EXECUTOR,
  SKILLS_RUNTIME_RESULT_CODE,
  SKILLS_RUNTIME_OUTCOME_CODE,
  buildVirtualDispatchStartEvents,
  buildSkillsDispatchProtocolEvents,
  buildVirtualDispatchFinalEvents,
  buildSkillsDispatchFinalEvents
};
