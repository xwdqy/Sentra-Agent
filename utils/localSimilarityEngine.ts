import { distance as fastLevenshtein } from 'fastest-levenshtein';
import { ConversationAnalyzer } from '../components/gate/analyzer.js';
import { createLogger } from './logger.js';

const logger = createLogger('LocalSimilarityEngine');

type SimilaritySource =
  | 'empty'
  | 'exact'
  | 'prefilter_positive'
  | 'prefilter_negative'
  | 'levenshtein_short'
  | 'analyzer'
  | 'cache';

type SimilarityMetrics = {
  normalizedA: string;
  normalizedB: string;
  lengthRatio: number;
  tokenJaccard: number;
  tokenOverlap: number;
  editSimilarity: number | null;
  jaccardMax: number;
  overlapCoefMax: number;
  simhashNearnessMax: number;
  minhashNearnessMax: number;
  tfidfMaxCosine: number;
  bm25MaxNorm: number;
};

export type LocalSimilarityResult = {
  areSimilar: boolean;
  similarity: number | null;
  source: SimilaritySource;
  reason?: string;
  metrics?: SimilarityMetrics;
  fromCache?: boolean;
};

type CacheEntry = {
  similarity: number | null;
  areSimilar: boolean;
  source: SimilaritySource;
  reason?: string;
  metrics?: SimilarityMetrics;
  expiresAt: number;
  ts: number;
};

const pairCache = new Map<string, CacheEntry>();
let analyzerInstance: ConversationAnalyzer | null = null;

const LOCAL_SIM_DEFAULTS = {
  threshold: 0.42,
  cacheTtlMs: 10 * 60 * 1000,
  cacheMax: 4000,
  lenRatioHardReject: 0.28,
  tokenOverlapHardReject: 0.08,
  tokenJaccardHardReject: 0.05,
  shortTextMaxLen: 32,
  shortTextEditAccept: 0.9,
  prefilterPositiveLenRatio: 0.92,
  prefilterPositiveOverlap: 0.9,
  prefilterPositiveJaccard: 0.72,
  debug: false
} as const;

function getDebug(): boolean {
  return LOCAL_SIM_DEFAULTS.debug;
}

function getThreshold(): number {
  return LOCAL_SIM_DEFAULTS.threshold;
}

function getCacheTtlMs(): number {
  return LOCAL_SIM_DEFAULTS.cacheTtlMs;
}

function getCacheMax(): number {
  return LOCAL_SIM_DEFAULTS.cacheMax;
}

function getLenRatioHardReject(): number {
  return LOCAL_SIM_DEFAULTS.lenRatioHardReject;
}

function getTokenOverlapHardReject(): number {
  return LOCAL_SIM_DEFAULTS.tokenOverlapHardReject;
}

function getTokenJaccardHardReject(): number {
  return LOCAL_SIM_DEFAULTS.tokenJaccardHardReject;
}

function getShortTextLen(): number {
  return LOCAL_SIM_DEFAULTS.shortTextMaxLen;
}

function getShortTextEditAccept(): number {
  return LOCAL_SIM_DEFAULTS.shortTextEditAccept;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeText(input: string): string {
  return String(input || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildUnorderedPairKey(a: string, b: string): string {
  const ha = `${fnv1a32(a)}:${a.length}`;
  const hb = `${fnv1a32(b)}:${b.length}`;
  return ha <= hb ? `${ha}|${hb}` : `${hb}|${ha}`;
}

function tokenizeMixed(text: string): string[] {
  const s = normalizeText(text);
  if (!s) return [];

  const tokens: string[] = [];
  const latin = s.match(/[a-z0-9]+/g) || [];
  for (const t of latin) tokens.push(t);

  const zhBlocks = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const block of zhBlocks) {
    if (block.length <= 2) {
      tokens.push(block);
      continue;
    }
    for (let i = 0; i < block.length - 1; i++) {
      tokens.push(block.slice(i, i + 2));
    }
  }

  if (tokens.length === 0) {
    const fallback = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    tokens.push(...fallback);
  }

  return tokens;
}

function tokenSetSimilarity(a: string, b: string): { jaccard: number; overlap: number } {
  const sa = new Set(tokenizeMixed(a));
  const sb = new Set(tokenizeMixed(b));
  if (sa.size === 0 || sb.size === 0) {
    return { jaccard: 0, overlap: 0 };
  }

  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) inter++;
  }
  const union = sa.size + sb.size - inter;
  const minSet = Math.min(sa.size, sb.size);

  const jaccard = union > 0 ? inter / union : 0;
  const overlap = minSet > 0 ? inter / minSet : 0;
  return { jaccard: clamp01(jaccard), overlap: clamp01(overlap) };
}

function lengthRatio(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la <= 0 || lb <= 0) return 0;
  return Math.min(la, lb) / Math.max(la, lb);
}

function editSimilarity(a: string, b: string): number | null {
  const la = a.length;
  const lb = b.length;
  const maxLen = Math.max(la, lb);
  if (maxLen <= 0) return null;
  try {
    const d = fastLevenshtein(a, b);
    return clamp01(1 - d / maxLen);
  } catch {
    return null;
  }
}

function getAnalyzer(): ConversationAnalyzer | null {
  if (analyzerInstance) return analyzerInstance;
  try {
    analyzerInstance = new ConversationAnalyzer({
      contextWindow: 2,
      maxSimilarity: 1,
      debug: getDebug()
    });
    return analyzerInstance;
  } catch (e) {
    logger.warn('Local analyzer init failed', { err: String(e) });
    analyzerInstance = null;
    return null;
  }
}

function readFeatureAsNumber(features: Record<string, unknown> | undefined, key: string): number {
  const v = features ? features[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : 0;
}

function scoreByAnalyzer(a: string, b: string): {
  score: number;
  metrics: Pick<
    SimilarityMetrics,
    'jaccardMax' | 'overlapCoefMax' | 'simhashNearnessMax' | 'minhashNearnessMax' | 'tfidfMaxCosine' | 'bm25MaxNorm'
  >;
} {
  const analyzer = getAnalyzer();
  if (!analyzer) {
    return {
      score: 0,
      metrics: {
        jaccardMax: 0,
        overlapCoefMax: 0,
        simhashNearnessMax: 0,
        minhashNearnessMax: 0,
        tfidfMaxCosine: 0,
        bm25MaxNorm: 0
      }
    };
  }

  const r = analyzer.analyze(a, [b], {});
  const f = (r?.features || {}) as Record<string, unknown>;

  const jaccardMax = readFeatureAsNumber(f, 'jaccardMax');
  const overlapCoefMax = readFeatureAsNumber(f, 'overlapCoefMax');
  const simhashNearnessMax = readFeatureAsNumber(f, 'simhashNearnessMax');
  const minhashNearnessMax = readFeatureAsNumber(f, 'minhashNearnessMax');
  const tfidfMaxCosine = readFeatureAsNumber(f, 'tfidfMaxCosine');
  const bm25MaxNorm = readFeatureAsNumber(f, 'bm25MaxNorm');

  const lexical = Math.max(jaccardMax, overlapCoefMax);
  const structural = Math.max(simhashNearnessMax, minhashNearnessMax);
  const vectorLike = Math.max(tfidfMaxCosine, bm25MaxNorm);

  const score = clamp01(
    lexical * 0.4 +
    structural * 0.35 +
    vectorLike * 0.25
  );

  return {
    score,
    metrics: {
      jaccardMax,
      overlapCoefMax,
      simhashNearnessMax,
      minhashNearnessMax,
      tfidfMaxCosine,
      bm25MaxNorm
    }
  };
}

function getFromCache(key: string, now: number): CacheEntry | null {
  const item = pairCache.get(key);
  if (!item) return null;
  if (item.expiresAt <= now) {
    pairCache.delete(key);
    return null;
  }
  // refresh LRU order
  pairCache.delete(key);
  pairCache.set(key, item);
  return item;
}

function putCache(key: string, entry: CacheEntry): void {
  pairCache.set(key, entry);
  const max = getCacheMax();
  while (pairCache.size > max) {
    const oldest = pairCache.keys().next().value as string | undefined;
    if (!oldest) break;
    pairCache.delete(oldest);
  }
}

export function clearLocalSimilarityCache(): void {
  pairCache.clear();
}

export function getLocalSimilarityCacheStats(): { size: number; max: number; ttlMs: number } {
  return {
    size: pairCache.size,
    max: getCacheMax(),
    ttlMs: getCacheTtlMs()
  };
}

export function judgeLocalSimilarity(textA: string, textB: string): LocalSimilarityResult {
  const a = normalizeText(textA);
  const b = normalizeText(textB);

  if (!a || !b) {
    return { areSimilar: false, similarity: null, source: 'empty', reason: 'empty_text' };
  }

  if (a === b) {
    return { areSimilar: true, similarity: 1, source: 'exact', reason: 'exact_match' };
  }

  const now = Date.now();
  const cacheKey = buildUnorderedPairKey(a, b);
  const cached = getFromCache(cacheKey, now);
  if (cached) {
    const out: LocalSimilarityResult = {
      areSimilar: cached.areSimilar,
      similarity: cached.similarity,
      source: 'cache',
      fromCache: true
    };
    if (typeof cached.reason === 'string' && cached.reason) {
      out.reason = cached.reason;
    }
    if (cached.metrics) {
      out.metrics = cached.metrics;
    }
    return out;
  }

  const lenRatio = lengthRatio(a, b);
  const tokenSim = tokenSetSimilarity(a, b);
  const maxShortLen = getShortTextLen();
  const canShortEdit = Math.max(a.length, b.length) <= maxShortLen;
  const editSim = canShortEdit ? editSimilarity(a, b) : null;

  const hardRejectByLength = Math.max(a.length, b.length) >= 40 && lenRatio <= getLenRatioHardReject();
  const hardRejectByToken = tokenSim.overlap <= getTokenOverlapHardReject() && tokenSim.jaccard <= getTokenJaccardHardReject();
  if (hardRejectByLength && hardRejectByToken) {
    const result: LocalSimilarityResult = {
      areSimilar: false,
      similarity: 0,
      source: 'prefilter_negative',
      reason: 'hard_reject_prefilter',
      metrics: {
        normalizedA: a,
        normalizedB: b,
        lengthRatio: lenRatio,
        tokenJaccard: tokenSim.jaccard,
        tokenOverlap: tokenSim.overlap,
        editSimilarity: editSim,
        jaccardMax: 0,
        overlapCoefMax: 0,
        simhashNearnessMax: 0,
        minhashNearnessMax: 0,
        tfidfMaxCosine: 0,
        bm25MaxNorm: 0
      }
    };
    putCache(cacheKey, {
      ...result,
      source: 'prefilter_negative',
      expiresAt: now + Math.min(30000, getCacheTtlMs()),
      ts: now
    });
    return result;
  }

  const positiveByToken =
    lenRatio >= LOCAL_SIM_DEFAULTS.prefilterPositiveLenRatio &&
    tokenSim.overlap >= LOCAL_SIM_DEFAULTS.prefilterPositiveOverlap &&
    tokenSim.jaccard >= LOCAL_SIM_DEFAULTS.prefilterPositiveJaccard;
  if (positiveByToken) {
    const score = clamp01(0.92 + tokenSim.jaccard * 0.08);
    const result: LocalSimilarityResult = {
      areSimilar: true,
      similarity: score,
      source: 'prefilter_positive',
      reason: 'high_lexical_overlap',
      metrics: {
        normalizedA: a,
        normalizedB: b,
        lengthRatio: lenRatio,
        tokenJaccard: tokenSim.jaccard,
        tokenOverlap: tokenSim.overlap,
        editSimilarity: editSim,
        jaccardMax: tokenSim.jaccard,
        overlapCoefMax: tokenSim.overlap,
        simhashNearnessMax: 0,
        minhashNearnessMax: 0,
        tfidfMaxCosine: 0,
        bm25MaxNorm: 0
      }
    };
    putCache(cacheKey, {
      ...result,
      source: 'prefilter_positive',
      expiresAt: now + getCacheTtlMs(),
      ts: now
    });
    return result;
  }

  if (typeof editSim === 'number' && editSim >= getShortTextEditAccept()) {
    const result: LocalSimilarityResult = {
      areSimilar: true,
      similarity: editSim,
      source: 'levenshtein_short',
      reason: 'short_text_edit_match',
      metrics: {
        normalizedA: a,
        normalizedB: b,
        lengthRatio: lenRatio,
        tokenJaccard: tokenSim.jaccard,
        tokenOverlap: tokenSim.overlap,
        editSimilarity: editSim,
        jaccardMax: 0,
        overlapCoefMax: 0,
        simhashNearnessMax: 0,
        minhashNearnessMax: 0,
        tfidfMaxCosine: 0,
        bm25MaxNorm: 0
      }
    };
    putCache(cacheKey, {
      ...result,
      source: 'levenshtein_short',
      expiresAt: now + getCacheTtlMs(),
      ts: now
    });
    return result;
  }

  const analyzerScore = scoreByAnalyzer(a, b);
  const score = clamp01(
    analyzerScore.score * 0.85 +
    tokenSim.jaccard * 0.1 +
    tokenSim.overlap * 0.05
  );
  const threshold = getThreshold();
  const areSimilar = score >= threshold;

  const result: LocalSimilarityResult = {
    areSimilar,
    similarity: score,
    source: 'analyzer',
    reason: areSimilar ? 'score_above_threshold' : 'score_below_threshold',
    metrics: {
      normalizedA: a,
      normalizedB: b,
      lengthRatio: lenRatio,
      tokenJaccard: tokenSim.jaccard,
      tokenOverlap: tokenSim.overlap,
      editSimilarity: editSim,
      ...analyzerScore.metrics
    }
  };

  putCache(cacheKey, {
    ...result,
    source: 'analyzer',
    expiresAt: now + getCacheTtlMs(),
    ts: now
  });

  if (getDebug()) {
    logger.debug('Local similarity judged', {
      areSimilar: result.areSimilar,
      similarity: result.similarity,
      threshold,
      reason: result.reason,
      cacheSize: pairCache.size
    });
  }

  return result;
}
