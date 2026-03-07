import { getRuntimeSignal } from './runtime_context.js';
import { mergeAbortSignals } from './signal.js';

let patched = false;
let originalFetch = null;

export function ensureRuntimeFetchPatched() {
  if (patched) return;
  if (typeof globalThis === 'undefined' || typeof globalThis.fetch !== 'function') return;

  originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = function runtimeAwareFetch(input, init) {
    const runtimeSignal = getRuntimeSignal();
    if (!runtimeSignal) {
      return originalFetch(input, init);
    }

    const nextInit = init ? { ...init } : {};
    const mergedSignal = mergeAbortSignals([init?.signal, runtimeSignal]);
    if (mergedSignal) nextInit.signal = mergedSignal;

    return originalFetch(input, nextInit);
  };

  patched = true;
}

export default { ensureRuntimeFetchPatched };
