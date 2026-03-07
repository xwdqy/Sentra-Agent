import logger from '../../src/logger/index.js';
import wsCall from '../../src/utils/ws_rpc.js';
import { getIdsWithCache } from '../../src/utils/message_cache_helper.js';
import { ok, fail } from '../../src/utils/result.js';

/**
 * 流式请求 OpenAI 格式的 API
 * @param {Object} config - 请求配置
 * @param {string} config.apiBaseUrl - API 基础 URL
 * @param {string} config.apiKey - API 密钥
 * @param {string} config.model - 模型名称
 * @param {Array} config.messages - 消息数组
 * @param {number} config.timeoutMs - 超时时间
 * @param {Function} onChunk - 接收到数据块时的回调
 * @returns {Promise<string>} 完整响应文本
 */
async function streamChatCompletion({ apiBaseUrl, apiKey, model, messages, timeoutMs = 300000 }, onChunk) {
  const url = `${apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.7
      }),
      signal: controller.signal
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        
        try {
          const data = JSON.parse(trimmed.slice(6));
          const content = data?.choices?.[0]?.delta?.content;
          if (content) {
            fullText += content;
            if (onChunk) onChunk(content);
          }
        } catch (e) {
          logger.warn?.('suno_music_generate:parse_chunk_error', { 
            label: 'PLUGIN', 
            line: trimmed.slice(0, 100),
            error: String(e)
          });
        }
      }
    }
    
    clearTimeout(timeout);
    return fullText;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

/**
 * 从 Markdown 文本中提取音频链接
 * @param {string} text - Markdown 文本
 * @returns {Array<Object>} 音频信息数组 [{ url, title }]
 */
function extractAudioLinks(text) {
  const audioLinks = [];
  let match;
  
  // 1. 优先匹配带扩展名的 Markdown 链接：[title](url.mp3)
  const audioExtRegex = /!?\[([^\]]*)\]\(([^)]+\.(mp3|wav|m4a|ogg|flac|aac|wma|webm))\)/gi;
  while ((match = audioExtRegex.exec(text)) !== null) {
    audioLinks.push({
      title: match[1] || '生成的音乐',
      url: match[2]
    });
  }
  
  // 2. 如果没有找到，匹配所有 Markdown 链接格式（不限扩展名）
  if (audioLinks.length === 0) {
    const anyMarkdownRegex = /!?\[([^\]]*)\]\((https?:\/\/[^)]+)\)/gi;
    while ((match = anyMarkdownRegex.exec(text)) !== null) {
      audioLinks.push({
        title: match[1] || '生成的音乐',
        url: match[2]
      });
    }
  }
  
  // 3. 如果还没有找到，直接匹配 http/https URL
  if (audioLinks.length === 0) {
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
    while ((match = urlRegex.exec(text)) !== null) {
      audioLinks.push({
        title: '生成的音乐',
        url: match[0]
      });
    }
  }
  
  return audioLinks;
}

/**
 * 构建自定义音乐卡片 segments
 */
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

/**
 * 通过 WebSocket 发送音乐卡片
 */
async function sendMusicCardViaWS({ wsUrl, timeoutMs, pathList, argStyle }, target, segments) {
  const { user_id, group_id } = target;
  const filteredTarget = user_id ? { user_id } : { group_id };
  const requestIdBase = `suno-music-${(user_id ? 'private' : 'group')}-${Date.now()}`;

  for (const path of pathList) {
    const requestId = `${path}-${requestIdBase}`;
    const args = (argStyle === 'pair')
      ? (user_id ? [Number(user_id), segments] : [Number(group_id), segments])
      : [{ ...filteredTarget, message: segments }];
    
    try {
      const resp = await wsCall({ url: wsUrl, path, args, requestId, timeoutMs });
      return { ok: true, path, args, resp };
    } catch (e) {
      logger.warn?.('suno_music_generate:ws_send_failed', { 
        label: 'PLUGIN', 
        path, 
        error: String(e?.message || e) 
      });
    }
  }
  
  return { ok: false };
}

/**
 * Suno 音乐生成插件处理函数
 */
async function legacyHandler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  
  // 参数验证
  const title = String(args.title || '').trim();
  const tags = String(args.tags || '').trim();
  const lyrics = String(args.lyrics || '').trim();
  
  if (!title) {
    return { success: false, code: 'INVALID_TITLE', error: 'title 为必填参数' };
  }
  
  if (!tags) {
    return { success: false, code: 'INVALID_TAGS', error: 'tags 为必填参数，需要提供音乐风格标签' };
  }
  
  if (!lyrics) {
    return { success: false, code: 'INVALID_LYRICS', error: 'lyrics 为必填参数，需要提供歌词内容' };
  }
  
  // 从参数或缓存中获取 ID（优先参数，其次缓存）
  const { user_id, group_id, source } = await getIdsWithCache(args, options, 'suno_music_generate');
  
  logger.info?.('suno_music_generate:ids_resolved', { 
    label: 'PLUGIN', 
    user_id, 
    group_id, 
    source 
  });
  
  // 配置读取
  const apiBaseUrl = String(penv.SUNO_API_BASE_URL || process.env.SUNO_API_BASE_URL || 'https://yuanplus.chat/v1');
  const apiKey = String(penv.SUNO_API_KEY || process.env.SUNO_API_KEY || '');
  const model = String(penv.SUNO_MODEL || process.env.SUNO_MODEL || 'suno-v3.5');
  const timeoutMs = Number(penv.SUNO_TIMEOUT_MS || process.env.SUNO_TIMEOUT_MS || 300000);
  const coverUrl = String(penv.SUNO_DEFAULT_COVER_URL || process.env.SUNO_DEFAULT_COVER_URL || 'https://filesystem.site/cdn/20251003/lSl1Vi7WNkZzBm6lNJ3LxvxkaHJ77M.png');
  
  if (!apiKey) {
    return { success: false, code: 'MISSING_API_KEY', error: 'SUNO_API_KEY 未配置' };
  }
  
  // WebSocket 配置
  const wsUrl = String(penv.WS_SDK_URL || process.env.WS_SDK_URL || 'ws://127.0.0.1:6702');
  const wsSendTimeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || process.env.WS_SDK_TIMEOUT_MS || 15000));
  const argStyle = String(penv.WS_SDK_ARG_STYLE || process.env.WS_SDK_ARG_STYLE || 'pair');
  const pathMain = String(penv.WS_SDK_SEND_PATH || process.env.WS_SDK_SEND_PATH || '').trim();
  const pathPri = String(penv.WS_SDK_SEND_PATH_PRIVATE || process.env.WS_SDK_SEND_PATH_PRIVATE || 'send.private');
  const pathGrp = String(penv.WS_SDK_SEND_PATH_GROUP || process.env.WS_SDK_SEND_PATH_GROUP || 'send.group');
  
  try {
    logger.info?.('suno_music_generate:start', { 
      label: 'PLUGIN',
      title: title.slice(0, 50),
      tags: tags.slice(0, 100),
      lyricsLength: lyrics.length,
      target: user_id ? 'private' : 'group',
      targetId: user_id || group_id
    });

    // 构建提示词
    const prompt = `${title}:${tags}:${lyrics}`;

    const messages = [
      {
        role: 'user',
        content: prompt
      }
    ];
    
    logger.info?.('suno_music_generate:streaming_start', { label: 'PLUGIN', model });
    
    // 流式生成
    let streamedText = '';
    const fullResponse = await streamChatCompletion(
      { apiBaseUrl, apiKey, model, messages, timeoutMs },
      (chunk) => {
        streamedText += chunk;
        logger.debug?.('suno_music_generate:stream_chunk', { 
          label: 'PLUGIN',
          chunkLength: chunk.length,
          totalLength: streamedText.length
        });
      }
    );
    
    logger.info?.('suno_music_generate:streaming_complete', { 
      label: 'PLUGIN',
      responseLength: fullResponse.length
    });
    
    // 提取音频链接
    const audioLinks = extractAudioLinks(fullResponse);
    
    if (audioLinks.length === 0) {
      logger.warn?.('suno_music_generate:no_audio_link', { 
        label: 'PLUGIN',
        responsePreview: fullResponse.slice(0, 200)
      });
      return {
        success: false,
        code: 'NO_AUDIO_LINK',
        error: '生成的响应中未找到音频链接',
        details: {
          response: fullResponse,
          title,
          tags
        }
      };
    }
    
    // 使用第一个音频链接
    const audio = audioLinks[0];
    logger.info?.('suno_music_generate:audio_extracted', { 
      label: 'PLUGIN',
      audioUrl: audio.url,
      audioTitle: audio.title
    });
    
    // 构建并发送音乐卡片
    const segments = buildCustomMusicCardSegments({
      url: audio.url,
      audio: audio.url,
      title: audio.title || title,
      image: coverUrl
    });
    
    const pathList = [pathMain, (user_id ? pathPri : pathGrp)].filter((v, i, a) => !!v && a.indexOf(v) === i);
    
    logger.info?.('suno_music_generate:sending_card', { 
      label: 'PLUGIN',
      pathList,
      target: user_id ? 'private' : 'group'
    });
    
    const sendRes = await sendMusicCardViaWS(
      { wsUrl, timeoutMs: wsSendTimeoutMs, pathList, argStyle },
      { user_id, group_id },
      segments
    );
    
    if (sendRes.ok) {
      return {
        success: true,
        data: {
          action: 'suno_music_generate',
          发送对象: user_id ? '私聊' : '群聊',
          目标: user_id || group_id,
          音乐标题: audio.title || title,
          风格标签: tags,
          音频链接: audio.url,
          封面链接: coverUrl,
          歌词长度: lyrics.length,
          生成响应: fullResponse,
          所有音频链接: audioLinks,
          发送路径: sendRes.path,
          timestamp: new Date().toISOString()
        }
      };
    } else {
      return {
        success: false,
        code: 'SEND_FAILED',
        error: '音乐卡片发送失败',
        details: {
          audioUrl: audio.url,
          title: audio.title,
          triedPaths: pathList
        }
      };
    }
  } catch (e) {
    logger.error?.('suno_music_generate:error', { 
      label: 'PLUGIN',
      error: String(e?.message || e),
      stack: e?.stack
    });
    
    return {
      success: false,
      code: 'ERR',
      error: String(e?.message || e)
    };
  }
}

export default async function handler(args = {}, options = {}) {
  const out = await legacyHandler(args, options);
  if (out && typeof out === 'object' && typeof out.success === 'boolean') {
    if (out.success === true) {
      return ok(out.data ?? null, out.code || 'OK');
    }
    const extra = {};
    if ('details' in out && out.details != null) extra.detail = out.details;
    if ('data' in out && out.data != null) extra.detail = extra.detail ? { ...(typeof extra.detail === 'object' ? extra.detail : { value: extra.detail }), data: out.data } : { data: out.data };
    return fail(('error' in out) ? out.error : 'Tool failed', out.code || 'ERR', extra);
  }
  return ok(out);
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
