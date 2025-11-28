import { DateTime } from 'luxon';
import { getRedis } from './redisClient.js';
import { createLogger } from './logger.js';

const logger = createLogger('ContextMemory');

const MEMORY_PREFIX = process.env.REDIS_CONTEXT_MEMORY_PREFIX || 'sentra:memory:';
const MEMORY_TTL_SECONDS = parseInt(process.env.REDIS_CONTEXT_MEMORY_TTL_SECONDS || '0', 10) || 0;
const TIMEZONE = process.env.CONTEXT_MEMORY_TIMEZONE || 'Asia/Shanghai';
const CURSOR_SUFFIX = ':cursor';

function getRedisSafe() {
  const redis = getRedis();
  if (!redis) {
    return null;
  }
  return redis;
}

function formatDateFromMillis(ms) {
  try {
    return DateTime.fromMillis(ms).setZone(TIMEZONE).toFormat('yyyy-LL-dd');
  } catch {
    return DateTime.fromMillis(ms).toUTC().toFormat('yyyy-LL-dd');
  }
}

function buildDailyKey(groupId, dateStr) {
  return `${MEMORY_PREFIX}${groupId}:${dateStr}`;
}

function buildCursorKey(groupId) {
  return `${MEMORY_PREFIX}${groupId}${CURSOR_SUFFIX}`;
}

export async function getLastSummarizedPairCount(groupId) {
  try {
    const redis = getRedisSafe();
    if (!redis) return 0;
    const key = buildCursorKey(groupId);
    const val = await redis.get(key);
    if (!val) return 0;
    const n = parseInt(val, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  } catch (e) {
    logger.warn('getLastSummarizedPairCount failed', { groupId, err: String(e) });
    return 0;
  }
}

export async function setLastSummarizedPairCount(groupId, count) {
  try {
    const redis = getRedisSafe();
    if (!redis) return;
    const key = buildCursorKey(groupId);
    const v = Math.max(0, Number.isFinite(count) ? count : 0);
    await redis.set(key, String(v));
  } catch (e) {
    logger.warn('setLastSummarizedPairCount failed', { groupId, err: String(e) });
  }
}

export async function saveContextMemoryItem(groupId, payload) {
  const redis = getRedisSafe();
  if (!redis) return;

  const summary = typeof payload?.summary === 'string' ? payload.summary.trim() : '';
  if (!summary) return;

  const timeStart = typeof payload?.timeStart === 'number' ? payload.timeStart : null;
  const timeEnd = typeof payload?.timeEnd === 'number' ? payload.timeEnd : null;
  const model = typeof payload?.model === 'string' ? payload.model : null;
  const chatType = typeof payload?.chatType === 'string' ? payload.chatType : null;
  const userId = typeof payload?.userId === 'string' ? payload.userId : null;

  const now = Date.now();
  const baseTs = timeStart && Number.isFinite(timeStart) ? timeStart : now;
  const dateStr = formatDateFromMillis(baseTs);
  const key = buildDailyKey(groupId, dateStr);

  const item = {
    groupId,
    date: dateStr,
    timeStart: timeStart && Number.isFinite(timeStart) ? timeStart : null,
    timeEnd: timeEnd && Number.isFinite(timeEnd) ? timeEnd : null,
    summary,
    model,
    chatType,
    userId,
    createdAt: now
  };

  const serialized = JSON.stringify(item);

  try {
    await redis.rpush(key, serialized);
    if (Number.isFinite(MEMORY_TTL_SECONDS) && MEMORY_TTL_SECONDS > 0) {
      await redis.expire(key, MEMORY_TTL_SECONDS);
    }
    logger.info(`saveContextMemoryItem: saved summary for ${groupId} date=${dateStr}`);
  } catch (e) {
    logger.warn('saveContextMemoryItem failed', { groupId, err: String(e) });
  }
}

function formatTimeRangeText(timeStart, timeEnd) {
  if (!timeStart && !timeEnd) {
    return '';
  }

  try {
    const fmt = (ms) => DateTime.fromMillis(ms).setZone(TIMEZONE).toFormat('yyyy-LL-dd HH:mm:ss');
    const hasStart = typeof timeStart === 'number' && timeStart > 0;
    const hasEnd = typeof timeEnd === 'number' && timeEnd > 0;

    if (hasStart && hasEnd) {
      return `${fmt(timeStart)} ~ ${fmt(timeEnd)}\u3010\u672c\u6b21\u8bb0\u5fc6\u7bc7\u8f7d\u7684\u5bf9\u8bdd\u65f6\u95f4\u8303\u56f4\u3011`;
    }
    if (hasStart) {
      return `${fmt(timeStart)} ~ \u5f53\u524d/\u672a\u77e5\u7ec8\u70b9\u3010\u6b64\u6b21\u8bb0\u5fc6\u4ee5\u8fd9\u4e2a\u65f6\u95f4\u4e3a\u8d77\u70b9\u3011`;
    }
    if (hasEnd) {
      return `\u672a\u77e5\u8d77\u70b9 ~ ${fmt(timeEnd)}\u3010\u672c\u6b21\u8bb0\u5fc6\u7d2f\u79ef\u5230\u8fd9\u4e2a\u65f6\u523b\u3011`;
    }
    return '';
  } catch {
    return '';
  }
}

export async function getDailyContextMemoryXml(groupId, nowMs = Date.now()) {
  try {
    const redis = getRedisSafe();
    if (!redis) return '';

    const dateStr = formatDateFromMillis(nowMs);
    const key = buildDailyKey(groupId, dateStr);
    const list = await redis.lrange(key, 0, -1);

    if (!Array.isArray(list) || list.length === 0) {
      return '';
    }

    const items = [];
    for (const raw of list) {
      try {
        const obj = JSON.parse(raw);
        if (!obj || typeof obj.summary !== 'string' || !obj.summary.trim()) continue;
        items.push(obj);
      } catch {
      }
    }

    if (items.length === 0) {
      return '';
    }

    let xml = '<sentra-memory>\n';
    xml += `  <date>${dateStr}</date>\n`;
    xml += '  <items>\n';

    items.forEach((item, index) => {
      const idx = index + 1;
      const rangeText = formatTimeRangeText(item.timeStart, item.timeEnd);
      xml += `    <item index="${idx}">\n`;
      if (rangeText) {
        xml += `      <time_range>${rangeText}</time_range>\n`;
      }
      xml += `      <summary>${item.summary}</summary>\n`;
      xml += '    </item>\n';
    });

    xml += '  </items>\n';
    xml += '</sentra-memory>';

    return xml;
  } catch (e) {
    logger.warn('getDailyContextMemoryXml failed', { groupId, err: String(e) });
    return '';
  }
}
