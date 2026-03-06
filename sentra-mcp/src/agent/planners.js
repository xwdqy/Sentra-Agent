import { v4 as uuidv4 } from 'uuid';
import { newStepId } from '../utils/stepIds.js';
import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../config/index.js';
import logger from '../logger/index.js';
import { chatCompletion } from '../openai/client.js';
import { HistoryStore } from '../history/store.js';
import { ok, fail } from '../utils/result.js';
import { summarizeToolHistory } from './summarizer.js';
import { clip } from '../utils/text.js';
import { buildPlanningManifest, manifestToBulletedText, buildToolContextSystem } from './plan/manifest.js';
import { buildDependentContextText } from './plan/history.js';
import { loadPrompt, renderTemplate, composeSystem } from './prompts/loader.js';
import { upsertToolMemory } from '../memory/index.js';
import { compactMessages, normalizeConversation } from './utils/messages.js';
import { emitRunEvent, wait, normKey } from './utils/events.js';
import { RunEvents } from '../bus/runEvents.js';
import { generatePlanViaFC } from './plan/plan_fc.js';
import { rerankManifest } from './plan/router.js';
import { getPreThought } from './stages/prethought.js';
import { generateToolArgs, validateArgs, fixToolArgs } from './stages/arggen.js';
import { evaluateRun } from './stages/evaluate.js';
import { checkTaskCompleteness } from './stages/reflection.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolDef } from './tools/loader.js';
import { createWorkspaceSnapshot, snapshotAndDiff } from './workspace/diff_engine.js';
import { upsertArtifact, getArtifactProjectRoot, getArtifactRootDir } from './workspace/registry.js';
import { cancelRun as markRunCancelled, isRunCancelled, clearRunCancelled } from '../bus/runCancel.js';
import { abortRunRequests } from '../bus/runAbort.js';
import { registerRunStart, markRunFinished, removeRun } from '../bus/runRegistry.js';
import { parseFunctionCalls, formatSentraResult } from '../utils/fc.js';
import { getRuntimeSignal } from '../utils/runtime_context.js';
import {
  TERMINAL_RUNTIME_AI_NAME,
  TERMINAL_RUNTIME_ACTION,
  getTerminalTaskArgSchema,
  pinTerminalRuntimeInManifest,
  isTerminalRuntimeStep
} from '../runtime/terminal/spec.js';
import {
  emitCancelledTerminalEvents,
  buildRuntimeSignalDecisionArtifacts,
  pollAndHandleRuntimeSignal,
  resolveRuntimeSignalAction,
  readLatestRuntimeUserSignal
} from './controllers/cancellation_controller.js';
import { waitForAssistantFeedbackBatches } from './controllers/feedback_controller.js';
import {
  normalizeEvalAction,
  runJudgeStage,
  runPlanStage,
  runEvaluateStage
} from './controllers/stage_runner.js';
import {
  applyDisplayIndex,
  sanitizeDependsOnStepIds,
  buildDependencyChain,
  formatReason,
  sanitizeContextForLog,
  buildExecutionGroupingState,
  buildGroupTopoOrder,
  buildDependsNoteForStep,
  buildDependsOnStepIdsForStep,
  buildDependedByStepIdsForStep
} from './controllers/execution_controller.js';
import {
  buildPlanSignature,
  buildResumeSeedFromCheckpoint
} from './controllers/resume_controller.js';
import {
  mapAndFilterPlanSteps,
  normalizePlanExecutor
} from './controllers/plan_step_controller.js';
import {
  dispatchActionRequest
} from './controllers/action_dispatch_controller.js';
import {
  normalizeActionOutcome
} from './controllers/action_result_controller.js';
import {
  buildActionRequest,
  createStepStateTracker
} from './controllers/run_kernel_controller.js';
import { evaluateStepMiniDecision } from './controllers/step_mini_eval_controller.js';
import {
  MINI_EVAL_DECISION,
  MINI_EVAL_REASON_CODE,
  NO_TOOL_REASON_CODE,
  RUNTIME_REASON_CODE,
  STEP_REASON_CODE,
  isMiniEvalRetryDecision,
  isMiniEvalStopDecision,
  isCooldownResultCode,
  miniEvalDecisionToReasonCode
} from './controllers/runtime_step_policy.js';
import { createGroupEventCoordinator } from './controllers/group_event_controller.js';
import {
  createRuntimeContext,
  emitRunStart,
  cleanupRuntimeRun,
  runFeedbackEvaluationRound
} from './controllers/runtime_orchestrator.js';
import {
  normalizePlanStepIds,
  injectConcurrencyOverlay,
  buildAdaptiveObjective,
  buildRuntimeAdaptiveObjective
} from './controllers/planning_controller.js';
import {
  claimRunExecutionEpoch,
  isRunExecutionEpochActive,
  releaseRunExecutionEpoch
} from './controllers/runtime_state_controller.js';
import {
  loadRuntimeRunCheckpointSnapshot,
  persistRuntimeCheckpoint,
  persistRuntimeRunFinal
} from './controllers/runtime_persistence_controller.js';

function now() { return Date.now(); }

const TERMINAL_TIMEOUT_RETRY_GUARD = Object.freeze({
  timeoutMsDefault: 35000,
  timeoutMsMax: 45000,
  maxOutputCharsDefault: 12000,
  maxOutputCharsMax: 20000,
  tailLinesDefault: 120,
  tailLinesMax: 200
});
const STEP_MINI_RETRY_ATTEMPT_LIMIT = 4;
const STEP_TIMEOUT_SAME_FINGERPRINT_LIMIT = 2;

function toBoundedInt(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.trunc(n);
  return Math.max(min, Math.min(max, clamped));
}

function isTimeoutLikeCode(value = '') {
  const text = String(value || '').trim().toUpperCase();
  return text === 'TIMEOUT' || text.includes('TIMEOUT');
}

function isTimeoutLikeFailureRecord(lastFailure = null) {
  const src = (lastFailure && typeof lastFailure === 'object') ? lastFailure : {};
  if (isTimeoutLikeCode(src.last_code)) return true;
  const msg = String(src.last_error || '').trim().toLowerCase();
  return msg.includes('timeout') || msg.includes('timed out');
}

function buildTerminalArgsFingerprint(args = {}) {
  const src = (args && typeof args === 'object') ? args : {};
  return [
    String(src.command || '').trim(),
    String(src.cwd || '').trim(),
    String(src.terminalType || '').trim().toLowerCase(),
    String(src.sessionMode || '').trim().toLowerCase(),
    String(src.timeoutMs ?? ''),
    String(src.maxOutputChars ?? ''),
    String(src.tailLines ?? '')
  ].join('|');
}

function applyTerminalTimeoutRetryGuards({ toolArgs = {}, retryState = {}, isSandboxStep = false } = {}) {
  const srcArgs = (toolArgs && typeof toolArgs === 'object') ? { ...toolArgs } : {};
  if (!isSandboxStep) return { args: srcArgs, applied: false, reasons: [] };
  const state = (retryState && typeof retryState === 'object') ? retryState : {};
  if (!isTimeoutLikeFailureRecord(state.lastFailure)) {
    return { args: srcArgs, applied: false, reasons: [] };
  }

  let applied = false;
  const reasons = [];

  const timeoutCurrent = toBoundedInt(srcArgs.timeoutMs, 0, 0, 900000);
  const timeoutNext = timeoutCurrent > 0
    ? Math.min(timeoutCurrent, TERMINAL_TIMEOUT_RETRY_GUARD.timeoutMsMax)
    : TERMINAL_TIMEOUT_RETRY_GUARD.timeoutMsDefault;
  if (timeoutCurrent !== timeoutNext) {
    srcArgs.timeoutMs = timeoutNext;
    applied = true;
    reasons.push('timeout_ms_bounded_for_retry');
  }

  const maxOutputCurrent = toBoundedInt(srcArgs.maxOutputChars, 0, 0, 2_000_000);
  const maxOutputNext = maxOutputCurrent > 0
    ? Math.min(maxOutputCurrent, TERMINAL_TIMEOUT_RETRY_GUARD.maxOutputCharsMax)
    : TERMINAL_TIMEOUT_RETRY_GUARD.maxOutputCharsDefault;
  if (maxOutputCurrent !== maxOutputNext) {
    srcArgs.maxOutputChars = maxOutputNext;
    applied = true;
    reasons.push('max_output_chars_bounded_for_retry');
  }

  const tailLinesCurrent = toBoundedInt(srcArgs.tailLines, 0, 0, 200000);
  const tailLinesNext = tailLinesCurrent > 0
    ? Math.min(tailLinesCurrent, TERMINAL_TIMEOUT_RETRY_GUARD.tailLinesMax)
    : TERMINAL_TIMEOUT_RETRY_GUARD.tailLinesDefault;
  if (tailLinesCurrent !== tailLinesNext) {
    srcArgs.tailLines = tailLinesNext;
    applied = true;
    reasons.push('tail_lines_bounded_for_retry');
  }

  return { args: srcArgs, applied, reasons };
}

function resolveRuntimeRunId(context = {}) {
  const ctx = (context && typeof context === 'object') ? context : {};
  const candidates = [
    ctx.resumeRunId,
    ctx.resume_run_id,
    ctx.runId,
    ctx.run_id
  ];
  for (const candidate of candidates) {
    const runId = String(candidate || '').trim();
    if (runId) return runId;
  }
  return uuidv4();
}

function isTerminalRuntimeStatus(statusLike) {
  const s = String(statusLike || '').trim().toLowerCase();
  return s === 'completed' || s === 'failed' || s === 'cancelled';
}

function resolveResumeCheckpointSignal(context = {}) {
  const ctx = (context && typeof context === 'object') ? context : {};
  const runtimeResume = (ctx.runtimeResume && typeof ctx.runtimeResume === 'object' && !Array.isArray(ctx.runtimeResume))
    ? ctx.runtimeResume
    : {};
  const fromCheckpoint = runtimeResume.fromCheckpoint === true
    || ctx.fromCheckpoint === true
    || ctx.runtime_resume_from_checkpoint === true;
  const runId = String(
    runtimeResume.runId
    || ctx.resumeRunId
    || ctx.resume_run_id
    || ctx.runId
    || ctx.run_id
    || ''
  ).trim();
  return {
    fromCheckpoint,
    runId,
    runtimeResume
  };
}

async function resolveResumePlanFromRuntimeCheckpoint({
  runId = '',
  context = {},
  normalizePlanFn = (x) => x
} = {}) {
  const rid = String(runId || '').trim();
  if (!rid) return { enabled: false, reason: 'resume_missing_run_id' };
  const signal = resolveResumeCheckpointSignal(context);
  if (!signal.fromCheckpoint) return { enabled: false, reason: 'resume_not_requested' };

  const checkpoint = await loadRuntimeRunCheckpointSnapshot({ runId: rid });
  if (!checkpoint || typeof checkpoint !== 'object') {
    return { enabled: false, reason: 'resume_checkpoint_not_found' };
  }
  if (isTerminalRuntimeStatus(checkpoint.status)) {
    return { enabled: false, reason: 'resume_checkpoint_terminal', checkpoint };
  }

  const persistedPlanRaw = await HistoryStore.getPlan(rid);
  if (!persistedPlanRaw || typeof persistedPlanRaw !== 'object') {
    return { enabled: false, reason: 'resume_plan_not_found', checkpoint };
  }
  const normalizedPlan = normalizePlanFn(persistedPlanRaw);
  if (!normalizedPlan || typeof normalizedPlan !== 'object' || isPlanEmpty(normalizedPlan)) {
    return { enabled: false, reason: 'resume_plan_empty', checkpoint };
  }

  const checkpointSignature = String(checkpoint.planSignature || '').trim();
  const planSignature = buildPlanSignature(normalizedPlan);
  if (checkpointSignature && checkpointSignature !== planSignature) {
    return {
      enabled: false,
      reason: 'resume_plan_signature_mismatch',
      checkpoint,
      checkpointSignature,
      planSignature
    };
  }

  const checkpointTotalSteps = Number(checkpoint.totalSteps || 0);
  const planTotalSteps = Number(normalizedPlan?.steps?.length || 0);
  if (checkpointTotalSteps > 0 && checkpointTotalSteps !== planTotalSteps) {
    return {
      enabled: false,
      reason: 'resume_plan_total_steps_mismatch',
      checkpoint,
      checkpointTotalSteps,
      planTotalSteps
    };
  }

  const lastCompletedStepIndex = Number.isFinite(Number(checkpoint.lastCompletedStepIndex))
    ? Number(checkpoint.lastCompletedStepIndex)
    : -1;
  const resumeCursorIndex = Math.max(0, lastCompletedStepIndex + 1);

  return {
    enabled: true,
    reason: 'resume_checkpoint_plan_loaded',
    checkpoint,
    plan: normalizedPlan,
    planSignature,
    checkpointSignature,
    resumeCursorIndex
  };
}

function normalizeEventPayload(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => normalizeEventPayload(item));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeEventPayload(v);
    }
    return out;
  }
  return value;
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeStringList(value, maxItems = 32) {
  const src = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of src) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function compactSkillDoc(skillDoc = null) {
  const src = (skillDoc && typeof skillDoc === 'object') ? skillDoc : null;
  if (!src) return null;
  return {
    path: String(src.path || '').trim(),
    whenToUse: normalizeStringList(src.whenToUse, 24),
    whenNotToUse: normalizeStringList(src.whenNotToUse, 24),
    successCriteria: normalizeStringList(src.successCriteria, 32)
  };
}

function collectStepSuccessCriteria(step = {}, manifestItem = null, currentToolFull = null) {
  const own = normalizeStringList(step?.successCriteria, 32);
  if (own.length > 0) return own;
  const fromManifest = normalizeStringList(manifestItem?.skillDoc?.successCriteria, 32);
  if (fromManifest.length > 0) return fromManifest;
  return normalizeStringList(currentToolFull?.skillDoc?.successCriteria, 32);
}

function buildStepToolContextSnapshot({
  aiName = '',
  executor = 'mcp',
  actionRef = '',
  manifestItem = null,
  currentToolFull = null,
  toolMeta = null
} = {}) {
  const manifest = (manifestItem && typeof manifestItem === 'object') ? manifestItem : {};
  const current = (currentToolFull && typeof currentToolFull === 'object') ? currentToolFull : {};
  const source = Object.keys(current).length > 0 ? current : manifest;
  const out = {
    aiName: String(aiName || source.aiName || '').trim(),
    name: String(source.name || '').trim(),
    provider: String(source.provider || '').trim(),
    executor: String(executor || source.executor || '').trim(),
    actionRef: String(actionRef || source.actionRef || '').trim(),
    description: String(source.description || '').trim(),
    inputSchema: (source.inputSchema && typeof source.inputSchema === 'object') ? source.inputSchema : {},
    meta: (toolMeta && typeof toolMeta === 'object')
      ? toolMeta
      : ((source.meta && typeof source.meta === 'object') ? source.meta : {}),
    skillDoc: compactSkillDoc(source.skillDoc || manifest.skillDoc || null)
  };
  return normalizeEventPayload(out);
}

function shouldSkipSummaryByEval(evalObj) {
  return normalizeEvalAction(evalObj) === 'perfect';
}

function toBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null) return !!fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (!s) return !!fallback;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return !!fallback;
}

function resolveRuntimeControl(context = {}) {
  const ctx = (context && typeof context === 'object') ? context : {};
  const source =
    (ctx.runtimeControl && typeof ctx.runtimeControl === 'object')
      ? ctx.runtimeControl
      : ((ctx.mcpRuntimeControl && typeof ctx.mcpRuntimeControl === 'object') ? ctx.mcpRuntimeControl : {});
  const singlePass = toBooleanFlag(source.singlePass, false);
  const skipEvaluation = toBooleanFlag(source.skipEvaluation, false);
  return {
    enabled: singlePass || skipEvaluation || toBooleanFlag(source.skipSummary, false),
    singlePass,
    skipEvaluation,
    skipSummary: toBooleanFlag(source.skipSummary, false) || skipEvaluation,
    disableAdaptive: toBooleanFlag(source.disableAdaptive, false) || singlePass || skipEvaluation,
    disablePlanRepair: toBooleanFlag(source.disablePlanRepair, false) || singlePass || skipEvaluation,
    disableArgFixRetry: toBooleanFlag(source.disableArgFixRetry, false) || singlePass,
    reason: String(source.reason || '').trim()
  };
}

function buildSkippedEvalResult(reason = '') {
  const why = String(reason || '').trim() || 'runtime_control_skip_evaluation';
  return {
    success: false,
    incomplete: true,
    nextAction: 'replan',
    completionLevel: 'poor',
    summary: `Evaluation skipped: ${why}`,
    skipped: true,
    reasonCode: why
  };
}

function isPlanEmpty(plan) {
  return !Array.isArray(plan?.steps) || plan.steps.length === 0;
}

function buildNoToolsResultGroupEvent({
  reasonCode = NO_TOOL_REASON_CODE.defaultNoInvocation,
  reason = '',
  summary = ''
} = {}) {
  const stepId = 'no_tool_invocation';
  const reasonText = String(reason || '').trim() || String(reasonCode || NO_TOOL_REASON_CODE.defaultNoInvocation);
  const summaryText = String(summary || '').trim();
  const data = {
    no_tool_call: true,
    reason_code: String(reasonCode || NO_TOOL_REASON_CODE.defaultNoInvocation)
  };
  if (summaryText) data.summary = summaryText;

  return {
    type: 'tool_result_group',
    groupId: 'runtime_no_tools',
    groupSize: 1,
    orderStepIds: [stepId],
    events: [{
      type: 'tool_result',
      stepId,
      plannedStepIndex: 0,
      stepIndex: 0,
      aiName: 'runtime__no_tool_call',
      reason: [reasonText],
      result: {
        success: true,
        code: 'NO_TOOL_CALL',
        provider: 'runtime',
        data
      }
    }],
    resultStream: true,
    resultStatus: 'final',
    groupFlushed: true
  };
}

function buildToolGateEvent({
  judge = null,
  manifest = []
} = {}) {
  const list = Array.isArray(manifest) ? manifest : [];
  const allToolNames = list
    .map((m) => String(m?.aiName || '').trim())
    .filter(Boolean);
  const gateToolNames = Array.isArray(judge?.toolNames)
    ? judge.toolNames.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const selectedSet = new Set(gateToolNames);
  if (allToolNames.includes(TERMINAL_RUNTIME_AI_NAME)) {
    selectedSet.add(TERMINAL_RUNTIME_AI_NAME);
  }
  const selectedTools = allToolNames.filter((name) => selectedSet.has(name));
  const skippedTools = allToolNames.filter((name) => !selectedSet.has(name));
  return {
    type: 'tool_gate',
    ok: judge?.ok !== false,
    need: judge?.need === true,
    forced: judge?.forced === true,
    summary: String(judge?.summary || '').trim(),
    selectedCount: selectedTools.length,
    totalCount: allToolNames.length,
    selectedTools,
    skippedCount: skippedTools.length
  };
}

async function buildJudgeManifestWithPrefilter({
  objective,
  baseManifest,
  context = {}
} = {}) {
  let manifest = pinTerminalRuntimeInManifest(
    Array.isArray(baseManifest) ? baseManifest : [],
    { insertIfMissing: true }
  );
  if (!String(objective || '').trim() || config.rerank?.enable === false) {
    return manifest;
  }
  const externalReasons = Array.isArray(context?.externalReasons)
    ? context.externalReasons
      .map((x) => String(x || '').trim())
      .filter(Boolean)
    : [];
  try {
    const ranked = await rerankManifest({
      manifest,
      objective,
      externalReasons
    });
    if (Array.isArray(ranked?.manifest) && ranked.manifest.length > 0) {
      manifest = pinTerminalRuntimeInManifest(ranked.manifest, { insertIfMissing: true });
    }
  } catch (e) {
    logger.warn?.('Judge prefilter rerank failed (ignored)', {
      label: 'RERANK',
      error: String(e)
    });
  }
  return manifest;
}



async function generateSingleNativePlan({ messages, tools, allowedAiNames, temperature, model }) {
  const res = await chatCompletion({
    messages,
    tools,
    tool_choice: { type: 'function', function: { name: 'emit_plan' } },
    temperature,
    timeoutMs: getStageTimeoutMs('plan'),
    model,
  });
  const call = res.choices?.[0]?.message?.tool_calls?.[0];
  let parsed; try { parsed = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { parsed = {}; }
  const stepsArr = Array.isArray(parsed?.steps) ? parsed.steps : [];
  const validNames = new Set(allowedAiNames || []);
  const steps = mapAndFilterPlanSteps(stepsArr, {
    allowedMcpAiNamesSet: validNames
  });
  const removedUnknown = steps.length < stepsArr.length;
  return { steps, removedUnknown, parsed };
}

async function selectBestNativePlan({ objective, manifest, candidates, context }) {
  try {
    const pa = await loadPrompt('plan_audit');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayAudit = overlays.audit?.system || overlays.plan_audit?.system || overlays.audit || overlays.plan_audit || '';
    const sys = composeSystem(pa.system, [overlayGlobal, overlayAudit].filter(Boolean).join('\n\n'));
    const manifestText = manifestToBulletedText(Array.isArray(manifest) ? manifest : []);
    const candidatesList = candidates.map((c, i) => `#${i}: ${clip(c.steps, 1200)}`).join('\n');
    const baseMsgs = compactMessages([
      { role: 'system', content: sys },
      { role: 'user', content: renderTemplate(pa.user_goal, { objective }) },
      { role: 'assistant', content: renderTemplate(pa.assistant_manifest, { manifestBulleted: manifestText }) },
      { role: 'user', content: renderTemplate(pa.user_candidates, { candidatesList }) },
      { role: 'user', content: pa.user_request },
    ]);

    if (!config.planner?.auditEnable) {
      return { index: 0, audit: 'audit disabled' };
    }

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const selectPlanTool = await loadToolDef({
      baseDir: __dirname,
      toolPath: './tools/internal/select_plan.tool.json',
      schemaPath: './tools/internal/select_plan.schema.json',
      fallbackTool: {
        type: 'function',
        function: {
          name: 'select_plan',
          description: 'Select the best plan from candidates and explain why.',
          parameters: { type: 'object', properties: {} }
        }
      },
      fallbackSchema: {
        type: 'object',
        properties: {
          best: { type: 'integer', minimum: 0 },
          reason: { type: 'string' }
        },
        required: ['best'],
        additionalProperties: true
      }
    });
    const tools = [selectPlanTool];
    const temperature = Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1);
    const res = await chatCompletion({
      messages: baseMsgs,
      tools,
      tool_choice: { type: 'function', function: { name: 'select_plan' } },
      temperature,
      timeoutMs: getStageTimeoutMs('plan')
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    let parsed; try { parsed = call?.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { parsed = {}; }
    let idx = Number(parsed?.best);
    let reason = String(parsed?.reason || '');
    if (!Number.isFinite(idx)) idx = 0;
    idx = Math.max(0, Math.min(candidates.length - 1, idx));
    return { index: idx, audit: reason };
  } catch (e) {
    logger.warn?.('Native selectBestPlan failed; fallback to candidate 0', { label: 'PLAN', error: String(e) });
    return { index: 0, audit: '' };
  }
}

function buildAdaptiveEvalContextForPlan(previousEval) {
  const ev = (previousEval && typeof previousEval === 'object') ? previousEval : null;
  if (!ev) return null;
  const missingGoals = Array.isArray(ev.missingGoals)
    ? ev.missingGoals.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const failedSteps = Array.isArray(ev.failedSteps)
    ? ev.failedSteps
      .map((x) => {
        const item = (x && typeof x === 'object') ? x : {};
        const stepId = String(item.stepId || '').trim();
        const aiName = String(item.aiName || '').trim();
        const reason = String(item.reason || '').trim();
        if (!stepId && !aiName && !reason) return null;
        const displayIndexRaw = Number(item.displayIndex);
        return {
          ...(stepId ? { stepId } : {}),
          ...(aiName ? { aiName } : {}),
          ...(Number.isFinite(displayIndexRaw) ? { displayIndex: Math.floor(displayIndexRaw) } : {}),
          ...(reason ? { reason } : {}),
        };
      })
      .filter(Boolean)
    : [];
  return {
    success: ev.success === true,
    incomplete: ev.incomplete === true,
    nextAction: String(ev.nextAction || '').trim().toLowerCase() || undefined,
    completionLevel: String(ev.completionLevel || '').trim().toLowerCase() || undefined,
    summary: String(ev.summary || '').trim(),
    missingGoals,
    failedSteps,
  };
}

function buildResultForAdaptiveHistory(item = {}) {
  const result = (item?.result && typeof item.result === 'object') ? item.result : {};
  const actionResult = (item?.actionResult && typeof item.actionResult === 'object') ? item.actionResult : {};
  const evidence = Array.isArray(actionResult?.evidence) && actionResult.evidence.length
    ? actionResult.evidence
    : (Array.isArray(result?.evidence) ? result.evidence : []);
  const out = {
    success: result.success === true,
    code: String(result.code || ''),
    provider: String(result.provider || actionResult?.output?.provider || '')
  };
  if (evidence.length > 0) {
    out.data = { evidence: evidence.slice(0, 6) };
  } else if (typeof result?.message === 'string' && result.message.trim()) {
    out.data = { message: result.message.trim().slice(0, 360) };
  }
  return out;
}

async function buildAdaptivePlanningMessages({ runId, context = {} }) {
  const roundRaw = Number(context?.adaptiveRound || 0);
  const adaptiveRound = Number.isFinite(roundRaw) ? Math.max(0, Math.floor(roundRaw)) : 0;
  const previousEvalCtx = buildAdaptiveEvalContextForPlan(context?.previousEval);
  if (adaptiveRound <= 0 && !previousEvalCtx) return [];

  const rid = String(runId || context?.runId || '').trim();
  let toolResults = [];
  let checkpointDiffIndex = {};
  if (rid) {
    try {
      const hist = await HistoryStore.list(rid, 0, -1);
      toolResults = (Array.isArray(hist) ? hist : []).filter((h) => h && h.type === 'tool_result');
    } catch (e) {
      logger.warn?.('Adaptive plan context failed to load tool_result history', {
        label: 'PLAN',
        runId: rid || 'unknown',
        error: String(e),
      });
    }
    try {
      const checkpoint = await loadRuntimeRunCheckpointSnapshot({ runId: rid });
      const fromCheckpoint = checkpoint?.lastWorkspaceDiffByStepKey;
      checkpointDiffIndex = (fromCheckpoint && typeof fromCheckpoint === 'object' && !Array.isArray(fromCheckpoint))
        ? fromCheckpoint
        : {};
    } catch (e) {
      logger.warn?.('Adaptive plan context failed to load checkpoint diff index', {
        label: 'PLAN',
        runId: rid || 'unknown',
        error: String(e),
      });
    }
  }

  const evalPayload = previousEvalCtx || {
    success: undefined,
    incomplete: undefined,
    nextAction: String(context?.adaptiveAction || '').trim().toLowerCase() || undefined,
    completionLevel: undefined,
    summary: '',
    missingGoals: [],
    failedSteps: [],
  };

  const messages = [];
  for (const h of toolResults) {
    const item = (h && typeof h === 'object') ? h : {};
    const xml = formatSentraResult({
      stepIndex: Number(item.plannedStepIndex ?? item.stepIndex ?? 0),
      stepId: item?.stepId,
      aiName: item.aiName,
      reason: item.reason,
      args: item.args || {},
      result: buildResultForAdaptiveHistory(item),
    });
    if (!String(xml || '').trim()) continue;
    messages.push({ role: 'user', content: xml });
    messages.push({
      role: 'assistant',
      content:
        `<sentra-message><chat_type>system_task</chat_type><message><segment index="1"><type>text</type><data><text>Recorded tool result for replanning context. step_id=${escapeXmlText(item?.stepId || '')}; tool=${escapeXmlText(item?.aiName || '')}.</text></data></segment></message></sentra-message>`
    });
  }

  const missingGoals = Array.isArray(evalPayload.missingGoals) ? evalPayload.missingGoals : [];
  const failedSteps = Array.isArray(evalPayload.failedSteps) ? evalPayload.failedSteps : [];
  const missingXml = missingGoals
    .map((g, idx) => `    <goal index="${idx + 1}">${escapeXmlText(g)}</goal>`)
    .join('\n');
  const failedXml = failedSteps
    .map((s, idx) => [
      `    <step index="${idx + 1}">`,
      `      <step_id>${escapeXmlText(s?.stepId || '')}</step_id>`,
      `      <ai_name>${escapeXmlText(s?.aiName || '')}</ai_name>`,
      `      <display_index>${escapeXmlText(s?.displayIndex ?? '')}</display_index>`,
      `      <reason>${escapeXmlText(s?.reason || '')}</reason>`,
      '    </step>'
    ].join('\n'))
    .join('\n');

  const evalXml = [
    '<sentra-adaptive-eval>',
    `  <run_id>${escapeXmlText(rid || 'unknown')}</run_id>`,
    `  <adaptive_round>${adaptiveRound}</adaptive_round>`,
    `  <success>${escapeXmlText(evalPayload.success ?? '')}</success>`,
    `  <incomplete>${escapeXmlText(evalPayload.incomplete ?? '')}</incomplete>`,
    `  <next_action>${escapeXmlText(evalPayload.nextAction || '')}</next_action>`,
    `  <completion_level>${escapeXmlText(evalPayload.completionLevel || '')}</completion_level>`,
    `  <summary>${escapeXmlText(evalPayload.summary || '')}</summary>`,
    '  <missing_goals>',
    missingXml,
    '  </missing_goals>',
    '  <failed_steps>',
    failedXml,
    '  </failed_steps>',
    '</sentra-adaptive-eval>',
    '<root>Replan from these result-history messages. Reuse already successful outputs. Fix failed steps by reason. Only add missing goals; do not repeat completed deliverables.</root>'
  ].join('\n');

  messages.push({ role: 'user', content: evalXml });
  const checkpointDiffRows = Object.entries(checkpointDiffIndex || {})
    .filter(([k, v]) => {
      if (!k) return false;
      return !!v && typeof v === 'object';
    })
    .slice(-48);
  if (checkpointDiffRows.length > 0) {
    const lines = [];
    lines.push('<sentra-workspace-diff-index>');
    lines.push(`  <run_id>${escapeXmlText(rid || 'unknown')}</run_id>`);
    lines.push('  <steps>');
    for (const [stepKey, value] of checkpointDiffRows) {
      const item = (value && typeof value === 'object') ? value : {};
      const summary = (item.summary && typeof item.summary === 'object') ? item.summary : {};
      const totalDelta = Number(summary.totalDelta || 0);
      const effect = String(item.effect || (totalDelta > 0 ? 'changed' : 'no_effect'));
      const stepId = String(item.stepId || '');
      const aiName = String(item.aiName || '');
      const comparedAt = Number(item.comparedAt || 0);
      const paths = Array.isArray(item.paths) ? item.paths.slice(0, 6) : [];
      lines.push(`    <step key="${escapeXmlText(stepKey)}" step_id="${escapeXmlText(stepId)}" ai_name="${escapeXmlText(aiName)}" effect="${escapeXmlText(effect)}" total_delta="${escapeXmlText(totalDelta)}" compared_at="${escapeXmlText(comparedAt)}">`);
      if (paths.length > 0) {
        lines.push('      <paths>');
        for (const p of paths) {
          lines.push(`        <path>${escapeXmlText(String(p || ''))}</path>`);
        }
        lines.push('      </paths>');
      }
      lines.push('    </step>');
    }
    lines.push('  </steps>');
    lines.push('</sentra-workspace-diff-index>');
    lines.push('<root>Use this checkpoint diff index to avoid replaying unchanged write steps during replan/resume.</root>');
    messages.push({ role: 'user', content: lines.join('\n') });
  }
  return compactMessages(messages);
}

export async function generatePlan(objective, mcpcore, context = {}, conversation) {
  const strategy = String(config.llm?.toolStrategy || 'auto');
  let removedUnknown = false;
  let parsed;
  if (strategy === 'fc') {
    return generatePlanViaFC(objective, mcpcore, context, conversation);
  }
  let manifest = pinTerminalRuntimeInManifest(buildPlanningManifest(mcpcore), { insertIfMissing: true });
  let rerankScoreByAiName = {};
  const externalReasons = Array.isArray(context?.externalReasons)
    ? context.externalReasons
      .map((x) => String(x || '').trim())
      .filter(Boolean)
    : [];

  const usePT = !!config.flags?.planUsePreThought;
  const preThought = usePT ? (await getPreThought(objective, manifest, conversation)) : '';

  try {
    if (objective && (config.rerank?.enable !== false)) {
      const ranked = await rerankManifest({
        manifest,
        objective,
        externalReasons
      });
      if (Array.isArray(ranked?.manifest) && ranked.manifest.length) {
        manifest = pinTerminalRuntimeInManifest(ranked.manifest, { insertIfMissing: true });
        if (Array.isArray(ranked?.details) && ranked.details.length) {
          rerankScoreByAiName = Object.fromEntries(
            ranked.details
              .filter((d) => d && typeof d.aiName === 'string' && d.aiName.trim())
              .map((d) => [String(d.aiName).trim(), {
                final: Number(d.final || 0),
                intent: Number(d.intent || 0),
                trust: Number(d.trust || 0),
                relevance: Number(d.relevance || 0),
                probability: Number(d.probability || 0),
                keywordHitRatio: Number(d.keywordHitRatio || 0),
                regexHitRatio: Number(d.regexHitRatio || 0),
                rank: Number(d.rank || 0)
              }])
          );
        }
        if (config.flags.enableVerboseSteps) {
          const tops = manifest.slice(0, Math.min(5, manifest.length)).map(x => x.aiName);
          logger.info('Plan rerank top tools', { label: 'RERANK', top: tops });
        }
      }
    }
  } catch (e) {
    logger.warn?.('Plan rerank failed (ignored)', { label: 'RERANK', error: String(e) });
  }

  const allowedAiNamesAll = (manifest || []).map((m) => m.aiName).filter(Boolean);
  const judgeToolNames = (context?.judge && Array.isArray(context.judge.toolNames))
    ? context.judge.toolNames
    : (Array.isArray(context?.judgeToolNames) ? context.judgeToolNames : []);

  const judgeToolSet = new Set((judgeToolNames || []).filter(Boolean));
  const reservedAiNames = new Set([TERMINAL_RUNTIME_AI_NAME]);
  const allowedByJudge = (judgeToolSet.size > 0)
    ? allowedAiNamesAll.filter((n) => judgeToolSet.has(n) || reservedAiNames.has(n))
    : [];
  const allowedAiNames = (judgeToolSet.size > 0 && allowedByJudge.length > 0)
    ? allowedByJudge
    : allowedAiNamesAll;

  if (judgeToolSet.size > 0) {
    const filtered = (manifest || []).filter((m) => m && m.aiName && (judgeToolSet.has(m.aiName) || reservedAiNames.has(m.aiName)));
    if (filtered.length > 0) {
      manifest = pinTerminalRuntimeInManifest(filtered, { insertIfMissing: true });
    }
  }
  manifest = pinTerminalRuntimeInManifest(manifest, { insertIfMissing: true });
  const validNames = new Set(allowedAiNames || []);

  // force LLM to emit a plan via function call (schema/tool loaded from JSON via loader)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const emitPlanTool = await loadToolDef({
    baseDir: __dirname,
    toolPath: './tools/internal/emit_plan.tool.json',
    schemaPath: './tools/internal/emit_plan.schema.json',
    mutateSchema: (schema) => {
      const aiNameProp = schema?.properties?.steps?.items?.properties?.aiName;
      if (aiNameProp && Array.isArray(allowedAiNames)) aiNameProp.enum = allowedAiNames;
    },
    fallbackTool: {
      type: 'function',
      function: {
        name: 'emit_plan',
        description: 'Emit a JSON plan with ordered tool steps. Each step contains one aiName and minimal draftArgs.',
        parameters: { type: 'object', properties: {} }
      }
    },
    fallbackSchema: {
      type: 'object',
      properties: {
        overview: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              aiName: { type: 'string' },
              executor: { type: 'string', enum: ['mcp', 'sandbox'] },
              actionRef: { type: 'string' }
            },
            anyOf: [
              { required: ['aiName'] },
              { required: ['executor', 'actionRef'] }
            ]
          }
        }
      },
      required: ['steps']
    },
  });
  const tools = [emitPlanTool];
  const ep = await loadPrompt('emit_plan');
  const overlays = (context?.promptOverlays || context?.overlays || {});
  const overlayGlobal = overlays.global?.system || overlays.global || '';
  const overlayPlan = overlays.plan?.system || overlays.emit_plan?.system || overlays.plan || overlays.emit_plan || '';
  const sys = [
    composeSystem(ep.system, [overlayGlobal, overlayPlan].filter(Boolean).join('\n\n')),
    ep.concurrency_hint || ''
  ].filter(Boolean).join('\n\n');
  const conv = normalizeConversation(conversation);
  const adaptivePlanningMsgs = await buildAdaptivePlanningMessages({ runId: context?.runId, context });
  const baseMessages = compactMessages([
    { role: 'system', content: sys },
    ...conv,
    { role: 'user', content: renderTemplate(ep.user_goal, { objective }) },
    ...(usePT ? [
      { role: 'assistant', content: renderTemplate(ep.assistant_thought, { preThought: preThought || '' }) },
    ] : []),
    { role: 'assistant', content: renderTemplate(ep.assistant_manifest, { manifestBulleted: manifestToBulletedText(manifest) }) },
    ...adaptivePlanningMsgs,
    { role: 'user', content: ep.user_request }
  ]);

  const planModelsRaw = Array.isArray(config.plan?.models) ? config.plan.models : [];
  const planModels = planModelsRaw.filter((m) => typeof m === 'string' && m.trim());
  const uniquePlanModels = Array.from(new Set(planModels)).slice(0, 5);
  const planModel = String(config.plan?.model || config.llm?.model || 'grok-4.1');

  const enableMulti = !!config.planner?.multiEnable && Number(config.planner?.multiCandidates || 0) > 1;
  let steps = [];
  if (enableMulti) {
    if (uniquePlanModels.length > 1) {
      const candidatesByModel = [];
      for (const m of uniquePlanModels) {
        try {
          const one = await generateSingleNativePlan({
            messages: baseMessages,
            tools,
            allowedAiNames,
            temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1),
            model: m,
          });
          if (Array.isArray(one?.steps) && one.steps.length > 0) {
            candidatesByModel.push({ steps: one.steps || [], removedUnknown: !!one.removedUnknown, parsed: one.parsed, model: m });
          }
        } catch { }
      }
      if (candidatesByModel.length === 0) {
        const one = await generateSingleNativePlan({ messages: baseMessages, tools, allowedAiNames, temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1), model: planModel });
        steps = one.steps || [];
        removedUnknown = !!one.removedUnknown;
        parsed = one.parsed;
      } else if (candidatesByModel.length === 1) {
        steps = candidatesByModel[0].steps || [];
        removedUnknown = !!candidatesByModel[0].removedUnknown;
        parsed = candidatesByModel[0].parsed;
      } else {
        const pick = await selectBestNativePlan({ objective, manifest, candidates: candidatesByModel, context });
        const idx = Math.max(0, Math.min(candidatesByModel.length - 1, Number(pick.index) || 0));
        const best = candidatesByModel[idx];
        steps = best.steps || [];
        removedUnknown = !!best.removedUnknown;
        parsed = best.parsed;
        if (config.flags.enableVerboseSteps) {
          logger.info('Native multi-model plan selected candidate', { label: 'PLAN', index: idx, model: best.model, audit: clip(String(pick.audit || ''), 360) });
        }
        try {
          if (context?.runId) {
            await HistoryStore.append(context.runId, { type: 'plan_audit', mode: 'native', candidates: candidatesByModel.length, chosenIndex: idx, chosenModel: best.model, reason: String(pick.audit || '') });
          }
        } catch { }
      }
    } else {
      const K = Math.max(2, Math.min(5, Number(config.planner.multiCandidates || 3)));
      const half = Math.ceil(K / 2);
      const minWait = Math.max(0, Number(config.planner?.candidateMinTimeoutMs ?? 3000));
      const maxWait = Math.max(minWait, Number(config.planner?.candidateMaxTimeoutMs ?? 25000));
      const factor = Number.isFinite(config.planner?.candidateTimeFactor) ? Number(config.planner.candidateTimeFactor) : 1.25;
      const extra = 1 + 0.25 * (K - half);
      const queue = [];
      const resolvers = [];
      function push(x) { const r = resolvers.shift(); if (r) r(x); else queue.push(x); }
      function next() { if (queue.length) return Promise.resolve(queue.shift()); return new Promise(res => resolvers.push(res)); }
      const startedAt = now();
      let finished = 0;
      const done = [];
      let deadline = 0;

      const tasks = [];
      for (let i = 0; i < K; i++) {
        const diversifyHint = `Diversified plan candidate #${i + 1}. Provide an executable plan that is meaningfully different from other candidates, with no more than ${Math.max(1, Number(config.planner?.maxSteps || 8))} steps.`;
        const msgs = compactMessages([...baseMessages, { role: 'user', content: diversifyHint }]);
        const t0 = now();
        const p = generateSingleNativePlan({ messages: msgs, tools, allowedAiNames, temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1 + Math.min(0.3, 0.03 * i)), model: planModel })
          .then((res) => ({ ok: true, res, i, ms: now() - t0 }))
          .catch(() => ({ ok: false, res: null, i, ms: now() - t0 }))
          .then((r) => { push(r); return r; });
        tasks.push(p);
      }

      while (finished < K) {
        let waiter;
        if (deadline > 0) {
          const remain = Math.max(0, deadline - now());
          waiter = Promise.race([next(), new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remain))]);
        } else {
          waiter = next();
        }
        const evt = await waiter;
        if (evt && evt.timeout) break;
        if (!evt) break;
        finished += 1;
        if (evt.ok && evt.res && Array.isArray(evt.res.steps) && evt.res.steps.length > 0) done.push(evt);
        if (done.length === half && deadline === 0) {
          const mean = done.reduce((s, x) => s + Number(x.ms || 0), 0) / Math.max(1, done.length);
          const waitMs = Math.max(minWait, Math.min(maxWait, mean * factor * extra));
          if (config.flags.enableVerboseSteps) {
            logger.info('Native multi-plan reached 50% completion; entering dynamic wait', { label: 'PLAN', K, half, meanMs: Math.round(mean), waitMs: Math.round(waitMs) });
          }
          deadline = now() + waitMs;
        }
      }

      const candidates = done
        .map((d) => ({ steps: Array.isArray(d.res.steps) ? d.res.steps : [], removedUnknown: !!d.res.removedUnknown, parsed: d.res.parsed }))
        .filter((c) => c.steps.length > 0);
      if (config.flags.enableVerboseSteps) {
        logger.info('Native multi-plan candidate count', { label: 'PLAN', count: candidates.length });
      }
      if (candidates.length === 0) {
        const one = await generateSingleNativePlan({ messages: baseMessages, tools, allowedAiNames, temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1), model: planModel });
        steps = one.steps || [];
        removedUnknown = !!one.removedUnknown;
        parsed = one.parsed;
      } else if (candidates.length === 1) {
        steps = candidates[0].steps || [];
        removedUnknown = !!candidates[0].removedUnknown;
        parsed = candidates[0].parsed;
      } else {
        const pick = await selectBestNativePlan({ objective, manifest, candidates, context });
        const idx = Math.max(0, Math.min(candidates.length - 1, Number(pick.index) || 0));
        steps = candidates[idx].steps || [];
        removedUnknown = !!candidates[idx].removedUnknown;
        parsed = candidates[idx].parsed;
        if (config.flags.enableVerboseSteps) {
          logger.info('Native multi-plan selected candidate', { label: 'PLAN', index: idx, audit: clip(String(pick.audit || ''), 360) });
        }
        try {
          if (context?.runId) {
            await HistoryStore.append(context.runId, { type: 'plan_audit', mode: 'native', candidates: candidates.length, chosenIndex: idx, reason: String(pick.audit || '') });
          }
        } catch { }
      }
    }
  } else {
    const isValid = (x) => Array.isArray(x?.steps) && x.steps.length > 0;
    const temperature = Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1);
    const t0 = now();
    if (config.flags.enableVerboseSteps) {
      logger.info('Native plan begin', { label: 'PLAN', mode: 'race2', model: planModel });
    }
    const tasks = [0, 1].map((i) => {
      const ti = now();
      return generateSingleNativePlan({ messages: baseMessages, tools, allowedAiNames, temperature, model: planModel })
        .then((res) => ({ ok: true, res, i, ms: now() - ti }))
        .catch((err) => ({ ok: false, res: null, i, ms: now() - ti, error: String(err || '') }));
    });

    let pick = await Promise.race(tasks);
    if (!pick?.ok || !isValid(pick?.res)) {
      try {
        const other = await tasks[1 - (Number(pick?.i) || 0)];
        if (other?.ok && isValid(other?.res)) {
          pick = other;
        }
      } catch { }
    }

    const one = pick?.ok ? (pick?.res || {}) : {};
    if (config.flags.enableVerboseSteps) {
      logger.info('Native plan end', {
        label: 'PLAN',
        mode: 'race2',
        model: planModel,
        ms: now() - t0,
        picked: Number.isInteger(pick?.i) ? pick.i : -1,
        pickedMs: Number.isFinite(pick?.ms) ? pick.ms : -1,
        steps: Array.isArray(one?.steps) ? one.steps.length : 0,
      });
    }
    steps = one.steps || [];
    removedUnknown = !!one.removedUnknown;
    parsed = one.parsed;
  }
  // Auto fallback to function_call planning when native tool-call produced empty plan
  if (strategy === 'auto' && steps.length === 0) {
    try {
      const alt = await generatePlanViaFC(objective, mcpcore, context, conversation);
      if (Array.isArray(alt?.steps) && alt.steps.length) {
        steps = alt.steps;
      }
    } catch (e) {
      logger.warn?.('FC plan fallback failed', { label: 'PLAN', error: String(e) });
    }
  }

  if (steps.length === 0 || removedUnknown) {
    try {
      if (config.flags.enableVerboseSteps) {
        const allSteps = Array.isArray(parsed?.steps)
          ? parsed.steps
          : [];
        const dropped = allSteps.filter((s) => !validNames.has(s?.aiName)).map((s) => s?.aiName);
        logger.warn?.('Trigger strict replan: previous plan had unknown tools or empty steps', { label: 'PLAN', dropped, allowedAiNames });
      }
      const replanMessages2 = compactMessages([
        { role: 'system', content: sys },
        { role: 'user', content: renderTemplate(ep.user_goal, { objective }) },
        ...(usePT ? [
          { role: 'assistant', content: renderTemplate(ep.assistant_thought, { preThought: preThought || '' }) },
        ] : []),
        { role: 'assistant', content: renderTemplate(ep.assistant_manifest, { manifestBulleted: manifestToBulletedText(manifest) }) },
        ...adaptivePlanningMsgs,
        { role: 'assistant', content: 'The previous plan used unknown or invalid aiName values. Rebuild the plan and choose aiName strictly from this allowed list:\n' + (allowedAiNames.join(', ')) },
        { role: 'user', content: ep.user_request }
      ]);
      const re2 = await chatCompletion({
        messages: replanMessages2,
        tools,
        tool_choice: { type: 'function', function: { name: 'emit_plan' } },
        temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1),
        timeoutMs: getStageTimeoutMs('plan'),
        model: planModel
      });
      const rcall2 = re2.choices?.[0]?.message?.tool_calls?.[0];
      let reparsed2; try { reparsed2 = rcall2?.function?.arguments ? JSON.parse(rcall2.function.arguments) : {}; } catch { reparsed2 = {}; }
      const stepsArr2 = Array.isArray(reparsed2?.steps) ? reparsed2.steps : [];
      steps = mapAndFilterPlanSteps(stepsArr2, {
        allowedMcpAiNamesSet: validNames
      });
    } catch (e) {
      logger.warn?.('Strict replan failed (ignored)', { label: 'PLAN', error: String(e) });
    }
  }

  const validateDependsOnStepIds = (arr) => {
    const stepIdToIndex = new Map((arr || []).map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId.trim() : '', idx]).filter(([k]) => k));
    let invalid = false;
    for (let i = 0; i < (arr || []).length; i++) {
      const s = arr[i] || {};
      const sid = typeof s?.stepId === 'string' ? s.stepId.trim() : '';
      const raw = Array.isArray(s?.dependsOnStepIds) ? s.dependsOnStepIds : [];
      const cleaned = [];
      for (const d of raw) {
        const depId = typeof d === 'string' ? d.trim() : '';
        if (!depId) { invalid = true; continue; }
        if (depId === sid) { invalid = true; continue; }
        const di = stepIdToIndex.get(depId);
        if (!Number.isInteger(di)) { invalid = true; continue; }
        if (di >= i) { invalid = true; continue; }
        cleaned.push(depId);
      }
      const uniq = Array.from(new Set(cleaned));
      s.dependsOnStepIds = uniq.length ? uniq : undefined;
    }
    return { ok: !invalid, invalidRefs: invalid };
  };

  let vres = validateDependsOnStepIds(steps);
  if (!vres.ok) {
    logger.warn?.('Plan dependsOnStepIds validation failed; attempting strict replan', { label: 'PLAN', invalidRefs: vres.invalidRefs });
    const replanMessages = compactMessages([
      { role: 'system', content: sys },
      { role: 'user', content: renderTemplate(ep.user_goal, { objective }) },
      ...(usePT ? [
        { role: 'assistant', content: renderTemplate(ep.assistant_thought, { preThought: preThought || '' }) },
      ] : []),
      { role: 'assistant', content: renderTemplate(ep.assistant_manifest, { manifestBulleted: manifestToBulletedText(manifest) }) },
      ...adaptivePlanningMsgs,
      {
        role: 'assistant',
        content:
          'The previous plan has invalid dependsOnStepIds references. Regenerate the plan with strict constraints: ' +
          '1) each dependsOnStepIds entry must reference only earlier steps by stepId; ' +
          '2) no self-dependency; ' +
          '3) omit dependsOnStepIds when not needed; ' +
          '4) every step must include a unique stepId; ' +
          '5) output only required fields and match the emit_plan JSON schema.'
      },
      { role: 'user', content: ep.user_request }
    ]);
    const re = await chatCompletion({
      messages: replanMessages,
      tools,
      tool_choice: { type: 'function', function: { name: 'emit_plan' } },
      temperature: Math.max(0.1, (config.llm.temperature ?? 0.2) - 0.1),
      timeoutMs: getStageTimeoutMs('plan'),
      model: planModel
    });
    const rcall = re.choices?.[0]?.message?.tool_calls?.[0];
    let reparsed; try { reparsed = rcall?.function?.arguments ? JSON.parse(rcall.function.arguments) : {}; } catch { reparsed = {}; }
    const stepsArr = Array.isArray(reparsed?.steps) ? reparsed.steps : [];
    let rsteps = mapAndFilterPlanSteps(stepsArr, {
      allowedMcpAiNamesSet: validNames
    });
    const v2 = validateDependsOnStepIds(rsteps);
    if (v2.ok) {
      steps = rsteps;
      logger.info('Strict replan succeeded and dependency validation passed', { label: 'PLAN', steps: steps.length });
    } else {
      logger.warn?.('Strict replan still invalid; clearing dependsOnStepIds as fallback', { label: 'PLAN' });
      steps = (steps || []).map((s) => ({ ...s, dependsOnStepIds: undefined }));
    }
  }

  if (config.flags.enableVerboseSteps) {
    logger.info(`Plan generated: ${steps.length} steps`, { label: 'PLAN', stepsPreview: clip(steps) });
  }

  return { manifest, steps, rerankScoreByAiName };
}

export async function executePlan(runId, objective, mcpcore, plan, opts = {}) {
  const runIdText = String(runId || '').trim();
  const executeEpoch = claimRunExecutionEpoch(runIdText);
  let executionClosed = false;
  const hardStopActionSet = new Set(['cancel', 'replan']);
  const isExecutionActive = () => !executionClosed && isRunExecutionEpochActive(runIdText, executeEpoch);
  const isHardStopAction = (action) => hardStopActionSet.has(String(action || '').trim().toLowerCase());
  const isHardStopRequestedByDirective = () => isHardStopAction(runtimeDirective?.action);

  // We'll build a per-step tool schema to reduce ambiguity
  const recentResults = Array.isArray(opts.seedRecent) ? [...opts.seedRecent] : [];
  const context = opts.context || {};
  const runtimeControl = resolveRuntimeControl(context);
  const requestedStartIndex = Math.max(0, Number(opts.startIndex) || 0);
  const retrySteps = Array.isArray(opts.retrySteps) ? new Set(opts.retrySteps.map(Number)) : null;
  const planSignature = buildPlanSignature(plan);
  const resumeSeed = await buildResumeSeedFromCheckpoint({
    runId,
    plan,
    startIndex: requestedStartIndex,
    retrySteps
  });
  const resumeApplied = !!(resumeSeed && resumeSeed.enabled === true);
  const startIndex = requestedStartIndex;
  const plannedTotalSteps = Math.max(0, Number(plan?.steps?.length || 0));
  let schedulerStartIndex = startIndex;
  if (resumeApplied) {
    const seedCursor = Number(resumeSeed?.resumeCursorIndex);
    if (Number.isInteger(seedCursor) && seedCursor >= startIndex && seedCursor < plannedTotalSteps) {
      schedulerStartIndex = seedCursor;
    }
  }
  const stepRetryState = new Map(); // stepIndex -> { attempts, sameRetries, regenRetries, forceRegenerate, lastFailure }
  let stopRequested = false;
  let hardStopRequested = false;
  const used = resumeApplied && Array.isArray(resumeSeed.usedEntries)
    ? [...resumeSeed.usedEntries]
    : [];
  let succeeded = resumeApplied
    ? Math.max(0, Number(resumeSeed.succeeded || 0))
    : 0;
  const conv = normalizeConversation(opts.conversation);
  let runtimeSignalCursorTs = Math.max(
    Number(opts.runtimeSignalCursorTs || 0),
    resumeApplied ? Number(resumeSeed.runtimeSignalCursorTs || 0) : 0
  );
  let runtimeSignalGeneration = Math.max(
    Number(opts.runtimeSignalGeneration || 0),
    resumeApplied ? Number(resumeSeed.runtimeSignalGeneration || 0) : 0
  );
  let runtimeSignalSeq = Math.max(
    Number(opts.runtimeSignalSeq || 0),
    resumeApplied ? Number(resumeSeed.runtimeSignalSeq || 0) : 0
  );
  let runtimeDirective = null;
  let runtimeSignalPollChain = Promise.resolve();
  const canEmitLiveEvents = () => isExecutionActive() && !isRunCancelled(runId) && !hardStopRequested && !isHardStopRequestedByDirective();
  const canFlushBufferedEvents = () => isExecutionActive();
  const updateRuntimeCheckpoint = async (patch = {}, event = null) => {
    await persistRuntimeCheckpoint({
      runId,
      context,
      patch: {
        status: isRunCancelled(runId) ? 'cancelled' : 'running',
        stage: 'execute_plan',
        totalSteps: Number(plan?.steps?.length || 0),
        attempted: Number(used.length || 0),
        succeeded: Number(succeeded || 0),
        runtimeSignalCursorTs: Number(runtimeSignalCursorTs || 0),
        runtimeSignalGeneration: Number(runtimeSignalGeneration || 0),
        runtimeSignalSeq: Number(runtimeSignalSeq || 0),
        ...patch
      },
      event
    });
  };
  const checkpointStepRuntimeIndex = new Map();
  const MAX_CHECKPOINT_STEP_RUNTIME_INDEX = 512;
  const upsertCheckpointStepRuntime = (payload = {}) => {
    const src = (payload && typeof payload === 'object') ? payload : {};
    const stepIndexRaw = Number(src.stepIndex);
    const stepIndex = Number.isFinite(stepIndexRaw) ? Math.max(-1, Math.floor(stepIndexRaw)) : -1;
    const stepId = String(src.stepId || '').trim();
    const aiName = String(src.aiName || '').trim();
    const key = stepIndex >= 0
      ? String(stepIndex)
      : (stepId ? `id:${stepId}` : (aiName ? `ai:${aiName}` : ''));
    if (!key) return;
    const prev = checkpointStepRuntimeIndex.get(key) || {};
    const merged = {
      ...prev,
      stepIndex,
      stepId: stepId || String(prev.stepId || ''),
      aiName: aiName || String(prev.aiName || ''),
      executor: String(src.executor || prev.executor || '').trim(),
      state: String(src.state || prev.state || '').trim(),
      reasonCode: String(src.reasonCode || prev.reasonCode || '').trim(),
      resultCode: String(src.resultCode || prev.resultCode || '').trim(),
      attemptNo: Number.isFinite(Number(src.attemptNo))
        ? Math.max(0, Math.floor(Number(src.attemptNo)))
        : Math.max(0, Number(prev.attemptNo || 0)),
      executionIndex: Number.isFinite(Number(src.executionIndex))
        ? Math.floor(Number(src.executionIndex))
        : Number.isFinite(Number(prev.executionIndex)) ? Math.floor(Number(prev.executionIndex)) : -1,
      success: (typeof src.success === 'boolean') ? src.success : (typeof prev.success === 'boolean' ? prev.success : false),
      elapsedMs: Number.isFinite(Number(src.elapsedMs))
        ? Math.max(0, Math.floor(Number(src.elapsedMs)))
        : Math.max(0, Number(prev.elapsedMs || 0)),
      availableAt: Number.isFinite(Number(src.availableAt))
        ? Math.max(0, Math.floor(Number(src.availableAt)))
        : Math.max(0, Number(prev.availableAt || 0)),
      message: String(src.message || prev.message || '').trim(),
      updatedAt: now()
    };
    checkpointStepRuntimeIndex.set(key, merged);
    while (checkpointStepRuntimeIndex.size > MAX_CHECKPOINT_STEP_RUNTIME_INDEX) {
      const first = checkpointStepRuntimeIndex.keys().next();
      if (first?.done) break;
      checkpointStepRuntimeIndex.delete(first.value);
    }
  };
  const serializeCheckpointStepRuntimeIndex = () => {
    const out = {};
    for (const [k, v] of checkpointStepRuntimeIndex.entries()) {
      out[k] = v;
    }
    return out;
  };
  if (resumeApplied && resumeSeed?.stepRuntimeIndex && typeof resumeSeed.stepRuntimeIndex === 'object') {
    for (const [k, v] of Object.entries(resumeSeed.stepRuntimeIndex)) {
      if (!v || typeof v !== 'object') continue;
      checkpointStepRuntimeIndex.set(String(k), {
        ...(v || {}),
        updatedAt: Number.isFinite(Number(v.updatedAt)) ? Number(v.updatedAt) : now()
      });
      if (checkpointStepRuntimeIndex.size >= MAX_CHECKPOINT_STEP_RUNTIME_INDEX) break;
    }
  }
  const stepStateTracker = createStepStateTracker();
  const emitStepState = async ({
    stepIndex = -1,
    step = {},
    aiName = '',
    executor = '',
    actionRef = '',
    state = '',
    reasonCode = '',
    reason = '',
    attemptNo = 0,
    resultCode = ''
  } = {}) => {
    const ev = stepStateTracker.transition({
      runId,
      stepId: step?.stepId || '',
      stepIndex,
      aiName,
      executor,
      actionRef,
      nextState: state,
      reasonCode,
      reason,
      attemptNo,
      resultCode
    });
    if (!ev) return null;
    if (canEmitLiveEvents()) emitRunEvent(runId, ev);
    await HistoryStore.append(runId, ev);
    upsertCheckpointStepRuntime({
      stepIndex: Number.isFinite(Number(ev.stepIndex)) ? Number(ev.stepIndex) : -1,
      stepId: String(ev.stepId || ''),
      aiName: String(ev.aiName || ''),
      executor: String(ev.executor || ''),
      state: String(ev.to || ''),
      reasonCode: String(ev.reasonCode || ''),
      resultCode: String(ev.resultCode || ''),
      attemptNo: Number.isFinite(Number(ev.attemptNo)) ? Number(ev.attemptNo) : 0
    });
    await updateRuntimeCheckpoint({
      lastStepState: String(ev.to || ''),
      lastStepReasonCode: String(ev.reasonCode || ''),
      lastStepResultCode: String(ev.resultCode || ''),
      lastCompletedStepId: String(ev.stepId || ''),
      lastCompletedStepIndex: Number.isFinite(Number(ev.stepIndex)) ? Number(ev.stepIndex) : -1,
      stepRuntimeIndex: serializeCheckpointStepRuntimeIndex()
    }, {
      type: 'runtime_step_state',
      stepIndex: Number.isFinite(Number(ev.stepIndex)) ? Number(ev.stepIndex) : -1,
      stepId: String(ev.stepId || ''),
      aiName: String(ev.aiName || ''),
      from: String(ev.from || ''),
      to: String(ev.to || ''),
      reasonCode: String(ev.reasonCode || ''),
      resultCode: String(ev.resultCode || '')
    });
    return ev;
  };
  const emitActionRequestEvent = async ({
    stepIndex = -1,
    executionIndex = -1,
    attemptNo = 0,
    step = {},
    aiName = '',
    executor = '',
    actionRef = '',
    args = {},
    reason = '',
    nextStep = '',
    dependsOnStepIds = [],
    dependedByStepIds = [],
    toolContext = null
  } = {}) => {
    const ev = buildActionRequest({
      runId,
      stepId: step?.stepId || '',
      stepIndex,
      executionIndex,
      attemptNo,
      aiName,
      executor,
      actionRef,
      args,
      objective,
      reason,
      nextStep,
      dependsOnStepIds,
      dependedByStepIds,
      toolContext
    });
    if (canEmitLiveEvents()) emitRunEvent(runId, ev);
    await HistoryStore.append(runId, ev);
    await updateRuntimeCheckpoint({
      lastActionRef: String(actionRef || ''),
      lastStepId: String(step?.stepId || ''),
      lastStepIndex: Number.isFinite(Number(stepIndex)) ? Number(stepIndex) : -1
    }, {
      type: 'runtime_action_request',
      stepIndex: Number.isFinite(Number(stepIndex)) ? Number(stepIndex) : -1,
      stepId: String(step?.stepId || ''),
      aiName: String(aiName || ''),
      actionRef: String(actionRef || ''),
      executor: String(executor || '')
    });
    return ev;
  };
  try {
  if (runtimeControl.enabled) {
    const runtimeControlEvent = {
      type: 'runtime_control',
      phase: 'execute_plan',
      reason: String(runtimeControl.reason || ''),
      singlePass: runtimeControl.singlePass === true,
      skipEvaluation: runtimeControl.skipEvaluation === true,
      skipSummary: runtimeControl.skipSummary === true,
      disableAdaptive: runtimeControl.disableAdaptive === true,
      disablePlanRepair: runtimeControl.disablePlanRepair === true,
      disableArgFixRetry: runtimeControl.disableArgFixRetry === true
    };
    if (canEmitLiveEvents()) emitRunEvent(runId, runtimeControlEvent);
    try { await HistoryStore.append(runId, runtimeControlEvent); } catch { }
  }
  await updateRuntimeCheckpoint({
    stage: 'execute_plan_start',
    status: 'running',
    startedAt: now(),
    retryMode: retrySteps ? '1' : '0',
    startIndex: Number(startIndex || 0),
    schedulerStartIndex: Number(schedulerStartIndex || 0),
    planSignature: String(planSignature || ''),
    resumeApplied: resumeApplied ? '1' : '0',
    resumedStepCount: resumeApplied && Array.isArray(resumeSeed.finishedIndices) ? resumeSeed.finishedIndices.length : 0,
    resumedUnfinishedStepCount: resumeApplied && Array.isArray(resumeSeed.unfinishedIndices) ? resumeSeed.unfinishedIndices.length : 0,
    resumeCursorIndex: resumeApplied ? Number(resumeSeed.resumeCursorIndex || -1) : -1,
    stepRuntimeIndex: serializeCheckpointStepRuntimeIndex()
  }, {
    type: 'runtime_checkpoint',
    phase: 'execute_plan_start',
    retryMode: retrySteps ? true : false,
    startIndex: Number(startIndex || 0),
    schedulerStartIndex: Number(schedulerStartIndex || 0),
    planSignature: String(planSignature || ''),
    resumeApplied: resumeApplied === true,
    resumedStepCount: resumeApplied && Array.isArray(resumeSeed.finishedIndices) ? resumeSeed.finishedIndices.length : 0,
    resumedUnfinishedStepCount: resumeApplied && Array.isArray(resumeSeed.unfinishedIndices) ? resumeSeed.unfinishedIndices.length : 0,
    resumeCursorIndex: resumeApplied ? Number(resumeSeed.resumeCursorIndex || -1) : -1
  });
  if (resumeApplied) {
    const resumedStepIds = (Array.isArray(resumeSeed.finishedIndices) ? resumeSeed.finishedIndices : [])
      .map((idx) => String(plan?.steps?.[idx]?.stepId || ''))
      .filter(Boolean);
    const resumeEvent = {
      type: 'resume_applied',
      runId,
      planSignature: String(planSignature || ''),
      resumedStepCount: Number(resumeSeed.finishedIndices?.length || 0),
      resumedStepIndices: Array.isArray(resumeSeed.finishedIndices) ? resumeSeed.finishedIndices : [],
      resumedUnfinishedStepCount: Number(resumeSeed.unfinishedIndices?.length || 0),
      resumedUnfinishedStepIndices: Array.isArray(resumeSeed.unfinishedIndices) ? resumeSeed.unfinishedIndices : [],
      resumeCursorIndex: Number(resumeSeed.resumeCursorIndex || -1),
      resumedStepIds,
      attempted: Number(resumeSeed.attempted || 0),
      succeeded: Number(resumeSeed.succeeded || 0),
      nextExecutionIndex: Number(resumeSeed.nextExecutionIndex || 0),
      checkpointStatus: String(resumeSeed.checkpointStatus || ''),
      checkpointStage: String(resumeSeed.checkpointStage || '')
    };
    if (canEmitLiveEvents()) emitRunEvent(runId, resumeEvent);
    await HistoryStore.append(runId, resumeEvent);
  }

  const stepStatus = new Map(); // stepIndex -> { success: boolean, reason: string }
  const rerankScoreByAiName = (plan?.rerankScoreByAiName && typeof plan.rerankScoreByAiName === 'object')
    ? plan.rerankScoreByAiName
    : {};

  let total = plan.steps.length;
  const maxConc = Math.max(1, Number(config.planner?.maxConcurrency ?? 3));
  const resumeFinished = new Set(
    resumeApplied && Array.isArray(resumeSeed.finishedIndices)
      ? resumeSeed.finishedIndices.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < total)
      : []
  );
  const resumeUnfinished = new Set(
    resumeApplied && Array.isArray(resumeSeed.unfinishedIndices)
      ? resumeSeed.unfinishedIndices.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < total)
      : []
  );
  const preFinalized = new Set(
    resumeApplied && Array.isArray(resumeSeed.preFinalizedIndices)
      ? resumeSeed.preFinalizedIndices.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < total)
      : []
  );
  const finished = new Set(resumeFinished);
  const started = new Set();
  const delayUntil = new Map(); // stepIndex -> epochMs when it becomes schedulable
  if (resumeApplied && resumeSeed?.retryAvailableByStep && typeof resumeSeed.retryAvailableByStep === 'object') {
    for (const [idxText, tsRaw] of Object.entries(resumeSeed.retryAvailableByStep)) {
      const idx = Number(idxText);
      const dueTs = Number(tsRaw);
      if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue;
      if (!(dueTs > 0)) continue;
      delayUntil.set(idx, Math.floor(dueTs));
    }
  }
  if (resumeApplied && resumeSeed?.stepStateByStepIndex && typeof resumeSeed.stepStateByStepIndex === 'object') {
    for (const [idxText, stateRaw] of Object.entries(resumeSeed.stepStateByStepIndex)) {
      const idx = Number(idxText);
      if (!Number.isInteger(idx) || idx < 0 || idx >= total) continue;
      if (resumeFinished.has(idx)) continue;
      const stateObj = (stateRaw && typeof stateRaw === 'object') ? stateRaw : {};
      const attemptNo = Math.max(0, Number(stateObj.attemptNo || 0));
      const lastCode = String(stateObj.resultCode || '').trim();
      const lastReasonCode = String(stateObj.reasonCode || '').trim();
      const lastState = String(stateObj.state || '').trim();
      stepRetryState.set(idx, {
        attempts: attemptNo,
        sameRetries: 0,
        regenRetries: 0,
        forceRegenerate: false,
        lastFailure: {
          attempt_no: attemptNo,
          last_args: {},
          last_error: `${lastReasonCode || lastState || 'resume_pending'}${lastCode ? `:${lastCode}` : ''}`,
          last_code: lastCode,
          evidence: []
        }
      });
      resumeUnfinished.add(idx);
    }
  }
  const runningByTool = new Map(); // aiName -> count
  const runningByProvider = new Map(); // providerKey -> count
  const firstPendingFromResume = (() => {
    if (!resumeApplied) return -1;
    const requested = Math.max(0, Number(requestedStartIndex || 0));
    const pending = Array.from(resumeUnfinished).filter((idx) => idx >= requested).sort((a, b) => a - b);
    if (pending.length > 0) return pending[0];
    const cursor = Number(resumeSeed?.resumeCursorIndex);
    if (Number.isInteger(cursor) && cursor >= requested && cursor < total) return cursor;
    return -1;
  })();
  schedulerStartIndex = firstPendingFromResume >= 0
    ? firstPendingFromResume
    : startIndex;

  let nextExecutionIndex = resumeApplied
    ? Math.max(0, Number(resumeSeed.nextExecutionIndex || 0))
    : 0;

  const toolList = mcpcore.getAvailableTools();
  const toolMeta = new Map(toolList.map((t) => [t.aiName, { provider: t.provider || 'local', executor: 'mcp' }]));
  for (const item of (Array.isArray(plan?.manifest) ? plan.manifest : [])) {
    if (!item || !item.aiName) continue;
    if (!toolMeta.has(item.aiName)) {
      toolMeta.set(item.aiName, {
        provider: item.provider || 'runtime',
        executor: normalizePlanExecutor(item.executor || (item.actionRef ? 'sandbox' : 'mcp'), 'mcp')
      });
    }
  }
  const toolMetaMap = new Map((mcpcore.getAvailableToolsDetailed?.() || []).map((t) => [t.aiName, t.meta || {}]));
  for (const item of (Array.isArray(plan?.manifest) ? plan.manifest : [])) {
    if (!item || !item.aiName) continue;
    if (!toolMetaMap.has(item.aiName)) {
      toolMetaMap.set(item.aiName, item.meta || {});
    }
  }
  const toolConcDefault = Math.max(1, Number(config.planner?.toolConcurrencyDefault || 1));
  const provConcDefault = Math.max(1, Number(config.planner?.providerConcurrencyDefault || 4));
  const toolOverride = config.planner?.toolConcurrency || {};
  const provOverride = config.planner?.providerConcurrency || {};
  const getToolLimit = (aiName) => Number(toolOverride[normKey(aiName)] ?? toolConcDefault);
  const getProvLimit = (provLabel) => Number(provOverride[normKey(provLabel)] ?? provConcDefault);

  let depsArr = [];
  let revDepsArr = [];
  let groupOf = [];
  let groups = [];
  let groupPending = new Map();
  let nextGroupToFlush = 0;
  const groupEventCoordinator = createGroupEventCoordinator({
    runId,
    emitRunEvent,
    canEmitLiveEvents,
    canFlushBufferedEvents,
    getGroupOf: () => groupOf,
    getGroups: () => groups,
    getGroupPending: () => groupPending,
    getNextGroupToFlush: () => nextGroupToFlush,
    setNextGroupToFlush: (v) => { nextGroupToFlush = Number(v) || 0; },
    getTopoOrderForGroup: (gid) => buildGroupTopoOrder({ gid, groups, depsArr, revDepsArr }),
    getStepIdForIndex: (idx) => {
      const sid = plan?.steps?.[idx]?.stepId;
      return (typeof sid === 'string' && sid.trim()) ? sid.trim() : ('step_' + idx);
    }
  });
  const artifactProjectRoot = getArtifactProjectRoot();
  const artifactSandboxRoot = getArtifactRootDir();
  const maxDiffArtifactsPerStep = Math.max(1, Number(config.runner?.artifactMaxDeltaFilesPerStep ?? 64));
  const maxDiffLogPaths = Math.max(1, Number(config.runner?.artifactDiffLogPaths ?? 12));
  let workspaceSnapshot = null;
  let workspaceDiffCaptureCount = 0;
  let workspaceDiffChangedCount = 0;
  let workspaceArtifactsUpserted = 0;
  let workspaceDiffCaptureChain = Promise.resolve(null);
  const workspaceDiffIndexByStepKey = new Map();
  const WORKSPACE_DIFF_INDEX_MAX_STEPS = 128;
  const buildWorkspaceDiffStepKey = ({ stepId = '', stepIndex = -1, aiName = '' } = {}) => {
    const sid = String(stepId || '').trim();
    if (sid) return `id:${sid}`;
    const idx = Number.isFinite(Number(stepIndex)) ? Math.floor(Number(stepIndex)) : -1;
    return `idx:${idx}:${String(aiName || '').trim()}`;
  };
  const upsertWorkspaceDiffCheckpointIndex = ({ stepIndex = -1, stepId = '', aiName = '', workspaceDiff = null } = {}) => {
    if (!workspaceDiff || typeof workspaceDiff !== 'object') return null;
    const summary = (workspaceDiff.summary && typeof workspaceDiff.summary === 'object')
      ? workspaceDiff.summary
      : { added: 0, changed: 0, removed: 0, unchanged: 0, totalDelta: 0 };
    const stepKey = buildWorkspaceDiffStepKey({ stepId, stepIndex, aiName });
    const entry = {
      stepIndex: Number.isFinite(Number(stepIndex)) ? Math.floor(Number(stepIndex)) : -1,
      stepId: String(stepId || '').trim(),
      aiName: String(aiName || '').trim(),
      comparedAt: Number(workspaceDiff.comparedAt || Date.now()),
      effect: Number(summary.totalDelta || 0) > 0 ? 'changed' : 'no_effect',
      summary: {
        added: Number(summary.added || 0),
        changed: Number(summary.changed || 0),
        removed: Number(summary.removed || 0),
        totalDelta: Number(summary.totalDelta || 0)
      },
      paths: Array.isArray(workspaceDiff.paths) ? workspaceDiff.paths.slice(0, maxDiffLogPaths) : []
    };
    workspaceDiffIndexByStepKey.set(stepKey, entry);
    while (workspaceDiffIndexByStepKey.size > WORKSPACE_DIFF_INDEX_MAX_STEPS) {
      const first = workspaceDiffIndexByStepKey.keys().next();
      if (!first?.done) workspaceDiffIndexByStepKey.delete(first.value);
      else break;
    }
    return {
      stepKey,
      entry,
      byStepKey: Object.fromEntries(workspaceDiffIndexByStepKey)
    };
  };
  const resolveDiffAbsPath = (rawPath, baseRoot) => {
    const normalized = String(rawPath || '').trim();
    if (!normalized) return '';
    const root = String(baseRoot || artifactSandboxRoot || artifactProjectRoot);
    const absPath = path.isAbsolute(normalized)
      ? path.resolve(normalized)
      : path.resolve(root, normalized.replace(/^[/\\]+/, ''));
    return absPath;
  };

  const buildDiffPathSample = (diffObj, limit = maxDiffLogPaths) => {
    const out = [];
    const baseRoot = String(diffObj?.rootDir || artifactSandboxRoot || artifactProjectRoot);
    const toPathForEvidence = (rawPath) => {
      const text = String(rawPath || '').trim();
      if (!text) return '';
      const asPosix = text.replace(/\\/g, '/');
      if (!path.isAbsolute(text)) return asPosix.replace(/^\/+/, '');
      const rel = path.relative(baseRoot, text).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..')) return asPosix;
      return rel.replace(/^\/+/, '');
    };
    const pushItem = (kind, rawPath) => {
      if (!rawPath || out.length >= limit) return;
      const resolved = resolveDiffAbsPath(rawPath, baseRoot);
      const evidencePath = toPathForEvidence(resolved || rawPath);
      if (!evidencePath) return;
      out.push(`${kind}:${evidencePath}`);
    };
    for (const it of (diffObj?.added || [])) pushItem('A', it?.relPath);
    for (const it of (diffObj?.changed || [])) pushItem('M', it?.relPath);
    for (const it of (diffObj?.removed || [])) pushItem('D', it?.relPath);
    return out;
  };

  const captureWorkspaceDiffArtifactsInner = async ({ stepIndex, stepId, aiName, usedEntry = null, error = '' } = {}) => {
    const sid = (typeof stepId === 'string' && stepId.trim()) ? stepId.trim() : `step_${Number(stepIndex)}`;
    let diff;
    try {
      const snap = await snapshotAndDiff({
        rootDir: artifactSandboxRoot,
        previousSnapshot: workspaceSnapshot
      });
      workspaceSnapshot = snap.nextSnapshot;
      diff = snap.diff;
    } catch (e) {
      logger.warn?.('workspace diff capture failed', {
        label: 'DIFF',
        runId,
        stepIndex,
        aiName,
        error: String(e)
      });
      return {
        stepIndex,
        stepId: sid,
        aiName: String(aiName || ''),
        summary: { added: 0, changed: 0, removed: 0, unchanged: 0, totalDelta: 0 },
        paths: [],
        comparedAt: Date.now(),
        rootDir: String(artifactSandboxRoot),
        captureError: String(e)
      };
    }

    const summary = diff?.summary || { added: 0, changed: 0, removed: 0, unchanged: 0, totalDelta: 0 };
    const deltaPaths = buildDiffPathSample(diff, maxDiffLogPaths);
    const totalDelta = Number(summary.totalDelta || 0);
    workspaceDiffCaptureCount += 1;
    if (totalDelta > 0) workspaceDiffChangedCount += 1;
    if (!(totalDelta > 0)) {
      return {
        stepIndex,
        stepId: sid,
        aiName: String(aiName || ''),
        summary,
        paths: deltaPaths,
        comparedAt: Number(diff?.comparedAt || Date.now()),
        rootDir: String(diff?.rootDir || artifactSandboxRoot)
      };
    }

    logger.info('workspace diff', {
      label: 'DIFF',
      runId,
      stepIndex,
      stepId: sid,
      aiName,
      added: summary.added,
      changed: summary.changed,
      removed: summary.removed,
      totalDelta: summary.totalDelta,
      paths: deltaPaths
    });

    const diffEvent = {
      type: 'workspace_diff',
      stepIndex,
      stepId: sid,
      aiName: String(aiName || ''),
      summary,
      paths: deltaPaths,
      comparedAt: Number(diff?.comparedAt || Date.now()),
      rootDir: String(diff?.rootDir || artifactSandboxRoot)
    };
    if (canEmitLiveEvents()) {
      emitRunEvent(runId, diffEvent);
    }
    try {
      await HistoryStore.append(runId, diffEvent);
    } catch (e) {
      logger.warn?.('workspace diff history append failed', {
        label: 'DIFF',
        runId,
        stepIndex,
        aiName,
        error: String(e)
      });
    }

    try {
      await upsertArtifact({
        runId,
        stepId: sid,
        type: 'workspace_diff',
        role: 'diff_summary',
        source: 'workspace_diff',
        dependsOn: [sid],
        summary: `workspace delta: +${Number(summary.added || 0)} ~${Number(summary.changed || 0)} -${Number(summary.removed || 0)}`,
        json: {
          stepIndex,
          stepId: sid,
          aiName: String(aiName || ''),
          summary,
          paths: deltaPaths,
          comparedAt: Number(diff?.comparedAt || Date.now()),
          usedEntry: usedEntry || null,
          error: String(error || '')
        }
      });
      workspaceArtifactsUpserted += 1;
    } catch (e) {
      logger.warn?.('workspace diff summary artifact upsert failed', {
        label: 'DIFF',
        runId,
        stepIndex,
        aiName,
        error: String(e)
      });
    }

    const diffRoot = String(diff?.rootDir || artifactSandboxRoot || artifactProjectRoot);
    const deltaItems = [
      ...(diff?.added || []).map((x) => ({ kind: 'added', path: resolveDiffAbsPath(x?.relPath, diffRoot), prev: null, next: x?.next || null })),
      ...(diff?.changed || []).map((x) => ({ kind: 'changed', path: resolveDiffAbsPath(x?.relPath, diffRoot), prev: x?.prev || null, next: x?.next || null })),
      ...(diff?.removed || []).map((x) => ({ kind: 'removed', path: resolveDiffAbsPath(x?.relPath, diffRoot), prev: x?.prev || null, next: null })),
    ];
    const bounded = deltaItems.slice(0, maxDiffArtifactsPerStep);
    for (const item of bounded) {
      if (!item?.path) continue;
      try {
        await upsertArtifact({
          runId,
          stepId: sid,
          type: 'workspace_file',
          role: `diff_${item.kind}`,
          source: 'workspace_diff',
          workspacePath: item.path,
          dependsOn: [sid],
          summary: `${item.kind}: ${item.path}`,
          metadata: {
            kind: item.kind,
            path: item.path,
            prevHash: String(item?.prev?.hash || ''),
            nextHash: String(item?.next?.hash || ''),
            prevSize: Number.isFinite(Number(item?.prev?.size)) ? Number(item.prev.size) : null,
            nextSize: Number.isFinite(Number(item?.next?.size)) ? Number(item.next.size) : null,
            comparedAt: Number(diff?.comparedAt || Date.now())
          }
        });
        workspaceArtifactsUpserted += 1;
      } catch (e) {
        logger.warn?.('workspace file artifact upsert failed', {
          label: 'DIFF',
          runId,
          stepIndex,
          stepId: sid,
          aiName,
          path: item.path,
          kind: item.kind,
          error: String(e)
        });
      }
    }
    return {
      stepIndex,
      stepId: sid,
      aiName: String(aiName || ''),
      summary,
      paths: deltaPaths,
      comparedAt: Number(diff?.comparedAt || Date.now()),
      rootDir: String(diff?.rootDir || artifactSandboxRoot)
    };
  };

  const captureWorkspaceDiffArtifacts = async (params = {}) => {
    const executeCapture = async () => captureWorkspaceDiffArtifactsInner(params);
    workspaceDiffCaptureChain = workspaceDiffCaptureChain.then(executeCapture, executeCapture);
    return workspaceDiffCaptureChain;
  };

  const pollRuntimeSignal = async ({ phase = 'loop', stepIndex = -1 } = {}) => {
    runtimeSignalPollChain = runtimeSignalPollChain.then(async () => {
      if (!isExecutionActive()) return;
      if (runtimeDirective || isRunCancelled(runId)) return;
      const prevCursorTs = Number(runtimeSignalCursorTs || 0);
      const prevGeneration = Number(runtimeSignalGeneration || 0);
      const prevSignalSeq = Number(runtimeSignalSeq || 0);
      const handled = await pollAndHandleRuntimeSignal({
        runId,
        objective,
        plan,
        context,
        phase,
        stepIndex,
        runtimeSignalCursorTs,
        runtimeSignalGeneration,
        runtimeSignalSeq,
        readLatestRuntimeUserSignal,
        resolveRuntimeSignalAction,
        buildRuntimeSignalDecisionArtifacts,
        emitRunEvent,
        appendHistory: (rid, ev) => HistoryStore.append(rid, ev),
        isExecutionActive,
        markRunCancelled,
        isHardStopAction,
        abortRunRequests
      });
      runtimeSignalCursorTs = handled.runtimeSignalCursorTs;
      runtimeSignalGeneration = Number(handled.runtimeSignalGeneration || runtimeSignalGeneration || 0);
      runtimeSignalSeq = Number(handled.runtimeSignalSeq || runtimeSignalSeq || 0);
      if (handled.runtimeDirective) {
        runtimeDirective = handled.runtimeDirective;
      }
      if (handled.hardStopRequested) {
        hardStopRequested = true;
      }
      if (handled.stopRequested) {
        stopRequested = true;
      }
      const signalProgressed =
        Number(runtimeSignalCursorTs || 0) !== prevCursorTs
        || Number(runtimeSignalGeneration || 0) !== prevGeneration
        || Number(runtimeSignalSeq || 0) !== prevSignalSeq;
      if (signalProgressed || handled.runtimeDirective || handled.hardStopRequested || handled.stopRequested) {
        await updateRuntimeCheckpoint({
          stage: 'runtime_signal',
          runtimeSignalCursorTs: Number(runtimeSignalCursorTs || 0),
          runtimeSignalGeneration: Number(runtimeSignalGeneration || 0),
          runtimeSignalSeq: Number(runtimeSignalSeq || 0),
          lastSignalAction: String(handled.runtimeDirective?.action || ''),
          lastSignalReason: String(handled.runtimeDirective?.reason || ''),
          lastSignalMessage: String(handled.runtimeDirective?.message || ''),
        }, {
          type: 'runtime_signal_checkpoint',
          phase,
          stepIndex,
          action: String(handled.runtimeDirective?.action || ''),
          stopRequested: handled.stopRequested === true,
          hardStopRequested: handled.hardStopRequested === true,
        });
      }
    }).catch((e) => {
      if (config.flags.enableVerboseSteps) {
        logger.warn?.('runtime signal polling failed', { label: 'RUN', runId, error: String(e) });
      }
    });
    await runtimeSignalPollChain;
    return runtimeDirective;
  };

  const rebuildGroupingState = () => {
    const grouping = buildExecutionGroupingState({ steps: plan.steps, finished });
    total = grouping.total;
    depsArr = grouping.depsArr;
    revDepsArr = grouping.revDepsArr;
    groupOf = grouping.groupOf;
    groups = grouping.groups;
    groupPending = grouping.groupPending;
    nextGroupToFlush = grouping.nextGroupToFlush;
    groupEventCoordinator.resetOnGroupingRebuild();
    for (const s of (plan.steps || [])) {
      sanitizeDependsOnStepIds(s, plan.steps);
    }
    applyDisplayIndex(plan.steps);
  };

  rebuildGroupingState();
  try {
    workspaceSnapshot = await createWorkspaceSnapshot({ rootDir: artifactSandboxRoot });
    logger.info('workspace baseline snapshot ready', {
      label: 'DIFF',
      runId,
      rootDir: workspaceSnapshot?.rootDir || artifactSandboxRoot,
      fileCount: Number(workspaceSnapshot?.fileCount || 0)
    });
    if (canEmitLiveEvents()) {
      const baselineEvent = {
        type: 'workspace_baseline',
        rootDir: workspaceSnapshot?.rootDir || artifactSandboxRoot,
        fileCount: Number(workspaceSnapshot?.fileCount || 0),
        createdAt: Number(workspaceSnapshot?.createdAt || Date.now())
      };
      emitRunEvent(runId, baselineEvent);
      try {
        await HistoryStore.append(runId, baselineEvent);
      } catch (e) {
        logger.warn?.('workspace baseline history append failed', { label: 'DIFF', runId, error: String(e) });
      }
    } else {
      try {
        await HistoryStore.append(runId, {
          type: 'workspace_baseline',
          rootDir: workspaceSnapshot?.rootDir || artifactSandboxRoot,
          fileCount: Number(workspaceSnapshot?.fileCount || 0),
          createdAt: Number(workspaceSnapshot?.createdAt || Date.now())
        });
      } catch (e) {
        logger.warn?.('workspace baseline history append failed', { label: 'DIFF', runId, error: String(e) });
      }
    }
  } catch (e) {
    logger.warn?.('workspace baseline snapshot failed', { label: 'DIFF', runId, error: String(e) });
  }

  const buildDependsNote = (i) => {
    return buildDependsNoteForStep({ stepIndex: i, steps: plan.steps, depsArr, revDepsArr });
  };

  const buildDependsOnStepIds = (i) => {
    return buildDependsOnStepIdsForStep({ stepIndex: i, steps: plan.steps });
  };

  const buildDependedByStepIds = (i) => {
    return buildDependedByStepIdsForStep({ stepIndex: i, steps: plan.steps, revDepsArr });
  };
  if (retrySteps) {
    for (let i = 0; i < total; i++) {
      if (!retrySteps.has(i)) {
        finished.add(i);
        const gid = groupOf[i];
        if (gid !== null && gid !== undefined && groupPending.has(gid)) {
          groupPending.set(gid, Math.max(0, (groupPending.get(gid) || 0) - 1));
        }
      }
    }
  } else {
    for (let i = 0; i < Math.min(startIndex, total); i++) finished.add(i);
    for (let i = 0; i < Math.min(startIndex, total); i++) {
      const gid = groupOf[i];
      if (gid !== null && gid !== undefined && groupPending.has(gid)) {
        groupPending.set(gid, Math.max(0, (groupPending.get(gid) || 0) - 1));
      }
    }
  }

  const executeSingleStep = async (i) => {
    if (!isExecutionActive()) return { stale: true };
    const step = plan.steps[i];
    const aiName = step.aiName;
    const manifestItem = plan.manifest?.find((m) => m.aiName === aiName);
    const stepExecutor = normalizePlanExecutor(
      step?.executor || manifestItem?.executor || (step?.actionRef ? 'sandbox' : 'mcp'),
      'mcp'
    );
    const stepActionRef = String(step?.actionRef || manifestItem?.actionRef || '').trim().toLowerCase();
    const isSandboxStep = stepExecutor === 'sandbox';
    const draftArgs = step.draftArgs || {};
    const stepId = step?.stepId;
    const stepStart = now();
    const retryState = stepRetryState.get(i) || {
      attempts: 0,
      sameRetries: 0,
      regenRetries: 0,
      forceRegenerate: false,
      lastFailure: null
    };
    const forceRegenerateArgs = retryState.forceRegenerate === true;
    const attemptNo = Math.max(1, Number(retryState.attempts || 0) + 1);
    const stepToolMetaSeed = (toolMetaMap.get(aiName) && typeof toolMetaMap.get(aiName) === 'object')
      ? toolMetaMap.get(aiName)
      : (manifestItem?.meta || {});
    const stepToolContextBase = buildStepToolContextSnapshot({
      aiName,
      executor: stepExecutor,
      actionRef: stepActionRef,
      manifestItem,
      currentToolFull: null,
      toolMeta: stepToolMetaSeed
    });
    const buildStepUsedEntry = ({
      executionIndex = -1,
      elapsedMs = 0,
      success = false,
      code = ''
    } = {}) => ({
      aiName: String(aiName || ''),
      executor: String(stepExecutor || ''),
      stepId: String(stepId || ''),
      stepIndex: Number(i),
      executionIndex: Number.isFinite(Number(executionIndex)) ? Math.floor(Number(executionIndex)) : -1,
      attemptNo: Number(attemptNo || 0),
      elapsedMs: Number.isFinite(Number(elapsedMs)) ? Math.max(0, Math.floor(Number(elapsedMs))) : 0,
      success: success === true,
      code: String(code || '')
    });
    const syncCheckpointStepRuntime = ({
      executionIndex = -1,
      elapsedMs = 0,
      success = false,
      code = '',
      state = '',
      reasonCode = '',
      message = '',
      availableAt = 0
    } = {}) => {
      upsertCheckpointStepRuntime({
        stepIndex: Number(i),
        stepId: String(stepId || ''),
        aiName: String(aiName || ''),
        executor: String(stepExecutor || ''),
        state: String(state || '').trim(),
        reasonCode: String(reasonCode || '').trim(),
        resultCode: String(code || '').trim(),
        attemptNo: Number(attemptNo || 0),
        executionIndex: Number.isFinite(Number(executionIndex)) ? Math.floor(Number(executionIndex)) : -1,
        success: success === true,
        elapsedMs: Number.isFinite(Number(elapsedMs)) ? Math.max(0, Math.floor(Number(elapsedMs))) : 0,
        availableAt: Number.isFinite(Number(availableAt)) ? Math.max(0, Math.floor(Number(availableAt))) : 0,
        message: String(message || '').trim()
      });
    };
    await emitStepState({
      stepIndex: i,
      step,
      aiName,
      executor: stepExecutor,
      actionRef: stepActionRef,
      state: 'planned',
      reasonCode: STEP_REASON_CODE.stepReady,
      reason: 'step queued for execution',
      attemptNo
    });
    await emitStepState({
      stepIndex: i,
      step,
      aiName,
      executor: stepExecutor,
      actionRef: stepActionRef,
      state: 'running',
      reasonCode: STEP_REASON_CODE.stepDispatchStart,
      reason: 'dispatching action request',
      attemptNo
    });
    await pollRuntimeSignal({ phase: 'step_start', stepIndex: i });
    if (!isExecutionActive()) return { stale: true };

    if (isRunCancelled(runId)) {
      const elapsed = now() - stepStart;
      const depOnStepIds = buildDependsOnStepIds(i);
      const depByStepIds = buildDependedByStepIds(i);
      const gid = groupOf[i];
      const res = {
        success: false,
        code: 'RUN_CANCELLED',
        data: null,
        message: 'Run cancelled due to runtime signal or upstream request.'
      };
      const ev = {
        type: 'tool_result',
        plannedStepIndex: i,
        stepId,
        executionIndex: nextExecutionIndex++,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef || undefined,
        reason: formatReason(step.reason),
        nextStep: step.nextStep || '',
        result: normalizeEventPayload(res),
        elapsedMs: elapsed,
        dependsOnStepIds: depOnStepIds,
        dependedByStepIds: depByStepIds,
        dependsNote: buildDependsNote(i),
        groupId: (gid ?? null),
        groupSize: (gid != null && groups[gid]?.nodes?.length) ? groups[gid].nodes.length : 1,
        toolContext: stepToolContextBase,
        toolMeta: {},
      };
      groupEventCoordinator.emitToolResultGrouped(ev, i);
      if (canEmitLiveEvents()) await HistoryStore.append(runId, ev);
      syncCheckpointStepRuntime({
        executionIndex: ev.executionIndex,
        elapsedMs: elapsed,
        success: false,
        code: String(res.code || 'RUN_CANCELLED'),
        state: 'failed',
        reasonCode: STEP_REASON_CODE.runCancelled,
        message: String(res.message || '')
      });
      if (config.flags.enableVerboseSteps) {
        logger.info?.('Step skipped after run cancellation', { label: 'STEP', stepIndex: i, aiName });
      }
      if (retrySteps) {
        stepStatus.set(i, { success: false, reason: res.message });
      }
      await emitStepState({
        stepIndex: i,
        step,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef,
        state: 'failed',
        reasonCode: STEP_REASON_CODE.runCancelled,
        reason: String(res.message || 'run cancelled'),
        attemptNo,
        resultCode: String(res.code || 'RUN_CANCELLED')
      });
      return { usedEntry: buildStepUsedEntry({ executionIndex: ev.executionIndex, elapsedMs: elapsed, success: false, code: res.code }), succeeded: 0 };
    }


    if (runtimeDirective && (runtimeDirective.action === 'replan' || runtimeDirective.action === 'supplement')) {
      const elapsed = now() - stepStart;
      const depOnStepIds = buildDependsOnStepIds(i);
      const depByStepIds = buildDependedByStepIds(i);
      const gid = groupOf[i];
      const res = {
        success: false,
        code: 'RUN_REDIRECTED',
        data: null,
        message: `Run redirected by runtime signal (${runtimeDirective.action})`
      };
      const ev = {
        type: 'tool_result',
        plannedStepIndex: i,
        stepId,
        executionIndex: nextExecutionIndex++,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef || undefined,
        reason: formatReason(step.reason),
        nextStep: step.nextStep || '',
        result: normalizeEventPayload(res),
        elapsedMs: elapsed,
        dependsOnStepIds: depOnStepIds,
        dependedByStepIds: depByStepIds,
        dependsNote: buildDependsNote(i),
        groupId: (gid ?? null),
        groupSize: (gid != null && groups[gid]?.nodes?.length) ? groups[gid].nodes.length : 1,
        toolContext: stepToolContextBase,
        toolMeta: {},
      };
      groupEventCoordinator.emitToolResultGrouped(ev, i);
      if (canEmitLiveEvents()) await HistoryStore.append(runId, ev);
      syncCheckpointStepRuntime({
        executionIndex: ev.executionIndex,
        elapsedMs: elapsed,
        success: false,
        code: String(res.code || 'RUN_REDIRECTED'),
        state: 'replanned',
        reasonCode: STEP_REASON_CODE.runtimeRedirected,
        message: String(res.message || '')
      });
      if (retrySteps) {
        stepStatus.set(i, { success: false, reason: res.message });
      }
      await emitStepState({
        stepIndex: i,
        step,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef,
        state: 'replanned',
        reasonCode: STEP_REASON_CODE.runtimeRedirected,
        reason: String(res.message || ''),
        attemptNo,
        resultCode: String(res.code || 'RUN_REDIRECTED')
      });
      return { usedEntry: buildStepUsedEntry({ executionIndex: ev.executionIndex, elapsedMs: elapsed, success: false, code: res.code }), succeeded: 0 };
    }

    if (retrySteps) {
      const deps = depsArr[i] || [];
      const failedDeps = deps.filter((d) => {
        const status = stepStatus.get(Number(d));
        return status && !status.success;
      });

      if (failedDeps.length > 0) {
        const elapsed = now() - stepStart;
        const failedDepReasons = failedDeps.map(d => {
          const st = stepStatus.get(d);
          return `Step ${d} (${plan.steps[d]?.aiName}): ${st?.reason || 'failed'}`;
        }).join('; ');
        const res = {
          success: false,
          code: 'SKIP_UPSTREAM_FAILED',
          data: null,
          message: `Skipped due to failed upstream dependencies: ${failedDepReasons}`
        };

        stepStatus.set(i, { success: false, reason: res.message });

        const depOnStepIds = buildDependsOnStepIds(i);
        const depByStepIds = buildDependedByStepIds(i);
        const gid = groupOf[i];
        const ev = {
          type: 'tool_result',
          plannedStepIndex: i,
          stepId,
          executionIndex: nextExecutionIndex++,
          aiName,
          executor: stepExecutor,
          actionRef: stepActionRef || undefined,
          reason: formatReason(step.reason),
          nextStep: step.nextStep || '',
          result: normalizeEventPayload(res),
          elapsedMs: elapsed,
          dependsOnStepIds: depOnStepIds,
          dependedByStepIds: depByStepIds,
          dependsNote: buildDependsNote(i),
          groupId: (gid ?? null),
          groupSize: (gid != null && groups[gid]?.nodes?.length) ? groups[gid].nodes.length : 1,
          toolContext: stepToolContextBase,
        toolMeta: {},
        };
        groupEventCoordinator.emitToolResultGrouped(ev, i);
        if (canEmitLiveEvents()) await HistoryStore.append(runId, ev);
        syncCheckpointStepRuntime({
          executionIndex: ev.executionIndex,
          elapsedMs: elapsed,
          success: false,
          code: String(res.code || 'SKIP_UPSTREAM_FAILED'),
          state: 'failed',
          reasonCode: STEP_REASON_CODE.upstreamFailed,
          message: String(res.message || '')
        });

        if (config.flags.enableVerboseSteps) {
          logger.info('Skipped step due to failed upstream dependency', {
            label: 'STEP',
            stepIndex: i,
            aiName,
            failedDeps: failedDepReasons
          });
        }
        await emitStepState({
          stepIndex: i,
          step,
          aiName,
          executor: stepExecutor,
          actionRef: stepActionRef,
          state: 'failed',
          reasonCode: STEP_REASON_CODE.upstreamFailed,
          reason: String(res.message || ''),
          attemptNo,
          resultCode: String(res.code || 'SKIP_UPSTREAM_FAILED')
        });

        return { usedEntry: buildStepUsedEntry({ executionIndex: ev.executionIndex, elapsedMs: elapsed, success: false, code: res.code }), succeeded: 0 };
      }
    }

    if (!manifestItem && !isSandboxStep) {
      const elapsed = now() - stepStart;
      const res = { success: false, code: 'NOT_FOUND', data: null, message: `Unknown aiName: ${aiName}` };
      const depOnStepIds = buildDependsOnStepIds(i);
      const depByStepIds = buildDependedByStepIds(i);
      const gid = groupOf[i];
      const ev = {
        type: 'tool_result',
        plannedStepIndex: i,  // Original index inside the planner's step list.
        stepId,
        executionIndex: nextExecutionIndex++,  // Global execution order index across emitted tool results.
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef || undefined,
        reason: formatReason(step.reason),
        nextStep: step.nextStep || '',
        result: normalizeEventPayload(res),
        elapsedMs: elapsed,
        dependsOnStepIds: depOnStepIds,
        dependedByStepIds: depByStepIds,
        dependsNote: buildDependsNote(i),
        groupId: (gid ?? null),
        groupSize: (gid != null && groups[gid]?.nodes?.length) ? groups[gid].nodes.length : 1,
        toolContext: stepToolContextBase,
        toolMeta: {},
      };
      if (canEmitLiveEvents()) {
        groupEventCoordinator.emitToolResultGrouped(ev, i);
        await HistoryStore.append(runId, ev);
      }
      syncCheckpointStepRuntime({
        executionIndex: ev.executionIndex,
        elapsedMs: elapsed,
        success: false,
        code: String(res.code || 'NOT_FOUND'),
        state: 'failed',
        reasonCode: STEP_REASON_CODE.toolNotFound,
        message: String(res.message || '')
      });
      if (config.flags.enableVerboseSteps) logger.warn?.('Unknown tool step skipped', { label: 'STEP', aiName });
      await emitStepState({
        stepIndex: i,
        step,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef,
        state: 'failed',
        reasonCode: STEP_REASON_CODE.toolNotFound,
        reason: String(res.message || ''),
        attemptNo,
        resultCode: String(res.code || 'NOT_FOUND')
      });
      return { usedEntry: buildStepUsedEntry({ executionIndex: ev.executionIndex, elapsedMs: elapsed, success: res.success === true, code: res.code }), succeeded: 0 };
    }

    if (isSandboxStep && !isTerminalRuntimeStep({ ...step, aiName, actionRef: stepActionRef })) {
      const elapsed = now() - stepStart;
      const res = {
        success: false,
        code: 'UNSUPPORTED_SANDBOX_ACTION',
        data: null,
        message: `Unsupported sandbox action for step: ${stepActionRef || aiName || 'unknown'}`
      };
      const depOnStepIds = buildDependsOnStepIds(i);
      const depByStepIds = buildDependedByStepIds(i);
      const gid = groupOf[i];
      const ev = {
        type: 'tool_result',
        plannedStepIndex: i,
        stepId,
        executionIndex: nextExecutionIndex++,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef || undefined,
        reason: formatReason(step.reason),
        nextStep: step.nextStep || '',
        result: normalizeEventPayload(res),
        elapsedMs: elapsed,
        dependsOnStepIds: depOnStepIds,
        dependedByStepIds: depByStepIds,
        dependsNote: buildDependsNote(i),
        groupId: (gid ?? null),
        groupSize: (gid != null && groups[gid]?.nodes?.length) ? groups[gid].nodes.length : 1,
        toolContext: stepToolContextBase,
        toolMeta: {},
      };
      if (canEmitLiveEvents()) {
        groupEventCoordinator.emitToolResultGrouped(ev, i);
        await HistoryStore.append(runId, ev);
      }
      syncCheckpointStepRuntime({
        executionIndex: ev.executionIndex,
        elapsedMs: elapsed,
        success: false,
        code: String(res.code || 'UNSUPPORTED_SANDBOX_ACTION'),
        state: 'failed',
        reasonCode: STEP_REASON_CODE.unsupportedSandboxAction,
        message: String(res.message || '')
      });
      await emitStepState({
        stepIndex: i,
        step,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef,
        state: 'failed',
        reasonCode: STEP_REASON_CODE.unsupportedSandboxAction,
        reason: String(res.message || ''),
        attemptNo,
        resultCode: String(res.code || 'UNSUPPORTED_SANDBOX_ACTION')
      });
      return { usedEntry: buildStepUsedEntry({ executionIndex: ev.executionIndex, elapsedMs: elapsed, success: false, code: res.code }), succeeded: 0 };
    }

    const rerankProfileRaw = (aiName && Object.prototype.hasOwnProperty.call(rerankScoreByAiName, aiName))
      ? rerankScoreByAiName[aiName]
      : null;
    const rerankProfile = (rerankProfileRaw && typeof rerankProfileRaw === 'object')
      ? {
        final: Number(rerankProfileRaw.final || 0),
        intent: Number(rerankProfileRaw.intent || 0),
        trust: Number(rerankProfileRaw.trust || 0),
        relevance: Number(rerankProfileRaw.relevance || 0),
        probability: Number(rerankProfileRaw.probability || 0),
        keywordHitRatio: Number(rerankProfileRaw.keywordHitRatio || 0),
        regexHitRatio: Number(rerankProfileRaw.regexHitRatio || 0),
        rank: Number(rerankProfileRaw.rank || 0)
      }
      : null;
    if (config.flags.enableVerboseSteps) {
      logger.info(`Executing step ${i + 1}/${plan.steps.length}`, {
        label: 'STEP',
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef || undefined,
        reason: formatReason(step.reason),
        nextStep: step.nextStep || '',
        draftArgs: clip(draftArgs),
        rerankFinal: rerankProfile ? Number(rerankProfile.final.toFixed(2)) : undefined,
        rerankIntent: rerankProfile ? Number(rerankProfile.intent.toFixed(2)) : undefined,
        rerankTrust: rerankProfile ? Number(rerankProfile.trust.toFixed(2)) : undefined,
        rerankRelevance: rerankProfile ? Number(rerankProfile.relevance.toFixed(2)) : undefined,
        rerankProbability: rerankProfile ? Number(rerankProfile.probability.toFixed(4)) : undefined,
        rerankKeywordHitRatio: rerankProfile ? Number(rerankProfile.keywordHitRatio.toFixed(3)) : undefined,
        rerankRegexHitRatio: rerankProfile ? Number(rerankProfile.regexHitRatio.toFixed(3)) : undefined
      });
    }

    let currentToolFull;
    if (isSandboxStep) {
      currentToolFull = {
        aiName: aiName || TERMINAL_RUNTIME_AI_NAME,
        description: manifestItem?.description || 'Runtime sandbox terminal command execution.',
        inputSchema: manifestItem?.inputSchema || getTerminalTaskArgSchema(),
        provider: 'runtime',
        executor: 'sandbox',
        actionRef: stepActionRef || TERMINAL_RUNTIME_ACTION
      };
    } else {
      currentToolFull = mcpcore.getAvailableTools().find((t) => t.aiName === aiName) || {
        description: manifestItem?.description || '',
        inputSchema: manifestItem?.inputSchema || { type: 'object', properties: {} }
      };
    }
    const schema = currentToolFull.inputSchema || manifestItem?.inputSchema || { type: 'object', properties: {} };
    const stepToolContext = buildStepToolContextSnapshot({
      aiName,
      executor: stepExecutor,
      actionRef: stepActionRef,
      manifestItem,
      currentToolFull,
      toolMeta: (toolMetaMap.get(aiName) && typeof toolMetaMap.get(aiName) === 'object')
        ? toolMetaMap.get(aiName)
        : (manifestItem?.meta || currentToolFull?.meta || {})
    });

    const isRetryMode = retrySteps !== null;
    let toolArgs = draftArgs;
    let reused = false;
    try {
      const argsResult = await generateToolArgs({
        runId,
        stepIndex: i,
        objective,
        step,
        currentToolFull,
        manifestItem,
        conv,
        totalSteps: plan.steps.length,
        context,
        disableReuse: isRetryMode || forceRegenerateArgs,
        retryContext: retryState.lastFailure || null,
      });
      toolArgs = argsResult.toolArgs;
      reused = argsResult.reused;
    } catch (e) {
      if (canEmitLiveEvents()) {
        emitRunEvent(runId, { type: 'arggen_error', stepIndex: i, stepId, aiName, error: String(e) });
        await HistoryStore.append(runId, { type: 'arggen_error', stepIndex: i, stepId, aiName, error: String(e) });
      }
      logger.warn?.('Arg generation failed; fallback to draft args', { label: 'ARGGEN', aiName, error: String(e) });
    }
    retryState.forceRegenerate = false;

    const timeoutGuard = applyTerminalTimeoutRetryGuards({
      toolArgs,
      retryState,
      isSandboxStep
    });
    toolArgs = timeoutGuard.args;
    if (timeoutGuard.applied) {
      const ev = {
        type: 'arg_retry_guard_applied',
        stepIndex: i,
        plannedStepIndex: i,
        stepId,
        aiName,
        reasons: timeoutGuard.reasons,
        args: toolArgs
      };
      if (canEmitLiveEvents()) {
        emitRunEvent(runId, ev);
        await HistoryStore.append(runId, ev);
      }
      if (config.flags.enableVerboseSteps) {
        logger.info('Applied timeout retry arg guard for terminal step', {
          label: 'ARGGEN',
          stepIndex: i,
          stepId,
          aiName,
          reasons: timeoutGuard.reasons
        });
      }
    }

    let validateResult = await validateArgs({ schema, toolArgs, aiName });
    let ajvValid = validateResult.valid;
    let ajvErrors = validateResult.errors;
    toolArgs = validateResult.args;

    const maxArgFixRetries = runtimeControl.disableArgFixRetry ? 0 : 3;
    let argFixAttempt = 0;
    while (!ajvValid && argFixAttempt < maxArgFixRetries) {
      argFixAttempt += 1;
      const failedArgs = toolArgs;
      toolArgs = await fixToolArgs({
        runId,
        stepIndex: i,
        objective,
        step,
        currentToolFull,
        schema,
        ajvErrors,
        toolArgs: failedArgs,
        draftArgs: failedArgs,
        totalSteps: plan.steps.length,
        context
      });
      validateResult = await validateArgs({ schema, toolArgs, aiName });
      ajvValid = validateResult.valid;
      ajvErrors = validateResult.errors;
      toolArgs = validateResult.args;
    }
    const argValidationFailed = !ajvValid;
    if (argValidationFailed && canEmitLiveEvents()) {
      const argFailEv = {
        type: 'arg_validation_failed',
        stepIndex: i,
        plannedStepIndex: i,
        stepId,
        aiName,
        attempts: argFixAttempt,
        maxAttempts: maxArgFixRetries,
        errors: ajvErrors,
        args: toolArgs,
      };
      emitRunEvent(runId, argFailEv);
      await HistoryStore.append(runId, argFailEv);
    }

    try {
      const depOnStepIds = buildDependsOnStepIds(i);
      const depByStepIds = buildDependedByStepIds(i);
      const gidA = groupOf[i];
      const argsEv = {
        type: 'args',
        stepIndex: i,
        plannedStepIndex: i,
        stepId,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef || undefined,
        reason: formatReason(step.reason),
        nextStep: step.nextStep || '',
        args: toolArgs,
        reused,
        dependsOnStepIds: depOnStepIds,
        dependedByStepIds: depByStepIds,
        dependsNote: buildDependsNote(i),
        groupId: (gidA ?? null),
        groupSize: (gidA != null && groups[gidA]?.nodes?.length) ? groups[gidA].nodes.length : 1,
        toolContext: stepToolContext,
        toolMeta: (stepToolContext?.meta && typeof stepToolContext.meta === 'object') ? stepToolContext.meta : {},
      };
      if (canEmitLiveEvents()) {
        groupEventCoordinator.emitArgsGrouped(argsEv, i);
        await HistoryStore.append(runId, argsEv);
      }
    } catch { }
    await emitActionRequestEvent({
      stepIndex: i,
      executionIndex: nextExecutionIndex,
      attemptNo,
      step,
      aiName,
      executor: stepExecutor,
      actionRef: stepActionRef || (isSandboxStep ? TERMINAL_RUNTIME_ACTION : aiName),
      args: toolArgs,
      reason: formatReason(step.reason),
      nextStep: step.nextStep || '',
      dependsOnStepIds: buildDependsOnStepIds(i),
      dependedByStepIds: buildDependedByStepIds(i),
      toolContext: stepToolContext
    });

    let res;
    let elapsed;
    if (argValidationFailed) {
      res = {
        success: false,
        code: 'ARG_VALIDATION_FAILED',
        provider: 'system',
        data: {
          errors: ajvErrors || [],
          args: toolArgs,
          attempts: argFixAttempt,
          maxAttempts: maxArgFixRetries,
        },
      };
      elapsed = now() - stepStart;
    }

    if (!res) {
      await pollRuntimeSignal({ phase: 'before_tool_call', stepIndex: i });
      if (!isExecutionActive()) return { stale: true };
      if (hardStopRequested || isHardStopRequestedByDirective()) return { stale: true };
      if (isRunCancelled(runId)) {
        const elapsedCancelled = now() - stepStart;
        syncCheckpointStepRuntime({
          executionIndex: -1,
          elapsedMs: elapsedCancelled,
          success: false,
          code: 'RUN_CANCELLED',
          state: 'failed',
          reasonCode: STEP_REASON_CODE.runCancelled,
          message: 'run cancelled before action dispatch'
        });
        return { usedEntry: buildStepUsedEntry({ executionIndex: -1, elapsedMs: elapsedCancelled, success: false, code: 'RUN_CANCELLED' }), succeeded: 0 };
      }
      if (runtimeDirective && (runtimeDirective.action === 'replan' || runtimeDirective.action === 'supplement')) {
        const elapsedRedirected = now() - stepStart;
        syncCheckpointStepRuntime({
          executionIndex: -1,
          elapsedMs: elapsedRedirected,
          success: false,
          code: 'RUN_REDIRECTED',
          state: 'replanned',
          reasonCode: STEP_REASON_CODE.runtimeRedirected,
          message: `run redirected before action dispatch (${runtimeDirective.action})`
        });
        return { usedEntry: buildStepUsedEntry({ executionIndex: -1, elapsedMs: elapsedRedirected, success: false, code: 'RUN_REDIRECTED' }), succeeded: 0 };
      }
      // runtime signal not redirecting this step; continue unified action dispatch
      const runtimeSignal = getRuntimeSignal();
      const actionRequest = {
        runId,
        stepId,
        stepIndex: i,
        plannedStepIndex: i,
        executionIndex: nextExecutionIndex,
        attemptNo,
        action: {
          aiName,
          executor: stepExecutor,
          actionRef: stepActionRef || (isSandboxStep ? TERMINAL_RUNTIME_ACTION : aiName)
        },
        input: {
          args: toolArgs
        }
      };
      res = await dispatchActionRequest({
        mcpcore,
        request: actionRequest,
        context: { runId, stepIndex: i },
        executionOptions: isSandboxStep ? { signal: runtimeSignal } : {}
      });
      elapsed = now() - stepStart;
      if (!isExecutionActive() || hardStopRequested || isHardStopRequestedByDirective() || isRunCancelled(runId)) {
        return { stale: true };
      }
    }
    if (!isExecutionActive() || hardStopRequested || isHardStopRequestedByDirective()) {
      return { stale: true };
    }
    // update rolling context and Redis history
    let actionResult = (res && typeof res === 'object' && res.actionResult && typeof res.actionResult === 'object')
      ? normalizeEventPayload(res.actionResult)
      : null;
    const resultPayload = (res && typeof res === 'object')
      ? (() => {
        const { actionResult: _actionResult, request: _request, ...rest } = res;
        return rest;
      })()
      : res;
    const normalizedResRaw = normalizeEventPayload(resultPayload);
    const normalizedRes = (normalizedResRaw && typeof normalizedResRaw === 'object')
      ? normalizedResRaw
      : { success: false, code: 'INVALID_RESULT', data: normalizedResRaw };
    if (!actionResult || typeof actionResult !== 'object') {
      actionResult = {
        ok: normalizedRes?.success === true,
        code: String(normalizedRes?.code || ''),
        errorClass: '',
        retryable: false,
        action: {
          executor: String(stepExecutor || ''),
          actionRef: String(stepActionRef || (isSandboxStep ? TERMINAL_RUNTIME_ACTION : aiName)),
          aiName: String(aiName || ''),
          stepId: String(stepId || '')
        },
        status: {
          success: normalizedRes?.success === true,
          code: String(normalizedRes?.code || ''),
          message: String(normalizedRes?.message || normalizedRes?.error || '')
        },
        input: { args: toolArgs },
        output: {
          provider: String(normalizedRes?.provider || ''),
          data: normalizedRes?.data ?? null
        },
        evidence: [],
        artifacts: Array.isArray(normalizedRes?.artifacts) ? normalizedRes.artifacts : [],
        metrics: {
          elapsedMs: Number.isFinite(Number(elapsed)) ? Number(elapsed) : 0
        }
      };
    }
    const protocolOutcome = normalizeActionOutcome({
      result: normalizedRes,
      actionResult
    });
    normalizedRes.success = protocolOutcome.success === true;
    normalizedRes.code = String(protocolOutcome.code || normalizedRes.code || '');
    if (!String(normalizedRes?.message || '').trim() && protocolOutcome.message) {
      normalizedRes.message = String(protocolOutcome.message || '');
    }
    if (!Array.isArray(normalizedRes.evidence) && Array.isArray(protocolOutcome.evidence) && protocolOutcome.evidence.length > 0) {
      normalizedRes.evidence = protocolOutcome.evidence;
    }
    if (!Array.isArray(normalizedRes.artifacts) && Array.isArray(protocolOutcome.artifacts) && protocolOutcome.artifacts.length > 0) {
      normalizedRes.artifacts = protocolOutcome.artifacts;
    }
    actionResult.ok = protocolOutcome.success === true;
    actionResult.code = String(protocolOutcome.code || actionResult.code || '');
    actionResult.errorClass = String(protocolOutcome.errorClass || actionResult.errorClass || '');
    actionResult.retryable = protocolOutcome.retryable === true;
    if (!Array.isArray(actionResult.evidence) && Array.isArray(protocolOutcome.evidence) && protocolOutcome.evidence.length > 0) {
      actionResult.evidence = protocolOutcome.evidence;
    }
    if (!Array.isArray(actionResult.artifacts) && Array.isArray(protocolOutcome.artifacts) && protocolOutcome.artifacts.length > 0) {
      actionResult.artifacts = protocolOutcome.artifacts;
    }
    let workspaceDiffTotalDelta = null;
    const workspaceDiff = await captureWorkspaceDiffArtifacts({
      stepIndex: i,
      stepId,
      aiName,
      usedEntry: {
        aiName,
        executor: stepExecutor,
        elapsedMs: Number.isFinite(Number(elapsed)) ? Number(elapsed) : 0,
        success: normalizedRes?.success === true,
        code: String(normalizedRes?.code || '')
      },
      error: normalizedRes?.success === true
        ? ''
        : String(normalizedRes?.message || normalizedRes?.error || normalizedRes?.code || '')
    });
    if (workspaceDiff && typeof workspaceDiff === 'object') {
      const diffSummary = (workspaceDiff.summary && typeof workspaceDiff.summary === 'object')
        ? workspaceDiff.summary
        : { added: 0, changed: 0, removed: 0, unchanged: 0, totalDelta: 0 };
      workspaceDiffTotalDelta = Number.isFinite(Number(diffSummary.totalDelta))
        ? Math.max(0, Math.floor(Number(diffSummary.totalDelta)))
        : 0;
      const diffPaths = Array.isArray(workspaceDiff.paths) ? workspaceDiff.paths : [];
      const diffEvidence = {
        kind: 'workspace_diff',
        effect: Number(diffSummary.totalDelta || 0) > 0 ? 'changed' : 'no_effect',
        added: Number(diffSummary.added || 0),
        changed: Number(diffSummary.changed || 0),
        removed: Number(diffSummary.removed || 0),
        totalDelta: Number(diffSummary.totalDelta || 0),
        paths: diffPaths.slice(0, maxDiffLogPaths),
        comparedAt: Number(workspaceDiff.comparedAt || Date.now())
      };
      const actionEvidence = Array.isArray(actionResult?.evidence) ? actionResult.evidence : [];
      actionResult.evidence = [diffEvidence, ...actionEvidence].slice(0, 12);
      const payloadData = (normalizedRes?.data && typeof normalizedRes.data === 'object') ? normalizedRes.data : {};
      normalizedRes.data = {
        ...payloadData,
        workspaceDiff: {
          summary: diffSummary,
          paths: diffPaths.slice(0, maxDiffLogPaths),
          comparedAt: Number(workspaceDiff.comparedAt || Date.now())
        }
      };
      const checkpointDiff = upsertWorkspaceDiffCheckpointIndex({
        stepIndex: i,
        stepId,
        aiName,
        workspaceDiff
      });
      if (checkpointDiff) {
        context.lastWorkspaceDiffStepKey = checkpointDiff.stepKey;
        context.lastWorkspaceDiffByStepKey = checkpointDiff.byStepKey;
        await updateRuntimeCheckpoint({
          lastWorkspaceDiffStepKey: checkpointDiff.stepKey,
          lastWorkspaceDiff: checkpointDiff.entry,
          lastWorkspaceDiffByStepKey: checkpointDiff.byStepKey
        }, {
          type: 'runtime_workspace_diff',
          stepIndex: Number(i),
          stepId: String(stepId || ''),
          aiName: String(aiName || ''),
          stepKey: checkpointDiff.stepKey,
          effect: String(checkpointDiff.entry.effect || ''),
          summary: checkpointDiff.entry.summary
        });
      }
    }
    if (!Array.isArray(normalizedRes.evidence) && Array.isArray(actionResult?.evidence) && actionResult.evidence.length > 0) {
      normalizedRes.evidence = actionResult.evidence;
    }
    recentResults.push({ aiName, executor: stepExecutor, actionRef: stepActionRef || undefined, args: toolArgs, result: normalizedRes, data: normalizedRes?.data, actionResult });
    const limit = Math.max(1, Number(config.flags?.recentContextLimit ?? 5));
    if (recentResults.length > limit) recentResults.shift();

    const stepSuccessCriteria = collectStepSuccessCriteria(step, manifestItem, currentToolFull);
    const hasStepSuccessCriteria = stepSuccessCriteria.length > 0;
    const forceMiniEvalOnSuccessWithCriteria =
      normalizedRes?.success === true &&
      hasStepSuccessCriteria;
    const successWithNoWorkspaceChange =
      forceMiniEvalOnSuccessWithCriteria &&
      workspaceDiffTotalDelta === 0;
    if (forceMiniEvalOnSuccessWithCriteria && config.flags.enableVerboseSteps) {
      logger.info('Force mini eval on successful step due to explicit success criteria', {
        label: 'MINI_EVAL',
        stepIndex: i,
        stepId,
        aiName,
        successCriteriaCount: stepSuccessCriteria.length,
        workspaceDiffTotalDelta: workspaceDiffTotalDelta,
        noWorkspaceChange: successWithNoWorkspaceChange === true
      });
    }
    const miniEval = await evaluateStepMiniDecision({
      runId,
      stepIndex: i,
      objective,
      step,
      manifestItem,
      currentToolFull,
      result: normalizedRes,
      actionResult,
      retryState,
      argValidationFailed,
      context
    });
    const miniEvalProvider = getStageProvider('mini_eval');
    const miniEvalRuntime = {
      stage: 'mini_eval',
      model: String(getStageModel('mini_eval') || ''),
      baseURL: String(miniEvalProvider?.baseURL || ''),
      timeoutMs: Number(getStageTimeoutMs('mini_eval') || 0),
      skipped: false,
      forcedByCriteriaOnSuccess: forceMiniEvalOnSuccessWithCriteria === true,
      successNoWorkspaceChange: successWithNoWorkspaceChange === true,
    };
    const miniEvalAdvisoryOnly =
      normalizedRes?.success === true &&
      miniEval?.pass !== true;
    let effectiveMiniEval = miniEvalAdvisoryOnly
      ? {
        ...(miniEval && typeof miniEval === 'object' ? miniEval : {}),
        decision: MINI_EVAL_DECISION.pass,
        pass: true,
        policy: {
          ...(miniEval?.policy && typeof miniEval.policy === 'object' ? miniEval.policy : {}),
          source: 'mini_eval_advisory_on_success',
          advisory: true
        }
      }
      : miniEval;
    if (miniEval?.pass !== true && normalizedRes?.success === true) {
      const prevData = (normalizedRes.data && typeof normalizedRes.data === 'object') ? normalizedRes.data : {};
      normalizedRes.data = {
        ...prevData,
        stepMiniEval: {
          decision: miniEval.decision,
          effectiveDecision: effectiveMiniEval?.decision || miniEval.decision,
          advisory: miniEvalAdvisoryOnly,
          failureClass: miniEval.failureClass,
          reason: miniEval.reason,
          criteria: miniEval.criteria,
          policy: miniEval?.policy || null
        }
      };
      if (!miniEvalAdvisoryOnly) {
        normalizedRes.success = false;
        normalizedRes.code = 'STEP_MINI_EVAL_FAILED';
        normalizedRes.message = miniEval.reason || 'Step failed mini evaluation criteria.';
      }
    }
    const miniEvalEvent = {
      type: 'step_mini_eval',
      stepIndex: i,
      plannedStepIndex: i,
      stepId,
      aiName,
      attemptNo,
      decision: String(miniEval?.decision || MINI_EVAL_DECISION.replan),
      effectiveDecision: String(effectiveMiniEval?.decision || miniEval?.decision || MINI_EVAL_DECISION.replan),
      pass: miniEval?.pass === true,
      effectivePass: effectiveMiniEval?.pass === true,
      advisory: miniEvalAdvisoryOnly === true,
      failureClass: String(miniEval?.failureClass || ''),
      reason: String(miniEval?.reason || ''),
      criteria: miniEval?.criteria || null,
      policy: effectiveMiniEval?.policy || miniEval?.policy || null,
      runtime: miniEvalRuntime,
      resultCode: String(normalizedRes?.code || ''),
      resultSuccess: normalizedRes?.success === true,
    };
    if (canEmitLiveEvents()) {
      emitRunEvent(runId, miniEvalEvent);
      await HistoryStore.append(runId, miniEvalEvent);
    }

    if (isMiniEvalRetryDecision(effectiveMiniEval?.decision)) {
      const resultCode = String(normalizedRes?.code || '');
      const lastFailurePrev = (retryState?.lastFailure && typeof retryState.lastFailure === 'object')
        ? retryState.lastFailure
        : {};
      const currentArgFingerprint = isSandboxStep ? buildTerminalArgsFingerprint(toolArgs) : '';
      const prevArgFingerprint = String(lastFailurePrev?.argFingerprint || '').trim();
      const prevTimeoutLoopCount = Math.max(0, toBoundedInt(lastFailurePrev?.timeoutLoopCount, 0, 0, 99));
      const isCurrentTimeout = isTimeoutLikeCode(resultCode);
      const repeatedTimeoutWithSameArgs = isSandboxStep
        && isCurrentTimeout
        && !!currentArgFingerprint
        && currentArgFingerprint === prevArgFingerprint
        && isTimeoutLikeCode(lastFailurePrev?.last_code);
      const timeoutLoopCount = isCurrentTimeout
        ? (repeatedTimeoutWithSameArgs ? prevTimeoutLoopCount + 1 : 1)
        : 0;

      const initialDecision = String(effectiveMiniEval?.decision || '');
      let retryDecision = initialDecision;
      let retryReason = String(effectiveMiniEval?.reason || miniEval?.reason || '');
      if (
        retryDecision === MINI_EVAL_DECISION.retrySame
        && timeoutLoopCount >= STEP_TIMEOUT_SAME_FINGERPRINT_LIMIT
      ) {
        retryDecision = MINI_EVAL_DECISION.retryRegen;
        retryReason = [retryReason, 'runtime_guard: repeated TIMEOUT on same terminal args; force retry_regen']
          .filter(Boolean)
          .join('; ');
      }
      if (attemptNo >= STEP_MINI_RETRY_ATTEMPT_LIMIT && isMiniEvalRetryDecision(retryDecision)) {
        retryDecision = MINI_EVAL_DECISION.replan;
        retryReason = [retryReason, `runtime_guard: retry attempt limit reached (${STEP_MINI_RETRY_ATTEMPT_LIMIT})`]
          .filter(Boolean)
          .join('; ');
      }
      if (retryDecision !== initialDecision) {
        effectiveMiniEval = {
          ...(effectiveMiniEval && typeof effectiveMiniEval === 'object' ? effectiveMiniEval : {}),
          decision: retryDecision,
          pass: retryDecision === MINI_EVAL_DECISION.pass,
          reason: retryReason,
          policy: {
            ...(effectiveMiniEval?.policy && typeof effectiveMiniEval.policy === 'object' ? effectiveMiniEval.policy : {}),
            source: 'runtime_retry_guard'
          }
        };
        if (canEmitLiveEvents()) {
          const guardEv = {
            type: 'step_retry_guard_adjusted',
            stepIndex: i,
            plannedStepIndex: i,
            stepId,
            aiName,
            fromDecision: initialDecision,
            toDecision: retryDecision,
            reason: retryReason,
            resultCode
          };
          emitRunEvent(runId, guardEv);
          await HistoryStore.append(runId, guardEv);
        }
      }
    }

    if (isMiniEvalRetryDecision(effectiveMiniEval?.decision)) {
      const nextState = {
        attempts: attemptNo,
        sameRetries: Number(retryState.sameRetries || 0),
        regenRetries: Number(retryState.regenRetries || 0),
        forceRegenerate: false,
        lastFailure: {
          attempt_no: attemptNo,
          last_args: toolArgs,
          last_error: String(normalizedRes?.message || normalizedRes?.error || normalizedRes?.code || ''),
          last_code: String(normalizedRes?.code || ''),
          argFingerprint: isSandboxStep ? buildTerminalArgsFingerprint(toolArgs) : '',
          timeoutLoopCount: isTimeoutLikeCode(normalizedRes?.code) ? (
            (
              isSandboxStep
              && isTimeoutLikeCode(retryState?.lastFailure?.last_code)
              && String(retryState?.lastFailure?.argFingerprint || '').trim() === buildTerminalArgsFingerprint(toolArgs)
            )
              ? Math.max(0, toBoundedInt(retryState?.lastFailure?.timeoutLoopCount, 0, 0, 99)) + 1
              : 1
          ) : 0,
          evidence: Array.isArray(actionResult?.evidence) ? actionResult.evidence.slice(0, 8) : [],
        }
      };
      if (effectiveMiniEval.decision === MINI_EVAL_DECISION.retrySame) {
        nextState.sameRetries += 1;
      } else {
        nextState.regenRetries += 1;
        nextState.forceRegenerate = true;
      }
      stepRetryState.set(i, nextState);
      if (config.flags.enableVerboseSteps) {
        logger.info('Step mini eval requested retry', {
          label: 'STEP',
          stepIndex: i,
          stepId,
          aiName,
          decision: effectiveMiniEval.decision,
          sameRetries: nextState.sameRetries,
          regenRetries: nextState.regenRetries,
          resultCode: String(normalizedRes?.code || '')
        });
      }
      await emitStepState({
        stepIndex: i,
        step,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef,
        state: 'retrying',
        reasonCode: miniEvalDecisionToReasonCode(effectiveMiniEval.decision, MINI_EVAL_REASON_CODE.retrySame),
        reason: String(effectiveMiniEval.reason || miniEval?.reason || ''),
        attemptNo,
        resultCode: String(normalizedRes?.code || '')
      });
      return await executeSingleStep(i);
    }

    stepRetryState.delete(i);
    if (isMiniEvalStopDecision(effectiveMiniEval?.decision)) {
      stopRequested = true;
    }
    if (effectiveMiniEval?.decision === MINI_EVAL_DECISION.replan) {
      await emitStepState({
        stepIndex: i,
        step,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef,
        state: 'replanned',
        reasonCode: miniEvalDecisionToReasonCode(effectiveMiniEval.decision, MINI_EVAL_REASON_CODE.replan),
        reason: String(effectiveMiniEval.reason || miniEval?.reason || ''),
        attemptNo,
        resultCode: String(normalizedRes?.code || '')
      });
    } else if (effectiveMiniEval?.decision === MINI_EVAL_DECISION.failFast) {
      await emitStepState({
        stepIndex: i,
        step,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef,
        state: 'failed',
        reasonCode: miniEvalDecisionToReasonCode(effectiveMiniEval.decision, MINI_EVAL_REASON_CODE.failFast),
        reason: String(effectiveMiniEval.reason || miniEval?.reason || ''),
        attemptNo,
        resultCode: String(normalizedRes?.code || '')
      });
    }

    const depOnStepIds = buildDependsOnStepIds(i);
    const depByStepIds = buildDependedByStepIds(i);
    const gid = groupOf[i];
    const toolMetaInherited = {
      ...(toolMetaMap.get(aiName) || manifestItem?.meta || currentToolFull?.meta || {}),
      executor: stepExecutor,
      ...(stepActionRef ? { actionRef: stepActionRef } : {})
    };
    const ev = {
      type: 'tool_result',
      plannedStepIndex: i,  // Original index inside the planner's step list.
      stepId,
      executionIndex: nextExecutionIndex++,  // Global execution order index across emitted tool results.
      aiName,
      executor: stepExecutor,
      actionRef: stepActionRef || undefined,
      reason: formatReason(step.reason),
      nextStep: step.nextStep || '',
      result: normalizedRes,
      actionResult,
      elapsedMs: elapsed,
      dependsOnStepIds: depOnStepIds,
      dependedByStepIds: depByStepIds,
      dependsNote: buildDependsNote(i),
      groupId: (gid ?? null),
      groupSize: (gid != null && groups[gid]?.nodes?.length) ? groups[gid].nodes.length : 1,
      toolContext: stepToolContext,
      toolMeta: toolMetaInherited,
    };
    ev.completion = {
      state: 'completed',
      mustAnswerFromResult: true,
      instruction: 'Tool execution has finished for this step. Answer the user based on the tool result and extracted files/resources.'
    };
    if (canEmitLiveEvents()) {
      groupEventCoordinator.emitToolResultGrouped(ev, i);
      await HistoryStore.append(runId, ev);
    }

    const finalOutcome = normalizeActionOutcome({
      result: normalizedRes,
      actionResult
    });
    const finalSuccess = finalOutcome.success === true;
    const finalCode = String(finalOutcome.code || normalizedRes?.code || res?.code || '');
    const finalState = effectiveMiniEval?.decision === MINI_EVAL_DECISION.replan
      ? 'replanned'
      : (finalSuccess ? 'succeeded' : 'failed');
    syncCheckpointStepRuntime({
      executionIndex: ev.executionIndex,
      elapsedMs: elapsed,
      success: finalSuccess,
      code: finalCode,
      state: finalState,
      reasonCode: finalSuccess ? STEP_REASON_CODE.toolResultSuccess : STEP_REASON_CODE.toolResultFailed,
      message: String(normalizedRes?.message || normalizedRes?.error || '')
    });
    if (config.memory?.enable && finalSuccess) {
      await upsertToolMemory({ runId, stepIndex: i, aiName, objective, reason: formatReason(step.reason), args: toolArgs, result: normalizedRes, success: true });
    }
    if (config.flags.enableVerboseSteps) logger.info('Tool execution result', { label: 'RESULT', aiName, success: finalSuccess, code: finalCode, dataPreview: clip(normalizedRes?.data) });

    if (!finalSuccess && isCooldownResultCode(finalCode)) {
      const remainMs = Number(normalizedRes.remainMs || (normalizedRes.ttl ? normalizedRes.ttl * 1000 : (config.planner?.cooldownDefaultMs || 1000)));
      const jitter = Math.floor(100 + Math.random() * 200);
      const requeueMs = Math.max(200, remainMs + jitter);
      const availableAt = now() + requeueMs;
      syncCheckpointStepRuntime({
        executionIndex: ev.executionIndex,
        elapsedMs: elapsed,
        success: false,
        code: finalCode,
        state: 'retrying',
        reasonCode: MINI_EVAL_REASON_CODE.retrySame,
        message: String(normalizedRes?.message || normalizedRes?.error || ''),
        availableAt
      });
      return { usedEntry: buildStepUsedEntry({ executionIndex: ev.executionIndex, elapsedMs: elapsed, success: finalSuccess, code: finalCode }), succeeded: 0, requeueMs };
    }

    if (retrySteps) {
      stepStatus.set(i, {
        success: finalSuccess,
        reason: finalSuccess ? 'ok' : (normalizedRes.message || normalizedRes.error || `execution failed: ${finalCode}`)
      });
    }
    if (!isMiniEvalStopDecision(effectiveMiniEval?.decision)) {
      await emitStepState({
        stepIndex: i,
        step,
        aiName,
        executor: stepExecutor,
        actionRef: stepActionRef,
        state: finalSuccess ? 'succeeded' : 'failed',
        reasonCode: finalSuccess ? STEP_REASON_CODE.toolResultSuccess : STEP_REASON_CODE.toolResultFailed,
        reason: finalSuccess ? 'tool result accepted' : String(normalizedRes.message || normalizedRes.error || ''),
        attemptNo,
        resultCode: finalCode
      });
    }

    return { usedEntry: buildStepUsedEntry({ executionIndex: ev.executionIndex, elapsedMs: elapsed, success: finalSuccess, code: finalCode }), succeeded: finalSuccess ? 1 : 0 };
  };

  const isReady = (i) => {
    if (!isExecutionActive()) return false;
    if (stopRequested) return false;
    if (hardStopRequested || isHardStopRequestedByDirective() || isRunCancelled(runId)) return false;
    if (retrySteps && !retrySteps.has(i)) return false;
    if (!retrySteps && i < schedulerStartIndex) return false;
    if (started.has(i) || finished.has(i)) return false;
    const due = delayUntil.get(i) || 0; if (due && now() < due) return false;
    const aiName = plan.steps[i]?.aiName;
    const prov = toolMeta.get(aiName)?.provider || 'local';
    const toolLim = getToolLimit(aiName);
    const provLim = getProvLimit(prov);
    const tRun = runningByTool.get(aiName) || 0;
    const pRun = runningByProvider.get(normKey(prov)) || 0;
    if (tRun >= toolLim) return false;
    if (pRun >= provLim) return false;
    const deps = depsArr[i] || [];
    if (!deps.length) return true;
    for (const idx of deps) {
      if (!finished.has(idx)) return false;
    }
    return true;
  };

  const inFlight = new Map(); // i -> Promise
  const track = (i, p) => p.finally(() => { inFlight.delete(i); });

  while (finished.size < plan.steps.length) {
    await pollRuntimeSignal({ phase: 'scheduler_loop', stepIndex: -1 });
    if (!isExecutionActive()) break;
    if (isRunCancelled(runId)) hardStopRequested = true;
    if (isHardStopRequestedByDirective()) hardStopRequested = true;
    if (hardStopRequested) {
      if (config.flags.enableVerboseSteps) {
        logger.info?.('scheduler hard-stop requested; break immediately', {
          label: 'RUN',
          runId,
          action: String(runtimeDirective?.action || '')
        });
      }
      groupEventCoordinator.flushAllOnCancel();
      break;
    }
    if (isRunCancelled(runId)) {
      if (config.flags.enableVerboseSteps) {
        logger.info?.('Run cancellation detected during scheduling; stop early', { label: 'RUN', runId });
      }
      groupEventCoordinator.flushAllOnCancel();
      break;
    }
    if (stopRequested) {
      if (inFlight.size === 0) {
        break;
      }
      await Promise.race([...inFlight.values()]);
      continue;
    }

    for (let i = schedulerStartIndex; i < plan.steps.length; i++) {
      const s = plan.steps[i];
      if (s && s.skip === true && !finished.has(i)) {
        finished.add(i);
        const isFinalStep = finished.size >= plan.steps.length;
        groupEventCoordinator.flushIsolatedResultIfAny(i, isFinalStep);
        groupEventCoordinator.decrementGroupPendingAndMaybeFlush(i, { isFinalStep });
      }
    }

    for (let i = schedulerStartIndex; i < plan.steps.length && inFlight.size < maxConc; i++) {
      if (isReady(i)) {
        started.add(i);
        const aiName = plan.steps[i]?.aiName;
        const prov = toolMeta.get(aiName)?.provider || 'local';
        runningByTool.set(aiName, (runningByTool.get(aiName) || 0) + 1);
        const provKey = normKey(prov);
        runningByProvider.set(provKey, (runningByProvider.get(provKey) || 0) + 1);

        const p = track(i, executeSingleStep(i).then(async (r) => {
          runningByProvider.set(provKey, Math.max(0, (runningByProvider.get(provKey) || 1) - 1));
          if (!isExecutionActive()) return;
          if (r?.stale) return;
          if (hardStopRequested || isHardStopRequestedByDirective() || isRunCancelled(runId)) return;

          if (r?.requeueMs > 0) {
            groupEventCoordinator.flushIsolatedResultIfAny(i, false);
            delayUntil.set(i, now() + r.requeueMs);
            started.delete(i);
            if (r?.usedEntry) used.push(r.usedEntry);
            await updateRuntimeCheckpoint({
              stage: 'execute_step_requeue',
              lastCompletedStepIndex: Number(i),
              lastCompletedStepId: String(plan.steps[i]?.stepId || ''),
              lastToolName: String(r?.usedEntry?.aiName || aiName || ''),
              lastToolCode: String(r?.usedEntry?.code || ''),
              lastToolSuccess: r?.usedEntry?.success ? '1' : '0',
              nextRetryAt: Number(delayUntil.get(i) || 0),
              lastExecutionIndex: Number.isFinite(Number(r?.usedEntry?.executionIndex))
                ? Number(r.usedEntry.executionIndex)
                : Math.max(-1, Number(nextExecutionIndex || 0) - 1),
              stepRuntimeIndex: serializeCheckpointStepRuntimeIndex()
            }, {
              type: 'runtime_step_requeue',
              stepIndex: Number(i),
              stepId: String(plan.steps[i]?.stepId || ''),
              aiName: String(aiName || ''),
              code: String(r?.usedEntry?.code || ''),
              requeueMs: Number(r?.requeueMs || 0)
            });
            return;
          }
          finished.add(i);
          const isFinalStep = finished.size >= plan.steps.length;
          groupEventCoordinator.flushIsolatedResultIfAny(i, isFinalStep);
          groupEventCoordinator.decrementGroupPendingAndMaybeFlush(i, { isFinalStep });
          if (r?.usedEntry) used.push(r.usedEntry);
          if (r?.succeeded) succeeded += r.succeeded;
          await updateRuntimeCheckpoint({
            stage: 'execute_step_done',
            lastCompletedStepIndex: Number(i),
            lastCompletedStepId: String(plan.steps[i]?.stepId || ''),
            lastToolName: String(r?.usedEntry?.aiName || aiName || ''),
            lastToolCode: String(r?.usedEntry?.code || ''),
            lastToolSuccess: r?.usedEntry?.success ? '1' : '0',
            lastExecutionIndex: Number.isFinite(Number(r?.usedEntry?.executionIndex))
              ? Number(r.usedEntry.executionIndex)
              : Math.max(-1, Number(nextExecutionIndex || 0) - 1),
            stepRuntimeIndex: serializeCheckpointStepRuntimeIndex()
          }, {
            type: 'runtime_step_done',
            stepIndex: Number(i),
            stepId: String(plan.steps[i]?.stepId || ''),
            aiName: String(aiName || ''),
            code: String(r?.usedEntry?.code || ''),
            success: r?.usedEntry?.success === true
          });
        }).catch(async (e) => {
          runningByProvider.set(provKey, Math.max(0, (runningByProvider.get(provKey) || 1) - 1));
          stopRequested = true;
          try {
            if (canEmitLiveEvents()) {
              const ffEv = {
                type: 'step_fail_fast',
                stepIndex: i,
                stepId: String(plan.steps[i]?.stepId || ''),
                aiName: String(aiName || ''),
                reason: String(e || 'STEP_EXCEPTION')
              };
              emitRunEvent(runId, ffEv);
              await HistoryStore.append(runId, ffEv);
            }
          } catch { }
          const exceptionExecutor = normalizePlanExecutor(plan.steps[i], toolMeta.get(aiName) || {});
          const exceptionUsedEntry = {
            aiName: String(aiName || ''),
            executor: String(exceptionExecutor || ''),
            stepId: String(plan.steps[i]?.stepId || ''),
            stepIndex: Number(i),
            executionIndex: -1,
            attemptNo: 0,
            elapsedMs: 0,
            success: false,
            code: 'STEP_EXCEPTION'
          };
          used.push(exceptionUsedEntry);
          upsertCheckpointStepRuntime({
            stepIndex: Number(i),
            stepId: String(plan.steps[i]?.stepId || ''),
            aiName: String(aiName || ''),
            executor: String(exceptionExecutor || ''),
            state: 'failed',
            reasonCode: STEP_REASON_CODE.stepException,
            resultCode: 'STEP_EXCEPTION',
            attemptNo: 0,
            executionIndex: -1,
            success: false,
            elapsedMs: 0,
            message: String(e || '')
          });
          const exceptionDiff = await captureWorkspaceDiffArtifacts({
            stepIndex: i,
            stepId: plan.steps[i]?.stepId,
            aiName,
            usedEntry: exceptionUsedEntry,
            error: String(e)
          });
          const checkpointDiff = upsertWorkspaceDiffCheckpointIndex({
            stepIndex: i,
            stepId: plan.steps[i]?.stepId,
            aiName,
            workspaceDiff: exceptionDiff
          });
          if (checkpointDiff) {
            context.lastWorkspaceDiffStepKey = checkpointDiff.stepKey;
            context.lastWorkspaceDiffByStepKey = checkpointDiff.byStepKey;
            await updateRuntimeCheckpoint({
              lastWorkspaceDiffStepKey: checkpointDiff.stepKey,
              lastWorkspaceDiff: checkpointDiff.entry,
              lastWorkspaceDiffByStepKey: checkpointDiff.byStepKey
            }, {
              type: 'runtime_workspace_diff',
              stepIndex: Number(i),
              stepId: String(plan.steps[i]?.stepId || ''),
              aiName: String(aiName || ''),
              stepKey: checkpointDiff.stepKey,
              effect: String(checkpointDiff.entry.effect || ''),
              summary: checkpointDiff.entry.summary
            });
          }
          if (!isExecutionActive()) return;
          if (hardStopRequested || isHardStopRequestedByDirective() || isRunCancelled(runId)) return;
          finished.add(i);
          const isFinalStep = finished.size >= plan.steps.length;
          groupEventCoordinator.flushIsolatedResultIfAny(i, isFinalStep);
          groupEventCoordinator.decrementGroupPendingAndMaybeFlush(i, { isFinalStep });
          await emitStepState({
            stepIndex: i,
            step: plan.steps[i] || {},
            aiName: String(aiName || ''),
            executor: normalizePlanExecutor(plan.steps[i], toolMeta.get(aiName) || {}),
            actionRef: String(plan.steps[i]?.actionRef || ''),
            state: 'failed',
            reasonCode: STEP_REASON_CODE.stepException,
            reason: String(e || ''),
            attemptNo: 0,
            resultCode: 'STEP_EXCEPTION'
          });
          await updateRuntimeCheckpoint({
            stage: 'execute_step_exception',
            lastCompletedStepIndex: Number(i),
            lastCompletedStepId: String(plan.steps[i]?.stepId || ''),
            lastToolName: String(aiName || ''),
            lastToolCode: 'STEP_EXCEPTION',
            lastToolSuccess: '0',
            lastError: String(e),
            lastExecutionIndex: Math.max(-1, Number(nextExecutionIndex || 0) - 1),
            stepRuntimeIndex: serializeCheckpointStepRuntimeIndex()
          }, {
            type: 'runtime_step_exception',
            stepIndex: Number(i),
            stepId: String(plan.steps[i]?.stepId || ''),
            aiName: String(aiName || ''),
            error: String(e)
          });
          logger.warn?.('Parallel step execution exception', { label: 'STEP', index: i, error: String(e) });
        }));
        inFlight.set(i, p);
      }
    }

    if (inFlight.size === 0) {
      let minWait = Infinity;
      for (const [idx, ts] of delayUntil.entries()) {
        if (idx < schedulerStartIndex || finished.has(idx)) continue;
        const w = (ts || 0) - now();
        if (w > 0) minWait = Math.min(minWait, w);
      }
      if (Number.isFinite(minWait) && minWait !== Infinity) {
        await wait(minWait);
        continue;
      }
      if (finished.size < plan.steps.length) {
        logger.warn?.('No schedulable steps; possible dependency cycle or invalid dependsOnStepIds', { label: 'PLAN' });
        for (let i = schedulerStartIndex; i < plan.steps.length; i++) {
          if (!finished.has(i)) {
            finished.add(i);
            const gid = groupOf[i];
            if (gid !== null && gid !== undefined && groupPending.has(gid)) {
              groupPending.set(gid, Math.max(0, (groupPending.get(gid) || 0) - 1));
            }
          }
        }
        const finalGid = groups.length ? groups[groups.length - 1].id : null;
        groupEventCoordinator.flushReadyGroupsInOrder({ force: true, finalGroupId: finalGid });
      }
      break;
    }

    await Promise.race([...inFlight.values()]);
  }

  const attempted = used.length;
  const successRate = attempted ? succeeded / attempted : 0;
  if (isRunCancelled(runId)) {
    groupEventCoordinator.flushAllOnCancel();
  } else {
    const finalGid = groups.length ? groups[groups.length - 1].id : null;
    groupEventCoordinator.flushReadyGroupsInOrder({ force: true, finalGroupId: finalGid });
  }
  await updateRuntimeCheckpoint({
    stage: hardStopRequested || isRunCancelled(runId) ? 'execute_plan_stopped' : 'execute_plan_done',
    status: isRunCancelled(runId) ? 'cancelled' : 'running',
    attempted: Number(used.length || 0),
    succeeded: Number(succeeded || 0),
    completedStepCount: Number(finished.size || 0),
    finishedAt: hardStopRequested || isRunCancelled(runId) ? now() : 0,
    lastExecutionIndex: Math.max(-1, Number(nextExecutionIndex || 0) - 1),
    stepRuntimeIndex: serializeCheckpointStepRuntimeIndex()
  }, {
    type: 'runtime_execute_done',
    attempted: Number(used.length || 0),
    succeeded: Number(succeeded || 0),
    cancelled: isRunCancelled(runId) === true,
    hardStopRequested: hardStopRequested === true,
    directiveAction: String(runtimeDirective?.action || '')
  });
  for (let i = 0; i < plan.steps.length; i++) {
    if (!finished.has(i)) continue;
    if (preFinalized.has(i)) continue;
    const step = plan.steps[i] || {};
    await emitStepState({
      stepIndex: i,
      step,
      aiName: String(step?.aiName || ''),
      executor: normalizePlanExecutor(step, toolMeta.get(step?.aiName) || {}),
      actionRef: String(step?.actionRef || ''),
      state: 'finalized',
      reasonCode: isRunCancelled(runId) ? STEP_REASON_CODE.runCancelledFinalize : STEP_REASON_CODE.executePlanFinalize,
      reason: isRunCancelled(runId) ? 'run cancelled' : 'step finalized in run cleanup',
      attemptNo: 0
    });
  }
  return {
    used,
    attempted,
    succeeded,
    successRate,
    runtimeControl,
    runtimeDirective,
    runtimeSignalCursorTs,
    runtimeSignalGeneration,
    runtimeSignalSeq,
    workspace: {
      capturedSteps: workspaceDiffCaptureCount,
      changedSteps: workspaceDiffChangedCount,
      artifactsUpserted: workspaceArtifactsUpserted
    }
  };
  } finally {
    executionClosed = true;
    releaseRunExecutionEpoch(runIdText, executeEpoch);
  }
}

export async function planThenExecute({ objective, context = {}, mcpcore, conversation, forceNeedTools = false }) {
  const runId = resolveRuntimeRunId(context);
  const { ctx } = createRuntimeContext({
    runId,
    objective,
    context,
    registerRunStart,
    injectConcurrencyOverlay
  });
  const runtimeControl = resolveRuntimeControl(ctx);
  try {
    await emitRunStart({
      runId,
      objective,
      context: ctx,
      sanitizeContextForLog,
      emitRunEvent,
      historyStore: HistoryStore
    });
    if (runtimeControl.enabled) {
      await HistoryStore.append(runId, {
        type: 'runtime_control',
        phase: 'plan_then_execute',
        reason: String(runtimeControl.reason || ''),
        singlePass: runtimeControl.singlePass === true,
        skipEvaluation: runtimeControl.skipEvaluation === true,
        skipSummary: runtimeControl.skipSummary === true,
        disableAdaptive: runtimeControl.disableAdaptive === true,
        disablePlanRepair: runtimeControl.disablePlanRepair === true,
        disableArgFixRetry: runtimeControl.disableArgFixRetry === true
      });
    }

    const resumePlan = await resolveResumePlanFromRuntimeCheckpoint({
      runId,
      context: ctx,
      normalizePlanFn: normalizePlanStepIds
    });
    let plan = null;
    if (resumePlan.enabled) {
      plan = resumePlan.plan;
      await HistoryStore.setPlan(runId, plan);
      await HistoryStore.append(runId, {
        type: 'resume_executor_applied',
        reason: String(resumePlan.reason || ''),
        checkpointStage: String(resumePlan?.checkpoint?.stage || ''),
        checkpointStatus: String(resumePlan?.checkpoint?.status || ''),
        checkpointUpdatedAt: Number(resumePlan?.checkpoint?.updatedAt || 0),
        resumeCursorIndex: Number(resumePlan.resumeCursorIndex || 0),
        planSignature: String(resumePlan.planSignature || ''),
        checkpointPlanSignature: String(resumePlan.checkpointSignature || ''),
        totalSteps: Number(plan?.steps?.length || 0)
      });
      await HistoryStore.append(runId, {
        type: 'plan',
        plan,
        resumedFromCheckpoint: true
      });
    } else {
      const manifest0 = await buildJudgeManifestWithPrefilter({
        objective,
        baseManifest: buildPlanningManifest(mcpcore),
        context: ctx
      });

      const judge = await runJudgeStage({
        objective,
        manifest: manifest0,
        conversation,
        context: ctx,
        forceNeedTools
      });
      await HistoryStore.append(runId, {
        type: 'judge',
        need: judge.need,
        summary: judge.summary,
        toolNames: judge.toolNames,
        ok: judge.ok !== false
      });
      await HistoryStore.append(runId, buildToolGateEvent({
        judge,
        manifest: manifest0
      }));
      if (judge && judge.ok === false) {
        const planFallback = { manifest: manifest0, steps: [] };
        const plan2 = normalizePlanStepIds(planFallback);
        await HistoryStore.setPlan(runId, plan2);
        await HistoryStore.append(runId, { type: 'plan', plan: plan2 });
        const exec = { used: [], attempted: 0, succeeded: 0, successRate: 0 };
        await HistoryStore.append(runId, { type: 'done', exec });
        const summary = String(judge.summary || 'Judge stage failed');
        try { await HistoryStore.setSummary(runId, summary); } catch { }
        await HistoryStore.append(runId, { type: 'summary', summary });
        return fail('JUDGE_FAILED', 'JUDGE_FAILED', { runId, plan: plan2, exec, eval: { success: false, summary }, summary });
      }
      if (!judge.need) {
        const planFallback = { manifest: manifest0, steps: [] };
        const plan2 = normalizePlanStepIds(planFallback);
        await HistoryStore.setPlan(runId, plan2);
        await HistoryStore.append(runId, { type: 'plan', plan: plan2 });
        const noToolsResultEvent = buildNoToolsResultGroupEvent({
          reasonCode: NO_TOOL_REASON_CODE.judgeNoTools,
          reason: String(judge.summary || '').trim() || 'Judge determined no MCP tool invocation is needed',
          summary: 'No tool invocation was required for this run.'
        });
        await HistoryStore.append(runId, noToolsResultEvent);
        const exec = { used: [], attempted: 0, succeeded: 0, successRate: 1 };
        const evalObj = { success: true, summary: 'No tools are required for this request; completed directly.' };
        await HistoryStore.append(runId, { type: 'done', exec });
        const summary = 'No tool invocation was required for this run.';
        await HistoryStore.setSummary(runId, summary);
        await HistoryStore.append(runId, { type: 'summary', summary });
        return ok({ runId, plan: plan2, exec, eval: evalObj, summary });
      }

      plan = await runPlanStage({
        objective,
        mcpcore,
        context: ctx,
        conversation,
        runId,
        judge,
        generatePlanFn: generatePlan,
        normalizePlanFn: normalizePlanStepIds
      });
      await HistoryStore.setPlan(runId, plan);
      await HistoryStore.append(runId, { type: 'plan', plan });
      if (isPlanEmpty(plan)) {
        logger.info('Plan returned empty steps; finish as no-tools run', { label: 'PLAN', runId, reason: 'empty_plan_short_circuit' });
        const noToolsResultEvent = buildNoToolsResultGroupEvent({
          reasonCode: NO_TOOL_REASON_CODE.emptyPlan,
          reason: 'Planner returned an empty executable plan',
          summary: 'No tool invocation was required for this run (empty plan).'
        });
        await HistoryStore.append(runId, noToolsResultEvent);
        const exec = { used: [], attempted: 0, succeeded: 0, successRate: 1 };
        const evalObj = {
          success: true,
          incomplete: false,
          nextAction: 'perfect',
          completionLevel: 'perfect',
          summary: 'Planner returned an empty executable plan; treated as no tool invocation required.'
        };
        await HistoryStore.append(runId, { type: 'done', exec });
        const summary = 'No tool invocation was required for this run (empty plan).';
        await HistoryStore.setSummary(runId, summary);
        await HistoryStore.append(runId, { type: 'summary', summary });
        return ok({ runId, plan, exec, eval: evalObj, summary });
      }
    }

    let exec = await executePlan(runId, objective, mcpcore, plan, { conversation, context: ctx });
    let evalObj = runtimeControl.skipEvaluation
      ? buildSkippedEvalResult(runtimeControl.reason || 'runtime_control_skip_evaluation')
      : await runEvaluateStage({ objective, plan, exec, runId, context: ctx });
    if (runtimeControl.skipEvaluation) {
      await HistoryStore.append(runId, {
        type: 'evaluation_skipped',
        reason: String(runtimeControl.reason || 'runtime_control_skip_evaluation')
      });
    }

    // Global repair loop (circuit breaker): limit the number of repair cycles
    const enableRepair = !(config.runner?.enableRepair === false);
    const maxRepairs = (enableRepair && !runtimeControl.disablePlanRepair && !runtimeControl.skipEvaluation)
      ? Math.max(0, Number(config.runner?.maxRepairs ?? 1))
      : 0;
    let repairs = 0;
    while (evalObj && !evalObj.success && repairs < maxRepairs) {
      const failedSteps = Array.isArray(evalObj.failedSteps) && evalObj.failedSteps.length
        ? evalObj.failedSteps.filter((f) => typeof f?.stepId === 'string' && f.stepId.trim())
        : [];
      if (failedSteps.length === 0) break;

      const stepIdToIndex = new Map((plan.steps || []).map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId : '', idx]).filter(([k]) => k));
      const failedIndices = Array.from(new Set(failedSteps.map((f) => {
        const sid = typeof f?.stepId === 'string' ? f.stepId.trim() : '';
        const idx = sid ? stepIdToIndex.get(sid) : undefined;
        return Number.isFinite(idx) ? idx : NaN;
      }).filter((x) => Number.isFinite(x)))).sort((a, b) => a - b);

      const retryChain = buildDependencyChain(plan.steps, failedIndices);
      const retryIndices = Array.from(retryChain).sort((a, b) => a - b);

      const history = await HistoryStore.list(runId, 0, -1);
      const prior = history
        .filter((h) => h.type === 'tool_result' && Number(h.result?.success) === 1)
        .map((h) => ({ aiName: h.aiName, args: h.args, result: h.result, data: h.result?.data }));

      await HistoryStore.append(runId, {
        type: 'retry_begin',
        failedSteps: failedSteps.map((f) => ({ stepId: f.stepId, displayIndex: f.displayIndex, aiName: f.aiName, reason: f.reason })),
        repairIndex: repairs + 1
      });

      if (config.flags.enableVerboseSteps) {
        logger.info('Retrying failed steps and dependency chain', {
          label: 'RETRY',
          originalFailed: failedIndices,
          retryChain: retryIndices,
          chainSize: retryIndices.length,
          failedSteps: failedSteps.map((f) => `stepId=${f.stepId} displayIndex=${f.displayIndex} (${f.aiName}): ${f.reason}`)
        });
      }

      const retryExec = await executePlan(runId, objective, mcpcore, plan, {
        retrySteps: retryIndices,  // Retry all failed steps plus their downstream dependency chain.
        seedRecent: prior,
        conversation,
        context: ctx,
        runtimeSignalCursorTs: Number(exec?.runtimeSignalCursorTs || 0),
        runtimeSignalGeneration: Number(exec?.runtimeSignalGeneration || 0),
        runtimeSignalSeq: Number(exec?.runtimeSignalSeq || 0)
      });

      await HistoryStore.append(runId, {
        type: 'retry_done',
        failedSteps: failedSteps.map((f) => ({ stepId: f.stepId, displayIndex: f.displayIndex, aiName: f.aiName, reason: f.reason })),
        repairIndex: repairs + 1,
        exec: retryExec
      });

      const updatedHistory = await HistoryStore.list(runId, 0, -1);
      const allToolResults = updatedHistory.filter((h) => h.type === 'tool_result');
      const globalUsed = allToolResults.map((h) => ({
        aiName: h.aiName,
        args: h.args,
        result: h.result
      }));
      const globalSucceeded = allToolResults.filter((h) => Number(h.result?.success) === 1).length;
      const globalExec = {
        used: globalUsed,
        attempted: allToolResults.length,
        succeeded: globalSucceeded,
        successRate: allToolResults.length ? globalSucceeded / allToolResults.length : 0
      };
      exec = globalExec;

      evalObj = await runEvaluateStage({ objective, plan, exec, runId, context: ctx });
      repairs++;
    }

    await HistoryStore.append(runId, { type: 'done', exec });

    const enableSummary = config.flags?.enableSummary !== false && !runtimeControl.skipSummary;
    const summarySkipped = enableSummary && shouldSkipSummaryByEval(evalObj);
    const summaryResult = !enableSummary
      ? {
        success: true,
        summary: '',
        skipped: true,
        reason: runtimeControl.skipSummary ? 'runtime_control_skip_summary' : 'summary_disabled'
      }
      : summarySkipped
        ? {
          success: true,
          summary: String(evalObj?.summary || ''),
          skipped: true,
          reason: 'evaluation_success'
        }
        : await summarizeToolHistory(runId, '', ctx);

    if (enableSummary && !summarySkipped && !summaryResult.success && config.flags.enableVerboseSteps) {
      logger.warn('Summary stage failed', {
        label: 'RUN',
        runId,
        error: summaryResult.error,
        attempts: summaryResult.attempts
      });
    }

    const summary = summaryResult.summary || '';

    const okres = ok({
      runId,
      plan,
      exec,
      eval: evalObj,
      summary,
      summaryResult  // Full summary stage payload for debugging and downstream consumers.
    });
    if (config.flags.enableVerboseSteps) {
      logger.info('Run completed', { label: 'RUN', runId, attempted: exec.attempted, succeeded: exec.succeeded, successRate: exec.successRate });
    }
    return okres;
  } finally {
    const cancelled = isRunCancelled(runId);
    await persistRuntimeRunFinal({
      runId,
      context: ctx,
      objective,
      status: cancelled ? 'cancelled' : 'completed',
      reasonCode: cancelled ? RUNTIME_REASON_CODE.runCancelled : RUNTIME_REASON_CODE.runFinished,
      source: 'planners.planThenExecute.finally'
    });
    try { markRunFinished(runId, { cancelled }); } catch { }
    try { removeRun(runId); } catch { }
    try { clearRunCancelled(runId); } catch { }
  }
}

export async function* planThenExecuteStream({ objective, context = {}, mcpcore, conversation, pollIntervalMs = 200, forceNeedTools = false }) {
  const runId = resolveRuntimeRunId(context);
  const sub = RunEvents.subscribe(runId);
  const { ctx } = createRuntimeContext({
    runId,
    objective,
    context,
    registerRunStart,
    injectConcurrencyOverlay
  });
  const runtimeControl = resolveRuntimeControl(ctx);

  // Producer: run the workflow in background while emitting events
  (async () => {
    try {
      // Start
      await emitRunStart({
        runId,
        objective,
        context: ctx,
        sanitizeContextForLog,
        emitRunEvent,
        historyStore: HistoryStore
      });
      if (runtimeControl.enabled) {
        const runtimeControlEvent = {
          type: 'runtime_control',
          phase: 'plan_then_execute_stream',
          reason: String(runtimeControl.reason || ''),
          singlePass: runtimeControl.singlePass === true,
          skipEvaluation: runtimeControl.skipEvaluation === true,
          skipSummary: runtimeControl.skipSummary === true,
          disableAdaptive: runtimeControl.disableAdaptive === true,
          disablePlanRepair: runtimeControl.disablePlanRepair === true,
          disableArgFixRetry: runtimeControl.disableArgFixRetry === true
        };
        emitRunEvent(runId, runtimeControlEvent);
        await HistoryStore.append(runId, runtimeControlEvent);
      }

      const resumePlan = await resolveResumePlanFromRuntimeCheckpoint({
        runId,
        context: ctx,
        normalizePlanFn: normalizePlanStepIds
      });
      let judge;
      let activePlan;
      let activeObjective = objective;
      if (resumePlan.enabled) {
        activePlan = resumePlan.plan;
        judge = {
          need: true,
          summary: 'resume_executor_checkpoint_plan',
          toolNames: Array.isArray(activePlan?.manifest)
            ? activePlan.manifest.map((m) => String(m?.aiName || '').trim()).filter(Boolean)
            : [],
          ok: true,
          forced: true,
          resumed: true
        };
        emitRunEvent(runId, {
          type: 'resume_executor_applied',
          reason: String(resumePlan.reason || ''),
          checkpointStage: String(resumePlan?.checkpoint?.stage || ''),
          checkpointStatus: String(resumePlan?.checkpoint?.status || ''),
          checkpointUpdatedAt: Number(resumePlan?.checkpoint?.updatedAt || 0),
          resumeCursorIndex: Number(resumePlan.resumeCursorIndex || 0),
          planSignature: String(resumePlan.planSignature || ''),
          checkpointPlanSignature: String(resumePlan.checkpointSignature || ''),
          totalSteps: Number(activePlan?.steps?.length || 0)
        });
        await HistoryStore.append(runId, {
          type: 'resume_executor_applied',
          reason: String(resumePlan.reason || ''),
          checkpointStage: String(resumePlan?.checkpoint?.stage || ''),
          checkpointStatus: String(resumePlan?.checkpoint?.status || ''),
          checkpointUpdatedAt: Number(resumePlan?.checkpoint?.updatedAt || 0),
          resumeCursorIndex: Number(resumePlan.resumeCursorIndex || 0),
          planSignature: String(resumePlan.planSignature || ''),
          checkpointPlanSignature: String(resumePlan.checkpointSignature || ''),
          totalSteps: Number(activePlan?.steps?.length || 0)
        });
        emitRunEvent(runId, {
          type: 'judge',
          need: true,
          summary: String(judge.summary || ''),
          toolNames: judge.toolNames,
          ok: true,
          forced: true
        });
        await HistoryStore.append(runId, {
          type: 'judge',
          need: true,
          summary: String(judge.summary || ''),
          toolNames: judge.toolNames,
          ok: true,
          forced: true
        });
        const resumeToolGateEvent = buildToolGateEvent({
          judge,
          manifest: Array.isArray(activePlan?.manifest) ? activePlan.manifest : []
        });
        emitRunEvent(runId, resumeToolGateEvent);
        await HistoryStore.append(runId, resumeToolGateEvent);
        await HistoryStore.setPlan(runId, activePlan);
        emitRunEvent(runId, { type: 'plan', plan: activePlan, resumedFromCheckpoint: true });
        await HistoryStore.append(runId, { type: 'plan', plan: activePlan, resumedFromCheckpoint: true });
      } else {
        const manifest0 = await buildJudgeManifestWithPrefilter({
          objective,
          baseManifest: buildPlanningManifest(mcpcore),
          context: ctx
        });

        judge = await runJudgeStage({
          objective,
          manifest: manifest0,
          conversation,
          context: ctx,
          forceNeedTools
        });
        emitRunEvent(runId, {
          type: 'judge',
          need: judge.need,
          summary: judge.summary,
          toolNames: judge.toolNames,
          ok: judge.ok !== false,
          forced: !!judge.forced
        });
        await HistoryStore.append(runId, {
          type: 'judge',
          need: judge.need,
          summary: judge.summary,
          toolNames: judge.toolNames,
          ok: judge.ok !== false,
          forced: !!judge.forced
        });
        const toolGateEvent = buildToolGateEvent({ judge, manifest: manifest0 });
        emitRunEvent(runId, toolGateEvent);
        await HistoryStore.append(runId, toolGateEvent);
        if (judge && judge.ok === false) {
          const plan0 = { manifest: manifest0, steps: [] };
          const plan = normalizePlanStepIds(plan0);
          await HistoryStore.setPlan(runId, plan);
          emitRunEvent(runId, { type: 'plan', plan });
          await HistoryStore.append(runId, { type: 'plan', plan });
          const exec = { used: [], attempted: 0, succeeded: 0, successRate: 0 };
          emitRunEvent(runId, { type: 'done', exec });
          await HistoryStore.append(runId, { type: 'done', exec });
          const summary = String(judge.summary || 'Judge stage failed');
          try { await HistoryStore.setSummary(runId, summary); } catch { }
          emitRunEvent(runId, { type: 'summary', summary });
          await HistoryStore.append(runId, { type: 'summary', summary });
          return;
        }
        if (!judge.need) {
          const plan0 = { manifest: manifest0, steps: [] };
          const plan = normalizePlanStepIds(plan0);
          await HistoryStore.setPlan(runId, plan);
          emitRunEvent(runId, { type: 'plan', plan });
          await HistoryStore.append(runId, { type: 'plan', plan });
          const noToolsResultEvent = buildNoToolsResultGroupEvent({
            reasonCode: NO_TOOL_REASON_CODE.judgeNoTools,
            reason: String(judge.summary || '').trim() || 'Judge determined no MCP tool invocation is needed',
            summary: 'No tool invocation was required for this run.'
          });
          emitRunEvent(runId, noToolsResultEvent);
          await HistoryStore.append(runId, noToolsResultEvent);
          const exec = { used: [], attempted: 0, succeeded: 0, successRate: 1 };
          emitRunEvent(runId, { type: 'done', exec });
          await HistoryStore.append(runId, { type: 'done', exec });
          const summary = 'No tool invocation was required for this run.';
          try { await HistoryStore.setSummary(runId, summary); } catch { }
          emitRunEvent(runId, { type: 'summary', summary });
          await HistoryStore.append(runId, { type: 'summary', summary });
          return;
        }

        // Plan (after judge)
        activePlan = await runPlanStage({
          objective,
          mcpcore,
          context: ctx,
          conversation,
          runId,
          judge,
          generatePlanFn: generatePlan,
          normalizePlanFn: normalizePlanStepIds
        });
        await HistoryStore.setPlan(runId, activePlan);
        emitRunEvent(runId, { type: 'plan', plan: activePlan });
        await HistoryStore.append(runId, { type: 'plan', plan: activePlan });
        if (isPlanEmpty(activePlan)) {
          logger.info('Plan returned empty steps; finish stream run as no-tools', { label: 'PLAN', runId, reason: 'empty_plan_short_circuit' });
          const noToolsResultEvent = buildNoToolsResultGroupEvent({
            reasonCode: NO_TOOL_REASON_CODE.emptyPlan,
            reason: 'Planner returned an empty executable plan',
            summary: 'No tool invocation was required for this run (empty plan).'
          });
          emitRunEvent(runId, noToolsResultEvent);
          await HistoryStore.append(runId, noToolsResultEvent);
          const exec = { used: [], attempted: 0, succeeded: 0, successRate: 1 };
          emitRunEvent(runId, { type: 'done', exec });
          await HistoryStore.append(runId, { type: 'done', exec });
          const summary = 'No tool invocation was required for this run (empty plan).';
          try { await HistoryStore.setSummary(runId, summary); } catch { }
          emitRunEvent(runId, { type: 'summary', summary });
          await HistoryStore.append(runId, { type: 'summary', summary });
          return;
        }
      }

      // Execute concurrently (existing executor emits args/tool_result events)
      let exec = await executePlan(runId, activeObjective, mcpcore, activePlan, { conversation, context: ctx });
      let adaptiveRoundsUsed = 0;
      let latestFeedbackTs = Number(exec?.runtimeSignalCursorTs || 0);
      let finalAction = 'perfect';
      let evalObj = null;

      let runtimeDirective = (exec && typeof exec === 'object' && exec.runtimeDirective && typeof exec.runtimeDirective === 'object')
        ? exec.runtimeDirective
        : null;

      if (!runtimeControl.disableAdaptive && runtimeDirective && (runtimeDirective.action === 'replan' || runtimeDirective.action === 'supplement')) {
        adaptiveRoundsUsed = 1;
        finalAction = runtimeDirective.action;
        activeObjective = buildRuntimeAdaptiveObjective({
          baseObjective: objective,
          runtimeDirective,
          round: adaptiveRoundsUsed
        });

        const triggerEvent = {
          type: 'runtime_adaptive_trigger',
          action: runtimeDirective.action,
          reason: String(runtimeDirective.reason || ''),
          message: String(runtimeDirective.message || ''),
          adaptiveRoundsUsed,
          maxAdaptiveRounds: 1,
        };
        emitRunEvent(runId, triggerEvent);
        await HistoryStore.append(runId, triggerEvent);

        activePlan = await runPlanStage({
          objective: activeObjective,
          mcpcore,
          context: {
            ...ctx,
            adaptiveRound: adaptiveRoundsUsed,
            adaptiveAction: runtimeDirective.action,
            previousRuntimeDirective: runtimeDirective,
            previousObjective: objective
          },
          conversation,
          runId,
          judge,
          generatePlanFn: generatePlan,
          normalizePlanFn: normalizePlanStepIds
        });

        await HistoryStore.setPlan(runId, activePlan);
        emitRunEvent(runId, {
          type: 'plan',
          plan: activePlan,
          adaptive: true,
          adaptiveRound: adaptiveRoundsUsed,
          adaptiveAction: runtimeDirective.action,
          runtimeDriven: true,
        });
        await HistoryStore.append(runId, {
          type: 'plan',
          plan: activePlan,
          adaptive: true,
          adaptiveRound: adaptiveRoundsUsed,
          adaptiveAction: runtimeDirective.action,
          runtimeDriven: true,
        });

        exec = await executePlan(runId, activeObjective, mcpcore, activePlan, {
          conversation,
          context: ctx,
          runtimeSignalCursorTs: Number(exec?.runtimeSignalCursorTs || latestFeedbackTs || 0),
          runtimeSignalGeneration: Number(exec?.runtimeSignalGeneration || 0),
          runtimeSignalSeq: Number(exec?.runtimeSignalSeq || 0)
        });
        latestFeedbackTs = Number(exec?.runtimeSignalCursorTs || latestFeedbackTs || 0);
        runtimeDirective = (exec && typeof exec === 'object' && exec.runtimeDirective && typeof exec.runtimeDirective === 'object')
          ? exec.runtimeDirective
          : runtimeDirective;
      }

      // cancellation still uses unified terminal stream: tool_result(runtime__control) -> done -> completed -> summary
      if (isRunCancelled(runId)) {
        if (config.flags.enableVerboseSteps) {
          logger.info('Run cancelled after executePlan, skip evaluation/reflection/summary', { label: 'RUN', runId });
        }
        await emitCancelledTerminalEvents({
          runId,
          exec,
          summary: String(runtimeDirective?.reason || 'Run cancelled by upstream request. Preserve finished tool results and stop follow-up evaluation.')
        });
        return;
      }

      if (runtimeControl.skipEvaluation) {
        evalObj = buildSkippedEvalResult(runtimeControl.reason || 'runtime_control_skip_evaluation');
        finalAction = 'perfect';
        const evSkipped = {
          type: 'evaluation_skipped',
          reason: String(runtimeControl.reason || 'runtime_control_skip_evaluation')
        };
        emitRunEvent(runId, evSkipped);
        await HistoryStore.append(runId, evSkipped);
      } else {
        const maxAdaptiveRounds = runtimeControl.disableAdaptive ? adaptiveRoundsUsed : 1;
        while (true) {
          const currentRound = adaptiveRoundsUsed + 1;
          const roundResult = await runFeedbackEvaluationRound({
            runId,
            objective: activeObjective,
            plan: activePlan,
            exec,
            context: ctx,
            round: currentRound,
            sinceTs: latestFeedbackTs,
            adaptiveRoundsUsed,
            maxAdaptiveRounds,
            waitForAssistantFeedbackBatches,
            runEvaluateStage,
            normalizeEvalAction,
            emitRunEvent,
            historyStore: HistoryStore
          });
          latestFeedbackTs = roundResult.nextSinceTs;
          evalObj = roundResult.evalObj;
          finalAction = roundResult.finalAction;
          const canAdaptive = !!roundResult.canAdaptive;

          if (!canAdaptive) break;

          adaptiveRoundsUsed += 1;
          const previousObjective = activeObjective;
          const adaptiveObjective = buildAdaptiveObjective({
            baseObjective: objective,
            action: finalAction,
            evalObj,
            round: adaptiveRoundsUsed,
          });
          activeObjective = adaptiveObjective;

          activePlan = await runPlanStage({
            objective: adaptiveObjective,
            mcpcore,
            context: {
              ...ctx,
              adaptiveRound: adaptiveRoundsUsed,
              adaptiveAction: finalAction,
              previousEval: evalObj,
              previousObjective
            },
            conversation,
            runId,
            judge,
            generatePlanFn: generatePlan,
            normalizePlanFn: normalizePlanStepIds
          });

          await HistoryStore.setPlan(runId, activePlan);
          emitRunEvent(runId, {
            type: 'plan',
            plan: activePlan,
            adaptive: true,
            adaptiveRound: adaptiveRoundsUsed,
            adaptiveAction: finalAction,
          });
          await HistoryStore.append(runId, {
            type: 'plan',
            plan: activePlan,
            adaptive: true,
            adaptiveRound: adaptiveRoundsUsed,
            adaptiveAction: finalAction,
          });

          const historyForRetry = await HistoryStore.list(runId, 0, -1);
          const prior = historyForRetry
            .filter((h) => h.type === 'tool_result' && Number(h.result?.success) === 1)
            .map((h) => ({ aiName: h.aiName, args: h.args, result: h.result, data: h.result?.data }));

          exec = await executePlan(runId, adaptiveObjective, mcpcore, activePlan, {
            seedRecent: prior,
            conversation,
            context: ctx,
            runtimeSignalCursorTs: Number(exec?.runtimeSignalCursorTs || 0),
            runtimeSignalGeneration: Number(exec?.runtimeSignalGeneration || 0),
            runtimeSignalSeq: Number(exec?.runtimeSignalSeq || 0)
          });

          if (isRunCancelled(runId)) {
            if (config.flags.enableVerboseSteps) {
              logger.info('Run cancelled during adaptive round, stop before summary', { label: 'RUN', runId, adaptiveRoundsUsed });
            }
            const summary = 'Run cancelled during adaptive replan phase. Keep finished tool results only.';
            await emitCancelledTerminalEvents({ runId, exec, summary, adaptiveRoundsUsed, evaluation: evalObj });
            return;
          }
        }
      }

      emitRunEvent(runId, { type: 'done', exec });
      await HistoryStore.append(runId, { type: 'done', exec });

      const enableSummary = config.flags?.enableSummary !== false && !runtimeControl.skipSummary;
      const summarySkipped = enableSummary && shouldSkipSummaryByEval(evalObj);
      emitRunEvent(runId, {
        type: 'completed',
        exec,
        evaluation: evalObj,
        finalAction,
        adaptiveRoundsUsed,
        summaryPending: enableSummary && !summarySkipped,
        resultStream: true,
        resultStatus: 'final'
      });
      await HistoryStore.append(runId, {
        type: 'completed',
        exec,
        evaluation: evalObj,
        finalAction,
        adaptiveRoundsUsed,
        summaryPending: enableSummary && !summarySkipped,
        resultStream: true,
        resultStatus: 'final'
      });

      if (enableSummary) {
        let summaryResult;
        if (summarySkipped) {
          summaryResult = {
            success: true,
            summary: String(evalObj?.summary || ''),
            skipped: true,
            reason: 'evaluation_success'
          };
        } else {
          summaryResult = await summarizeToolHistory(runId, '', ctx);

          if (!summaryResult.success && config.flags.enableVerboseSteps) {
            logger.warn('Summary stage failed', {
              label: 'RUN',
              runId,
              error: summaryResult.error,
              attempts: summaryResult.attempts
            });
          }
        }

        const summary = summaryResult.summary || '';
        try { await HistoryStore.setSummary(runId, summary); } catch { }

        emitRunEvent(runId, {
          type: 'summary',
          summary,
          success: summaryResult.success,
          error: summaryResult.error,
          attempts: summaryResult.attempts,
          skipped: summaryResult.skipped === true,
          reason: summaryResult.reason
        });
        await HistoryStore.append(runId, {
          type: 'summary',
          summary,
          success: summaryResult.success,
          error: summaryResult.error,
          attempts: summaryResult.attempts,
          skipped: summaryResult.skipped === true,
          reason: summaryResult.reason
        });
      }
    } catch (e) {
      emitRunEvent(runId, { type: 'done', error: String(e) });
      await HistoryStore.append(runId, { type: 'done', error: String(e) });
    } finally {
      await cleanupRuntimeRun({
        runId,
        sub,
        isRunCancelled,
        markRunFinished,
        removeRun,
        closeRunEvents: (rid) => RunEvents.close(rid),
        clearRunCancelled,
        context: ctx,
        objective
      });
    }
  })();

  try {
    for await (const ev of sub) {
      yield ev;
      if (ev?.type === 'completed' || ev?.type === 'summary') break;
    }
  } finally {
    await cleanupRuntimeRun({
      runId,
      sub,
      isRunCancelled,
      markRunFinished,
      removeRun,
      closeRunEvents: (rid) => RunEvents.close(rid),
      clearRunCancelled,
      context: ctx,
      objective
    });
  }
}

export async function* planThenExecuteStreamToolsXml({ objective, toolsXml, context = {}, mcpcore, conversation }) {
  const runId = resolveRuntimeRunId(context);
  const sub = RunEvents.subscribe(runId);
  const { ctx } = createRuntimeContext({
    runId,
    objective,
    context,
    registerRunStart,
    injectConcurrencyOverlay
  });
  const runtimeControl = resolveRuntimeControl(ctx);

  (async () => {
    try {
      await emitRunStart({
        runId,
        objective,
        context: ctx,
        sanitizeContextForLog,
        emitRunEvent,
        historyStore: HistoryStore
      });
      if (runtimeControl.enabled) {
        const runtimeControlEvent = {
          type: 'runtime_control',
          phase: 'plan_then_execute_stream_tools_xml',
          reason: String(runtimeControl.reason || ''),
          singlePass: runtimeControl.singlePass === true,
          skipEvaluation: runtimeControl.skipEvaluation === true,
          skipSummary: runtimeControl.skipSummary === true,
          disableAdaptive: runtimeControl.disableAdaptive === true,
          disablePlanRepair: runtimeControl.disablePlanRepair === true,
          disableArgFixRetry: runtimeControl.disableArgFixRetry === true
        };
        emitRunEvent(runId, runtimeControlEvent);
        await HistoryStore.append(runId, runtimeControlEvent);
      }

      let manifest0 = buildPlanningManifest(mcpcore);

      const judge = { need: true, summary: 'direct_tools_xml', toolNames: [], ok: true, forced: true };
      emitRunEvent(runId, {
        type: 'judge',
        need: true,
        summary: judge.summary,
        toolNames: judge.toolNames,
        ok: true,
        forced: true
      });
      await HistoryStore.append(runId, {
        type: 'judge',
        need: true,
        summary: judge.summary,
        toolNames: judge.toolNames,
        ok: true,
        forced: true
      });
      const toolGateEvent = buildToolGateEvent({ judge, manifest: manifest0 });
      emitRunEvent(runId, toolGateEvent);
      await HistoryStore.append(runId, toolGateEvent);

      const rawToolsXml = String(toolsXml || '').trim();
      const calls = parseFunctionCalls(rawToolsXml, { format: (config.fcLlm?.format || 'sentra') });
      const steps = (Array.isArray(calls) ? calls : [])
        .filter((c) => c && typeof c === 'object')
        .map((c) => {
          const rawName = String(c.name || '').trim();
          const isTerminal = rawName === TERMINAL_RUNTIME_ACTION
            || rawName === TERMINAL_RUNTIME_AI_NAME;
          return {
            stepId: newStepId(),
            aiName: isTerminal ? TERMINAL_RUNTIME_AI_NAME : rawName,
            executor: isTerminal ? 'sandbox' : 'mcp',
            actionRef: isTerminal ? TERMINAL_RUNTIME_ACTION : undefined,
            reason: ['direct_tools_xml'],
            nextStep: '',
            draftArgs: (c.arguments && typeof c.arguments === 'object') ? c.arguments : {},
            dependsOnStepIds: undefined
          };
        })
        .filter((s) => s.aiName);

      const plan0 = { manifest: manifest0, steps };
      const plan = normalizePlanStepIds(plan0);
      await HistoryStore.setPlan(runId, plan);
      emitRunEvent(runId, { type: 'plan', plan });
      await HistoryStore.append(runId, { type: 'plan', plan });
      if (isPlanEmpty(plan)) {
        logger.info('Direct tools xml produced empty steps; finish as no-tools run', { label: 'PLAN', runId, reason: 'empty_plan_short_circuit' });
        const noToolsResultEvent = buildNoToolsResultGroupEvent({
          reasonCode: NO_TOOL_REASON_CODE.emptyDirectToolsPlan,
          reason: 'Direct tools XML produced no executable calls',
          summary: 'No tool invocation was required for this run (empty direct tools plan).'
        });
        emitRunEvent(runId, noToolsResultEvent);
        await HistoryStore.append(runId, noToolsResultEvent);
        const exec = { used: [], attempted: 0, succeeded: 0, successRate: 1 };
        emitRunEvent(runId, { type: 'done', exec });
        await HistoryStore.append(runId, { type: 'done', exec });
        const summary = 'No tool invocation was required for this run (empty direct tools plan).';
        try { await HistoryStore.setSummary(runId, summary); } catch { }
        emitRunEvent(runId, { type: 'summary', summary });
        await HistoryStore.append(runId, { type: 'summary', summary });
        return;
      }

      let exec = await executePlan(runId, objective, mcpcore, plan, { conversation, context: ctx });
      let activePlan = plan;
      let activeObjective = objective;
      let adaptiveRoundsUsed = 0;

      let runtimeDirective = (exec && typeof exec === 'object' && exec.runtimeDirective && typeof exec.runtimeDirective === 'object')
        ? exec.runtimeDirective
        : null;

      if (!runtimeControl.disableAdaptive && runtimeDirective && (runtimeDirective.action === 'replan' || runtimeDirective.action === 'supplement')) {
        adaptiveRoundsUsed = 1;
        activeObjective = buildRuntimeAdaptiveObjective({
          baseObjective: objective,
          runtimeDirective,
          round: adaptiveRoundsUsed
        });
        activePlan = await runPlanStage({
          objective: activeObjective,
          mcpcore,
          context: {
            ...ctx,
            adaptiveRound: adaptiveRoundsUsed,
            adaptiveAction: runtimeDirective.action,
            previousRuntimeDirective: runtimeDirective,
            previousObjective: objective
          },
          conversation,
          runId,
          judge,
          generatePlanFn: generatePlan,
          normalizePlanFn: normalizePlanStepIds
        });
        await HistoryStore.setPlan(runId, activePlan);
        emitRunEvent(runId, {
          type: 'plan',
          plan: activePlan,
          adaptive: true,
          adaptiveRound: adaptiveRoundsUsed,
          adaptiveAction: runtimeDirective.action,
          runtimeDriven: true,
        });
        await HistoryStore.append(runId, {
          type: 'plan',
          plan: activePlan,
          adaptive: true,
          adaptiveRound: adaptiveRoundsUsed,
          adaptiveAction: runtimeDirective.action,
          runtimeDriven: true,
        });

        exec = await executePlan(runId, activeObjective, mcpcore, activePlan, {
          conversation,
          context: ctx,
          runtimeSignalCursorTs: Number(exec?.runtimeSignalCursorTs || 0),
          runtimeSignalGeneration: Number(exec?.runtimeSignalGeneration || 0),
          runtimeSignalSeq: Number(exec?.runtimeSignalSeq || 0)
        });
        runtimeDirective = (exec && typeof exec === 'object' && exec.runtimeDirective && typeof exec.runtimeDirective === 'object')
          ? exec.runtimeDirective
          : runtimeDirective;
      }

      if (isRunCancelled(runId)) {
        const summary = String(runtimeDirective?.reason || 'Run cancelled by upstream request (user intent changed). Preserve completed tool results only.');
        await emitCancelledTerminalEvents({ runId, exec, summary });
        return;
      }

      let evalObj = null;
      let finalAction = 'perfect';
      if (runtimeControl.skipEvaluation) {
        evalObj = buildSkippedEvalResult(runtimeControl.reason || 'runtime_control_skip_evaluation');
        const evSkipped = {
          type: 'evaluation_skipped',
          reason: String(runtimeControl.reason || 'runtime_control_skip_evaluation')
        };
        emitRunEvent(runId, evSkipped);
        await HistoryStore.append(runId, evSkipped);
      } else {
        const currentRound = 1;
        const feedbackSinceTsBase = Number(exec?.runtimeSignalCursorTs || 0);
        const roundResult = await runFeedbackEvaluationRound({
          runId,
          objective: activeObjective,
          plan: activePlan,
          exec,
          context: ctx,
          round: currentRound,
          sinceTs: feedbackSinceTsBase,
          adaptiveRoundsUsed,
          maxAdaptiveRounds: runtimeControl.disableAdaptive ? adaptiveRoundsUsed : 1,
          waitForAssistantFeedbackBatches,
          runEvaluateStage,
          normalizeEvalAction,
          emitRunEvent,
          historyStore: HistoryStore
        });
        evalObj = roundResult.evalObj;
        finalAction = roundResult.finalAction;
      }

      emitRunEvent(runId, { type: 'done', exec });
      await HistoryStore.append(runId, { type: 'done', exec });

      const enableSummary = config.flags?.enableSummary !== false && !runtimeControl.skipSummary;
      const summarySkipped = enableSummary && shouldSkipSummaryByEval(evalObj);
      emitRunEvent(runId, {
        type: 'completed',
        exec,
        evaluation: evalObj,
        finalAction,
        adaptiveRoundsUsed,
        summaryPending: enableSummary && !summarySkipped,
        resultStream: true,
        resultStatus: 'final'
      });
      await HistoryStore.append(runId, {
        type: 'completed',
        exec,
        evaluation: evalObj,
        finalAction,
        adaptiveRoundsUsed,
        summaryPending: enableSummary && !summarySkipped,
        resultStream: true,
        resultStatus: 'final'
      });

      if (enableSummary) {
        const summaryResult = summarySkipped
          ? {
            success: true,
            summary: String(evalObj?.summary || ''),
            skipped: true,
            reason: 'evaluation_success'
          }
          : await summarizeToolHistory(runId, '', ctx);
        const summary = summaryResult.summary || '';
        try { await HistoryStore.setSummary(runId, summary); } catch { }
        emitRunEvent(runId, {
          type: 'summary',
          summary,
          success: summaryResult.success,
          error: summaryResult.error,
          attempts: summaryResult.attempts,
          skipped: summaryResult.skipped === true,
          reason: summaryResult.reason
        });
        await HistoryStore.append(runId, {
          type: 'summary',
          summary,
          success: summaryResult.success,
          error: summaryResult.error,
          attempts: summaryResult.attempts,
          skipped: summaryResult.skipped === true,
          reason: summaryResult.reason
        });
      }
    } catch (e) {
      emitRunEvent(runId, { type: 'done', error: String(e) });
      await HistoryStore.append(runId, { type: 'done', error: String(e) });
    } finally {
      await cleanupRuntimeRun({
        runId,
        sub,
        isRunCancelled,
        markRunFinished,
        removeRun,
        closeRunEvents: (rid) => RunEvents.close(rid),
        clearRunCancelled,
        context: ctx,
        objective
      });
    }
  })();

  try {
    for await (const ev of sub) {
      yield ev;
      if (ev?.type === 'completed' || ev?.type === 'summary') break;
    }
  } finally {
    await cleanupRuntimeRun({
      runId,
      sub,
      isRunCancelled,
      markRunFinished,
      removeRun,
      closeRunEvents: (rid) => RunEvents.close(rid),
      clearRunCancelled,
      context: ctx,
      objective
    });
  }
}

export default { generatePlan, executePlan, evaluateRun, planThenExecute, planThenExecuteStream };




