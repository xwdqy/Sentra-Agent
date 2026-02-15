import { createLogger } from './logger.js';
import { getRedis, isRedisReady } from './redisClient.js';
import { getEnvInt } from './envHotReloader.js';

const logger = createLogger('AttentionStats');
type AttentionStats = {
  windowStart: number;
  lastUpdate: number;
  consideredCount: number;
  repliedCount: number;
  sumAnalyzerProb: number;
  sumGateProb: number;
  sumFusedProb: number;
};

type AttentionUpdatePayload = {
  groupId?: string | number | null;
  senderId?: string | number | null;
  analyzerProb?: number;
  gateProb?: number;
  fusedProb?: number;
  didReply?: boolean;
};

const localCache = new Map<string, AttentionStats>();

function makeKey(groupId: string | number | null | undefined, senderId: string | number | null | undefined): string {
  const g = groupId != null ? String(groupId) : '';
  const s = senderId != null ? String(senderId) : '';
  return `att_stats:${g}:${s}`;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function getTtlSec(): number {
  const raw = getEnvInt('ATTENTION_STATS_TTL_SEC', 600);
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 600;
  return raw;
}

function getBaseStats(): AttentionStats {
  return {
    windowStart: 0,
    lastUpdate: 0,
    consideredCount: 0,
    repliedCount: 0,
    sumAnalyzerProb: 0,
    sumGateProb: 0,
    sumFusedProb: 0
  };
}

function coerceNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mergeStats(base: AttentionStats, raw: unknown): AttentionStats {
  if (!raw || typeof raw !== 'object') return { ...base };
  const obj = raw as Record<string, unknown>;
  return {
    windowStart: coerceNumber(obj.windowStart, base.windowStart),
    lastUpdate: coerceNumber(obj.lastUpdate, base.lastUpdate),
    consideredCount: coerceNumber(obj.consideredCount, base.consideredCount),
    repliedCount: coerceNumber(obj.repliedCount, base.repliedCount),
    sumAnalyzerProb: coerceNumber(obj.sumAnalyzerProb, base.sumAnalyzerProb),
    sumGateProb: coerceNumber(obj.sumGateProb, base.sumGateProb),
    sumFusedProb: coerceNumber(obj.sumFusedProb, base.sumFusedProb)
  };
}

export async function loadAttentionStats(
  groupId: string | number | null | undefined,
  senderId: string | number | null | undefined
): Promise<AttentionStats> {
  const key = makeKey(groupId, senderId);
  const base = getBaseStats();
  const redis = getRedis();
  if (!redis || !isRedisReady()) {
    const cached = localCache.get(key);
    return cached ? { ...base, ...cached } : base;
  }
  try {
    const raw = await redis.get(key);
    if (!raw) {
      const cached = localCache.get(key);
      return cached ? { ...base, ...cached } : base;
    }
    const parsed = JSON.parse(raw);
    return mergeStats(base, parsed);
  } catch (e) {
    logger.error('loadAttentionStats failed', { key, err: String(e) });
    const cached = localCache.get(key);
    return cached ? { ...base, ...cached } : base;
  }
}

export async function updateAttentionStatsAfterDecision(payload: AttentionUpdatePayload | null | undefined) {
  if (!payload) return;
  const groupId = payload.groupId;
  const senderId = payload.senderId;
  if (groupId == null || senderId == null) return;
  const key = makeKey(groupId, senderId);
  const now = Date.now();
  const stats = await loadAttentionStats(groupId, senderId);
  if (!stats.windowStart || !Number.isFinite(stats.windowStart)) {
    stats.windowStart = now;
  }
  stats.lastUpdate = now;
  stats.consideredCount = (stats.consideredCount || 0) + 1;
  if (typeof payload.analyzerProb === 'number' && Number.isFinite(payload.analyzerProb)) {
    stats.sumAnalyzerProb = (stats.sumAnalyzerProb || 0) + clamp01(payload.analyzerProb);
  }
  if (typeof payload.gateProb === 'number' && Number.isFinite(payload.gateProb)) {
    stats.sumGateProb = (stats.sumGateProb || 0) + clamp01(payload.gateProb);
  }
  if (typeof payload.fusedProb === 'number' && Number.isFinite(payload.fusedProb)) {
    stats.sumFusedProb = (stats.sumFusedProb || 0) + clamp01(payload.fusedProb);
  }
  if (payload.didReply) {
    stats.repliedCount = (stats.repliedCount || 0) + 1;
  }
  localCache.set(key, stats);
  const redis = getRedis();
  if (!redis || !isRedisReady()) return;
  try {
    const ttl = getTtlSec();
    await redis.set(key, JSON.stringify(stats), 'EX', ttl);
  } catch (e) {
    logger.error('updateAttentionStatsAfterDecision failed', { key, err: String(e) });
  }
}
