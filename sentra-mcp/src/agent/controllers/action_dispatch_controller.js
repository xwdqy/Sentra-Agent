import { runTerminalTask } from '../../runtime/terminal/manager.js';
import {
  TERMINAL_RUNTIME_AI_NAME,
  TERMINAL_RUNTIME_ACTION,
  isTerminalRuntimeStep
} from '../../runtime/terminal/spec.js';
import {
  buildActionResultFromMcp,
  buildActionResultFromTerminal
} from './action_result_controller.js';

function toText(value) {
  return String(value ?? '').trim();
}

function normalizeExecutor(value, fallback = 'mcp') {
  const s = toText(value).toLowerCase();
  return s || fallback;
}

function normalizeActionRequest(raw = {}) {
  const req = (raw && typeof raw === 'object') ? raw : {};
  const action = (req.action && typeof req.action === 'object') ? req.action : {};
  const input = (req.input && typeof req.input === 'object') ? req.input : {};
  const stepIndex = Number(req.stepIndex);
  const plannedStepIndex = Number(req.plannedStepIndex);
  const executionIndex = Number(req.executionIndex);
  const attemptNo = Number(req.attemptNo);

  const normalized = {
    runId: toText(req.runId),
    stepId: toText(req.stepId),
    stepIndex: Number.isFinite(stepIndex) ? Math.floor(stepIndex) : -1,
    plannedStepIndex: Number.isFinite(plannedStepIndex) ? Math.floor(plannedStepIndex) : -1,
    executionIndex: Number.isFinite(executionIndex) ? Math.floor(executionIndex) : -1,
    attemptNo: Number.isFinite(attemptNo) ? Math.max(0, Math.floor(attemptNo)) : 0,
    action: {
      aiName: toText(action.aiName),
      executor: normalizeExecutor(action.executor),
      actionRef: toText(action.actionRef)
    },
    input: {
      args: (input.args && typeof input.args === 'object') ? input.args : {}
    }
  };

  if (!normalized.action.aiName && normalized.action.actionRef === TERMINAL_RUNTIME_ACTION) {
    normalized.action.aiName = TERMINAL_RUNTIME_AI_NAME;
  }
  if (!normalized.action.actionRef && normalized.action.aiName === TERMINAL_RUNTIME_AI_NAME) {
    normalized.action.actionRef = TERMINAL_RUNTIME_ACTION;
  }
  if (isTerminalRuntimeStep({
    aiName: normalized.action.aiName,
    executor: normalized.action.executor,
    actionRef: normalized.action.actionRef
  })) {
    normalized.action.executor = 'sandbox';
  }
  return normalized;
}

export async function dispatchActionRequest({
  mcpcore,
  request = {},
  context = {},
  executionOptions = {}
} = {}) {
  const req = normalizeActionRequest(request);
  const args = req.input.args;
  const step = {
    stepId: req.stepId,
    aiName: req.action.aiName,
    executor: req.action.executor,
    actionRef: req.action.actionRef
  };
  const startedAt = Date.now();

  if (!req.action.aiName) {
    return {
      success: false,
      code: 'INVALID_ACTION_REQUEST',
      error: { message: 'action.aiName is required' },
      request: req,
      actionResult: {
        action: {
          executor: req.action.executor || 'mcp',
          actionRef: req.action.actionRef || '',
          aiName: '',
          stepId: req.stepId
        },
        status: {
          success: false,
          code: 'INVALID_ACTION_REQUEST',
          message: 'action.aiName is required'
        },
        input: { args },
        output: { provider: '', data: null },
        evidence: [],
        artifacts: [],
        metrics: { elapsedMs: Date.now() - startedAt }
      }
    };
  }

  const isTerminal = isTerminalRuntimeStep(step);
  if (isTerminal) {
    const result = await runTerminalTask(
      { args },
      { executionOptions: (executionOptions && typeof executionOptions === 'object') ? executionOptions : {} }
    );
    const elapsedMs = Date.now() - startedAt;
    const actionResult = buildActionResultFromTerminal({
      step,
      args,
      result,
      elapsedMs
    });
    return {
      ...result,
      request: req,
      actionResult
    };
  }

  const options = (executionOptions && typeof executionOptions === 'object') ? executionOptions : {};
  const executors = (options.executors && typeof options.executors === 'object') ? options.executors : {};
  const customExecutor = executors?.[req.action.executor];
  if (typeof customExecutor === 'function') {
    const result = await customExecutor({
      request: req,
      step,
      args,
      context: (context && typeof context === 'object') ? context : {},
      executionOptions: options,
      mcpcore
    });
    const elapsedMs = Date.now() - startedAt;
    const actionResult = buildActionResultFromMcp({
      step,
      args,
      result,
      elapsedMs
    });
    return {
      ...(result && typeof result === 'object' ? result : {}),
      request: req,
      actionResult
    };
  }
  if (req.action.executor !== 'mcp') {
    return {
      success: false,
      code: 'UNSUPPORTED_EXECUTOR',
      provider: 'runtime_dispatch',
      error: {
        message: `Unsupported executor: ${req.action.executor || '(empty)'}`
      },
      request: req,
      actionResult: {
        ok: false,
        code: 'UNSUPPORTED_EXECUTOR',
        errorClass: 'arg_schema',
        retryable: false,
        action: {
          executor: req.action.executor || '',
          actionRef: req.action.actionRef || '',
          aiName: req.action.aiName || '',
          stepId: req.stepId || ''
        },
        status: {
          success: false,
          code: 'UNSUPPORTED_EXECUTOR',
          message: `Unsupported executor: ${req.action.executor || '(empty)'}`
        },
        input: { args },
        output: { provider: 'runtime_dispatch', data: null },
        evidence: [],
        artifacts: [],
        metrics: { elapsedMs: Date.now() - startedAt }
      }
    };
  }

  const safeContext = (context && typeof context === 'object') ? context : {};
  const result = await mcpcore.callByAIName(req.action.aiName, args, {
    ...safeContext,
    runId: req.runId,
    stepIndex: req.stepIndex
  });
  const elapsedMs = Date.now() - startedAt;
  const actionResult = buildActionResultFromMcp({
    step,
    args,
    result,
    elapsedMs
  });
  return {
    ...result,
    request: req,
    actionResult
  };
}

export default {
  dispatchActionRequest
};
