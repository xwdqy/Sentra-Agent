import type { FastifyInstance } from 'fastify';
import path from 'path';
import { pathToFileURL } from 'url';

function getSentraRoot() {
  const root = (process.env.SENTRA_ROOT || '..').trim();
  return path.resolve(process.cwd(), root);
}

function normalizeProfile(p: any): 'main' | 'mcp' {
  const s = String(p ?? '').trim().toLowerCase();
  if (s === 'mcp') return 'mcp';
  return 'main';
}

function getEnvPathByProfile(profile: 'main' | 'mcp') {
  const sentraRoot = getSentraRoot();
  if (profile === 'mcp') {
    return path.join(sentraRoot, 'sentra-mcp', '.env');
  }
  return path.join(sentraRoot, '.env');
}

async function getRedisAdminClass() {
  const sentraRoot = getSentraRoot();
  const modPath = path.join(sentraRoot, 'components', 'RedisAdmin.js');
  const url = pathToFileURL(modPath).href;
  const m: any = await import(url);
  const RedisAdmin = m?.RedisAdmin;
  if (!RedisAdmin) {
    throw new Error(`RedisAdmin not found in ${modPath}`);
  }
  return RedisAdmin as any;
}

function asString(v: any) {
  return v == null ? '' : String(v);
}

function formatDateTime(tsMs: number | null) {
  if (!Number.isFinite(tsMs as any)) return null;
  const dt = new Date(Number(tsMs));
  const t = dt.getTime();
  if (!Number.isFinite(t)) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function normalizeTsMs(ts: any): number | null {
  const n = typeof ts === 'number' ? ts : Number(ts);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 1e12) return n * 1000;
  return n;
}

function parseYmdToStartMs(ymd: string): number | null {
  const s = String(ymd || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const dt = new Date(y, mo - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function pickMaxTs(obj: any, keys: string[]): number | null {
  let best: number | null = null;
  for (const k of keys) {
    const v = normalizeTsMs(obj?.[k]);
    if (v == null) continue;
    best = best == null ? v : Math.max(best, v);
  }
  return best;
}

function inferTsFromStringValue(meta: any, raw: any): number | null {
  if (!raw || typeof raw !== 'object') return null;

  if (meta?.category === '会话') {
    const arrs = [raw.userMessages, raw.botMessages];
    let best: number | null = null;
    for (const arr of arrs) {
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        const v = normalizeTsMs(it?.timestamp);
        if (v == null) continue;
        best = best == null ? v : Math.max(best, v);
      }
    }
    return best;
  }

  if (meta?.category === '群会话状态') {
    let best: number | null = null;
    const ap = raw.activePairs && typeof raw.activePairs === 'object' ? raw.activePairs : null;
    if (ap) {
      for (const v of Object.values(ap)) {
        const vv = pickMaxTs(v, ['lastUpdatedAt', 'createdAt']);
        if (vv == null) continue;
        best = best == null ? vv : Math.max(best, vv);
      }
    }
    const slt = raw.senderLastMessageTime && typeof raw.senderLastMessageTime === 'object' ? raw.senderLastMessageTime : null;
    if (slt) {
      for (const v of Object.values(slt)) {
        const vv = normalizeTsMs(v);
        if (vv == null) continue;
        best = best == null ? vv : Math.max(best, vv);
      }
    }
    return best;
  }

  if (meta?.category === '意愿/主动') {
    return pickMaxTs(raw, ['lastUpdateAt', 'lastUserAt', 'lastBotAt', 'lastProactiveAt', 'msgWindowStart']);
  }

  if (meta?.category === '疲劳度') {
    return pickMaxTs(raw, ['lastUserReplyAt', 'lastProactiveAt', 'penaltyUntil']);
  }

  return pickMaxTs(raw, ['updatedAt', 'createdAt', 'timestamp', 'ts', 'tsMs']);
}

function parseKeyMeta(key: string, prefixes: any) {
  const k = asString(key).trim();
  const p = prefixes || {};
  const out: any = {
    key: k,
    category: '其他',
    chatType: null as string | null,
    groupId: null as string | null,
    userId: null as string | null,
    date: null as string | null,
    tsMs: null as number | null,
    extra: {} as Record<string, any>,
  };

  const convPrivatePrefix = asString(p.convPrivate || 'sentra:conv:private:');
  const convGroupPrefix = asString(p.convGroup || 'sentra:conv:group:');
  const groupHistoryPrefix = asString(p.groupHistory || 'sentra:group:');
  const desirePrefix = asString(p.desire || 'sentra:desire:');
  const fatiguePrefix = asString(p.desireUserFatigue || 'sentra:desire:user:');
  const ctxMemPrefix = asString(p.contextMemory || 'sentra:memory:');
  const mcpMetricsPrefix = asString(p.mcpMetrics || 'sentra:mcp:metrics');
  const mcpCtxPrefix = asString(p.mcpContext || 'sentra:mcp:ctx');
  const mcpMemPrefix = asString(p.mcpMem || 'sentra:mcp:mem');

  if (k.startsWith(convPrivatePrefix)) {
    out.category = '会话';
    out.chatType = '私聊';
    out.userId = k.slice(convPrivatePrefix.length) || null;
    return out;
  }

  if (k.startsWith(convGroupPrefix)) {
    out.category = '会话';
    out.chatType = '群聊';
    const rest = k.slice(convGroupPrefix.length);
    const m = rest.match(/^group_(\d+?)_(\d+?)$/);
    if (m) {
      out.groupId = m[1];
      out.userId = m[2];
    }
    return out;
  }

  if (k.startsWith(groupHistoryPrefix)) {
    out.category = '群会话状态';
    out.chatType = '群聊';
    out.groupId = k.slice(groupHistoryPrefix.length) || null;
    return out;
  }

  if (k.startsWith(fatiguePrefix)) {
    out.category = '疲劳度';
    out.userId = k.slice(fatiguePrefix.length) || null;
    return out;
  }

  if (k.startsWith(desirePrefix)) {
    out.category = '意愿/主动';
    const rest = k.slice(desirePrefix.length);
    const m = rest.match(/^(G|U):(.+)$/);
    if (m) {
      if (m[1] === 'G') {
        out.chatType = '群聊';
        out.groupId = m[2];
      } else {
        out.chatType = '私聊';
        out.userId = m[2];
      }
    }
    return out;
  }

  if (k.startsWith(ctxMemPrefix)) {
    out.category = '记忆';
    out.chatType = '群聊';
    const rest = k.slice(ctxMemPrefix.length);
    const m = rest.match(/^(\d+):(.+)$/);
    if (m) {
      out.groupId = m[1];
      const suffix = m[2];
      if (suffix === 'cursor') {
        out.extra.kind = 'cursor';
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(suffix)) {
        out.date = suffix;
        out.tsMs = parseYmdToStartMs(suffix);
      }
    }
    return out;
  }

  if (k.startsWith('att_stats:')) {
    out.category = '关注度';
    const rest = k.slice('att_stats:'.length);
    const m = rest.match(/^(\d+):(\d+)$/);
    if (m) {
      out.chatType = '群聊';
      out.groupId = m[1];
      out.userId = m[2];
    } else {
      const mg = rest.match(/^(\d+):/);
      if (mg) {
        out.chatType = '群聊';
        out.groupId = mg[1];
      }
    }
    return out;
  }

  if (k.startsWith(mcpMetricsPrefix)) {
    out.category = 'MCP 指标';
    const restRaw = k.slice(mcpMetricsPrefix.length);
    const rest = restRaw.startsWith(':') ? restRaw.slice(1) : restRaw;
    out.extra.kind = 'metrics';

    if (rest.startsWith('cooldown:')) {
      out.extra.kind = 'cooldown';
      out.extra.aiName = rest.slice('cooldown:'.length) || null;
      return out;
    }

    if (rest.startsWith('cache:tool:')) {
      out.extra.kind = 'tool_cache';
      const parts = rest.split(':');
      // cache:tool:<aiName>:<hash>
      out.extra.aiName = parts.length >= 3 ? parts[2] : null;
      out.extra.hash = parts.length >= 4 ? parts[3] : null;
      return out;
    }

    // calls/success/failure/latency_*
    const parts = rest.split(':').filter(Boolean);
    if (parts.length >= 2) {
      out.extra.metric = parts[0];
      out.extra.provider = parts[1];
      if (parts[0] === 'failure_code' && parts.length >= 3) {
        out.extra.code = parts[2];
      }
    }
    return out;
  }

  if (k.startsWith(mcpCtxPrefix)) {
    out.category = 'MCP 上下文';
    const restRaw = k.slice(mcpCtxPrefix.length);
    const rest = restRaw.startsWith(':') ? restRaw.slice(1) : restRaw;
    // expected: run:<runId>:history | run:<runId>:plan | run:<runId>:summary
    const mRun = rest.match(/^run:([^:]+):([^:]+)$/);
    if (mRun) {
      out.extra.kind = 'run';
      out.extra.runId = mRun[1];
      out.extra.section = mRun[2];
    }
    return out;
  }

  if (k.startsWith(mcpMemPrefix)) {
    out.category = 'MCP 记忆';
    const pp = mcpMemPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mDoc = k.match(new RegExp(`^${pp}:doc:[^:]+:(\\d{10,13}):`));
    if (mDoc) {
      const ts = Number(mDoc[1]);
      out.tsMs = Number.isFinite(ts) ? (String(mDoc[1]).length === 10 ? ts * 1000 : ts) : null;
      out.date = formatDateTime(out.tsMs);
      out.extra.kind = 'doc';
    }
    const mArg = k.match(new RegExp(`^${pp}:argcache:doc:([^:]+):(\\d{10,13}):`));
    if (mArg) {
      out.extra.aiName = mArg[1];
      const ts = Number(mArg[2]);
      out.tsMs = Number.isFinite(ts) ? (String(mArg[2]).length === 10 ? ts * 1000 : ts) : null;
      out.date = formatDateTime(out.tsMs);
      out.extra.kind = 'argcache';
    }

    const mPlanIdx = k.match(new RegExp(`^${pp}:index:plan$`));
    if (mPlanIdx) {
      out.extra.kind = 'index_plan';
      return out;
    }

    const mToolIdx = k.match(new RegExp(`^${pp}:index:tool:([^:]+)$`));
    if (mToolIdx) {
      out.extra.kind = 'index_tool';
      out.extra.aiName = mToolIdx[1];
      return out;
    }

    const mArgIdx = k.match(new RegExp(`^${pp}:argcache:index:([^:]+)$`));
    if (mArgIdx) {
      out.extra.kind = 'argcache_index';
      out.extra.aiName = mArgIdx[1];
      return out;
    }
    return out;
  }

  return out;
}

export async function redisAdminRoutes(fastify: FastifyInstance) {
  // NOTE: still protected by global x-auth-token middleware.

  fastify.get('/api/redis-admin/health', async () => {
    return {
      enabled: true,
      sentraRoot: getSentraRoot(),
    };
  });

  fastify.get('/api/redis-admin/info', async (_request, reply) => {
    try {
      const profile = normalizeProfile((_request.query as any)?.profile);
      const RedisAdmin = await getRedisAdminClass();
      const envPath = getEnvPathByProfile(profile);
      const admin = new RedisAdmin({ envPath });
      try {
        const cfg = (admin as any)?.redisConfig || {};
        return {
          success: true,
          profile,
          envPath,
          host: cfg.host != null ? String(cfg.host) : null,
          port: cfg.port != null ? Number(cfg.port) : null,
          db: cfg.db != null ? Number(cfg.db) : null,
          hasPassword: !!cfg.password,
          prefixes: (admin as any)?.prefixes || {},
        };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.post('/api/redis-admin/string/set', async (request, reply) => {
    try {
      const body: any = (request as any).body || {};
      const profile = normalizeProfile(body.profile);
      const key = String(body.key || '').trim();
      const value = body.value != null ? String(body.value) : '';

      if (!key) {
        return reply.code(400).send({ success: false, error: 'Missing key' });
      }

      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: getEnvPathByProfile(profile) });

      try {
        const redisType = await admin.redis.type(key);
        if (!redisType || String(redisType).toLowerCase() === 'none') {
          return reply.code(404).send({ success: false, error: `Key not found: ${key}` });
        }
        if (String(redisType).toLowerCase() !== 'string') {
          return reply.code(400).send({ success: false, error: `Only string key is supported, got: ${redisType}` });
        }

        const ttl = await admin.redis.ttl(key);

        if (Number.isFinite(ttl as any) && Number(ttl) > 0) {
          await admin.redis.set(key, value, 'EX', Number(ttl));
        } else {
          await admin.redis.set(key, value);
        }

        const len = await admin.redis.strlen(key);

        return {
          success: true,
          profile,
          key,
          redisType: 'string',
          ttl: Number.isFinite(ttl as any) ? Number(ttl) : null,
          len: Number.isFinite(len as any) ? Number(len) : null,
        };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.post('/api/redis-admin/groupState/deletePairs', async (request, reply) => {
    try {
      const body: any = (request as any).body || {};
      const profile = normalizeProfile(body.profile);
      const groupId = String(body.groupId || '').trim();
      const pairIds = Array.isArray(body.pairIds) ? body.pairIds.map((x: any) => String(x || '').trim()).filter(Boolean) : [];
      const dryRun = body.dryRun === true || body.dryRun === 1 || body.dryRun === '1' || body.dryRun === 'true';

      if (!groupId) {
        return reply.code(400).send({ success: false, error: 'Missing groupId' });
      }
      if (!pairIds.length) {
        return reply.code(400).send({ success: false, error: 'Missing pairIds' });
      }

      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: getEnvPathByProfile(profile) });

      try {
        const key = `${String(admin.prefixes?.groupHistory || 'sentra:group:')}${groupId}`;
        const ttl = await admin.redis.ttl(key);
        const raw = await admin.redis.get(key);
        if (!raw) {
          return reply.code(404).send({ success: false, error: `Key not found: ${key}` });
        }

        let parsed: any = null;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          parsed = null;
        }
        if (!parsed || typeof parsed !== 'object') {
          return reply.code(400).send({ success: false, error: 'Invalid JSON value (not object)' });
        }

        const conv = Array.isArray(parsed.conversations) ? parsed.conversations : [];
        const activePairs = parsed.activePairs && typeof parsed.activePairs === 'object' ? parsed.activePairs : {};

        const uniqPairIds = Array.from(new Set(pairIds));

        const beforeMsgs = conv.length;
        const beforeActive = Object.keys(activePairs).length;

        const drop = new Set(uniqPairIds);
        const nextConv = conv.filter((m: any) => {
          const pid = m && m.pairId != null ? String(m.pairId) : '';
          return !pid || !drop.has(pid);
        });

        const nextActive: Record<string, any> = {};
        for (const [pid, ctx] of Object.entries(activePairs)) {
          const k = String(pid || '');
          if (!k || drop.has(k)) continue;
          (nextActive as any)[k] = ctx;
        }

        const afterMsgs = nextConv.length;
        const afterActive = Object.keys(nextActive).length;

        const deletedMsgs = beforeMsgs - afterMsgs;
        const deletedActive = beforeActive - afterActive;

        if (!dryRun) {
          parsed.conversations = nextConv;
          parsed.activePairs = nextActive;
          const encoded = JSON.stringify(parsed);
          if (Number.isFinite(ttl as any) && Number(ttl) > 0) {
            await admin.redis.set(key, encoded, 'EX', Number(ttl));
          } else {
            await admin.redis.set(key, encoded);
          }
        }

        return {
          success: true,
          profile,
          key,
          dryRun,
          groupId,
          pairIds: uniqPairIds,
          stats: {
            before: { conversations: beforeMsgs, activePairs: beforeActive },
            after: { conversations: afterMsgs, activePairs: afterActive },
            deleted: { conversations: deletedMsgs, activePairs: deletedActive },
          },
        };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.post('/api/redis-admin/groupState/updatePairMessage', async (request, reply) => {
    try {
      const body: any = (request as any).body || {};
      const profile = normalizeProfile(body.profile);
      const groupId = String(body.groupId || '').trim();
      const pairId = String(body.pairId || '').trim();
      const roleRaw = String(body.role || '').trim().toLowerCase();
      const content = body.content != null ? String(body.content) : '';
      const timestamp = body.timestamp != null && body.timestamp !== '' ? Number(body.timestamp) : null;

      if (!groupId) {
        return reply.code(400).send({ success: false, error: 'Missing groupId' });
      }
      if (!pairId) {
        return reply.code(400).send({ success: false, error: 'Missing pairId' });
      }
      if (roleRaw !== 'user' && roleRaw !== 'assistant') {
        return reply.code(400).send({ success: false, error: 'Invalid role, expected user|assistant' });
      }

      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: getEnvPathByProfile(profile) });

      try {
        const key = `${String(admin.prefixes?.groupHistory || 'sentra:group:')}${groupId}`;
        const ttl = await admin.redis.ttl(key);
        const raw = await admin.redis.get(key);
        if (!raw) {
          return reply.code(404).send({ success: false, error: `Key not found: ${key}` });
        }

        let parsed: any = null;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          parsed = null;
        }
        if (!parsed || typeof parsed !== 'object') {
          return reply.code(400).send({ success: false, error: 'Invalid JSON value (not object)' });
        }

        const conv = Array.isArray(parsed.conversations) ? parsed.conversations : [];
        const candidates = (conv as any[])
          .map((m: any, idx: number) => ({ m: m as any, idx }))
          .filter((it: { m: any; idx: number }) => {
            const m = it.m;
            const pid = m && m.pairId != null ? String(m.pairId) : '';
            const r = String(m?.role || '').toLowerCase();
            if (!pid || pid !== pairId) return false;
            if (r !== roleRaw) return false;
            if (timestamp != null && Number.isFinite(timestamp)) {
              const ts = typeof m?.timestamp === 'number' ? m.timestamp : null;
              return ts != null && ts === timestamp;
            }
            return true;
          });

        if (!candidates.length) {
          return reply.code(404).send({
            success: false,
            error: `Pair message not found: groupId=${groupId}, pairId=${pairId}, role=${roleRaw}${timestamp != null ? `, timestamp=${timestamp}` : ''}`,
          });
        }

        const updatedIndexes: number[] = [];
        if (timestamp != null && Number.isFinite(timestamp)) {
          for (const it of candidates) {
            (conv[it.idx] as any).content = content;
            updatedIndexes.push(it.idx);
          }
        } else {
          const first = candidates[0];
          (conv[first.idx] as any).content = content;
          updatedIndexes.push(first.idx);
        }

        parsed.conversations = conv;
        const encoded = JSON.stringify(parsed);
        if (Number.isFinite(ttl as any) && Number(ttl) > 0) {
          await admin.redis.set(key, encoded, 'EX', Number(ttl));
        } else {
          await admin.redis.set(key, encoded);
        }

        return {
          success: true,
          profile,
          key,
          groupId,
          pairId,
          role: roleRaw,
          timestamp: timestamp != null && Number.isFinite(timestamp) ? timestamp : null,
          updatedIndexes,
          updatedCount: updatedIndexes.length,
        };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.get('/api/redis-admin/groups', async (_request, reply) => {
    try {
      const profile = normalizeProfile((_request.query as any)?.profile);
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: getEnvPathByProfile(profile) });
      try {
        return { groups: admin.getKeyGroups() };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.get('/api/redis-admin/overview', async (request, reply) => {
    try {
      const profile = normalizeProfile((request.query as any)?.profile);
      const count = Math.max(1, Number((request.query as any)?.count || 500));
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: getEnvPathByProfile(profile) });
      try {
        const payload = await admin.overview({ count });
        return { success: true, ...payload };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.get('/api/redis-admin/stats', async (request, reply) => {
    try {
      const q: any = request.query || {};
      const profile = normalizeProfile(q.profile);
      const pattern = String(q.pattern || '').trim();
      const count = Math.max(1, Number(q.count || 500));
      const limit = Math.max(1, Number(q.limit || 500));
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: getEnvPathByProfile(profile) });
      try {
        const payload = await admin.statsByPattern(pattern, { count, limit });
        return { success: true, ...payload };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.get('/api/redis-admin/list', async (request, reply) => {
    try {
      const q: any = request.query || {};
      const profile = normalizeProfile(q.profile);
      const pattern = String(q.pattern || '').trim();
      const count = Math.max(1, Number(q.count || 500));
      const withMeta = q.withMeta === '1' || q.withMeta === 1 || q.withMeta === true || q.withMeta === 'true';
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: getEnvPathByProfile(profile) });
      try {
        const keys = await admin.scanKeys(pattern, { count });
        if (!withMeta) {
          return { success: true, pattern, count: keys.length, keys };
        }

        const list = Array.isArray(keys) ? keys : [];
        const pipe = admin.redis.pipeline();
        for (const k of list) {
          pipe.type(k);
          pipe.ttl(k);
        }
        const rows = await pipe.exec();

        const items: any[] = [];

        const lenPipe = admin.redis.pipeline();
        const lenPlan: { key: string; type: string }[] = [];

        for (let i = 0; i < list.length; i++) {
          const typeRow = rows[i * 2];
          const ttlRow = rows[i * 2 + 1];
          const redisType = typeRow && typeRow[1] != null ? String(typeRow[1]) : 'unknown';
          const ttl = ttlRow && ttlRow[1] != null ? Number(ttlRow[1]) : null;

          const meta = parseKeyMeta(list[i], admin.prefixes);
          meta.redisType = redisType;
          meta.ttl = Number.isFinite(ttl as any) ? ttl : null;
          items.push(meta);

          if (redisType === 'list') {
            lenPipe.llen(list[i]);
            lenPlan.push({ key: list[i], type: 'list' });
          } else if (redisType === 'hash') {
            lenPipe.hlen(list[i]);
            lenPlan.push({ key: list[i], type: 'hash' });
          } else if (redisType === 'zset') {
            lenPipe.zcard(list[i]);
            lenPlan.push({ key: list[i], type: 'zset' });
          } else if (redisType === 'set') {
            lenPipe.scard(list[i]);
            lenPlan.push({ key: list[i], type: 'set' });
          } else if (redisType === 'string') {
            lenPipe.strlen(list[i]);
            lenPlan.push({ key: list[i], type: 'string' });
          }
        }

        if (lenPlan.length) {
          const lenRows = await lenPipe.exec();
          const lenMap = new Map<string, number>();
          for (let i = 0; i < lenPlan.length; i++) {
            const r = lenRows[i];
            const n = r && r[1] != null ? Number(r[1]) : null;
            if (Number.isFinite(n as any)) {
              lenMap.set(lenPlan[i].key, Number(n));
            }
          }
          for (const it of items) {
            const n = lenMap.get(it.key);
            if (n != null) it.len = n;
          }
        }

        const maxGetBytes = 220_000;
        const valueKeys: string[] = [];
        const valueIndexByKey = new Map<string, number>();
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (!it || it.tsMs != null) continue;
          if (it.redisType !== 'string') continue;
          const ln = Number.isFinite(Number(it.len)) ? Number(it.len) : null;
          if (ln == null || ln <= 0 || ln > maxGetBytes) continue;
          if (it.category !== '会话' && it.category !== '群会话状态' && it.category !== '意愿/主动' && it.category !== '疲劳度' && it.category !== 'MCP 上下文') continue;
          valueIndexByKey.set(it.key, i);
          valueKeys.push(it.key);
        }

        if (valueKeys.length) {
          const vpipe = admin.redis.pipeline();
          for (const k of valueKeys) vpipe.get(k);
          const vrows = await vpipe.exec();

          for (let i = 0; i < valueKeys.length; i++) {
            const k = valueKeys[i];
            const idx = valueIndexByKey.get(k);
            if (idx == null) continue;
            const row = vrows[i];
            const raw = row && row[1] != null ? row[1] : null;
            if (typeof raw !== 'string' || !raw.trim()) continue;
            let parsed: any = null;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = null;
            }
            const tms = inferTsFromStringValue(items[idx], parsed);
            if (tms != null) {
              items[idx].tsMs = tms;
              if (!items[idx].date) {
                items[idx].date = formatDateTime(tms);
              }
            }
          }
        }

        return { success: true, pattern, count: items.length, items };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.get('/api/redis-admin/inspect', async (request, reply) => {
    try {
      const q: any = request.query || {};
      const profile = normalizeProfile(q.profile);
      const key = String(q.key || '').trim();
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: getEnvPathByProfile(profile) });
      try {
        const payload = await admin.inspectKey(key, {
          preview: q.preview,
          head: q.head,
          tail: q.tail,
          sample: q.sample,
          top: q.top,
        });
        return { success: true, ...payload };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.get('/api/redis-admin/related', async (request, reply) => {
    try {
      const q: any = request.query || {};
      const profile = normalizeProfile(q.profile);
      const groupId = q.groupId != null ? String(q.groupId).trim() : '';
      const userId = q.userId != null ? String(q.userId).trim() : '';
      const count = Math.max(1, Number(q.count || 500));
      const withMeta = q.withMeta === '1' || q.withMeta === 1 || q.withMeta === true || q.withMeta === 'true';
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: getEnvPathByProfile(profile) });
      try {
        const payload = await admin.listRelatedKeys({
          groupId: groupId || null,
          userId: userId || null,
        }, { count });

        if (!withMeta) {
          return { success: true, groupId: groupId || null, userId: userId || null, keys: payload.keys };
        }

        const keyArrays = payload?.keys && typeof payload.keys === 'object' ? Object.values(payload.keys) : [];
        const flattened: string[] = [];
        for (const arr of keyArrays as any[]) {
          if (Array.isArray(arr)) {
            for (const k of arr) {
              if (k) flattened.push(String(k));
            }
          }
        }

        const unique = Array.from(new Set(flattened));
        const pipe = admin.redis.pipeline();
        for (const k of unique) {
          pipe.type(k);
          pipe.ttl(k);
        }
        const rows = await pipe.exec();
        const items: any[] = [];
        for (let i = 0; i < unique.length; i++) {
          const typeRow = rows[i * 2];
          const ttlRow = rows[i * 2 + 1];
          const redisType = typeRow && typeRow[1] != null ? String(typeRow[1]) : 'unknown';
          const ttl = ttlRow && ttlRow[1] != null ? Number(ttlRow[1]) : null;
          const meta = parseKeyMeta(unique[i], admin.prefixes);
          meta.redisType = redisType;
          meta.ttl = Number.isFinite(ttl as any) ? ttl : null;
          items.push(meta);
        }

        return { success: true, groupId: payload.groupId, userId: payload.userId, items };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.post('/api/redis-admin/deleteByPattern', async (request, reply) => {
    try {
      const body: any = request.body || {};
      const profile = normalizeProfile(body.profile);
      const pattern = String(body.pattern || '').trim();
      const dryRun = body.dryRun !== undefined ? !!body.dryRun : true;
      const count = Math.max(1, Number(body.count || 800));

      if (!pattern) return reply.code(400).send({ success: false, error: 'Missing pattern' });

      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: getEnvPathByProfile(profile) });
      try {
        const result = await admin.deleteByPattern(pattern, { dryRun, count });
        return { success: true, ...result };
      } finally {
        await admin.disconnect();
      }
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });
}
