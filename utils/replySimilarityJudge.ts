import { createLogger } from './logger.js';
import { computeSemanticSimilarity } from './messageBundler.js';
import { getEnv, getEnvBool } from './envHotReloader.js';
import { ConversationAnalyzer } from '../components/gate/analyzer.js';

const logger = createLogger('ReplySimilarityJudge');

function getSendDedupMinSimilarity(): number {
  const raw = String(getEnv('SEND_FUSION_DEDUP_MIN_SIMILARITY', '0.92') ?? '0.92');
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : 0.92;
}

function getSendDedupLocalDebug(): boolean {
  const v = getEnvBool('SEND_FUSION_DEDUP_LOCAL_DEBUG', false);
  return v === true;
}

function buildAnalyzer(): ConversationAnalyzer | null {
  try {
    return new ConversationAnalyzer({
      contextWindow: 4,
      maxSimilarity: 1,
      debug: getSendDedupLocalDebug()
    });
  } catch (e) {
    logger.warn('初始化 ConversationAnalyzer 失败，将仅使用 Embedding 相似度', { err: String(e) });
    return null;
  }
}

let sharedAnalyzer: ConversationAnalyzer | null = null;

function getAnalyzer(): ConversationAnalyzer | null {
  if (sharedAnalyzer === null) {
    sharedAnalyzer = buildAnalyzer();
  }
  return sharedAnalyzer;
}

function computeLocalSimilarity(a: string, b: string): number | null {
  const analyzer = getAnalyzer();
  if (!analyzer) return null;

  try {
    const result = analyzer.analyze(a, [b], {});
    const f = result && result.features ? result.features : {};
    const sims = [
      typeof f.jaccardMax === 'number' ? f.jaccardMax : null,
      typeof f.overlapCoefMax === 'number' ? f.overlapCoefMax : null,
      typeof f.simhashNearnessMax === 'number' ? f.simhashNearnessMax : null,
      typeof f.minhashNearnessMax === 'number' ? f.minhashNearnessMax : null
    ].filter((x): x is number => typeof x === 'number' && !Number.isNaN(x));

    if (!sims.length) return null;
    return Math.max(...sims);
  } catch (e) {
    logger.warn('本地相似度计算失败，将忽略本地特征', { err: String(e) });
    return null;
  }
}

export async function judgeReplySimilarity(textA: string, textB: string): Promise<{ areSimilar: boolean; similarity: number | null; source: string }> {
  const localDebug = getSendDedupLocalDebug();
  const a = (textA || '').trim();
  const b = (textB || '').trim();
  if (!a || !b) {
    return { areSimilar: false, similarity: null, source: 'none' };
  }

  let embSim = null;
  try {
    embSim = await computeSemanticSimilarity(a, b);
  } catch {
    embSim = null;
  }

  let localSim = null;
  if (a.length <= 512 && b.length <= 512) {
    localSim = computeLocalSimilarity(a, b);
  }

  const embValue = typeof embSim === 'number' && !Number.isNaN(embSim) ? embSim : null;
  const localValue = typeof localSim === 'number' && !Number.isNaN(localSim) ? localSim : null;
  const hasEmb = embValue != null;
  const hasLocal = localValue != null;

  if (localDebug) {
    try {
      logger.debug('judgeReplySimilarity 输入与初始相似度', {
        aPreview: a.slice(0, 80),
        bPreview: b.slice(0, 80),
        embSim,
        localSim,
        hasEmb,
        hasLocal
      });
    } catch {}
  }

  let combined = null;
  if (hasEmb && hasLocal) {
    combined = ((embValue || 0) + (localValue || 0)) / 2;
  } else if (hasEmb) {
    combined = embValue;
  } else if (hasLocal) {
    combined = localValue;
  }

  if (combined == null) {
    return { areSimilar: false, similarity: null, source: 'none' };
  }

  const threshold = getSendDedupMinSimilarity();

  if (localDebug) {
    try {
      logger.debug('judgeReplySimilarity 综合相似度', {
        combined,
        threshold,
        embSim,
        localSim
      });
    } catch {}
  }

  return { areSimilar: combined >= threshold, similarity: combined, source: 'local_only' };
}
