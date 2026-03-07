import { HistoryStore } from '../../history/store.js';
import { RunEvents } from '../../bus/runEvents.js';

const DEFAULT_FEEDBACK_WAIT_TIMEOUT_MS = 12000;
const MIN_FEEDBACK_WAIT_TIMEOUT_MS = 1000;

function normalizeFeedbackWaitTimeoutMs(timeoutMs) {
  const raw = Number(timeoutMs);
  if (!Number.isFinite(raw)) return DEFAULT_FEEDBACK_WAIT_TIMEOUT_MS;
  return Math.max(MIN_FEEDBACK_WAIT_TIMEOUT_MS, Math.floor(raw));
}

async function nextWithTimeout(iterator, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true }), Math.max(1, Number(timeoutMs) || 1));
      })
    ]);
  } finally {
    if (timer) {
      try { clearTimeout(timer); } catch {}
    }
  }
}

function extractAssistantResponsesFromBatches(batches = []) {
  const out = [];
  for (const b of (Array.isArray(batches) ? batches : [])) {
    const arr = Array.isArray(b?.responses) ? b.responses : [];
    for (const r of arr) {
      if (!r || typeof r !== 'object') continue;
      const content = String(r.content || '').trim();
      if (!content) continue;
      out.push({
        phase: String(r.phase || 'unknown'),
        content,
        noReply: r.noReply === true,
        delivered: r.delivered === true,
        ts: Number.isFinite(Number(r.ts)) ? Number(r.ts) : 0,
      });
    }
  }
  return out;
}

function hasFeedbackData(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.flushDone) return true;
  const batches = Array.isArray(payload.batches) ? payload.batches : [];
  const responses = Array.isArray(payload.responses) ? payload.responses : [];
  return batches.length > 0 || responses.length > 0;
}

function buildPendingFeedbackSnapshot(pendingBatches = [], flushDone = null) {
  const batches = Array.isArray(pendingBatches) ? pendingBatches.slice() : [];
  batches.sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
  const responses = extractAssistantResponsesFromBatches(batches);
  return { batches, responses, flushDone };
}

export async function waitForAssistantFeedbackBatches(
  runId,
  { sinceTs = 0, round = 0, timeoutMs = DEFAULT_FEEDBACK_WAIT_TIMEOUT_MS } = {}
) {
  const rid = String(runId || '');
  if (!rid) return { interrupted: true, batches: [], responses: [], flushDone: null };
  const targetRound = Number.isFinite(Number(round)) ? Math.max(0, Math.floor(Number(round))) : 0;
  const waitTimeoutMs = normalizeFeedbackWaitTimeoutMs(timeoutMs);

  const isTargetBatch = (h) => {
    const ts = Number(h?.ts || 0);
    if (Number.isFinite(sinceTs) && ts <= sinceTs) return false;
    const reason = String(h?.reason || '');
    if (reason !== 'feedback_wait') return false;
    const r = Number(h?.context?.feedbackRound);
    if (!Number.isFinite(r)) return false;
    return Math.floor(r) === targetRound;
  };

  const pickFromHistory = async (flushTs = Number.POSITIVE_INFINITY) => {
    const hist = await HistoryStore.list(rid, 0, -1);
    const allBatches = hist
      .filter((h) => h && h.type === 'assistant_response_batch')
      .filter((h) => {
        const ts = Number(h?.ts || 0);
        if (Number.isFinite(sinceTs) && ts <= sinceTs) return false;
        if (Number.isFinite(flushTs) && ts > flushTs) return false;
        return true;
      });
    const targetBatches = allBatches.filter(isTargetBatch);
    const batches = targetBatches;
    batches.sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
    const responses = extractAssistantResponsesFromBatches(batches);
    const flushDone = hist
      .filter((h) => h && h.type === 'feedback_flush_done')
      .reverse()
      .find((h) => {
        const ts = Number(h?.ts || 0);
        if (Number.isFinite(sinceTs) && ts <= sinceTs) return false;
        if (Number.isFinite(flushTs) && ts > flushTs) return false;
        const r = Number(h?.round);
        return Number.isFinite(r) && Math.floor(r) === targetRound;
      });
    return {
      batches,
      responses,
      flushDone
    };
  };

  try {
    const first = await pickFromHistory();
    if (first.flushDone) {
      const flushTs = Number(first.flushDone?.ts || 0);
      const bounded = await pickFromHistory(Number.isFinite(flushTs) && flushTs > 0 ? flushTs : Number.POSITIVE_INFINITY);
      return { interrupted: false, ...bounded };
    }
  } catch {}

  const sub = RunEvents.subscribe(rid);
  const deadline = Date.now() + waitTimeoutMs;
  const pendingTargetBatches = [];
  let liveResult = null;
  let interrupted = false;
  try {
    while (true) {
      const remainMs = deadline - Date.now();
      if (!Number.isFinite(remainMs) || remainMs <= 0) {
        interrupted = true;
        break;
      }
      const r = await nextWithTimeout(sub, remainMs);
      if (r && r.__timeout) {
        interrupted = true;
        break;
      }
      if (!r || r.done) {
        interrupted = true;
        break;
      }
      const ev = r.value;
      if (!ev) continue;
      if (ev.type === 'assistant_response_batch') {
        const ts = Number(ev?.ts || 0);
        if (Number.isFinite(sinceTs) && ts <= sinceTs) continue;
        if (String(ev?.reason || '') !== 'feedback_wait') continue;
        const r0 = Number(ev?.context?.feedbackRound);
        if (!Number.isFinite(r0) || Math.floor(r0) !== targetRound) continue;
        pendingTargetBatches.push(ev);
        continue;
      }
      if (ev.type === 'feedback_flush_done') {
        const ts = Number(ev?.ts || 0);
        if (Number.isFinite(sinceTs) && ts <= sinceTs) continue;
        const r0 = Number(ev?.round);
        if (!Number.isFinite(r0) || Math.floor(r0) !== targetRound) continue;
        try {
          const fromHistory = await pickFromHistory(ts);
          if (hasFeedbackData(fromHistory)) {
            liveResult = { interrupted: false, ...fromHistory };
            break;
          }
        } catch {}
        liveResult = { interrupted: false, ...buildPendingFeedbackSnapshot(pendingTargetBatches, ev) };
        break;
      }
    }
  } catch {}
  try { await sub.return?.(); } catch {}
  if (liveResult) return liveResult;

  try {
    const final = await pickFromHistory();
    if (final.flushDone && hasFeedbackData(final)) {
      return { interrupted: false, ...final };
    }
  } catch {}

  const pendingFallback = buildPendingFeedbackSnapshot(
    pendingTargetBatches
  );
  if (hasFeedbackData(pendingFallback)) {
    return { interrupted: interrupted === true, ...pendingFallback };
  }

  return { interrupted: interrupted === true, batches: [], responses: [], flushDone: null };
}
