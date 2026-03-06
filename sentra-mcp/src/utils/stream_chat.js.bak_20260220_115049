/**
 * 流式聊天完成工具
 * 支持 OpenAI 格式的流式 API 请求
 */

import logger from '../logger/index.js';

/**
 * 流式请求 OpenAI 格式的 Chat Completions API
 * @param {Object} config - 请求配置
 * @param {string} config.apiBaseUrl - API 基础 URL
 * @param {string} config.apiKey - API 密钥
 * @param {string} config.model - 模型名称
 * @param {Array} config.messages - 消息数组
 * @param {number} [config.timeoutMs=180000] - 超时时间（毫秒）
 * @param {number} [config.temperature=0.7] - 温度参数
 * @param {number} [config.max_tokens] - 最大token数
 * @param {Object} [config.extra] - 额外参数
 * @param {Function} [onChunk] - 接收到数据块时的回调函数
 * @param {Function} [onProgress] - 进度回调 ({ totalChunks, totalChars })
 * @returns {Promise<string>} 完整响应文本
 */
export async function streamChatCompletion(config, onChunk, onProgress) {
  const {
    apiBaseUrl,
    apiKey,
    model,
    messages,
    timeoutMs = 180000,
    temperature = 0.7,
    max_tokens,
    extra = {}
  } = config;

  const url = `${apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    logger.warn?.('stream_chat:timeout', { label: 'UTIL', timeoutMs, model });
    controller.abort();
  }, timeoutMs);
  
  try {
    logger.info?.('stream_chat:request_start', { 
      label: 'UTIL',
      url,
      model,
      messagesCount: messages.length,
      timeoutMs
    });

    const requestBody = {
      model,
      messages,
      stream: true,
      temperature,
      ...extra
    };

    if (typeof max_tokens !== 'undefined') {
      const mt = Number(max_tokens);
      if (Number.isFinite(mt) && mt > 0) {
        requestBody.max_tokens = mt;
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    let chunkCount = 0;
    let charCount = 0;
    
    logger.info?.('stream_chat:streaming_start', { label: 'UTIL', model });
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        logger.info?.('stream_chat:streaming_done', { 
          label: 'UTIL',
          totalChunks: chunkCount,
          totalChars: charCount,
          fullTextLength: fullText.length
        });
        break;
      }
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        
        try {
          const jsonStr = trimmed.slice(6);
          const data = JSON.parse(jsonStr);
          const content = data?.choices?.[0]?.delta?.content;
          
          if (content) {
            fullText += content;
            chunkCount++;
            charCount += content.length;
            
            if (onChunk) {
              try {
                onChunk(content, { chunkIndex: chunkCount, totalChars: charCount });
              } catch (e) {
                logger.warn?.('stream_chat:onChunk_error', { 
                  label: 'UTIL',
                  error: String(e)
                });
              }
            }
            
            if (onProgress && chunkCount % 10 === 0) {
              try {
                onProgress({ totalChunks: chunkCount, totalChars: charCount });
              } catch (e) {
                logger.warn?.('stream_chat:onProgress_error', { 
                  label: 'UTIL',
                  error: String(e)
                });
              }
            }
          }
        } catch (e) {
          logger.warn?.('stream_chat:parse_chunk_error', { 
            label: 'UTIL',
            line: trimmed.slice(0, 100),
            error: String(e?.message || e)
          });
        }
      }
    }
    
    clearTimeout(timeout);
    
    logger.info?.('stream_chat:complete', { 
      label: 'UTIL',
      model,
      responseLength: fullText.length,
      chunksProcessed: chunkCount
    });
    
    return fullText;
    
  } catch (e) {
    clearTimeout(timeout);
    
    logger.error?.('stream_chat:error', { 
      label: 'UTIL',
      model,
      error: String(e?.message || e),
      errorName: e?.name
    });
    
    throw e;
  }
}

/**
 * 非流式请求（向后兼容）
 * @param {Object} config - 同 streamChatCompletion
 * @returns {Promise<string>} 完整响应文本
 */
export async function chatCompletion(config) {
  const {
    apiBaseUrl,
    apiKey,
    model,
    messages,
    timeoutMs = 180000,
    temperature = 0.7,
    max_tokens,
    extra = {}
  } = config;

  const url = `${apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const requestBody = {
      model,
      messages,
      stream: false,
      temperature,
      ...extra
    };

    if (max_tokens) {
      requestBody.max_tokens = max_tokens;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
    }
    
    const data = await response.json();
    clearTimeout(timeout);
    
    return data?.choices?.[0]?.message?.content || '';
    
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

export default {
  streamChatCompletion,
  chatCompletion
};
