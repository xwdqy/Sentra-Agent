import type { FastifyInstance } from 'fastify';
import path from 'path';
import { pathToFileURL } from 'url';

function getSentraRoot() {
  const root = (process.env.SENTRA_ROOT || '..').trim();
  return path.resolve(process.cwd(), root);
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
    out.category = '群历史';
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

  if (k.startsWith(mcpCtxPrefix)) {
    out.category = 'MCP 上下文';
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

  fastify.get('/api/redis-admin/groups', async (_request, reply) => {
    try {
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: path.join(getSentraRoot(), '.env') });
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
      const count = Math.max(1, Number((request.query as any)?.count || 500));
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: path.join(getSentraRoot(), '.env') });
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
      const pattern = String(q.pattern || '').trim();
      const count = Math.max(1, Number(q.count || 500));
      const limit = Math.max(1, Number(q.limit || 500));
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: path.join(getSentraRoot(), '.env') });
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
      const pattern = String(q.pattern || '').trim();
      const count = Math.max(1, Number(q.count || 500));
      const withMeta = q.withMeta === '1' || q.withMeta === 1 || q.withMeta === true || q.withMeta === 'true';
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: path.join(getSentraRoot(), '.env') });
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
      const key = String(q.key || '').trim();
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: path.join(getSentraRoot(), '.env') });
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
      const groupId = q.groupId != null ? String(q.groupId).trim() : '';
      const userId = q.userId != null ? String(q.userId).trim() : '';
      const count = Math.max(1, Number(q.count || 500));
      const withMeta = q.withMeta === '1' || q.withMeta === 1 || q.withMeta === true || q.withMeta === 'true';
      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: path.join(getSentraRoot(), '.env') });
      try {
        const payload = await admin.listRelatedKeys({
          groupId: groupId || null,
          userId: userId || null,
        }, { count });

        if (!withMeta) {
          return { success: true, ...payload };
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
      const pattern = String(body.pattern || '').trim();
      const dryRun = body.dryRun !== undefined ? !!body.dryRun : true;
      const count = Math.max(1, Number(body.count || 800));

      if (!pattern) return reply.code(400).send({ success: false, error: 'Missing pattern' });

      const RedisAdmin = await getRedisAdminClass();
      const admin = new RedisAdmin({ envPath: path.join(getSentraRoot(), '.env') });
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
