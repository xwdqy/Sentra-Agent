import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';
import { getEnvBool, getEnvInt } from './envHotReloader.js';
import { escapeXml } from './xmlUtils.js';

const logger = createLogger('SocialContextManager');

function safeInt(v: unknown, fallback: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeIdString(v: unknown): string {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s : '';
}

interface SocialGroup {
  group_id?: unknown;
  group_name?: unknown;
}

interface SocialFriend {
  user_id?: unknown;
  nickname?: unknown;
}

interface SocialContextPayload {
  groups?: SocialGroup[];
  friends?: SocialFriend[];
}

interface SocialContextCache {
  cachedAt: number;
  ttlMs: number;
  groups: Array<{ group_id: unknown; group_name: unknown }>;
  friends: Array<{ user_id: unknown; nickname: unknown }>;
  xml: string;
}

interface SocialContextManagerOptions {
  sendAndWaitResult?: (payload: unknown) => Promise<any>;
  cacheDir?: string;
}

type SdkArg =
  | string
  | number
  | boolean
  | null
  | { [key: string]: SdkArg }
  | SdkArg[];

function takeFirst<T>(items: T[], limit: number): T[] {
  if (!Array.isArray(items) || limit <= 0) return [];
  const out: T[] = [];
  for (const item of items) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function buildSocialContextXml(payload: SocialContextPayload): string {
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  const friends = Array.isArray(payload?.friends) ? payload.friends : [];

  const groupCount = groups.length;
  const friendCount = friends.length;

  const lines: string[] = [];
  lines.push('<sentra-social-context>');
  lines.push(`  <groups count="${groupCount}">`);
  for (const g of groups) {
    const gid = normalizeIdString(g?.group_id);
    if (!gid) continue;
    const name = String(g?.group_name ?? '').trim();
    lines.push('    <group>');
    lines.push(`      <id>${gid}</id>`);
    if (name) lines.push(`      <name>${escapeXml(name)}</name>`);
    lines.push('    </group>');
  }
  lines.push('  </groups>');

  lines.push(`  <friends count="${friendCount}">`);
  for (const f of friends) {
    const uid = normalizeIdString(f?.user_id);
    if (!uid) continue;
    const nick = String(f?.nickname ?? '').trim();
    lines.push('    <friend>');
    lines.push(`      <id>${uid}</id>`);
    if (nick) lines.push(`      <name>${escapeXml(nick)}</name>`);
    lines.push('    </friend>');
  }
  lines.push('  </friends>');

  lines.push('</sentra-social-context>');
  return lines.join('\n');
}

export class SocialContextManager {
  sendAndWaitResult: ((payload: unknown) => Promise<any>) | null;
  cacheDir: string;
  cachePath: string;
  cached: SocialContextCache | null;
  refreshing: Promise<SocialContextCache | null> | null;

  constructor(options: SocialContextManagerOptions = {}) {
    this.sendAndWaitResult = typeof options.sendAndWaitResult === 'function' ? options.sendAndWaitResult : null;
    this.cacheDir = options.cacheDir || path.resolve(process.cwd(), 'cache', 'social');
    this.cachePath = path.join(this.cacheDir, 'social_context.json');
    this.cached = null;
    this.refreshing = null;
  }

  isEnabled() {
    return getEnvBool('SOCIAL_CONTEXT_ENABLED', true);
  }

  getTtlMs() {
    return safeInt(getEnvInt('SOCIAL_CONTEXT_TTL_MS', 30 * 60 * 1000), 30 * 60 * 1000);
  }

  getMaxGroups() {
    return safeInt(getEnvInt('SOCIAL_CONTEXT_MAX_GROUPS', 200), 200);
  }

  getMaxFriends() {
    return safeInt(getEnvInt('SOCIAL_CONTEXT_MAX_FRIENDS', 200), 200);
  }

  async _ensureDir() {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
    } catch { }
  }

  async _loadFromDisk() {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf-8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      if (typeof data.cachedAt !== 'number') return null;
      if (typeof data.xml !== 'string') return null;
      return data as SocialContextCache;
    } catch {
      return null;
    }
  }

  async _saveToDisk(data: SocialContextCache): Promise<void> {
    try {
      await this._ensureDir();
      await fs.writeFile(this.cachePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      logger.debug('save cache failed', { err: String(e) });
    }
  }

  _isFresh(data: SocialContextCache, now: number = Date.now()): boolean {
    if (!data || typeof data.cachedAt !== 'number') return false;
    const ttlMs = this.getTtlMs();
    return now - data.cachedAt <= ttlMs;
  }

  async _callSdk(pathStr: string, args: SdkArg[] = []): Promise<unknown> {
    if (typeof this.sendAndWaitResult !== 'function') {
      throw new Error('missing_sendAndWaitResult');
    }
    const payload = {
      type: 'sdk',
      path: pathStr,
      args: Array.isArray(args) ? args : []
    };
    const res = await this.sendAndWaitResult(payload);
    if (!res || res.ok !== true) {
      throw new Error('napcat_sdk_call_failed');
    }
    return res.data;
  }

  _extractOneBotData(resp: unknown): Array<Record<string, unknown>> | null {
    if (!resp) return null;
    if (Array.isArray(resp)) return resp as Array<Record<string, unknown>>;
    if (resp && typeof resp === 'object' && Array.isArray((resp as { data?: unknown }).data)) {
      return (resp as { data: Array<Record<string, unknown>> }).data;
    }
    return null;
  }

  async refresh(force: boolean = false): Promise<SocialContextCache | null> {
    if (!this.isEnabled()) {
      this.cached = null;
      return null;
    }

    const now = Date.now();
    if (!force) {
      if (this.cached && this._isFresh(this.cached, now)) return this.cached;
      const disk = await this._loadFromDisk();
      if (disk && this._isFresh(disk, now)) {
        this.cached = disk;
        return disk;
      }
    }

    if (this.refreshing) return this.refreshing;

    this.refreshing = (async (): Promise<SocialContextCache> => {
      const ttlMs = this.getTtlMs();
      const maxGroups = this.getMaxGroups();
      const maxFriends = this.getMaxFriends();

      let groups: Array<{ group_id: unknown; group_name: unknown }> = [];
      let friends: Array<{ user_id: unknown; nickname: unknown }> = [];

      try {
        const gl = await this._callSdk('group.list', []);
        const arr = this._extractOneBotData(gl);
        if (Array.isArray(arr)) {
          const mapped = arr
            .map((g) => ({ group_id: g?.group_id, group_name: g?.group_name }))
            .filter((g) => normalizeIdString(g?.group_id));
          groups = takeFirst(mapped, maxGroups);
        }
      } catch { }

      try {
        const fl = await this._callSdk('user.friendList', []);
        const arr = this._extractOneBotData(fl);
        if (Array.isArray(arr)) {
          const mapped = arr
            .map((f) => ({ user_id: f?.user_id, nickname: f?.nickname }))
            .filter((f) => normalizeIdString(f?.user_id));
          friends = takeFirst(mapped, maxFriends);
        }
      } catch { }

      const xml = buildSocialContextXml({
        groups,
        friends
      });

      const out: SocialContextCache = {
        cachedAt: Date.now(),
        ttlMs,
        groups,
        friends,
        xml
      };

      this.cached = out;
      await this._saveToDisk(out);
      return out;
    })().finally(() => {
      this.refreshing = null;
    });

    return this.refreshing;
  }

  async getXml() {
    if (!this.isEnabled()) return '';
    try {
      const data = await this.refresh(false);
      return data && typeof data.xml === 'string' ? data.xml : '';
    } catch {
      return '';
    }
  }
}
