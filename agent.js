import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createLogger } from './utils/logger.js';
import { preprocessPlainModelOutput } from './components/OutputPreprocessor.js';
import { loadEnv, initEnvWatcher, onEnvReload } from './utils/envHotReloader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('Agent');

function previewData(data, limit = 1200) {
  if (data == null) return '[empty]';
  try {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    if (!text) return '[empty]';
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch (err) {
    return `[unserializable: ${err.message || 'unknown'}]`;
  }
}

/**
 * Agent 类 - 轻量级 AI 对话代理
 * 支持环境变量配置、重试机制、Function Calling
 */
class Agent {
  constructor(config = {}) {
    // 支持自定义环境变量路径
    this._envPath = path.resolve(config.envPath || '.env');
    this._lastEnvMtimeMs = 0;

    try {
      loadEnv(this._envPath);
      initEnvWatcher(this._envPath);
    } catch {}
    
    // 配置优先级：传入参数 > 环境变量 > 默认值
    const maxRetriesRaw =
      config.maxRetries ?? (process.env.MAX_RETRIES !== undefined ? process.env.MAX_RETRIES : '3');
    let maxRetriesParsed = parseInt(maxRetriesRaw, 10);
    if (!Number.isFinite(maxRetriesParsed) || maxRetriesParsed < 0) {
      maxRetriesParsed = 1;
    }

    this.config = {
      apiKey: config.apiKey || process.env.API_KEY,
      apiBaseUrl: config.apiBaseUrl || process.env.API_BASE_URL || 'https://yuanplus.chat/v1',
      defaultModel: config.defaultModel || process.env.MAIN_AI_MODEL || 'gpt-3.5-turbo',
      temperature: parseFloat(config.temperature || process.env.TEMPERATURE || '0.7'),
      maxTokens: parseInt(config.maxTokens || process.env.MAX_TOKENS || '4096'),
      // 语义：maxRetries = 最大“重试”次数（>=0），总尝试次数 = maxRetries + 1
      maxRetries: maxRetriesParsed,
      timeout: parseInt(config.timeout || process.env.TIMEOUT || '60000'),
      stream: config.stream !== undefined ? config.stream : false
    };

    this._configFromEnv = {
      apiKey: config.apiKey === undefined,
      apiBaseUrl: config.apiBaseUrl === undefined,
      defaultModel: config.defaultModel === undefined,
      temperature: config.temperature === undefined,
      maxTokens: config.maxTokens === undefined,
      maxRetries: config.maxRetries === undefined,
      timeout: config.timeout === undefined
    };

    this._refreshConfigFromEnv = () => {
      try {
        if (this._configFromEnv.apiKey) this.config.apiKey = process.env.API_KEY;
        if (this._configFromEnv.apiBaseUrl) this.config.apiBaseUrl = process.env.API_BASE_URL || 'https://yuanplus.chat/v1';
        if (this._configFromEnv.defaultModel) this.config.defaultModel = process.env.MAIN_AI_MODEL || 'gpt-3.5-turbo';
        if (this._configFromEnv.temperature) this.config.temperature = parseFloat(process.env.TEMPERATURE || '0.7');
        if (this._configFromEnv.maxTokens) this.config.maxTokens = parseInt(process.env.MAX_TOKENS || '4096');
        if (this._configFromEnv.timeout) this.config.timeout = parseInt(process.env.TIMEOUT || '60000');

        if (this._configFromEnv.maxRetries) {
          const mrRaw = process.env.MAX_RETRIES !== undefined ? process.env.MAX_RETRIES : '3';
          let mr = parseInt(mrRaw, 10);
          if (!Number.isFinite(mr) || mr < 0) mr = 1;
          this.config.maxRetries = mr;
        }
      } catch {}
    };

    this._refreshConfigFromEnv();

    this._disposeEnvReload = onEnvReload(() => {
      this._refreshConfigFromEnv();
    });

    if (!this.config.apiKey) {
      throw new Error('API_KEY is required. Please set API_KEY environment variable or pass it in config.');
    }
    
    // 启动时输出配置信息（不输出敏感信息）
    if (process.env.NODE_ENV !== 'production') {
      logger.config('Agent 初始化', {
        'API Base': this.config.apiBaseUrl,
        'Model': this.config.defaultModel,
        'Temperature': this.config.temperature,
        'Max Tokens': this.config.maxTokens === -1 ? '不限制' : this.config.maxTokens,
        'Max Retries': this.config.maxRetries,
        'Timeout': `${this.config.timeout}ms`
      });
    }
  }

  _tryHotReloadEnvOnce() {
    try {
      const fullPath = this._envPath;
      if (!fullPath) return;
      if (!fs.existsSync(fullPath)) return;
      const st = fs.statSync(fullPath);
      const mtime = Number(st && st.mtimeMs ? st.mtimeMs : 0);
      if (!Number.isFinite(mtime) || mtime <= 0) return;
      if (mtime <= (this._lastEnvMtimeMs || 0)) return;
      this._lastEnvMtimeMs = mtime;
      loadEnv(fullPath);
      this._refreshConfigFromEnv();
    } catch {}
  }
  
  /**
   * 发送聊天请求
   * @param {Array} messages - 消息数组
   * @param {String|Object} modelOrOptions - 模型名称或配置对象
   * @returns {Promise<String>} AI 回复内容
   */
  async chat(messages, modelOrOptions = {}) {
    this._tryHotReloadEnvOnce();
    // 兼容旧版API：直接传模型名称
    const options = typeof modelOrOptions === 'string' 
      ? { model: modelOrOptions }
      : modelOrOptions;
    
    const requestConfig = {
      model: options.model || this.config.defaultModel,
      temperature: options.temperature !== undefined ? options.temperature : this.config.temperature,
      stream: options.stream !== undefined ? options.stream : this.config.stream,
      messages: messages
    };
    
    // maxTokens 为 -1 时不限制，不添加 max_tokens 字段（由模型自行决定）
    const maxTokens = options.maxTokens !== undefined ? options.maxTokens : this.config.maxTokens;
    if (maxTokens !== -1 && maxTokens > 0) {
      requestConfig.max_tokens = maxTokens;
    }
    
    // 添加可选参数
    if (options.topP !== undefined) requestConfig.top_p = options.topP;
    if (options.frequencyPenalty !== undefined) requestConfig.frequency_penalty = options.frequencyPenalty;
    if (options.presencePenalty !== undefined) requestConfig.presence_penalty = options.presencePenalty;
    if (options.stop !== undefined) requestConfig.stop = options.stop;
    
    // 添加 tools 和 tool_choice 支持（OpenAI function calling）
    if (options.tools !== undefined) requestConfig.tools = options.tools;
    if (options.tool_choice !== undefined) requestConfig.tool_choice = options.tool_choice;

    const isPlainRequest = requestConfig.tools === undefined && requestConfig.tool_choice === undefined;
    
    let lastError = null;

    // 重试机制：maxRetries 表示“重试次数”，总尝试次数 = maxRetries + 1（>=1）
    const maxRetries = Number.isFinite(this.config.maxRetries) && this.config.maxRetries >= 0
      ? this.config.maxRetries
      : 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.config.apiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`
          },
          body: JSON.stringify(requestConfig),
          signal: AbortSignal.timeout(this.config.timeout)
        });

        if (!response.ok) {
          const errorText = await response.text();
          let errorData;
          try {
            errorData = JSON.parse(errorText);
          } catch {
            errorData = { message: errorText };
          }
          
          throw new Error(
            `API request failed (${response.status}): ${errorData.error?.message || errorData.message || errorText}`
          );
        }

        const data = await response.json();
        
        if (!data.choices || !data.choices[0]) {
          logger.error('Agent.chat: API响应缺少 choices', {
            responsePreview: previewData(data)
          });
          throw new Error('Invalid API response: missing choices');
        }
        
        const message = data.choices[0].message;

        if (!message || typeof message !== 'object') {
          logger.warn('Agent.chat: API响应 message 异常', {
            responsePreview: previewData(data)
          });
        }
        
        const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];

        // 如果使用了 tools，优先返回 tool_calls 的参数（解析后的JSON对象）
        // 注意：tool calling 模式下 message.content 可能为空/不存在，这是正常情况，不应告警。
        if (toolCalls.length > 0) {
          const toolCall = toolCalls[0];
          if (toolCall && toolCall.function && toolCall.function.arguments) {
            try {
              return JSON.parse(toolCall.function.arguments);
            } catch (parseError) {
              logger.warn('解析 tool_calls 参数失败', parseError.message);
              return toolCall.function.arguments;
            }
          }
        }

        if (!message || typeof message.content !== 'string' || !message.content.trim()) {
          logger.warn('Agent.chat: API返回空的 message.content', {
            messagePreview: previewData(message),
            responsePreview: previewData(data),
            hasTools: requestConfig.tools !== undefined || requestConfig.tool_choice !== undefined
          });
        }
        
        // 否则返回普通的文本内容
        if (typeof message.content === 'string' && isPlainRequest) {
          return preprocessPlainModelOutput(message.content);
        }
        return message.content;
      } catch (error) {
        lastError = error;

        // 如果是超时或网络错误，且还有剩余重试次数，则等待后重试
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000); // 指数退避
          logger.warn(`请求失败，${delay}ms 后重试 (${attempt + 1}/${maxRetries + 1})`, error.message);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
    }

    const totalAttempts = maxRetries + 1;

    // 所有尝试都失败
    logger.error(`AI 生成失败 (${totalAttempts}次尝试)`, lastError);

    // 如果配置了跳过失败，返回null而不是抛出错误
    if (process.env.SKIP_ON_GENERATION_FAIL === 'true') {
      return null;
    }

    const errMsg = lastError && lastError.message ? lastError.message : 'unknown error';
    throw new Error(`Failed to call AI API after ${totalAttempts} attempts: ${errMsg}`);
  }
  
  /**
   * 流式聊天（如果需要支持）
   * @param {Array} messages - 消息数组
   * @param {Object} options - 配置选项
   * @param {Function} onChunk - 处理每个chunk的回调
   * @returns {Promise<String>} 完整的回复内容
   */
  async chatStream(messages, options = {}, onChunk) {
    const requestConfig = {
      model: options.model || this.config.defaultModel,
      temperature: options.temperature !== undefined ? options.temperature : this.config.temperature,
      stream: true,
      messages: messages
    };
    
    // maxTokens 为 -1 时不限制，不添加 max_tokens 字段（由模型自行决定）
    const maxTokens = options.maxTokens !== undefined ? options.maxTokens : this.config.maxTokens;
    if (maxTokens !== -1 && maxTokens > 0) {
      requestConfig.max_tokens = maxTokens;
    }
    
    try {
      const response = await fetch(`${this.config.apiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(requestConfig),
        signal: AbortSignal.timeout(this.config.timeout)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed (${response.status}): ${errorText}`);
      }

      let fullContent = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices[0]?.delta?.content;
              if (content) {
                fullContent += content;
                if (onChunk) onChunk(content);
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      }
      
      return fullContent;
    } catch (error) {
      throw new Error(`Failed to call AI API (stream): ${error.message}`);
    }
  }
}

// 只导出 Agent 类，由调用方创建实例
export { Agent };
export default Agent;