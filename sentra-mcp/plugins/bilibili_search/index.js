import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import logger from '../../src/logger/index.js';
import { abs as toAbs } from '../../src/utils/path.js';
import os from 'node:os';
import wsCall from '../../src/utils/ws_rpc.js';
import { getIdsWithCache } from '../../src/utils/message_cache_helper.js';
import { ok, fail } from '../../src/utils/result.js';

function toMarkdownPath(abs) {
  const label = path.basename(abs);
  const mdPath = String(abs).replace(/\\/g, '/');
  return `![${label}](${mdPath})`;
}

// ==== BVID 去重缓存（避免重复推送相同视频，默认 24 小时）====
const BVID_CACHE_TTL_SEC = Number(process.env.BILI_BVID_CACHE_TTL_SEC || 24 * 60 * 60);
const bvidMemCache = new Map(); // Map<bvid, { expireAt:number, data:any }>

function now() { return Date.now(); }

function getBvidCacheDir() {
  return path.resolve(process.cwd(), 'cache', 'bilibili_search');
}

async function ensureBvidCacheDir() {
  await fs.mkdir(getBvidCacheDir(), { recursive: true });
}

function getBvidCacheFilePath(bvid) {
  const safe = String(bvid).replace(/[^\w,-]/g, '_');
  return path.join(getBvidCacheDir(), `${safe}.json`);
}

async function readBvidFileCache(bvid) {
  try {
    const p = getBvidCacheFilePath(bvid);
    const txt = await fs.readFile(p, 'utf-8');
    const cached = JSON.parse(txt);
    if (cached.expireAt && Number(cached.expireAt) > now()) return cached.data || null;
    return null;
  } catch {
    return null;
  }
}

async function writeBvidFileCache(bvid, data, ttlSec) {
  try {
    await ensureBvidCacheDir();
    const p = getBvidCacheFilePath(bvid);
    const obj = {
      expireAt: now() + ttlSec * 1000,
      data,
      cachedAt: new Date().toISOString()
    };
    await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) {
    logger.warn?.('bilibili_search:write_bvid_cache_failed', { label: 'PLUGIN', error: String(e?.message || e) });
  }
}

function getFromBvidMem(bvid) {
  const v = bvidMemCache.get(String(bvid));
  if (v && v.expireAt > now()) return v.data;
  return null;
}

function setToBvidMem(bvid, data, ttlSec) {
  bvidMemCache.set(String(bvid), { expireAt: now() + ttlSec * 1000, data });
}

async function isBvidUsedRecently(bvid) {
  if (!bvid) return false;
  const mem = getFromBvidMem(bvid);
  if (mem) return true;
  const file = await readBvidFileCache(bvid);
  if (file) {
    setToBvidMem(bvid, file, BVID_CACHE_TTL_SEC);
    return true;
  }
  return false;
}

async function markBvidUsed(bvid, context = {}) {
  if (!bvid) return;
  const ttl = BVID_CACHE_TTL_SEC > 0 ? BVID_CACHE_TTL_SEC : 24 * 60 * 60;
  const data = { bvid, ...context };
  setToBvidMem(bvid, data, ttl);
  await writeBvidFileCache(bvid, data, ttl);
}

// Fisher-Yates 洗牌算法，增强随机性
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 基础超时请求封装
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error(`Abort by timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, headers = {}, timeoutMs = 20000) {
  const res = await fetchWithTimeout(url, { headers }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const json = await res.json();
  return json;
}

async function ensureCookie(headers, timeoutMs = 8000) {
  if (headers.cookie) return headers;
  try {
    const res = await fetchWithTimeout('https://www.bilibili.com', { headers: { 'user-agent': headers['user-agent'] || '' } }, timeoutMs);
    const setCookie = [];
    // 收集所有 set-cookie
    for (const [k, v] of res.headers) {
      if (String(k).toLowerCase() === 'set-cookie' && v) setCookie.push(String(v));
    }
    if (typeof res.headers.get === 'function') {
      const one = res.headers.get('set-cookie');
      if (one) setCookie.push(one);
    }
    const cookieHeader = setCookie.map(c => String(c).split(';')[0]).filter(Boolean).join('; ');
    if (cookieHeader) return { ...headers, cookie: cookieHeader };
  } catch {}
  return headers;
}

// 流式下载（使用 pipeline + Transform 实现进度跟踪）
async function downloadToFile(url, absPath, headers = {}, timeoutMs = 120000) {
  const res = await fetchWithTimeout(url, { headers }, timeoutMs);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const ct = (res.headers?.get?.('content-type') || '').split(';')[0].trim();
  
  if (!res.body) throw new Error('no response body');
  
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  
  // 进度跟踪 Transform Stream
  let downloaded = 0;
  const logInterval = 5 * 1024 * 1024; // 5MB
  let lastLog = 0;
  
  const { Transform } = await import('node:stream');
  const progressTransform = new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length;
      if (downloaded - lastLog >= logInterval) {
        logger.info?.('bilibili_search:download_progress', { label: 'PLUGIN', downloadedMB: (downloaded / 1024 / 1024).toFixed(2) });
        lastLog = downloaded;
      }
      callback(null, chunk);
    }
  });
  
  // 超时控制：pipeline 不会自动超时，需要外层包装
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Download timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  
  const downloadPromise = pipeline(
    res.body,
    progressTransform,
    fssync.createWriteStream(absPath)
  );
  
  await Promise.race([downloadPromise, timeoutPromise]);
  
  return { size: downloaded, contentType: ct };
}

// 尝试探测文件大小（优先 HEAD，其次 Range: bytes=0-0）
async function probeContentLength(url, headers = {}, timeoutMs = 8000) {
  // 1) HEAD
  try {
    const res = await fetchWithTimeout(url, { method: 'HEAD', headers }, timeoutMs);
    if (res.ok) {
      const len = res.headers?.get?.('content-length') || '';
      const n = parseInt(len, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {}
  // 2) GET with Range
  try {
    const res = await fetchWithTimeout(url, { headers: { ...headers, Range: 'bytes=0-0' } }, timeoutMs);
    if (res.ok) {
      const cr = res.headers?.get?.('content-range') || '';
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > 0) {
          try { await res?.body?.cancel?.(); } catch {}
          return n;
        }
      }
      try { await res?.body?.cancel?.(); } catch {}
    }
  } catch {}
  return -1;
}

async function searchVideos(keyword, headers = {}, timeoutMs = 20000) {
  const url = `https://api.bilibili.com/x/web-interface/search/type?keyword=${encodeURIComponent(keyword)}&search_type=video`;
  const j = await fetchJson(url, headers, timeoutMs);
  if (j?.code !== 0) throw new Error(`search failed: code=${j?.code} msg=${j?.message || ''}`);
  const items = Array.isArray(j?.data?.result) ? j.data.result : [];
  return items;
}

async function getViewByBvid(bvid, headers = {}, timeoutMs = 20000) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const j = await fetchJson(url, headers, timeoutMs);
  if (j?.code !== 0) throw new Error(`view failed: code=${j?.code} msg=${j?.message || ''}`);
  return j?.data || {};
}

async function getPlayUrl({ bvid, cid, qn = 80, headers = {}, referer = '' }, timeoutMs = 20000) {
  // 优先使用 html5 平台（durl 提供整段 mp4）
  const params = new URLSearchParams({ bvid, cid: String(cid), qn: String(qn), platform: 'html5' });
  const url = `https://api.bilibili.com/x/player/playurl?${params.toString()}`;
  const h = { ...headers, Referer: referer || `https://www.bilibili.com/video/${bvid}` };
  const j = await fetchJson(url, h, timeoutMs);
  if (j?.code !== 0) throw new Error(`playurl failed: code=${j?.code} msg=${j?.message || ''}`);
  const durl = Array.isArray(j?.data?.durl) ? j.data.durl : [];
  if (durl.length === 0) throw new Error('no playable url (durl empty)');
  // 取第一个分段
  const first = durl[0] || {};
  const mainUrl = first?.url;
  const backupUrls = Array.isArray(first?.backup_url) ? first.backup_url.filter(Boolean) : [];
  const allUrls = [mainUrl, ...backupUrls].filter(Boolean);
  if (allUrls.length === 0) throw new Error('no play url');
  const size = Number(first?.size || 0);
  return { urls: allUrls, size: Number.isFinite(size) && size > 0 ? size : 0 };
}

// 构建自定义音乐卡片 segments
function buildCustomMusicCardSegments({ url, audio, title, image }) {
  return [{
    type: 'music',
    data: {
      type: 'custom',
      url: String(url || ''),
      audio: String(audio || ''),
      title: String(title || ''),
      image: String(image || '')
    }
  }];
}

// 通过 WebSocket 发送自定义音乐卡片
async function sendMusicCardViaWS({ wsUrl, timeoutMs, pathList, argStyle }, target, segments) {
  const { user_id, group_id } = target;
  const filteredTarget = user_id ? { user_id } : { group_id };
  const requestIdBase = `${(user_id ? 'private' : 'group')}-${Date.now()}`;

  for (const path of pathList) {
    const requestId = `${path}-${requestIdBase}`;
    const args = (argStyle === 'pair')
      ? (user_id ? [Number(user_id), segments] : [Number(group_id), segments])
      : [{ ...filteredTarget, message: segments }];
    try {
      const resp = await wsCall({ url: wsUrl, path, args, requestId, timeoutMs });
      return { ok: true, path, args, resp };
    } catch (e) {
      logger.warn?.('bilibili_search:ws_send_failed', { label: 'PLUGIN', path, error: String(e?.message || e) });
    }
  }
  return { ok: false };
}

function buildAdvice(kind, ctx = {}) {
  const personaHint = '请结合你当前的预设/人设继续作答：当搜索/获取失败时，要解释原因、给替代方案（换关键词/换模式/改参数/稍后重试），并主动引导用户下一步。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我现在还没拿到你要搜的 B 站关键词，所以没法开始检索。你把想搜的标题/角色/UP 主/关键词发我一下，我再继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '补充 keywords（至少一个）或 keyword（单次）',
        '可以加上更具体的限定词：作品名 + 片段 + “MAD/AMV/剪辑/全集/现场”等',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'NO_RESULT') {
    return {
      suggested_reply: '我翻了一圈 B 站，但没搜到符合这个关键词的视频结果。我们可以换个更常见/更具体的关键词，或者我按你给的描述改写几个更好搜的搜索词再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '换关键词：补充作品名/UP 主/关键桥段/发布时间线索',
        '尝试不同 pick 策略（first/random/fresh 等）',
        '如果你有视频链接/BV 号，直接给我，我可以走“解析/下载/卡片发送”流程',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我这边尝试拉取 B 站数据时卡住了，像是网络/接口超时。我可以先基于已有知识给你建议，或者我们稍后重试一次（也可以换个关键词/降低请求压力）。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试，或换更短更具体的关键词',
        '如果你有可用的 Cookie/代理环境，配置后成功率更高',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'PLAYURL_ERR' || kind === 'NO_PLAYURL' || kind === 'NO_CID') {
    return {
      suggested_reply: '我找到了视频条目，但在解析播放地址/视频信息时失败了（可能是接口限制、需要登录、或该视频分区/清晰度受限）。我可以换一个结果重试，或者切换为“只返回视频页面链接”的模式。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '换一个搜索结果（换 pick 策略或换关键词）',
        '切换模式：仅返回视频页面链接（不下载/不解析播放地址）',
        '如需下载，建议配置 Cookie（部分内容需要登录）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TARGET_REQUIRED') {
    return {
      suggested_reply: '我可以帮你把视频做成音乐卡片发送，但你还没告诉我发到哪里（私聊 user_id 或群聊 group_id）。你把目标发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 user_id（私聊）或 group_id（群聊）',
        '确认 mode=music_card（或开启相应发送参数）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'SEND_FAILED') {
    return {
      suggested_reply: '我找到了视频，但发送音乐卡片时失败了（可能是 WebSocket/适配器状态异常）。我可以把视频链接/信息直接整理给你，或者你确认一下 bot/WS 是否在线后我再重试发送。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS/适配器在线、目标会话可达（user_id/group_id）',
        '改为仅返回视频链接（不发送卡片）',
        '稍后重试发送',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试帮你在 B 站检索/解析视频，但这次工具执行失败了。我可以先给你更好用的搜索关键词建议，或者换个策略再试一次。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '更换关键词或缩小范围后重试',
      '如果你有 BV 号/链接，直接提供可提高成功率',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

async function singleBilibiliSearchHandler(args = {}, options = {}) {
  const keyword = String(args.keyword || '').trim();
  const pick = (args.pick || 'first');
  
  if (!keyword) return { success: false, code: 'INVALID', error: 'keyword is required', advice: buildAdvice('INVALID', { tool: 'bilibili_search' }) };

  const penv = options?.pluginEnv || {};
  
  // 音乐卡片发送功能配置
  const sendAsMusicCard = typeof args.send_as_music_card === 'boolean' 
    ? args.send_as_music_card 
    : String(penv.BILI_SEND_AS_MUSIC_CARD || process.env.BILI_SEND_AS_MUSIC_CARD || 'false').toLowerCase() === 'true';
  
  // 仅在音乐卡片模式下解析 QQ 目标 ID 和 WebSocket 配置，普通模式不依赖 ws 服务
  let user_id;
  let group_id;
  let source;
  let wsUrl;
  let wsSendTimeoutMs;
  let argStyle;
  let pathMain;
  let pathPri;
  let pathGrp;

  if (sendAsMusicCard) {
    const ids = await getIdsWithCache(args, options, 'bilibili_search');
    user_id = ids?.user_id;
    group_id = ids?.group_id;
    source = ids?.source;

    logger.info?.('bilibili_search:ids_resolved', { 
      label: 'PLUGIN', 
      user_id, 
      group_id, 
      source,
      sendAsMusicCard 
    });

    // 如果开启音乐卡片发送，必须提供目标
    if (!user_id && !group_id) {
      return { success: false, code: 'TARGET_REQUIRED', error: '发送音乐卡片时必须提供 user_id（私聊）或 group_id（群聊）', advice: buildAdvice('TARGET_REQUIRED', { tool: 'bilibili_search', keyword }) };
    }

    // WebSocket 配置（音乐卡片模式）
    wsUrl = String(penv.WS_SDK_URL || process.env.WS_SDK_URL || 'ws://127.0.0.1:6702');
    wsSendTimeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || process.env.WS_SDK_TIMEOUT_MS || 15000));
    argStyle = String(penv.WS_SDK_ARG_STYLE || process.env.WS_SDK_ARG_STYLE || 'pair');
    pathMain = String(penv.WS_SDK_SEND_PATH || process.env.WS_SDK_SEND_PATH || '').trim();
    pathPri = String(penv.WS_SDK_SEND_PATH_PRIVATE || process.env.WS_SDK_SEND_PATH_PRIVATE || 'send.private');
    pathGrp = String(penv.WS_SDK_SEND_PATH_GROUP || process.env.WS_SDK_SEND_PATH_GROUP || 'send.group');
  } else {
    logger.info?.('bilibili_search:ids_resolved', { 
      label: 'PLUGIN', 
      user_id: null, 
      group_id: null, 
      source: null,
      sendAsMusicCard 
    });
  }
  
  // B站视频下载配置
  const wantCover = String(penv.BILI_SAVE_COVER || process.env.BILI_SAVE_COVER || 'true').toLowerCase() !== 'false';
  const baseDir = String(penv.BILI_BASE_DIR || process.env.BILI_BASE_DIR || 'artifacts');
  const quality = Number(penv.BILI_QUALITY || process.env.BILI_QUALITY || 80);
  const maxDownloadMB = Number(penv.BILI_MAX_DOWNLOAD_MB || process.env.BILI_MAX_DOWNLOAD_MB || 65);
  const maxBytes = Math.max(1, Math.floor(maxDownloadMB * 1024 * 1024));
  const fetchTimeoutMs = Number(penv.BILI_FETCH_TIMEOUT_MS || process.env.BILI_FETCH_TIMEOUT_MS || 20000);
  const probeTimeoutMs = Number(penv.BILI_PROBE_TIMEOUT_MS || process.env.BILI_PROBE_TIMEOUT_MS || 8000);
  const downloadTimeoutMs = Number(penv.BILI_DOWNLOAD_TIMEOUT_MS || process.env.BILI_DOWNLOAD_TIMEOUT_MS || 120000);
  const strictProbe = String(penv.BILI_STRICT_PROBE || process.env.BILI_STRICT_PROBE || 'true').toLowerCase() !== 'false';
  const userAgent = String(penv.BILI_USER_AGENT || process.env.BILI_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36');
  const cookie = String(penv.BILI_COOKIE || process.env.BILI_COOKIE || '');

  const headers = {
    'user-agent': userAgent,
    'accept': 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'zh-CN,zh;q=0.9',
    ...(cookie ? { cookie } : {}),
  };

  // 如果未提供 Cookie，尝试从 bilibili 首页预取以通过校验
  const headersWithCookie = await ensureCookie(headers, fetchTimeoutMs);

  try {
    logger.info?.('bilibili_search:start', { label: 'PLUGIN', keyword, pick });
    
    logger.info?.('bilibili_search:step:search', { label: 'PLUGIN', keyword, timeout: fetchTimeoutMs });
    const items = await searchVideos(keyword, headersWithCookie, fetchTimeoutMs);
    logger.info?.('bilibili_search:step:search_done', { label: 'PLUGIN', count: items.length });
    if (!items.length) return { success: false, code: 'NO_RESULT', error: `未找到与 "${keyword}" 相关的视频`, advice: buildAdvice('NO_RESULT', { tool: 'bilibili_search', keyword }) };

    // 基于 BVID 做去重过滤，优先选择近期未使用过的视频
    const freshItems = [];
    const skippedBvids = [];
    for (const it of items) {
      const rawBvid = it?.bvid ?? it?.bvid?.trim?.();
      const bvidCandidate = String(rawBvid || '').trim();
      if (!bvidCandidate) {
        freshItems.push(it);
        continue;
      }
      try {
        const used = await isBvidUsedRecently(bvidCandidate);
        if (!used) {
          freshItems.push(it);
        } else {
          skippedBvids.push(bvidCandidate);
        }
      } catch {
        // 缓存异常时不阻塞主流程
        freshItems.push(it);
      }
    }
    if (skippedBvids.length) {
      logger.info?.('bilibili_search:bvid_skipped_by_cache', { label: 'PLUGIN', keyword, count: skippedBvids.length });
    }

    let pool = freshItems.length ? freshItems : items;
    if (pick === 'random') {
      pool = shuffleInPlace([...pool]);
    }

    const chosen = pool[0];
    if (!chosen) return { success: false, code: 'NO_RESULT', error: `未找到与 "${keyword}" 相关的视频`, advice: buildAdvice('NO_RESULT', { tool: 'bilibili_search', keyword }) };

    const title = String(chosen?.title || '').replace(/<[^>]+>/g, '');
    const rawBvidChosen = chosen?.bvid ?? chosen?.bvid?.trim?.();
    const bvid = String(rawBvidChosen || '').trim();
    const up = String(chosen?.author || chosen?.uname || '');
    const duration = String(chosen?.duration || '');
    const pic = String(chosen?.pic || '');
    const urlVideoPage = `https://www.bilibili.com/video/${bvid}`;
    logger.info?.('bilibili_search:step:chosen', { label: 'PLUGIN', bvid, title: title.slice(0, 50) });

    // 获取 cid
    logger.info?.('bilibili_search:step:get_cid', { label: 'PLUGIN', bvid, timeout: fetchTimeoutMs });
    const view = await getViewByBvid(bvid, headersWithCookie, fetchTimeoutMs);
    logger.info?.('bilibili_search:step:get_cid_done', { label: 'PLUGIN', bvid });
    const firstPage = Array.isArray(view?.pages) && view.pages.length > 0 ? view.pages[0] : null;
    const cid = Number(firstPage?.cid || view?.cid || 0);
    if (!cid) return { success: false, code: 'NO_CID', error: '未能解析视频 CID', advice: buildAdvice('NO_CID', { tool: 'bilibili_search', keyword, bvid }) };

    // 播放地址（mp4）
    let playUrls = [];
    let durlSize = 0;
    try {
      logger.info?.('bilibili_search:step:get_playurl', { label: 'PLUGIN', bvid, cid, quality, timeout: fetchTimeoutMs });
      const got = await getPlayUrl({ bvid, cid, qn: quality, headers: headersWithCookie, referer: urlVideoPage }, fetchTimeoutMs);
      playUrls = got.urls || [];
      durlSize = Number(got.size || 0);
      logger.info?.('bilibili_search:step:get_playurl_done', { label: 'PLUGIN', bvid, durlSizeMB: (durlSize / 1024 / 1024).toFixed(2), urlCount: playUrls.length });
    } catch (e) {
      logger.error?.('bilibili_search:step:get_playurl_failed', { label: 'PLUGIN', bvid, error: String(e?.message || e) });
      const rawErr = String(e?.message || e);
      const isTimeout = rawErr.toLowerCase().includes('timeout') || rawErr.toLowerCase().includes('timed out');
      return { success: false, code: isTimeout ? 'TIMEOUT' : 'PLAYURL_ERR', error: rawErr, advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'PLAYURL_ERR', { tool: 'bilibili_search', keyword, bvid }) };
    }
    
    if (!playUrls.length) return { success: false, code: 'NO_PLAYURL', error: '未能获取播放地址', advice: buildAdvice('NO_PLAYURL', { tool: 'bilibili_search', keyword, bvid }) };

    // 获取/预探测视频大小
    let sizeBytes = Number(durlSize || 0);
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      logger.info?.('bilibili_search:step:probe_size', { label: 'PLUGIN', timeout: probeTimeoutMs });
      sizeBytes = await probeContentLength(playUrls[0], { ...headersWithCookie, Referer: urlVideoPage }, probeTimeoutMs);
      logger.info?.('bilibili_search:step:probe_size_done', { label: 'PLUGIN', sizeMB: sizeBytes > 0 ? (sizeBytes / 1024 / 1024).toFixed(2) : 'unknown' });
    } else {
      logger.info?.('bilibili_search:step:size_from_durl', { label: 'PLUGIN', sizeMB: (sizeBytes / 1024 / 1024).toFixed(2) });
    }

    // 保存目录
    const baseAbs = toAbs(baseDir);
    await fs.mkdir(baseAbs, { recursive: true });
    const id = crypto.randomUUID();
    const fileName = `${id}.mp4`;
    const videoAbs = toAbs(path.join(baseAbs, fileName));

    // 结果骨架
    const data = {
      action: 'bilibili_search',
      keyword,
      pick,
      quality,
      url: urlVideoPage,
      bvid,
      title,
      author: up,
      duration,
      play_url: playUrls[0] || '',
      timestamp: new Date().toISOString(),
    };

    // 9) 音乐卡片模式
    if (sendAsMusicCard) {
      logger.info?.('bilibili_search:send_music_card', { label: 'PLUGIN', mode: 'music_card', user_id, group_id });

      const picUrl = pic.startsWith('//') ? `https:${pic}` : pic;
      const segments = buildCustomMusicCardSegments({
        url: urlVideoPage,
        audio: playUrls[0] || '',
        title: title || '未知标题',
        image: picUrl || ''
      });

      const pathList = [pathMain, (user_id ? pathPri : pathGrp)].filter((v, i, a) => !!v && a.indexOf(v) === i);
      const sendRes = await sendMusicCardViaWS(
        { wsUrl, timeoutMs: wsSendTimeoutMs, pathList, argStyle },
        { user_id, group_id },
        segments
      );

      if (sendRes.ok) {
        data.music_card_sent = true;
        data.send_target = user_id ? '私聊' : '群聊';
        data.send_to = user_id || group_id;
        data.status = 'OK_MUSIC_CARD_SENT';
        data.summary = `已成功发送B站视频"${title}"（${bvid}）的音乐卡片到${data.send_target}`;
        data.markdown = [
          '### B 站视频搜索结果',
          '',
          `- 标题：[${title}](${urlVideoPage})`,
          up ? `- UP 主：${up}` : null,
          duration ? `- 时长：${duration}` : null,
          bvid ? `- BV 号：\`${bvid}\`` : null,
          `- 发送方式：${data.send_target}（已以音乐卡片形式发送）`
        ].filter(Boolean).join('\n');
        try {
          await markBvidUsed(bvid, { keyword, mode: 'music_card', status: data.status });
        } catch {}
        logger.info?.('bilibili_search:send_music_card_success', { label: 'PLUGIN', target: data.send_target, to: data.send_to });
        return { success: true, data };
      }

      logger.warn?.('bilibili_search:send_music_card_failed', { label: 'PLUGIN', reason: 'all_ws_paths_failed' });
      return { success: false, code: 'SEND_FAILED', error: '发送音乐卡片失败（所有WebSocket路径均失败）', advice: buildAdvice('SEND_FAILED', { tool: 'bilibili_search', keyword, bvid }) };
    }

    // 10) 下载模式 / 链接模式
    if (Number.isFinite(sizeBytes) && sizeBytes > 0 && sizeBytes > maxBytes) {
      const sizeMB = +(sizeBytes / 1024 / 1024).toFixed(2);
      logger.info?.('bilibili_search:too_large_skip_download', { label: 'PLUGIN', sizeMB, maxDownloadMB });
      data.too_large = true;
      data.size_bytes = sizeBytes;
      data.size_mb = sizeMB;
      data.notice = `已成功获取视频，但体积 ${sizeMB}MB 超过阈值 ${maxDownloadMB}MB，按策略不下载，已提供访问链接`;
      data.downloaded = false;
      data.status = 'OK_LINK_ONLY';
      data.summary = `已成功获取视频"${title}"（${bvid}），体积 ${sizeMB}MB 超过阈值 ${maxDownloadMB}MB，按策略不下载，已提供链接：${urlVideoPage}`;
    } else if ((!Number.isFinite(sizeBytes) || sizeBytes <= 0) && strictProbe) {
      logger.info?.('bilibili_search:unknown_size_skip_download', { label: 'PLUGIN', strictProbe });
      data.unknown_size = true;
      data.downloaded = false;
      data.status = 'OK_LINK_ONLY';
      data.notice = '已获取视频链接，但无法确定文件大小，按严格策略不下载，已提供访问链接';
      data.summary = `已成功获取视频"${title}"（${bvid}），由于无法确定体积，按策略不下载，已提供链接：${urlVideoPage}`;
    } else {
      let videoSize = 0; let contentType = '';
      let lastError = null;
      for (let i = 0; i < playUrls.length; i++) {
        const currentUrl = playUrls[i];
        try {
          logger.info?.('bilibili_search:step:download_start', { label: 'PLUGIN', urlIndex: i, totalUrls: playUrls.length, timeout: downloadTimeoutMs, sizeMB: sizeBytes > 0 ? (sizeBytes / 1024 / 1024).toFixed(2) : 'unknown' });
          const got = await downloadToFile(currentUrl, videoAbs, { ...headersWithCookie, Referer: urlVideoPage }, downloadTimeoutMs);
          videoSize = got.size; contentType = got.contentType;
          logger.info?.('bilibili_search:step:download_done', { label: 'PLUGIN', urlIndex: i, sizeMB: (videoSize / 1024 / 1024).toFixed(2) });
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          logger.warn?.('bilibili_search:download_failed_retry', { label: 'PLUGIN', urlIndex: i, error: String(e?.message || e) });
          if (i < playUrls.length - 1) {
            logger.info?.('bilibili_search:download_retry_backup', { label: 'PLUGIN', nextUrlIndex: i + 1 });
          }
        }
      }

      if (lastError) {
        const note = String(lastError?.message || lastError);
        logger.warn?.('bilibili_search:download_aborted_all_urls', { label: 'PLUGIN', error: note });
        data.downloaded = false;
        data.status = 'OK_LINK_ONLY';
        data.notice = `下载阶段中止（尝试了 ${playUrls.length} 个地址）：${note}。已提供访问链接`;
        data.summary = `已获取视频"${title}"（${bvid}），下载阶段中止（${note}），按策略返回链接：${urlVideoPage}`;
        try {
          await markBvidUsed(bvid, { keyword, mode: 'link_only_after_download_fail', status: data.status });
        } catch {}
        return { success: true, data };
      }

      data.path_markdown = toMarkdownPath(videoAbs);
      data.video = { path_markdown: toMarkdownPath(videoAbs), size: videoSize, contentType };
      data.downloaded = true;
      const sizeMB = +(videoSize / 1024 / 1024).toFixed(2);
      data.size_bytes = videoSize;
      data.size_mb = sizeMB;
      data.status = 'OK_DOWNLOADED';
      data.summary = `已成功下载视频"${title}"（${bvid}），大小 ${sizeMB}MB，保存至本地。`;
    }

    // 11) 下载封面
    if (wantCover && pic) {
      try {
        logger.info?.('bilibili_search:step:download_cover', { label: 'PLUGIN', timeout: fetchTimeoutMs });
        const coverUrl = pic.startsWith('//') ? `https:${pic}` : pic;
        const ext = path.extname(new URL(coverUrl).pathname) || '.jpg';
        const coverName = `${id}_cover${ext}`;
        const coverAbs = toAbs(path.join(baseAbs, coverName));
        const { size: coverSize, contentType: coverType } = await downloadToFile(coverUrl, coverAbs, headersWithCookie, fetchTimeoutMs);
        data.cover = { path_markdown: toMarkdownPath(coverAbs), size: coverSize, contentType: coverType };
        logger.info?.('bilibili_search:step:download_cover_done', { label: 'PLUGIN' });
      } catch (e) {
        logger.warn?.('bilibili_search:cover_download_failed', { label: 'PLUGIN', error: String(e?.message || e) });
      }
    }

    // 12) 构建 Markdown
    try {
      const lines = [];
      lines.push('### B 站视频搜索结果');
      lines.push('');
      lines.push(`- 标题：[${title}](${urlVideoPage})`);
      if (up) lines.push(`- UP 主：${up}`);
      if (duration) lines.push(`- 时长：${duration}`);
      if (bvid) lines.push(`- BV 号：\`${bvid}\``);
      if (data.status) lines.push(`- 状态：${data.status}`);
      if (data.notice) {
        lines.push('');
        lines.push(`> ${data.notice}`);
      }
      if (data.downloaded && data.path_markdown) {
        lines.push('');
        lines.push('本地文件：');
        lines.push('');
        lines.push(data.path_markdown);
      }
      data.markdown = lines.join('\n');
    } catch {}

    // 13) 最终标记 BVID 已使用
    try {
      await markBvidUsed(bvid, { keyword, mode: 'download_or_link', status: data.status });
    } catch {}

    logger.info?.('bilibili_search:complete', { label: 'PLUGIN', status: data.status, downloaded: data.downloaded });
    return { success: true, data };
  } catch (e) {
    logger.error?.('bilibili_search:error', { label: 'PLUGIN', error: String(e?.message || e), stack: e?.stack });
    const rawErr = String(e?.message || e);
    const isTimeout = rawErr.toLowerCase().includes('timeout') || rawErr.toLowerCase().includes('timed out');
    return { success: false, code: isTimeout ? 'TIMEOUT' : 'ERR', error: rawErr, advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'bilibili_search', keyword }) };
  }
}

export default async function handler(args = {}, options = {}) {
  const keywordSingle = (args.keyword !== undefined && args.keyword !== null) ? String(args.keyword || '').trim() : '';
  const rawKeywords = Array.isArray(args.keywords) ? args.keywords : [];
  const usedKeywordsArray = Array.isArray(args.keywords) && args.keywords.length > 0;
  const keywords = [
    ...(keywordSingle ? [keywordSingle] : []),
    ...rawKeywords
      .map((k) => String(k || '').trim())
      .filter((k) => !!k)
  ];

  if (!keywords.length) {
    return fail('keyword/keywords 为必填参数：请提供单个 keyword（如 "鬼灭之刃 MAD"）或 keywords 数组（如 ["鬼灭之刃 MAD","进击的巨人 AMV"]）', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'bilibili_search' }) });
  }

  const delayMinMs = Number(process.env.BILI_SEARCH_DELAY_MIN_MS || 800);
  const delayMaxMs = Number(process.env.BILI_SEARCH_DELAY_MAX_MS || 3000);
  const enableDelay = delayMaxMs > 0 && delayMaxMs >= delayMinMs;

  const results = [];
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    const singleArgs = { ...args, keyword: kw };
    const res = await singleBilibiliSearchHandler(singleArgs, options);
    results.push({
      keyword: kw,
      ...res
    });

    if (enableDelay && i < keywords.length - 1) {
      const delay = delayMinMs + Math.floor(Math.random() * (delayMaxMs - delayMinMs + 1));
      logger.info?.('bilibili_search:inter_keyword_delay', { label: 'PLUGIN', delayMs: delay, index: i, total: keywords.length });
      await sleep(delay);
    }
  }

  const anyOk = results.some((r) => r.success);
  if (anyOk) {
    if (usedKeywordsArray || keywords.length > 1) {
      return ok({ mode: 'batch', results });
    }
    return ok({ results });
  }

  return fail('所有关键词的视频搜索或处理均失败', 'BILIBILI_SEARCH_FAILED', {
    advice: buildAdvice('NO_RESULT', { tool: 'bilibili_search', keywords }),
    detail: (usedKeywordsArray || keywords.length > 1)
      ? { mode: 'batch', results }
      : { results },
  });
}
