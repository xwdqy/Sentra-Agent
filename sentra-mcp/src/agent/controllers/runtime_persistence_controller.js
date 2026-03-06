import fs from 'node:fs/promises';
import path from 'node:path';
import { getRedis } from '../../redis/client.js';
import { config } from '../../config/index.js';
import logger from '../../logger/index.js';
import { ARTIFACTS_ROOT } from '../workspace/hash.js';

const prefix = String(config.redis?.contextPrefix || 'sentra_mcp_ctx');
const RUNTIME_ROOT = path.join(ARTIFACTS_ROOT, 'runtime');
const RUNTIME_RUNS_DIR = path.join(RUNTIME_ROOT, 'runs');
const RUNTIME_CONVERSATIONS_DIR = path.join(RUNTIME_RUNS_DIR, '_conversations');
const RUNTIME_ARCHIVE_DIR = path.join(RUNTIME_RUNS_DIR, '_archive');
const MAX_RUN_EVENTS = 4000;
const MAX_CONVERSATION_TRANSITIONS = 4000;
const RUNTIME_RETENTION_DAYS = 30;
const RUNTIME_RETENTION_MS = RUNTIME_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const RUNTIME_RETENTION_SEC = Math.floor(RUNTIME_RETENTION_MS / 1000);
const RETENTION_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const conversationCache = new Map();
const runCheckpointCache = new Map();
const finalizedRunCache = new Map();
let lastRetentionSweepAt = 0;
let retentionSweepInFlight = null;

function nowMs() {
  return Date.now();
}

function safeText(v) {
  return String(v == null ? '' : v).trim();
}

function safeId(v, fallback = 'unknown') {
  const cleaned = safeText(v).replace(/[^a-zA-Z0-9._@-]/g, '_');
  return cleaned || fallback;
}

function inferConversationModeFromId(raw = '') {
  const s = safeText(raw);
  if (!s) return 'unknown';
  if (/^G[:_]/i.test(s)) return 'group';
  if (/^U[:_]/i.test(s)) return 'private';
  return 'unknown';
}

function toState(value, fallback = 'IDLE') {
  const s = safeText(value).toUpperCase();
  if (s === 'IDLE' || s === 'BUNDLING' || s === 'RUNNING' || s === 'DRAINING' || s === 'FINALIZED') {
    return s;
  }
  return fallback;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function resolveRuntimeLineage(source = {}, fallback = {}) {
  const src = (source && typeof source === 'object') ? source : {};
  const fb = (fallback && typeof fallback === 'object') ? fallback : {};
  const orchestratorRunId = safeText(
    src.orchestratorRunId
    || src.orchestrator_run_id
    || fb.orchestratorRunId
    || fb.orchestrator_run_id
  );
  const parentRunId = safeText(
    src.parentRunId
    || src.parent_run_id
    || fb.parentRunId
    || fb.parent_run_id
    || orchestratorRunId
  );
  return {
    orchestratorRunId,
    parentRunId
  };
}

function toHashPatch(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean') {
      out[k] = v ? '1' : '0';
      continue;
    }
    if (typeof v === 'number') {
      out[k] = Number.isFinite(v) ? String(Math.floor(v)) : '0';
      continue;
    }
    if (typeof v === 'object') {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = '{}';
      }
      continue;
    }
    out[k] = String(v);
  }
  return out;
}

function parseHashObject(hash = {}) {
  const obj = (hash && typeof hash === 'object') ? hash : {};
  const raw = { ...obj };
  return {
    ...raw,
    version: toInt(raw.version, 0),
    checkpointVersion: toInt(raw.checkpointVersion, toInt(raw.version, 0)),
    stateVersion: toInt(raw.stateVersion, toInt(raw.checkpointVersion, toInt(raw.version, 0))),
    eventSeq: toInt(raw.eventSeq, 0),
    lastEventAt: toInt(raw.lastEventAt, 0),
    lastCheckpointAt: toInt(raw.lastCheckpointAt, 0),
    generation: toInt(raw.generation, 0),
    signalSeq: toInt(raw.signalSeq, 0),
    updatedAt: toInt(raw.updatedAt, 0),
    startedAt: toInt(raw.startedAt, 0),
    finishedAt: toInt(raw.finishedAt, 0),
    lastSignalTs: toInt(raw.lastSignalTs, 0),
  };
}

function parseJsonMaybe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  const text = safeText(value);
  if (!text) return fallback;
  if (!text.startsWith('{') && !text.startsWith('[')) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeRunCheckpointObject(raw = {}) {
  const parsed = parseHashObject(raw);
  const diffIndex = parseJsonMaybe(parsed.lastWorkspaceDiffByStepKey, {});
  const lastDiff = parseJsonMaybe(parsed.lastWorkspaceDiff, null);
  const parsedRunLineage = parseJsonMaybe(parsed.runLineage, null);
  const lineage = resolveRuntimeLineage(parsedRunLineage || parsed, parsed);
  return {
    ...parsed,
    orchestratorRunId: lineage.orchestratorRunId,
    parentRunId: lineage.parentRunId,
    runLineage: lineage,
    checkpointVersion: toInt(parsed.checkpointVersion, toInt(parsed.version, 0)),
    stateVersion: toInt(parsed.stateVersion, toInt(parsed.checkpointVersion, toInt(parsed.version, 0))),
    eventSeq: toInt(parsed.eventSeq, 0),
    lastEventAt: toInt(parsed.lastEventAt, 0),
    lastCheckpointAt: toInt(parsed.lastCheckpointAt, 0),
    lastWorkspaceDiffByStepKey: (diffIndex && typeof diffIndex === 'object' && !Array.isArray(diffIndex)) ? diffIndex : {},
    lastWorkspaceDiff: (lastDiff && typeof lastDiff === 'object') ? lastDiff : null,
  };
}

function conversationKey(conversationId) {
  return `${prefix}_runtime_conversation_${safeId(conversationId, 'unknown')}`;
}

function conversationRunsKey(conversationId) {
  return `${conversationKey(conversationId)}_runs`;
}

function conversationTransitionsKey(conversationId) {
  return `${conversationKey(conversationId)}_transitions`;
}

function runCheckpointKey(runId) {
  return `${prefix}_runtime_run_${safeId(runId, 'unknown')}_checkpoint`;
}

function runMetaKey(runId) {
  return `${prefix}_runtime_run_${safeId(runId, 'unknown')}_meta`;
}

function runEventsKey(runId) {
  return `${prefix}_runtime_run_${safeId(runId, 'unknown')}_events`;
}

function conversationDir(conversationId) {
  return path.join(RUNTIME_CONVERSATIONS_DIR, safeId(conversationId, 'unknown'));
}

function runDir(runId) {
  return path.join(RUNTIME_RUNS_DIR, safeId(runId, 'unknown'));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJsonAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tmp = `${filePath}.tmp_${nowMs()}_${Math.random().toString(16).slice(2, 10)}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

async function appendJsonl(filePath, payload) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

async function statSafe(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function readJsonlTail(filePath, maxLines = 20) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const tail = lines.slice(-Math.max(1, Math.floor(maxLines)));
    const parsed = [];
    for (const line of tail) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        parsed.push({ raw: line });
      }
    }
    return {
      total: lines.length,
      tail: parsed
    };
  } catch {
    return { total: 0, tail: [] };
  }
}

function isoDay(ts) {
  const n = Math.max(0, toInt(ts, nowMs()));
  return new Date(n).toISOString().slice(0, 10);
}

function archiveFilePath(kind, ts) {
  const day = isoDay(ts);
  return path.join(RUNTIME_ARCHIVE_DIR, safeId(kind, 'misc'), `${day}.jsonl`);
}

function maxTs(...values) {
  let best = 0;
  for (const v of values) {
    const n = toInt(v, 0);
    if (n > best) best = n;
  }
  return best;
}

function buildRuntimeRedisKeys({ conversationId = '', runId = '' } = {}) {
  const keys = new Set();
  const cid = safeText(conversationId);
  const rid = safeText(runId);
  if (cid && cid !== 'unknown') {
    keys.add(conversationKey(cid));
    keys.add(conversationRunsKey(cid));
    keys.add(conversationTransitionsKey(cid));
  }
  if (rid) {
    keys.add(runCheckpointKey(rid));
    keys.add(runMetaKey(rid));
    keys.add(runEventsKey(rid));
  }
  return Array.from(keys);
}

function applyRedisRetentionInTx(tx, keys = []) {
  for (const key of (Array.isArray(keys) ? keys : [])) {
    const k = safeText(key);
    if (!k) continue;
    tx.expire(k, RUNTIME_RETENTION_SEC);
  }
}

async function sweepRuntimeRuns({ cutoffTs, nowTs }) {
  let archived = 0;
  let removed = 0;
  let entries = [];
  try {
    entries = await fs.readdir(RUNTIME_RUNS_DIR, { withFileTypes: true });
  } catch {
    return { archived, removed };
  }
  for (const ent of entries) {
    if (!ent?.isDirectory?.()) continue;
    const dirPath = path.join(RUNTIME_RUNS_DIR, ent.name);
    const metaPath = path.join(dirPath, 'meta.json');
    const checkpointPath = path.join(dirPath, 'checkpoint.json');
    const planPath = path.join(dirPath, 'plan.json');
    const summaryPath = path.join(dirPath, 'summary.json');
    const historyPath = path.join(dirPath, 'history.jsonl');
    const meta = await readJsonSafe(metaPath);
    const checkpoint = await readJsonSafe(checkpointPath);
    const plan = await readJsonSafe(planPath);
    const summary = await readJsonSafe(summaryPath);
    const historyStats = await readJsonlTail(historyPath, 20);
    const st = await statSafe(dirPath);
    const ts = maxTs(
      meta?.finishedAt,
      meta?.updatedAt,
      meta?.startedAt,
      checkpoint?.finishedAt,
      checkpoint?.updatedAt,
      checkpoint?.startedAt,
      plan?.ts,
      summary?.ts,
      st?.mtimeMs
    );
    if (!ts || ts > cutoffTs) continue;
    const archiveRecord = {
      kind: 'run',
      archivedAt: nowTs,
      runId: safeText(meta?.runId || checkpoint?.runId || ent.name),
      conversationId: safeText(meta?.conversationId || checkpoint?.conversationId || ''),
      status: safeText(meta?.status || checkpoint?.status || ''),
      startedAt: toInt(meta?.startedAt ?? checkpoint?.startedAt, 0),
      finishedAt: toInt(meta?.finishedAt ?? checkpoint?.finishedAt, 0),
      updatedAt: toInt(meta?.updatedAt ?? checkpoint?.updatedAt, ts),
      checkpoint: {
        stage: safeText(checkpoint?.stage || ''),
        lastCompletedStepIndex: toInt(checkpoint?.lastCompletedStepIndex, -1),
        lastCompletedStepId: safeText(checkpoint?.lastCompletedStepId || ''),
        attempted: toInt(checkpoint?.attempted, 0),
        succeeded: toInt(checkpoint?.succeeded, 0),
        totalSteps: toInt(checkpoint?.totalSteps, 0),
      },
      plan: {
        ts: toInt(plan?.ts, 0),
        stepCount: toInt(plan?.plan?.steps?.length ?? plan?.steps?.length, 0)
      },
      summary: {
        ts: toInt(summary?.ts, 0),
        text: safeText(summary?.summary || '')
      },
      history: {
        total: toInt(historyStats?.total, 0),
        tail: Array.isArray(historyStats?.tail) ? historyStats.tail : []
      }
    };
    try {
      await appendJsonl(archiveFilePath('runs', ts), archiveRecord);
      archived += 1;
    } catch {}
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return { archived, removed };
}

async function sweepRuntimeConversations({ cutoffTs, nowTs }) {
  let archived = 0;
  let removed = 0;
  let entries = [];
  try {
    entries = await fs.readdir(RUNTIME_CONVERSATIONS_DIR, { withFileTypes: true });
  } catch {
    return { archived, removed };
  }
  for (const ent of entries) {
    if (!ent?.isDirectory?.()) continue;
    const dirPath = path.join(RUNTIME_CONVERSATIONS_DIR, ent.name);
    const runtimePath = path.join(dirPath, 'runtime.json');
    const runtime = await readJsonSafe(runtimePath);
    const st = await statSafe(dirPath);
    const ts = maxTs(runtime?.updatedAt, runtime?.startedAt, runtime?.lastSignalTs, st?.mtimeMs);
    if (!ts || ts > cutoffTs) continue;
    const archiveRecord = {
      kind: 'conversation',
      archivedAt: nowTs,
      conversationId: safeText(runtime?.conversationId || ent.name),
      mode: safeText(runtime?.mode || ''),
      state: safeText(runtime?.state || ''),
      activeRunId: safeText(runtime?.activeRunId || ''),
      lastRunId: safeText(runtime?.lastRunId || ''),
      generation: toInt(runtime?.generation, 0),
      signalSeq: toInt(runtime?.signalSeq, 0),
      updatedAt: toInt(runtime?.updatedAt, ts),
    };
    try {
      await appendJsonl(archiveFilePath('conversations', ts), archiveRecord);
      archived += 1;
    } catch {}
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return { archived, removed };
}

async function sweepArchiveFiles({ cutoffTs }) {
  let removed = 0;
  const kinds = ['runs', 'conversations'];
  for (const kind of kinds) {
    const dirPath = path.join(RUNTIME_ARCHIVE_DIR, kind);
    let entries = [];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent?.isFile?.()) continue;
      const filePath = path.join(dirPath, ent.name);
      const st = await statSafe(filePath);
      const ts = toInt(st?.mtimeMs, 0);
      if (!ts || ts > cutoffTs) continue;
      try {
        await fs.rm(filePath, { force: true });
        removed += 1;
      } catch {}
    }
  }
  return { removed };
}

async function runRetentionSweep(reason = '') {
  const nowTs = nowMs();
  const cutoffTs = nowTs - RUNTIME_RETENTION_MS;
  await ensureDir(RUNTIME_RUNS_DIR);
  await ensureDir(RUNTIME_CONVERSATIONS_DIR);
  await ensureDir(RUNTIME_ARCHIVE_DIR);

  const runStats = await sweepRuntimeRuns({ cutoffTs, nowTs });
  const conversationStats = await sweepRuntimeConversations({ cutoffTs, nowTs });
  const archiveStats = await sweepArchiveFiles({ cutoffTs });

  if (runStats.archived || runStats.removed || conversationStats.archived || conversationStats.removed || archiveStats.removed) {
    logger.info?.('runtime retention sweep', {
      label: 'RUNTIME',
      retentionDays: RUNTIME_RETENTION_DAYS,
      reason: safeText(reason),
      runArchived: runStats.archived,
      runRemoved: runStats.removed,
      conversationArchived: conversationStats.archived,
      conversationRemoved: conversationStats.removed,
      archiveRemoved: archiveStats.removed,
    });
  }
}

function maybeScheduleRetentionSweep(reason = '') {
  const nowTs = nowMs();
  if (retentionSweepInFlight) return;
  if (nowTs - lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS) return;
  lastRetentionSweepAt = nowTs;
  retentionSweepInFlight = runRetentionSweep(reason)
    .catch((e) => {
      logger.warn?.('runtime retention sweep failed', { label: 'RUNTIME', reason: safeText(reason), error: String(e) });
    })
    .finally(() => {
      retentionSweepInFlight = null;
    });
}

function maybePruneFinalizedCache() {
  if (finalizedRunCache.size < 5000) return;
  const entries = Array.from(finalizedRunCache.entries()).sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0));
  const removeCount = Math.max(500, Math.floor(entries.length / 3));
  for (let i = 0; i < removeCount; i++) {
    finalizedRunCache.delete(entries[i][0]);
  }
}

export function resolveConversationRuntimeIdentity(context = {}) {
  const ctx = (context && typeof context === 'object') ? context : {};
  const groupId = safeText(ctx.groupId);
  const userId = safeText(ctx.userId);
  const lineage = resolveRuntimeLineage(ctx);
  const rawConversationId = safeText(
    groupId
    || ctx.conversationId
    || ctx.channelId
    || ctx.identityKey
    || (userId ? `U_${userId}` : '')
  ) || 'unknown';
  const inferredMode = inferConversationModeFromId(rawConversationId);
  const mode = inferredMode !== 'unknown' ? inferredMode : safeText(ctx.chatType || 'unknown');
  const conversationId = safeId(rawConversationId, 'unknown');
  return {
    rawConversationId,
    conversationId,
    mode,
    channelId: safeText(ctx.channelId),
    identityKey: safeText(ctx.identityKey),
    groupId,
    userId,
    orchestratorRunId: lineage.orchestratorRunId,
    parentRunId: lineage.parentRunId,
  };
}

async function loadConversationRecord(r, conversationId) {
  const cid = safeId(conversationId, 'unknown');
  if (conversationCache.has(cid)) return conversationCache.get(cid);
  try {
    const raw = await r.hgetall(conversationKey(cid));
    const parsed = parseHashObject(raw);
    conversationCache.set(cid, parsed);
    return parsed;
  } catch {
    return {};
  }
}

async function loadRunCheckpoint(r, runId) {
  const rid = safeId(runId, 'unknown');
  if (runCheckpointCache.has(rid)) return runCheckpointCache.get(rid);
  try {
    const raw = await r.hgetall(runCheckpointKey(rid));
    const parsed = normalizeRunCheckpointObject(raw);
    runCheckpointCache.set(rid, parsed);
    return parsed;
  } catch {
    return {};
  }
}

export async function loadRuntimeRunCheckpointSnapshot({ runId } = {}) {
  const rid = safeText(runId);
  if (!rid) return null;
  const key = safeId(rid, 'unknown');
  if (runCheckpointCache.has(key)) {
    return runCheckpointCache.get(key);
  }
  try {
    const r = getRedis();
    const fromRedis = await loadRunCheckpoint(r, rid);
    if (fromRedis && typeof fromRedis === 'object' && Object.keys(fromRedis).length > 0) {
      return fromRedis;
    }
  } catch {}

  try {
    const local = await readJsonSafe(path.join(runDir(rid), 'checkpoint.json'));
    if (local && typeof local === 'object') {
      const normalized = normalizeRunCheckpointObject(local);
      runCheckpointCache.set(key, normalized);
      return normalized;
    }
  } catch {}
  return null;
}

export async function listRuntimeRunCheckpointSnapshots({
  includeTerminal = true,
  limit = 500
} = {}) {
  const cap = Math.max(1, Math.min(5000, toInt(limit, 500)));
  let entries = [];
  try {
    await ensureDir(RUNTIME_RUNS_DIR);
    entries = await fs.readdir(RUNTIME_RUNS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent?.isDirectory?.()) continue;
    const runId = safeText(ent.name);
    if (!runId || runId.startsWith('_')) continue;
    const checkpointPath = path.join(RUNTIME_RUNS_DIR, runId, 'checkpoint.json');
    const local = await readJsonSafe(checkpointPath);
    if (!local || typeof local !== 'object') continue;
    const checkpoint = normalizeRunCheckpointObject(local);
    const status = safeText(checkpoint.status).toLowerCase();
    if (!includeTerminal && isTerminalStatus(status)) continue;
    const delaySession = extractDelayRuntimeSessionFromCheckpoint(checkpoint, runId);
    const replayCursor = (delaySession?.replayCursor && typeof delaySession.replayCursor === 'object')
      ? delaySession.replayCursor
      : null;
    out.push({
      runId: safeText(checkpoint.runId || runId),
      conversationId: safeText(checkpoint.conversationId || ''),
      objective: safeText(checkpoint.objective || ''),
      userId: safeText(checkpoint.userId || ''),
      groupId: safeText(checkpoint.groupId || ''),
      channelId: safeText(checkpoint.channelId || ''),
      identityKey: safeText(checkpoint.identityKey || ''),
      status: safeText(checkpoint.status || ''),
      stage: safeText(checkpoint.stage || ''),
      startedAt: toInt(checkpoint.startedAt, 0),
      updatedAt: toInt(checkpoint.updatedAt, 0),
      finishedAt: toInt(checkpoint.finishedAt, 0),
      lastCompletedStepIndex: toInt(checkpoint.lastCompletedStepIndex, -1),
      lastCompletedStepId: safeText(checkpoint.lastCompletedStepId || ''),
      totalSteps: toInt(checkpoint.totalSteps, 0),
      attempted: toInt(checkpoint.attempted, 0),
      succeeded: toInt(checkpoint.succeeded, 0),
      checkpointVersion: toInt(checkpoint.checkpointVersion, toInt(checkpoint.version, 0)),
      stateVersion: toInt(checkpoint.stateVersion, toInt(checkpoint.checkpointVersion, toInt(checkpoint.version, 0))),
      eventSeq: toInt(checkpoint.eventSeq, 0),
      lastEventAt: toInt(checkpoint.lastEventAt, 0),
      orchestratorRunId: safeText(checkpoint.orchestratorRunId || ''),
      parentRunId: safeText(checkpoint.parentRunId || ''),
      hasDelayRuntimeSession: !!delaySession,
      delaySessionId: safeText(delaySession?.sessionId || ''),
      delayFireAt: toInt(delaySession?.fireAt, 0),
      delayCompletedAt: toInt(delaySession?.completedAt, 0),
      delayDueFiredAt: toInt(delaySession?.dueFiredAt, 0),
      replayCursorNextOffset: toInt(replayCursor?.nextOffset, 0),
      replayCursorTotalEvents: toInt(replayCursor?.totalEvents, 0),
      replayCursorStatus: safeText(replayCursor?.status || ''),
      replayCursorUpdatedAt: toInt(replayCursor?.updatedAt, 0)
    });
  }
  return out
    .sort((a, b) => {
      const au = toInt(a.updatedAt, 0);
      const bu = toInt(b.updatedAt, 0);
      if (au !== bu) return bu - au;
      return safeText(a.runId).localeCompare(safeText(b.runId));
    })
    .slice(0, cap);
}

async function writeConversationLocal(conversationId, payload) {
  const file = path.join(conversationDir(conversationId), 'runtime.json');
  await writeJsonAtomic(file, payload);
}

async function writeRunMetaLocal(runId, payload) {
  const file = path.join(runDir(runId), 'meta.json');
  await writeJsonAtomic(file, payload);
}

async function writeRunCheckpointLocal(runId, payload) {
  const file = path.join(runDir(runId), 'checkpoint.json');
  await writeJsonAtomic(file, payload);
}

async function appendConversationTransitionLocal(conversationId, payload) {
  const file = path.join(conversationDir(conversationId), 'transitions.jsonl');
  await appendJsonl(file, payload);
}

async function appendRunEventLocal(runId, payload) {
  const file = path.join(runDir(runId), 'events.jsonl');
  await appendJsonl(file, payload);
}

function buildTransitionEvent({
  runId,
  conversationId,
  fromState,
  targetState,
  reasonCode = '',
  source = 'runtime_persistence',
  generation = 0,
  signalSeq = 0,
  note = '',
  objective = '',
  orchestratorRunId = '',
  parentRunId = '',
}) {
  return {
    type: 'runtime_state_transition',
    ts: nowMs(),
    runId: safeText(runId),
    conversationId: safeText(conversationId),
    from: toState(fromState, 'IDLE'),
    to: toState(targetState, 'IDLE'),
    reasonCode: safeText(reasonCode),
    source: safeText(source),
    generation: Math.max(0, toInt(generation, 0)),
    signalSeq: Math.max(0, toInt(signalSeq, 0)),
    note: safeText(note),
    objective: safeText(objective),
    orchestratorRunId: safeText(orchestratorRunId),
    parentRunId: safeText(parentRunId),
  };
}

export async function persistRuntimeRunStart({ runId, objective = '', context = {}, source = 'run_start' } = {}) {
  const rid = safeText(runId);
  if (!rid) return null;
  const identity = resolveConversationRuntimeIdentity(context);
  const lineage = resolveRuntimeLineage(identity, context);
  const cid = safeId(identity.conversationId, 'unknown');
  const now = nowMs();

  try {
    const r = getRedis();
    const prev = await loadConversationRecord(r, cid);
    const prevState = toState(prev.state, 'IDLE');
    const nextState = 'RUNNING';
    const generation = Math.max(1, toInt(prev.generation, 0));
    const signalSeq = Math.max(0, toInt(prev.signalSeq, 0));
    const transition = buildTransitionEvent({
      runId: rid,
      conversationId: cid,
      fromState: prevState,
      targetState: nextState,
      reasonCode: 'run_started',
      source,
      generation,
      signalSeq,
      objective,
      orchestratorRunId: lineage.orchestratorRunId,
      parentRunId: lineage.parentRunId,
    });

    const convPatch = {
      conversationId: cid,
      mode: identity.mode,
      channelId: identity.channelId,
      identityKey: identity.identityKey,
      groupId: identity.groupId,
      userId: identity.userId,
      state: nextState,
      activeRunId: rid,
      lastRunId: rid,
      lastObjective: safeText(objective),
      lastReasonCode: transition.reasonCode,
      lastSource: transition.source,
      generation,
      signalSeq,
      lastSignalTs: transition.ts,
      updatedAt: now,
      orchestratorRunId: lineage.orchestratorRunId,
      parentRunId: lineage.parentRunId,
    };
    const nextConversation = { ...prev, ...convPatch, version: Math.max(0, toInt(prev.version, 0)) + 1 };
    conversationCache.set(cid, nextConversation);

    const initialCheckpoint = {
      runId: rid,
      conversationId: cid,
      mode: identity.mode,
      channelId: identity.channelId,
      identityKey: identity.identityKey,
      groupId: identity.groupId,
      userId: identity.userId,
      rawConversationId: identity.rawConversationId,
      status: 'running',
      stage: 'start',
      objective: safeText(objective),
      startedAt: now,
      updatedAt: now,
      finishedAt: 0,
      lastCompletedStepIndex: -1,
      lastCompletedStepId: '',
      totalSteps: 0,
      attempted: 0,
      succeeded: 0,
      runtimeSignalCursorTs: 0,
      runtimeSignalGeneration: generation,
      runtimeSignalSeq: signalSeq,
      checkpointVersion: 1,
      stateVersion: 1,
      eventSeq: 0,
      lastEventAt: 0,
      lastCheckpointAt: now,
      version: 1,
      lastReasonCode: 'run_started',
      lastWorkspaceDiffStepKey: '',
      lastWorkspaceDiff: null,
      lastWorkspaceDiffByStepKey: {},
      orchestratorRunId: lineage.orchestratorRunId,
      parentRunId: lineage.parentRunId,
      runLineage: lineage,
    };
    runCheckpointCache.set(safeId(rid, 'unknown'), initialCheckpoint);

    const runMeta = {
      runId: rid,
      conversationId: cid,
      status: 'running',
      objective: safeText(objective),
      source: safeText(source),
      startedAt: now,
      updatedAt: now,
      finishedAt: 0,
      orchestratorRunId: lineage.orchestratorRunId,
      parentRunId: lineage.parentRunId,
    };
    const retentionKeys = buildRuntimeRedisKeys({ conversationId: cid, runId: rid });
    const staleBefore = now - RUNTIME_RETENTION_MS;

    const tx = r.multi();
    tx.hset(conversationKey(cid), toHashPatch(convPatch));
    tx.hincrby(conversationKey(cid), 'version', 1);
    tx.zadd(conversationRunsKey(cid), now, rid);
    tx.zremrangebyscore(conversationRunsKey(cid), 0, staleBefore);
    tx.rpush(conversationTransitionsKey(cid), JSON.stringify(transition));
    tx.ltrim(conversationTransitionsKey(cid), -MAX_CONVERSATION_TRANSITIONS, -1);
    tx.hset(runCheckpointKey(rid), toHashPatch(initialCheckpoint));
    tx.hset(runMetaKey(rid), toHashPatch(runMeta));
    tx.rpush(runEventsKey(rid), JSON.stringify({ ...transition, type: 'runtime_run_started' }));
    tx.ltrim(runEventsKey(rid), -MAX_RUN_EVENTS, -1);
    applyRedisRetentionInTx(tx, retentionKeys);
    await tx.exec();

    await writeConversationLocal(cid, nextConversation);
    await appendConversationTransitionLocal(cid, transition);
    await writeRunMetaLocal(rid, runMeta);
    await writeRunCheckpointLocal(rid, initialCheckpoint);
    await appendRunEventLocal(rid, { ...transition, type: 'runtime_run_started' });
    maybeScheduleRetentionSweep('run_start');

    return { conversationId: cid, transition };
  } catch (e) {
    logger.warn?.('runtime persistence run-start failed', { label: 'RUNTIME', runId: rid, error: String(e) });
    return null;
  }
}

export async function persistRuntimeStateTransition({
  runId,
  context = {},
  to,
  reasonCode = '',
  source = 'runtime_transition',
  note = '',
  objective = '',
  generation = 0,
  signalSeq = 0,
} = {}) {
  const rid = safeText(runId);
  if (!rid) return null;
  const identity = resolveConversationRuntimeIdentity(context);
  const lineage = resolveRuntimeLineage(identity, context);
  const cid = safeId(identity.conversationId, 'unknown');
  const targetState = toState(to, 'RUNNING');

  try {
    const r = getRedis();
    const prev = await loadConversationRecord(r, cid);
    const prevState = toState(prev.state, 'IDLE');
    const event = buildTransitionEvent({
      runId: rid,
      conversationId: cid,
      fromState: prevState,
      targetState,
      reasonCode,
      source,
      generation: generation || prev.generation,
      signalSeq: signalSeq || prev.signalSeq,
      note,
      objective,
      orchestratorRunId: lineage.orchestratorRunId,
      parentRunId: lineage.parentRunId,
    });
    const patch = {
      conversationId: cid,
      mode: identity.mode,
      channelId: identity.channelId,
      identityKey: identity.identityKey,
      groupId: identity.groupId,
      userId: identity.userId,
      state: targetState,
      lastRunId: rid,
      lastReasonCode: event.reasonCode,
      lastSource: event.source,
      lastSignalTs: event.ts,
      updatedAt: event.ts,
      generation: Math.max(0, toInt(event.generation, toInt(prev.generation, 0))),
      signalSeq: Math.max(0, toInt(event.signalSeq, toInt(prev.signalSeq, 0))),
      ...(safeText(objective) ? { lastObjective: safeText(objective) } : {}),
      ...(targetState === 'FINALIZED' ? { activeRunId: '' } : { activeRunId: rid }),
      orchestratorRunId: lineage.orchestratorRunId,
      parentRunId: lineage.parentRunId,
    };
    const nextConversation = { ...prev, ...patch, version: Math.max(0, toInt(prev.version, 0)) + 1 };
    conversationCache.set(cid, nextConversation);
    const retentionKeys = buildRuntimeRedisKeys({ conversationId: cid, runId: rid });
    const staleBefore = event.ts - RUNTIME_RETENTION_MS;

    const tx = r.multi();
    tx.hset(conversationKey(cid), toHashPatch(patch));
    tx.hincrby(conversationKey(cid), 'version', 1);
    tx.zremrangebyscore(conversationRunsKey(cid), 0, staleBefore);
    tx.rpush(conversationTransitionsKey(cid), JSON.stringify(event));
    tx.ltrim(conversationTransitionsKey(cid), -MAX_CONVERSATION_TRANSITIONS, -1);
    tx.rpush(runEventsKey(rid), JSON.stringify(event));
    tx.ltrim(runEventsKey(rid), -MAX_RUN_EVENTS, -1);
    applyRedisRetentionInTx(tx, retentionKeys);
    await tx.exec();

    await writeConversationLocal(cid, nextConversation);
    await appendConversationTransitionLocal(cid, event);
    await appendRunEventLocal(rid, event);
    maybeScheduleRetentionSweep('state_transition');

    return event;
  } catch (e) {
    logger.warn?.('runtime persistence transition failed', { label: 'RUNTIME', runId: rid, to: targetState, error: String(e) });
    return null;
  }
}

export async function persistRuntimeCheckpoint({
  runId,
  context = {},
  patch = {},
  event = null,
} = {}) {
  const rid = safeText(runId);
  if (!rid) return null;
  try {
    const r = getRedis();
    const cached = await loadRunCheckpoint(r, rid);
    const identity = resolveConversationRuntimeIdentity(context);
    const patchObj = (patch && typeof patch === 'object') ? patch : {};
    const contextLineage = resolveRuntimeLineage(identity, cached);
    const lineage = resolveRuntimeLineage(patchObj, contextLineage);
    const cid = safeText(cached.conversationId || identity.conversationId || 'unknown');
    const now = nowMs();
    const prevCheckpointVersion = Math.max(0, toInt(cached.checkpointVersion, toInt(cached.version, 0)));
    const checkpointVersion = prevCheckpointVersion + 1;
    const prevEventSeq = Math.max(0, toInt(cached.eventSeq, 0));
    const hasEvent = !!(event && typeof event === 'object');
    const eventSeq = hasEvent ? (prevEventSeq + 1) : prevEventSeq;
    const eventIdempotencyKey = hasEvent
      ? (
        safeText((event && typeof event === 'object') ? event.idempotencyKey : '')
        || safeText((event && typeof event === 'object') ? event.eventId : '')
        || `${rid}:event:${eventSeq}`
      )
      : '';
    const eventEnvelope = hasEvent
      ? {
        ts: now,
        seq: eventSeq,
        stateVersion: checkpointVersion,
        idempotencyKey: eventIdempotencyKey,
        ...(event && typeof event === 'object' ? event : {})
      }
      : null;
    const next = {
      ...cached,
      runId: rid,
      conversationId: cid,
      mode: safeText(identity.mode || cached.mode || ''),
      channelId: safeText(identity.channelId || cached.channelId || ''),
      identityKey: safeText(identity.identityKey || cached.identityKey || ''),
      groupId: safeText(identity.groupId || cached.groupId || ''),
      userId: safeText(identity.userId || cached.userId || ''),
      rawConversationId: safeText(identity.rawConversationId || cached.rawConversationId || ''),
      ...patchObj,
      updatedAt: now,
      checkpointVersion,
      stateVersion: checkpointVersion,
      version: checkpointVersion,
      eventSeq,
      lastEventAt: hasEvent ? now : Math.max(0, toInt(cached.lastEventAt, 0)),
      lastCheckpointAt: now,
      orchestratorRunId: lineage.orchestratorRunId,
      parentRunId: lineage.parentRunId,
      runLineage: lineage,
    };
    runCheckpointCache.set(safeId(rid, 'unknown'), next);
    const retentionKeys = buildRuntimeRedisKeys({ conversationId: cid, runId: rid });
    const staleBefore = next.updatedAt - RUNTIME_RETENTION_MS;

    const tx = r.multi();
    if (cid && cid !== 'unknown') {
      tx.zadd(conversationRunsKey(cid), next.updatedAt, rid);
      tx.zremrangebyscore(conversationRunsKey(cid), 0, staleBefore);
    }
    tx.hset(runCheckpointKey(rid), toHashPatch(next));
    if (eventEnvelope) {
      tx.rpush(runEventsKey(rid), JSON.stringify(eventEnvelope));
      tx.ltrim(runEventsKey(rid), -MAX_RUN_EVENTS, -1);
    }
    applyRedisRetentionInTx(tx, retentionKeys);
    await tx.exec();

    await writeRunCheckpointLocal(rid, next);
    if (eventEnvelope) {
      await appendRunEventLocal(rid, eventEnvelope);
    }
    maybeScheduleRetentionSweep('checkpoint');
    return next;
  } catch (e) {
    logger.warn?.('runtime persistence checkpoint failed', { label: 'RUNTIME', runId: rid, error: String(e) });
    return null;
  }
}

function isTerminalStatus(status) {
  const s = safeText(status).toLowerCase();
  return s === 'completed' || s === 'cancelled' || s === 'failed';
}

export async function persistRuntimeRunFinal({
  runId,
  context = {},
  status = 'completed',
  reasonCode = 'run_finished',
  source = 'run_cleanup',
  note = '',
  objective = '',
} = {}) {
  const rid = safeText(runId);
  if (!rid) return null;
  const key = safeId(rid, 'unknown');
  if (finalizedRunCache.has(key)) return null;
  maybePruneFinalizedCache();
  const finalStatus = safeText(status).toLowerCase() || 'completed';
  const finalTs = nowMs();

  try {
    const r = getRedis();
    const current = await loadRunCheckpoint(r, rid);
    const lineage = resolveRuntimeLineage(context, current);
    if (isTerminalStatus(current.status)) {
      finalizedRunCache.set(key, finalTs);
      return null;
    }
    await persistRuntimeCheckpoint({
      runId: rid,
      context,
      patch: {
        status: finalStatus,
        stage: 'terminal',
        finishedAt: finalTs,
        updatedAt: finalTs,
        lastReasonCode: safeText(reasonCode),
      },
      event: {
        type: 'runtime_run_terminal',
        runId: rid,
        status: finalStatus,
        reasonCode: safeText(reasonCode),
        source: safeText(source),
        note: safeText(note),
      },
    });
    await persistRuntimeStateTransition({
      runId: rid,
      context,
      to: 'FINALIZED',
      reasonCode,
      source,
      note,
      objective,
      generation: toInt(current.runtimeSignalGeneration, 0),
      signalSeq: toInt(current.runtimeSignalSeq, 0),
    });

    const identity = resolveConversationRuntimeIdentity(context);
    const runMeta = {
      runId: rid,
      conversationId: safeText(current.conversationId || identity.conversationId || 'unknown'),
      status: finalStatus,
      source: safeText(source),
      finishedAt: finalTs,
      updatedAt: finalTs,
      reasonCode: safeText(reasonCode),
      note: safeText(note),
      orchestratorRunId: lineage.orchestratorRunId,
      parentRunId: lineage.parentRunId,
    };
    const retentionKeys = buildRuntimeRedisKeys({
      conversationId: safeText(current.conversationId || identity.conversationId || ''),
      runId: rid
    });
    const tx = r.multi();
    tx.hset(runMetaKey(rid), toHashPatch(runMeta));
    tx.rpush(runEventsKey(rid), JSON.stringify({ ts: finalTs, type: 'runtime_run_finalized', ...runMeta }));
    tx.ltrim(runEventsKey(rid), -MAX_RUN_EVENTS, -1);
    applyRedisRetentionInTx(tx, retentionKeys);
    await tx.exec();

    await writeRunMetaLocal(rid, runMeta);
    await appendRunEventLocal(rid, { ts: finalTs, type: 'runtime_run_finalized', ...runMeta });

    finalizedRunCache.set(key, finalTs);
    maybeScheduleRetentionSweep('run_final');
    return runMeta;
  } catch (e) {
    logger.warn?.('runtime persistence finalize failed', { label: 'RUNTIME', runId: rid, error: String(e) });
    return null;
  }
}

function normalizeDelayRuntimeSession(rawSession, extras = {}) {
  const session = (rawSession && typeof rawSession === 'object' && !Array.isArray(rawSession))
    ? rawSession
    : null;
  if (!session) return null;
  const sessionId = safeText(session.sessionId);
  if (!sessionId) return null;
  const bufferedEvents = Array.isArray(session.bufferedEvents)
    ? session.bufferedEvents.filter((x) => x && typeof x === 'object').map((x) => ({ ...x }))
    : [];
  const reasonArgs = (session.reasonArgs && typeof session.reasonArgs === 'object' && !Array.isArray(session.reasonArgs))
    ? { ...session.reasonArgs }
    : {};
  const baseMessage = (session.baseMessage && typeof session.baseMessage === 'object' && !Array.isArray(session.baseMessage))
    ? { ...session.baseMessage }
    : null;
  const replayCursorRaw = (session.replayCursor && typeof session.replayCursor === 'object' && !Array.isArray(session.replayCursor))
    ? session.replayCursor
    : {};
  const replayCursor = {
    nextOffset: toInt(replayCursorRaw.nextOffset, 0),
    totalEvents: toInt(replayCursorRaw.totalEvents, 0),
    status: safeText(replayCursorRaw.status || ''),
    lastReplayRunId: safeText(replayCursorRaw.lastReplayRunId || ''),
    updatedAt: toInt(replayCursorRaw.updatedAt, 0)
  };
  return {
    sessionId,
    createdAt: toInt(session.createdAt, 0),
    fireAt: toInt(session.fireAt, 0),
    dueFiredAt: toInt(session.dueFiredAt, 0),
    completedAt: toInt(session.completedAt, 0),
    runId: safeText(session.runId),
    type: safeText(session.type),
    groupId: safeText(session.groupId),
    userId: safeText(session.userId),
    senderId: safeText(session.senderId),
    delayWhenText: safeText(session.delayWhenText),
    delayTargetISO: safeText(session.delayTargetISO),
    reason: safeText(session.reason),
    reasonCode: safeText(session.reasonCode),
    reasonArgs,
    deferredResponseXml: safeText(session.deferredResponseXml),
    bufferedEvents,
    baseMessage,
    replayCursor,
    checkpointRunId: safeText(extras.checkpointRunId),
    checkpointConversationId: safeText(extras.checkpointConversationId),
    checkpointStatus: safeText(extras.checkpointStatus),
    checkpointStage: safeText(extras.checkpointStage),
    orchestratorRunId: safeText(extras.orchestratorRunId),
    parentRunId: safeText(extras.parentRunId),
    updatedAt: toInt(extras.updatedAt, 0),
  };
}

function extractDelayRuntimeSessionFromCheckpoint(checkpoint = {}, fallbackRunId = '') {
  const cp = (checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint))
    ? checkpoint
    : {};
  const raw = cp.delayRuntimeSession;
  const session = normalizeDelayRuntimeSession(raw, {
    checkpointRunId: safeText(cp.runId || fallbackRunId),
    checkpointConversationId: safeText(cp.conversationId),
    checkpointStatus: safeText(cp.status),
    checkpointStage: safeText(cp.stage),
    orchestratorRunId: safeText(cp.orchestratorRunId),
    parentRunId: safeText(cp.parentRunId),
    updatedAt: toInt(cp.updatedAt, 0),
  });
  return session;
}

export async function listRuntimeDelaySessionSnapshots({
  includeCompleted = false,
  limit = 500
} = {}) {
  const cap = Math.max(1, Math.min(5000, toInt(limit, 500)));
  const bySessionId = new Map();
  let entries = [];
  try {
    await ensureDir(RUNTIME_RUNS_DIR);
    entries = await fs.readdir(RUNTIME_RUNS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const ent of entries) {
    if (!ent?.isDirectory?.()) continue;
    const runId = safeText(ent.name);
    if (!runId || runId.startsWith('_')) continue;
    const checkpointPath = path.join(RUNTIME_RUNS_DIR, runId, 'checkpoint.json');
    const local = await readJsonSafe(checkpointPath);
    if (!local || typeof local !== 'object') continue;
    const checkpoint = normalizeRunCheckpointObject(local);
    const session = extractDelayRuntimeSessionFromCheckpoint(checkpoint, runId);
    if (!session) continue;
    if (!includeCompleted && toInt(session.completedAt, 0) > 0) continue;
    const prev = bySessionId.get(session.sessionId);
    if (!prev) {
      bySessionId.set(session.sessionId, session);
      continue;
    }
    const prevUpdated = toInt(prev.updatedAt, 0);
    const nextUpdated = toInt(session.updatedAt, 0);
    if (nextUpdated >= prevUpdated) {
      bySessionId.set(session.sessionId, session);
    }
  }

  return Array.from(bySessionId.values())
    .sort((a, b) => {
      const af = toInt(a.fireAt, 0);
      const bf = toInt(b.fireAt, 0);
      if (af !== bf) return af - bf;
      return toInt(b.updatedAt, 0) - toInt(a.updatedAt, 0);
    })
    .slice(0, cap);
}

export async function loadRuntimeDelaySessionSnapshot({
  sessionId = '',
  runId = '',
  orchestratorRunId = ''
} = {}) {
  const sid = safeText(sessionId);
  const rid = safeText(runId);
  const oid = safeText(orchestratorRunId);

  const directRunIds = [];
  if (rid) directRunIds.push(rid);
  if (oid && oid !== rid) directRunIds.push(oid);
  for (const id of directRunIds) {
    const checkpoint = await loadRuntimeRunCheckpointSnapshot({ runId: id });
    if (!checkpoint || typeof checkpoint !== 'object') continue;
    const session = extractDelayRuntimeSessionFromCheckpoint(checkpoint, id);
    if (!session) continue;
    if (!sid || session.sessionId === sid) return session;
  }

  if (!sid) return null;
  const all = await listRuntimeDelaySessionSnapshots({ includeCompleted: true, limit: 2000 });
  const hit = all.find((item) => safeText(item.sessionId) === sid);
  return hit || null;
}

export default {
  resolveConversationRuntimeIdentity,
  loadRuntimeRunCheckpointSnapshot,
  listRuntimeRunCheckpointSnapshots,
  listRuntimeDelaySessionSnapshots,
  loadRuntimeDelaySessionSnapshot,
  persistRuntimeRunStart,
  persistRuntimeStateTransition,
  persistRuntimeCheckpoint,
  persistRuntimeRunFinal,
};
