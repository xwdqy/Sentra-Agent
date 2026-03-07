import { httpRequest } from '../../src/utils/http.js';
import { ok, fail } from '../../src/utils/result.js';

const SEARCH_PROVIDER = '163';
const DEFAULT_PROVIDER = '163';
const MAX_LIMIT = 30;
const MIN_LIMIT = 1;

function normalizeProvider(raw) {
  const value = String(raw || DEFAULT_PROVIDER).trim().toLowerCase();
  if (value === 'qq' || value === '163' || value === 'kugou' || value === 'migu' || value === 'kuwo') {
    return value;
  }
  return DEFAULT_PROVIDER;
}

function clampLimit(raw, fallback = 10) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  const n = Math.trunc(num);
  if (n < MIN_LIMIT) return MIN_LIMIT;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

function normalizeKeywords(args = {}) {
  const out = [];
  const seen = new Set();
  const pushOne = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };

  if (Array.isArray(args.keywords)) {
    for (const item of args.keywords) pushOne(item);
  }
  pushOne(args.keyword);
  return out;
}

function normalizeSongId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (!/^\d+$/.test(s)) return '';
  return s;
}

function buildCandidate(provider, item = {}) {
  const songId = normalizeSongId(item.id ?? item.song_id);
  const songName = String(item.name || item.song_name || '').trim();
  const artist = String(item.artists || item.artist || '').trim();
  const alias = String(item.alias || '').trim();
  if (!songId) return null;
  return {
    provider,
    song_id: songId,
    song_name: songName,
    artist,
    alias,
    music_segment: {
      type: 'music',
      data: {
        type: provider,
        id: songId
      }
    }
  };
}

async function searchMusic163(keyword, limit = 10) {
  const url = `http://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=${limit}`;
  const res = await httpRequest({
    method: 'GET',
    url,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeoutMs: 15000,
    validateStatus: () => true
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`163 search HTTP ${res.status}`);
  }
  const songs = Array.isArray(res?.data?.result?.songs) ? res.data.result.songs : [];
  return songs.map((s) => ({
    id: s?.id,
    name: s?.name,
    artists: Array.isArray(s?.artists)
      ? s.artists.map((a) => String(a?.name || '').trim()).filter(Boolean).join('&')
      : '',
    alias: Array.isArray(s?.alias) ? s.alias.join(',') : ''
  }));
}

function buildDirectResult(args = {}) {
  const provider = normalizeProvider(args.provider);
  const songId = normalizeSongId(args.song_id);
  if (!songId) {
    return fail('song_id must be digits only', 'INVALID_SONG_ID', {
      detail: { field: 'song_id', expected: 'digits string or number' }
    });
  }
  const candidate = buildCandidate(provider, {
    song_id: songId,
    song_name: String(args.song_name || '').trim(),
    artist: String(args.artist || '').trim(),
    alias: ''
  });
  return ok({
    mode: 'direct_song_id',
    provider,
    song_id: songId,
    recommended: candidate,
    candidates: candidate ? [candidate] : []
  });
}

async function searchOneKeyword({ keyword, provider, limit }) {
  if (provider !== SEARCH_PROVIDER) {
    return {
      keyword,
      success: false,
      code: 'UNSUPPORTED_PROVIDER_SEARCH',
      error: {
        message: `provider=${provider} is not supported for keyword search now; use provider=163 or pass song_id directly`
      },
      candidates: []
    };
  }

  try {
    const rows = await searchMusic163(keyword, limit);
    const candidates = rows
      .map((row) => buildCandidate(provider, row))
      .filter(Boolean);
    if (!candidates.length) {
      return {
        keyword,
        success: false,
        code: 'NOT_FOUND',
        error: { message: 'no songs found' },
        candidates: []
      };
    }
    return {
      keyword,
      success: true,
      code: 'OK',
      recommended: candidates[0],
      candidates
    };
  } catch (error) {
    return {
      keyword,
      success: false,
      code: 'SEARCH_FAILED',
      error: { message: String(error?.message || error) },
      candidates: []
    };
  }
}

export default async function handler(args = {}) {
  const directSongId = normalizeSongId(args.song_id);
  if (directSongId) {
    return buildDirectResult(args);
  }

  const keywords = normalizeKeywords(args);
  if (!keywords.length) {
    return fail('keyword/keywords or song_id is required', 'INVALID', {
      detail: {
        accepted: ['song_id', 'keyword', 'keywords']
      }
    });
  }

  const provider = normalizeProvider(args.provider);
  const limit = clampLimit(args.limit, 10);

  const results = [];
  for (const keyword of keywords) {
    const item = await searchOneKeyword({ keyword, provider, limit });
    results.push(item);
  }

  const successItems = results.filter((item) => item && item.success === true);
  if (!successItems.length) {
    return fail('all keyword searches failed', 'MUSIC_CARD_FAILED', {
      detail: {
        provider,
        limit,
        results
      }
    });
  }

  return ok({
    mode: 'search',
    provider,
    limit,
    results
  });
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
