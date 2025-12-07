import { getEnvInt } from './envHotReloader.js';
import { getRedis } from './redisClient.js';
import { createLogger } from './logger.js';

const logger = createLogger('PresetTeachingCache');

function sanitizePresetName(raw) {
  const text = (raw || '').trim();
  if (!text) return 'default';
  return text.replace(/\s+/g, '_');
}

function getExamplesKey(presetName) {
  const safeName = sanitizePresetName(presetName);
  const prefix = 'sentra:preset:teaching:examples:';
  return `${prefix}${safeName}`;
}

export async function pushPresetTeachingExample(example, presetName) {
  try {
    const redis = getRedis();
    if (!redis) return;
    if (!example || typeof example !== 'object') return;

    const key = getExamplesKey(presetName);
    const maxExamples = getEnvInt('AGENT_PRESET_TEACHING_CACHE_MAX_EXAMPLES', 20);

    const payload = JSON.stringify(example);
    await redis.lpush(key, payload);
    if (maxExamples > 0) {
      await redis.ltrim(key, 0, maxExamples - 1);
    }
  } catch (e) {
    logger.debug('pushPresetTeachingExample failed', { err: String(e) });
  }
}

export async function getRecentPresetTeachingExamples(limit, presetName) {
  try {
    const redis = getRedis();
    if (!redis) return [];

    const key = getExamplesKey(presetName);
    const fallback = getEnvInt('AGENT_PRESET_TEACHING_CONTEXT_EXAMPLES', 8);
    const n = Number.isInteger(limit) && limit > 0 ? limit : fallback;
    if (!n || n <= 0) return [];

    const rawList = await redis.lrange(key, 0, n - 1);
    if (!Array.isArray(rawList) || rawList.length === 0) return [];

    const examples = [];
    for (const raw of rawList) {
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
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
