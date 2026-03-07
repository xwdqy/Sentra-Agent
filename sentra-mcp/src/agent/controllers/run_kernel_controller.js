function toText(value) {
  return String(value ?? '').trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

export const STEP_STATES = Object.freeze([
  'planned',
  'running',
  'succeeded',
  'failed',
  'retrying',
  'replanned',
  'finalized'
]);

const STEP_STATE_SET = new Set(STEP_STATES);

const STEP_STATE_TRANSITIONS = Object.freeze({
  planned: new Set(['running', 'failed', 'finalized']),
  running: new Set(['succeeded', 'failed', 'retrying', 'replanned', 'finalized']),
  succeeded: new Set(['finalized']),
  failed: new Set(['retrying', 'replanned', 'finalized']),
  retrying: new Set(['running', 'failed', 'replanned', 'finalized']),
  replanned: new Set(['finalized']),
  finalized: new Set([])
});

export function normalizeStepState(value, fallback = 'planned') {
  const state = toText(value).toLowerCase();
  if (STEP_STATE_SET.has(state)) return state;
  return fallback;
}

function stepIdentity(stepId, stepIndex) {
  const sid = toText(stepId);
  if (sid) return `sid:${sid}`;
  const idx = Number(stepIndex);
  return Number.isFinite(idx) ? `idx:${Math.floor(idx)}` : '';
}

export function createStepStateTracker() {
  const stateByStep = new Map();

  const get = ({ stepId = '', stepIndex = -1 } = {}) => {
    const key = stepIdentity(stepId, stepIndex);
    if (!key) return 'planned';
    return normalizeStepState(stateByStep.get(key), 'planned');
  };

  const transition = ({
    runId = '',
    stepId = '',
    stepIndex = -1,
    aiName = '',
    executor = '',
    actionRef = '',
    nextState = '',
    reasonCode = '',
    reason = '',
    attemptNo = 0,
    resultCode = ''
  } = {}) => {
    const key = stepIdentity(stepId, stepIndex);
    if (!key) return null;
    const fromState = get({ stepId, stepIndex });
    const toState = normalizeStepState(nextState, fromState);
    if (fromState === toState) return null;
    const allowed = STEP_STATE_TRANSITIONS[fromState] || new Set();
    if (!allowed.has(toState)) return null;

    stateByStep.set(key, toState);
    return {
      type: 'step_state',
      ts: Date.now(),
      runId: toText(runId),
      stepId: toText(stepId),
      stepIndex: Number.isFinite(Number(stepIndex)) ? Number(stepIndex) : -1,
      plannedStepIndex: Number.isFinite(Number(stepIndex)) ? Number(stepIndex) : -1,
      aiName: toText(aiName),
      executor: toText(executor),
      actionRef: toText(actionRef),
      from: fromState,
      to: toState,
      reasonCode: toText(reasonCode),
      reason: toText(reason),
      attemptNo: Number.isFinite(Number(attemptNo)) ? Math.max(0, Math.floor(Number(attemptNo))) : 0,
      resultCode: toText(resultCode)
    };
  };

  return {
    get,
    transition
  };
}

export function buildActionRequest({
  runId = '',
  stepId = '',
  stepIndex = -1,
  executionIndex = -1,
  attemptNo = 0,
  aiName = '',
  executor = '',
  actionRef = '',
  args = {},
  objective = '',
  reason = '',
  nextStep = '',
  dependsOnStepIds = [],
  dependedByStepIds = [],
  toolContext = null
} = {}) {
  return {
    type: 'action_request',
    ts: Date.now(),
    runId: toText(runId),
    stepId: toText(stepId),
    stepIndex: Number.isFinite(Number(stepIndex)) ? Number(stepIndex) : -1,
    plannedStepIndex: Number.isFinite(Number(stepIndex)) ? Number(stepIndex) : -1,
    executionIndex: Number.isFinite(Number(executionIndex)) ? Number(executionIndex) : -1,
    attemptNo: Number.isFinite(Number(attemptNo)) ? Math.max(0, Math.floor(Number(attemptNo))) : 0,
    action: {
      aiName: toText(aiName),
      executor: toText(executor),
      actionRef: toText(actionRef)
    },
    input: {
      args: (args && typeof args === 'object') ? args : {}
    },
    objective: toText(objective),
    reason: toText(reason),
    nextStep: toText(nextStep),
    dependsOnStepIds: toArray(dependsOnStepIds).map((x) => toText(x)).filter(Boolean),
    dependedByStepIds: toArray(dependedByStepIds).map((x) => toText(x)).filter(Boolean),
    toolContext: (toolContext && typeof toolContext === 'object') ? toolContext : null
  };
}

export default {
  STEP_STATES,
  normalizeStepState,
  createStepStateTracker,
  buildActionRequest
};
