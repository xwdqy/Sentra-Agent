import { getRedis } from '../redis/client.js';
import { config } from '../config/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACTS_ROOT } from '../agent/workspace/hash.js';

const prefix = config.redis.contextPrefix;
const RUNTIME_RUNS_DIR = path.join(ARTIFACTS_ROOT, 'runtime', 'runs');
const MAX_BACKUPS_PER_KIND = 120;

const k = (runId, ...parts) => [prefix, 'run', runId, ...parts].join('_');

function safeId(v, fallback = 'unknown') {
  const s = String(v || '').trim().replace(/[^a-zA-Z0-9._@-]/g, '_');
  return s || fallback;
}

function runDir(runId) {
  return path.join(RUNTIME_RUNS_DIR, safeId(runId, 'unknown'));
}

function historyPath(runId) {
  return path.join(runDir(runId), 'history.jsonl');
}

function planPath(runId) {
  return path.join(runDir(runId), 'plan.json');
}

function toolContextPath(runId) {
  return path.join(runDir(runId), 'tool_context.json');
}

function summaryPath(runId) {
  return path.join(runDir(runId), 'summary.json');
}

function backupDir(runId) {
  return path.join(runDir(runId), 'backups');
}

function stepsPath(runId) {
  return path.join(runDir(runId), 'steps.jsonl');
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function appendJsonl(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function writeJsonAtomic(filePath, payload) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}

function applyRange(arr, start = 0, stop = -1) {
  const list = Array.isArray(arr) ? arr : [];
  const n = list.length;
  if (n <= 0) return [];
  let s = Number.isFinite(Number(start)) ? Math.trunc(Number(start)) : 0;
  let e = Number.isFinite(Number(stop)) ? Math.trunc(Number(stop)) : -1;
  if (s < 0) s = n + s;
  if (e < 0) e = n + e;
  s = Math.max(0, s);
  e = Math.min(n - 1, e);
  if (s > e) return [];
  return list.slice(s, e + 1);
}

function normalizeToolContextSkillDoc(skillDoc = null) {
  const src = (skillDoc && typeof skillDoc === 'object') ? skillDoc : null;
  if (!src) return null;
  const normalizeList = (value, maxItems = 16) => {
    const out = [];
    const srcArr = Array.isArray(value) ? value : [];
    for (const item of srcArr) {
      const text = String(item ?? '').trim();
      if (!text) continue;
      out.push(text);
      if (out.length >= maxItems) break;
    }
    return out;
  };
  return {
    path: String(src.path || '').trim(),
    whenToUse: normalizeList(src.whenToUse, 24),
    whenNotToUse: normalizeList(src.whenNotToUse, 24),
    successCriteria: normalizeList(src.successCriteria, 32)
  };
}

function buildToolContextSnapshot(plan = null) {
  const manifest = Array.isArray(plan?.manifest) ? plan.manifest : [];
  return manifest
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      aiName: String(item.aiName || '').trim(),
      name: String(item.name || '').trim(),
      provider: String(item.provider || '').trim(),
      executor: String(item.executor || '').trim(),
      actionRef: String(item.actionRef || '').trim(),
      description: String(item.description || '').trim(),
      inputSchema: (item.inputSchema && typeof item.inputSchema === 'object') ? item.inputSchema : {},
      meta: (item.meta && typeof item.meta === 'object') ? item.meta : {},
      skillDoc: normalizeToolContextSkillDoc(item.skillDoc || null)
    }))
    .filter((item) => item.aiName);
}

async function readHistoryLocal(runId) {
  try {
    const raw = await fs.readFile(historyPath(runId), 'utf8');
    const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        out.push({ raw: line });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function writeBackupSnapshot(runId, kind, payload) {
  try {
    const dir = backupDir(runId);
    await ensureDir(dir);
    const ts = Date.now();
    const base = `${String(kind || 'snapshot').replace(/[^a-zA-Z0-9._-]/g, '_')}_${ts}`;
    const file = path.join(dir, `${base}.json`);
    await writeJsonAtomic(file, payload);

    const names = (await fs.readdir(dir))
      .filter((n) => n.startsWith(`${String(kind || 'snapshot').replace(/[^a-zA-Z0-9._-]/g, '_')}_`) && n.endsWith('.json'))
      .sort();
    if (names.length > MAX_BACKUPS_PER_KIND) {
      const removeCount = names.length - MAX_BACKUPS_PER_KIND;
      for (let i = 0; i < removeCount; i++) {
        try { await fs.rm(path.join(dir, names[i]), { force: true }); } catch {}
      }
    }
  } catch {}
}

async function appendHistoryLocal(runId, payload) {
  try {
    await appendJsonl(historyPath(runId), payload);
    await appendJsonl(path.join(backupDir(runId), 'history_backup.jsonl'), payload);
  } catch {}
}

async function appendStepDetailLocal(runId, payload) {
  try {
    await appendJsonl(stepsPath(runId), payload);
  } catch {}
}

async function mirrorStepDetails(runId, payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const ts = Number.isFinite(Number(p.ts)) ? Number(p.ts) : Date.now();
  const typ = String(p.type || '').trim();
  if (typ === 'args') {
    await appendStepDetailLocal(runId, {
      ts,
      type: 'args',
      plannedStepIndex: p.plannedStepIndex,
      stepIndex: p.stepIndex,
      stepId: p.stepId,
      aiName: p.aiName,
      executor: p.executor,
      actionRef: p.actionRef,
      reason: p.reason,
      nextStep: p.nextStep,
      args: p.args ?? {},
      reused: p.reused === true,
      toolContext: (p.toolContext && typeof p.toolContext === 'object') ? p.toolContext : null,
      toolMeta: (p.toolMeta && typeof p.toolMeta === 'object') ? p.toolMeta : null,
      dependsOnStepIds: Array.isArray(p.dependsOnStepIds) ? p.dependsOnStepIds : [],
      dependedByStepIds: Array.isArray(p.dependedByStepIds) ? p.dependedByStepIds : [],
      groupId: p.groupId ?? null,
    });
    return;
  }
  if (typ === 'action_request') {
    const action = (p.action && typeof p.action === 'object') ? p.action : {};
    const input = (p.input && typeof p.input === 'object') ? p.input : {};
    await appendStepDetailLocal(runId, {
      ts,
      type: 'action_request',
      plannedStepIndex: p.plannedStepIndex,
      stepIndex: p.stepIndex,
      executionIndex: p.executionIndex,
      stepId: p.stepId,
      aiName: action.aiName || p.aiName || '',
      executor: action.executor || p.executor || '',
      actionRef: action.actionRef || p.actionRef || '',
      attemptNo: p.attemptNo,
      args: (input.args && typeof input.args === 'object') ? input.args : {},
      reason: p.reason || '',
      nextStep: p.nextStep || '',
      dependsOnStepIds: Array.isArray(p.dependsOnStepIds) ? p.dependsOnStepIds : [],
      dependedByStepIds: Array.isArray(p.dependedByStepIds) ? p.dependedByStepIds : [],
      toolContext: (p.toolContext && typeof p.toolContext === 'object') ? p.toolContext : null,
      groupId: p.groupId ?? null,
    });
    return;
  }
  if (typ === 'step_state') {
    await appendStepDetailLocal(runId, {
      ts,
      type: 'step_state',
      plannedStepIndex: p.plannedStepIndex,
      stepIndex: p.stepIndex,
      stepId: p.stepId,
      aiName: p.aiName || '',
      executor: p.executor || '',
      actionRef: p.actionRef || '',
      from: p.from || '',
      to: p.to || '',
      reasonCode: p.reasonCode || '',
      reason: p.reason || '',
      resultCode: p.resultCode || '',
      attemptNo: p.attemptNo,
      groupId: p.groupId ?? null,
    });
    return;
  }
  if (typ === 'tool_result') {
    const actionResult = (p.actionResult && typeof p.actionResult === 'object') ? p.actionResult : null;
    const actionArgs = (actionResult?.input && typeof actionResult.input === 'object')
      ? (actionResult.input.args ?? null)
      : null;
    await appendStepDetailLocal(runId, {
      ts,
      type: 'tool_result',
      plannedStepIndex: p.plannedStepIndex,
      executionIndex: p.executionIndex,
      stepId: p.stepId,
      aiName: p.aiName,
      executor: p.executor,
      actionRef: p.actionRef,
      reason: p.reason,
      nextStep: p.nextStep,
      elapsedMs: p.elapsedMs,
      args: actionArgs,
      result: p.result ?? {},
      actionResult,
      toolContext: (p.toolContext && typeof p.toolContext === 'object') ? p.toolContext : null,
      toolMeta: (p.toolMeta && typeof p.toolMeta === 'object') ? p.toolMeta : null,
      dependsOnStepIds: Array.isArray(p.dependsOnStepIds) ? p.dependsOnStepIds : [],
      dependedByStepIds: Array.isArray(p.dependedByStepIds) ? p.dependedByStepIds : [],
      groupId: p.groupId ?? null,
    });
    return;
  }
  if (typ === 'tool_result_group' && Array.isArray(p.events)) {
    const groupId = p.groupId ?? null;
    for (const ev of p.events) {
      if (!ev || typeof ev !== 'object') continue;
      if (String(ev.type || '') !== 'tool_result') continue;
      const actionResult = (ev.actionResult && typeof ev.actionResult === 'object') ? ev.actionResult : null;
      const actionArgs = (actionResult?.input && typeof actionResult.input === 'object')
        ? (actionResult.input.args ?? null)
        : null;
      await appendStepDetailLocal(runId, {
        ts,
        type: 'tool_result',
        fromGroup: true,
        groupId,
        plannedStepIndex: ev.plannedStepIndex,
        executionIndex: ev.executionIndex,
        stepId: ev.stepId,
        aiName: ev.aiName,
        executor: ev.executor,
        actionRef: ev.actionRef,
        reason: ev.reason,
        nextStep: ev.nextStep,
        elapsedMs: ev.elapsedMs,
        args: actionArgs,
        result: ev.result ?? {},
        actionResult,
        toolContext: (ev.toolContext && typeof ev.toolContext === 'object') ? ev.toolContext : null,
        toolMeta: (ev.toolMeta && typeof ev.toolMeta === 'object') ? ev.toolMeta : null,
        dependsOnStepIds: Array.isArray(ev.dependsOnStepIds) ? ev.dependsOnStepIds : [],
        dependedByStepIds: Array.isArray(ev.dependedByStepIds) ? ev.dependedByStepIds : [],
      });
    }
  }
}

export const HistoryStore = {
  async append(runId, entry) {
    const rid = safeId(runId, 'unknown');
    const payload = { ts: Date.now(), ...entry };
    try {
      const r = getRedis();
      await r.rpush(k(rid, 'history'), JSON.stringify(payload));
    } catch {}
    await appendHistoryLocal(rid, payload);
    await mirrorStepDetails(rid, payload);
  },
  async list(runId, start = 0, stop = -1) {
    const rid = safeId(runId, 'unknown');
    try {
      const r = getRedis();
      const items = await r.lrange(k(rid, 'history'), start, stop);
      return items.map((x) => {
        try { return JSON.parse(x); } catch { return { raw: x }; }
      });
    } catch {
      const items = await readHistoryLocal(rid);
      return applyRange(items, start, stop);
    }
  },
  async len(runId) {
    const rid = safeId(runId, 'unknown');
    try {
      const r = getRedis();
      return r.llen(k(rid, 'history'));
    } catch {
      const items = await readHistoryLocal(rid);
      return items.length;
    }
  },
  async setPlan(runId, plan) {
    const rid = safeId(runId, 'unknown');
    const payload = { ts: Date.now(), plan };
    const toolContextPayload = {
      ts: Date.now(),
      runId: rid,
      tools: buildToolContextSnapshot(plan)
    };
    try {
      const r = getRedis();
      await r.set(k(rid, 'plan'), JSON.stringify(plan));
    } catch {}
    try {
      await writeJsonAtomic(planPath(rid), payload);
      await writeJsonAtomic(toolContextPath(rid), toolContextPayload);
      await writeBackupSnapshot(rid, 'plan', payload);
      await writeBackupSnapshot(rid, 'tool_context', toolContextPayload);
    } catch {}
  },
  async getPlan(runId) {
    const rid = safeId(runId, 'unknown');
    try {
      const r = getRedis();
      const v = await r.get(k(rid, 'plan'));
      return v ? JSON.parse(v) : null;
    } catch {
      const local = await readJsonSafe(planPath(rid));
      if (!local) return null;
      if (Object.prototype.hasOwnProperty.call(local, 'plan')) return local.plan;
      return local;
    }
  },
  async setSummary(runId, summary) {
    const rid = safeId(runId, 'unknown');
    const payload = { ts: Date.now(), summary };
    try {
      const r = getRedis();
      await r.set(k(rid, 'summary'), JSON.stringify(payload));
    } catch {}
    try {
      await writeJsonAtomic(summaryPath(rid), payload);
      await writeBackupSnapshot(rid, 'summary', payload);
    } catch {}
  },
  async getSummary(runId) {
    const rid = safeId(runId, 'unknown');
    try {
      const r = getRedis();
      const v = await r.get(k(rid, 'summary'));
      return v ? JSON.parse(v) : null;
    } catch {
      const local = await readJsonSafe(summaryPath(rid));
      if (!local) return null;
      if (Object.prototype.hasOwnProperty.call(local, 'summary')) return local;
      return { ts: Date.now(), summary: String(local || '') };
    }
  },
};

export default HistoryStore;
