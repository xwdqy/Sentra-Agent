/**
 * 消息发送工具模块
 * 包含智能发送、文件处理、消息分段发送等功能
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import mimeTypes from 'mime-types';
import fetch from 'node-fetch';
import { parseSentraResponse } from './protocolUtils.js';
import { parseTextSegments, buildSegmentMessage } from './messageUtils.js';
import { updateConversationHistory } from './conversationUtils.js';
import { createLogger } from './logger.js';
import { replySendQueue } from './replySendQueue.js';
import { getEnv, getEnvBool, getEnvInt, onEnvReload } from './envHotReloader.js';
import { randomUUID } from 'crypto';

const logger = createLogger('SendUtils');

const _httpMimeCache = new Map();

function _normalizeContentType(ct) {
  const s = String(ct || '').trim().toLowerCase();
  if (!s) return '';
  return s.split(';')[0].trim();
}

function _extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (!m) return '';
  if (m === 'image/jpeg') return '.jpg';
  if (m === 'image/jpg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/svg+xml') return '.svg';
  if (m === 'image/bmp') return '.bmp';
  if (m === 'image/x-icon') return '.ico';
  return '';
}

async function _readFirstBytesFromResponse(res, maxBytes) {
  try {
    const cap = Math.max(0, Number(maxBytes) || 0);
    if (!cap) return Buffer.alloc(0);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk);
      chunks.push(b);
      total += b.length;
      if (total >= cap) break;
    }
    try { res.body?.destroy?.(); } catch {}
    const buf = Buffer.concat(chunks);
    return buf.length > cap ? buf.subarray(0, cap) : buf;
  } catch {
    try { res.body?.destroy?.(); } catch {}
    return Buffer.alloc(0);
  }
}

function _sniffMimeFromBytes(buf) {
  try {
    if (!buf || !buf.length) return '';
    if (buf.length >= 8) {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (buf.subarray(0, 8).equals(png)) return 'image/png';
    }
    if (buf.length >= 3) {
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    }
    if (buf.length >= 6) {
      const h = buf.toString('ascii', 0, 6);
      if (h === 'GIF87a' || h === 'GIF89a') return 'image/gif';
    }
    if (buf.length >= 12) {
      const a = buf.toString('ascii', 0, 4);
      const b = buf.toString('ascii', 8, 12);
      if (a === 'RIFF' && b === 'WEBP') return 'image/webp';
    }
    if (buf.length >= 2) {
      if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
    }
    if (buf.length >= 4) {
      if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x01 || buf[2] === 0x02) && buf[3] === 0x00) return 'image/x-icon';
    }
    const head = buf.toString('utf8', 0, Math.min(512, buf.length)).trimStart().toLowerCase();
    if (head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!doctype')) {
      if (head.includes('<svg')) return 'image/svg+xml';
    }
    return '';
  } catch {
    return '';
  }
}

async function _probeHttpMime(source) {
  const key = String(source || '').trim();
  if (!key) return '';
  if (_httpMimeCache.has(key)) return _httpMimeCache.get(key) || '';

  const controller = new AbortController();
  const t = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, 3500);

  const setCache = (v) => {
    const out = String(v || '').trim().toLowerCase();
    _httpMimeCache.set(key, out);
    return out;
  };

  const commonHeaders = {
    Accept: '*/*',
    'User-Agent': 'Mozilla/5.0 (compatible; Sentra-Agent/1.0; +https://github.com/)',
  };

  try {
    try {
      const r = await fetch(key, { method: 'HEAD', redirect: 'follow', headers: commonHeaders, signal: controller.signal });
      const ct = _normalizeContentType(r?.headers?.get?.('content-type'));
      if (ct && ct !== 'text/html' && !ct.startsWith('text/')) {
        // Only trust HEAD when it is explicit media type; otherwise keep sniffing.
        if (ct.startsWith('image/') || ct.startsWith('video/') || ct.startsWith('audio/')) {
          clearTimeout(t);
          return setCache(ct);
        }
      }
    } catch {}

    try {
      const r2 = await fetch(key, {
        method: 'GET',
        redirect: 'follow',
        headers: { ...commonHeaders, Range: 'bytes=0-1023' },
        signal: controller.signal
      });
      const ct2 = _normalizeContentType(r2?.headers?.get?.('content-type'));
      if (ct2 && ct2 !== 'text/html' && ct2.startsWith('image/')) {
        clearTimeout(t);
        return setCache(ct2);
      }
      const buf = await _readFirstBytesFromResponse(r2, 1024);
      const sniffed = _sniffMimeFromBytes(buf);
      clearTimeout(t);
      return setCache(sniffed);
    } catch {
      clearTimeout(t);
      return setCache('');
    }
  } catch {
    clearTimeout(t);
    return setCache('');
  }
}

let _cfgCache = null;
function _getCfg() {
  if (_cfgCache) return _cfgCache;

  let base64MaxBytes = 2 * 1024 * 1024;
  const mbText = getEnv('NAPCAT_BASE64_MAX_MB', undefined);
  const mb = mbText !== undefined ? Number(mbText) : NaN;
  if (Number.isFinite(mb) && mb > 0) {
    base64MaxBytes = Math.floor(mb * 1024 * 1024);
  }

  _cfgCache = {
    base64MaxBytes,
    maxMediaPartsPerMessage: getEnvInt('SEND_MEDIA_BATCH_MAX', 8),
    crossChat: {
      enabled: getEnvBool('CROSS_CHAT_SEND_ENABLED', true),
      allowedGroupIds: _parseCsvIdSet(getEnv('CROSS_CHAT_SEND_ALLOW_GROUP_IDS', '')),
      allowedUserIds: _parseCsvIdSet(getEnv('CROSS_CHAT_SEND_ALLOW_USER_IDS', '')),
      allowedSenderIds: _parseCsvIdSet(getEnv('CROSS_CHAT_SEND_ALLOW_SENDER_IDS', '')),
      requireTargetIdInUserText: getEnvBool('CROSS_CHAT_SEND_REQUIRE_TARGET_IN_USER_TEXT', false),
      maxCrossOpsPerResponse: getEnvInt('CROSS_CHAT_SEND_MAX_OPS_PER_RESPONSE', 6)
    }
  };

  return _cfgCache;
}

onEnvReload(() => {
  _cfgCache = null;
});

function _isAdapterSendFailed(result) {
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

function _toFileUrlIfLikelyLocal(p) {
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

function _resolveLocalPathFromFileField(p) {
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

function _readBase64FileIfAllowed(fileField) {
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

function _withNormalizedFileField(messageParts) {
  if (!Array.isArray(messageParts)) return messageParts;
  return messageParts.map((p) => {
    const f = p?.data?.file;
    if (!f) return p;
    return { ...p, data: { ...p.data, file: _toFileUrlIfLikelyLocal(f) } };
  });
}

function _withBase64FallbackForImages(messageParts) {
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

function _shouldRetryAsFileUrl(result) {
  const msg = String(result?.data?.message || '').toLowerCase();
  if (msg.includes('识别url失败')) return true;
  if (msg.includes('url')) return true;
  return false;
}

function _parseCsvIdSet(raw) {
  const s = String(raw || '').trim();
  if (!s) return new Set();
  return new Set(
    s
      .split(',')
      .map((v) => String(v || '').trim())
      .filter(Boolean)
  );
}

function _getCrossChatSendConfig() {
  return _getCfg().crossChat;
}

function _collectUserProvidedTextForCrossAuth(msg) {
  const out = [];
  const push = (v) => {
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

function _isTargetIdExplicitlyMentionedInUserText(msg, id) {
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

function _extractRoutePrefix(text) {
  const raw = typeof text === 'string' ? text : '';
  return { kind: 'current', id: '', rest: raw };
}

function _resolveRouteTarget(msg, route) {
  const current = {
    kind: msg?.type === 'private' ? 'private' : 'group',
    id: msg?.type === 'private' ? String(msg?.sender_id ?? '') : String(msg?.group_id ?? '')
  };

  const kind = route?.kind || 'current';
  if (kind === 'current') return { kind: current.kind, id: current.id, isCurrent: true };

  const id = String(route?.id || '').trim();
  const isCurrent = kind === current.kind && id && id === current.id;
  return { kind, id, isCurrent };
}

function _resolveRouteTargetWithDefault(msg, route, defaultRoute) {
  if (route && route.kind === 'current' && defaultRoute && defaultRoute.kind && defaultRoute.id) {
    const current = {
      kind: msg?.type === 'private' ? 'private' : 'group',
      id: msg?.type === 'private' ? String(msg?.sender_id ?? '') : String(msg?.group_id ?? '')
    };
    const kind = String(defaultRoute.kind || '').trim();
    const id = String(defaultRoute.id || '').trim();
    const isCurrent = kind === current.kind && id && id === current.id;
    return { kind, id, isCurrent, explicitByProtocol: true };
  }
  return _resolveRouteTarget(msg, route);
}

function _isCrossRouteAllowed(msg, routeTarget, crossCfg) {
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
async function _smartSendInternal(msg, response, sendAndWaitResult, allowReply = true) {
  const parsed = parseSentraResponse(response);
  if (parsed && parsed.shouldSkip) {
    logger.warn('smartSend: 解析结果标记为 shouldSkip，本次不发送任何内容');
    return;
  }
  const textSegments = parsed.textSegments || [response];
  const protocolResources = parsed.resources || [];
  const emoji = parsed.emoji || null;
  const replyMode = parsed.replyMode || 'none';
  const mentionsBySegment = (parsed && typeof parsed.mentionsBySegment === 'object' && parsed.mentionsBySegment) ? parsed.mentionsBySegment : {};
  const hasSendDirective = typeof response === 'string' && response.includes('<send>');

  const normalizeMentionIds = (ids) => {
    if (!Array.isArray(ids)) return [];
    const out = [];
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

  const defaultRoute = (parsed && parsed.group_id)
    ? { kind: 'group', id: String(parsed.group_id) }
    : ((parsed && parsed.user_id) ? { kind: 'private', id: String(parsed.user_id) } : null);

  const crossCfg = _getCrossChatSendConfig();
  const maxMediaPartsPerMessage = Math.max(1, Number(_getCfg().maxMediaPartsPerMessage || 8));

  const _splitBatches = (arr, maxSize) => {
    const out = [];
    const max = Math.max(1, Number(maxSize || 1));
    if (!Array.isArray(arr) || arr.length === 0) return out;
    for (let i = 0; i < arr.length; i += max) out.push(arr.slice(i, i + max));
    return out;
  };
  
  logger.debug(`文本段落数: ${textSegments.length}`);
  logger.debug(`协议资源数: ${protocolResources.length}`);
  if (emoji) {
    logger.debug(`表情包: ${emoji.source}`);
  }
  
  // 只从AI的resources中提取文件（支持本地路径和 HTTP/HTTPS 链接）
  const protocolFiles = [];
  const linkSegments = [];
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

      if (isHttpUrl) {
        const urlPath = source.split('?')[0];
        const t = String(res?.type || '').trim().toLowerCase();
        const isLinkType = t === 'link' || t === 'url';

        if (isLinkType) {
          const cap = (typeof res?.caption === 'string' && res.caption.trim()) ? `${res.caption.trim()}\n` : '';
          linkSegments.push({
            text: `${cap}${source}`,
            routeTarget,
            segmentIndex: segmentIndexOk ? segmentIndex : null
          });
          logger.debug(`HTTP link 资源将作为文本发送: ${source}`);
          return;
        }

        const inferredMime = mimeTypes.lookup(urlPath);
        let mime = typeof inferredMime === 'string' ? inferredMime : '';
        const isHtml = mime === 'text/html';
        if (!mime || isHtml) {
          const probed = await _probeHttpMime(source);
          if (probed) mime = probed;
        }

        if (!mime || mime === 'text/html') {
          logger.warn(`HTTP 资源无法推断有效文件 MIME，已跳过: ${source}`, { mime: mime || '(unknown)' });
          return;
        }

        try {
          res._resolvedMime = mime;
        } catch {}
      }
      
      // 本地文件：检查是否存在
      if (!isHttpUrl && (!resolvedLocalPath || !fs.existsSync(resolvedLocalPath))) {
        logger.warn(`协议资源文件不存在: ${source}`, {
          resolvedLocalPath: resolvedLocalPath || '(empty)'
        });
        return;
      }
      
      // 提取文件扩展名（支持 URL 中的扩展名）
      let ext = '';
      if (isHttpUrl) {
        // 从 URL 中提取扩展名（去除查询参数）
        const urlPath = source.split('?')[0];
        ext = path.extname(urlPath).toLowerCase();
      } else {
        ext = path.extname(resolvedLocalPath || source).toLowerCase();
      }

      if (isHttpUrl && !ext) {
        const m = String(res?._resolvedMime || '').trim();
        const guessed = _extFromMime(m);
        if (guessed) ext = guessed;
      }
      
      // 根据扩展名判断文件类型
      let fileType = 'file';
      {
        const inferredMime = String(res?._resolvedMime || '') || mimeTypes.lookup(isHttpUrl ? (source.split('?')[0]) : (resolvedLocalPath || source));
        const mime = typeof inferredMime === 'string' ? inferredMime : '';
        if (mime.startsWith('image/')) fileType = 'image';
        else if (mime.startsWith('video/')) fileType = 'video';
        else if (mime.startsWith('audio/')) fileType = 'record';
      }
      
      // 提取文件名
      let fileName = '';
      if (isHttpUrl) {
        // 从 URL 中提取文件名
        const urlPath = source.split('?')[0];
        fileName = path.basename(urlPath) || 'download' + ext;
        if (ext && fileName && !fileName.toLowerCase().endsWith(ext)) {
          fileName = `${fileName}${ext}`;
        }
      } else {
        fileName = path.basename(resolvedLocalPath || source);
      }
      
      protocolFiles.push({
        path: isHttpUrl ? source : (resolvedLocalPath || source),
        fileName: fileName,
        fileType,
        caption: res.caption,
        isHttpUrl,  // 标记是否为 HTTP 链接
        routeTarget,
        segmentIndex: segmentIndexOk ? segmentIndex : null
      });
      
      if (isHttpUrl) {
        logger.debug(`添加 HTTP 资源: ${fileType} ${fileName} (${source})`);
      } else {
        logger.debug(`添加本地文件: ${fileType} ${fileName}`);
      }
    }
  }
  
  // 解析文本段落
  const segments = parseTextSegments(textSegments)
    .map((seg) => {
      const extracted = _extractRoutePrefix(seg?.text || '');
      const routeTarget = _resolveRouteTargetWithDefault(msg, extracted, defaultRoute);
      return {
        text: extracted.rest,
        routeTarget
      };
    })
    .filter((seg) => seg && typeof seg.text === 'string' && seg.text.trim());
  const linkSendPlans = [];
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

  const attachedFilesBySegAndTarget = new Map();
  const attachedLinksBySegAndTarget = new Map();
  const deferredProtocolFiles = [];
  for (const f of protocolFiles) {
    const rt = f?.routeTarget || _resolveRouteTarget(msg, { kind: 'current', id: '' });
    const segIdx = Number(f?.segmentIndex || 0);
    if (segIdx > 0 && segments.length > 0 && segIdx <= segments.length) {
      const k = `${segIdx}|${rt.kind}:${rt.id}`;
      if (!attachedFilesBySegAndTarget.has(k)) attachedFilesBySegAndTarget.set(k, []);
      attachedFilesBySegAndTarget.get(k).push(f);
    } else {
      deferredProtocolFiles.push(f);
    }
  }
  for (const l of linkSendPlans) {
    const rt = l?.routeTarget || _resolveRouteTarget(msg, { kind: 'current', id: '' });
    const segIdx = Number(l?.segmentIndex || 0);
    if (segIdx > 0 && segments.length > 0 && segIdx <= segments.length) {
      const k = `${segIdx}|${rt.kind}:${rt.id}`;
      if (!attachedLinksBySegAndTarget.has(k)) attachedLinksBySegAndTarget.set(k, []);
      attachedLinksBySegAndTarget.get(k).push(l);
    } else {
      segments.push({ text: l.text, routeTarget: rt });
    }
  }
  
  // 发送文本段落
  if (segments.length > 0) {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
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

      let messageParts = buildSegmentMessage(segment);
      
      if (messageParts.length === 0) continue;
      
      logger.debug(`发送第${i+1}段: ${messageParts.map(p => p.type).join(', ')}`);
      
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
        const atParts = segMentions.map(qq => ({ type: 'at', data: { qq } }));
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
          const result = await sendAndWaitResult({
            type: "sdk",
            path: "send.privateReply",
            args: [Number(routeTarget.id), replyMessageId, messageParts],
            requestId: `private-reply-${Date.now()}-${i}`
          });
          sentMessageId = result?.data?.message_id;
        } else if (isGroupTarget) {
          const result = await sendAndWaitResult({
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
          const result = await sendAndWaitResult({
            type: "sdk",
            path: "send.private",
            args: [Number(routeTarget.id), messageParts],
            requestId: `private-${Date.now()}-${i}`
          });
          sentMessageId = result?.data?.message_id;
        } else if (isGroupTarget) {
          const result = await sendAndWaitResult({
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
        logger.debug(`第${i+1}段发送成功，消息ID: ${sentMessageId}`);
      }

      const segKey = `${i + 1}|${routeTarget.kind}:${routeTarget.id}`;
      const attachedLinks = attachedLinksBySegAndTarget.get(segKey) || [];
      const attachedFiles = attachedFilesBySegAndTarget.get(segKey) || [];

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
          const parts = buildSegmentMessage({ text: addonText });
          if (parts.length === 0) continue;
          if (routeTarget.kind === 'private') {
            const result = await sendAndWaitResult({
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
            const result = await sendAndWaitResult({
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

        const mediaParts = [];
        const normalFiles = [];
        for (const file of attachedFiles) {
          if (['image', 'video', 'record'].includes(file.fileType)) {
            if (file.fileType === 'image') mediaParts.push({ type: 'image', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
            else if (file.fileType === 'video') mediaParts.push({ type: 'video', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
            else if (file.fileType === 'record') mediaParts.push({ type: 'record', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
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
          for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            const useReply = shouldReplyForMedia && !usedReply;
            const requestId = `${routeTarget.kind}-segmedia-${Date.now()}-${i}-${bi}`;
            let normalizedParts = _withNormalizedFileField(batch);
            let result = await sendAndWaitResult({
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
                result = await sendAndWaitResult({
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
            let result = await sendAndWaitResult({
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
                result = await sendAndWaitResult({
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

              const emojiMessageParts = [
                { type: 'image', data: { file: _toFileUrlIfLikelyLocal(emojiPath) } }
              ];

              if (rt.kind === 'private') {
                const requestId = `private-emoji-${Date.now()}`;
                let normalizedParts = _withNormalizedFileField(emojiMessageParts);
                let result = await sendAndWaitResult({
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
                    result = await sendAndWaitResult({
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
                let result = await sendAndWaitResult({
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
                    result = await sendAndWaitResult({
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
  const mediaFiles = deferredProtocolFiles.filter(f => ['image', 'video', 'record'].includes(f.fileType));
  const uploadFiles = deferredProtocolFiles.filter(f => f.fileType === 'file');
  
  logger.debug(`媒体文件: ${mediaFiles.length}个, 普通文件: ${uploadFiles.length}个`);
  
  // 发送媒体文件（图片、视频、语音）
  if (mediaFiles.length > 0) {
    if (segments.length > 0) {
      const delay = 800 + Math.random() * 800;
      logger.debug(`等待 ${Math.round(delay)}ms 后发送媒体`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    const grouped = new Map();
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
      const key = `${rt.kind}:${rt.id}`;
      if (!grouped.has(key)) grouped.set(key, { routeTarget: rt, files: [] });
      grouped.get(key).files.push(file);
    }

    for (const group of grouped.values()) {
      const rt = group.routeTarget;
      const mediaMessageParts = [];
      group.files.forEach(file => {
        logger.debug(`添加媒体: ${file.fileType} - ${file.fileName}`);
        if (file.fileType === 'image') {
          mediaMessageParts.push({ type: 'image', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
        } else if (file.fileType === 'video') {
          mediaMessageParts.push({ type: 'video', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
        } else if (file.fileType === 'record') {
          mediaMessageParts.push({ type: 'record', data: { file: _toFileUrlIfLikelyLocal(file.path) } });
        }
      });

      if (mediaMessageParts.length === 0) continue;

      if (segments.length === 0 && hasSendDirective && rt.isCurrent && rt.kind === 'group') {
        const ids = mentionsBySegment && typeof mentionsBySegment === 'object' ? mentionsBySegment['1'] : null;
        const segMentions = normalizeMentionIds(ids);
        if (segMentions.length > 0) {
          const atParts = segMentions.map(qq => ({ type: 'at', data: { qq } }));
          mediaMessageParts.unshift(...atParts);
        }
      }

      const replyForMedia = rt.isCurrent && replyMessageId && allowReply && (
        finalReplyMode === 'always' || (finalReplyMode === 'first' && !usedReply)
      );

      const prefixParts = [];
      const mediaOnlyParts = [...mediaMessageParts];
      while (mediaOnlyParts.length > 0 && mediaOnlyParts[0] && mediaOnlyParts[0].type === 'at') {
        prefixParts.push(mediaOnlyParts.shift());
      }
      const mediaBatches = _splitBatches(mediaOnlyParts, maxMediaPartsPerMessage);

      for (let bi = 0; bi < mediaBatches.length; bi++) {
        const batch = mediaBatches[bi];
        if (!Array.isArray(batch) || batch.length === 0) continue;
        const useReply = replyForMedia && !usedReply;
        const requestId = `${rt.kind}-media-${Date.now()}-${bi}`;
        const parts = (bi === 0 && prefixParts.length > 0) ? [...prefixParts, ...batch] : batch;
        let normalizedParts = _withNormalizedFileField(parts);
        let result = await sendAndWaitResult({
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
            result = await sendAndWaitResult({
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
        let result = await sendAndWaitResult({
          type: "sdk",
          path: "file.uploadPrivate",
          args: [Number(rt.id), fileField, file.fileName],
          requestId
        });

        if (result && _isAdapterSendFailed(result)) {
          const b64 = _readBase64FileIfAllowed(fileField);
          if (b64) {
            result = await sendAndWaitResult({
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
        let result = await sendAndWaitResult({
          type: "sdk",
          path: "file.uploadGroup",
          args: [Number(rt.id), fileField, file.fileName, ""],
          requestId
        });

        if (result && _isAdapterSendFailed(result)) {
          const b64 = _readBase64FileIfAllowed(fileField);
          if (b64) {
            result = await sendAndWaitResult({
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
      const emojiMessageParts = [
        { type: 'image', data: { file: _toFileUrlIfLikelyLocal(emojiPath) } }
      ];
      
      logger.debug('发送表情包作为图片消息');
      
      if (rt.kind === 'private') {
        const requestId = `private-emoji-${Date.now()}`;
        let normalizedParts = _withNormalizedFileField(emojiMessageParts);
        let result = await sendAndWaitResult({
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
            result = await sendAndWaitResult({
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
        let result = await sendAndWaitResult({
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
            result = await sendAndWaitResult({
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
export async function smartSend(msg, response, sendAndWaitResult, allowReply = true, options = {}) {
  const groupId = msg?.group_id ? `G:${msg.group_id}` : `U:${msg.sender_id}`;
  const taskId = `${groupId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  
  // 预解析一次用于去重的文本和资源信息
  let textForDedup = '';
  let resourceKeys = [];
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
  const meta = {
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