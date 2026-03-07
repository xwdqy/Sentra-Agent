import { createLogger } from './logger.js';
import { computeSemanticSimilarity } from './messageBundler.js';
import { getEnv, getEnvBool } from './envHotReloader.js';
import { judgeLocalSimilarity } from './localSimilarityEngine.js';

const logger = createLogger('ReplySimilarityJudge');

type JudgeResult = {
  areSimilar: boolean;
  similarity: number | null;
  source: string;
};

type CacheEntry = JudgeResult & {
  expiresAt: number;
};

const judgeCache = new Map<string, CacheEntry>();

const FINAL_CACHE_TTL_MS = 5 * 60 * 1000;
const FINAL_CACHE_MAX = 3000;

// 本地判定的高/低置信边界：高于上限直接判相似，低于下限直接判不相似，减少 embedding 请求。
const LOCAL_STRONG_SIMILAR = 0.78;
const LOCAL_STRONG_DIFFERENT = 0.12;

// 无 embedding 时的兜底阈值（本地评分尺度）。
const LOCAL_FALLBACK_THRESHOLD = 0.45;

// embedding 兜底时，保留少量本地信号作为稳定项。
const EMBEDDING_BLEND_LOCAL_WEIGHT = 0.2;

function getSendDedupMinSimilarity(): number {
  const raw = String(getEnv('SEND_FUSION_DEDUP_MIN_SIMILARITY', '0.92') ?? '0.92');
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : 0.92;
}

function getSendDedupLocalDebug(): boolean {
  const v = getEnvBool('SEND_FUSION_DEDUP_LOCAL_DEBUG', false);
  return v === true;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function makePairKey(a: string, b: string): string {
  const aa = `${fnv1a32(a)}:${a.length}`;
  const bb = `${fnv1a32(b)}:${b.length}`;
  return aa <= bb ? `${aa}|${bb}` : `${bb}|${aa}`;
}

function getCached(key: string, now: number): JudgeResult | null {
  const item = judgeCache.get(key);
  if (!item) return null;
  if (item.expiresAt <= now) {
    judgeCache.delete(key);
    return null;
  }
  judgeCache.delete(key);
  judgeCache.set(key, item);
  return {
    areSimilar: item.areSimilar,
    similarity: item.similarity,
    source: 'cache'
  };
}

function setCache(key: string, result: JudgeResult, now: number): void {
  judgeCache.set(key, { ...result, expiresAt: now + FINAL_CACHE_TTL_MS });
  while (judgeCache.size > FINAL_CACHE_MAX) {
    const oldest = judgeCache.keys().next().value as string | undefined;
    if (!oldest) break;
    judgeCache.delete(oldest);
  }
}

export async function judgeReplySimilarity(textA: string, textB: string): Promise<JudgeResult> {
  const localDebug = getSendDedupLocalDebug();
  const a = (textA || '').trim();
  const b = (textB || '').trim();
  if (!a || !b) {
    return { areSimilar: false, similarity: null, source: 'none' };
  }

  const now = Date.now();
  const cacheKey = makePairKey(a, b);
  const cached = getCached(cacheKey, now);
  if (cached) return cached;

  const local = judgeLocalSimilarity(a, b);
  const localScore =
    typeof local.similarity === 'number' && Number.isFinite(local.similarity)
      ? clamp01(local.similarity)
      : null;

  if (localDebug) {
    logger.debug('judgeReplySimilarity local stage', {
      aPreview: a.slice(0, 80),
      bPreview: b.slice(0, 80),
      localScore,
      localSource: local.source,
      localReason: local.reason
    });
  }

  if (localScore != null && localScore >= LOCAL_STRONG_SIMILAR) {
    const out: JudgeResult = {
      areSimilar: true,
      similarity: localScore,
      source: `local_strong:${local.source}`
    };
    setCache(cacheKey, out, now);
    return out;
  }

  if (localScore != null && localScore <= LOCAL_STRONG_DIFFERENT) {
    const out: JudgeResult = {
      areSimilar: false,
      similarity: localScore,
      source: `local_reject:${local.source}`
    };
    setCache(cacheKey, out, now);
    return out;
  }

  let embSim: number | null = null;
  try {
    const v = await computeSemanticSimilarity(a, b);
    embSim = typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : null;
  } catch {
    embSim = null;
  }

  if (embSim != null) {
    const threshold = getSendDedupMinSimilarity();
    const combined =
      localScore == null
        ? embSim
        : clamp01(embSim * (1 - EMBEDDING_BLEND_LOCAL_WEIGHT) + localScore * EMBEDDING_BLEND_LOCAL_WEIGHT);

    const out: JudgeResult = {
      areSimilar: combined >= threshold,
      similarity: combined,
      source: 'local_embedding'
    };

    if (localDebug) {
      logger.debug('judgeReplySimilarity embedding fallback', {
        combined,
        threshold,
        embSim,
        localScore,
        areSimilar: out.areSimilar
      });
    }

    setCache(cacheKey, out, now);
    return out;
  }

  if (localScore == null) {
    const out: JudgeResult = { areSimilar: false, similarity: null, source: 'none' };
    setCache(cacheKey, out, now);
    return out;
  }

  const fallback: JudgeResult = {
    areSimilar: localScore >= LOCAL_FALLBACK_THRESHOLD,
    similarity: localScore,
    source: 'local_fallback'
  };
  setCache(cacheKey, fallback, now);
  return fallback;
}

