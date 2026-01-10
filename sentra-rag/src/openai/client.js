import OpenAI from 'openai';
import { getEnv } from '../config/env.js';

export function createOpenAIClient() {
  const apiKey = getEnv('OPENAI_API_KEY', { required: true });
  const baseURL = getEnv('OPENAI_BASE_URL', { defaultValue: undefined });

  return new OpenAI({ apiKey, baseURL: baseURL || undefined });
}
