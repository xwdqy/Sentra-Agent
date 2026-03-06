import logger from '../logger/index.js';
import { getRuntimeSignal } from './runtime_context.js';
import { mergeAbortSignals, makeAbortError } from './signal.js';

function buildTimeoutController(timeoutMs, model) {
  const controller = new AbortController();
  const ms = Math.max(1, Number(timeoutMs) || 180000);
  const timer = setTimeout(() => {
    logger.warn?.('stream_chat:timeout', { label: 'UTIL', timeoutMs: ms, model });
    try {
      controller.abort(makeAbortError(`Timeout after ${ms}ms`, 'TIMEOUT', { timeoutMs: ms }));
    } catch {}
  }, ms);
  return { controller, timer, timeoutMs: ms };
}

function createRequestSignal({ signal, timeoutMs, model }) {
  const { controller, timer, timeoutMs: ms } = buildTimeoutController(timeoutMs, model);
  const merged = mergeAbortSignals([signal, getRuntimeSignal(), controller.signal]);
  return { signal: merged || controller.signal, timer, timeoutMs: ms };
}

export async function streamChatCompletion(config, onChunk, onProgress) {
  const {
    apiBaseUrl,
    apiKey,
    model,
    messages,
    timeoutMs = 180000,
    temperature = 0.7,
    max_tokens,
    extra = {},
    signal,
  } = config;

  const url = `${apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const { signal: requestSignal, timer, timeoutMs: finalTimeoutMs } = createRequestSignal({ signal, timeoutMs, model });

  try {
    logger.info?.('stream_chat:request_start', {
      label: 'UTIL',
      url,
      model,
      messagesCount: Array.isArray(messages) ? messages.length : 0,
      timeoutMs: finalTimeoutMs,
    });

    const requestBody = {
      model,
      messages,
      stream: true,
      temperature,
      ...extra,
    };

    if (typeof max_tokens !== 'undefined') {
      const mt = Number(max_tokens);
      if (Number.isFinite(mt) && mt > 0) requestBody.max_tokens = mt;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: requestSignal,
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
          fullTextLength: fullText.length,
        });
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));
          const content = data?.choices?.[0]?.delta?.content;
          if (!content) continue;

          fullText += content;
          chunkCount += 1;
          charCount += content.length;

          if (typeof onChunk === 'function') {
            try { onChunk(content, { chunkIndex: chunkCount, totalChars: charCount }); } catch {}
          }

          if (typeof onProgress === 'function' && chunkCount % 10 === 0) {
            try { onProgress({ totalChunks: chunkCount, totalChars: charCount }); } catch {}
          }
        } catch (e) {
          logger.warn?.('stream_chat:parse_chunk_error', {
            label: 'UTIL',
            line: trimmed.slice(0, 100),
            error: String(e?.message || e),
          });
        }
      }
    }

    return fullText;
  } finally {
    try { clearTimeout(timer); } catch {}
  }
}

export async function chatCompletion(config) {
  const {
    apiBaseUrl,
    apiKey,
    model,
    messages,
    timeoutMs = 180000,
    temperature = 0.7,
    max_tokens,
    extra = {},
    signal,
  } = config;

  const url = `${apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const { signal: requestSignal, timer } = createRequestSignal({ signal, timeoutMs, model });

  try {
    const requestBody = {
      model,
      messages,
      stream: false,
      temperature,
      ...extra,
    };

    if (typeof max_tokens !== 'undefined') {
      const mt = Number(max_tokens);
      if (Number.isFinite(mt) && mt > 0) requestBody.max_tokens = mt;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: requestSignal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || '';
  } finally {
    try { clearTimeout(timer); } catch {}
  }
}

export default {
  streamChatCompletion,
  chatCompletion,
};
