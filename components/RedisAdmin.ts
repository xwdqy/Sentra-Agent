import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Redis, RedisOptions } from 'ioredis';
import dotenv from 'dotenv';

type EnvMap = Record<string, string>;
type CliValue = string | boolean;
type CliArgs = { _: string[] } & Record<string, CliValue | string[]>;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type MsRange =
  | { startMs: number; endMs: number; mode: 'single'; date: string }
  | { startMs: number; endMs: number; mode: 'range'; from: string; to: string };

interface RedisAdminOptions {
  envPath?: string;
  strictEnv?: boolean | number | string;
  host?: string;
  port?: number | string;
  db?: number | string;
  password?: string;
}

interface RedisConfig {
  host: string;
  port: number;
  db: number;
  password?: string;
}

interface RedisPrefixes {
  convPrivate: string;
  convGroup: string;
  groupHistory: string;
  contextMemory: string;
  presetTeachingExamples: string;
  mcpMetrics: string;
  mcpContext: string;
  mcpMem: string;
  desire: string;
  desireUserFatigue: string;
}

interface ScanOptions {
  count?: number;
}

interface DeleteOptions extends ScanOptions {
  dryRun?: boolean;
  batchSize?: number;
  includeCursor?: boolean;
}

interface StatsOptions extends ScanOptions {
  limit?: number;
}

interface InspectOptions {
  preview?: number;
  head?: number;
  tail?: number;
  sample?: number;
  top?: number;
}

interface ListRelatedOptions extends ScanOptions {}
interface OverviewOptions extends ScanOptions {}
interface ExportOptions extends ScanOptions {}

function toBool(v: unknown): boolean {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return false;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function readEnvFileMap(envPath?: unknown): EnvMap {
  try {
    const full = path.resolve(String(envPath || '.env'));
    if (!fs.existsSync(full)) return {};
    const raw = fs.readFileSync(full, 'utf8');
    const parsed = dotenv.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as EnvMap) : {};
  } catch {
    return {};
  }
}

function getEnvFrom(map: EnvMap | null | undefined, name: string, defaultValue: string, strict?: boolean): string;
function getEnvFrom(map: EnvMap | null | undefined, name: string, defaultValue?: string, strict?: boolean): string | undefined;
function getEnvFrom(map: EnvMap | null | undefined, name: string, defaultValue?: string, strict = false) {
  const v = map && Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
  const pv = v !== undefined && v !== null && String(v) !== '' ? String(v) : undefined;
  if (pv !== undefined) return pv;
  if (!strict) {
    const ev = process.env[name];
    if (ev !== undefined && ev !== null && String(ev) !== '') return String(ev);
  }
  return defaultValue;
}

function getEnvIntFrom(map: EnvMap | null | undefined, name: string, defaultValue: number, strict = false): number {
  const v = getEnvFrom(map, name, undefined, strict);
  if (v === undefined) return defaultValue;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function escapeRegex(s: unknown): string {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseYmdToStartMs(ymd: unknown): number | null {
  const s = String(ymd || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || m.length < 4) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function getCliString(args: CliArgs, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

function getCliNumber(args: CliArgs, key: string): number | undefined {
  const raw = args[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function buildMsRangeFromCli(args: CliArgs): MsRange | null {
  const date = getCliString(args, 'date').trim();
  const from = getCliString(args, 'from').trim();
  const to = getCliString(args, 'to').trim();

  if (date) {
    const start = parseYmdToStartMs(date);
    if (start == null) return null;
    return { startMs: start, endMs: start + 86400000, mode: 'single', date };
  }

  if (from || to) {
    const start = from ? parseYmdToStartMs(from) : null;
    const endStart = to ? parseYmdToStartMs(to) : null;
    if (start == null || endStart == null) return null;
    const endMs = endStart + 86400000;
    if (endMs <= start) return null;
    return { startMs: start, endMs, mode: 'range', from, to };
  }

  return null;
}

function ensureTrailingStar(pattern: unknown): string {
  const p = String(pattern || '').trim();
  if (!p) return '';
  return p.includes('*') ? p : `${p}*`;
}

function previewText(raw: unknown, limit = 600): string {
  const s = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
  if (s.length <= limit) return s;
  return s.substring(0, limit) + `... (len=${s.length})`;
}

function safeParseJson(raw: unknown): JsonValue | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try {
    return JSON.parse(s) as JsonValue;
  } catch {
    return null;
  }
}

function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      const k = a.substring(2, eq);
      const v = a.substring(eq + 1);
      out[k] = v;
      continue;
    }
    const k = a.substring(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[k] = next;
      i++;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function takeArrayRange<T>(list: T[], start: number, endExclusive: number): T[] {
  const out: T[] = [];
  if (!Array.isArray(list) || list.length === 0) return out;
  const safeStart = Math.max(0, Math.floor(start));
  const safeEnd = Math.max(safeStart, Math.floor(endExclusive));
  for (let i = safeStart; i < safeEnd && i < list.length; i++) {
    const item = list[i];
    if (item !== undefined) out.push(item);
  }
  return out;
}

export class RedisAdmin {
  options: RedisAdminOptions;
  envPath: string;
  strictEnv: boolean;
  _envMap: EnvMap;
  redisConfig: RedisConfig;
  prefixes: RedisPrefixes;
  redis: Redis;

  constructor(options: RedisAdminOptions = {}) {
    this.options = options && typeof options === 'object' ? options : {};
    this.envPath = path.resolve(String(this.options.envPath || '.env'));

    this.strictEnv = this.options.strictEnv === undefined ? true : toBool(this.options.strictEnv);

    // Isolated env: read .env for THIS CLI only; do NOT mutate process.env and do NOT trigger EnvHotReload logs.
    this._envMap = readEnvFileMap(this.envPath);

    const host = this.options.host || getEnvFrom(this._envMap, 'REDIS_HOST', '127.0.0.1', this.strictEnv);
    const port = Number.isFinite(Number(this.options.port)) ? Number(this.options.port) : getEnvIntFrom(this._envMap, 'REDIS_PORT', 6379, this.strictEnv);
    const db = Number.isFinite(Number(this.options.db)) ? Number(this.options.db) : getEnvIntFrom(this._envMap, 'REDIS_DB', 0, this.strictEnv);
    const password = this.options.password !== undefined
      ? this.options.password
      : (getEnvFrom(this._envMap, 'REDIS_PASSWORD', undefined, this.strictEnv) || undefined);

    this.redisConfig = {
      host,
      port,
      db,
      ...(password !== undefined ? { password } : {}),
    };

    this.prefixes = {
      convPrivate: getEnvFrom(this._envMap, 'REDIS_CONV_PRIVATE_PREFIX', 'sentra:conv:private:', this.strictEnv),
      convGroup: getEnvFrom(this._envMap, 'REDIS_CONV_GROUP_PREFIX', 'sentra:conv:group:', this.strictEnv),
      groupHistory: getEnvFrom(this._envMap, 'REDIS_GROUP_HISTORY_PREFIX', 'sentra:group:', this.strictEnv),
      contextMemory: getEnvFrom(this._envMap, 'REDIS_CONTEXT_MEMORY_PREFIX', 'sentra:memory:', this.strictEnv),
      desire: getEnvFrom(this._envMap, 'REDIS_DESIRE_PREFIX', 'sentra:desire:', this.strictEnv),
      desireUserFatigue: getEnvFrom(this._envMap, 'REDIS_DESIRE_USER_FATIGUE_PREFIX', 'sentra:desire:fatigue:', this.strictEnv),
      presetTeachingExamples: 'sentra:preset:teaching:examples:',
      mcpMetrics: getEnvFrom(this._envMap, 'REDIS_METRICS_PREFIX', 'sentra:mcp:metrics', this.strictEnv),
      mcpContext: getEnvFrom(this._envMap, 'REDIS_CONTEXT_PREFIX', 'sentra:mcp:ctx', this.strictEnv),
      mcpMem: getEnvFrom(this._envMap, 'MEM_PREFIX', 'sentra:mcp:mem', this.strictEnv),
    };

    const redisOptions: RedisOptions = {
      host: this.redisConfig.host,
      port: this.redisConfig.port,
      db: this.redisConfig.db,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    };
    if (this.redisConfig.password !== undefined) {
      redisOptions.password = this.redisConfig.password;
    }
    this.redis = new Redis(redisOptions);

    this.redis.on('error', () => {});
  }

  async connect() {
    if (this.redis.status === 'ready') return;
    if (this.redis.status === 'connecting') return;
    await this.redis.connect();
  }

  async disconnect() {
    try {
      await this.redis.quit();
    } catch {
      try {
        this.redis.disconnect();
      } catch {}
    }
  }

  getKeyGroups(): Record<string, string> {
    const p = this.prefixes;
    return {
      conversation_private: ensureTrailingStar(p.convPrivate),
      conversation_group: ensureTrailingStar(p.convGroup),
      group_history: ensureTrailingStar(p.groupHistory),
      context_memory: ensureTrailingStar(p.contextMemory),
      preset_teaching_examples: ensureTrailingStar(p.presetTeachingExamples),
      mcp_metrics: ensureTrailingStar(p.mcpMetrics),
      mcp_context: ensureTrailingStar(p.mcpContext),
      mcp_memory: ensureTrailingStar(p.mcpMem),
      mcp_tool_cache: ensureTrailingStar(`${p.mcpMetrics}:cache:tool:`),
      mcp_argcache: ensureTrailingStar(`${p.mcpMem}:argcache:`),
    };
  }

  buildConversationPrivateKey(userId: unknown): string | null {
    const uid = String(userId ?? '').trim();
    if (!uid) return null;
    return `${this.prefixes.convPrivate}${uid}`;
  }

  buildConversationGroupKey(groupId: unknown, userId: unknown): string | null {
    const gid = String(groupId ?? '').trim();
    const uid = String(userId ?? '').trim();
    if (!gid || !uid) return null;
    return `${this.prefixes.convGroup}group_${gid}_${uid}`;
  }

  buildGroupHistoryKey(groupId: unknown): string | null {
    const gid = String(groupId ?? '').trim();
    if (!gid) return null;
    return `${this.prefixes.groupHistory}${gid}`;
  }

  buildDesireKey(kind: 'group' | 'private', id: unknown): string | null {
    const raw = String(id ?? '').trim();
    if (!raw) return null;
    if (kind === 'group') return `${this.prefixes.desire}G:${raw}`;
    if (kind === 'private') return `${this.prefixes.desire}U:${raw}`;
    return null;
  }

  buildUserFatigueKey(userId: unknown): string | null {
    const uid = String(userId ?? '').trim();
    if (!uid) return null;
    return `${this.prefixes.desireUserFatigue}${uid}`;
  }

  buildContextMemoryDailyKey(groupId: unknown, ymd: unknown): string | null {
    const gid = String(groupId ?? '').trim();
    const dateStr = String(ymd ?? '').trim();
    if (!gid || !dateStr) return null;
    return `${this.prefixes.contextMemory}${gid}:${dateStr}`;
  }

  buildContextMemoryCursorKey(groupId: unknown): string | null {
    const gid = String(groupId ?? '').trim();
    if (!gid) return null;
    return `${this.prefixes.contextMemory}${gid}:cursor`;
  }

  async scanKeys(pattern: string, opts: ScanOptions = {}): Promise<string[]> {
    await this.connect();
    const match = ensureTrailingStar(pattern);
    const count = Math.max(1, Number(opts.count || 200));

    let cursor = '0';
    const keys: string[] = [];
    while (true) {
      const resp = match
        ? await this.redis.scan(cursor, 'MATCH', match, 'COUNT', String(count))
        : await this.redis.scan(cursor, 'COUNT', String(count));
      const nextCursor = resp && resp[0] != null ? String(resp[0]) : '0';
      const batch = Array.isArray(resp && resp[1]) ? resp[1] : [];
      for (const k of batch) {
        if (k) keys.push(k);
      }
      cursor = nextCursor;
      if (cursor === '0') break;
    }
    return keys;
  }

  async keyTypes(keys: string[] | null | undefined): Promise<Array<{ key: string; type: string }>> {
    await this.connect();
    const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
    if (!list.length) return [];
    const pipeline = this.redis.pipeline();
    for (const k of list) pipeline.type(k);
    const res = await pipeline.exec();
    if (!res) return [];
    const out: Array<{ key: string; type: string }> = [];
    for (let i = 0; i < list.length; i++) {
      const key = list[i];
      if (!key) continue;
      const row = res[i];
      const type = row && row[1] ? String(row[1]) : 'unknown';
      out.push({ key, type });
    }
    return out;
  }

  async exportKeys(keys: string[] | null | undefined): Promise<Record<string, unknown>> {
    await this.connect();
    const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
    if (!list.length) return {};

    const typed = await this.keyTypes(list);
    const byType = new Map<string, string[]>();
    for (const t of typed) {
      const arr = byType.get(t.type) || [];
      arr.push(t.key);
      byType.set(t.type, arr);
    }

    const out: Record<string, unknown> = {};

    const exportString = async (ks: string[]) => {
      const pipe = this.redis.pipeline();
      for (const k of ks) pipe.get(k);
      const res = await pipe.exec();
      if (!res) return;
      for (let i = 0; i < ks.length; i++) {
        const key = ks[i];
        if (!key) continue;
        const row = res[i];
        const v = row && row[1] != null ? row[1] : null;
        out[key] = v;
      }
    };

    const exportList = async (ks: string[]) => {
      const pipe = this.redis.pipeline();
      for (const k of ks) pipe.lrange(k, 0, -1);
      const res = await pipe.exec();
      if (!res) return;
      for (let i = 0; i < ks.length; i++) {
        const key = ks[i];
        if (!key) continue;
        const row = res[i];
        const v = row && Array.isArray(row[1]) ? row[1] : [];
        out[key] = v;
      }
    };

    const exportHash = async (ks: string[]) => {
      const pipe = this.redis.pipeline();
      for (const k of ks) pipe.hgetall(k);
      const res = await pipe.exec();
      if (!res) return;
      for (let i = 0; i < ks.length; i++) {
        const key = ks[i];
        if (!key) continue;
        const row = res[i];
        const v = row && row[1] && typeof row[1] === 'object' ? row[1] : {};
        out[key] = v;
      }
    };

    const exportZSet = async (ks: string[]) => {
      const pipe = this.redis.pipeline();
      for (const k of ks) pipe.zrange(k, 0, -1, 'WITHSCORES');
      const res = await pipe.exec();
      if (!res) return;
      for (let i = 0; i < ks.length; i++) {
        const key = ks[i];
        if (!key) continue;
        const row = res[i];
        const v = row && Array.isArray(row[1]) ? row[1] : [];
        out[key] = v;
      }
    };

    const stringKeys = byType.get('string');
    if (stringKeys && stringKeys.length) await exportString(stringKeys);
    const listKeys = byType.get('list');
    if (listKeys && listKeys.length) await exportList(listKeys);
    const hashKeys = byType.get('hash');
    if (hashKeys && hashKeys.length) await exportHash(hashKeys);
    const zsetKeys = byType.get('zset');
    if (zsetKeys && zsetKeys.length) await exportZSet(zsetKeys);

    const otherKeys: string[] = [];
    for (const [t, ks] of byType.entries()) {
      if (t === 'string' || t === 'list' || t === 'hash' || t === 'zset') continue;
      for (const k of ks) otherKeys.push(k);
    }
    for (const k of otherKeys) {
      out[k] = { type: 'unsupported' };
    }

    return out;
  }

  async deleteKeys(keys: string[] | null | undefined, opts: DeleteOptions = {}) {
    await this.connect();
    const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
    const dryRun = toBool(opts.dryRun);
    const batchSize = Math.max(1, Number(opts.batchSize || 200));

    if (!list.length) return { requested: 0, deleted: 0, dryRun: !!dryRun };
    if (dryRun) return { requested: list.length, deleted: 0, dryRun: true };

    let deleted = 0;
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = takeArrayRange(list, i, i + batchSize);
      try {
        if (typeof this.redis.unlink === 'function') {
          const n = await this.redis.unlink(...batch);
          deleted += Number(n || 0);
        } else {
          const n = await this.redis.del(...batch);
          deleted += Number(n || 0);
        }
      } catch {
        try {
          const n = await this.redis.del(...batch);
          deleted += Number(n || 0);
        } catch {}
      }
    }

    return { requested: list.length, deleted, dryRun: false };
  }

  async deleteByPattern(pattern: string, opts: DeleteOptions = {}) {
    const keys = await this.scanKeys(pattern, { count: opts.count || 500 });
    return {
      pattern: ensureTrailingStar(pattern),
      ...await this.deleteKeys(keys, opts),
    };
  }

  async deleteExact(keys: string[] | null | undefined, opts: DeleteOptions = {}) {
    const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
    return this.deleteKeys(list, opts);
  }

  async deleteConversationPrivate(userId: unknown, opts: DeleteOptions = {}) {
    const k = this.buildConversationPrivateKey(userId);
    const keys = k ? [k] : [];
    return { key: k, ...(await this.deleteExact(keys, opts)) };
  }

  async deleteConversationGroup(groupId: unknown, userId: unknown, opts: DeleteOptions = {}) {
    const k = this.buildConversationGroupKey(groupId, userId);
    const keys = k ? [k] : [];
    return { key: k, ...(await this.deleteExact(keys, opts)) };
  }

  async deleteGroupHistory(groupId: unknown, opts: DeleteOptions = {}) {
    const k = this.buildGroupHistoryKey(groupId);
    const keys = k ? [k] : [];
    return { key: k, ...(await this.deleteExact(keys, opts)) };
  }

  async deleteDesireState(kind: 'group' | 'private', id: unknown, opts: DeleteOptions = {}) {
    const k = this.buildDesireKey(kind, id);
    const keys = k ? [k] : [];
    return { key: k, ...(await this.deleteExact(keys, opts)) };
  }

  async deleteUserFatigue(userId: unknown, opts: DeleteOptions = {}) {
    const k = this.buildUserFatigueKey(userId);
    const keys = k ? [k] : [];
    return { key: k, ...(await this.deleteExact(keys, opts)) };
  }

  async deleteContextMemoryByRange(groupId: unknown, startMs: number, endMs: number, opts: DeleteOptions = {}) {
    const gid = String(groupId ?? '').trim();
    if (!gid) return { error: 'missing groupId' };
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return { error: 'invalid range' };
    }

    const keys: string[] = [];
    const dayMs = 86400000;
    for (let t = startMs; t < endMs; t += dayMs) {
      const dt = new Date(t);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const d = String(dt.getDate()).padStart(2, '0');
      const ymd = `${y}-${m}-${d}`;
      const k = this.buildContextMemoryDailyKey(gid, ymd);
      if (k) keys.push(k);
    }

    if (toBool(opts.includeCursor)) {
      const ck = this.buildContextMemoryCursorKey(gid);
      if (ck) keys.push(ck);
    }

    return { groupId: gid, startMs, endMs, ...(await this.deleteExact(keys, opts)) };
  }

  _extractMcpDocTs(key: unknown, kind: 'mem_doc' | 'argcache_doc'): number | null {
    const p = String(this.prefixes.mcpMem || 'sentra:mcp:mem');
    const pp = escapeRegex(p);
    let re;
    if (kind === 'mem_doc') {
      re = new RegExp(`^${pp}:doc:[^:]+:(\\d{10,13}):`);
    } else if (kind === 'argcache_doc') {
      re = new RegExp(`^${pp}:argcache:doc:[^:]+:(\\d{10,13}):`);
    } else {
      return null;
    }
    const m = String(key || '').match(re);
    if (!m) return null;
    const ts = Number(m[1]);
    return Number.isFinite(ts) ? ts : null;
  }

  _extractMcpArgcacheAiName(key: unknown): string | null {
    const p = String(this.prefixes.mcpMem || 'sentra:mcp:mem');
    const pp = escapeRegex(p);
    const re = new RegExp(`^${pp}:argcache:doc:([^:]+):(\\d{10,13}):`);
    const m = String(key || '').match(re);
    if (!m) return null;
    return String(m[1] || '').trim() || null;
  }

  _extractMcpMemDocId(key: unknown): string | null {
    const p = String(this.prefixes.mcpMem || 'sentra:mcp:mem');
    const prefix = `${p}:doc:`;
    const s = String(key || '');
    if (!s.startsWith(prefix)) return null;
    return s.substring(prefix.length);
  }

  async deleteMcpMemDocsByRange(startMs: number, endMs: number, opts: DeleteOptions = {}) {
    const memPrefix = String(this.prefixes.mcpMem || 'sentra:mcp:mem');
    const pattern = `${memPrefix}:doc:`;
    const keys = await this.scanKeys(pattern, { count: opts.count || 800 });

    const filtered: string[] = [];
    for (const k of keys) {
      const ts = this._extractMcpDocTs(k, 'mem_doc');
      if (ts == null) continue;
      if (ts >= startMs && ts < endMs) filtered.push(k);
    }

    const result = await this.deleteExact(filtered, opts);

    if (!toBool(opts.dryRun) && result && result.deleted > 0) {
      try {
        if (filtered.length) {
          const pipe = this.redis.pipeline();
          for (const k of filtered) pipe.hmget(k, 'type', 'aiName');
          const rows = await pipe.exec();
          if (!rows) return { pattern: ensureTrailingStar(pattern), startMs, endMs, ...result };

          const rmPipe = this.redis.pipeline();
          for (let i = 0; i < filtered.length; i++) {
            const key = filtered[i];
            if (!key) continue;
            const id = this._extractMcpMemDocId(key);
            if (!id) continue;
            const row = rows[i];
            const payload = row && Array.isArray(row[1]) ? row[1] : [];
            const type = payload[0] ? String(payload[0]) : '';
            const aiName = payload[1] ? String(payload[1]) : '';
            if (type === 'plan') {
              rmPipe.zrem(`${memPrefix}:index:plan`, id);
            } else if (type === 'tool' && aiName) {
              rmPipe.zrem(`${memPrefix}:index:tool:${aiName}`, id);
            }
          }
          await rmPipe.exec();
        }
      } catch {}
    }

    return { pattern: ensureTrailingStar(pattern), startMs, endMs, ...result };
  }

  async deleteMcpArgcacheDocsByRange(startMs: number, endMs: number, opts: DeleteOptions = {}) {
    const memPrefix = String(this.prefixes.mcpMem || 'sentra:mcp:mem');
    const pattern = `${memPrefix}:argcache:doc:`;
    const keys = await this.scanKeys(pattern, { count: opts.count || 800 });

    const filtered: string[] = [];
    const aiNames: Array<string | null> = [];
    for (const k of keys) {
      const ts = this._extractMcpDocTs(k, 'argcache_doc');
      if (ts == null) continue;
      if (ts >= startMs && ts < endMs) {
        filtered.push(k);
        aiNames.push(this._extractMcpArgcacheAiName(k));
      }
    }

    const result = await this.deleteExact(filtered, opts);

    if (!toBool(opts.dryRun) && result && result.deleted > 0) {
      try {
        const pipe = this.redis.pipeline();
        for (let i = 0; i < filtered.length; i++) {
          const key = filtered[i];
          const ai = aiNames[i];
          if (!key || !ai) continue;
          pipe.zrem(`${memPrefix}:argcache:index:${ai}`, key);
        }
        await pipe.exec();
      } catch {}
    }

    return { pattern: ensureTrailingStar(pattern), startMs, endMs, ...result };
  }

  async statsByPattern(pattern: string, opts: StatsOptions = {}) {
    await this.connect();
    const keys = await this.scanKeys(pattern, { count: opts.count || 500 });
    const limit = Math.max(1, Number(opts.limit || 500));
    const sliced = takeArrayRange(keys, 0, limit);

    const pipe = this.redis.pipeline();
    for (const k of sliced) {
      pipe.type(k);
      pipe.ttl(k);
    }
    const res = await pipe.exec();
    if (!res) {
      return {
        pattern: ensureTrailingStar(pattern),
        scanned: keys.length,
        sampled: sliced.length,
        byType: {},
        ttl: { expiring: 0, persistent: 0, missing: 0, min: null, max: null },
      };
    }

    const byType: Record<string, number> = {};
    const ttl: { expiring: number; persistent: number; missing: number; min: number | null; max: number | null } = {
      expiring: 0,
      persistent: 0,
      missing: 0,
      min: null,
      max: null,
    };

    for (let i = 0; i < sliced.length; i++) {
      const typeRow = res[i * 2];
      const ttlRow = res[i * 2 + 1];
      const t = typeRow && typeRow[1] ? String(typeRow[1]) : 'unknown';
      byType[t] = (byType[t] || 0) + 1;

      const tv = ttlRow && ttlRow[1] != null ? Number(ttlRow[1]) : NaN;
      if (!Number.isFinite(tv)) continue;
      if (tv === -2) {
        ttl.missing += 1;
      } else if (tv === -1) {
        ttl.persistent += 1;
      } else if (tv >= 0) {
        ttl.expiring += 1;
        ttl.min = ttl.min == null ? tv : Math.min(ttl.min, tv);
        ttl.max = ttl.max == null ? tv : Math.max(ttl.max, tv);
      }
    }

    return {
      pattern: ensureTrailingStar(pattern),
      scanned: keys.length,
      sampled: sliced.length,
      byType,
      ttl,
    };
  }

  async inspectKey(key: unknown, opts: InspectOptions = {}) {
    await this.connect();
    const k = String(key || '').trim();
    if (!k) return { error: 'missing key' };

    const rows = await this.redis
      .multi()
      .type(k)
      .ttl(k)
      .exec();
    const type = rows && rows[0] ? rows[0][1] : null;
    const ttl = rows && rows[1] ? rows[1][1] : null;

    const t = type ? String(type) : 'unknown';
    const ttlNum = Number(ttl);

    const base = { key: k, type: t, ttl: Number.isFinite(ttlNum) ? ttlNum : null };

    if (t === 'string') {
      const v = await this.redis.get(k);
      const json = safeParseJson(v);
      return {
        ...base,
        valuePreview: previewText(v, Number(opts.preview || 900)),
        isJson: json != null,
        json,
      };
    }

    if (t === 'list') {
      const n = await this.redis.llen(k);
      const headN = Math.max(0, Number(opts.head || 3));
      const tailN = Math.max(0, Number(opts.tail || 0));
      const head = headN ? await this.redis.lrange(k, 0, headN - 1) : [];
      const tail = tailN ? await this.redis.lrange(k, Math.max(0, n - tailN), n - 1) : [];
      const headParsed: JsonValue[] = head.map((x) => safeParseJson(x) ?? x);
      const tailParsed: JsonValue[] = tail.map((x) => safeParseJson(x) ?? x);
      return { ...base, len: n, head: headParsed, tail: tailParsed };
    }

    if (t === 'hash') {
      const n = await this.redis.hlen(k);
      const sample = Math.max(0, Number(opts.sample || 8));
      const fields = sample ? await this.redis.hgetall(k) : {};
      const fieldMap: Record<string, string> = fields;
      // For large hashes, hgetall can be heavy; allow sampling by keys
      if (sample && n > sample && fieldMap && typeof fieldMap === 'object') {
        const keys = Object.keys(fieldMap);
        if (keys.length > sample) {
          const sliced = takeArrayRange(keys, 0, sample);
          const picked: Record<string, string> = {};
          for (const kk of sliced) {
            const value = fieldMap[kk];
            if (value !== undefined) picked[kk] = value;
          }
          return { ...base, len: n, fields: picked };
        }
      }
      return { ...base, len: n, fields: fieldMap };
    }

    if (t === 'zset') {
      const n = await this.redis.zcard(k);
      const top = Math.max(0, Number(opts.top || 10));
      const items = top ? await this.redis.zrevrange(k, 0, top - 1, 'WITHSCORES') : [];
      return { ...base, len: n, top: items };
    }

    if (t === 'set') {
      const n = await this.redis.scard(k);
      const sample = Math.max(0, Number(opts.sample || 10));
      const items = sample ? await this.redis.srandmember(k, sample) : [];
      return { ...base, len: n, sample: items };
    }

    return base;
  }

  async listRelatedKeys({ groupId, userId }: { groupId?: string | null; userId?: string | null } = {}, opts: ListRelatedOptions = {}) {
    const gid = String(groupId ?? '').trim();
    const uid = String(userId ?? '').trim();

    const out: { groupId: string | null; userId: string | null; keys: Record<string, string[]> } = {
      groupId: gid || null,
      userId: uid || null,
      keys: {},
    };

    if (uid) {
      const k = this.buildConversationPrivateKey(uid);
      if (k) out.keys.conversation_private = [k];
      const dk = this.buildDesireKey('private', uid);
      if (dk) out.keys.desire_state_user = [dk];
      const fk = this.buildUserFatigueKey(uid);
      if (fk) out.keys.desire_user_fatigue = [fk];
    }

    if (gid) {
      const hk = this.buildGroupHistoryKey(gid);
      if (hk) out.keys.group_history = [hk];
      const dk = this.buildDesireKey('group', gid);
      if (dk) out.keys.desire_state_group = [dk];

      // context memory uses date suffix; list via scan
      const ptn = `${this.prefixes.contextMemory}${gid}:`;
      out.keys.context_memory = await this.scanKeys(ptn, { count: opts.count || 500 });
    }

    if (gid && uid) {
      const k = this.buildConversationGroupKey(gid, uid);
      if (k) out.keys.conversation_group = [k];
      // attention stats key (not configurable via env; defined in utils/attentionStats.js)
      out.keys.attention_stats = [`att_stats:${gid}:${uid}`];
    } else if (gid && !uid) {
      // group-wide attention stats
      const ptn = `att_stats:${gid}:`;
      out.keys.attention_stats = await this.scanKeys(ptn, { count: opts.count || 500 });
    }

    return out;
  }

  async overview(opts: OverviewOptions = {}) {
    const groups = this.getKeyGroups();
    const out: { groups: Record<string, string>; counts: Record<string, number | null> } = { groups, counts: {} };
    for (const [name, pattern] of Object.entries(groups)) {
      try {
        const keys = await this.scanKeys(pattern, { count: opts.count || 500 });
        out.counts[name] = keys.length;
      } catch {
        out.counts[name] = null;
      }
    }
    // Additional hardcoded keys
    try {
      const keys = await this.scanKeys('att_stats:', { count: opts.count || 500 });
      out.counts.attention_stats = keys.length;
    } catch {
      out.counts.attention_stats = null;
    }
    return out;
  }

  async exportByPattern(pattern: string, opts: ExportOptions = {}) {
    const keys = await this.scanKeys(pattern, { count: opts.count || 500 });
    const data = await this.exportKeys(keys);
    return { pattern: ensureTrailingStar(pattern), keys, data };
  }

  async deleteMemories(opts: DeleteOptions = {}) {
    const groups = this.getKeyGroups();
    const targets = [
      groups.context_memory,
      groups.mcp_memory,
      groups.mcp_argcache,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    const results = [];
    for (const ptn of targets) {
      results.push(await this.deleteByPattern(ptn, opts));
    }
    return results;
  }
}

async function main() {
  const args = parseCliArgs(process.argv.filter((_, idx) => idx >= 2));
  const cmd = String(args._[0] || 'help').toLowerCase();
  const envPath = args.env ? String(args.env) : '.env';
  const admin = new RedisAdmin({ envPath });

  const yes = toBool(args.yes);
  const dryRun = toBool(args.dry) || toBool(args['dry-run']) || !yes;
  const count = Math.max(1, getCliNumber(args, 'count') ?? 500);

  const helpText = [
    'Usage:',
    '  node components/RedisAdmin.js list --pattern <glob> [--count 500]',
    '  node components/RedisAdmin.js overview [--count 500]',
    '  node components/RedisAdmin.js groups',
    '  node components/RedisAdmin.js stats --pattern <glob> [--count 500] [--limit 500]',
    '  node components/RedisAdmin.js inspect --key <redisKey> [--preview 900] [--head 3] [--tail 0] [--sample 8] [--top 10]',
    '  node components/RedisAdmin.js related --group <gid> [--user <uid>] [--count 500]',
    '  node components/RedisAdmin.js export --pattern <glob> --out <file.json> [--count 500]',
    '  node components/RedisAdmin.js delete --pattern <glob> --yes [--count 500]',
    '  node components/RedisAdmin.js delete_memories --yes',
    '  node components/RedisAdmin.js delete_conv_private --user <uid> --yes',
    '  node components/RedisAdmin.js delete_conv_group --group <gid> --user <uid> --yes',
    '  node components/RedisAdmin.js delete_group_history --group <gid> --yes',
    '  node components/RedisAdmin.js delete_desire --group <gid> --yes',
    '  node components/RedisAdmin.js delete_desire --user <uid> --yes',
    '  node components/RedisAdmin.js delete_user_fatigue --user <uid> --yes',
    '  node components/RedisAdmin.js delete_context_memory --group <gid> --date YYYY-MM-DD --yes [--include-cursor]',
    '  node components/RedisAdmin.js delete_context_memory --group <gid> --from YYYY-MM-DD --to YYYY-MM-DD --yes [--include-cursor]',
    '  node components/RedisAdmin.js delete_mcp_mem_by_date --date YYYY-MM-DD --yes',
    '  node components/RedisAdmin.js delete_mcp_mem_by_date --from YYYY-MM-DD --to YYYY-MM-DD --yes',
    'Notes:',
    '  delete operations default to dry-run unless you pass --yes',
  ].join('\n');

  try {
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
      process.stdout.write(helpText + '\n');
      return;
    }

    if (cmd === 'groups') {
      const g = admin.getKeyGroups();
      process.stdout.write(JSON.stringify(g, null, 2) + '\n');
      return;
    }

    if (cmd === 'overview') {
      const payload = await admin.overview({ count });
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      return;
    }

    if (cmd === 'list') {
      const pattern = String(args.pattern || args.p || '').trim();
      const keys = await admin.scanKeys(pattern, { count });
      process.stdout.write(JSON.stringify({ pattern: ensureTrailingStar(pattern), count: keys.length, keys }, null, 2) + '\n');
      return;
    }

    if (cmd === 'stats') {
      const pattern = String(args.pattern || args.p || '').trim();
      const limit = Math.max(1, getCliNumber(args, 'limit') ?? 500);
      const payload = await admin.statsByPattern(pattern, { count, limit });
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      return;
    }

    if (cmd === 'inspect') {
      const key = String(args.key || args.k || '').trim();
      const inspectOptions: InspectOptions = {};
      const preview = getCliNumber(args, 'preview');
      const head = getCliNumber(args, 'head');
      const tail = getCliNumber(args, 'tail');
      const sample = getCliNumber(args, 'sample');
      const top = getCliNumber(args, 'top');
      if (preview !== undefined) inspectOptions.preview = preview;
      if (head !== undefined) inspectOptions.head = head;
      if (tail !== undefined) inspectOptions.tail = tail;
      if (sample !== undefined) inspectOptions.sample = sample;
      if (top !== undefined) inspectOptions.top = top;
      const payload = await admin.inspectKey(key, inspectOptions);
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      return;
    }

    if (cmd === 'related') {
      const gid = String(args.group || args.g || '').trim();
      const uid = String(args.user || args.u || '').trim();
      if (!gid && !uid) throw new Error('Missing --group and/or --user');
      const payload = await admin.listRelatedKeys({ groupId: gid || null, userId: uid || null }, { count });
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      return;
    }

    if (cmd === 'export') {
      const pattern = String(args.pattern || args.p || '').trim();
      const outPath = String(args.out || '').trim();
      if (!outPath) {
        throw new Error('Missing --out');
      }
      const payload = await admin.exportByPattern(pattern, { count });
      fs.writeFileSync(path.resolve(outPath), JSON.stringify(payload, null, 2), 'utf8');
      process.stdout.write(JSON.stringify({ ok: true, out: path.resolve(outPath), keys: payload.keys.length }, null, 2) + '\n');
      return;
    }

    if (cmd === 'delete') {
      const pattern = String(args.pattern || args.p || '').trim();
      const result = await admin.deleteByPattern(pattern, { dryRun, count });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    if (cmd === 'delete_memories') {
      const results = await admin.deleteMemories({ dryRun });
      process.stdout.write(JSON.stringify({ dryRun, results }, null, 2) + '\n');
      return;
    }

    if (cmd === 'delete_conv_private') {
      const uid = String(args.user || args.u || '').trim();
      const result = await admin.deleteConversationPrivate(uid, { dryRun });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    if (cmd === 'delete_conv_group') {
      const gid = String(args.group || args.g || '').trim();
      const uid = String(args.user || args.u || '').trim();
      const result = await admin.deleteConversationGroup(gid, uid, { dryRun });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    if (cmd === 'delete_group_history') {
      const gid = String(args.group || args.g || '').trim();
      const result = await admin.deleteGroupHistory(gid, { dryRun });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    if (cmd === 'delete_desire') {
      const gid = String(args.group || args.g || '').trim();
      const uid = String(args.user || args.u || '').trim();
      if (gid) {
        const result = await admin.deleteDesireState('group', gid, { dryRun });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      if (uid) {
        const result = await admin.deleteDesireState('private', uid, { dryRun });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      throw new Error('Missing --group or --user');
    }

    if (cmd === 'delete_user_fatigue') {
      const uid = String(args.user || args.u || '').trim();
      const result = await admin.deleteUserFatigue(uid, { dryRun });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    if (cmd === 'delete_context_memory') {
      const gid = String(args.group || args.g || '').trim();
      const range = buildMsRangeFromCli(args);
      if (!gid) throw new Error('Missing --group');
      if (!range) throw new Error('Missing/invalid --date or --from/--to');
      const includeCursor = toBool(args['include-cursor']) || toBool(args.includeCursor);
      const result = await admin.deleteContextMemoryByRange(gid, range.startMs, range.endMs, { dryRun, includeCursor });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    if (cmd === 'delete_mcp_mem_by_date') {
      const range = buildMsRangeFromCli(args);
      if (!range) throw new Error('Missing/invalid --date or --from/--to');
      const r1 = await admin.deleteMcpMemDocsByRange(range.startMs, range.endMs, { dryRun, count: Math.max(200, count) });
      const r2 = await admin.deleteMcpArgcacheDocsByRange(range.startMs, range.endMs, { dryRun, count: Math.max(200, count) });
      process.stdout.write(JSON.stringify({ dryRun, range, results: [r1, r2] }, null, 2) + '\n');
      return;
    }

    process.stdout.write(helpText + '\n');
  } finally {
    await admin.disconnect();
  }
}

const __filename = fileURLToPath(import.meta.url);
const __entry = process.argv && process.argv[1] ? path.resolve(process.argv[1]) : '';
if (__entry && path.resolve(__entry) === path.resolve(__filename)) {
  main().catch((e) => {
    process.stderr.write(String(e && e.stack ? e.stack : e) + '\n');
    process.exitCode = 1;
  });
}
