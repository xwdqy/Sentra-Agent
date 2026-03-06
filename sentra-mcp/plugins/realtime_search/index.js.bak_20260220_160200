import OpenAI from 'openai';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import { ok, fail } from '../../src/utils/result.js';

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
      suggested_reply: '我搜了半天，还是没能在规定时间内拿到结果（可能是网络/接口超时）。我先基于我已有的知识给你一个可行的思路，如果你愿意我也可以稍后再重试搜索。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '建议稍后重试，或换一个更短/更具体的关键词',
        '如果你有指定网站/来源，可以告诉我（include_domains）',
        '如果你需要我直接给结论/步骤，我可以不依赖搜索先回答一个版本',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试进行实时搜索，但这次搜索失败了。我可以先按已有知识给你一个可靠的回答框架，并告诉你哪些点需要进一步核对；如果你同意，我也可以换个关键词再搜一次。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '建议更换关键词或缩小问题范围后重试',
      '如果你能提供更多上下文（时间、地点、对象），我可以给更准确的回答',
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

function buildSearchSystemPrompt({ include, exclude, maxResults }) {
  const lines = [];
  lines.push(`你是一个实时搜索助手。请基于最新的网页搜索结果，为用户提供准确、简明的答案。`);
  if (include?.length) lines.push(`优先参考以下域名的内容：${include.join(', ')}`);
  if (exclude?.length) lines.push(`不要引用以下域名的内容：${exclude.join(', ')}`);
  if (maxResults) lines.push(`每次查询最多参考 ${maxResults} 条结果。`);
  lines.push('请在回答末尾按 [1], [2], ... 格式列出所有参考链接的完整 URL。');
  return lines.join('\n');
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
  let m; while ((m = re.exec(text)) !== null) { set.add(m[0]); }
  return Array.from(set);
}

function normalizeQueries(args = {}) {
  const list = Array.isArray(args.queries) ? args.queries : [];
  const cleaned = list.map((q) => String(q || '').trim()).filter(Boolean);
  return cleaned;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runOneSearch({ client, model, baseArgs = {}, query, include, exclude, maxResults }) {
  const raw = baseArgs.rawRequest && typeof baseArgs.rawRequest === 'object' ? baseArgs.rawRequest : null;
  let payload;
  if (raw) {
    // Pass-through but enforce model from env
    payload = { ...raw, model };
  } else {
    const systemPrompt = buildSearchSystemPrompt({ include, exclude, maxResults });
    payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: String(query || '').trim() }
      ],
      temperature: 0.3,
    };
  }

  const res = await client.chat.completions.create(payload);
  const text = extractTextFromChatCompletion(res);
  const urls = extractUrls(text);
  return {
    query: String(query || '').trim() || null,
    model: res?.model || model,
    created: res?.created || null,
    answer_text: text || null,
    citations: urls.map((u, i) => ({ index: i + 1, url: u })),
    completion_id: res?.id || null,
    usage: res?.usage || null,
  };
}

export default async function handler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const q = String(args.query || '').trim();
  const queries = normalizeQueries(args);
  const raw = args.rawRequest && typeof args.rawRequest === 'object' ? args.rawRequest : null;
  const model = String(penv.REALTIME_SEARCH_MODEL || process.env.REALTIME_SEARCH_MODEL || 'gpt-4o-search');
  const baseURL = String(penv.REALTIME_SEARCH_BASE_URL || process.env.REALTIME_SEARCH_BASE_URL || config.llm.baseURL || 'https://yuanplus.chat/v1');
  const apiKey = String(penv.REALTIME_SEARCH_API_KEY || process.env.REALTIME_SEARCH_API_KEY || config.llm.apiKey || '');
  const maxResults = Number(args.max_results || 5);
  const include = arrifyCsv(args.include_domains);
  const exclude = arrifyCsv(args.exclude_domains);

  // Required condition: rawRequest OR query OR queries
  if (!raw && !q && !queries.length) {
    return fail('query/queries is required (or provide rawRequest)', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'realtime_search' }) });
  }

  const client = new OpenAI({ apiKey, baseURL });

  // Batch mode: queries[] (homogeneous tasks)
  if (!raw && queries.length) {
    const delayMs = Math.max(0, Number(penv.REALTIME_SEARCH_BATCH_DELAY_MS || process.env.REALTIME_SEARCH_BATCH_DELAY_MS || 250));
    const results = [];
    for (let i = 0; i < queries.length; i++) {
      const one = queries[i];
      try {
        const data = await runOneSearch({ client, model, baseArgs: args, query: one, include, exclude, maxResults });
        results.push({ query: one, success: true, data });
      } catch (e) {
        const msg = String(e?.message || e);
        const isTimeout = isTimeoutError(e);
        logger.error('realtime_search: batch item failed', { label: 'PLUGIN', error: msg, index: i, query: one });
        results.push({
          query: one,
          success: false,
          code: isTimeout ? 'TIMEOUT' : 'ERR',
          error: msg,
          advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'realtime_search', query: one || null })
        });
      }

      if (delayMs > 0 && i < queries.length - 1) {
        await sleep(delayMs);
      }
    }
    const anyOk = results.some((r) => r && r.success);
    return anyOk
      ? ok({ mode: 'batch', results })
      : fail('All batch queries failed', 'ERR', { detail: { mode: 'batch', results } });
  }

  // Single mode: rawRequest or query
  let data;
  try {
    data = await runOneSearch({ client, model, baseArgs: args, query: q, include, exclude, maxResults });
  } catch (e) {
    const msg = String(e?.message || e);
    logger.error('realtime_search: chat.completions.create failed', { label: 'PLUGIN', error: msg });
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', {
      advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'realtime_search', query: q || null })
    });
  }

  return ok(data);
}

