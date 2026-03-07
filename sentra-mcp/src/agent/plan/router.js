import { config } from '../../config/index.js';
import { embedTexts } from '../../openai/client.js';
import logger from '../../logger/index.js';
import { Metrics } from '../../metrics/index.js';
import { truncateTextByTokens } from '../../utils/tokenizer.js';
import {
  TERMINAL_RUNTIME_AI_NAME,
  pinTerminalRuntimeInManifest
} from '../../runtime/terminal/spec.js';

/**
 * Build a compact tool document for reranking from structured metadata.
 */
export function buildToolDoc(tool) {
  const aiName = String(tool?.aiName || '').trim();
  const name = String(tool?.name || '').trim();
  const description = String(tool?.description || '').trim();
  const schema = (tool?.inputSchema && typeof tool.inputSchema === 'object') ? tool.inputSchema : {};
  const required = Array.isArray(schema.required)
    ? schema.required.map((k) => String(k || '').trim()).filter(Boolean)
    : [];
  const props = (schema.properties && typeof schema.properties === 'object')
    ? schema.properties
    : {};

  const lines = [];
  if (aiName) lines.push(`ai_name: ${aiName}`);
  if (name) lines.push(`name: ${name}`);
  if (description) lines.push(`description: ${description}`);

  if (required.length > 0) {
    lines.push(`required: ${required.join(', ')}`);
    for (const key of required) {
      const field = (props[key] && typeof props[key] === 'object') ? props[key] : {};
      const fieldType = Array.isArray(field.type)
        ? field.type.map((v) => String(v || '').trim()).filter(Boolean).join('|')
        : String(field.type || '').trim();
      const fieldDesc = String(field.description || '').trim();
      if (fieldType || fieldDesc) {
        lines.push(`param.${key}: ${[fieldType, fieldDesc].filter(Boolean).join(' ')}`);
      }
    }
  }

  const doc = lines.join('\n').trim();
  if (!doc) return 'tool';
  return clipRerankTextByTokens(doc, Number(config.rerank?.toolDocMaxTokens ?? 1024));
}

function clipRerankTextByTokens(text, maxTokens) {
  const src = String(text ?? '');
  const limit = Number(maxTokens);
  if (!Number.isFinite(limit) || limit <= 0) return src;
  return truncateTextByTokens(src, {
    maxTokens: Math.max(1, Math.floor(limit)),
    model: config.rerank?.model,
    suffix: ''
  }).text;
}

function fitRerankTextByTokens(text, maxTokens) {
  const src = String(text ?? '');
  const limit = Number(maxTokens);
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      text: src,
      truncated: false
    };
  }
  return truncateTextByTokens(src, {
    maxTokens: Math.max(1, Math.floor(limit)),
    model: config.rerank?.model,
    suffix: ''
  });
}

function buildRerankUrl(baseURL) {
  const root = String(baseURL || 'https://api.siliconflow.cn').replace(/\/+$/, '');
  if (/\/rerank$/i.test(root)) return root;
  if (/\/v\d+$/i.test(root)) return `${root}/rerank`;
  return `${root}/v1/rerank`;
}

export async function rerankDocumentsSiliconFlow({ query, documents, baseURL, apiKey, model, topN, timeoutMs }) {
  const url = buildRerankUrl(baseURL);
  const docsClean = (documents || [])
    .map((d) => (typeof d === 'string' ? d : String(d?.text || '')))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const q = String(query || '').trim();
  if (!q || docsClean.length === 0) {
    throw new Error(`Invalid rerank inputs: query='${q}', docs=${docsClean.length}`);
  }

  const payload = {
    model: model || 'BAAI/bge-reranker-v2-m3',
    query: q,
    documents: docsClean
  };
  if (!Number.isFinite(topN) || Number(topN) <= 0) {
    payload.top_n = docsClean.length;
  } else {
    payload.top_n = Math.max(1, Math.min(Number(topN), docsClean.length));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs || 20000)));
  try {
    logger.debug?.('Rerank request', {
      label: 'RERANK',
      url,
      model: payload.model,
      docs: docsClean.length,
      top_n: payload.top_n
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const previewText = text
        ? clipRerankTextByTokens(text, Number(config.rerank?.errorPreviewMaxTokens ?? 120))
        : '';
      const preview = previewText ? ` ${previewText}` : '';
      throw new Error(`Rerank HTTP ${res.status}:${preview}`);
    }
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.map((r) => ({ index: Number(r.index), score: Number(r.relevance_score || 0) }));
  } finally {
    clearTimeout(timer);
  }
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function normalizeScores(scores = []) {
  const arr = Array.isArray(scores) ? scores.map((v) => Number(v)) : [];
  if (!arr.length) return [];
  const finite = arr.filter((v) => Number.isFinite(v));
  if (!finite.length) return arr.map(() => 0);
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  if (!(hi > lo)) return arr.map(() => 1);
  return arr.map((v) => {
    if (!Number.isFinite(v)) return 0;
    return clamp01((v - lo) / (hi - lo));
  });
}

function median(nums = []) {
  const arr = (Array.isArray(nums) ? nums : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!arr.length) return 0;
  const m = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[m];
  return (arr[m - 1] + arr[m]) / 2;
}

function softmaxProbabilities(scores = [], temperatureRaw = 12) {
  const src = Array.isArray(scores) ? scores.map((v) => Number(v)) : [];
  if (!src.length) return [];
  const t0 = Number(temperatureRaw);
  const temperature = Number.isFinite(t0) && t0 > 0 ? Math.max(1, Math.min(64, t0)) : 12;
  const finite = src.map((v) => (Number.isFinite(v) ? v : 0));
  const scaled = finite.map((v) => v / temperature);
  const maxv = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - maxv));
  const denom = exps.reduce((acc, v) => acc + v, 0);
  if (!(denom > 0)) {
    const p = 1 / src.length;
    return src.map(() => p);
  }
  return exps.map((v) => v / denom);
}

function estimateTaskComplexity(text) {
  const src = String(text || '').trim();
  if (!src) return 1;
  const separators = /[;；。!?！？\n]|然后|并且|并|再|接着|随后|同时|另外|顺便/g;
  const chunks = src
    .split(separators)
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 2);
  const clauseCount = chunks.length || 1;
  const lenFactor = Math.ceil(Math.min(8, src.length / 80));
  const raw = Math.max(clauseCount, lenFactor);
  return Math.max(1, Math.min(8, raw));
}

function normalizeQueryList(objective, externalReasons = []) {
  const out = [];
  const queryMaxTokens = Number(config.rerank?.queryMaxTokens ?? 256);
  const push = (v) => {
    const t = String(v || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    const clipped = clipRerankTextByTokens(t, queryMaxTokens).trim();
    if (!clipped) return;
    out.push(clipped);
  };
  push(objective);
  const reasons = Array.isArray(externalReasons) ? externalReasons : [];
  for (const reason of reasons) {
    push(reason);
  }
  return out;
}

function buildQueryWeights({ objective, queries = [] }) {
  const list = Array.isArray(queries) ? queries : [];
  if (list.length === 0) return [];
  if (list.length === 1) return [1];

  const hasObjective = String(objective || '').replace(/\s+/g, ' ').trim().length > 0;
  if (!hasObjective) {
    const w = 1 / list.length;
    return list.map(() => w);
  }

  const reasonCount = Math.max(0, list.length - 1);
  if (reasonCount <= 0) return [1];

  // Dynamic weighting by reason count (no fixed ratio):
  // objective gets sqrt-prior; each reason gets unit prior.
  const objectiveRaw = Math.sqrt(reasonCount + 1);
  const objectiveWeight = objectiveRaw / (objectiveRaw + reasonCount);
  const reasonWeight = (1 - objectiveWeight) / reasonCount;
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    out.push(i === 0 ? objectiveWeight : reasonWeight);
  }
  const sum = out.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
  if (!(sum > 0)) {
    const w = 1 / list.length;
    return list.map(() => w);
  }
  return out.map((v) => v / sum);
}

function normalizeRuleStringArray(value, { maxItems = 64, maxTokens = 120 } = {}) {
  const src = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    const clipped = clipRerankTextByTokens(text, maxTokens).trim();
    if (!clipped) continue;
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeBoost100(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function parseRegexPattern(raw, { maxTokens = 160 } = {}) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fitted = fitRerankTextByTokens(text, maxTokens);
  if (fitted.truncated) return null;

  let source = text;
  let flags = 'iu';
  const m = text.match(/^\/([\s\S]+)\/([a-z]*)$/i);
  if (m) {
    source = m[1] || '';
    const parsedFlags = String(m[2] || '')
      .split('')
      .filter((f) => 'imsuy'.includes(f.toLowerCase()));
    flags = Array.from(new Set(parsedFlags)).join('') || 'iu';
  }
  if (!source) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function extractRerankSignals(tool = {}) {
  const t = (tool && typeof tool === 'object') ? tool : {};
  const meta = (t.meta && typeof t.meta === 'object') ? t.meta : {};
  const rr = (meta.rerank && typeof meta.rerank === 'object') ? meta.rerank : {};
  const keywordMaxItems = Math.max(1, Number(config.rerank?.triggerKeywordMaxItems ?? 64));
  const patternMaxItems = Math.max(1, Number(config.rerank?.triggerPatternMaxItems ?? 32));
  const keywordMaxTokens = Math.max(1, Number(config.rerank?.triggerKeywordMaxTokens ?? 80));
  const patternMaxTokens = Math.max(1, Number(config.rerank?.triggerPatternMaxTokens ?? 160));
  const triggerKeywords = normalizeRuleStringArray(
    rr.triggerKeywords ?? rr.trigger_keywords ?? t.trigger_keywords ?? t.triggerKeywords,
    { maxItems: keywordMaxItems, maxTokens: keywordMaxTokens }
  );
  const triggerPatterns = normalizeRuleStringArray(
    rr.triggerPatterns ?? rr.trigger_patterns ?? t.trigger_patterns ?? t.triggerPatterns,
    { maxItems: patternMaxItems, maxTokens: patternMaxTokens }
  );
  const keywordBoost = normalizeBoost100(rr.keywordBoost ?? rr.keyword_boost ?? t.keyword_boost ?? t.keywordBoost);
  const regexBoost = normalizeBoost100(rr.regexBoost ?? rr.regex_boost ?? t.regex_boost ?? t.regexBoost);
  return { triggerKeywords, triggerPatterns, keywordBoost, regexBoost };
}

function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const x = Number(a[i] || 0);
    const y = Number(b[i] || 0);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!(na > 0) || !(nb > 0)) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function buildRuleMatchText({ objective, externalReasons = [] }) {
  const parts = [];
  const maxTokens = Number(config.rerank?.ruleMatchMaxTokens ?? 640);
  const push = (v) => {
    const t = String(v || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    parts.push(t);
  };
  push(objective);
  const reasons = Array.isArray(externalReasons) ? externalReasons : [];
  for (const reason of reasons) {
    push(reason);
  }
  const merged = parts.join('\n');
  if (!merged) return '';
  return clipRerankTextByTokens(merged, maxTokens);
}

function computeKeywordRegexSignal(tool, matchText) {
  const text = String(matchText || '').trim();
  const haystack = clipRerankTextByTokens(text, Number(config.rerank?.signalTextMaxTokens ?? 320));
  if (!haystack) {
    return {
      score01: 0,
      keywordHitRatio: 0,
      regexHitRatio: 0,
      keywordBoost: 0,
      regexBoost: 0
    };
  }

  const sig = extractRerankSignals(tool);
  const keywords = sig.triggerKeywords;
  const patterns = sig.triggerPatterns;
  const keywordBoost01 = clamp01((sig.keywordBoost || 0) / 100);
  const regexBoost01 = clamp01((sig.regexBoost || 0) / 100);

  const lower = haystack.toLowerCase();
  let keywordHits = 0;
  if (keywords.length > 0) {
    for (const kw of keywords) {
      const key = String(kw || '').trim();
      if (!key) continue;
      const keyLower = key.toLowerCase();
      if (keyLower && lower.includes(keyLower)) keywordHits += 1;
    }
  }
  const keywordHitRatio = keywords.length > 0 ? clamp01(keywordHits / keywords.length) : 0;

  let regexHits = 0;
  let regexTotal = 0;
  if (patterns.length > 0) {
    const regexPatternMaxTokens = Number(config.rerank?.regexPatternMaxTokens ?? 160);
    for (const p of patterns) {
      const re = parseRegexPattern(p, { maxTokens: regexPatternMaxTokens });
      if (!re) continue;
      regexTotal += 1;
      try {
        if (re.test(haystack)) regexHits += 1;
      } catch { }
    }
  }
  const regexHitRatio = regexTotal > 0 ? clamp01(regexHits / regexTotal) : 0;

  const keywordScore = keywordBoost01 * keywordHitRatio;
  const regexScore = regexBoost01 * regexHitRatio;

  const keywordEnabled = keywords.length > 0 && keywordBoost01 > 0;
  const regexEnabled = patterns.length > 0 && regexBoost01 > 0;
  let weightKeyword = 0;
  let weightRegex = 0;
  if (keywordEnabled && regexEnabled) {
    weightKeyword = 0.4;
    weightRegex = 0.6;
  } else if (regexEnabled) {
    weightRegex = 1;
  } else if (keywordEnabled) {
    weightKeyword = 1;
  }

  const score01 = clamp01((weightKeyword * keywordScore) + (weightRegex * regexScore));
  return {
    score01,
    keywordHitRatio,
    regexHitRatio,
    keywordBoost: sig.keywordBoost,
    regexBoost: sig.regexBoost
  };
}

function resolveAggWeights() {
  // Fixed aggregation priors (no env/config tuning).
  const aa = 0.1;
  const bb = 0.5;
  const cc = 0.4;
  const sum = aa + bb + cc;
  return {
    alpha: aa / sum,
    beta: bb / sum,
    gamma: cc / sum
  };
}

function cosineScoresForQuery(qv = [], dvs = []) {
  return (Array.isArray(dvs) ? dvs : []).map((v) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const len = Math.min(v.length, qv.length);
    for (let i = 0; i < len; i += 1) {
      const x = qv[i];
      const y = v[i];
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  });
}

function resolveMetricsIdentity(tool = {}) {
  const name = String(tool?.name || '').trim();
  if (!name) return null;

  const provider = String(tool?.provider || '').trim();
  if (provider) return { name, provider };

  const aiName = String(tool?.aiName || '').trim();
  if (aiName.startsWith('local__')) return { name, provider: 'local' };
  if (aiName.startsWith('ext__')) {
    const m = aiName.match(/^ext__([^_].*?)__/);
    if (m && m[1]) return { name, provider: `external:${m[1]}` };
  }
  return { name, provider: 'local' };
}

async function applyTrustAwareCut({
  manifest,
  rankedIndices,
  rankedScores,
  ruleMatchText = '',
  objective = '',
  externalReasons = [],
  docVectors = []
}) {
  const MIN_KEEP = 6;
  const EXPLORE_KEEP = 3;
  const PROB_RHO = clamp01(Number(config.rerank?.coverageRho ?? 0.9)) || 0.9;
  const SOFTMAX_TEMP = Number(config.rerank?.softmaxTemperature ?? 12);
  const COVERAGE_RATIO_TARGET = clamp01(Number(config.rerank?.coverageRatioTarget ?? 0.85)) || 0.85;
  const SET_PENALTY = Number.isFinite(Number(config.rerank?.setPenalty))
    ? Number(config.rerank?.setPenalty)
    : 6;
  const TRUST_BONUS = Number.isFinite(Number(config.rerank?.setTrustBonus))
    ? Number(config.rerank?.setTrustBonus)
    : 3;
  const PROB_BONUS = Number.isFinite(Number(config.rerank?.setProbBonus))
    ? Number(config.rerank?.setProbBonus)
    : 5;
  const DIVERSITY_PENALTY = Number.isFinite(Number(config.rerank?.mmrDiversityPenalty))
    ? Number(config.rerank?.mmrDiversityPenalty)
    : 8;
  const SEED_ENABLE = config.rerank?.seedByIntent !== false;

  const indices = (Array.isArray(rankedIndices) ? rankedIndices : [])
    .filter((v) => Number.isInteger(v) && v >= 0 && v < manifest.length);
  const scores = Array.isArray(rankedScores) ? rankedScores : [];
  if (!indices.length) {
    return { indices: [], scores: [], details: [], debug: { before: 0, after: 0, keepBase: 0, exploreAdded: 0 } };
  }

  const normRel = normalizeScores(indices.map((_, i) => scores[i] ?? 0));

  const metricsList = await Promise.all(indices.map(async (idx) => {
    const tool = manifest[idx] || {};
    const identity = resolveMetricsIdentity(tool);
    if (!identity) return { calls: 0, success: 0, failure: 0, avgLatencyMs: 0 };
    try {
      return await Metrics.getSummary(identity.name, identity.provider);
    } catch {
      return { calls: 0, success: 0, failure: 0, avgLatencyMs: 0 };
    }
  }));

  const latencyBase = median(metricsList.map((m) => Number(m?.avgLatencyMs || 0)).filter((v) => v > 0));
  const rows = indices.map((index, i) => {
    const m = metricsList[i] || {};
    const calls = Number(m.calls || 0);
    const success = Number(m.success || 0);
    const avgLatencyMs = Number(m.avgLatencyMs || 0);
    const relevance01 = clamp01(normRel[i] ?? 0);
    const trustBayes01 = clamp01((success + 1) / (calls + 2));
    const callsConfidence = clamp01(calls / (calls + 10));
    const trust01 = clamp01((0.5 * (1 - callsConfidence)) + (trustBayes01 * callsConfidence));
    const latencyRaw01 = latencyBase > 0
      ? clamp01(latencyBase / (latencyBase + Math.max(0, avgLatencyMs)))
      : 1;
    const signal = computeKeywordRegexSignal(manifest[index] || {}, ruleMatchText);
    const intent = clamp01(signal.score01) * 100;
    const relevance = relevance01 * 100;
    const trust = trust01 * 100;
    const latencyPenalty = 70 + (30 * latencyRaw01);
    // Percentile weighted score:
    // relevance is primary, intent-rules are secondary, trust third, latency weak.
    const final = (relevance * 0.54) + (intent * 0.26) + (trust * 0.16) + (latencyPenalty * 0.04);
    return {
      index,
      relevance,
      intent,
      trust,
      latencyPenalty,
      final,
      calls,
      keywordHitRatio: signal.keywordHitRatio,
      regexHitRatio: signal.regexHitRatio,
      keywordBoost: signal.keywordBoost,
      regexBoost: signal.regexBoost,
      probability: 0,
      docVec: Array.isArray(docVectors[index]) ? docVectors[index] : []
    };
  });

  const sorted = rows.slice().sort((a, b) => (b.final - a.final) || (b.relevance - a.relevance));
  const n = sorted.length;
  if (n <= MIN_KEEP) {
    const details = sorted.map((r, rank) => ({
      rank: rank + 1,
      index: r.index,
      aiName: String(manifest[r.index]?.aiName || ''),
      final: r.final,
      intent: r.intent,
      trust: r.trust,
      relevance: r.relevance,
      latencyPenalty: r.latencyPenalty,
      calls: r.calls,
      keywordHitRatio: r.keywordHitRatio,
      regexHitRatio: r.regexHitRatio,
      keywordBoost: r.keywordBoost,
      regexBoost: r.regexBoost,
      probability: r.probability
    }));
    return {
      indices: sorted.map((r) => r.index),
      scores: sorted.map((r) => r.final),
      details,
      debug: { before: n, after: n, keepBase: n, exploreAdded: 0 }
    };
  }

  const probs = softmaxProbabilities(sorted.map((r) => r.final), SOFTMAX_TEMP);
  for (let i = 0; i < sorted.length; i += 1) {
    sorted[i].probability = Number(probs[i] || 0);
  }

  let cumulativeProb = 0;
  let probK = n;
  for (let i = 0; i < n; i += 1) {
    cumulativeProb += Number(sorted[i].probability || 0);
    if (cumulativeProb >= PROB_RHO) {
      probK = i + 1;
      break;
    }
  }
  const intents = normalizeQueryList(objective, externalReasons);
  const intentTexts = intents.length > 0 ? intents : [String(objective || '').trim() || ruleMatchText || ''];
  const intentCount = intentTexts.length;
  const complexity = estimateTaskComplexity(objective);
  const complexityCap = Math.max(MIN_KEEP, Math.min(n, 6 + (complexity * 4)));
  const rawTargetK = Math.max(MIN_KEEP, Math.min(n, probK));
  const targetK = Math.min(rawTargetK, complexityCap);
  const complexityNeed = clamp01((complexity - 2) / 6);
  const intentNeed = clamp01((intentCount - 1) / 2);
  const keepNeed = Math.max(complexityNeed, intentNeed);
  const keepRatio = 0.45 + (0.35 * keepNeed);
  const keepFloor = Math.max(
    MIN_KEEP,
    Math.min(
      targetK,
      Math.max(MIN_KEEP + 1, Math.round(targetK * keepRatio))
    )
  );
  const poolK = Math.max(targetK, Math.min(n, Math.max(targetK * 3, targetK + 8)));
  const pool = sorted.slice(0, poolK);

  const totalCoverageCeil = Math.max(1, intentCount * 100);
  const seedCoverageNeed = SEED_ENABLE && intentTexts.length >= 2 && complexity >= 3;
  const diversityComplexityScale = 1 - (0.65 * clamp01((complexity - 1) / 7));
  const baseDiversityPenalty = DIVERSITY_PENALTY * diversityComplexityScale;

  for (const row of pool) {
    const tool = manifest[row.index] || {};
    row.intentRel = intentTexts.map((txt, idx) => {
      const s = computeKeywordRegexSignal(tool, txt);
      const signalScore = clamp01(Number(s.score01 || 0)) * 100;
      if (idx === 0) {
        return Math.max(signalScore, row.relevance * 0.65);
      }
      return signalScore;
    });
  }

  const selected = [];
  const selectedSet = new Set();
  const coverage = intentTexts.map(() => 0);
  let coverageSum = 0;
  let selectedProb = 0;
  const applyPick = (row) => {
    if (!row || selectedSet.has(row.index)) return;
    selected.push(row);
    selectedSet.add(row.index);
    selectedProb += Number(row.probability || 0);
    coverageSum = 0;
    for (let i = 0; i < coverage.length; i += 1) {
      coverage[i] = Math.max(Number(coverage[i] || 0), Number(row.intentRel?.[i] || 0));
      coverageSum += coverage[i];
    }
  };
  const evaluateGain = (row) => {
    const rel = Array.isArray(row.intentRel) ? row.intentRel : [];
    let nextCoverageSum = 0;
    for (let i = 0; i < coverage.length; i += 1) {
      const rv = Number(rel[i] || 0);
      nextCoverageSum += Math.max(Number(coverage[i] || 0), rv);
    }
    const deltaCoverage = nextCoverageSum - coverageSum;
    const trust01 = clamp01(Number(row.trust || 0) / 100);
    const prob01 = clamp01(Number(row.probability || 0));
    const currentCoverageRatio = totalCoverageCeil > 0 ? (coverageSum / totalCoverageCeil) : 0;
    const coverageLift01 = clamp01(deltaCoverage / Math.max(1, totalCoverageCeil));
    const diversityGate = 0.55;
    let redundancy = 0;
    if (selected.length > 0 && currentCoverageRatio >= diversityGate) {
      const curVec = Array.isArray(row.docVec) ? row.docVec : [];
      for (const s of selected) {
        const sim = cosineSimilarity(curVec, Array.isArray(s.docVec) ? s.docVec : []);
        if (sim > redundancy) redundancy = sim;
      }
    }
    const diversityRelax = 1 - (0.7 * coverageLift01);
    const effectiveDiversityPenalty = baseDiversityPenalty * diversityRelax;
    const gain = deltaCoverage
      - SET_PENALTY
      + (TRUST_BONUS * trust01)
      + (PROB_BONUS * prob01 * 10)
      - (effectiveDiversityPenalty * redundancy);
    return { gain, nextCoverageSum };
  };

  // Seed coverage by intent: ensure each intent gets at least one strong candidate before greedy loop.
  if (seedCoverageNeed) {
    const seeds = [];
    for (let i = 0; i < intentTexts.length; i += 1) {
      let best = null;
      for (const row of pool) {
        if (selectedSet.has(row.index)) continue;
        const rel = Number(row.intentRel?.[i] || 0);
        const score = rel + (0.08 * Number(row.relevance || 0)) + (0.05 * Number(row.trust || 0));
        if (!best || score > best.score) {
          best = { row, score };
        }
      }
      if (best && Number.isFinite(best.score) && best.score > 0) seeds.push(best);
    }
    seeds
      .sort((a, b) => b.score - a.score)
      .forEach((s) => {
        if (selected.length >= targetK) return;
        applyPick(s.row);
      });
  }

  while (selected.length < targetK) {
    let best = null;
    for (const row of pool) {
      if (selectedSet.has(row.index)) continue;
      const scored = evaluateGain(row);
      if (!best || scored.gain > best.gain) {
        best = { row, gain: scored.gain, nextCoverageSum: scored.nextCoverageSum };
      }
    }
    if (!best) break;
    if (best.gain <= 0 && selected.length >= keepFloor) break;
    applyPick(best.row);
    const coverageRatio = coverageSum / totalCoverageCeil;
    if (selected.length >= keepFloor && selectedProb >= PROB_RHO && coverageRatio >= COVERAGE_RATIO_TARGET) {
      break;
    }
  }

  if (selected.length < keepFloor) {
    for (const row of sorted) {
      if (selected.length >= keepFloor) break;
      if (selectedSet.has(row.index)) continue;
      applyPick(row);
    }
  }

  const kept = selected
    .slice()
    .sort((a, b) => (b.final - a.final) || (b.relevance - a.relevance) || (b.probability - a.probability));

  const explore = sorted
    .filter((r) => !selectedSet.has(r.index))
    .sort((a, b) => (a.calls - b.calls) || (b.probability - a.probability) || (b.final - a.final))
    .slice(0, EXPLORE_KEEP);

  const finalRows = kept.concat(explore).sort((a, b) => (b.final - a.final) || (b.probability - a.probability));
  const details = finalRows.map((r, rank) => ({
    rank: rank + 1,
    index: r.index,
    aiName: String(manifest[r.index]?.aiName || ''),
    final: r.final,
    intent: r.intent,
    trust: r.trust,
    relevance: r.relevance,
    latencyPenalty: r.latencyPenalty,
    calls: r.calls,
    keywordHitRatio: r.keywordHitRatio,
    regexHitRatio: r.regexHitRatio,
    keywordBoost: r.keywordBoost,
    regexBoost: r.regexBoost,
    probability: r.probability
  }));
  return {
    indices: finalRows.map((r) => r.index),
    scores: finalRows.map((r) => r.final),
    details,
    debug: {
      before: n,
      after: finalRows.length,
      keepBase: kept.length,
      exploreAdded: explore.length,
      maxGapAfter50: 0,
      probK,
      rawTargetK,
      targetK,
      keepFloor,
      probRho: PROB_RHO,
      selectedProb: Number(selectedProb.toFixed(4)),
      coverageRatio: Number((coverageSum / totalCoverageCeil).toFixed(4)),
      intentCount,
      complexity,
      complexityCap,
      keepRatio: Number(keepRatio.toFixed(3))
    }
  };
}

export async function rerankManifest({ manifest, objective, externalReasons = [] }) {
  if (!Array.isArray(manifest)) return { manifest: [], indices: [], scores: [] };
  if (manifest.length === 0) return { manifest: [], indices: [], scores: [] };

  const baseManifest = pinTerminalRuntimeInManifest(manifest, { insertIfMissing: true });
  const runtimeEntry = baseManifest.find((m) => String(m?.aiName || '').trim() === TERMINAL_RUNTIME_AI_NAME) || null;
  const candidateManifest = baseManifest.filter((m) => String(m?.aiName || '').trim() !== TERMINAL_RUNTIME_AI_NAME);

  if (candidateManifest.length === 0) {
    return {
      manifest: baseManifest,
      indices: baseManifest.map((_, i) => i),
      scores: []
    };
  }

  const queries = normalizeQueryList(objective, externalReasons);
  if (queries.length === 0) {
    return {
      manifest: baseManifest,
      indices: baseManifest.map((_, i) => i),
      scores: []
    };
  }
  const query = String(queries[0] || '').trim();
  const queryWeights = buildQueryWeights({ objective, queries });
  const hasObjective = String(objective || '').replace(/\s+/g, ' ').trim().length > 0;
  const ruleMatchText = buildRuleMatchText({ objective, externalReasons });

  const docs = candidateManifest.map((t) => buildToolDoc(t));

  try {
    const embs = await embedTexts({ texts: [...queries, ...docs] });
    const queryVecs = embs.slice(0, queries.length);
    const dvs = embs.slice(queries.length);
    const simMatrix = queryVecs.map((qv) => cosineScoresForQuery(qv || [], dvs));
    const coarseScores = docs.map((_, i) => {
      const arr = simMatrix.map((row) => Number(row?.[i] ?? 0)).filter((v) => Number.isFinite(v));
      if (arr.length === 0) return 0;
      const weightedMean = simMatrix.reduce((acc, row, qi) => {
        const w = Number(queryWeights?.[qi] ?? 0);
        const s = Number(row?.[i] ?? 0);
        if (!Number.isFinite(w) || !Number.isFinite(s)) return acc;
        return acc + (w * s);
      }, 0);
      const max = Math.max(...arr);
      return (0.85 * weightedMean) + (0.15 * max);
    });
    const orderByCos = coarseScores.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s);
    const preIdx = orderByCos.map((x) => x.i);
    const prePairs = preIdx
      .map((i) => ({ i, text: String(docs[i] || '').trim() }))
      .filter((p) => !!p.text);
    const preDocs = prePairs.map((p) => p.text);
    const coarseByIdx = new Map(prePairs.map((p) => [p.i, Number(coarseScores[p.i] ?? 0)]));

    const enable = (config.rerank?.enable !== false)
      && String(process.env.RERANK_ENABLE || 'true').toLowerCase() !== 'false';
    const apiKey = process.env.RERANK_API_KEY || config.rerank?.apiKey || '';
    const finalTopN = preDocs.length;

    let rankedIndices = [];
    let rankedScores = [];

    if (enable && apiKey) {
      try {
        const queryTasks = queries.map((q, qIndex) => rerankDocumentsSiliconFlow({
          query: q,
          documents: preDocs,
          baseURL: process.env.RERANK_BASE_URL || config.rerank?.baseURL,
          apiKey,
          model: process.env.RERANK_MODEL || config.rerank?.model,
          topN: finalTopN,
          timeoutMs: Number(process.env.RERANK_TIMEOUT_MS || config.rerank?.timeoutMs || 20000)
        }).then((results) => ({
          qIndex,
          qWeight: Number(queryWeights?.[qIndex] ?? 0),
          results
        })));
        const settled = await Promise.allSettled(queryTasks);
        const valid = settled
          .filter((it) => it.status === 'fulfilled')
          .map((it) => it.value)
          .filter((it) => Array.isArray(it?.results) && it.results.length > 0);

        if (valid.length > 0) {
          const { alpha, beta, gamma } = resolveAggWeights();
          const stats = new Map(prePairs.map((p) => [p.i, { hitWeight: 0, scoreWeightSum: 0, rrWeightSum: 0 }]));
          const totalWeightUsed = valid.reduce((acc, item) => {
            const w = Number(item?.qWeight);
            if (!Number.isFinite(w) || w <= 0) return acc;
            return acc + w;
          }, 0) || 1;

          for (const item of valid) {
            const qWeight = Number(item?.qWeight);
            if (!Number.isFinite(qWeight) || qWeight <= 0) continue;
            const rows = (item.results || [])
              .filter((r) => Number.isInteger(r.index) && r.index >= 0)
              .map((r) => {
                const idx = prePairs[r.index]?.i;
                const score = Number(r.score);
                return {
                  idx,
                  score: Number.isFinite(score) ? score : 0
                };
              })
              .filter((r) => Number.isInteger(r.idx));
            if (rows.length === 0) continue;
            const norm = normalizeScores(rows.map((r) => r.score));
            for (let rank = 0; rank < rows.length; rank += 1) {
              const row = rows[rank];
              const st = stats.get(row.idx);
              if (!st) continue;
              st.hitWeight += qWeight;
              st.scoreWeightSum += qWeight * Number(norm[rank] ?? 0);
              st.rrWeightSum += qWeight * (1 / (rank + 1));
            }
          }

          const merged = [];
          for (const [idx, st] of stats.entries()) {
            const freq = st.hitWeight / totalWeightUsed;
            const scoreAvg = st.hitWeight > 0 ? (st.scoreWeightSum / st.hitWeight) : 0;
            const rrAvg = st.rrWeightSum / totalWeightUsed;
            const score = (alpha * freq) + (beta * scoreAvg) + (gamma * rrAvg);
            merged.push({ idx, score, coarse: Number(coarseByIdx.get(idx) ?? 0) });
          }
          merged.sort((a, b) => (b.score - a.score) || (b.coarse - a.coarse));
          const picked = merged.slice(0, finalTopN);
          rankedIndices = picked.map((x) => x.idx);
          rankedScores = picked.map((x) => x.score);
          const rankedManifest = rankedIndices.map((i) => candidateManifest[i]);
          logger.info?.('Online rerank completed', {
            label: 'RERANK',
            topN: rankedIndices.length,
            topAi: rankedManifest?.[0]?.aiName,
            query,
            queryCount: queries.length,
            effectiveQueryCount: valid.length,
            objectiveWeight: hasObjective ? Number(queryWeights?.[0] ?? 0) : 0,
            reasonsWeight: hasObjective
              ? Number(queryWeights.slice(1).reduce((acc, w) => acc + (Number.isFinite(w) ? Number(w) : 0), 0))
              : 1
          });
        } else {
          logger.warn?.('Online rerank returned no valid query results, fallback to cosine ranking', {
            label: 'RERANK',
            query,
            queryCount: queries.length,
            preDocs: preDocs.length,
            finalTopN
          });
        }
      } catch (e) {
        logger.warn?.('Online rerank failed, fallback to cosine ranking', {
          label: 'RERANK',
          error: String(e),
          query,
          queryCount: queries.length,
          preDocs: preDocs.length,
          finalTopN
        });
      }
    }

    if (rankedIndices.length === 0) {
      const fallbackTopN = prePairs.length || preIdx.length;
      const rankedFallback = (prePairs.length ? prePairs.map((p) => p.i) : preIdx)
        .map((i) => ({ i, score: Number(coarseScores[i] ?? 0) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, fallbackTopN);
      rankedIndices = rankedFallback.map((x) => x.i);
      rankedScores = rankedFallback.map((x) => x.score);
      const rankedManifest = rankedIndices.map((i) => candidateManifest[i]);
      logger.info?.('Cosine rerank completed', {
        label: 'RERANK',
        topN: rankedIndices.length,
        topAi: rankedManifest?.[0]?.aiName,
        topScore: rankedScores?.[0],
        queryCount: queries.length
      });
    }

    const trustCut = await applyTrustAwareCut({
      manifest: candidateManifest,
      rankedIndices,
      rankedScores,
      ruleMatchText,
      objective,
      externalReasons,
      docVectors: dvs
    });
    const cutIndices = Array.isArray(trustCut?.indices) ? trustCut.indices : rankedIndices;
    const cutScores = Array.isArray(trustCut?.scores) ? trustCut.scores : rankedScores;
    const cutDetails = Array.isArray(trustCut?.details) ? trustCut.details : [];
    const cutManifest = cutIndices.map((i) => candidateManifest[i]).filter(Boolean);
    const finalManifest = pinTerminalRuntimeInManifest(
      runtimeEntry ? [...cutManifest, runtimeEntry] : cutManifest,
      { insertIfMissing: true }
    );
    const finalScoreByAiName = new Map();
    for (let i = 0; i < cutManifest.length; i += 1) {
      const aiName = String(cutManifest[i]?.aiName || '').trim();
      if (!aiName) continue;
      const s = Number(cutScores[i] ?? 0);
      finalScoreByAiName.set(aiName, Number.isFinite(s) ? s : 0);
    }
    const finalScores = finalManifest.map((m) => {
      const aiName = String(m?.aiName || '').trim();
      return Number(finalScoreByAiName.get(aiName) ?? 0);
    });

    logger.info?.('Rerank trust-aware cut applied', {
      label: 'RERANK',
      before: rankedIndices.length,
      after: cutIndices.length,
      keepBase: trustCut?.debug?.keepBase,
      exploreAdded: trustCut?.debug?.exploreAdded,
      maxGapAfter50: trustCut?.debug?.maxGapAfter50,
      probK: trustCut?.debug?.probK,
      rawTargetK: trustCut?.debug?.rawTargetK,
      targetK: trustCut?.debug?.targetK,
      keepFloor: trustCut?.debug?.keepFloor,
      probRho: trustCut?.debug?.probRho,
      selectedProb: trustCut?.debug?.selectedProb,
      coverageRatio: trustCut?.debug?.coverageRatio,
      intentCount: trustCut?.debug?.intentCount,
      complexity: trustCut?.debug?.complexity,
      complexityCap: trustCut?.debug?.complexityCap,
      keepRatio: trustCut?.debug?.keepRatio
    });

    if (cutDetails.length > 0) {
      logger.debug?.('Rerank scored tools', {
        label: 'RERANK',
        tools: cutDetails.map((d) => ({
          rank: d.rank,
          aiName: d.aiName,
            final: Number(d.final?.toFixed?.(2) || 0),
            intent: Number(d.intent?.toFixed?.(2) || 0),
            trust: Number(d.trust?.toFixed?.(2) || 0),
            relevance: Number(d.relevance?.toFixed?.(2) || 0),
            probability: Number(d.probability?.toFixed?.(4) || 0),
            keywordHitRatio: Number(d.keywordHitRatio?.toFixed?.(3) || 0),
            regexHitRatio: Number(d.regexHitRatio?.toFixed?.(3) || 0)
          }))
      });
    }

    return { manifest: finalManifest, indices: cutIndices, scores: finalScores, details: cutDetails };
  } catch (e) {
    logger.warn?.('Rerank exception, use original manifest', { label: 'RERANK', error: String(e) });
    return { manifest: baseManifest, indices: baseManifest.map((_, i) => i), scores: [] };
  }
}

export default { buildToolDoc, rerankDocumentsSiliconFlow, rerankManifest };
