/**
 * 消息发送工具模块
 * 包含智能发送、文件处理、消息分段发送等功能
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import mimeTypes from 'mime-types';
import { parseSentraMessage } from './protocolUtils.js';
import { parseTextSegments, buildSegmentMessage } from './messageUtils.js';
import { updateConversationHistory } from './conversationUtils.js';
import { createLogger } from './logger.js';
import { replySendQueue } from './replySendQueue.js';
import { getEnv, getEnvBool, getEnvInt, onEnvReload } from './envHotReloader.js';
import { randomUUID } from 'crypto';
import { buildGroupScopeId, buildPrivateScopeId } from './conversationId.js';

const logger = createLogger('SendUtils');

type FetchHeadersLike = { get?: (name: string) => string | null | undefined } & Record<string, string>;
type FetchBodyReaderLike = {
  read: () => Promise<{ value?: Uint8Array; done?: boolean }>;
  cancel?: () => Promise<void> | void;
};
type FetchBodyLike = {
  getReader?: () => FetchBodyReaderLike;
  on?: (event: string, handler: (chunk?: unknown) => void) => void;
  off?: (event: string, handler: (chunk?: unknown) => void) => void;
  destroy?: () => void;
};
type FetchResponseLike = {
  ok?: boolean;
  status?: number;
  headers?: FetchHeadersLike;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  body?: FetchBodyLike;
};
type FetchFn = (url: string, options?: Record<string, unknown>) => Promise<FetchResponseLike>;
type FetchOptions = Record<string, unknown> & {
  method?: string;
  redirect?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};
type ProbeOptions = { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> };
type FileProbeResult = {
  ok: boolean;
  mime: string;
  fileType: string;
  isHtml?: boolean;
  ext: string;
  fileNameFromCd?: string;
};
type LocalFileProbeResult = { ok: boolean; mime: string; fileType: string; ext: string };
type MessagePart = { type: string; data?: Record<string, unknown> };
type SegmentLike = { text?: string | null; routeTarget?: RouteTarget };
type MsgLike = {
  type?: string;
  sender_id?: string | number | null;
  group_id?: string | number | null;
  text?: string;
  summary?: string;
  raw?: { text?: string; summary?: string };
  message_id?: string | number | null;
  _merged?: boolean;
  _mergedUsers?: Array<{ text?: string; raw?: { text?: string; summary?: string } }>;
  [key: string]: unknown;
};
type RouteSpec = { kind?: string; id?: string };
type RouteTarget = { kind: 'group' | 'private'; id: string; isCurrent: boolean; explicitByProtocol?: boolean };
type CrossChatConfig = {
  enabled: boolean;
  allowedGroupIds: Set<string>;
  allowedUserIds: Set<string>;
  allowedSenderIds: Set<string>;
  requireTargetIdInUserText: boolean;
  maxCrossOpsPerResponse: number;
};
type SendConfig = {
  base64MaxBytes: number;
  maxMediaPartsPerMessage: number;
  crossChat: CrossChatConfig;
};
type SendResult = {
  data?: { status?: string; retcode?: number | string; message?: string; message_id?: string | number };
  [key: string]: unknown;
};
type SegmentDeliveryEntry = {
  segmentIndex: number;
  messageId: string;
};
type SendBatchPlan = {
  parts: MessagePart[];
  segmentIndexes: number[];
};
type SmartSendOptions = { hasTool?: boolean; immediate?: boolean };
type SmartSendMeta = {
  groupId: string;
  response: string;
  textForDedup: string;
  resourceKeys: string[];
  sourceMessageId: string | null;
  allowReply: boolean;
  hasTool?: boolean;
  immediate?: boolean;
};
type ProtocolFile = {
  type: string;
  path: string;
  fileName?: string;
  fileType?: string;
  isHttpUrl?: boolean;
  routeTarget: RouteTarget;
  segmentIndex: number | null;
  caption?: string;
};
type LinkSegment = {
  text: string;
  routeTarget: RouteTarget;
  segmentIndex: number | null;
};

const MUSIC_PROVIDERS = new Set(['qq', '163', 'kugou', 'migu', 'kuwo']);
type SegmentPlan = { text: string; routeTarget: RouteTarget };

let _fetchCached: FetchFn | null = null;
async function _getFetch(): Promise<FetchFn> {
  if (_fetchCached) return _fetchCached;
  if (typeof globalThis.fetch === 'function') {
    _fetchCached = globalThis.fetch.bind(globalThis) as unknown as FetchFn;
    return _fetchCached;
  }
  const mod = await import('node-fetch');
  _fetchCached = mod.default as unknown as FetchFn;
  return _fetchCached;
}

function readEnvInt(name: string, fallback: number): number {
  const raw = getEnvInt(name, fallback);
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readEnvBool(name: string, fallback: boolean): boolean {
  const raw = getEnvBool(name, fallback);
  return raw === undefined ? fallback : raw;
}

async function _fetchWithTimeout(url: string, options: FetchOptions = {}, timeoutMs = 10000): Promise<FetchResponseLike> {
  const fetchFn = await _getFetch();
  const timeout = Number(timeoutMs || 0);
  if (!Number.isFinite(timeout) || timeout <= 0) return await fetchFn(url, options);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetchFn(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function _readFirstBytesFromResponse(res: FetchResponseLike | null | undefined, maxBytes = 2048): Promise<Buffer> {
  const max = Math.max(1, Number(maxBytes || 2048));
  const body = res?.body;
  if (!body) return Buffer.alloc(0);

  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (total < max) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const buf = Buffer.from(value);
          chunks.push(buf);
          total += buf.length;
        }
      }
    } finally {
      try { await reader.cancel?.(); } catch { }
    }
    return Buffer.concat(chunks).subarray(0, max);
  }

  if (typeof body.on === 'function') {
    return await new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const cleanup = () => {
        try { body.off?.('data', onData); } catch { }
        try { body.off?.('end', onEnd); } catch { }
        try { body.off?.('error', onErr); } catch { }
      };
      const finish = () => {
        cleanup();
        resolve(Buffer.concat(chunks).subarray(0, max));
      };
      const onErr = () => finish();
      const onEnd = () => finish();
      const onData = (chunk: unknown) => {
        try {
          let buf: Buffer;
          if (Buffer.isBuffer(chunk)) {
            buf = chunk;
          } else if (chunk instanceof Uint8Array) {
            buf = Buffer.from(chunk);
          } else if (chunk instanceof ArrayBuffer) {
            buf = Buffer.from(new Uint8Array(chunk));
          } else {
            buf = Buffer.from(String(chunk));
          }
          chunks.push(buf);
          total += buf.length;
          if (total >= max) {
            try { body.destroy?.(); } catch { }
            finish();
          }
        } catch {
          finish();
        }
      };
      try {
        body.on?.('data', onData);
        body.on?.('end', onEnd);
        body.on?.('error', onErr);
      } catch {
        finish();
      }
    });
  }

  try {
    if (typeof res?.arrayBuffer === 'function') {
      const ab = await res.arrayBuffer();
      return Buffer.from(new Uint8Array(ab)).subarray(0, max);
    }
    return Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}

function _stripMimeParams(contentType: string | null | undefined): string {
  const raw = String(contentType || '').trim();
  if (!raw) return '';
  const parts = raw.split(';');
  const head = parts.length > 0 && parts[0] ? parts[0] : '';
  return head.trim().toLowerCase();
}

function _firstSplitPart(text: string, sep: string): string {
  const parts = text.split(sep);
  return parts.length > 0 && parts[0] ? parts[0] : '';
}

function _parseContentDispositionFilename(headerValue: string | null | undefined): string {
  const raw = String(headerValue || '').trim();
  if (!raw) return '';
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(raw);
  if (star && star[2]) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      return star[2].trim().replace(/^"|"$/g, '');
    }
  }
  const m = /filename\s*=\s*([^;]+)/i.exec(raw);
  if (!m || !m[1]) return '';
  return m[1].trim().replace(/^"|"$/g, '');
}

function _detectByMagic(buf: Buffer | Uint8Array | ArrayBuffer | null | undefined): { mime: string; ext: string } {
  let b: Buffer;
  if (Buffer.isBuffer(buf)) {
    b = buf;
  } else if (buf instanceof Uint8Array) {
    b = Buffer.from(buf);
  } else if (buf instanceof ArrayBuffer) {
    b = Buffer.from(new Uint8Array(buf));
  } else {
    b = Buffer.from([]);
  }
  if (!b.length) return { mime: '', ext: '' };

  const startsWith = (hex: string) => {
    const bytes = Buffer.from(hex.replace(/\s+/g, ''), 'hex');
    if (bytes.length > b.length) return false;
    return b.subarray(0, bytes.length).equals(bytes);
  };

  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (startsWith('89504e470d0a1a0a')) return { mime: 'image/png', ext: '.png' };
  if (b.length >= 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    return { mime: 'image/gif', ext: '.gif' };
  }
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' };
  }
  if (b.length >= 2 && b.subarray(0, 2).toString('ascii') === 'BM') return { mime: 'image/bmp', ext: '.bmp' };
  if (startsWith('00000100')) return { mime: 'image/x-icon', ext: '.ico' };

  if (startsWith('25504446')) return { mime: 'application/pdf', ext: '.pdf' };
  if (startsWith('504b0304')) return { mime: 'application/zip', ext: '.zip' };
  if (startsWith('377abcaf271c')) return { mime: 'application/x-7z-compressed', ext: '.7z' };
  if (startsWith('526172211a0700') || startsWith('526172211a0701')) return { mime: 'application/x-rar-compressed', ext: '.rar' };
  if (startsWith('1f8b')) return { mime: 'application/gzip', ext: '.gz' };

  if (b.length >= 12 && b.subarray(4, 8).toString('ascii') === 'ftyp') return { mime: 'video/mp4', ext: '.mp4' };
  if (b.length >= 4 && b.subarray(0, 4).toString('ascii') === 'OggS') return { mime: 'audio/ogg', ext: '.ogg' };
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WAVE') {
    return { mime: 'audio/wav', ext: '.wav' };
  }
  if (b.length >= 3 && b.subarray(0, 3).toString('ascii') === 'ID3') return { mime: 'audio/mpeg', ext: '.mp3' };

  return { mime: '', ext: '' };
}
function _inferFileTypeFromMime(mime: string | null | undefined): string {
  const m = String(mime || '').toLowerCase();
  if (!m) return 'file';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'record';
  return 'file';
}

function _isLikelyHtml({ mime, buf }: { mime: string; buf: Buffer }): boolean {
  const m = String(mime || '').toLowerCase();
  if (m === 'text/html') return true;
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return false;
  const text = buf.subarray(0, 256).toString('utf8').trim().toLowerCase();
  if (!text) return false;
  if (text.startsWith('<!doctype html')) return true;
  if (text.startsWith('<html')) return true;
  return false;
}

async function _probeHttpResource(url: string, options: ProbeOptions = {}): Promise<FileProbeResult> {
  const timeoutMs = Number(options.timeoutMs || 10000);
  const maxBytes = Number(options.maxBytes || 2048);

  const baseHeaders = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0',
    accept: '*/*'
  };

  let headHeaders = null;
  try {
    const headRes = await _fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow', headers: baseHeaders }, timeoutMs);
    if (headRes && headRes.headers) headHeaders = headRes.headers;
  } catch { }

  let getHeaders = null;
  let firstBytes: Buffer = Buffer.alloc(0);
  try {
    const range = `bytes=0-${Math.max(0, Math.floor(maxBytes) - 1)}`;
    const getRes = await _fetchWithTimeout(
      url,
      { method: 'GET', redirect: 'follow', headers: { ...baseHeaders, range } },
      timeoutMs
    );
    if (getRes && getRes.headers) getHeaders = getRes.headers;
    firstBytes = await _readFirstBytesFromResponse(getRes, maxBytes);
  } catch { }

  const getCt = _stripMimeParams(getHeaders?.get?.('content-type'));
  const headCt = _stripMimeParams(headHeaders?.get?.('content-type'));
  const magic = _detectByMagic(firstBytes);
  const mime = magic.mime || getCt || headCt || '';

  const cd = getHeaders?.get?.('content-disposition') || headHeaders?.get?.('content-disposition') || '';
  const fileNameFromCd = _parseContentDispositionFilename(cd);

  const isHtml = _isLikelyHtml({ mime, buf: firstBytes });
  const fileType = _inferFileTypeFromMime(mime);
  const extFromMime = mime ? `.${mimeTypes.extension(mime) || ''}` : '';
  const ext = magic.ext || ((extFromMime && extFromMime !== '.') ? extFromMime : '');

  return {
    ok: !!(mime || fileNameFromCd || firstBytes.length),
    mime,
    fileType,
    isHtml,
    ext,
    fileNameFromCd
  };
}

function _probeLocalFileType(localPath: string): LocalFileProbeResult {
  try {
    const fd = fs.openSync(localPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const sample = buf.subarray(0, Math.max(0, bytes));
      const magic = _detectByMagic(sample);
      const mime = magic.mime || '';
      return {
        ok: !!mime,
        mime,
        fileType: _inferFileTypeFromMime(mime),
        ext: magic.ext || ''
      };
    } finally {
      try { fs.closeSync(fd); } catch { }
    }
  } catch {
    return { ok: false, mime: '', fileType: 'file', ext: '' };
  }
}

let _cfgCache: SendConfig | null = null;
function _getCfg(): SendConfig {
  if (_cfgCache) return _cfgCache;

  let base64MaxBytes = 2 * 1024 * 1024;
  const mbText = getEnv('NAPCAT_BASE64_MAX_MB', undefined);
  const mb = mbText !== undefined ? Number(mbText) : NaN;
  if (Number.isFinite(mb) && mb > 0) {
    base64MaxBytes = Math.floor(mb * 1024 * 1024);
  }

  _cfgCache = {
    base64MaxBytes,
    maxMediaPartsPerMessage: readEnvInt('SEND_MEDIA_BATCH_MAX', 8),
    crossChat: {
      enabled: readEnvBool('CROSS_CHAT_SEND_ENABLED', true),
      allowedGroupIds: _parseCsvIdSet(getEnv('CROSS_CHAT_SEND_ALLOW_GROUP_IDS', '')),
      allowedUserIds: _parseCsvIdSet(getEnv('CROSS_CHAT_SEND_ALLOW_USER_IDS', '')),
      allowedSenderIds: _parseCsvIdSet(getEnv('CROSS_CHAT_SEND_ALLOW_SENDER_IDS', '')),
      requireTargetIdInUserText: readEnvBool('CROSS_CHAT_SEND_REQUIRE_TARGET_IN_USER_TEXT', false),
      maxCrossOpsPerResponse: readEnvInt('CROSS_CHAT_SEND_MAX_OPS_PER_RESPONSE', 6)
    }
  };

  return _cfgCache as SendConfig;
}

onEnvReload(() => {
  _cfgCache = null;
});

function _isAdapterSendFailed(result: SendResult | null | undefined): boolean {
  try {
    const status = result?.data?.status;
    const retcode = result?.data?.retcode;
    if (status && String(status).toLowerCase() === 'failed') return true;
    if (typeof retcode === 'number' && retcode !== 0) return true;
    if (typeof retcode === 'string' && retcode.trim() && retcode.trim() !== '0') return true;
    return false;
  } catch {
    return false;
  }
}

function _extractRpcSendMessageId(result: SendResult | null | undefined): string | number | null {
  if (!result || typeof result !== 'object') return null;
  const data = result.data && typeof result.data === 'object'
    ? result.data as Record<string, unknown>
    : {};

  const direct = data.message_id;
  if (direct != null && String(direct).trim() && String(direct).trim() !== '0') {
    return direct as string | number;
  }

  const nestedData = data.data && typeof data.data === 'object'
    ? data.data as Record<string, unknown>
    : {};
  const nested = nestedData.message_id;
  if (nested != null && String(nested).trim() && String(nested).trim() !== '0') {
    return nested as string | number;
  }

  return null;
}

function _normalizeMessageIdText(value: unknown): string {
  if (value == null) return '';
  const s = String(value).trim();
  if (!s || s === '0') return '';
  return s;
}

function _tryResolvePokeArgs(
  rawBatch: MessagePart[] | null | undefined,
  routeKind: 'group' | 'private'
): [number] | [number, number] | null {
  if (!Array.isArray(rawBatch) || rawBatch.length !== 1) return null;
  const seg = rawBatch[0];
  const type = String(seg?.type || '').trim().toLowerCase();
  if (type !== 'poke') return null;

  const data = seg?.data && typeof seg.data === 'object'
    ? seg.data as Record<string, unknown>
    : {};
  const userId = Number(String(data.user_id ?? '').trim());
  const groupId = Number(String(data.group_id ?? '').trim());

  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('poke segment missing valid user_id');
  }

  if (routeKind === 'group') {
    if (!Number.isFinite(groupId) || groupId <= 0) {
      throw new Error('group poke segment missing valid group_id');
    }
    return [Math.trunc(userId), Math.trunc(groupId)];
  }

  return [Math.trunc(userId)];
}

function _tryResolveRecallMessageId(rawBatch: MessagePart[] | null | undefined): number | null {
  if (!Array.isArray(rawBatch) || rawBatch.length !== 1) return null;
  const seg = rawBatch[0];
  const type = String(seg?.type || '').trim().toLowerCase();
  if (type !== 'recall') return null;

  const data = seg?.data && typeof seg.data === 'object'
    ? seg.data as Record<string, unknown>
    : {};
  const messageIdRaw = String(data.message_id ?? '').trim();
  if (!/^\d+$/.test(messageIdRaw)) {
    throw new Error('recall segment missing valid message_id');
  }

  let messageIdNum = Number.NaN;
  try {
    const bi = BigInt(messageIdRaw);
    if (bi <= 0n) {
      throw new Error('recall segment message_id must be > 0');
    }
    if (bi > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('recall segment message_id exceeds max safe integer');
    }
    messageIdNum = Number(messageIdRaw);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('recall segment missing valid message_id');
  }

  if (!Number.isFinite(messageIdNum) || messageIdNum <= 0) {
    throw new Error('recall segment missing valid message_id');
  }
  return Math.trunc(messageIdNum);
}

function _assertRpcResult(
  result: SendResult | null | undefined,
  mode: 'message' | 'poke' | 'recall',
  routeKind: 'group' | 'private',
  routeId: string,
  batchIndex: number,
  batchTotal: number
): asserts result is SendResult {
  const prefix = mode === 'poke'
    ? 'send poke rpc'
    : (mode === 'recall' ? 'send recall rpc' : 'send rpc');
  if (!result) {
    throw new Error(
      `${prefix} failed or timed out (route=${routeKind}:${routeId}, batch=${batchIndex}/${batchTotal})`
    );
  }
  if (_isAdapterSendFailed(result)) {
    const errMsg = String(result?.data?.message || result?.message || 'unknown send failure');
    throw new Error(
      `${prefix} returned failed status (route=${routeKind}:${routeId}, batch=${batchIndex}/${batchTotal}, error=${errMsg})`
    );
  }
}

function _toFileUrlIfLikelyLocal(p: unknown): string {
  const s = String(p || '').trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^file:\/\//i.test(s)) return s;
  if (/^base64:\/\//i.test(s)) return s;
  try {
    const abs = path.isAbsolute(s) ? s : path.resolve(s);
    return pathToFileURL(abs).href;
  } catch {
    return s;
  }
}

function _resolveLocalPathFromFileField(p: unknown): string {
  const s = String(p || '').trim();
  if (!s) return '';
  if (/^base64:\/\//i.test(s)) return '';
  if (/^https?:\/\//i.test(s)) return '';
  if (/^file:\/\//i.test(s)) {
    try {
      return fileURLToPath(s);
    } catch {
      return '';
    }
  }
  return s;
}

function _getBase64MaxBytes() {
  return _getCfg().base64MaxBytes;
}

function _readBase64FileIfAllowed(fileField: unknown): string | null {
  try {
    const maxBytes = _getBase64MaxBytes();
    const localPath = _resolveLocalPathFromFileField(fileField);
    if (!localPath) return null;
    const stat = fs.statSync(localPath);
    if (!stat?.isFile?.()) return null;
    if (maxBytes > 0 && stat.size > maxBytes) return null;
    const buf = fs.readFileSync(localPath);
    if (maxBytes > 0 && buf.length > maxBytes) return null;
    return `base64://${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function _withNormalizedFileField(messageParts: MessagePart[] | null | undefined): MessagePart[] | null | undefined {
  if (!Array.isArray(messageParts)) return messageParts;
  return messageParts.map((p) => {
    const f = p?.data?.file;
    if (!f) return p;
    return { ...p, data: { ...p.data, file: _toFileUrlIfLikelyLocal(f) } };
  });
}

function _withBase64FallbackForImages(messageParts: MessagePart[] | null | undefined): { parts: MessagePart[] | null | undefined; changed: boolean } {
  if (!Array.isArray(messageParts)) return { parts: messageParts, changed: false };
  let changed = false;
  const parts = messageParts.map((p) => {
    if (!p || typeof p !== 'object') return p;
    if (p.type !== 'image') return p;
    const f = p?.data?.file;
    if (!f) return p;
    if (/^base64:\/\//i.test(String(f))) return p;
    const b64 = _readBase64FileIfAllowed(f);
    if (!b64) return p;
    changed = true;
    return { ...p, data: { ...p.data, file: b64 } };
  });
  return { parts, changed };
}

function _shouldRetryAsFileUrl(result: SendResult | null | undefined): boolean {
  const msg = String(result?.data?.message || '').toLowerCase();
  if (msg.includes('识别url失败')) return true;
  if (msg.includes('url')) return true;
  return false;
}

function _parseCsvIdSet(raw: string | null | undefined): Set<string> {
  const s = String(raw || '').trim();
  if (!s) return new Set();
  return new Set(
    s
      .split(',')
      .map((v) => String(v || '').trim())
      .filter(Boolean)
  );
}

function _getCrossChatSendConfig(): CrossChatConfig {
  return _getCfg().crossChat;
}

function _collectUserProvidedTextForCrossAuth(msg: MsgLike): string {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (s) out.push(s);
  };

  push(msg?.text);
  push((msg as any)?.summary_text);
  push((msg as any)?.objective_text);
  push(msg?.summary);
  push(msg?.raw?.text);
  push(msg?.raw?.summary);

  if (msg?._merged && Array.isArray(msg?._mergedUsers)) {
    for (const u of msg._mergedUsers) {
      if (!u) continue;
      push(u?.text);
      push(u?.raw?.text);
      push(u?.raw?.summary);
    }
  }

  return out.join('\n\n');
}

function _isTargetIdExplicitlyMentionedInUserText(msg: MsgLike, id: string | number | null | undefined): boolean {
  const digits = String(id || '').trim();
  if (!digits) return false;
  const ctx = _collectUserProvidedTextForCrossAuth(msg);
  if (!ctx) return false;
  try {
    const re = new RegExp(`(^|\\D)${digits}(\\D|$)`);
    return re.test(ctx);
  } catch {
    return ctx.includes(digits);
  }
}

function _extractRoutePrefix(text: unknown): { kind: 'current'; id: string; rest: string } {
  const raw = typeof text === 'string' ? text : '';
  return { kind: 'current', id: '', rest: raw };
}

function _resolveRouteTarget(msg: MsgLike, route: RouteSpec | null | undefined): RouteTarget {
  const current: { kind: 'group' | 'private'; id: string } = {
      kind: msg?.type === 'private' ? 'private' : 'group',
      id: msg?.type === 'private' ? String(msg?.sender_id ?? '') : String(msg?.group_id ?? '')
  };

  const rawKind = route?.kind || 'current';
  if (rawKind === 'current') return { kind: current.kind, id: current.id, isCurrent: true };
  const kind = rawKind === 'group' || rawKind === 'private' ? rawKind : current.kind;

  const id = String(route?.id || '').trim();
  const isCurrent = kind === current.kind && !!id && id === current.id;
  return { kind, id, isCurrent };
}

function _resolveRouteTargetWithDefault(
  msg: MsgLike,
  route: RouteSpec | null | undefined,
  defaultRoute: RouteSpec | null | undefined
): RouteTarget {
  if (route && route.kind === 'current' && defaultRoute && defaultRoute.kind && defaultRoute.id) {
    const current: { kind: 'group' | 'private'; id: string } = {
      kind: msg?.type === 'private' ? 'private' : 'group',
      id: msg?.type === 'private' ? String(msg?.sender_id ?? '') : String(msg?.group_id ?? '')
    };
    const kindRaw = String(defaultRoute.kind || '').trim();
    const kind = kindRaw === 'group' || kindRaw === 'private' ? kindRaw : current.kind;
    const id = String(defaultRoute.id || '').trim();
    const isCurrent = kind === current.kind && !!id && id === current.id;
    return { kind, id, isCurrent, explicitByProtocol: true };
  }
  return _resolveRouteTarget(msg, route);
}

function _isCrossRouteAllowed(msg: MsgLike, routeTarget: RouteTarget, crossCfg: CrossChatConfig): boolean {
  if (!routeTarget || routeTarget.isCurrent) return true;
  if (!crossCfg?.enabled) return false;

  const senderId = String(msg?.sender_id ?? '').trim();
  if (crossCfg.allowedSenderIds.size > 0) {
    if (!senderId || !crossCfg.allowedSenderIds.has(senderId)) return false;
  }

  if (crossCfg.requireTargetIdInUserText && !routeTarget?.explicitByProtocol) {
    if (!_isTargetIdExplicitlyMentionedInUserText(msg, routeTarget.id)) return false;
  }

  if (routeTarget.kind === 'group') {
    return crossCfg.allowedGroupIds.size === 0 || crossCfg.allowedGroupIds.has(String(routeTarget.id));
  }
  if (routeTarget.kind === 'private') {
    return crossCfg.allowedUserIds.size === 0 || crossCfg.allowedUserIds.has(String(routeTarget.id));
  }
  return false;
}

/**
 * 智能发送消息内部实现（完全拟人化，只从AI的resources中提取文件）
 * @private
 * @param {Object} msg - 消息对象
 * @param {string} response - AI响应内容
 * @param {Function} sendAndWaitResult - 发送函数
 * @param {boolean} allowReply - 是否允许引用回复（默认true），同一任务中只有第一次发送应设置为true
 */
type SendAndWaitFn = (payload: Record<string, unknown>) => Promise<unknown>;

function _normalizeOutgoingSegment(
  seg: { type?: string; data?: Record<string, unknown> } | null | undefined,
  allowReply: boolean,
  normalizePositiveId: (value: unknown) => string,
  routeContext?: { kind: 'group' | 'private'; id: string }
): MessagePart | null {
  if (!seg || typeof seg !== 'object') return null;
  const type = String(seg.type || '').trim().toLowerCase();
  if (!type) return null;
  const data = seg.data && typeof seg.data === 'object' ? seg.data : {};

  const toSafeIntLike = (digits: string): number | string => {
    try {
      const bi = BigInt(digits);
      if (bi <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(digits);
      return digits;
    } catch {
      const n = Number(digits);
      return Number.isFinite(n) ? n : digits;
    }
  };

  if (type === 'text') {
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) return null;
    return { type: 'text', data: { text } };
  }

  if (type === 'reply') {
    if (!allowReply) return null;
    const rid = normalizePositiveId((data as Record<string, unknown>).id);
    if (!rid) return null;
    return { type: 'reply', data: { id: toSafeIntLike(rid) } };
  }

  if (type === 'at') {
    const rawQq = (data as Record<string, unknown>).qq;
    const qq = String(rawQq ?? '').trim().toLowerCase();
    if (!qq) return null;
    if (qq === 'all') {
      return { type: 'at', data: { qq: 'all' } };
    }
    const qid = normalizePositiveId(rawQq);
    if (!qid) return null;
    return { type: 'at', data: { qq: qid } };
  }

  if (type === 'music') {
    const provider = String((data as Record<string, unknown>).type ?? '').trim().toLowerCase();
    if (!provider || !MUSIC_PROVIDERS.has(provider)) return null;
    const rawId = (data as Record<string, unknown>).id;
    const idText = rawId == null ? '' : String(rawId).trim();
    if (!idText) return null;
    const normalizedId = /^\d+$/.test(idText) ? toSafeIntLike(idText) : idText;
    return { type: 'music', data: { type: provider, id: normalizedId } };
  }

  if (type === 'poke') {
    const userId = normalizePositiveId((data as Record<string, unknown>).user_id);
    if (!userId) return null;
    const groupId = normalizePositiveId((data as Record<string, unknown>).group_id);
    if (routeContext?.kind === 'group') {
      if (!groupId) return null;
      if (routeContext.id && groupId !== routeContext.id) return null;
      return {
        type: 'poke',
        data: {
          user_id: toSafeIntLike(userId),
          group_id: toSafeIntLike(groupId)
        }
      };
    }
    if (groupId) return null;
    return {
      type: 'poke',
      data: { user_id: toSafeIntLike(userId) }
    };
  }

  if (type === 'recall') {
    const recallMessageId = normalizePositiveId((data as Record<string, unknown>).message_id);
    if (!recallMessageId) return null;
    return {
      type: 'recall',
      data: { message_id: toSafeIntLike(recallMessageId) }
    };
  }

  if (type === 'image' || type === 'record' || type === 'video' || type === 'file') {
    const file = String((data as Record<string, unknown>).file ?? '').trim();
    if (!file) return null;
    const cleanData = { ...data, file } as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(cleanData, 'message_id')) {
      delete cleanData.message_id;
    }
    return { type, data: cleanData };
  }

  return null;
}

async function _smartSendInternal(
  msg: MsgLike,
  response: string,
  sendAndWaitResult: SendAndWaitFn,
  allowReply = true
): Promise<unknown> {
  const normalizePositiveId = (value: unknown): string => {
    const s = value != null ? String(value).trim() : '';
    if (!/^\d+$/.test(s)) return '';
    try {
      return BigInt(s) > 0n ? s : '';
    } catch {
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? s : '';
    }
  };

  const parsed = parseSentraMessage(response);
  if (parsed && parsed.shouldSkip) {
    logger.warn('smartSend: parse result marked shouldSkip, nothing will be sent');
    return null;
  }

  const packetSegments = Array.isArray((parsed as { message?: unknown[] }).message)
    ? ((parsed as { message?: Array<{ type?: string; data?: Record<string, unknown> }> }).message || [])
    : [];
  if (packetSegments.length === 0) {
    logger.warn('smartSend(sentra-message): no valid message segments, skip send');
    return null;
  }

  const explicitGroupId = normalizePositiveId(parsed?.group_id);
  const explicitUserId = normalizePositiveId(parsed?.user_id);
  const parsedChatType = typeof parsed?.chat_type === 'string'
    ? parsed.chat_type.trim().toLowerCase()
    : '';
  if (parsedChatType !== 'group' && parsedChatType !== 'private') {
    logger.warn('smartSend(sentra-message): missing/invalid chat_type, skip send', {
      chat_type: parsed?.chat_type ?? null
    });
    return null;
  }

  let routeKind: 'group' | 'private' = parsedChatType;
  let routeId = '';

  if (parsedChatType === 'group') {
    if (explicitUserId) {
      logger.warn('smartSend(sentra-message): chat_type=group cannot carry user_id, skip send', {
        group_id: parsed?.group_id ?? null,
        user_id: parsed?.user_id ?? null
      });
      return null;
    }
    if (!explicitGroupId) {
      logger.warn('smartSend(sentra-message): chat_type=group requires valid group_id, skip send', {
        group_id: parsed?.group_id ?? null
      });
      return null;
    }
    routeKind = 'group';
    routeId = explicitGroupId;
  } else {
    if (explicitGroupId) {
      logger.warn('smartSend(sentra-message): chat_type=private cannot carry group_id, skip send', {
        group_id: parsed?.group_id ?? null,
        user_id: parsed?.user_id ?? null
      });
      return null;
    }
    if (!explicitUserId) {
      logger.warn('smartSend(sentra-message): chat_type=private requires valid user_id, skip send', {
        user_id: parsed?.user_id ?? null
      });
      return null;
    }
    routeKind = 'private';
    routeId = explicitUserId;
  }

  if (!routeId) {
    logger.warn('smartSend(sentra-message): missing valid route target, skip send', {
      chat_type: parsed?.chat_type ?? null,
      routeKind,
      routeId,
      explicitGroupId: parsed?.group_id ?? null,
      explicitUserId: parsed?.user_id ?? null
    });
    return null;
  }

  const messageParts: MessagePart[] = [];
  const messagePartSegmentIndexes: number[] = [];
  for (let si = 0; si < packetSegments.length; si++) {
    const seg = packetSegments[si];
    const normalized = _normalizeOutgoingSegment(
      seg,
      allowReply,
      normalizePositiveId,
      { kind: routeKind, id: routeId }
    );
    if (normalized) {
      messageParts.push(normalized);
      messagePartSegmentIndexes.push(si + 1);
    }
  }

  if (messageParts.length === 0) {
    logger.warn('smartSend(sentra-message): all segments invalid after normalization, skip send');
    return null;
  }

  const hasImageSegment = (parts: MessagePart[] | null | undefined): boolean => {
    if (!Array.isArray(parts) || parts.length === 0) return false;
    return parts.some((p) => p && String(p.type || '').trim().toLowerCase() === 'image');
  };

  const buildSendBatches = (parts: MessagePart[], segmentIndexes: number[]): SendBatchPlan[] => {
    const batches: SendBatchPlan[] = [];
    let pendingReply: MessagePart | null = null;
    let pendingReplySegmentIndex: number | null = null;
    let pendingAfterReply: MessagePart[] = [];
    let pendingAfterReplySegmentIndexes: number[] = [];
    const isReplyAnchor = (type: unknown): boolean => {
      const t = String(type || '').trim().toLowerCase();
      return t === 'text' || t === 'image';
    };
    const isReplyCompatibleInterSegment = (type: unknown): boolean => {
      const t = String(type || '').trim().toLowerCase();
      return t === 'at';
    };
    const flushPendingStandalone = () => {
      if (pendingAfterReply.length > 0) {
        for (let pi = 0; pi < pendingAfterReply.length; pi++) {
          const p = pendingAfterReply[pi];
          const idx = pendingAfterReplySegmentIndexes[pi];
          if (!p) continue;
          const segmentIndexesForPart =
            typeof idx === 'number' && Number.isFinite(idx)
              ? [idx]
              : [];
          batches.push({
            parts: [p],
            segmentIndexes: segmentIndexesForPart
          });
        }
      }
      pendingAfterReply = [];
      pendingAfterReplySegmentIndexes = [];
    };

    for (let pidx = 0; pidx < parts.length; pidx++) {
      const part = parts[pidx];
      const segmentIndex = Number(segmentIndexes[pidx]);
      if (!part) continue;
      const type = String(part.type || '').trim().toLowerCase();

      if (type === 'reply') {
        if (pendingReply) {
          logger.warn('smartSend(sentra-message): found unresolved reply before next anchor; drop previous unresolved reply');
          flushPendingStandalone();
        }
        pendingReply = part;
        pendingReplySegmentIndex = Number.isFinite(segmentIndex) ? segmentIndex : null;
        pendingAfterReply = [];
        pendingAfterReplySegmentIndexes = [];
        continue;
      }

      if (!pendingReply) {
        batches.push({
          parts: [part],
          segmentIndexes: Number.isFinite(segmentIndex) ? [segmentIndex] : []
        });
        continue;
      }

      if (isReplyAnchor(type)) {
        const groupedIndexes: number[] = [];
        if (pendingReplySegmentIndex != null) groupedIndexes.push(pendingReplySegmentIndex);
        groupedIndexes.push(...pendingAfterReplySegmentIndexes.filter((x) => Number.isFinite(x)));
        if (Number.isFinite(segmentIndex)) groupedIndexes.push(segmentIndex);
        batches.push({
          parts: [pendingReply, ...pendingAfterReply, part],
          segmentIndexes: groupedIndexes
        });
        pendingReply = null;
        pendingReplySegmentIndex = null;
        pendingAfterReply = [];
        pendingAfterReplySegmentIndexes = [];
        continue;
      }

      if (isReplyCompatibleInterSegment(type)) {
        pendingAfterReply.push(part);
        if (Number.isFinite(segmentIndex)) pendingAfterReplySegmentIndexes.push(segmentIndex);
        continue;
      }

      logger.warn('smartSend(sentra-message): reply anchor must be text/image; unresolved reply dropped due to incompatible segment type', {
        incompatibleType: type || '(empty)'
      });
      pendingReply = null;
      pendingReplySegmentIndex = null;
      flushPendingStandalone();
      batches.push({
        parts: [part],
        segmentIndexes: Number.isFinite(segmentIndex) ? [segmentIndex] : []
      });
    }

    if (pendingReply) {
      logger.warn('smartSend(sentra-message): unresolved reply without text/image anchor, drop reply segment');
      flushPendingStandalone();
    }

    return batches;
  };

  const sendBatches = buildSendBatches(messageParts, messagePartSegmentIndexes);
  if (sendBatches.length === 0) {
    logger.warn('smartSend(sentra-message): no sendable batches after composition, skip send');
    return null;
  }

  await updateConversationHistory(msg);
  let lastResult: SendResult | null | undefined = null;
  const segmentDeliveryMap = new Map<number, string>();
  const rpcPath = routeKind === 'group' ? 'send.group' : 'send.private';
  const targetId = Number(routeId);

  for (let i = 0; i < sendBatches.length; i++) {
    const batch = sendBatches[i];
    const rawBatch = batch?.parts;
    if (!Array.isArray(rawBatch) || rawBatch.length === 0) continue;

    const recallMessageId = _tryResolveRecallMessageId(rawBatch);
    if (recallMessageId != null) {
      const result = await sendAndWaitResult({
        type: 'sdk',
        path: 'message.recall',
        args: [recallMessageId],
        requestId: `${routeKind}-recall-v1-${Date.now()}-${i + 1}`
      }) as SendResult | null | undefined;
      _assertRpcResult(result, 'recall', routeKind, routeId, i + 1, sendBatches.length);
      lastResult = result;
      await updateConversationHistory(msg, null, true);
      continue;
    }

    const pokeArgs = _tryResolvePokeArgs(rawBatch, routeKind);
    if (pokeArgs) {
      const result = await sendAndWaitResult({
        type: 'sdk',
        path: 'user.sendPoke',
        args: pokeArgs,
        requestId: `${routeKind}-poke-v1-${Date.now()}-${i + 1}`
      }) as SendResult | null | undefined;
      _assertRpcResult(result, 'poke', routeKind, routeId, i + 1, sendBatches.length);
      lastResult = result;
      const sentMid = _extractRpcSendMessageId(result);
      const sentMidText = _normalizeMessageIdText(sentMid);
      if (sentMidText && Array.isArray(batch?.segmentIndexes)) {
        for (const idx of batch.segmentIndexes) {
          if (Number.isFinite(idx) && idx > 0) segmentDeliveryMap.set(Math.floor(idx), sentMidText);
        }
      }
      await updateConversationHistory(msg, sentMid, true);
      continue;
    }

    const normalizedBatchRaw = _withNormalizedFileField(rawBatch);
    let normalizedBatch = Array.isArray(normalizedBatchRaw) && normalizedBatchRaw.length > 0
      ? normalizedBatchRaw
      : rawBatch;

    const requestId = `${routeKind}-msg-v2-${Date.now()}-${i + 1}`;
    let result = await sendAndWaitResult({
      type: 'sdk',
      path: rpcPath,
      args: [targetId, normalizedBatch],
      requestId
    }) as SendResult | null | undefined;

    const shouldTryImageFallback = (!result || _isAdapterSendFailed(result)) && hasImageSegment(normalizedBatch);
    if (shouldTryImageFallback) {
      const fallback = _withBase64FallbackForImages(normalizedBatch);
      if (fallback.changed && Array.isArray(fallback.parts) && fallback.parts.length > 0) {
        const retryRequestId = `${routeKind}-msg-v2-${Date.now()}-${i + 1}-b64`;
        normalizedBatch = fallback.parts;
        result = await sendAndWaitResult({
          type: 'sdk',
          path: rpcPath,
          args: [targetId, normalizedBatch],
          requestId: retryRequestId
        }) as SendResult | null | undefined;
      }
    }

    _assertRpcResult(result, 'message', routeKind, routeId, i + 1, sendBatches.length);

    lastResult = result;
    const sentMid = _extractRpcSendMessageId(result);
    const sentMidText = _normalizeMessageIdText(sentMid);
    if (sentMidText && Array.isArray(batch?.segmentIndexes)) {
      for (const idx of batch.segmentIndexes) {
        if (Number.isFinite(idx) && idx > 0) segmentDeliveryMap.set(Math.floor(idx), sentMidText);
      }
    }
    await updateConversationHistory(msg, sentMid, true);
  }

  const segmentMessageIds = Array.from(segmentDeliveryMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([segmentIndex, messageId]) => ({ segmentIndex, messageId }));

  if (lastResult && typeof lastResult === 'object') {
    return {
      ...lastResult,
      __sentraDeliveryMeta: {
        segmentMessageIds
      }
    };
  }
  return {
    __sentraDeliveryMeta: {
      segmentMessageIds
    }
  };
}
/**
 * 智能发送消息（队列控制版本）
 * 通过队列确保回复按顺序发送，避免多个任务同时完成时消息交错
 * @param {Object} msg - 消息对象
 * @param {string} response - AI响应内容
 * @param {Function} sendAndWaitResult - 发送函数
 * @param {boolean} allowReply - 是否允许引用回复（默认true），同一任务中只有第一次发送应设置为true
 * @param {Object} options - 可选参数（例如 { hasTool: boolean } 用于发送阶段去重）
 * @returns {Promise} 发送完成的 Promise
 */
export async function smartSend(
  msg: MsgLike,
  response: string,
  sendAndWaitResult: SendAndWaitFn,
  allowReply = true,
  options: SmartSendOptions = {}
): Promise<unknown> {
  const groupId = msg?.group_id ? buildGroupScopeId(msg.group_id) : buildPrivateScopeId(msg?.sender_id);
  const taskId = `${groupId}-${Date.now()}-${randomUUID().substring(0, 8)}`;
  const normalizedResponse = typeof response === 'string'
    ? response
    : String(response ?? '');

  // 预解析一次用于去重的文本和资源信息
  let textForDedup = '';
  let resourceKeys: string[] = [];
  try {
    const parsed = parseSentraMessage(normalizedResponse);

    // 如果解析结果表明应跳过发送，则直接返回，不进入发送队列
    if (parsed && parsed.shouldSkip) {
      logger.warn(`smartSend: 解析结果标记为 shouldSkip，跳过发送任务 (groupId=${groupId})`);
      return null;
    }

    const packetSegs = Array.isArray((parsed as { message?: unknown[] }).message)
      ? ((parsed as { message?: Array<{ type?: string; data?: Record<string, unknown> }> }).message || [])
      : [];
    if (packetSegs.length === 0) {
      logger.warn(`smartSend: sentra-message has no segments, skip enqueue (groupId=${groupId})`);
      return null;
    }
    const parts: string[] = [];
    for (const seg of packetSegs) {
      if (!seg || typeof seg !== 'object') continue;
      const type = String(seg.type || '').trim().toLowerCase();
      const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
      if (type === 'text') {
        const t = typeof data.text === 'string' ? data.text.trim() : '';
        if (t) parts.push(t);
      } else {
        const stable = JSON.stringify(data);
        resourceKeys.push(`seg|${type}|${stable}`);
      }
    }
    textForDedup = parts.join('\\n');

    const parsedChatType = typeof parsed?.chat_type === 'string'
      ? parsed.chat_type.trim().toLowerCase()
      : '';
    const targetKey = parsedChatType === 'group' && parsed?.group_id
      ? `target|group:${String(parsed.group_id)}`
      : (parsedChatType === 'private' && parsed?.user_id
        ? `target|private:${String(parsed.user_id)}`
        : '');
    if (targetKey) {
      resourceKeys.push(targetKey);
    }

    if (resourceKeys.length > 0) {
      resourceKeys = Array.from(new Set(resourceKeys));
    }
    // 文本去重仅基于纯文本内容，资源和表情通过 resourceKeys 独立参与资源集合去重。
    // 这里不再将资源信息混入文本指纹，避免资源差异被语义文本相似度误伤。
  } catch (e) {
    logger.warn('smartSend: 预解析用于去重的 sentra-message 失败，将回退为基于完整响应字符串的去重', { err: String(e) });
  }

  // 将发送任务加入队列（附带去重所需的元信息）
  const meta: SmartSendMeta = {
    groupId,
    response: normalizedResponse,
    textForDedup,
    resourceKeys,
    sourceMessageId: msg?.message_id != null ? String(msg.message_id) : null,
    allowReply: !!allowReply
  };

  if (typeof options.hasTool === 'boolean') {
    meta.hasTool = options.hasTool;
  }

  if (typeof options.immediate === 'boolean') {
    meta.immediate = options.immediate;
  }

  return replySendQueue.enqueue(async () => {
    return await _smartSendInternal(msg, meta.response, sendAndWaitResult, !!meta.allowReply);
  }, taskId, meta);
}

