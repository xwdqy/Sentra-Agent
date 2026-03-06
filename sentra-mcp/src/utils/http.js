import axios from 'axios';
import { getRuntimeSignal } from './runtime_context.js';
import { isAbortLikeError, makeAbortError, mergeAbortSignals } from './signal.js';

const instance = axios.create({
  maxRedirects: 5,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

function withRuntimeSignal(config = {}) {
  const cfg = { ...(config || {}) };
  const runtimeSignal = getRuntimeSignal();
  if (!runtimeSignal) return cfg;
  const merged = mergeAbortSignals([cfg.signal, runtimeSignal]);
  if (merged) cfg.signal = merged;
  return cfg;
}

function normalizeRetryNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function buildRetryDelayMs(attempt, { retryBaseMs = 300, retryMaxMs = 8000, retryJitterMs = 0 } = {}) {
  const base = Math.max(0, Number(retryBaseMs) || 0);
  const cap = Math.max(base, Number(retryMaxMs) || 0);
  const jitter = Math.max(0, Number(retryJitterMs) || 0);
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, Number(attempt) || 0)));
  if (jitter <= 0) return exp;
  return exp + Math.floor(Math.random() * jitter);
}

function waitWithSignal(ms, signal) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason || makeAbortError('Retry wait aborted', 'RUN_ABORTED', { delayMs: waitMs }));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { signal.removeEventListener('abort', onAbort); } catch { }
      resolve();
    }, waitMs);
    const onAbort = () => {
      try { clearTimeout(timer); } catch { }
      reject(signal.reason || makeAbortError('Retry wait aborted', 'RUN_ABORTED', { delayMs: waitMs }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function isRetryableHttpError(error, options = {}) {
  if (!error) return false;
  if (isAbortLikeError(error)) return false;
  const retryStatuses = Array.isArray(options.retryStatuses) && options.retryStatuses.length
    ? options.retryStatuses
    : [429, 500, 502, 503, 504];
  const retryCodes = Array.isArray(options.retryCodes) && options.retryCodes.length
    ? options.retryCodes
    : ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNABORTED'];
  const status = Number(error?.response?.status ?? error?.status);
  const code = String(error?.code || '').toUpperCase();
  if (Number.isFinite(status) && retryStatuses.includes(status)) return true;
  if (code && retryCodes.includes(code)) return true;
  return false;
}

instance.interceptors.request.use((cfg) => withRuntimeSignal(cfg));

export async function httpRequest(config = {}) {
  const { timeoutMs, ...rest } = config || {};
  const req = withRuntimeSignal({
    ...rest,
    timeout: timeoutMs,
  });
  return instance.request(req);
}

export async function httpGet(url, options = {}) {
  const { timeoutMs, headers, responseType, validateStatus, signal } = options || {};
  return httpRequest({
    method: 'get',
    url,
    headers,
    responseType,
    validateStatus,
    timeoutMs,
    signal,
  });
}

export async function httpRequestWithRetry(requestConfig = {}, retryOptions = {}) {
  const maxRetries = Math.max(0, normalizeRetryNumber(retryOptions.retries, 0));
  const shouldRetry = typeof retryOptions.shouldRetry === 'function'
    ? retryOptions.shouldRetry
    : (e) => isRetryableHttpError(e, retryOptions);
  const validateResponse = typeof retryOptions.validateResponse === 'function'
    ? retryOptions.validateResponse
    : null;
  const onRetry = typeof retryOptions.onRetry === 'function'
    ? retryOptions.onRetry
    : null;
  const mergedSignal = mergeAbortSignals([retryOptions.signal, requestConfig?.signal, getRuntimeSignal()]);

  let attempt = 0;
  while (true) {
    try {
      const res = await httpRequest({ ...(requestConfig || {}), signal: mergedSignal || requestConfig?.signal });
      if (validateResponse) {
        const ok = await validateResponse(res);
        if (ok === false) {
          const err = new Error('HTTP response validation failed');
          err.response = res;
          throw err;
        }
      }
      return res;
    } catch (error) {
      if (attempt >= maxRetries || !shouldRetry(error)) throw error;
      const delayMs = buildRetryDelayMs(attempt, retryOptions);
      try { onRetry?.({ attempt: attempt + 1, delayMs, error }); } catch { }
      await waitWithSignal(delayMs, mergedSignal);
      attempt += 1;
    }
  }
}

export const httpClient = instance;

export default { httpRequest, httpGet, httpRequestWithRetry, isRetryableHttpError, httpClient };
