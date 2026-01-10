/**
 * 消息发送工具模块
 * 包含智能发送、文件处理、消息分段发送等功能
 */

import fs from 'fs';
import path from 'path';
import { parseSentraResponse } from './protocolUtils.js';
import { parseTextSegments, buildSegmentMessage } from './messageUtils.js';
import { getReplyableMessageId, updateConversationHistory } from './conversationUtils.js';
import { createLogger } from './logger.js';
import { replySendQueue } from './replySendQueue.js';
import { getEnv, getEnvBool, getEnvInt } from './envHotReloader.js';
import { randomUUID } from 'crypto';

const logger = createLogger('SendUtils');

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
  return {
    enabled: getEnvBool('CROSS_CHAT_SEND_ENABLED', true),
    allowedGroupIds: _parseCsvIdSet(getEnv('CROSS_CHAT_SEND_ALLOW_GROUP_IDS', '')),
    allowedUserIds: _parseCsvIdSet(getEnv('CROSS_CHAT_SEND_ALLOW_USER_IDS', '')),
    allowedSenderIds: _parseCsvIdSet(getEnv('CROSS_CHAT_SEND_ALLOW_SENDER_IDS', '')),
    requireTargetIdInUserText: getEnvBool('CROSS_CHAT_SEND_REQUIRE_TARGET_IN_USER_TEXT', false),
    maxCrossOpsPerResponse: getEnvInt('CROSS_CHAT_SEND_MAX_OPS_PER_RESPONSE', 6)
  };
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
  const mentions = Array.isArray(parsed.mentions) ? parsed.mentions : [];
  const hasSendDirective = typeof response === 'string' && response.includes('<send>');

  const defaultRoute = (parsed && parsed.group_id)
    ? { kind: 'group', id: String(parsed.group_id) }
    : ((parsed && parsed.user_id) ? { kind: 'private', id: String(parsed.user_id) } : null);

  const crossCfg = _getCrossChatSendConfig();
  
  logger.debug(`文本段落数: ${textSegments.length}`);
  logger.debug(`协议资源数: ${protocolResources.length}`);
  if (emoji) {
    logger.debug(`表情包: ${emoji.source}`);
  }
  
  // 只从AI的resources中提取文件（支持本地路径和 HTTP/HTTPS 链接）
  const protocolFiles = [];
  protocolResources.forEach(res => {
    const parsedRoute = _extractRoutePrefix(String(res.source || ''));
    const routeTarget = _resolveRouteTargetWithDefault(msg, parsedRoute, defaultRoute);
    const source = parsedRoute.rest;

    logger.debug(`处理协议资源: ${res.type} ${source}`);
    if (source) {
      const isHttpUrl = /^https?:\/\//i.test(source);
      
      // 本地文件：检查是否存在
      if (!isHttpUrl && !fs.existsSync(source)) {
        logger.warn(`协议资源文件不存在: ${source}`);
        return;
      }
      
      // 提取文件扩展名（支持 URL 中的扩展名）
      let ext = '';
      if (isHttpUrl) {
        // 从 URL 中提取扩展名（去除查询参数）
        const urlPath = source.split('?')[0];
        ext = path.extname(urlPath).toLowerCase();
      } else {
        ext = path.extname(source).toLowerCase();
      }
      
      // 根据扩展名判断文件类型
      let fileType = 'file';
      if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'].includes(ext)) fileType = 'image';
      else if (['.mp4', '.avi', '.mov', '.mkv', '.flv', '.wmv', '.webm'].includes(ext)) fileType = 'video';
      else if (['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'].includes(ext)) fileType = 'record';
      
      // 提取文件名
      let fileName = '';
      if (isHttpUrl) {
        // 从 URL 中提取文件名
        const urlPath = source.split('?')[0];
        fileName = path.basename(urlPath) || 'download' + ext;
      } else {
        fileName = path.basename(source);
      }
      
      protocolFiles.push({
        path: source,
        fileName: fileName,
        fileType,
        caption: res.caption,
        isHttpUrl,  // 标记是否为 HTTP 链接
        routeTarget
      });
      
      if (isHttpUrl) {
        logger.debug(`添加 HTTP 资源: ${fileType} ${fileName} (${source})`);
      } else {
        logger.debug(`添加本地文件: ${fileType} ${fileName}`);
      }
    }
  });
  
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
  const mentionsToUse = hasSendDirective ? mentions : [];
  
  // 获取要引用的消息ID（仅当允许引用时）
  const replyMessageId = allowReply ? await getReplyableMessageId(msg) : null;
  let usedReply = false;
  
  logger.debug(`发送策略: 段落=${segments.length}, replyMode=${finalReplyMode}(${hasSendDirective ? 'by_send' : 'fallback'}), mentions=[${mentionsToUse.join(',')}], allowReply=${allowReply}, replyId=${replyMessageId}`);

  let usedMentions = false;
  let skippedCrossRouteCount = 0;
  let crossOps = 0;
  
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
      if (!usedMentions && routeTarget.isCurrent && isGroupTarget && mentionsToUse.length > 0) {
        const atParts = mentionsToUse.map(mid => {
          const raw = String(mid).trim();
          const qq = (raw.toLowerCase && (raw.toLowerCase() === 'all' || raw.toLowerCase() === '@all')) ? 'all' : raw;
        
          return { type: 'at', data: { qq } };
        });
        messageParts = [
          ...atParts,
          { type: 'text', data: { text: ' ' } },
          ...messageParts
        ];
        usedMentions = true;
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
      
      if (i < segments.length - 1) {
        const delay = 800 + Math.random() * 2200; // 0.8-3秒随机间隔
        logger.debug(`等待 ${Math.round(delay)}ms 后发送下一段`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // 分类文件：媒体文件 vs 普通文件
  const mediaFiles = protocolFiles.filter(f => ['image', 'video', 'record'].includes(f.fileType));
  const uploadFiles = protocolFiles.filter(f => f.fileType === 'file');
  
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
          mediaMessageParts.push({ type: 'image', data: { file: file.path } });
        } else if (file.fileType === 'video') {
          mediaMessageParts.push({ type: 'video', data: { file: file.path } });
        } else if (file.fileType === 'record') {
          mediaMessageParts.push({ type: 'record', data: { file: file.path } });
        }
      });

      if (mediaMessageParts.length === 0) continue;

      if (segments.length === 0 && rt.isCurrent && rt.kind === 'group' && mentionsToUse.length > 0) {
        const atParts = mentionsToUse.map(mid => {
          const raw = String(mid).trim();
          const qq = (raw.toLowerCase && (raw.toLowerCase() === 'all' || raw.toLowerCase() === '@all')) ? 'all' : raw;
          return { type: 'at', data: { qq } };
        });
        mediaMessageParts.unshift(...atParts);
      }

      const replyForMedia = rt.isCurrent && replyMessageId && allowReply && (
        finalReplyMode === 'always' || (finalReplyMode === 'first' && !usedReply)
      );

      if (rt.kind === 'private') {
        const requestId = `private-media-${Date.now()}`;
        const result = await sendAndWaitResult({
          type: "sdk",
          path: replyForMedia ? "send.privateReply" : "send.private",
          args: replyForMedia ? [Number(rt.id), replyMessageId, mediaMessageParts] : [Number(rt.id), mediaMessageParts],
          requestId
        });
        logger.debug('媒体发送结果', {
          ok: !!result?.ok,
          requestId,
          target: { kind: rt.kind, id: String(rt.id), isCurrent: !!rt.isCurrent },
          message_id: result?.data?.message_id,
          data: result?.data
        });
      } else if (rt.kind === 'group') {
        const requestId = `group-media-${Date.now()}`;
        const result = await sendAndWaitResult({
          type: "sdk",
          path: replyForMedia ? "send.groupReply" : "send.group",
          args: replyForMedia ? [Number(rt.id), replyMessageId, mediaMessageParts] : [Number(rt.id), mediaMessageParts],
          requestId
        });
        logger.debug('媒体发送结果', {
          ok: !!result?.ok,
          requestId,
          target: { kind: rt.kind, id: String(rt.id), isCurrent: !!rt.isCurrent },
          message_id: result?.data?.message_id,
          data: result?.data
        });
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
        await sendAndWaitResult({
          type: "sdk",
          path: "file.uploadPrivate",
          args: [Number(rt.id), file.path, file.fileName],
          requestId: `file-upload-private-${Date.now()}`
        });
      } else if (rt.kind === 'group') {
        await sendAndWaitResult({
          type: "sdk",
          path: "file.uploadGroup",
          args: [Number(rt.id), file.path, file.fileName, ""],
          requestId: `file-upload-group-${Date.now()}`
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  
  // 发送表情包（如果有）
  if (emoji && emoji.source) {
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
        { type: 'image', data: { file: emojiPath } }
      ];
      
      logger.debug('发送表情包作为图片消息');
      
      if (rt.kind === 'private') {
        const requestId = `private-emoji-${Date.now()}`;
        const result = await sendAndWaitResult({
          type: "sdk",
          path: "send.private",
          args: [Number(rt.id), emojiMessageParts],
          requestId
        });
        logger.debug('表情包发送结果', {
          ok: !!result?.ok,
          requestId,
          target: { kind: rt.kind, id: String(rt.id), isCurrent: !!rt.isCurrent },
          message_id: result?.data?.message_id,
          data: result?.data
        });
      } else if (rt.kind === 'group') {
        const requestId = `group-emoji-${Date.now()}`;
        const result = await sendAndWaitResult({
          type: "sdk",
          path: "send.group",
          args: [Number(rt.id), emojiMessageParts],
          requestId
        });
        logger.debug('表情包发送结果', {
          ok: !!result?.ok,
          requestId,
          target: { kind: rt.kind, id: String(rt.id), isCurrent: !!rt.isCurrent },
          message_id: result?.data?.message_id,
          data: result?.data
        });
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

  return replySendQueue.enqueue(async () => {
    return await _smartSendInternal(msg, meta.response, sendAndWaitResult, !!meta.allowReply);
  }, taskId, meta);
}