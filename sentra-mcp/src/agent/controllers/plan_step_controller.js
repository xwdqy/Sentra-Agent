import { newStepId } from '../../utils/stepIds.js';
import {
  TERMINAL_RUNTIME_AI_NAME,
  TERMINAL_RUNTIME_ACTION,
  isTerminalRuntimeStep
} from '../../runtime/terminal/spec.js';

const EXECUTOR_SET = new Set(['mcp', 'sandbox']);

function toStepObject(value) {
  return (value && typeof value === 'object') ? value : {};
}

function toText(value) {
  return String(value ?? '').trim();
}

export function normalizePlanReason(reason) {
  if (Array.isArray(reason)) {
    return reason.map((x) => toText(x)).filter(Boolean);
  }
  if (typeof reason === 'string' && reason.trim()) {
    return [reason.trim()];
  }
  return [];
}

export function normalizePlanSuccessCriteria(value) {
  const src = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const text = toText(item);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= 12) break;
  }
  return out;
}

export function normalizePlanExecutor(value, fallback = 'mcp') {
  const base = toText(value).toLowerCase();
  if (EXECUTOR_SET.has(base)) return base;
  if (base === 'runtime' || base === 'terminal') return 'sandbox';
  const fb = toText(fallback).toLowerCase();
  return EXECUTOR_SET.has(fb) ? fb : 'mcp';
}

export function normalizePlanStep(rawStep = {}, options = {}) {
  const raw = toStepObject(rawStep);
  const stepId = toText(raw.stepId) || newStepId();
  const aiNameRaw = toText(raw.aiName || raw.toolName || raw.toolRef);
  let executor = normalizePlanExecutor(raw.executor || raw.execution || raw.provider, options.defaultExecutor || 'mcp');
  let actionRef = toText(raw.actionRef || raw.action || raw.runtimeAction).toLowerCase();
  let aiName = aiNameRaw;

  if (aiName === TERMINAL_RUNTIME_AI_NAME) executor = 'sandbox';
  if (executor === 'sandbox') {
    if (!actionRef && (aiName === TERMINAL_RUNTIME_AI_NAME || !aiName)) actionRef = TERMINAL_RUNTIME_ACTION;
    if (!aiName && actionRef === TERMINAL_RUNTIME_ACTION) aiName = TERMINAL_RUNTIME_AI_NAME;
  }

  const reason = normalizePlanReason(raw.reason);
  const nextStep = toText(raw.nextStep);
  const draftArgs = (raw.draftArgs && typeof raw.draftArgs === 'object') ? { ...raw.draftArgs } : {};
  const successCriteria = normalizePlanSuccessCriteria(raw.successCriteria);
  const dependsRaw = Array.isArray(raw.dependsOnStepIds) ? raw.dependsOnStepIds : [];
  const dependsOnStepIds = dependsRaw.map((x) => toText(x)).filter(Boolean);

  return {
    stepId,
    aiName,
    executor,
    actionRef: actionRef || undefined,
    reason,
    successCriteria: successCriteria.length ? successCriteria : undefined,
    nextStep,
    draftArgs,
    dependsOnStepIds: dependsOnStepIds.length ? dependsOnStepIds : undefined
  };
}

export function isPlanStepAllowed(step = {}, options = {}) {
  const s = toStepObject(step);
  const allowSandbox = options.allowSandbox !== false;
  const allowedMcpAiNamesSet = options.allowedMcpAiNamesSet instanceof Set
    ? options.allowedMcpAiNamesSet
    : new Set();
  const executor = normalizePlanExecutor(s.executor || 'mcp', 'mcp');
  const aiName = toText(s.aiName);

  if (executor === 'sandbox') {
    if (!allowSandbox) return false;
    return isTerminalRuntimeStep(s);
  }
  if (!aiName) return false;
  if (allowedMcpAiNamesSet.size > 0) return allowedMcpAiNamesSet.has(aiName);
  return true;
}

export function mapAndFilterPlanSteps(rawSteps = [], options = {}) {
  const source = Array.isArray(rawSteps) ? rawSteps : [];
  const normalized = source.map((step) => normalizePlanStep(step, options));
  return normalized.filter((step) => isPlanStepAllowed(step, options));
}

export default {
  normalizePlanReason,
  normalizePlanExecutor,
  normalizePlanStep,
  isPlanStepAllowed,
  mapAndFilterPlanSteps
};
