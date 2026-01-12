import logger from '../../src/logger/index.js';
import wsCall from '../../src/utils/ws_rpc.js';
import { getIdsWithCache } from '../../src/utils/message_cache_helper.js';
import { httpRequest } from '../../src/utils/http.js';
import { ok, fail } from '../../src/utils/result.js';

function buildAdvice(kind, ctx = {}) {
  const personaHint = '请结合你当前的预设/人设继续作答：当发送音乐卡片失败时，要说明原因（关键词/平台/发送权限/网络），给替代方案（换关键词/换歌/回退发送音频/稍后重试），并引导用户补充必要信息。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我需要你提供要搜索的歌曲关键词（keywords/keyword），当前缺失所以没法发送音乐卡片。你把歌名+歌手发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 keywords（数组）或 keyword（单条）',
        '可选提供 provider=163、limit、random、pick',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'SEND_FAILED') {
    return {
      suggested_reply: '我找到歌曲了，但通过 WS 发送音乐卡片失败了（可能是 WS 地址/权限/接口路径不对）。如果你愿意，我可以尝试回退发送音频直链，或者你把 WS_SDK_URL / 发送路径确认一下我们再重试。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS_SDK_URL 可用（默认 ws://localhost:6702）',
        '确认 WS_SDK_SEND_PATH(_PRIVATE/_GROUP) 与实际 OneBot/NapCat 路径一致',
        '可开启 fallback_to_record=true 回退发送音频直链',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试发送音乐卡片，但这次失败了。你可以换一个关键词/指定歌手/或让我回退发送音频直链；也可以稍后重试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '换关键词（歌名 + 歌手）再试',
      '或开启 fallback_to_record=true',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function pickOne(arr, idx, random) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (random) return arr[Math.floor(Math.random() * arr.length)];
  const i = toInt(idx) ?? 0;
  return arr[Math.max(0, Math.min(arr.length - 1, i))];
}

async function searchMusic163(keyword, limit = 6) {
  const url = `http://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=${limit}`;
  const res = await httpRequest({
    method: 'GET',
    url,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeoutMs: 15000,
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`163 search HTTP ${res.status}`);
  const json = res.data;
  const songs = json?.result?.songs || [];
  return songs.map((s) => ({
    id: s.id,
    name: s.name,
    artists: Array.isArray(s.artists) ? s.artists.map((a) => a?.name).filter(Boolean).join('&') : '',
    alias: Array.isArray(s.alias) && s.alias.length ? s.alias.join(',') : 'none',
  }));
}

async function getMusicUrl163(ids, musicUCookie = '') {
  let url = `http://music.163.com/song/media/outer/url?id=${ids}`;
  if (!musicUCookie) return url; // 无 COOKIE 直接返回外链（通常会302到实际地址）
  const body = `ids=${encodeURIComponent(JSON.stringify([ids]))}&level=standard&encodeType=mp3`;
  const res = await httpRequest({
    method: 'POST',
    url: 'https://music.163.com/api/song/enhance/player/url/v1',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 12; MI Build/SKQ1.211230.001)',
      'Cookie': `versioncode=8008070; os=android; channel=xiaomi; appver=8.8.70; MUSIC_U=${musicUCookie}`,
    },
    data: body,
    timeoutMs: 15000,
    validateStatus: () => true,
  });
  if (res.status < 200 || res.status >= 300) return url;
  let json = {};
  try { json = res.data || {}; } catch { json = {}; }
  const u = json?.data?.[0]?.url;
  return u || url;
}

function buildSegmentsMusic(provider, id) {
  return [{ type: 'music', data: { type: String(provider), id: String(id) } }];
}

function buildSegmentsRecord(url) {
  return [{ type: 'record', data: { file: String(url) } }];
}

async function sendViaWS({ url, timeoutMs, pathList, argStyle }, target, segments) {
  const { user_id, group_id } = target;
  const filteredTarget = user_id ? { user_id } : { group_id };
  const requestIdBase = `${(user_id ? 'private' : 'group')}-${Date.now()}`;

  for (const path of pathList) {
    const requestId = `${path}-${requestIdBase}`;
    const args = (argStyle === 'pair')
      ? (user_id ? [Number(user_id), segments] : [Number(group_id), segments])
      : [{ ...filteredTarget, message: segments }];
    try {
      const resp = await wsCall({ url, path, args, requestId, timeoutMs });
      // 返回即认为调用成功，交由上层判定业务字段
      return { ok: true, path, args, resp };
    } catch (e) {
      logger.warn?.('music_card:ws_send_failed', { label: 'PLUGIN', path, error: String(e?.message || e) });
    }
  }
  return { ok: false };
}

async function singleMusicCardHandler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const keyword = String(args.keyword || '').trim();
  if (!keyword) return { success: false, code: 'INVALID', error: 'keyword 为必填参数' };

  const provider = String(args.provider || '163').trim();
  if (provider !== '163') return { success: false, code: 'UNSUPPORTED', error: '仅支持 provider=163（网易云）' };

  // 从参数或缓存中获取 ID（优先参数，其次缓存）
  const { user_id, group_id, source } = await getIdsWithCache(args, options, 'music_card');
  
  logger.info?.('music_card:ids_resolved', { 
    label: 'PLUGIN', 
    user_id, 
    group_id, 
    source 
  });

  const defaultLimit = toInt(penv.MUSIC163_SEARCH_LIMIT || process.env.MUSIC163_SEARCH_LIMIT) ?? 6;
  const limit = Math.max(1, Math.min(10, toInt(args.limit) ?? defaultLimit));
  const random = typeof args.random === 'boolean' ? args.random : true;
  const pick = args.pick;

  const wsUrl = String(penv.WS_SDK_URL || process.env.WS_SDK_URL || 'ws://localhost:6702');
  const timeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || process.env.WS_SDK_TIMEOUT_MS || 15000));
  const argStyle = String(penv.WS_SDK_ARG_STYLE || process.env.WS_SDK_ARG_STYLE || 'pair'); // 'object' | 'pair'
  const pathMain = String(penv.WS_SDK_SEND_PATH || process.env.WS_SDK_SEND_PATH || '').trim();
  const pathPri = String(penv.WS_SDK_SEND_PATH_PRIVATE || process.env.WS_SDK_SEND_PATH_PRIVATE || 'send.private');
  const pathGrp = String(penv.WS_SDK_SEND_PATH_GROUP || process.env.WS_SDK_SEND_PATH_GROUP || 'send.group');

  try {
    const list = await searchMusic163(keyword, limit);
    if (!list.length) return { success: false, code: 'NOT_FOUND', error: '未找到相关的音乐' };
    const chosen = pickOne(list, pick, random);

    const segments = buildSegmentsMusic(provider, chosen.id);
    const pathList = [pathMain, (user_id ? pathPri : pathGrp)].filter((v, i, a) => !!v && a.indexOf(v) === i);
    const sendRes = await sendViaWS({ url: wsUrl, timeoutMs, pathList, argStyle }, { user_id, group_id }, segments);
    if (sendRes.ok) {
      return { success: true, data: { 发送对象: user_id ? '私聊' : '群聊', 目标: user_id || group_id, 平台: provider, 歌曲: chosen, request: { pathTried: pathList, argStyle, segments }, response: sendRes.resp } };
    }

    if (args.fallback_to_record) {
      const musicU = String(penv.MUSIC163_COOKIE_MUSIC_U || process.env.MUSIC163_COOKIE_MUSIC_U || '').trim();
      const playUrl = await getMusicUrl163(chosen.id, musicU);
      if (playUrl) {
        const fbSeg = buildSegmentsRecord(playUrl);
        const fbRes = await sendViaWS({ url: wsUrl, timeoutMs, pathList, argStyle }, { user_id, group_id }, fbSeg);
        if (fbRes.ok) {
          return { success: true, data: { 发送对象: user_id ? '私聊' : '群聊', 目标: user_id || group_id, 提示: '音乐卡片发送失败，已回退发送音频直链', 歌曲: chosen, request: { pathTried: pathList, argStyle, segments: fbSeg }, response: fbRes.resp } };
        }
      }
    }

    return { success: false, code: 'SEND_FAILED', error: '发送音乐卡片失败（WS）' };
  } catch (e) {
    logger.warn?.('music_card:error', { label: 'PLUGIN', error: String(e?.message || e) });
    return { success: false, code: 'ERR', error: String(e?.message || e) };
  }
}

export default async function handler(args = {}, options = {}) {
  const rawKeywords = Array.isArray(args.keywords) ? args.keywords : [];
  const keywordSingle = String(args.keyword || '').trim();
  const keywords = rawKeywords
    .map((k) => String(k || '').trim())
    .filter((k) => !!k);

  if (!keywords.length && keywordSingle) {
    keywords.push(keywordSingle);
  }

  if (!keywords.length) {
    return fail('keyword/keywords 为必填参数，请提供关键词（字符串）或关键词数组，如："稻香 周杰伦" 或 ["稻香 周杰伦", "夜曲 周杰伦"]', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'music_card' }) });
  }

  const results = [];
  for (const kw of keywords) {
    const singleArgs = { ...args, keyword: kw };
    const res = await singleMusicCardHandler(singleArgs, options);
    results.push({
      keyword: kw,
      ...res
    });
  }

  const anyOk = results.some((r) => r.success);
  if (anyOk) {
    return ok({ results });
  }

  return fail('所有关键词的音乐搜索或发送均失败', 'MUSIC_CARD_FAILED', {
    advice: buildAdvice('SEND_FAILED', { tool: 'music_card', keywords }),
    detail: { results },
  });
}
