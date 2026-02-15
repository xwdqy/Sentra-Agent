/**
 * 消息发送工具模块
 * 包含智能发送、文件处理、消息分段发送等功能
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import mimeTypes from 'mime-types';
import { parseSentraResponse } from './protocolUtils.js';
import type { SentraResponseEmoji, SentraResponseResource } from './protocolUtils.js';
import { parseTextSegments, buildSegmentMessage } from './messageUtils.js';
import { updateConversationHistory } from './conversationUtils.js';
import { createLogger } from './logger.js';
import { replySendQueue } from './replySendQueue.js';
import { getEnv, getEnvBool, getEnvInt, onEnvReload } from './envHotReloader.js';
import { randomUUID } from 'crypto';

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

async function _smartSendInternal(
  msg: MsgLike,
  response: string,
  sendAndWaitResult: SendAndWaitFn,
  allowReply = true
): Promise<unknown> {
  const parsed = parseSentraResponse(response);
  if (parsed && parsed.shouldSkip) {
    logger.warn('smartSend: 解析结果标记为 shouldSkip，本次不发送任何内容');
    return;
  }
  const textSegments = Array.isArray(parsed.textSegments) && parsed.textSegments.length > 0
    ? parsed.textSegments
    : [response];
  const protocolResources: SentraResponseResource[] = Array.isArray(parsed.resources) ? parsed.resources : [];
  const emoji: SentraResponseEmoji | null =
    parsed && typeof parsed.emoji === 'object' && parsed.emoji ? parsed.emoji : null;
  const replyMode = parsed.replyMode || 'none';
  const mentionsBySegment: Record<string, Array<string | number>> =
    parsed && typeof parsed.mentionsBySegment === 'object' && parsed.mentionsBySegment
      ? parsed.mentionsBySegment
      : {};
  const hasSendDirective = typeof response === 'string' && response.includes('<send>');
  const sendAndWait = async (payload: Record<string, unknown>) => {
    return (await sendAndWaitResult(payload)) as SendResult | null | undefined;
  };
  const updateIfMessageId = async (res: SendResult | null | undefined, isCurrent: boolean) => {
    const msgId = res?.data?.message_id;
    if (isCurrent && msgId != null) {
      await updateConversationHistory(msg, msgId, true);
    }
  };


  const normalizeMentionIds = (ids: unknown): string[] => {
    if (!Array.isArray(ids)) return [];
    const out: string[] = [];
    const seen = new Set();
    for (const mid of ids) {
      const raw = String(mid ?? '').trim();
      if (!raw) continue;
      const lowered = raw.toLowerCase ? raw.toLowerCase() : raw;
      const normalized = (lowered === '@all') ? 'all' : raw;
      if (normalized !== 'all' && !/^\d+$/.test(normalized)) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
      if (out.length >= 20) break;
    }
    return out;
  };

  const defaultRoute: RouteSpec | null = (parsed && parsed.group_id)
    ? { kind: 'group', id: String(parsed.group_id) }
    : ((parsed && parsed.user_id) ? { kind: 'private', id: String(parsed.user_id) } : null);

  const crossCfg = _getCrossChatSendConfig();
  const maxMediaPartsPerMessage = Math.max(1, Number(_getCfg().maxMediaPartsPerMessage || 8));

  const _splitBatches = <T,>(arr: T[], maxSize: number): T[][] => {
    const out: T[][] = [];
    const max = Math.max(1, Number(maxSize || 1));
    if (!Array.isArray(arr) || arr.length === 0) return out;
    for (let i = 0; i < arr.length; i += max) {
      const batch: T[] = [];
      const limit = Math.min(arr.length, i + max);
      for (let j = i; j < limit; j++) {
        const item = arr[j];
        if (item !== undefined) batch.push(item);
      }
      out.push(batch);
    }
    return out;
  };

  logger.debug(`文本段落数: ${textSegments.length}`);
  logger.debug(`协议资源数: ${protocolResources.length}`);
  if (emoji) {
    logger.debug(`表情包: ${emoji.source}`);
  }

  // 只从AI的resources中提取文件（支持本地路径和 HTTP/HTTPS 链接）
  const protocolFiles: ProtocolFile[] = [];
  const linkSegments: LinkSegment[] = [];
  const segmentCountHint = Array.isArray(textSegments) ? textSegments.length : 0;
  for (const res of protocolResources) {
    const parsedRoute = _extractRoutePrefix(String(res.source || ''));
    const routeTarget = _resolveRouteTargetWithDefault(msg, parsedRoute, defaultRoute);
    const source = parsedRoute.rest;

    logger.debug(`处理协议资源: ${res.type} ${source}`);
    if (source) {
      const isHttpUrl = /^https?:\/\//i.test(source);
      const resolvedLocalPath = (!isHttpUrl) ? _resolveLocalPathFromFileField(source) : '';
      const segIdxRaw = res && res.segment_index != null ? Number(res.segment_index) : NaN;
      const segmentIndex = Number.isFinite(segIdxRaw) && segIdxRaw > 0 ? Math.floor(segIdxRaw) : null;
      const segmentIndexOk = segmentIndex && (segmentCountHint <= 0 || segmentIndex <= segmentCountHint);

      if (segmentIndex && !segmentIndexOk) {
        logger.warn(`协议资源 segment_index 超出范围，将忽略并按默认顺序发送: ${source}`, {
          segment_index: segmentIndex,
          textSegments: segmentCountHint
        });
      }

      const normalizedResType = String(res?.type || '').trim().toLowerCase();
      const isLinkType = normalizedResType === 'link' || normalizedResType === 'url';

      let httpProbe = null;
      if (isHttpUrl) {
        const urlPath = _firstSplitPart(source, '?');

        if (isLinkType) {
          const cap = (typeof res?.caption === 'string' && res.caption.trim()) ? `${res.caption.trim()}\n` : '';
          linkSegments.push({
            text: `${cap}${source}`,
            routeTarget,
            segmentIndex: segmentIndexOk ? segmentIndex : null
          });
          logger.debug(`HTTP link 资源将作为文本发送: ${source}`);
          continue;
        }

        const inferredMime = mimeTypes.lookup(urlPath);
        const guessedMime = typeof inferredMime === 'string' ? inferredMime : '';
        const guessedHtml = guessedMime === 'text/html';

        if (!guessedMime || guessedHtml) {
          try {
            httpProbe = await _probeHttpResource(source, {
              timeoutMs: readEnvInt('SEND_HTTP_PROBE_TIMEOUT_MS', 10000),
              maxBytes: readEnvInt('SEND_HTTP_PROBE_BYTES', 2048)
            });
          } catch (e) {
            logger.warn('HTTP 资源探针失败', { url: source, err: String(e) });
          }

          if (httpProbe?.isHtml) {
            const cap = (typeof res?.caption === 'string' && res.caption.trim()) ? `${res.caption.trim()}\n` : '';
            linkSegments.push({
              text: `${cap}${source}`,
              routeTarget,
              segmentIndex: segmentIndexOk ? segmentIndex : null
            });
            logger.debug(`HTTP 资源探测为 HTML，将作为链接文本发送: ${source}`);
            continue;
          }
        }
      }

      // 本地文件：检查是否存在
      if (!isHttpUrl && (!resolvedLocalPath || !fs.existsSync(resolvedLocalPath))) {
        logger.warn(`协议资源文件不存在: ${source}`, {
          resolvedLocalPath: resolvedLocalPath || '(empty)'
        });
        continue;
      }

      // 提取文件扩展名（支持 URL 中的扩展名）
      let ext = '';
      if (isHttpUrl) {
        // 从 URL 中提取扩展名（去除查询参数）
        const urlPath = _firstSplitPart(source, '?');
        ext = path.extname(urlPath).toLowerCase();
      } else {
        ext = path.extname(resolvedLocalPath || source).toLowerCase();
      }

      // 根据扩展名 / 探针 / magic number 判断文件类型
      let fileType = 'file';
      {
        const inferredMime = mimeTypes.lookup(isHttpUrl ? _firstSplitPart(source, '?') : (resolvedLocalPath || source));
        const mime = typeof inferredMime === 'string' ? inferredMime : '';
        const forcedByResType = (() => {
          if (normalizedResType === 'image') return 'image';
          if (normalizedResType === 'video') return 'video';
          if (normalizedResType === 'record' || normalizedResType === 'audio') return 'record';
          return '';
        })();

        if (forcedByResType) {
          fileType = forcedByResType;
        } else if (httpProbe?.mime) {
          fileType = _inferFileTypeFromMime(httpProbe.mime);
        } else if (mime) {
          fileType = _inferFileTypeFromMime(mime);
        } else if (!isHttpUrl && resolvedLocalPath) {
          const localProbe = _probeLocalFileType(resolvedLocalPath);
          if (localProbe?.ok) fileType = localProbe.fileType;
        }
      }

      // 提取文件名
      let fileName = '';
      if (isHttpUrl) {
        const urlPath = _firstSplitPart(source, '?');
        fileName = (httpProbe?.fileNameFromCd || '').trim() || path.basename(urlPath) || 'download';
      } else {
        fileName = path.basename(resolvedLocalPath || source);
      }

      if (isHttpUrl && httpProbe?.ext) {
        const currentExt = path.extname(fileName).toLowerCase();
        if (!currentExt) {
          fileName = `${fileName}${httpProbe.ext}`;
        }
      }

      const fileItem: ProtocolFile = {
        type: normalizedResType,
        path: isHttpUrl ? source : (resolvedLocalPath || source),
        fileName: fileName,
        fileType,
        isHttpUrl,  // 标记是否为 HTTP 链接
        routeTarget,
        segmentIndex: segmentIndexOk ? segmentIndex : null
      };
      if (typeof res.caption === 'string' && res.caption.trim()) {
        fileItem.caption = res.caption;
      }
      protocolFiles.push(fileItem);

      if (isHttpUrl) {
        logger.debug(`添加 HTTP 资源: ${fileType} ${fileName} (${source})`);
      } else {
        logger.debug(`添加本地文件: ${fileType} ${fileName}`);
      }
    }
  }

  // 解析文本段落
  const segments: SegmentPlan[] = parseTextSegments(textSegments)
    .map((seg) => {
      const extracted = _extractRoutePrefix(seg?.text || '');
      const routeTarget = _resolveRouteTargetWithDefault(msg, extracted, defaultRoute);
      return {
        text: extracted.rest,
        routeTarget
      };
    })
    .filter((seg): seg is SegmentPlan => !!seg && typeof seg.text === 'string' && seg.text.trim().length > 0);
  const linkSendPlans: LinkSegment[] = [];
  if (linkSegments.length) {
    for (const s of linkSegments) {
      if (!s || typeof s.text !== 'string' || !s.text.trim()) continue;
      linkSendPlans.push({
        text: s.text,
        routeTarget: s.routeTarget,
        segmentIndex: s.segmentIndex
      });
    }
  }

  //logger.debug(`文本段落数: ${segments.length}`);
  //logger.debug(`资源文件数: ${protocolFiles.length}`);
  segments.forEach((seg, i) => {
    //logger.debug(`  段落${i+1}: "${seg.text.slice(0, 60)}${seg.text.length > 60 ? '...' : ''}"`);
  });
  protocolFiles.forEach((f, i) => {
    //logger.debug(`  文件${i+1}: ${f.fileName} (${f.fileType})`);
  });

  if (segments.length === 0 && protocolFiles.length === 0 && !emoji) {
    logger.warn('无内容可发送');
    return;
  }

  // 更新用户消息历史
  await updateConversationHistory(msg);

  // 决定发送策略
  const isPrivateChat = msg.type === 'private';
  const isGroupChat = msg.type === 'group';
  const selfId = msg?.self_id;
  const userAtSelf = isGroupChat && Array.isArray(msg?.at_users) && typeof selfId === 'number' && msg.at_users.includes(selfId);
  const finalReplyMode = hasSendDirective ? replyMode : 'none';

  // Model-controlled quoting: only quote when <send> is present AND a valid <reply_to_message_id> is provided.
  // If parsing fails or id is missing/invalid, we MUST NOT quote.
  const replyMessageId = (allowReply && hasSendDirective && parsed?.replyToMessageId)
    ? String(parsed.replyToMessageId)
    : null;
  let usedReply = false;

  const emojiSegIdxRaw = emoji && emoji.segment_index != null ? Number(emoji.segment_index) : NaN;
  const emojiSegmentIndex = Number.isFinite(emojiSegIdxRaw) && emojiSegIdxRaw > 0 ? Math.floor(emojiSegIdxRaw) : null;
  let emojiSentInSegmentFlow = false;

  logger.debug(`发送策略: 段落=${segments.length}, replyMode=${finalReplyMode}(${hasSendDirective ? 'by_send' : 'fallback'}), allowReply=${allowReply}, replyTo=${replyMessageId || '(none)'}`);

  let skippedCrossRouteCount = 0;
  let crossOps = 0;

  const attachedFilesBySegAndTarget = new Map<string, ProtocolFile[]>();
  const attachedLinksBySegAndTarget = new Map<string, LinkSegment[]>();
  const deferredProtocolFiles: ProtocolFile[] = [];
  for (const f of protocolFiles) {
    const rt = f?.routeTarget || _resolveRouteTarget(msg, { kind: 'current', id: '' });
    const segIdx = Number(f?.segmentIndex || 0);
    if (segIdx > 0 && segments.length > 0 && segIdx <= segments.length) {
      const k = `${segIdx}|${rt.kind}:${rt.id}`;
      const list = attachedFilesBySegAndTarget.get(k);
      if (list) {
        list.push(f);
      } else {
        attachedFilesBySegAndTarget.set(k, [f]);
      }
    } else {
      deferredProtocolFiles.push(f);
    }
  }
  for (const l of linkSendPlans) {
    const rt = l?.routeTarget || _resolveRouteTarget(msg, { kind: 'current', id: '' });
    const segIdx = Number(l?.segmentIndex || 0);
    if (segIdx > 0 && segments.length > 0 && segIdx <= segments.length) {
      const k = `${segIdx}|${rt.kind}:${rt.id}`;
      const list = attachedLinksBySegAndTarget.get(k);
      if (list) {
        list.push(l);
      } else {
        attachedLinksBySegAndTarget.set(k, [l]);
      }
    } else {
      segments.push({ text: l.text, routeTarget: rt });
    }
  }

  // 发送文本段落
  if (segments.length > 0) {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment) continue;
      const routeTarget = segment?.routeTarget || _resolveRouteTarget(msg, { kind: 'current', id: '' });

      if (!routeTarget?.id) {
        logger.warn('发送目标缺少 id，已跳过该段', { kind: routeTarget?.kind });
        continue;
      }

      if (!_isCrossRouteAllowed(msg, routeTarget, crossCfg)) {
        skippedCrossRouteCount++;
        continue;
      }

      if (!routeTarget.isCurrent) {
        if (crossOps >= crossCfg.maxCrossOpsPerResponse) {
          skippedCrossRouteCount++;
          continue;
        }
        crossOps++;
      }

      let messageParts: MessagePart[] = buildSegmentMessage(segment);

      if (messageParts.length === 0) continue;
      const segKey = `${i + 1}|${routeTarget.kind}:${routeTarget.id}`;

      logger.debug(`发送第${i + 1}段: ${messageParts.map(p => p.type).join(', ')}`);

      const isGroupTarget = routeTarget.kind === 'group';
      const isPrivateTarget = routeTarget.kind === 'private';

      // 仅在“当前会话”中允许 mentions（避免跨群误 @）
      const segMentions = (() => {
        if (!hasSendDirective) return [];
        if (!routeTarget.isCurrent || !isGroupTarget) return [];
        const bySeg = mentionsBySegment && typeof mentionsBySegment === 'object' ? mentionsBySegment[String(i + 1)] : null;
        return normalizeMentionIds(bySeg);
      })();

      if (segMentions.length > 0) {
        const atParts: MessagePart[] = segMentions.map((qq) => ({ type: 'at', data: { qq } }));
        messageParts = [
          ...atParts,
          { type: 'text', data: { text: ' ' } },
          ...messageParts
        ];
      }

      let sentMessageId = null;

      // 根据协议选择是否使用引用回复
      const wantReply = routeTarget.isCurrent && replyMessageId && allowReply && (
        (finalReplyMode === 'always') || (finalReplyMode === 'first' && i === 0)
      );
      if (wantReply) {
        if (isPrivateTarget) {
          const result = await sendAndWait({
            type: "sdk",
            path: "send.privateReply",
            args: [Number(routeTarget.id), replyMessageId, messageParts],
            requestId: `private-reply-${Date.now()}-${i}`
          });
          sentMessageId = result?.data?.message_id;
        } else if (isGroupTarget) {
          const result = await sendAndWait({
            type: "sdk",
            path: "send.groupReply",
            args: [Number(routeTarget.id), replyMessageId, messageParts],
            requestId: `group-reply-${Date.now()}-${i}`
          });
          sentMessageId = result?.data?.message_id;
        }
        usedReply = true;
      } else {
        // 普通发送
        if (isPrivateTarget) {
          const result = await sendAndWait({
            type: "sdk",
            path: "send.private",
            args: [Number(routeTarget.id), messageParts],
            requestId: `private-${Date.now()}-${i}`
          });
          sentMessageId = result?.data?.message_id;
        } else if (isGroupTarget) {
          const result = await sendAndWait({
            type: "sdk",
            path: "send.group",
            args: [Number(routeTarget.id), messageParts],
            requestId: `group-${Date.now()}-${i}`
          });
          sentMessageId = result?.data?.message_id;
        }
      }

      // 更新消息历史（仅对当前会话写入，避免跨群污染）
      if (routeTarget.isCurrent && sentMessageId) {
        await updateConversationHistory(msg, sentMessageId, true);
        logger.debug(`第${i + 1}段发送成功，消息ID: ${sentMessageId}`);
      }

      const attachedLinks: LinkSegment[] = attachedLinksBySegAndTarget.get(segKey) || [];
      const attachedFiles: ProtocolFile[] = attachedFilesBySegAndTarget.get(segKey) || [];

      if (attachedLinks.length > 0) {
        const isGroupTarget2 = routeTarget.kind === 'group';
        const replyForAddon = routeTarget.isCurrent && replyMessageId && allowReply && (
          finalReplyMode === 'always' || (finalReplyMode === 'first' && !usedReply)
        );

        for (const l of attachedLinks) {
          const addonText = String(l?.text || '').trim();
          if (!addonText) continue;
          const delay = 200 + Math.random() * 500;
          await new Promise(resolve => setTimeout(resolve, delay));
          const parts: MessagePart[] = buildSegmentMessage({ text: addonText });
          if (parts.length === 0) continue;
          if (routeTarget.kind === 'private') {
            const result = await sendAndWait({
              type: "sdk",
              path: replyForAddon ? "send.privateReply" : "send.private",
              args: replyForAddon ? [Number(routeTarget.id), replyMessageId, parts] : [Number(routeTarget.id), parts],
              requestId: `private-link-${Date.now()}-${i}`
            });
            if (routeTarget.isCurrent && result?.data?.message_id) {
              await updateConversationHistory(msg, result.data.message_id, true);
            }
            if (replyForAddon) usedReply = true;
          } else if (isGroupTarget2) {
            const result = await sendAndWait({
              type: "sdk",
              path: replyForAddon ? "send.groupReply" : "send.group",
              args: replyForAddon ? [Number(routeTarget.id), replyMessageId, parts] : [Number(routeTarget.id), parts],
              requestId: `group-link-${Date.now()}-${i}`
            });
            if (routeTarget.isCurrent && result?.data?.message_id) {
              await updateConversationHistory(msg, result.data.message_id, true);
            }
            if (replyForAddon) usedReply = true;
          }
        }
      }

      if (attachedFiles.length > 0) {
        const delay = 200 + Math.random() * 700;
        await new Promise(resolve => setTimeout(resolve, delay));

        const mediaParts: MessagePart[] = [];
        const normalFiles: ProtocolFile[] = [];
        const mediaFilesOnly: ProtocolFile[] = [];
        for (const file of attachedFiles) {
          const fileType = file.fileType || '';
          if (['image', 'video', 'record'].includes(fileType)) {
            mediaFilesOnly.push(file);
            if (fileType === 'image') mediaParts.push({ type: 'image', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
            else if (fileType === 'video') mediaParts.push({ type: 'video', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
            else if (fileType === 'record') mediaParts.push({ type: 'record', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
          } else {
            normalFiles.push(file);
          }
        }

        const shouldReplyForMedia = routeTarget.isCurrent && replyMessageId && allowReply && (
          finalReplyMode === 'always' || (finalReplyMode === 'first' && !usedReply)
        );

        if (mediaParts.length > 0) {
          const batches = _splitBatches(mediaParts, maxMediaPartsPerMessage);
          logger.debug(`分批发送媒体: 总数=${mediaParts.length}, 单批上限=${maxMediaPartsPerMessage}, 批次数=${batches.length}`);

          const shouldAttachCaptionToSingleImage = (() => {
            if (mediaFilesOnly.length !== 1) return false;
            const f = mediaFilesOnly[0];
            if (!f || f.fileType !== 'image') return false;
            const cap = typeof f.caption === 'string' ? f.caption.trim() : '';
            if (!cap) return false;
            return true;
          })();
          const firstMedia = mediaFilesOnly[0];
          const singleImageCaption = shouldAttachCaptionToSingleImage && firstMedia && typeof firstMedia.caption === 'string'
            ? firstMedia.caption.trim()
            : '';

          for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            const useReply = shouldReplyForMedia && !usedReply;
            const requestId = `${routeTarget.kind}-segmedia-${Date.now()}-${i}-${bi}`;
            let partsToSend = batch;
            if (shouldAttachCaptionToSingleImage && bi === 0 && Array.isArray(batch) && batch.length === 1 && batch[0]?.type === 'image') {
              partsToSend = [{ type: 'text', data: { text: singleImageCaption } }, ...batch];
            }
            let normalizedParts = _withNormalizedFileField(partsToSend);
            let result = await sendAndWait({
              type: "sdk",
              path: routeTarget.kind === 'private'
                ? (useReply ? "send.privateReply" : "send.private")
                : (useReply ? "send.groupReply" : "send.group"),
              args: routeTarget.kind === 'private'
                ? (useReply ? [Number(routeTarget.id), replyMessageId, normalizedParts] : [Number(routeTarget.id), normalizedParts])
                : (useReply ? [Number(routeTarget.id), replyMessageId, normalizedParts] : [Number(routeTarget.id), normalizedParts]),
              requestId
            });
            if (result && _isAdapterSendFailed(result)) {
              const fb = _withBase64FallbackForImages(normalizedParts);
              if (fb.changed) {
                const retryId = `${requestId}-base64`;
                normalizedParts = fb.parts;
                result = await sendAndWait({
                  type: "sdk",
                  path: routeTarget.kind === 'private'
                    ? (useReply ? "send.privateReply" : "send.private")
                    : (useReply ? "send.groupReply" : "send.group"),
                  args: routeTarget.kind === 'private'
                    ? (useReply ? [Number(routeTarget.id), replyMessageId, normalizedParts] : [Number(routeTarget.id), normalizedParts])
                    : (useReply ? [Number(routeTarget.id), replyMessageId, normalizedParts] : [Number(routeTarget.id), normalizedParts]),
                  requestId: retryId
                });
              }
            }
            if (useReply) usedReply = true;
            if (routeTarget.isCurrent && result?.data?.message_id) {
              await updateConversationHistory(msg, result.data.message_id, true);
            }
            if (bi < batches.length - 1) {
              const gap = 250 + Math.random() * 700;
              await new Promise(resolve => setTimeout(resolve, gap));
            }
          }
        }

        if (normalFiles.length > 0) {
          const delay2 = 200 + Math.random() * 800;
          await new Promise(resolve => setTimeout(resolve, delay2));
          for (const file of normalFiles) {
            const fileField = _toFileUrlIfLikelyLocal(file.path);
            const requestId = `segfile-${routeTarget.kind}-${Date.now()}-${i}`;
            let result = await sendAndWait({
              type: "sdk",
              path: routeTarget.kind === 'private' ? "file.uploadPrivate" : "file.uploadGroup",
              args: routeTarget.kind === 'private'
                ? [Number(routeTarget.id), fileField, file.fileName]
                : [Number(routeTarget.id), fileField, file.fileName, ""],
              requestId
            });
            if (result && _isAdapterSendFailed(result)) {
              const b64 = _readBase64FileIfAllowed(fileField);
              if (b64) {
                result = await sendAndWait({
                  type: "sdk",
                  path: routeTarget.kind === 'private' ? "file.uploadPrivate" : "file.uploadGroup",
                  args: routeTarget.kind === 'private'
                    ? [Number(routeTarget.id), b64, file.fileName]
                    : [Number(routeTarget.id), b64, file.fileName, ""],
                  requestId: `${requestId}-base64`
                });
              }
            }
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        }
      }

      if (!emojiSentInSegmentFlow && emoji && emoji.source && emojiSegmentIndex && emojiSegmentIndex === (i + 1)) {
        const extracted = _extractRoutePrefix(String(emoji.source || ''));
        const rt = _resolveRouteTargetWithDefault(msg, extracted, defaultRoute);
        const emojiPath = extracted.rest;

        if (rt?.id && _isCrossRouteAllowed(msg, rt, crossCfg)) {
          if (!rt.isCurrent) {
            if (crossOps >= crossCfg.maxCrossOpsPerResponse) {
              skippedCrossRouteCount++;
            } else {
              crossOps++;
            }
          }

          if (rt?.id && (rt.isCurrent || crossOps <= crossCfg.maxCrossOpsPerResponse)) {
            if (fs.existsSync(emojiPath)) {
              const delay3 = 200 + Math.random() * 800;
              await new Promise(resolve => setTimeout(resolve, delay3));

              const emojiMessageParts: MessagePart[] = [
                { type: 'image', data: { file: _toFileUrlIfLikelyLocal(emojiPath) } }
              ];

              if (rt.kind === 'private') {
                const requestId = `private-emoji-${Date.now()}`;
                let normalizedParts = _withNormalizedFileField(emojiMessageParts);
                let result = await sendAndWait({
                  type: "sdk",
                  path: "send.private",
                  args: [Number(rt.id), normalizedParts],
                  requestId
                });
                if (result && _isAdapterSendFailed(result)) {
                  const fb = _withBase64FallbackForImages(normalizedParts);
                  if (fb.changed) {
                    const retryId = `${requestId}-base64`;
                    normalizedParts = fb.parts;
                    result = await sendAndWait({
                      type: "sdk",
                      path: "send.private",
                      args: [Number(rt.id), normalizedParts],
                      requestId: retryId
                    });
                  }
                }
              } else if (rt.kind === 'group') {
                const requestId = `group-emoji-${Date.now()}`;
                let normalizedParts = _withNormalizedFileField(emojiMessageParts);
                let result = await sendAndWait({
                  type: "sdk",
                  path: "send.group",
                  args: [Number(rt.id), normalizedParts],
                  requestId
                });
                if (result && _isAdapterSendFailed(result)) {
                  const fb = _withBase64FallbackForImages(normalizedParts);
                  if (fb.changed) {
                    const retryId = `${requestId}-base64`;
                    normalizedParts = fb.parts;
                    result = await sendAndWait({
                      type: "sdk",
                      path: "send.group",
                      args: [Number(rt.id), normalizedParts],
                      requestId: retryId
                    });
                  }
                }
              }

              emojiSentInSegmentFlow = true;
              if (rt.isCurrent && replyMessageId && allowReply && finalReplyMode === 'first') {
                usedReply = true;
              }
            } else {
              logger.warn(`表情包文件不存在: ${emojiPath}`);
            }
          }
        }
      }

      if (i < segments.length - 1) {
        const delay = 800 + Math.random() * 2200; // 0.8-3秒随机间隔
        logger.debug(`等待 ${Math.round(delay)}ms 后发送下一段`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // 分类文件：媒体文件 vs 普通文件
  const mediaFiles: ProtocolFile[] = deferredProtocolFiles.filter((f) => ['image', 'video', 'record'].includes(f.fileType || ''));
  const uploadFiles: ProtocolFile[] = deferredProtocolFiles.filter((f) => f.fileType === 'file');

  logger.debug(`媒体文件: ${mediaFiles.length}个, 普通文件: ${uploadFiles.length}个`);

  // 发送媒体文件（图片、视频、语音）
  if (mediaFiles.length > 0) {
    if (segments.length > 0) {
      const delay = 800 + Math.random() * 800;
      logger.debug(`等待 ${Math.round(delay)}ms 后发送媒体`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    const grouped = new Map<string, { routeTarget: RouteTarget; files: ProtocolFile[] }>();
    for (const file of mediaFiles) {
      const rt = file?.routeTarget || _resolveRouteTarget(msg, { kind: 'current', id: '' });
      if (!rt?.id) {
        skippedCrossRouteCount++;
        continue;
      }
      if (!_isCrossRouteAllowed(msg, rt, crossCfg)) {
        skippedCrossRouteCount++;
        continue;
      }
      if (!rt.isCurrent) {
        if (crossOps >= crossCfg.maxCrossOpsPerResponse) {
          skippedCrossRouteCount++;
          continue;
        }
        crossOps++;
      }
      const key = rt.kind + ':' + rt.id;
      const bucket = grouped.get(key);
      if (bucket) {
        bucket.files.push(file);
      } else {
        grouped.set(key, { routeTarget: rt, files: [file] });
      }
    }

    for (const group of grouped.values()) {
      const rt = group.routeTarget;
      const mediaMessageParts: MessagePart[] = [];
      group.files.forEach((file: ProtocolFile) => {
        const fileType = file.fileType || '';
        logger.debug('添加媒体: ' + fileType + ' - ' + (file.fileName || ''));
        if (fileType === 'image') {
          mediaMessageParts.push({ type: 'image', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
        } else if (fileType === 'video') {
          mediaMessageParts.push({ type: 'video', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
        } else if (fileType === 'record') {
          mediaMessageParts.push({ type: 'record', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
        }
      });

      if (mediaMessageParts.length === 0) continue;

      if (segments.length === 0 && hasSendDirective && rt.isCurrent && rt.kind === 'group') {
        const ids = mentionsBySegment && typeof mentionsBySegment === 'object' ? mentionsBySegment['1'] : null;
        const segMentions = normalizeMentionIds(ids);
        if (segMentions.length > 0) {
          const atParts: MessagePart[] = segMentions.map((qq) => ({ type: 'at', data: { qq } }));
          mediaMessageParts.unshift(...atParts);
        }
      }

      const replyForMedia = rt.isCurrent && replyMessageId && allowReply && (
        finalReplyMode === 'always' || (finalReplyMode === 'first' && !usedReply)
      );

      const prefixParts: MessagePart[] = [];
      const mediaOnlyParts: MessagePart[] = [...mediaMessageParts];
      while (mediaOnlyParts.length > 0 && mediaOnlyParts[0] && mediaOnlyParts[0].type === 'at') {
        const shifted = mediaOnlyParts.shift();
        if (shifted) prefixParts.push(shifted);
      }
      const mediaBatches = _splitBatches(mediaOnlyParts, maxMediaPartsPerMessage);

      for (let bi = 0; bi < mediaBatches.length; bi++) {
        const batch = mediaBatches[bi];
        if (!Array.isArray(batch) || batch.length === 0) continue;
        const useReply = replyForMedia && !usedReply;
        const requestId = `${rt.kind}-media-${Date.now()}-${bi}`;
        const parts = (bi === 0 && prefixParts.length > 0) ? [...prefixParts, ...batch] : batch;
        let normalizedParts = _withNormalizedFileField(parts);
        let result = await sendAndWait({
          type: "sdk",
          path: rt.kind === 'private'
            ? (useReply ? "send.privateReply" : "send.private")
            : (useReply ? "send.groupReply" : "send.group"),
          args: rt.kind === 'private'
            ? (useReply ? [Number(rt.id), replyMessageId, normalizedParts] : [Number(rt.id), normalizedParts])
            : (useReply ? [Number(rt.id), replyMessageId, normalizedParts] : [Number(rt.id), normalizedParts]),
          requestId
        });
        if (result && _isAdapterSendFailed(result)) {
          const fb = _withBase64FallbackForImages(normalizedParts);
          if (fb.changed) {
            const retryId = `${requestId}-base64`;
            normalizedParts = fb.parts;
            result = await sendAndWait({
              type: "sdk",
              path: rt.kind === 'private'
                ? (useReply ? "send.privateReply" : "send.private")
                : (useReply ? "send.groupReply" : "send.group"),
              args: rt.kind === 'private'
                ? (useReply ? [Number(rt.id), replyMessageId, normalizedParts] : [Number(rt.id), normalizedParts])
                : (useReply ? [Number(rt.id), replyMessageId, normalizedParts] : [Number(rt.id), normalizedParts]),
              requestId: retryId
            });
          }
        }
        if (useReply) usedReply = true;
        logger.debug('媒体发送结果', {
          ok: !!result?.ok,
          requestId,
          target: { kind: rt.kind, id: String(rt.id), isCurrent: !!rt.isCurrent },
          message_id: result?.data?.message_id,
          data: result?.data
        });
        if (bi < mediaBatches.length - 1) {
          const gap = 350 + Math.random() * 900;
          await new Promise(resolve => setTimeout(resolve, gap));
        }
      }
    }
  }

  // 上传普通文件
  if (uploadFiles.length > 0) {
    logger.debug(`准备上传 ${uploadFiles.length} 个普通文件`);

    const delay = 1000 + Math.random() * 1000;
    await new Promise(resolve => setTimeout(resolve, delay));

    for (const file of uploadFiles) {
      logger.debug(`上传文件: ${file.fileName}`);

      const rt = file?.routeTarget || _resolveRouteTarget(msg, { kind: 'current', id: '' });
      if (!rt?.id) {
        skippedCrossRouteCount++;
        continue;
      }

      if (!_isCrossRouteAllowed(msg, rt, crossCfg)) {
        skippedCrossRouteCount++;
        continue;
      }

      if (!rt.isCurrent) {
        if (crossOps >= crossCfg.maxCrossOpsPerResponse) {
          skippedCrossRouteCount++;
          continue;
        }
        crossOps++;
      }

      if (rt.kind === 'private') {
        const requestId = `file-upload-private-${Date.now()}`;
        const fileField = _toFileUrlIfLikelyLocal(file.path);
        let result = await sendAndWait({
          type: "sdk",
          path: "file.uploadPrivate",
          args: [Number(rt.id), fileField, file.fileName],
          requestId
        });

        if (result && _isAdapterSendFailed(result)) {
          const b64 = _readBase64FileIfAllowed(fileField);
          if (b64) {
            result = await sendAndWait({
              type: "sdk",
              path: "file.uploadPrivate",
              args: [Number(rt.id), b64, file.fileName],
              requestId: `${requestId}-base64`
            });
          }
        }
      } else if (rt.kind === 'group') {
        const requestId = `file-upload-group-${Date.now()}`;
        const fileField = _toFileUrlIfLikelyLocal(file.path);
        let result = await sendAndWait({
          type: "sdk",
          path: "file.uploadGroup",
          args: [Number(rt.id), fileField, file.fileName, ""],
          requestId
        });

        if (result && _isAdapterSendFailed(result)) {
          const b64 = _readBase64FileIfAllowed(fileField);
          if (b64) {
            result = await sendAndWait({
              type: "sdk",
              path: "file.uploadGroup",
              args: [Number(rt.id), b64, file.fileName, ""],
              requestId: `${requestId}-base64`
            });
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }

  // 发送表情包（如果有）
  if (emoji && emoji.source && !emojiSentInSegmentFlow) {
    const extracted = _extractRoutePrefix(String(emoji.source || ''));
    const rt = _resolveRouteTargetWithDefault(msg, extracted, defaultRoute);
    const emojiPath = extracted.rest;

    if (!rt?.id) {
      skippedCrossRouteCount++;
      logger.success('发送完成');
      return;
    }

    if (!_isCrossRouteAllowed(msg, rt, crossCfg)) {
      skippedCrossRouteCount++;
      logger.success('发送完成');
      return;
    }

    if (!rt.isCurrent) {
      if (crossOps >= crossCfg.maxCrossOpsPerResponse) {
        skippedCrossRouteCount++;
        logger.success('发送完成');
        return;
      }
      crossOps++;
    }

    logger.debug(`准备发送表情包: ${emojiPath}`);

    // 验证文件存在性
    if (!fs.existsSync(emojiPath)) {
      logger.warn(`表情包文件不存在: ${emojiPath}`);
    } else {
      // 等待一小段时间
      const delay = (textSegments.length > 0 || protocolFiles.length > 0) ? (600 + Math.random() * 800) : 0;
      if (delay > 0) {
        logger.debug(`等待 ${Math.round(delay)}ms 后发送表情包`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // 构建图片消息
      const emojiMessageParts: MessagePart[] = [
        { type: 'image', data: { file: _toFileUrlIfLikelyLocal(emojiPath) } }
      ];

      logger.debug('发送表情包作为图片消息');

      if (rt.kind === 'private') {
        const requestId = `private-emoji-${Date.now()}`;
        let normalizedParts = _withNormalizedFileField(emojiMessageParts);
        let result = await sendAndWait({
          type: "sdk",
          path: "send.private",
          args: [Number(rt.id), normalizedParts],
          requestId
        });

        if (result && _isAdapterSendFailed(result)) {
          const fb = _withBase64FallbackForImages(normalizedParts);
          if (fb.changed) {
            const retryId = `${requestId}-base64`;
            normalizedParts = fb.parts;
            result = await sendAndWait({
              type: "sdk",
              path: "send.private",
              args: [Number(rt.id), normalizedParts],
              requestId: retryId
            });
          }
        }
        logger.debug('表情包发送结果', {
          ok: !!result?.ok,
          requestId,
          target: { kind: rt.kind, id: String(rt.id), isCurrent: !!rt.isCurrent },
          message_id: result?.data?.message_id,
          data: result?.data
        });
      } else if (rt.kind === 'group') {
        const requestId = `group-emoji-${Date.now()}`;
        let normalizedParts = _withNormalizedFileField(emojiMessageParts);
        let result = await sendAndWait({
          type: "sdk",
          path: "send.group",
          args: [Number(rt.id), normalizedParts],
          requestId
        });

        if (result && _isAdapterSendFailed(result)) {
          const fb = _withBase64FallbackForImages(normalizedParts);
          if (fb.changed) {
            const retryId = `${requestId}-base64`;
            normalizedParts = fb.parts;
            result = await sendAndWait({
              type: "sdk",
              path: "send.group",
              args: [Number(rt.id), normalizedParts],
              requestId: retryId
            });
          }
        }
        logger.debug('表情包发送结果', {
          ok: !!result?.ok,
          requestId,
          target: { kind: rt.kind, id: String(rt.id), isCurrent: !!rt.isCurrent },
          message_id: result?.data?.message_id,
          data: result?.data
        });
      }

      if (rt.isCurrent && replyMessageId && allowReply && finalReplyMode === 'first') {
        usedReply = true;
      }
    }
  }

  if (skippedCrossRouteCount > 0) {
    logger.warn('部分跨会话路由目标未获授权或未启用，已跳过发送', { skipped: skippedCrossRouteCount });
  }

  logger.success('发送完成');
  return undefined;
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
  const groupId = msg?.group_id ? `G:${msg.group_id}` : `U:${msg.sender_id}`;
  const taskId = `${groupId}-${Date.now()}-${randomUUID().substring(0, 8)}`;

  // 预解析一次用于去重的文本和资源信息
  let textForDedup = '';
  let resourceKeys: string[] = [];
  let emojiKey = '';
  try {
    if (typeof response === 'string') {
      const parsed = parseSentraResponse(response);

      // 如果解析结果表明应跳过发送，则直接返回，不进入发送队列
      if (parsed && parsed.shouldSkip) {
        logger.warn(`smartSend: 解析结果标记为 shouldSkip，跳过发送任务 (groupId=${groupId})`);
        return null;
      }

      const segments = Array.isArray(parsed.textSegments) ? parsed.textSegments : [];
      textForDedup = segments
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean)
        .join('\n');

      const resources = Array.isArray(parsed.resources) ? parsed.resources : [];
      resourceKeys = resources
        .map((r) => {
          const t = r?.type || '';
          const src = r?.source || '';
          return t && src ? `${t}|${src}` : '';
        })
        .filter(Boolean);

      const targetKey = parsed?.group_id
        ? `target|group:${String(parsed.group_id)}`
        : (parsed?.user_id ? `target|private:${String(parsed.user_id)}` : '');
      if (targetKey) {
        resourceKeys.push(targetKey);
      }

      if (parsed?.emoji?.source) {
        emojiKey = `emoji|${parsed.emoji.source}`;
      }

      if (resourceKeys.length > 0) {
        resourceKeys = Array.from(new Set(resourceKeys));
      }
      // 文本去重仅基于纯文本内容，资源和表情通过 resourceKeys 独立参与资源集合去重。
      // 这里不再将资源信息混入文本指纹，避免资源差异被语义文本相似度误伤。
    }
  } catch (e) {
    logger.warn('smartSend: 预解析用于去重的 sentra-response 失败，将回退为基于完整响应字符串的去重', { err: String(e) });
  }

  // 将发送任务加入队列（附带去重所需的元信息）
  const meta: SmartSendMeta = {
    groupId,
    response: typeof response === 'string' ? response : String(response ?? ''),
    textForDedup,
    resourceKeys: emojiKey ? [...resourceKeys, emojiKey] : resourceKeys,
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





