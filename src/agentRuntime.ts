import axios from 'axios';
import { createParser } from 'eventsource-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createLogger } from '../utils/logger.js';
import { preprocessPlainModelOutput } from '../components/OutputPreprocessor.js';
import { loadEnv, initEnvWatcher, onEnvReload, getEnvTimeoutMs } from '../utils/envHotReloader.js';
import { tryParseXmlFragment } from '../utils/xmlUtils.js';
import type { ExpectedOutput } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('Agent');

type ParserEvent = { data: string };

type StreamHandlers = {
  onChunk?: (chunk: string) => void;
  expectedOutput?: ExpectedOutput;
  onEarlyTerminate?: (event: { reason?: string; partial?: string }) => void;
};

type ChatOptions = StreamHandlers & {
  apiKey?: string;
  apiBaseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  stream?: boolean;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string | string[];
};

export type AgentConfig = {
  apiKey?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  stream?: boolean;
  envPath?: string;
};

type NormalizedConfig = {
  apiKey: string;
  apiBaseUrl: string;
  defaultModel: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
  stream: boolean;
};

type ConfigSourceFlags = {
  apiKey: boolean;
  apiBaseUrl: boolean;
  defaultModel: boolean;
  temperature: boolean;
  maxTokens: boolean;
  timeout: boolean;
};

type OpenAIRequestBody = {
  model: string;
  temperature: number;
  stream: boolean;
  messages: AnyChatMessage[];
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
};

type OpenAIChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
};

type StreamChunk = {
  choices?: Array<{ delta?: { content?: string } }>;
};

type AnyChatMessage = {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
};

type DestroyableStream = NodeJS.ReadableStream & { destroy: () => void };

function normalizeOpenAIBaseUrl(input: unknown): string {
  const raw = String(input || '').trim();
  if (!raw) return raw;
  const root = raw.replace(/\/+$/, '');
  if (/\/v\d+$/i.test(root)) return root;
  return `${root}/v1`;
}

function findFirstCompleteSentraBlock(text: unknown, allowTags?: string[]): { tag: string; block: string } | null {
  const s = typeof text === 'string' ? text : '';
  if (!s) return null;
  const tags = Array.isArray(allowTags) && allowTags.length
    ? allowTags
    : ['sentra-response', 'sentra-tools'];

  let cursor = 0;
  while (cursor < s.length) {
    let bestIdx = -1;
    let bestTag = '';
    for (const tag of tags) {
      const needle = `<${tag}`;
      const idx = s.indexOf(needle, cursor);
      if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
        bestIdx = idx;
        bestTag = tag;
      }
    }
    if (bestIdx < 0) return null;

    const close = `</${bestTag}>`;
    const endIdx = s.indexOf(close, bestIdx);
    if (endIdx < 0) return null;

    const fullEnd = endIdx + close.length;
    const block = s.substring(bestIdx, fullEnd);
    const parsed = tryParseXmlFragment(block, 'root');
    const parsedObj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    if (parsedObj && parsedObj[bestTag] != null) {
      return { tag: bestTag, block };
    }

    cursor = bestIdx + 1;
  }
  return null;
}

/**
 * Agent 类 - 轻量级 AI 对话代理
 * 支持环境变量配置、流式输出、Sentra XML 协议
 */
class Agent {
  config: NormalizedConfig;
  _envPath: string;
  _lastEnvMtimeMs: number;
  _configFromEnv: ConfigSourceFlags;
  _refreshConfigFromEnv: () => void;
  _disposeEnvReload?: () => void;

  constructor(config: AgentConfig = {}) {
    // 支持自定义环境变量路径
    const envPath = typeof config.envPath === 'string' && config.envPath.trim()
      ? config.envPath.trim()
      : '.env';
    this._envPath = path.resolve(envPath);
    this._lastEnvMtimeMs = 0;

    try {
      loadEnv(this._envPath);
      initEnvWatcher(this._envPath);
    } catch { }

    // 配置优先级：传入参数 > 环境变量 > 默认值
    const apiKeyRaw = config.apiKey ?? process.env.API_KEY ?? '';
    const apiBaseUrlRaw = config.apiBaseUrl ?? process.env.API_BASE_URL ?? 'https://yuanplus.chat/v1';
    const modelRaw = config.defaultModel ?? process.env.MAIN_AI_MODEL ?? 'gpt-3.5-turbo';
    const tempRaw = config.temperature ?? process.env.TEMPERATURE ?? '0.7';
    const maxTokensRaw = config.maxTokens ?? process.env.MAX_TOKENS ?? '4096';
    const timeoutRaw = Number(config.timeout);

    const tempParsed = Number.parseFloat(String(tempRaw));
    const maxTokensParsed = Number.parseInt(String(maxTokensRaw), 10);

    this.config = {
      apiKey: String(apiKeyRaw || ''),
      apiBaseUrl: normalizeOpenAIBaseUrl(apiBaseUrlRaw),
      defaultModel: String(modelRaw || 'gpt-3.5-turbo'),
      temperature: Number.isFinite(tempParsed) ? tempParsed : 0.7,
      maxTokens: Number.isFinite(maxTokensParsed) ? maxTokensParsed : 4096,
      timeout: getEnvTimeoutMs('TIMEOUT', Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 180000, 900000),
      stream: config.stream !== undefined ? !!config.stream : true
    };

    this._configFromEnv = {
      apiKey: config.apiKey === undefined,
      apiBaseUrl: config.apiBaseUrl === undefined,
      defaultModel: config.defaultModel === undefined,
      temperature: config.temperature === undefined,
      maxTokens: config.maxTokens === undefined,
      timeout: config.timeout === undefined
    };

    this._refreshConfigFromEnv = () => {
      try {
        if (this._configFromEnv.apiKey) {
          this.config.apiKey = String(process.env.API_KEY || '');
        }
        if (this._configFromEnv.apiBaseUrl) {
          this.config.apiBaseUrl = normalizeOpenAIBaseUrl(process.env.API_BASE_URL || 'https://yuanplus.chat/v1');
        }
        if (this._configFromEnv.defaultModel) {
          this.config.defaultModel = String(process.env.MAIN_AI_MODEL || 'gpt-3.5-turbo');
        }
        if (this._configFromEnv.temperature) {
          const temp = Number.parseFloat(String(process.env.TEMPERATURE || '0.7'));
          this.config.temperature = Number.isFinite(temp) ? temp : 0.7;
        }
        if (this._configFromEnv.maxTokens) {
          const maxTokens = Number.parseInt(String(process.env.MAX_TOKENS || '4096'), 10);
          this.config.maxTokens = Number.isFinite(maxTokens) ? maxTokens : 4096;
        }
        if (this._configFromEnv.timeout) {
          this.config.timeout = getEnvTimeoutMs('TIMEOUT', 180000, 900000);
        }
      } catch { }
    };

    this._refreshConfigFromEnv();

    this._disposeEnvReload = onEnvReload(() => {
      this._refreshConfigFromEnv();
    });

    if (!this.config.apiKey) {
      throw new Error('缺少 API_KEY：请在环境变量中设置 API_KEY，或在创建 Agent 时传入 config.apiKey');
    }

    // 启动时输出配置信息（不输出敏感信息）
    if (process.env.NODE_ENV !== 'production') {
      logger.config('Agent 初始化', {
        'API Base': this.config.apiBaseUrl,
        'Model': this.config.defaultModel,
        'Temperature': this.config.temperature,
        'Max Tokens': this.config.maxTokens === -1 ? '不限制' : this.config.maxTokens,
        'Timeout': `${this.config.timeout}ms`
      });
    }
  }

  _tryHotReloadEnvOnce(): void {
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
    } catch { }
  }

  /**
   * 发送聊天请求
   * @param {Array} messages - 消息数组
   * @param {String|Object} modelOrOptions - 模型名称或配置对象
   * @returns {Promise<String>} AI 回复内容
   */
  async chat(messages: AnyChatMessage[], modelOrOptions: string | ChatOptions = {}): Promise<string | null> {
    this._tryHotReloadEnvOnce();
    const options: ChatOptions = typeof modelOrOptions === 'string'
      ? { model: modelOrOptions }
      : (modelOrOptions || {});

    const apiBaseUrl = normalizeOpenAIBaseUrl(options.apiBaseUrl || this.config.apiBaseUrl);
    const apiKey = typeof options.apiKey === 'string' && options.apiKey ? options.apiKey : this.config.apiKey;
    const model = typeof options.model === 'string' && options.model ? options.model : this.config.defaultModel;
    const temperature = typeof options.temperature === 'number' ? options.temperature : this.config.temperature;
    const stream = options.stream !== undefined ? !!options.stream : this.config.stream;
    const maxTokens = typeof options.maxTokens === 'number' ? options.maxTokens : this.config.maxTokens;
    const timeoutMs = Number.isFinite(Number(options.timeout)) && Number(options.timeout) > 0
      ? Math.min(Number(options.timeout), 900000)
      : (Number.isFinite(Number(this.config.timeout)) && Number(this.config.timeout) > 0 ? Number(this.config.timeout) : 180000);

    const requestBody: OpenAIRequestBody = {
      model,
      temperature,
      stream,
      messages
    };

    if (maxTokens !== -1 && maxTokens > 0) {
      requestBody.max_tokens = maxTokens;
    }

    if (options.topP !== undefined) requestBody.top_p = options.topP;
    if (options.frequencyPenalty !== undefined) requestBody.frequency_penalty = options.frequencyPenalty;
    if (options.presencePenalty !== undefined) requestBody.presence_penalty = options.presencePenalty;
    if (options.stop !== undefined) requestBody.stop = options.stop;

    try {
      if (stream) {
        return await this._streamChat(apiBaseUrl, apiKey, requestBody, timeoutMs, options);
      } else {
        return await this._nonStreamChat(apiBaseUrl, apiKey, requestBody, timeoutMs);
      }
    } catch (error) {
      logger.error('AI 生成失败（已禁用内部重试）', error);
      return null;
    }
  }

  async _nonStreamChat(apiBaseUrl: string, apiKey: string, requestBody: OpenAIRequestBody, timeoutMs: number): Promise<string> {
    const response = await axios.post<OpenAIChatResponse>(`${apiBaseUrl}/chat/completions`, requestBody, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs,
      responseType: 'json'
    });

    if (!response.data?.choices?.[0]?.message) {
      throw new Error('API 响应格式异常：缺少 message');
    }

    const message = response.data.choices[0].message;
    if (typeof message.content === 'string' && message.content.trim()) {
      return preprocessPlainModelOutput(message.content);
    }
    return message.content || '';
  }

  async _streamChat(
    apiBaseUrl: string,
    apiKey: string,
    requestBody: OpenAIRequestBody,
    timeoutMs: number,
    options: StreamHandlers = {}
  ): Promise<string> {
    const { onChunk, expectedOutput, onEarlyTerminate } = options;

    const response = await axios.post(`${apiBaseUrl}/chat/completions`, requestBody, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs,
      responseType: 'stream'
    });

    let assembledContent = '';
    let aborted = false;
    let completedBlock = null;

    const stream = response.data as DestroyableStream;

    const parser = createParser({
      onEvent: (event: ParserEvent) => {
        // eventsource-parser@3: onEvent is already an SSE "event" callback.
        if (!event || event.data === '[DONE]') return;
        try {
          const parsed = JSON.parse(event.data) as StreamChunk;
          const content = parsed.choices?.[0]?.delta?.content;
          if (typeof content === 'string' && content.length) {
            assembledContent += content;
            if (onChunk) onChunk(content);

            if (!aborted) {
              const allowTags = expectedOutput === 'sentra_tools'
                ? ['sentra-tools']
                : (expectedOutput === 'sentra_response'
                  ? ['sentra-response', 'sentra-tools']
                  : ['sentra-response', 'sentra-tools']);
              const found = findFirstCompleteSentraBlock(assembledContent, allowTags);
              if (found) {
                const tag = found.tag;
                const block = found.block;
                const allowsTools = expectedOutput === 'sentra_tools' || expectedOutput === 'sentra_tools_or_response';
                const allowsResponse = expectedOutput === 'sentra_response' || expectedOutput === 'sentra_tools_or_response';

                if ((tag === 'sentra-tools' && allowsTools) || (tag === 'sentra-response' && allowsResponse)) {
                  completedBlock = block;
                  assembledContent = block;
                  aborted = true;
                }
              }
            }

            if (expectedOutput && onEarlyTerminate && !aborted) {
              const normalized = assembledContent.toLowerCase();
              const hasTools = normalized.includes('<sentra-tools>');
              const hasResponse = normalized.includes('<sentra-response>');

              if (expectedOutput === 'sentra_tools' && hasResponse && !hasTools) {
                aborted = true;
                try { stream?.destroy?.(); } catch { }
                onEarlyTerminate({ reason: 'unexpected_sentra_response', partial: assembledContent });
              } else if (
                expectedOutput === 'sentra_response' &&
                hasTools &&
                !hasResponse &&
                normalized.includes('</sentra-tools>')
              ) {
                aborted = true;
                try { stream?.destroy?.(); } catch { }
                onEarlyTerminate({ reason: 'early_tools_complete', partial: assembledContent });
              }
            }
          }
        } catch {
        }
      }
    });

    const decoder = new TextDecoder();

    const reader: AsyncIterable<string | Uint8Array> = stream[Symbol.asyncIterator]?.() || (async function* (readable: NodeJS.ReadableStream) {
      for await (const chunk of readable as AsyncIterable<Buffer | Uint8Array | string>) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        yield decoder.decode(buf, { stream: true });
      }
    })(stream);

    for await (const chunk of reader) {
      if (aborted) break;

      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
      parser.feed(text);
    }

    if (aborted) {
      try { stream?.destroy?.(); } catch { }
    }

    return preprocessPlainModelOutput(assembledContent);
  }
}

// 流式优先架构：默认使用流式输出，支持早终止和协议校验
export { Agent };
export default Agent;
