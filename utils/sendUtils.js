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

const logger = createLogger('SendUtils');

/**
 * 智能发送消息（完全拟人化，只从AI的resources中提取文件）
 * @param {Object} msg - 消息对象
 * @param {string} response - AI响应内容
 * @param {Function} sendAndWaitResult - 发送函数
 * @param {boolean} allowReply - 是否允许引用回复（默认true），同一任务中只有第一次发送应设置为true
 */
export async function smartSend(msg, response, sendAndWaitResult, allowReply = true) {
  const parsed = parseSentraResponse(response);
  const textSegments = parsed.textSegments || [response];
  const protocolResources = parsed.resources || [];
  const emoji = parsed.emoji || null;
  
  logger.debug(`文本段落数: ${textSegments.length}`);
  logger.debug(`协议资源数: ${protocolResources.length}`);
  if (emoji) {
    logger.debug(`表情包: ${emoji.source}`);
  }
  
  // 只从AI的resources中提取文件（支持本地路径和 HTTP/HTTPS 链接）
  const protocolFiles = [];
  protocolResources.forEach(res => {
    logger.debug(`处理协议资源: ${res.type} ${res.source}`);
    if (res.source) {
      const isHttpUrl = /^https?:\/\//i.test(res.source);
      
      // 本地文件：检查是否存在
      if (!isHttpUrl && !fs.existsSync(res.source)) {
        logger.warn(`协议资源文件不存在: ${res.source}`);
        return;
      }
      
      // 提取文件扩展名（支持 URL 中的扩展名）
      let ext = '';
      if (isHttpUrl) {
        // 从 URL 中提取扩展名（去除查询参数）
        const urlPath = res.source.split('?')[0];
        ext = path.extname(urlPath).toLowerCase();
      } else {
        ext = path.extname(res.source).toLowerCase();
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
        const urlPath = res.source.split('?')[0];
        fileName = path.basename(urlPath) || 'download' + ext;
      } else {
        fileName = path.basename(res.source);
      }
      
      protocolFiles.push({
        path: res.source,
        fileName: fileName,
        fileType,
        caption: res.caption,
        isHttpUrl  // 标记是否为 HTTP 链接
      });
      
      if (isHttpUrl) {
        logger.debug(`添加 HTTP 资源: ${fileType} ${fileName} (${res.source})`);
      } else {
        logger.debug(`添加本地文件: ${fileType} ${fileName}`);
      }
    }
  });
  
  // 解析文本段落
  const segments = parseTextSegments(textSegments);
  
  //logger.debug(`文本段落数: ${segments.length}`);
  //logger.debug(`资源文件数: ${protocolFiles.length}`);
  segments.forEach((seg, i) => {
    //logger.debug(`  段落${i+1}: "${seg.text.slice(0, 60)}${seg.text.length > 60 ? '...' : ''}"`);
  });
  protocolFiles.forEach((f, i) => {
    //logger.debug(`  文件${i+1}: ${f.fileName} (${f.fileType})`);
  });
  
  if (segments.length === 0 && protocolFiles.length === 0) {
    logger.warn('无内容可发送');
    return;
  }
  
  // 更新用户消息历史
  updateConversationHistory(msg);
  
  // 决定发送策略
  const isPrivateChat = msg.type === 'private';
  const isGroupChat = msg.type === 'group';
  
  // 群聊专属策略
  const shouldAt = isGroupChat && Math.random() > 0.75; // 25%概率@用户
  
  // 回复策略：多段落时第一段有概率回复，单段落时随机回复
  const replyProbability = segments.length > 1 ? 0.6 : 0.5;
  const shouldReplyFirst = allowReply && (Math.random() < replyProbability);  // 只有 allowReply=true 时才可能引用
  
  // 获取要引用的消息ID
  const replyMessageId = shouldReplyFirst ? getReplyableMessageId(msg) : null;
  
  logger.debug(`发送策略: ${segments.length}段分别发送, At用户: ${shouldAt}, 允许引用: ${allowReply}, 回复消息: ${shouldReplyFirst}, 引用ID: ${replyMessageId}`);
  
  // 发送文本段落
  if (segments.length > 0) {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      let messageParts = buildSegmentMessage(segment);
      
      if (messageParts.length === 0) continue;
      
      logger.debug(`发送第${i+1}段: ${messageParts.map(p => p.type).join(', ')}`);
      
      // 第一段可能需要@用户（仅群聊）
      if (i === 0 && shouldAt && isGroupChat) {
        messageParts = [
          { type: 'at', data: { qq: msg.sender_id } },
          { type: 'text', data: { text: ' ' } },
          ...messageParts
        ];
      }
      
      let sentMessageId = null;
      
      // 第一段可能使用回复
      if (i === 0 && shouldReplyFirst && replyMessageId) {
        if (isPrivateChat) {
          const result = await sendAndWaitResult({
            type: "sdk",
            path: "send.privateReply",
            args: [msg.sender_id, replyMessageId, messageParts],
            requestId: `private-reply-${Date.now()}-${i}`
          });
          sentMessageId = result?.data?.message_id;
        } else if (isGroupChat) {
          const result = await sendAndWaitResult({
            type: "sdk",
            path: "send.groupReply",
            args: [msg.group_id, replyMessageId, messageParts],
            requestId: `group-reply-${Date.now()}-${i}`
          });
          sentMessageId = result?.data?.message_id;
        }
      } else {
        // 普通发送
        if (isPrivateChat) {
          const result = await sendAndWaitResult({
            type: "sdk",
            path: "send.private",
            args: [msg.sender_id, messageParts],
            requestId: `private-${Date.now()}-${i}`
          });
          sentMessageId = result?.data?.message_id;
        } else if (isGroupChat) {
          const result = await sendAndWaitResult({
            type: "sdk",
            path: "send.group",
            args: [msg.group_id, messageParts],
            requestId: `group-${Date.now()}-${i}`
          });
          sentMessageId = result?.data?.message_id;
        }
      }
      
      // 更新消息历史
      if (sentMessageId) {
        updateConversationHistory(msg, sentMessageId, true);
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
    
    const mediaMessageParts = [];
    mediaFiles.forEach(file => {
      logger.debug(`添加媒体: ${file.fileType} - ${file.fileName}`);
      if (file.fileType === 'image') {
        mediaMessageParts.push({ type: 'image', data: { file: file.path } });
      } else if (file.fileType === 'video') {
        mediaMessageParts.push({ type: 'video', data: { file: file.path } });
      } else if (file.fileType === 'record') {
        mediaMessageParts.push({ type: 'record', data: { file: file.path } });
      }
    });
    
    if (mediaMessageParts.length > 0) {
      if (isPrivateChat) {
        const result = await sendAndWaitResult({
          type: "sdk",
          path: "send.private",
          args: [msg.sender_id, mediaMessageParts],
          requestId: `private-media-${Date.now()}`
        });
        logger.debug(`媒体发送结果: ${result?.ok ? 'OK' : 'FAIL'}`);
      } else if (isGroupChat) {
        const result = await sendAndWaitResult({
          type: "sdk",
          path: "send.group",
          args: [msg.group_id, mediaMessageParts],
          requestId: `group-media-${Date.now()}`
        });
        logger.debug(`媒体发送结果: ${result?.ok ? 'OK' : 'FAIL'}`);
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
      
      if (isPrivateChat) {
        await sendAndWaitResult({
          type: "sdk",
          path: "file.uploadPrivate",
          args: [msg.sender_id, file.path, file.fileName],
          requestId: `file-upload-private-${Date.now()}`
        });
      } else if (isGroupChat) {
        await sendAndWaitResult({
          type: "sdk",
          path: "file.uploadGroup",
          args: [msg.group_id, file.path, file.fileName, ""],
          requestId: `file-upload-group-${Date.now()}`
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  
  // 发送表情包（如果有）
  if (emoji && emoji.source) {
    logger.debug(`准备发送表情包: ${emoji.source}`);
    
    // 验证文件存在性
    if (!fs.existsSync(emoji.source)) {
      logger.warn(`表情包文件不存在: ${emoji.source}`);
    } else {
      // 等待一小段时间
      const delay = (textSegments.length > 0 || protocolFiles.length > 0) ? (600 + Math.random() * 800) : 0;
      if (delay > 0) {
        logger.debug(`等待 ${Math.round(delay)}ms 后发送表情包`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      // 构建图片消息
      const emojiMessageParts = [
        { type: 'image', data: { file: emoji.source } }
      ];
      
      logger.debug('发送表情包作为图片消息');
      
      if (isPrivateChat) {
        const result = await sendAndWaitResult({
          type: "sdk",
          path: "send.private",
          args: [msg.sender_id, emojiMessageParts],
          requestId: `private-emoji-${Date.now()}`
        });
        logger.debug(`表情包发送结果: ${result?.ok ? 'OK' : 'FAIL'}`);
      } else if (isGroupChat) {
        const result = await sendAndWaitResult({
          type: "sdk",
          path: "send.group",
          args: [msg.group_id, emojiMessageParts],
          requestId: `group-emoji-${Date.now()}`
        });
        logger.debug(`表情包发送结果: ${result?.ok ? 'OK' : 'FAIL'}`);
      }
    }
  }
  
  logger.success('发送完成');
}