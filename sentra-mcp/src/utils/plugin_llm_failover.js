import { isRetryableHttpError } from './http.js';
import { isAbortLikeError } from './signal.js';
import logger from '../logger/index.js';

function toText(v) {
  return String(v ?? '').trim();
}

function parseBool(value, fallback = false) {
  const s = toText(value).toLowerCase();
  if (!s) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function parseCsv(value, maxItems = 16) {
  const src = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  const seen = new Set();
  for (const one of src) {
    const text = toText(one);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseIntSafe(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

export function resolveModelFailoverPolicy(pluginEnv = {}) {
  const env = (pluginEnv && typeof pluginEnv === 'object') ? pluginEnv : {};
  const enabled = parseBool(
    env.MODEL_FAILOVER_ENABLED ?? process.env.MODEL_FAILOVER_ENABLED,
    true
  );
  const maxModels = Math.max(
    1,
    Math.min(
      8,
      parseIntSafe(env.MODEL_FAILOVER_MAX_MODELS ?? process.env.MODEL_FAILOVER_MAX_MODELS, 4)
    )
  );
  const retryStatuses = parseCsv(
    env.MODEL_FAILOVER_STATUS_CODES ?? process.env.MODEL_FAILOVER_STATUS_CODES ?? '429,500,502,503,504',
    16
  )
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  const retryCodes = parseCsv(
    env.MODEL_FAILOVER_RETRY_CODES
      ?? process.env.MODEL_FAILOVER_RETRY_CODES
      ?? 'ECONNRESET,ETIMEDOUT,EPIPE,EAI_AGAIN,ENOTFOUND,ECONNREFUSED,ECONNABORTED',
    24
  );
  return {
    enabled,
    maxModels,
    retryStatuses: retryStatuses.length ? retryStatuses : [429, 500, 502, 503, 504],
    retryCodes: retryCodes.length ? retryCodes : ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNABORTED'],
  };
}

export function resolvePluginModelCandidates({
  pluginEnv = {},
  primaryKey = '',
  explicitModel = '',
  defaultModel = '',
  fallbackKeys = [],
} = {}) {
  const env = (pluginEnv && typeof pluginEnv === 'object') ? pluginEnv : {};
  const mainKey = toText(primaryKey);
  const explicit = toText(explicitModel);
  const primary = explicit
    || (mainKey ? toText(env[mainKey] ?? process.env[mainKey]) : '')
    || toText(defaultModel);
  const builtins = mainKey
    ? [`${mainKey}_FALLBACKS`, `${mainKey}_FALLBACK_MODELS`, 'MODEL_FALLBACKS']
    : ['MODEL_FALLBACKS'];
  const allFallbackKeys = [...builtins, ...(Array.isArray(fallbackKeys) ? fallbackKeys : [])];
  const fallbackModels = [];
  for (const key of allFallbackKeys) {
    const val = env[key] ?? process.env[key];
    fallbackModels.push(...parseCsv(val, 12));
  }
  return parseCsv([primary, ...fallbackModels], 16);
}

export function shouldFailoverByError(error, policy = {}) {
  if (!error) return false;
  if (isAbortLikeError(error)) return false;
  return isRetryableHttpError(error, {
    retryStatuses: Array.isArray(policy.retryStatuses) ? policy.retryStatuses : undefined,
    retryCodes: Array.isArray(policy.retryCodes) ? policy.retryCodes : undefined,
  });
}

export async function runWithModelFailover({
  models = [],
  policy = {},
  execute,
  tag = 'plugin',
  meta = {},
} = {}) {
  const candidatesRaw = Array.isArray(models) ? models : [];
  const candidates = parseCsv(candidatesRaw, Math.max(1, Number(policy?.maxModels || 4)));
  if (!candidates.length) {
    const err = new Error('MODEL_FAILOVER_NO_CANDIDATES');
    err.code = 'MODEL_FAILOVER_NO_CANDIDATES';
    throw err;
  }
  if (typeof execute !== 'function') {
    const err = new Error('MODEL_FAILOVER_EXECUTOR_REQUIRED');
    err.code = 'MODEL_FAILOVER_EXECUTOR_REQUIRED';
    throw err;
  }
  const failoverEnabled = policy?.enabled !== false;
  let lastError = null;
  const attempts = [];
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    try {
      const value = await execute(model, { attempt: i + 1, total: candidates.length });
      return { value, model, attempt: i + 1, total: candidates.length, attempts };
    } catch (error) {
      lastError = error;
      const canTryNext = i < candidates.length - 1;
      const failoverAllowed = failoverEnabled && canTryNext && shouldFailoverByError(error, policy);
      attempts.push({
        model,
        success: false,
        status: Number(error?.response?.status || 0) || undefined,
        code: toText(error?.code || ''),
        message: toText(error?.message || error),
      });
      if (!failoverAllowed) break;
      logger.warn(`${String(tag || 'plugin')}: model attempt failed, switching model`, {
        label: 'PLUGIN',
        model,
        nextModel: candidates[i + 1],
        status: Number(error?.response?.status || 0) || undefined,
        code: toText(error?.code || ''),
        error: toText(error?.message || error),
        meta,
      });
    }
  }
  const err = lastError instanceof Error ? lastError : new Error(String(lastError || 'MODEL_FAILOVER_FAILED'));
  err.modelFailover = {
    candidates,
    attempts,
    tag: String(tag || 'plugin'),
    meta: (meta && typeof meta === 'object') ? meta : {},
  };
  throw err;
}

export default {
  resolveModelFailoverPolicy,
  resolvePluginModelCandidates,
  shouldFailoverByError,
  runWithModelFailover,
};

