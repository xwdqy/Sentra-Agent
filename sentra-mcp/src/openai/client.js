import OpenAI from 'openai';
import { config } from '../config/index.js';
import logger from '../logger/index.js';

let client;
let clientKey;
let embeddingClient;
let embeddingClientKey;

export function getOpenAI() {
  const key = `${config.llm.apiKey || ''}@@${config.llm.baseURL || ''}`;
  if (!client || clientKey !== key) {
    const timeout = Number(config.llm?.timeoutMs);
    client = new OpenAI({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseURL,
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
    });
    clientKey = key;
  }
  return client;
}

export function getEmbeddingOpenAI() {
  const apiKey = config.embedding.apiKey || config.llm.apiKey;
  const baseURL = config.embedding.baseURL || config.llm.baseURL;
  const timeout = Number(config.embedding?.timeoutMs);
  const key = `${apiKey || ''}@@${baseURL || ''}@@${Number.isFinite(timeout) && timeout > 0 ? timeout : ''}`;
  if (!embeddingClient || embeddingClientKey !== key) {
    embeddingClient = new OpenAI({
      apiKey,
      baseURL,
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
    });
    embeddingClientKey = key;
  }
  return embeddingClient;
}

export async function chatCompletion({ messages, tools, tool_choice, temperature, top_p, max_tokens, apiKey, baseURL, model, omitMaxTokens, timeoutMs }) {
  // Allow per-call overrides of API credentials and base URL
  const timeout = Number(timeoutMs);
  const openai = (apiKey || baseURL || Number.isFinite(timeout))
    ? new OpenAI({
        apiKey: apiKey || config.llm.apiKey,
        baseURL: baseURL || config.llm.baseURL,
        ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {})
      })
    : getOpenAI();
  const payload = {
    model: model || config.llm.model,
    messages,
    temperature: temperature ?? config.llm.temperature,
  };
  if (typeof top_p === 'number') {
    const tp = Number(top_p);
    if (Number.isFinite(tp) && tp > 0 && tp <= 1) payload.top_p = tp;
  }
  // Decide whether to include max_tokens
  if (!omitMaxTokens) {
    const cfgMax = Number(config.llm.maxTokens);
    if (typeof max_tokens !== 'undefined') {
      const mt = Number(max_tokens);
      if (Number.isFinite(mt) && mt > 0) payload.max_tokens = mt; // positive value only
      // if -1 or <=0: omit
    } else if (Number.isFinite(cfgMax) && cfgMax > 0) {
      payload.max_tokens = cfgMax; // use env-configured positive limit
    }
  }
  if (tools) payload.tools = tools;
  if (tool_choice) payload.tool_choice = tool_choice;

  logger.debug?.('openai.chat.completions.create', { hasTools: !!tools, tool_choice: payload.tool_choice });

  const res = await openai.chat.completions.create(payload);
  return res;
}

export async function chatCompletionStream({ messages, tools, tool_choice, temperature, top_p, max_tokens, apiKey, baseURL, model, omitMaxTokens, onDelta, timeoutMs }) {
  const timeout = Number(timeoutMs);
  const openai = (apiKey || baseURL || Number.isFinite(timeout))
    ? new OpenAI({
        apiKey: apiKey || config.llm.apiKey,
        baseURL: baseURL || config.llm.baseURL,
        ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {})
      })
    : getOpenAI();

  const payload = {
    model: model || config.llm.model,
    messages,
    temperature: temperature ?? config.llm.temperature,
    stream: true,
  };

  if (typeof top_p === 'number') {
    const tp = Number(top_p);
    if (Number.isFinite(tp) && tp > 0 && tp <= 1) payload.top_p = tp;
  }

  if (!omitMaxTokens) {
    const cfgMax = Number(config.llm.maxTokens);
    if (typeof max_tokens !== 'undefined') {
      const mt = Number(max_tokens);
      if (Number.isFinite(mt) && mt > 0) payload.max_tokens = mt;
    } else if (Number.isFinite(cfgMax) && cfgMax > 0) {
      payload.max_tokens = cfgMax;
    }
  }

  if (tools) payload.tools = tools;
  if (tool_choice) payload.tool_choice = tool_choice;

  logger.debug?.('openai.chat.completions.create(stream)', { hasTools: !!tools, tool_choice: payload.tool_choice });

  const stream = await openai.chat.completions.create(payload);
  let content = '';
  let created;
  let usedModel;

  for await (const chunk of stream) {
    if (typeof chunk?.created === 'number') created = chunk.created;
    if (typeof chunk?.model === 'string') usedModel = chunk.model;
    const delta = chunk?.choices?.[0]?.delta?.content || '';
    if (delta) {
      content += delta;
      if (typeof onDelta === 'function') {
        try { onDelta(delta, content, chunk); } catch {}
      }
    }
  }

  return { content, created, model: usedModel || payload.model };
}

// 中文：简单封装 Embeddings 接口，返回每个输入文本的向量数组
export async function embedTexts({ texts = [], apiKey, baseURL, model }) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const timeout = Number(config.embedding?.timeoutMs);
  const openai = (apiKey || baseURL || (Number.isFinite(timeout) && timeout > 0))
    ? new OpenAI({
        apiKey: apiKey || config.embedding.apiKey || config.llm.apiKey,
        baseURL: baseURL || config.embedding.baseURL || config.llm.baseURL,
        ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {})
      })
    : getEmbeddingOpenAI();
  const mdl = model || config.embedding.model || 'text-embedding-3-small';
  const res = await openai.embeddings.create({ model: mdl, input: texts });
  return (res?.data || []).map((d) => Array.isArray(d.embedding) ? d.embedding : []);
}

export function buildToolSchemaFromLocal(tools) {
  // Convert our unified tool metadata to OpenAI tools schema
  // Each tool: { name, description, inputSchema }
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

export default { getOpenAI, chatCompletion, chatCompletionStream, buildToolSchemaFromLocal, embedTexts };
