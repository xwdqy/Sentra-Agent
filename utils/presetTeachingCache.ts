import { getEnvInt } from './envHotReloader.js';
import { getRedis } from './redisClient.js';
import { createLogger } from './logger.js';

const logger = createLogger('PresetTeachingCache');

type TeachingExample = Record<string, unknown>;

function sanitizePresetName(raw: string | null | undefined): string {
  const text = (raw || '').trim();
  if (!text) return 'default';
  return text.replace(/\s+/g, '_');
}

function getExamplesKey(presetName: string | null | undefined): string {
  const safeName = sanitizePresetName(presetName);
  const prefix = 'sentra:preset:teaching:examples:';
  return `${prefix}${safeName}`;
}

export async function pushPresetTeachingExample(example: TeachingExample, presetName?: string | null): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    if (!example || typeof example !== 'object') return;

    const key = getExamplesKey(presetName);
    const maxExamplesRaw = getEnvInt('AGENT_PRESET_TEACHING_CACHE_MAX_EXAMPLES', 20);
    const maxExamples = Number.isFinite(maxExamplesRaw) ? Number(maxExamplesRaw) : 20;

    const payload = JSON.stringify(example);
    await redis.lpush(key, payload);
    if (maxExamples > 0) {
      await redis.ltrim(key, 0, maxExamples - 1);
    }
  } catch (e) {
    logger.debug('pushPresetTeachingExample failed', { err: String(e) });
  }
}

export async function getRecentPresetTeachingExamples(limit: number | null | undefined, presetName?: string | null): Promise<TeachingExample[]> {
  try {
    const redis = getRedis();
    if (!redis) return [];

    const key = getExamplesKey(presetName);
    const fallbackRaw = getEnvInt('AGENT_PRESET_TEACHING_CONTEXT_EXAMPLES', 8);
    const fallback = Number.isFinite(fallbackRaw) ? Number(fallbackRaw) : 8;
    const n = Number.isInteger(limit) && Number(limit) > 0 ? Number(limit) : fallback;
    if (!n || n <= 0) return [];

    const rawList = await redis.lrange(key, 0, n - 1);
    if (!Array.isArray(rawList) || rawList.length === 0) return [];

    const examples: TeachingExample[] = [];
    for (const raw of rawList) {
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw) as TeachingExample;
        if (obj && typeof obj === 'object') {
          examples.push(obj);
        }
      } catch {
      }
    }
    return examples;
  } catch (e) {
    logger.debug('getRecentPresetTeachingExamples failed', { err: String(e) });
    return [];
  }
}
