import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../src/logger/index.js';
import { httpGet } from '../../src/utils/http.js';
import { ok, fail } from '../../src/utils/result.js';

function isTimeoutError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  const code = String(e?.code || '').toUpperCase();
  return (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'ECONNABORTED' ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  );
}

function buildAdvice(kind, ctx = {}) {
  const personaHint = '请结合你当前的预设/人设继续作答：当获取 QQ 头像失败时，要说明原因（参数/网络/接口限制），给替代方案（确认QQ号/稍后重试/换网络），并引导用户补充信息。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你获取 QQ 头像，但需要提供 user_id 或 user_ids（QQ号）。你把 QQ 号发我一下（单个用 user_id，多个用 user_ids），我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 user_id 或 user_ids（QQ号）',
        '如需强制更新缓存，可设置 useCache=false',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试拉取 QQ 头像，但网络请求超时了。我们可以稍后重试，或者换个网络环境再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试',
        '如果你在内网/代理环境，确认能访问 q.qlogo.cn',
        '必要时 useCache=false 强制刷新',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试获取 QQ 头像，但这次失败了。可能是网络波动或对方头像接口暂时不可用。你可以稍后重试，我也可以帮你确认 QQ 号是否正确。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 user_id 是否正确',
      '稍后重试',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

// In-memory cache: Map<userId, { expireAt:number, data:any }>
const memCache = new Map();
const TTL_SEC = 1800; // 30 minutes

function now() { return Date.now(); }

function getCacheDir() { return path.resolve(process.cwd(), 'cache', 'qq_avatar_get'); }
async function ensureCacheDir() { await fs.mkdir(getCacheDir(), { recursive: true }); }
function getCacheFilePath(userId) {
  const safe = String(userId).replace(/[^\w,-]/g, '_');
  return path.join(getCacheDir(), `${safe}.json`);
}

async function readFileCache(userId) {
  try {
    const p = getCacheFilePath(userId);
    const txt = await fs.readFile(p, 'utf-8');
    const cached = JSON.parse(txt);
    if (cached.expireAt && Number(cached.expireAt) > now()) return cached.data || null;
    return null;
  } catch { return null; }
}

async function writeFileCache(userId, data, ttlSec) {
  try {
    await ensureCacheDir();
    const p = getCacheFilePath(userId);
    const obj = { expireAt: now() + ttlSec * 1000, data, cachedAt: new Date().toISOString() };
    await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) {
    logger.warn?.('qq_avatar_get:write_cache_failed', { label: 'PLUGIN', error: String(e?.message || e) });
  }
}

function getFromMem(userId) {
  const v = memCache.get(String(userId));
  if (v && v.expireAt > now()) return v.data;
  return null;
}
function setToMem(userId, data, ttlSec) {
  memCache.set(String(userId), { expireAt: now() + ttlSec * 1000, data });
}

function buildAvatarUrl(userId) {
  const uid = encodeURIComponent(String(userId));
  return `http://q.qlogo.cn/headimg_dl?dst_uin=${uid}&spec=640&img_type=jpg`;
}

async function downloadToArtifacts(userId) {
  const url = buildAvatarUrl(userId);
  const res = await httpGet(url, { responseType: 'arraybuffer', timeoutMs: 15000, validateStatus: () => true });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(res.data);
  const baseDir = 'artifacts';
  await fs.mkdir(baseDir, { recursive: true });
  const name = `qq_avatar_${String(userId).replace(/[^\w-]/g, '_')}.jpg`;
  const abs = path.resolve(baseDir, name);
  await fs.writeFile(abs, buf);
  return abs.replace(/\\/g, '/');
}

async function fetchOne(userId, useCache) {
  // Try memory cache
  if (useCache) {
    const cached = getFromMem(userId);
    if (cached && cached.path_absolute) {
      return ok({
        user_id: userId,
        path_absolute: cached.path_absolute,
        content: `![avatar](${cached.path_absolute})`,
        path_markdown: `![avatar](${cached.path_absolute})`
      }, 'OK', { cached: true, cache: 'memory' });
    }
  }

  // Try file cache
  if (useCache) {
    const cached = await readFileCache(userId);
    if (cached && cached.path_absolute) {
      // backfill memory cache
      setToMem(userId, cached, TTL_SEC);
      return ok({
        user_id: userId,
        path_absolute: cached.path_absolute,
        content: `![avatar](${cached.path_absolute})`,
        path_markdown: `![avatar](${cached.path_absolute})`
      }, 'OK', { cached: true, cache: 'file' });
    }
  }

  // Download fresh
  try {
    const abs = await downloadToArtifacts(userId);
    const data = { user_id: userId, path_absolute: abs };
    if (useCache) {
      setToMem(userId, data, TTL_SEC);
      await writeFileCache(userId, data, TTL_SEC);
    }
    return ok({
      user_id: userId,
      path_absolute: abs,
      content: `![avatar](${abs})`,
      path_markdown: `![avatar](${abs})`
    }, 'OK', { cached: false });
  } catch (e) {
    logger.warn?.('qq_avatar_get:download_failed', { label: 'PLUGIN', error: String(e?.message || e) });
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_avatar_get', user_id: userId }) });
  }
}

export default async function handler(args = {}, options = {}) {
  const rawArgs = (args && typeof args === 'object') ? args : {};
  const userIds = Array.isArray(rawArgs.user_ids)
    ? rawArgs.user_ids.map((v) => String(v ?? '').trim()).filter(Boolean)
    : [];
  const userId = String(rawArgs.user_id ?? '').trim();
  const inputs = userIds.length ? userIds : (userId ? [userId] : []);

  if (!inputs.length) {
    return fail('user_id/user_ids is required', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_avatar_get' }) });
  }

  const useCache = rawArgs.useCache !== false; // default true
  if (inputs.length === 1) {
    return await fetchOne(inputs[0], useCache);
  }

  const results = [];
  for (const uid of inputs) {
    const out = await fetchOne(uid, useCache);
    results.push({ user_id: uid, ...out });
  }
  return ok({ mode: 'batch', results });
}
