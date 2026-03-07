const runExecutionEpochByRunId = new Map();

export function claimRunExecutionEpoch(runId) {
  const rid = String(runId || '').trim();
  if (!rid) return 0;
  const prev = Number(runExecutionEpochByRunId.get(rid) || 0);
  const next = Number.isFinite(prev) ? (prev + 1) : 1;
  runExecutionEpochByRunId.set(rid, next);
  return next;
}

export function isRunExecutionEpochActive(runId, epoch) {
  const rid = String(runId || '').trim();
  if (!rid) return false;
  const current = Number(runExecutionEpochByRunId.get(rid) || 0);
  return Number(epoch) > 0 && current === Number(epoch);
}

export function releaseRunExecutionEpoch(runId, epoch) {
  const rid = String(runId || '').trim();
  if (!rid) return;
  const current = Number(runExecutionEpochByRunId.get(rid) || 0);
  if (current === Number(epoch)) {
    runExecutionEpochByRunId.delete(rid);
  }
}
