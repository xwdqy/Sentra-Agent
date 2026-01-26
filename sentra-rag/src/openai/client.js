import OpenAI from 'openai';
import { getEnv, getEnvNumber } from '../config/env.js';

function normalizeOpenAIBaseUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return raw;
  const root = raw.replace(/\/+$/, '');
  if (/\/v\d+$/i.test(root)) return root;
  return `${root}/v1`;
}

export function createChatOpenAIClient() {
  const apiKey = getEnv('CHAT_API_KEY', { required: true });
  const baseURL = normalizeOpenAIBaseUrl(getEnv('CHAT_BASE_URL', { required: true }));
  const timeout = getEnvNumber('CHAT_TIMEOUT_MS', { defaultValue: 60000 });

  return new OpenAI({ apiKey, baseURL, timeout });
}

export function createEmbeddingOpenAIClient() {
  const apiKey = getEnv('EMBEDDING_API_KEY', { required: true });
  const baseURL = normalizeOpenAIBaseUrl(getEnv('EMBEDDING_BASE_URL', { required: true }));
  const timeout = getEnvNumber('EMBEDDING_TIMEOUT_MS', { defaultValue: 60000 });

  return new OpenAI({ apiKey, baseURL, timeout });
}

export function readRerankConfig() {
  return {
    enable: String(getEnv('RERANK_ENABLE', { defaultValue: 'false' })).trim().toLowerCase() === 'true',
    baseURL: getEnv('RERANK_BASE_URL', { defaultValue: '' }),
    apiKey: getEnv('RERANK_API_KEY', { defaultValue: '' }),
    model: getEnv('RERANK_MODEL', { defaultValue: '' }),
    timeoutMs: getEnvNumber('RERANK_TIMEOUT_MS', { defaultValue: 12000 }),
    candidateK: getEnvNumber('RERANK_CANDIDATE_K', { defaultValue: 40 }),
    topN: getEnvNumber('RERANK_TOP_N', { defaultValue: 20 }),
  };
}
