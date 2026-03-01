import OpenAI from 'openai';
import axios from 'axios';
import crypto from 'crypto';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import { ok, fail } from '../../src/utils/result.js';

const searchCache = new Map();
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_SWEEP_MS = 60 * 60 * 1000;

const cacheGcTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of searchCache.entries()) {
    if (!value?.time || !value?.ttlMs || now - value.time > value.ttlMs) {
      searchCache.delete(key);
    }
  }
}, DEFAULT_CACHE_SWEEP_MS);
if (typeof cacheGcTimer?.unref === 'function') cacheGcTimer.unref();

function isTimeoutError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  const code = String(e?.code || '').toUpperCase();
  return (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'ECONNABORTED' ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  );
}

function buildAdvice(kind, ctx = {}) {
  const personaHint = '请结合你当前的预设/人设继续作答：即使工具失败，也要给出可执行的替代方案、解释原因，并引导用户补充信息。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我现在还没拿到要搜索的关键词/问题描述，所以没法开始实时搜索。你把想查的内容发我一下，我再继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '请提供 query（单条搜索关键词/问题）或 queries（多个关键词数组）',
        '可以给出你期望的时间范围/地区/更具体的限定词',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试联网搜索超时了（可能是网络问题或上游接口波动）。我先基于已有知识给你一个可行方案，也可以稍后重试。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '建议稍后重试，或换更短/更具体的关键词',
        '如果有指定网站/来源，请告诉我（include_domains）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试进行实时搜索，但搜索链路暂时不可用。我可以先按已有知识给你可靠回答，并标注不确定点。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '建议更换关键词或缩小问题范围后重试',
      '可先让我基于已有知识给你可执行方案',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

function arrifyCsv(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeQueries(args = {}) {
  const list = Array.isArray(args.queries) ? args.queries : [];
  return list.map((q) => String(q || '').trim()).filter(Boolean);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getCacheKey(payload) {
  return crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
}

function getCached(key, ttlMs) {
  if (!key || ttlMs <= 0) return null;
  const item = searchCache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > ttlMs) {
    searchCache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data, { ttlMs, maxSize }) {
  if (!key || ttlMs <= 0) return;
  searchCache.set(key, { time: Date.now(), ttlMs, data });
  if (searchCache.size <= maxSize) return;
  const firstKey = searchCache.keys().next().value;
  if (firstKey) searchCache.delete(firstKey);
}

function extractTextFromChatCompletion(res) {
  try {
    const content = res?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
  } catch {}
  return '';
}

function extractUrls(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s)\]]+/gi;
  const set = new Set();
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[0]);
  return Array.from(set);
}

function pickProviderOrder(mode) {
  const normalized = String(mode || 'auto').toLowerCase();
  if (normalized === 'model') return ['model'];
  if (normalized === 'serper') return ['serper', 'model'];
  if (normalized === 'tavily') return ['tavily', 'serper', 'model'];
  return ['gemini', 'tavily', 'serper', 'model'];
}

async function fetchGeminiNativeSearch({ query, apiKey, model, baseURL, timeoutMs }) {
  if (!apiKey) throw new Error('missing GEMINI_NATIVE_API_KEY');
  const modelName = String(model || 'gemini-2.5-flash');
  const root = String(baseURL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const url = `${root}/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await axios.post(url, {
    contents: [
      {
        role: 'user',
        parts: [{ text: `请帮我联网搜索并详细回答以下问题：\n${String(query || '').trim()}` }],
      },
    ],
    tools: [{ googleSearch: {} }],
  }, {
    timeout: timeoutMs,
  });

  const data = res?.data || {};
  const answerText = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('\n').trim();
  if (!answerText) throw new Error('Gemini native search returned empty text');

  const chunks = Array.isArray(data?.candidates?.[0]?.groundingMetadata?.groundingChunks)
    ? data.candidates[0].groundingMetadata.groundingChunks
    : [];

  const citations = chunks
    .filter((c) => c?.web?.uri)
    .map((c, i) => ({
      index: i + 1,
      url: c.web.uri,
      title: c.web.title || '参考链接',
    }));

  return {
    query: String(query || '').trim() || null,
    model: `${modelName}-grounding`,
    created: Date.now(),
    answer_text: answerText,
    citations,
    completion_id: null,
    usage: null,
    provider: 'gemini',
  };
}

async function fetchTavilyResults({ query, maxResults, include, exclude, apiKey, baseURL, timeoutMs }) {
  if (!apiKey) throw new Error('missing TAVILY_API_KEY');
  const url = String(baseURL || 'https://api.tavily.com/search');
  const res = await axios.post(url, {
    api_key: apiKey,
    query: String(query || '').trim(),
    search_depth: 'basic',
    include_answer: false,
    max_results: Number(maxResults || 5),
    include_domains: include?.length ? include : undefined,
    exclude_domains: exclude?.length ? exclude : undefined,
  }, {
    timeout: timeoutMs,
  });
  const rows = Array.isArray(res?.data?.results) ? res.data.results : [];
  return rows.map((r) => ({
    title: String(r?.title || '').trim(),
    url: String(r?.url || '').trim(),
    content: String(r?.content || '').trim(),
  })).filter((r) => r.url);
}

async function fetchSerperResults({ query, maxResults, apiKey, baseURL, timeoutMs }) {
  if (!apiKey) throw new Error('missing SERPER_API_KEY');
  const url = String(baseURL || 'https://google.serper.dev/search');
  const res = await axios.post(url, {
    q: String(query || '').trim(),
    num: Math.min(Number(maxResults || 5), 10),
  }, {
    timeout: timeoutMs,
    headers: { 'X-API-KEY': apiKey },
  });
  const rows = Array.isArray(res?.data?.organic) ? res.data.organic : [];
  return rows.map((r) => ({
    title: String(r?.title || '').trim(),
    url: String(r?.link || '').trim(),
    content: String(r?.snippet || '').trim(),
  })).filter((r) => r.url);
}

async function summarizeWithModel({ client, model, query, searchResults }) {
  const contextText = searchResults
    .map((r, i) => `[${i + 1}] 标题: ${r.title || '（无标题）'}\n来源: ${r.url}\n内容片段: ${r.content || '（无摘要）'}`)
    .join('\n\n');

  const systemPrompt = [
    '你是一个实时搜索助手。请基于提供的网页搜索结果回答用户问题。',
    '要求：准确、简明、可执行；不要编造未出现在搜索结果中的事实。',
    '请在回答末尾用 [1], [2]... 标注来源。',
    '',
    '【搜索结果】',
    contextText,
  ].join('\n');

  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: String(query || '').trim() },
    ],
    temperature: 0.3,
  });

  return {
    query: String(query || '').trim() || null,
    model: res?.model || model,
    created: res?.created || null,
    answer_text: extractTextFromChatCompletion(res) || '',
    citations: searchResults.map((r, i) => ({ index: i + 1, url: r.url, title: r.title || null })),
    completion_id: res?.id || null,
    usage: res?.usage || null,
    provider: 'model',
  };
}

async function runModelOnlyAnswer({ client, model, query }) {
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: '你是一个助手。联网搜索不可用时，请基于已有知识给出明确、可执行的回答，并说明可能存在时效性限制。' },
      { role: 'user', content: String(query || '').trim() },
    ],
    temperature: 0.3,
  });

  const text = extractTextFromChatCompletion(res);
  return {
    query: String(query || '').trim() || null,
    model: res?.model || model,
    created: res?.created || null,
    answer_text: text || '',
    citations: extractUrls(text).map((u, i) => ({ index: i + 1, url: u })),
    completion_id: res?.id || null,
    usage: res?.usage || null,
    provider: 'model_fallback',
  };
}

async function runSearchChain({ client, query, maxResults, include, exclude, providerMode, model, env }) {
  const providerOrder = pickProviderOrder(providerMode);
  const providerErrors = [];

  for (const provider of providerOrder) {
    try {
      if (provider === 'gemini') {
        return {
          ...(await fetchGeminiNativeSearch({
            query,
            apiKey: env.geminiApiKey,
            model: env.geminiModel,
            baseURL: env.geminiBaseURL,
            timeoutMs: env.searchTimeoutMs,
          })),
          provider_chain: providerOrder,
        };
      }

      if (provider === 'tavily') {
        const rows = await fetchTavilyResults({
          query,
          maxResults,
          include,
          exclude,
          apiKey: env.tavilyApiKey,
          baseURL: env.tavilyBaseURL,
          timeoutMs: env.searchTimeoutMs,
        });
        if (!rows.length) throw new Error('Tavily returned empty result');
        const data = await summarizeWithModel({ client, model, query, searchResults: rows });
        return { ...data, provider: 'tavily+model', provider_chain: providerOrder };
      }

      if (provider === 'serper') {
        const rows = await fetchSerperResults({
          query,
          maxResults,
          apiKey: env.serperApiKey,
          baseURL: env.serperBaseURL,
          timeoutMs: env.searchTimeoutMs,
        });
        if (!rows.length) throw new Error('Serper returned empty result');
        const data = await summarizeWithModel({ client, model, query, searchResults: rows });
        return { ...data, provider: 'serper+model', provider_chain: providerOrder };
      }

      if (provider === 'model') {
        const data = await runModelOnlyAnswer({ client, model, query });
        return { ...data, provider_chain: providerOrder };
      }
    } catch (e) {
      providerErrors.push({ provider, error: String(e?.message || e) });
      logger.warn('realtime_search: provider failed', { label: 'PLUGIN', provider, error: String(e?.message || e) });
    }
  }

  throw new Error(`All providers failed: ${providerErrors.map((x) => `${x.provider}: ${x.error}`).join(' | ')}`);
}

async function runOneSearch({ client, model, baseArgs = {}, query, include, exclude, maxResults, providerMode, env, cache }) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Query is empty');

  const raw = baseArgs.rawRequest && typeof baseArgs.rawRequest === 'object' ? baseArgs.rawRequest : null;
  if (raw) {
    const payload = { ...raw, model };
    const res = await client.chat.completions.create(payload);
    const text = extractTextFromChatCompletion(res);
    return {
      query: q,
      model: res?.model || model,
      created: res?.created || null,
      answer_text: text || null,
      citations: extractUrls(text).map((u, i) => ({ index: i + 1, url: u })),
      completion_id: res?.id || null,
      usage: res?.usage || null,
      provider: 'raw_request',
    };
  }

  const cacheKey = getCacheKey({ providerMode, model, q, maxResults, include, exclude });
  const cached = getCached(cacheKey, cache.ttlMs);
  if (cached) return { ...cached, cache_hit: true };

  const data = await runSearchChain({
    client,
    query: q,
    maxResults,
    include,
    exclude,
    providerMode,
    model,
    env,
  });

  setCached(cacheKey, data, cache);
  return data;
}

export default async function handler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const q = String(args.query || '').trim();
  const queries = normalizeQueries(args);
  const raw = args.rawRequest && typeof args.rawRequest === 'object' ? args.rawRequest : null;

  const model = String(penv.REALTIME_SEARCH_MODEL || process.env.REALTIME_SEARCH_MODEL || 'gemini-2.5-flash');
  const providerMode = String(args.provider || penv.REALTIME_SEARCH_PROVIDER || process.env.REALTIME_SEARCH_PROVIDER || 'auto').toLowerCase();
  const baseURL = String(penv.REALTIME_SEARCH_BASE_URL || process.env.REALTIME_SEARCH_BASE_URL || config.llm.baseURL || 'https://yuanplus.chat/v1');
  const apiKey = String(penv.REALTIME_SEARCH_API_KEY || process.env.REALTIME_SEARCH_API_KEY || config.llm.apiKey || '');

  const maxResults = Number(args.max_results || 5);
  const include = arrifyCsv(args.include_domains);
  const exclude = arrifyCsv(args.exclude_domains);

  const env = {
    geminiApiKey: String(penv.GEMINI_NATIVE_API_KEY || process.env.GEMINI_NATIVE_API_KEY || ''),
    geminiModel: String(penv.GEMINI_NATIVE_MODEL || process.env.GEMINI_NATIVE_MODEL || 'gemini-2.5-flash'),
    geminiBaseURL: String(penv.GEMINI_NATIVE_BASE_URL || process.env.GEMINI_NATIVE_BASE_URL || 'https://generativelanguage.googleapis.com'),
    tavilyApiKey: String(penv.TAVILY_API_KEY || process.env.TAVILY_API_KEY || ''),
    tavilyBaseURL: String(penv.TAVILY_BASE_URL || process.env.TAVILY_BASE_URL || 'https://api.tavily.com/search'),
    serperApiKey: String(penv.SERPER_API_KEY || process.env.SERPER_API_KEY || ''),
    serperBaseURL: String(penv.SERPER_BASE_URL || process.env.SERPER_BASE_URL || 'https://google.serper.dev/search'),
    searchTimeoutMs: Number(penv.REALTIME_SEARCH_UPSTREAM_TIMEOUT_MS || process.env.REALTIME_SEARCH_UPSTREAM_TIMEOUT_MS || 30000),
  };

  const cache = {
    ttlMs: Number(penv.REALTIME_SEARCH_CACHE_TTL_MS || process.env.REALTIME_SEARCH_CACHE_TTL_MS || DEFAULT_CACHE_TTL_MS),
    maxSize: Number(penv.REALTIME_SEARCH_CACHE_MAX_SIZE || process.env.REALTIME_SEARCH_CACHE_MAX_SIZE || 500),
  };

  if (!raw && !q && !queries.length) {
    return fail('query/queries is required (or provide rawRequest)', 'INVALID', {
      advice: buildAdvice('INVALID', { tool: 'realtime_search' }),
    });
  }

  const client = new OpenAI({ apiKey, baseURL });

  if (!raw && queries.length) {
    const delayMs = Math.max(0, Number(penv.REALTIME_SEARCH_BATCH_DELAY_MS || process.env.REALTIME_SEARCH_BATCH_DELAY_MS || 250));
    const results = [];

    for (let i = 0; i < queries.length; i++) {
      const one = queries[i];
      try {
        const data = await runOneSearch({
          client,
          model,
          baseArgs: args,
          query: one,
          include,
          exclude,
          maxResults,
          providerMode,
          env,
          cache,
        });
        results.push({ query: one, success: true, data });
      } catch (e) {
        const msg = String(e?.message || e);
        const isTimeout = isTimeoutError(e);
        logger.error('realtime_search: batch item failed', { label: 'PLUGIN', index: i, query: one, error: msg });
        results.push({
          query: one,
          success: false,
          code: isTimeout ? 'TIMEOUT' : 'ERR',
          error: msg,
          advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'realtime_search', query: one || null }),
        });
      }
      if (delayMs > 0 && i < queries.length - 1) await sleep(delayMs);
    }

    const anyOk = results.some((r) => r?.success);
    return anyOk ? ok({ mode: 'batch', results }) : fail('All batch queries failed', 'ERR', { detail: { mode: 'batch', results } });
  }

  try {
    const data = await runOneSearch({
      client,
      model,
      baseArgs: args,
      query: q,
      include,
      exclude,
      maxResults,
      providerMode,
      env,
      cache,
    });
    return ok(data);
  } catch (e) {
    const msg = String(e?.message || e);
    logger.error('realtime_search: failed', { label: 'PLUGIN', error: msg });
    const isTimeout = isTimeoutError(e);
    return fail(msg, isTimeout ? 'TIMEOUT' : 'ERR', {
      advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'realtime_search', query: q || null }),
    });
  }
}
