import logger from '../logger/index.js';
import { makeAbortError } from '../utils/signal.js';

const controllersByRun = new Map();

function normalizeRunId(runId) {
  const rid = String(runId || '').trim();
  return rid;
}

function ensureSet(runId) {
  const rid = normalizeRunId(runId);
  if (!rid) return null;
  if (!controllersByRun.has(rid)) controllersByRun.set(rid, new Set());
  return controllersByRun.get(rid);
}

export function registerRunAbortController(runId, controller, meta = {}) {
  const rid = normalizeRunId(runId);
  if (!rid || !controller || typeof controller.abort !== 'function' || !controller.signal) {
    return () => { };
  }
  const set = ensureSet(rid);
  if (!set) return () => { };

  set.add(controller);

  const remove = () => {
    try {
      const cur = controllersByRun.get(rid);
      if (!cur) return;
      cur.delete(controller);
      if (cur.size === 0) controllersByRun.delete(rid);
    } catch { }
  };

  const onAbort = () => remove();
  try { controller.signal.addEventListener('abort', onAbort, { once: true }); } catch { }

  return () => {
    try { controller.signal.removeEventListener('abort', onAbort); } catch { }
    remove();
  };
}

export function abortRunRequests(runId, reason = 'run_cancelled', meta = {}) {
  const rid = normalizeRunId(runId);
  if (!rid) return 0;
  const set = controllersByRun.get(rid);
  if (!set || set.size === 0) return 0;

  let aborted = 0;
  const snapshot = Array.from(set.values());
  for (const controller of snapshot) {
    if (!controller || controller.signal?.aborted) continue;
    try {
      const err = makeAbortError(
        String(reason || 'Run aborted'),
        'RUN_ABORTED',
        {
          runId: rid,
          reason: String(reason || ''),
          source: String(meta?.source || ''),
          decision: String(meta?.decision || ''),
          ts: Number(meta?.ts || Date.now()),
        }
      );
      controller.abort(err);
      aborted += 1;
    } catch { }
  }

  try {
    logger.info?.('RunAbort: abort active requests', {
      label: 'RUN',
      runId: rid,
      aborted,
      reason: String(reason || ''),
      source: String(meta?.source || ''),
      decision: String(meta?.decision || ''),
    });
  } catch { }

  return aborted;
}

export function clearRunAbort(runId) {
  const rid = normalizeRunId(runId);
  if (!rid) return;
  controllersByRun.delete(rid);
}

export function countRunAbortControllers(runId) {
  const rid = normalizeRunId(runId);
  if (!rid) return 0;
  return controllersByRun.get(rid)?.size || 0;
}

export default {
  registerRunAbortController,
  abortRunRequests,
  clearRunAbort,
  countRunAbortControllers,
};
