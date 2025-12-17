import { createLogger } from './logger.js';
import { computeSemanticSimilarity } from './messageBundler.js';
import { decideSendDedupPair } from './replyIntervention.js';
import { getEnv, getEnvBool } from './envHotReloader.js';
import { ConversationAnalyzer } from '../components/gate/analyzer.js';

const logger = createLogger('ReplySimilarityJudge');

const SEND_DEDUP_MIN_SIMILARITY = parseFloat(getEnv('SEND_DEDUP_MIN_SIMILARITY', '0.8'));
const SEND_DEDUP_USE_LLM = getEnvBool('SEND_DEDUP_USE_LLM', false);
const SEND_DEDUP_LOCAL_DEBUG = getEnvBool('SEND_DEDUP_LOCAL_DEBUG', false);

function buildAnalyzer() {
  try {
    return new ConversationAnalyzer({
      contextWindow: 4,
      maxSimilarity: 1,
      debug: SEND_DEDUP_LOCAL_DEBUG
    });
  } catch (e) {
    logger.warn('初始化 ConversationAnalyzer 失败，将仅使用 Embedding 相似度', { err: String(e) });
    return null;
  }
}

let sharedAnalyzer = null;

function getAnalyzer() {
  if (sharedAnalyzer === null) {
    sharedAnalyzer = buildAnalyzer();
  }
  return sharedAnalyzer;
}

function computeLocalSimilarity(a, b) {
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
    ].filter((x) => x != null && !Number.isNaN(x));

    if (!sims.length) return null;
    return Math.max(...sims);
  } catch (e) {
    logger.warn('本地相似度计算失败，将忽略本地特征', { err: String(e) });
    return null;
  }
}

export async function judgeReplySimilarity(textA, textB) {
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

  const hasEmb = typeof embSim === 'number' && !Number.isNaN(embSim);
  const hasLocal = typeof localSim === 'number' && !Number.isNaN(localSim);

  if (SEND_DEDUP_LOCAL_DEBUG) {
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
    combined = (embSim + localSim) / 2;
  } else if (hasEmb) {
    combined = embSim;
  } else if (hasLocal) {
    combined = localSim;
  }

  if (combined == null) {
    if (!SEND_DEDUP_USE_LLM) {
      return { areSimilar: false, similarity: null, source: 'none' };
    }

    const llm = await safeCallLlm(a, b);
    if (llm) {
      return { areSimilar: !!llm.areSimilar, similarity: llm.similarity ?? null, source: 'llm_only' };
    }

    return { areSimilar: false, similarity: null, source: 'none' };
  }

  const threshold = Number.isFinite(SEND_DEDUP_MIN_SIMILARITY) ? SEND_DEDUP_MIN_SIMILARITY : 0.8;
  const useLlm = SEND_DEDUP_USE_LLM;

  if (SEND_DEDUP_LOCAL_DEBUG) {
    try {
      logger.debug('judgeReplySimilarity 综合相似度', {
        combined,
        threshold,
        useLlm,
        embSim,
        localSim
      });
    } catch {}
  }

  if (!useLlm) {
    return { areSimilar: combined >= threshold, similarity: combined, source: 'local_only' };
  }

  if (combined >= threshold + 0.1) {
    return { areSimilar: true, similarity: combined, source: 'local_confident' };
  }
  if (combined <= threshold - 0.1) {
    return { areSimilar: false, similarity: combined, source: 'local_confident' };
  }

  const llm = await safeCallLlm(a, b);
  if (llm && typeof llm.areSimilar === 'boolean') {
    return { areSimilar: llm.areSimilar, similarity: llm.similarity ?? combined, source: 'local+llm' };
  }

  return { areSimilar: combined >= threshold, similarity: combined, source: 'local_fallback' };
}

async function safeCallLlm(a, b) {
  try {
    const r = await decideSendDedupPair(a, b);
    if (r && typeof r.areSimilar === 'boolean') {
      return r;
    }
  } catch (e) {
    logger.warn('调用 LLM 去重判定失败', { err: String(e) });
  }
  return null;
}
