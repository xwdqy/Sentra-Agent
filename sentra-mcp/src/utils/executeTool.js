import { runWithRuntimeContext } from './runtime_context.js';
import { mergeAbortSignals, makeAbortError } from './signal.js';
import { registerRunAbortController } from '../bus/runAbort.js';
import { ensureRuntimeFetchPatched } from './fetch_runtime_patch.js';

function normalizeRuntime(options = {}) {
  const runtime0 = (options?.runtime && typeof options.runtime === 'object') ? options.runtime : {};
  const out = { ...runtime0 };

  if (!out.runId && options?.runId) out.runId = String(options.runId);
  if (!Number.isFinite(Number(out.stepIndex)) && Number.isFinite(Number(options?.stepIndex))) {
    out.stepIndex = Number(options.stepIndex);
  }
  return out;
}

function attachTimeoutController(timeoutController, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  return setTimeout(() => {
    try { onTimeout?.(); } catch { }
    try {
      timeoutController.abort(
        makeAbortError(`Timeout after ${timeoutMs} ms`, 'TIMEOUT', { timeoutMs })
      );
    } catch { }
  }, timeoutMs);
}

function buildAbortPromise(signal) {
  if (!signal) return null;
  return new Promise((_, reject) => {
    const rejectWithReason = () => {
      const reason = signal.reason;
      if (reason && typeof reason === 'object') {
        reject(reason);
        return;
      }
      reject(makeAbortError('Run aborted', 'RUN_ABORTED', { reason }));
    };

    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener('abort', rejectWithReason, { once: true });
  });
}

export async function executeToolWithTimeout(fn, ms, options = {}) {
  ensureRuntimeFetchPatched();
  const onTimeout = options.onTimeout;
  const timeoutMs = Number(ms);
  const runtime = normalizeRuntime(options);

  const timeoutController = new AbortController();
  const upstreamSignal = runtime?.signal || options?.signal || null;
  const mergedSignal = mergeAbortSignals([timeoutController.signal, upstreamSignal]);

  const startedAt = Date.now();
  const runtimeCtx = {
    ...runtime,
    startedAt,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0,
    deadlineAt: Number.isFinite(timeoutMs) && timeoutMs > 0 ? startedAt + timeoutMs : 0,
    signal: mergedSignal || upstreamSignal || timeoutController.signal,
  };

  const unregisterAbort = registerRunAbortController(runtimeCtx.runId, timeoutController, {
    stepIndex: runtimeCtx.stepIndex,
    source: String(runtimeCtx.source || options?.source || ''),
  });

  const timer = attachTimeoutController(timeoutController, timeoutMs, onTimeout);

  try {
    const runPromise = runWithRuntimeContext(runtimeCtx, () => Promise.resolve().then(() => fn()));
    const abortPromise = buildAbortPromise(runtimeCtx.signal);
    if (!abortPromise) return await runPromise;
    return await Promise.race([runPromise, abortPromise]);
  } finally {
    try { if (timer) clearTimeout(timer); } catch { }
    try { unregisterAbort(); } catch { }
  }
}

export default { executeToolWithTimeout };
