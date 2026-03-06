import { AsyncLocalStorage } from 'node:async_hooks';

const runtimeContextStorage = new AsyncLocalStorage();

export function runWithRuntimeContext(context, fn) {
  const ctx = (context && typeof context === 'object') ? context : {};
  return runtimeContextStorage.run(ctx, fn);
}

export function getRuntimeContext() {
  return runtimeContextStorage.getStore() || null;
}

export function getRuntimeSignal() {
  const ctx = getRuntimeContext();
  return ctx?.signal || null;
}

export function getRuntimeRunId() {
  const ctx = getRuntimeContext();
  const runId = String(ctx?.runId || '').trim();
  return runId || '';
}

export default {
  runWithRuntimeContext,
  getRuntimeContext,
  getRuntimeSignal,
  getRuntimeRunId,
};
