import logger from '../logger/index.js';

const runs = new Map();

function nowMs() {
  return Date.now();
}

function clipText(v, max = 240) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}

export function registerRunStart({ runId, channelId, identityKey, objective }) {
  if (!runId) return;
  const rid = String(runId);
  const rec = {
    runId: rid,
    channelId: channelId != null ? String(channelId) : '',
    identityKey: identityKey != null ? String(identityKey) : '',
    objectivePreview: clipText(objective, 240),
    status: 'running',
    startedAt: nowMs(),
    finishedAt: 0,
    cancelled: false,
  };
  runs.set(rid, rec);
  try {
    const inflightSameChannel = rec.channelId ? listInFlightByChannel(rec.channelId) : [];
    const others = inflightSameChannel.filter((r) => String(r.runId) !== rid);
    logger.info?.('RunRegistry: start', {
      label: 'RUN',
      runId: rid,
      channelId: rec.channelId,
      identityKey: rec.identityKey,
      objectivePreview: rec.objectivePreview,
      otherInFlightCount: others.length,
    });
  } catch {}
}

export function markRunFinished(runId, { cancelled = false } = {}) {
  if (!runId) return;
  const rid = String(runId);
  const rec = runs.get(rid);
  if (!rec) return;
  rec.status = cancelled ? 'cancelled' : 'completed';
  rec.cancelled = !!cancelled;
  rec.finishedAt = nowMs();
  try {
    const durMs = rec.startedAt ? Math.max(0, rec.finishedAt - rec.startedAt) : 0;
    const inflightSameChannel = rec.channelId ? listInFlightByChannel(rec.channelId) : [];
    const others = inflightSameChannel.filter((r) => String(r.runId) !== rid);
    logger.info?.('RunRegistry: finish', {
      label: 'RUN',
      runId: rid,
      channelId: rec.channelId,
      identityKey: rec.identityKey,
      objectivePreview: rec.objectivePreview,
      status: rec.status,
      durationMs: durMs,
      otherInFlightCount: others.length,
    });
  } catch {}
}

export function removeRun(runId) {
  if (!runId) return;
  const rid = String(runId);
  const rec = runs.get(rid);
  runs.delete(rid);
  try {
    logger.debug?.('RunRegistry: remove', {
      label: 'RUN',
      runId: rid,
      channelId: rec?.channelId || '',
      identityKey: rec?.identityKey || '',
    });
  } catch {}
}

export function listInFlightByChannel(channelId) {
  const cid = channelId != null ? String(channelId) : '';
  if (!cid) return [];
  const out = [];
  for (const rec of runs.values()) {
    if (rec.status === 'running' && rec.channelId === cid) out.push({ ...rec });
  }
  out.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  return out;
}

export function buildConcurrencyOverlay({ runId, channelId, identityKey, objective }) {
  const cid = channelId != null ? String(channelId) : '';
  const ik = identityKey != null ? String(identityKey) : '';
  if (!cid && !ik) return '';

  const inflight = cid ? listInFlightByChannel(cid) : [];
  const others = inflight.filter((r) => String(r.runId) !== String(runId || '') && (!ik || r.identityKey !== ik));

  const lines = [];
  lines.push('RUNTIME CONTEXT (CONCURRENCY / IDENTITY):');
  if (cid) lines.push(`- channel_id: ${cid}`);
  if (ik) lines.push(`- identity_key: ${ik}`);
  if (objective) lines.push(`- current_objective_preview: ${clipText(objective, 160)}`);

  if (others.length) {
    lines.push('- other_inflight_runs_in_same_channel:');
    others.slice(0, 6).forEach((r) => {
      const rid8 = String(r.runId || '').slice(0, 8);
      const startedSec = r.startedAt ? Math.max(0, Math.floor((nowMs() - r.startedAt) / 1000)) : 0;
      const ident = r.identityKey ? ` identity_key=${r.identityKey}` : '';
      lines.push(`  - run_id=${rid8} age_s=${startedSec}${ident} objective=${clipText(r.objectivePreview, 160)}`);
    });
  } else {
    lines.push('- other_inflight_runs_in_same_channel: (none)');
  }

  lines.push('CRITICAL RULES:');
  lines.push('1) Focus ONLY on the current objective and the most recent user messages for this identity_key.');
  lines.push('2) Do NOT repeat, take over, or re-trigger objectives from other in-flight runs listed above.');
  lines.push('3) If the user asks about progress of another run, summarize that it is still running instead of restarting it.');

  return lines.join('\n');
}

export default {
  registerRunStart,
  markRunFinished,
  removeRun,
  listInFlightByChannel,
  buildConcurrencyOverlay,
};
