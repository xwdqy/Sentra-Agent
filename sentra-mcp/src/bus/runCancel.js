import logger from '../logger/index.js';
import { abortRunRequests, clearRunAbort } from './runAbort.js';

const cancelledRuns = new Set();
const cancelMetaByRun = new Map();

function normalizeCancelMeta(meta) {
  const obj = (meta && typeof meta === 'object') ? meta : {};
  const out = {};
  if (obj.reason != null) out.reason = String(obj.reason);
  if (obj.source != null) out.source = String(obj.source);
  if (obj.decision != null) out.decision = String(obj.decision);
  if (obj.latestUserObjective != null) out.latestUserObjective = String(obj.latestUserObjective);
  if (obj.latestUserObjectiveXml != null) out.latestUserObjectiveXml = String(obj.latestUserObjectiveXml);
  if (obj.userIntentText != null) out.userIntentText = String(obj.userIntentText);
  if (obj.cancelledBy != null) out.cancelledBy = String(obj.cancelledBy);
  if (!out.userIntentText) {
    out.userIntentText = String(out.latestUserObjective || '');
  }
  const ts = Number(obj.ts);
  if (Number.isFinite(ts) && ts > 0) out.ts = Math.floor(ts);
  if (!out.ts) out.ts = Date.now();
  return out;
}

export function cancelRun(runId, meta = null) {
  if (!runId) return;
  const rid = String(runId);
  cancelledRuns.add(rid);
  const normalizedMeta = normalizeCancelMeta(meta);
  cancelMetaByRun.set(rid, normalizedMeta);
  try {
    abortRunRequests(rid, normalizedMeta.reason || 'run_cancelled', normalizedMeta);
  } catch { }
  try {
    logger.info?.('RunCancel: 标记取消', { label: 'RUN', runId: rid, ...normalizedMeta });
  } catch { }
}

export function isRunCancelled(runId) {
  if (!runId) return false;
  return cancelledRuns.has(String(runId));
}

export function getRunCancelMeta(runId) {
  if (!runId) return null;
  return cancelMetaByRun.get(String(runId)) || null;
}

export function clearRunCancelled(runId) {
  if (!runId) return;
  const rid = String(runId);
  cancelledRuns.delete(rid);
  cancelMetaByRun.delete(rid);
  try { clearRunAbort(rid); } catch { }
}
