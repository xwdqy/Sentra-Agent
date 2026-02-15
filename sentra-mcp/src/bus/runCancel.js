import logger from '../logger/index.js';

const cancelledRuns = new Set();

export function cancelRun(runId) {
  if (!runId) return;
  cancelledRuns.add(String(runId));
  try {
    logger.info?.('RunCancel: 标记取消', { label: 'RUN', runId: String(runId) });
  } catch { }
}

export function isRunCancelled(runId) {
  if (!runId) return false;
  return cancelledRuns.has(String(runId));
}

export function clearRunCancelled(runId) {
  if (!runId) return;
  cancelledRuns.delete(String(runId));
}
