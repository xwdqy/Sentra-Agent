export function makeAbortError(message = 'Aborted', code = 'RUN_ABORTED', extras = {}) {
  const err = new Error(String(message || 'Aborted'));
  err.name = 'AbortError';
  err.code = String(code || 'RUN_ABORTED');
  if (extras && typeof extras === 'object') {
    for (const [k, v] of Object.entries(extras)) {
      if (k === 'message' || k === 'name' || k === 'code') continue;
      try { err[k] = v; } catch { }
    }
  }
  return err;
}

export function isAbortLikeError(err) {
  if (!err) return false;
  const name = String(err?.name || '').toLowerCase();
  const code = String(err?.code || '').toUpperCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    name === 'aborterror' ||
    code === 'ABORT_ERR' ||
    code === 'RUN_ABORTED' ||
    msg.includes('aborted')
  );
}

export function mergeAbortSignals(signals = []) {
  const list = (Array.isArray(signals) ? signals : [])
    .filter((s) => s && typeof s === 'object' && typeof s.aborted === 'boolean' && typeof s.addEventListener === 'function');
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      return AbortSignal.any(list);
    }
  } catch { }

  const controller = new AbortController();
  const cleanups = [];

  const cleanup = () => {
    for (const fn of cleanups) {
      try { fn(); } catch { }
    }
    cleanups.length = 0;
  };

  const abortFromSignal = (sig) => {
    if (controller.signal.aborted) return;
    const reason = (sig && 'reason' in sig) ? sig.reason : undefined;
    try {
      if (reason !== undefined) controller.abort(reason);
      else controller.abort(makeAbortError('Aborted by upstream signal', 'RUN_ABORTED'));
    } catch {
      try { controller.abort(); } catch { }
    }
    cleanup();
  };

  for (const sig of list) {
    if (sig.aborted) {
      abortFromSignal(sig);
      break;
    }
    const onAbort = () => abortFromSignal(sig);
    sig.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => {
      try { sig.removeEventListener('abort', onAbort); } catch { }
    });
  }

  controller.signal.addEventListener('abort', cleanup, { once: true });
  return controller.signal;
}

export default {
  makeAbortError,
  isAbortLikeError,
  mergeAbortSignals,
};
