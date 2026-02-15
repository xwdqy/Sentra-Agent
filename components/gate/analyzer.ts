// - 概率：线性加权 + 温度/Platt/分段校准 + 多通道一致性驱动的“不确定性收缩”。
// - 去除一切硬编码 CTA 关键词；CTA 通过结构特征 + 可配置规则引擎实现（无内置词表）。

import emojiRegex from 'emoji-regex';
import LinkifyIt from 'linkify-it';
import stringSimilarity from 'string-similarity';
import { franc } from 'franc';
import nlp from 'compromise';
import winkUtils from 'wink-nlp-utils';
import natural from 'natural';
import leven from 'leven';
import { distance as fastLeven } from 'fastest-levenshtein';
import { createRequire } from 'node:module';
import { createLogger } from '../../utils/logger.js';

const require = createRequire(import.meta.url);
const logger = createLogger('ConversationAnalyzer');

type LangCode = string;

type IntentRuleFn = (text: string, lang: LangCode) => number;
type IntentRule = {
  lang?: LangCode;
  type?: 'regex' | 'fn';
  pattern?: string;
  flags?: string;
  weight?: number;
  fn?: IntentRuleFn;
};
type RuleMatch = { type: 'regex' | 'fn'; weight: number; pattern?: string };
type IntentRuleEngine = {
  score: (text: string, lang: LangCode) => number;
  matched: (text: string, lang: LangCode) => RuleMatch[];
};

type StopwordLib = { en?: string[] };
type StopwordsIsoLib = Record<string, string[]>;
type BadWordsFilterCtor = new () => { isProfane: (word: string) => boolean };
type SensitiveWordFilterLike =
  | { filter: (text: string) => string }
  | (new () => { filter: (text: string) => string });
type SentimentZhFn = (text: string) => { score?: number; comparative?: number; positive?: number; negative?: number };

type SegmentInstance = { doSegment: (text: string, options?: { simple?: boolean }) => string[] };
type SegmentModule = { Segment: new () => SegmentInstance; useDefault: (seg: SegmentInstance) => void };
const segmentit = require('segmentit') as SegmentModule;
const { Segment, useDefault } = segmentit;

type Bm25SearchHit = { score?: number };
type Bm25Instance = {
  defineConfig: (cfg: { fldWeights: Record<string, number> }) => void;
  definePrepTasks: (tasks: Array<(s: string) => string | string[]>) => void;
  addDoc: (doc: { text: string }, id: number) => void;
  consolidate: () => void;
  search: (query: string) => Bm25SearchHit[];
};
type Bm25Factory = () => Bm25Instance;

let bm25Factory: Bm25Factory | null = null; try { bm25Factory = require('wink-bm25-text-search') as Bm25Factory; } catch {}
let sw: StopwordLib | null = null; try { sw = require('stopword') as StopwordLib; } catch {}
let stopwordsIso: StopwordsIsoLib | null = null; try { stopwordsIso = require('stopwords-iso') as StopwordsIsoLib; } catch {}
let BadWordsFilter: BadWordsFilterCtor | null = null; try { BadWordsFilter = require('bad-words') as BadWordsFilterCtor; } catch {}
let BadWordsChinese = null;

try {
  const m = require('bad-words-chinese');
  BadWordsChinese = m?.default || m;
} catch (e) {
  logger.warn('`bad-words-chinese` not installed, Chinese compliance check will be limited.', { err: String(e) });
}

let SensitiveWordFilter: SensitiveWordFilterLike | null = null;
try {
  const m = require('sensitive-word-filter');
  SensitiveWordFilter = m?.default || m;
} catch (e) {
  logger.warn('`sensitive-word-filter` not installed, Chinese compliance check will be limited.', { err: String(e) });
}

let sentimentZh: SentimentZhFn | null = null;
try {
  const m = require('sentiment-zh_cn_web');
  sentimentZh = m?.default || m;
} catch (e) {
  logger.warn('`sentiment-zh_cn_web` not installed, Chinese sentiment features will be disabled.', { err: String(e) });
}

const linkify = new LinkifyIt();
const segment: SegmentInstance = new Segment();
useDefault(segment);

type PunctConfig = { questionMarks?: string[]; questionBonus?: number };

type NlpSentenceJson = { terms?: Array<{ text?: string; tags?: string[] }> };
type NlpSentenceDoc = { out: (format: string) => string[]; json: () => NlpSentenceJson[] };
type NlpDoc = { sentences: () => NlpSentenceDoc };

type IntentFns = {
  question?: (text: string, lang: LangCode, ctx: { doc: NlpDoc | null; tokensNoStop: string[]; tokensAll: string[]; punctCfg: PunctConfig }) => number;
  cta?: (text: string, lang: LangCode, ctx: { doc: NlpDoc | null; tokensNoStop: string[]; tokensAll: string[]; features: AnalysisFeatures; ruleScore: number }) => number;
  urgency?: (text: string, lang: LangCode, ctx: { capsRatio: number; punctIntensity: number }) => number;
  ack?: (text: string, lang: LangCode, ctx: { totalTokens: number; semanticScore: number; hasQuestionPunct: boolean; hasLink: boolean }) => number;
};

type ComplianceConfig = {
  enabled?: boolean;
  thresholds?: { flag?: number; block?: number };
  zhDetector?: ((text: string, tokens?: string[] | null) => { score?: number; matches?: number }) | undefined;
};

type CalibrationConfig = {
  temperature?: number;
  platt?: { a?: number; b?: number } | null;
  isotonic?: Array<{ x: number; y: number }> | null;
  shrinkAmbiguity?: number;
};

type RepeatPenaltyConfig = { maxPenalty?: number; minFactor?: number; threshold?: number | null };

type Weights = {
  intercept: number;
  question: number;
  link: number;
  length: number;
  entropy: number;
  semantic: number;
  noveltyChar: number;
  noveltyTfidf: number;
  noveltyBm25: number;
  noveltyJaccard: number;
  callToAction: number;
  youMention: number;
  urgency: number;
  emojiPenalty: number;
  capsPenalty: number;
  toxicityPenaltyEn: number;
  toxicityPenaltyZh: number;
  repetitionPenalty: number;
  histCompositePenalty: number;
  shortUtterancePenalty: number;
  ackPenalty: number;
  punctPenalty: number;
  repeatCharPenalty: number;
  digitPenalty: number;
  urlPenalty: number;
  codePenalty: number;
  mentionBonus: number;
  uniqueCharBonus: number;
  simhashPenalty: number;
  senderFatiguePenalty: number;
  groupFatiguePenalty: number;
  senderReplyRatePenalty: number;
  groupReplyRatePenalty: number;
  followupBonus: number;
  explicitMentionBonus: number;
  sessionValence: number;
  sessionSaturationPenalty: number;
};

type AnalyzerConfig = {
  minTextLength?: number;
  minEntropy?: number;
  minTokens?: number;
  maxSimilarity?: number;
  validTokenRatio?: number;
  contextWindow?: number;
  replyThreshold?: number;
  linkFallback?: boolean;
  historyHardBlock?: number;
  softQuestionMin?: number;
  softCtaMin?: number;
  repeatPenalty?: RepeatPenaltyConfig;
  punct?: PunctConfig;
  weights?: Weights;
  stopwords?: StopwordConfig;
  intentFns?: IntentFns;
  compliance?: ComplianceConfig;
  calibration?: CalibrationConfig;
  resources?: { ctaRules?: IntentRule[] } & Record<string, unknown>;
  debug?: boolean;
} & Record<string, unknown>;

type AnalyzerConfigResolved = AnalyzerConfig & {
  minTextLength: number;
  minEntropy: number;
  minTokens: number;
  maxSimilarity: number;
  validTokenRatio: number;
  contextWindow: number;
  replyThreshold: number;
  linkFallback: boolean;
  historyHardBlock: number;
  softQuestionMin: number;
  softCtaMin: number;
  repeatPenalty: RepeatPenaltyConfig;
  punct: PunctConfig;
  weights: Weights;
  stopwords: StopwordConfig;
  intentFns: IntentFns;
  compliance: ComplianceConfig;
  calibration: CalibrationConfig;
  resources: { ctaRules?: IntentRule[] } & Record<string, unknown>;
  debug: boolean;
};

type AnalysisFeatures = {
  cleanText?: string;
  hasLink?: boolean;
  urlCount?: number;
  mentionCount?: number;
  hasCode?: boolean;
  emojiCount?: number;
  entropy?: number;
  language?: string;
  tokens?: string[];
  tokensAll?: string[];
  totalTokens?: number;
  meaningfulTokens?: number;
  semanticScore?: number;
  maxSimilarity?: number;
  tfidfMaxCosine?: number;
  jaccardMax?: number;
  overlapCoefMax?: number;
  bm25Max?: number;
  bm25MaxNorm?: number;
  simhashNearnessMax?: number;
  minhashNearnessMax?: number;
  youMention?: number;
  capsRatio?: number;
  emojiRatio?: number;
  punctIntensity?: number;
  repeatCharRatio?: number;
  uniqueCharRatio?: number;
  digitRatio?: number;
  length?: number;
  senderFatigue?: number;
  groupFatigue?: number;
  senderReplyRate?: number;
  groupReplyRate?: number;
  followup?: number;
  explicitMention?: number;
  sessionValence?: number;
  sessionSaturation?: number;
  questionness?: number;
  callToAction?: number;
  urgency?: number;
  ack?: number;
  ctaRuleScore?: number;
  toxicityEn?: number;
  toxicityZh?: number;
  linkFallback?: boolean;
  histCompositeSim?: number;
  ctaRuleMatches?: RuleMatch[];
  [key: string]: unknown;
};

type PolicyDetail = { kind: string; score: number; matches?: number };

type AnalysisResult = {
  original: string;
  isWorthReplying: boolean;
  probability: number;
  score: number;
  confidence: number;
  features: AnalysisFeatures;
  reasons: string[];
  policy: { action: 'none' | 'flag' | 'block' | 'allow'; details: PolicyDetail[] };
  breakdown?: Array<{ name: string; val: number; weight: number; contrib: number }>;
};

type RuleEngines = { cta?: IntentRuleEngine };

type AttentionSession = {
  consideredCount?: number;
  repliedCount?: number;
  avgGateProb?: number;
  replyRatio?: number;
};

type SignalFeatures = {
  senderFatigue?: number;
  groupFatigue?: number;
  senderReplyCountWindow?: number;
  groupReplyCountWindow?: number;
  isFollowupAfterBotReply?: boolean;
  mentionedByAt?: boolean;
  mentionedByName?: boolean;
  attentionSession?: AttentionSession;
};

type AnalyzerMeta = SignalFeatures & { signals?: SignalFeatures };

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const isLikelyChinese = (t: string): boolean => /[\u4e00-\u9fff]/.test(t);
const isLikelyLatin = (t: string): boolean => /[A-Za-z]/.test(t);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function toHalfWidth(str: string): string {
  return (str || '').replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}
function normalizeForMatch(str: string): string { return toHalfWidth(str).toLowerCase().replace(/\s+/g, ' ').trim(); }

// ---------------- resources & rules ----------------
function compileIntentRules(rules: IntentRule[] | null | undefined): IntentRuleEngine {
  // rules: [{ lang: 'zho'|'eng'|'*', type: 'regex'|'fn', pattern, flags, weight(0..1), fn(text, lang)->0..1 }]
  if (!Array.isArray(rules) || !rules.length) {
    return { score: () => 0, matched: () => [] };
  }
  const compiled: Array<{
    kind: 'fn' | 'regex';
    lang: LangCode;
    weight: number;
    fn?: IntentRuleFn;
    regex?: RegExp;
    pattern?: string;
  }> = [];
  for (const r of rules) {
    if (!r) continue;
    const lang = r.lang || '*';
    const w = isNum(r.weight) ? clamp(r.weight, 0, 1) : 0.3;
    if (r.type === 'fn' && typeof r.fn === 'function') {
      compiled.push({ kind: 'fn', lang, weight: w, fn: r.fn });
    } else if (r.type === 'regex' && typeof r.pattern === 'string') {
      try {
        const re = new RegExp(r.pattern, r.flags || 'i');
        compiled.push({ kind: 'regex', lang, weight: w, regex: re, pattern: r.pattern });
      } catch {}
    }
  }
  function score(text: string, lang: LangCode): number {
    if (!compiled.length || !text) return 0;
    let probNoHit = 1; // combine via noisy-or: 1 - Π(1 - w_i)
    for (const r of compiled) {
      if (r.lang !== '*' && r.lang !== lang) continue;
      try {
        let hit = 0;
        if (r.kind === 'regex' && r.regex) hit = r.regex.test(text) ? 1 : 0;
        else if (r.kind === 'fn' && r.fn) hit = clamp(r.fn(text, lang) || 0, 0, 1);
        if (hit > 0) probNoHit *= (1 - r.weight);
      } catch {}
    }
    return clamp(1 - probNoHit, 0, 1);
  }
  function matched(text: string, lang: LangCode): RuleMatch[] {
    const m: RuleMatch[] = [];
    for (const r of compiled) {
      if (r.lang !== '*' && r.lang !== lang) continue;
      try {
        if (r.kind === 'regex' && r.regex && r.regex.test(text)) {
          const entry: RuleMatch = r.pattern
            ? { type: 'regex', weight: r.weight, pattern: r.pattern }
            : { type: 'regex', weight: r.weight };
          m.push(entry);
        }
        if (r.kind === 'fn' && r.fn) {
          const v = clamp(r.fn(text, lang) || 0, 0, 1);
          if (v > 0) m.push({ type: 'fn', weight: r.weight });
        }
      } catch {}
    }
    return m;
  }
  return { score, matched };
}

type StopwordConfig = { en?: Set<string> | string[]; zh?: Set<string> | string[] };

function buildStopwords(config: { stopwords?: StopwordConfig } | null | undefined): { en: Set<string>; zh: Set<string> } {
  let en = new Set<string>();
  if (config?.stopwords?.en instanceof Set) en = config.stopwords.en;
  else if (Array.isArray(config?.stopwords?.en)) en = new Set(config.stopwords.en);
  else if (sw?.en) en = new Set(sw.en);

  let zh = new Set<string>();
  if (config?.stopwords?.zh instanceof Set) zh = config.stopwords.zh;
  else if (Array.isArray(config?.stopwords?.zh)) zh = new Set(config.stopwords.zh);
  else if (stopwordsIso) {
    const keys = ['zh', 'zh-cn', 'zh-tw', 'zh-hans', 'zh-hant'];
    const collected = [];
    for (const k of keys) { const arr = stopwordsIso[k]; if (Array.isArray(arr)) collected.push(...arr); }
    if (collected.length) zh = new Set(collected);
  }
  return { en, zh };
}

function countCapsRatio(str: string): number {
  const letters = str.match(/[A-Za-z]/g) || [];
  if (!letters.length) return 0;
  const caps = letters.filter(c => c === c.toUpperCase());
  return caps.length / letters.length;
}

// tokenization
function englishTokensAll(text: string): string[] { const doc = nlp(text); return doc.terms().out('array') || []; }
function englishTokensNoStop(text: string, stopSet: Set<string>): string[] {
  const ts = englishTokensAll(text);
  return ts.map(t => t.toLowerCase()).filter(t => t && !stopSet.has(t) && !/^\d+$/.test(t));
}
function chineseTokensAll(text: string): string[] { return segment.doSegment(text, { simple: true }) || []; }
function chineseTokensNoStop(text: string, stopSet: Set<string>): string[] {
  const segs = chineseTokensAll(text);
  return segs.filter(w => w && !stopSet.has(w) && !/^\d+$/.test(w));
}

// char n-gram fallback
function charShingles(str: string, n = 2): string[] {
  const s = winkUtils.string.removePunctuations(str || '').replace(/\s+/g, '');
  const out: string[] = []; for (let i = 0; i <= s.length - n; i++) out.push(s.slice(i, i + n));
  return out;
}

// ---------------- similarities ----------------
function cosineSimFromVectors(vecA: Record<string, number>, vecB: Record<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  const keys = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  for (const k of keys) { const a = vecA[k] || 0, b = vecB[k] || 0; dot += a*b; na += a*a; nb += b*b; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
type TfidfLike = { listTerms: (idx: number) => Array<{ term: string; tfidf: number }> };
function vectorizeTfidf(tfidf: TfidfLike, idx: number): Record<string, number> { const terms = tfidf.listTerms(idx); const v: Record<string, number> = Object.create(null); for (const t of terms) v[t.term] = t.tfidf; return v; }

function maxTfidfCosineSimilarityNatural(currentTokens: string[], historyTokenLists: string[][]): number {
  if (!historyTokenLists.length) return 0;
  const tfidf = new natural.TfIdf();
  const docs = [currentTokens, ...historyTokenLists];
  docs.forEach(d => tfidf.addDocument(d));
  const curVec = vectorizeTfidf(tfidf, 0);
  let maxCos = 0;
  for (let i = 1; i < docs.length; i++) {
    const vec = vectorizeTfidf(tfidf, i);
    maxCos = Math.max(maxCos, cosineSimFromVectors(curVec, vec));
  }
  return maxCos;
}
function maxTfidfCosineSimilarityManual(currentTokens: string[], historyTokenLists: string[][]): number {
  const docs = [currentTokens, ...historyTokenLists].filter(Array.isArray);
  if (!docs.length || !currentTokens.length || !historyTokenLists.length) return 0;
  const N = docs.length;
  const dfs = Object.create(null);
  const tfs = docs.map((tokens) => {
    const tf: Record<string, number> = Object.create(null), seen = new Set<string>();
    for (const t of tokens as string[]) { tf[t] = (tf[t] || 0) + 1; if (!seen.has(t)) { dfs[t] = (dfs[t] || 0) + 1; seen.add(t); } }
    return tf;
  });
  const idf: Record<string, number> = Object.create(null);
  Object.keys(dfs).forEach((t) => { const df = dfs[t]; idf[t] = Math.log(1 + (N / (1 + df))); });
  function vecOf(i: number): Record<string, number> {
    const tf = tfs[i] || Object.create(null);
    const v: Record<string, number> = Object.create(null);
    for (const [t, f] of Object.entries(tf)) v[t] = (1 + Math.log(Number(f))) * (idf[t] || 0);
    return v;
  }
  const curVec = vecOf(0);
  let maxCos = 0; for (let i = 1; i < docs.length; i++) maxCos = Math.max(maxCos, cosineSimFromVectors(curVec, vecOf(i)));
  return maxCos;
}

function jaccardMax(currentTokens: string[], historyTokenLists: string[][]): number {
  if (!historyTokenLists.length || !currentTokens.length) return 0;
  const A = new Set(currentTokens); let maxJ = 0;
  for (const tks of historyTokenLists) {
    const B = new Set(tks); let inter = 0; for (const x of A) if (B.has(x)) inter++;
    const uni = A.size + B.size - inter || 1; maxJ = Math.max(maxJ, inter / uni);
  } return maxJ;
}
function overlapCoefMax(currentTokens: string[], historyTokenLists: string[][]): number {
  if (!historyTokenLists.length || !currentTokens.length) return 0;
  const A = new Set(currentTokens); let maxO = 0;
  for (const tks of historyTokenLists) {
    const B = new Set(tks); let inter = 0; for (const x of A) if (B.has(x)) inter++;
    const denom = Math.min(A.size, B.size) || 1; maxO = Math.max(maxO, inter / denom);
  } return maxO;
}

// SimHash (32-bit) for robustness on short/mixed texts
function hash32(s: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return h >>> 0;
}
function simhash32(tokens: string[]): number {
  const V = new Array(32).fill(0);
  for (const t of tokens || []) {
    const h = hash32(t);
    for (let i = 0; i < 32; i++) V[i] += ((h >>> i) & 1) ? 1 : -1;
  }
  let sig = 0 >>> 0; for (let i = 0; i < 32; i++) if (V[i] > 0) sig |= (1 << i);
  return sig >>> 0;
}
function hamming32(a: number, b: number): number { let x = (a ^ b) >>> 0; let c = 0; while (x) { x &= x - 1; c++; } return c; }
function simhashNearnessMax(curTokens: string[], histTokenLists: string[][]): number {
  if (!histTokenLists.length || !curTokens.length) return 0;
  const cur = simhash32(curTokens); let max = 0;
  for (const tks of histTokenLists) {
    if (!tks || !tks.length) continue;
    const d = hamming32(cur, simhash32(tks));
    const near = 1 - d / 32; // 0..1
    if (near > max) max = near;
  } return max;
}

// MinHash (character shingles) for LSH-like similarity
function rand32(seed: number): () => number {
  // xorshift32
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return x >>> 0;
  };
}
function makeHashers(k = 64, seed = 1337): (x: number) => number[] {
  const next = rand32(seed);
  const a: number[] = []; const b: number[] = [];
  for (let i = 0; i < k; i++) { a.push((next() | 1) >>> 0); b.push((next() | 1) >>> 0); }
  // universal hashing: h_i(x) = (a_i * x + b_i) mod 2^32
  return (x: number) => {
    const out = new Array<number>(k);
    for (let i = 0; i < k; i++) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
      out[i] = ((Math.imul(ai, x >>> 0) + bi) >>> 0);
    }
    return out;
  };
}
function minhashSignature(tokens: string[], k = 64, seed = 1337): number[] {
  const hasher = makeHashers(k, seed);
  const INF = 0xffffffff >>> 0;
  const sig = new Array<number>(k).fill(INF);
  for (const t of tokens || []) {
    const x = hash32(String(t));
    const hv = hasher(x);
    for (let i = 0; i < k; i++) {
      const v = hv[i];
      const cur = sig[i];
      if (typeof v === 'number' && typeof cur === 'number' && v < cur) sig[i] = v;
    }
  }
  return sig;
}
function minhashJaccard(sigA: number[], sigB: number[]): number {
  if (!Array.isArray(sigA) || !Array.isArray(sigB) || sigA.length !== sigB.length || sigA.length === 0) return 0;
  let eq = 0; for (let i = 0; i < sigA.length; i++) if (sigA[i] === sigB[i]) eq++;
  return eq / sigA.length;
}
function minhashNearnessMax(text: string, historyTexts: string[], n = 3, k = 64): number {
  if (!historyTexts?.length || !text) return 0;
  const s = charShingles(text, n);
  const curSig = minhashSignature(s, k);
  let maxS = 0;
  for (const h of historyTexts) {
    const hs = charShingles(h || '', n);
    const sig = minhashSignature(hs, k);
    const sim = minhashJaccard(curSig, sig);
    if (sim > maxS) maxS = sim;
  }
  return maxS;
}

// BM25
function normBm25Score(raw: number): number { const K = 8; return (isNum(raw) && raw > 0) ? (raw / (raw + K)) : 0; }
function bm25MaxManual(queryTokens: string[], docsTokens: string[][], k1 = 1.5, b = 0.75): number {
  const docs = docsTokens.filter(Array.isArray); if (!docs.length || !queryTokens.length) return 0;
  const N = docs.length, df: Record<string, number> = Object.create(null);
  const tfDocs = docs.map((tokens) => {
    const tf: Record<string, number> = Object.create(null), seen = new Set<string>();
    for (const t of tokens as string[]) { tf[t] = (tf[t] || 0) + 1; if (!seen.has(t)) { df[t] = (df[t] || 0) + 1; seen.add(t); } }
    return tf;
  });
  const docLens = tfDocs.map((tf) => Object.values(tf).reduce((a, b) => a + Number(b), 0));
  const avgdl = docLens.reduce((a,b)=>a+b,0) / N || 1;
  function scoreDoc(i: number): number {
    const tf = tfDocs[i];
    const dl = docLens[i] || 0;
    if (!tf) return 0;
    let s = 0;
    for (const t of queryTokens) {
      const f = tf[t] || 0; if (!f) continue;
      const dft = df[t] || 0; const idf = Math.log(((N - dft + 0.5) / (dft + 0.5)) + 1);
      const denom = f + k1 * (1 - b + b * (dl / avgdl)); s += idf * ((f * (k1 + 1)) / (denom || 1));
    } return s;
  }
  let maxS = 0; for (let i = 0; i < docs.length; i++) maxS = Math.max(maxS, scoreDoc(i)); return maxS;
}

// ---------------- intents & structure ----------------
function punctuationIntensity(text: string): number {
  if (!text) return 0;
  const ex = (text.match(/!/g) || []).length, qn = (text.match(/\?/g) || []).length, dots = (text.match(/\.{3,}/g) || []).length, len = text.length;
  return clamp((ex * 1.0 + qn * 0.8 + dots * 0.6) / Math.max(10, len), 0, 1);
}
function repeatCharRatio(text: string): number { if (!text) return 0; const m = text.match(/(.)\1{2,}/g) || []; return clamp(m.length / Math.max(5, text.length / 10), 0, 1); }
function uniqueCharRatio(text: string): number { if (!text) return 0; const set = new Set(text.replace(/\s+/g, '')); return clamp(set.size / Math.max(1, text.length), 0, 1); }
function digitRatio(text: string): number { if (!text) return 0; const d = (text.match(/\d/g) || []).length; return clamp(d / text.length, 0, 1); }
function shortUtteranceScore(totalTokens: number, hasQP: boolean, hasLink: boolean): number { const s = clamp(1 - (totalTokens / 5), 0, 1); const protect = Math.max(hasQP ? 0.6 : 0, hasLink ? 0.4 : 0); return Math.max(0, s * (1 - protect)); }

function defaultQuestionScore(text: string, lang: LangCode, doc: NlpDoc | null, punctCfg: PunctConfig | undefined): number {
  const sentences = (doc && doc.sentences && doc.sentences().out('array')) || [text];
  const qm = punctCfg?.questionMarks || ['?', '？']; const hasQP = qm.some((ch) => text.includes(ch));
  let qEnds = 0; for (const s of sentences) if (qm.some((ch) => s.trim().endsWith(ch))) qEnds++;
  const frac = sentences.length ? (qEnds / sentences.length) : 0; const bonus = hasQP ? (punctCfg?.questionBonus || 0.4) : 0;
  return clamp(bonus + frac * (1 - bonus), 0, 1);
}

// 新版 CTA 评分：无硬编码关键词，结构信号 + 可配置规则引擎
function defaultCtaScore(text: string, lang: LangCode, { doc, features, ruleScore }: { doc: NlpDoc | null; features: AnalysisFeatures; ruleScore: number }): number {
  const mNorm = clamp((features?.mentionCount || 0) / 3, 0, 1);
  const urgencyProxy = clamp(0.6 * (features?.punctIntensity || 0) + 0.4 * (features?.capsRatio || 0), 0, 1);
  let base = clamp(0.65 * mNorm + 0.35 * urgencyProxy, 0, 1);

  // 英文：动词起始的祈使句增强（仍不依赖词表）
  if (lang === 'eng' && doc) {
    try {
      const sents = doc.sentences().json();
      let imp = 0, tot = 0;
      for (const s of sents) {
        const terms = (s.terms || []).filter((t) => t.text && !/^\W+$/.test(t.text || ''));
        if (!terms.length) continue; tot++;
        const first = terms[0];
        if (!first) continue;
        const tags = new Set(first.tags || []);
        if (tags.has('Verb')) imp++;
      }
      const impRatio = tot ? (imp / tot) : 0;
      base = Math.max(base, impRatio);
    } catch {}
  }

  // 可配置规则引擎（正则或函数），不含任何内置词表
  const rule = clamp(ruleScore || 0, 0, 1);

  // 融合：选择上界并做轻微保守校准
  const s = Math.max(base, rule);
  return clamp(0.9 * s + 0.1 * Math.min(base, rule), 0, 1);
}

function defaultUrgencyScore(text: string, lang: LangCode, capsRatio: number, punctInt: number): number { return clamp(0.6 * punctInt + 0.4 * capsRatio, 0, 1); }
function defaultAckScore(text: string, lang: LangCode, totalTokens: number, semanticScore: number, hasQP: boolean, hasLink: boolean): number {
  const shortScore = shortUtteranceScore(totalTokens, hasQP, hasLink); const lowSem = clamp(1 - semanticScore, 0, 1);
  return clamp(0.7 * shortScore + 0.3 * lowSem, 0, 1);
}

function profaneScoreEn(text: string, tokens: string[] | null): { score: number; matches: number } {
  if (!BadWordsFilter) return { score: 0, matches: 0 };
  const f = new BadWordsFilter();
  const toks = (Array.isArray(tokens) && tokens.length ? tokens : (text.match(/\w+/g) || [])).map(t => t.toLowerCase());
  if (!toks.length) return { score: 0, matches: 0 };
  const profane = toks.filter(t => f.isProfane(t)).length;
  return { score: clamp(profane / toks.length, 0, 1), matches: profane };
}

function createDefaultZhDetector(): ((text: string, tokens?: string[] | null) => { score: number; matches: number }) | null {
  // 无内置关键词；仅桥接外部敏感词库/过滤器，若存在则使用
  let swfDetector = null;
  try {
    if (SensitiveWordFilter && typeof (SensitiveWordFilter as { filter?: unknown }).filter === 'function') {
      const swf = SensitiveWordFilter as { filter: (text: string) => string };
      swfDetector = (text: string) => {
        try {
          const filtered = swf.filter(text);
          return filtered !== text ? { score: 1, matches: 1 } : { score: 0, matches: 0 };
        } catch { return { score: 0, matches: 0 }; }
      };
    } else if (typeof SensitiveWordFilter === 'function') {
      const inst = new (SensitiveWordFilter as new () => { filter: (text: string) => string })();
      if (typeof inst.filter === 'function') {
        swfDetector = (text: string) => {
          try {
            const filtered = inst.filter(text);
            return filtered !== text ? { score: 1, matches: 1 } : { score: 0, matches: 0 };
          } catch { return { score: 0, matches: 0 }; }
        };
      }
    }
  } catch (e) {
    logger.warn('`sensitive-word-filter` load failed', { err: String(e) });
  }
  if (!swfDetector) return null;
  return (text: string) => {
    const sRaw = String(text || '');
    if (!sRaw) return { score: 0, matches: 0 };
    const sNorm = normalizeForMatch(sRaw);
    let score = 0, matches = 0;
    const tryOne = (det: ((t: string) => { score?: number; matches?: number } | boolean) | null, s: string) => {
      try {
        const r = det ? det(s) : null;
        if (r && typeof r === 'object' && 'score' in r) {
          const scoreVal = (r as { score?: number }).score;
          if (typeof scoreVal === 'number') {
            score = Math.max(score, clamp(scoreVal, 0, 1));
          }
          const matchesVal = (r as { matches?: number }).matches;
          matches += typeof matchesVal === 'number' ? matchesVal : 0;
        } else if (r === true) { score = Math.max(score, 1); matches += 1; }
      } catch {}
    };
    tryOne(swfDetector, sRaw); tryOne(swfDetector, sNorm);
    return { score: clamp(score, 0, 1), matches };
  };
}

export class ConversationAnalyzer {
  config: AnalyzerConfigResolved;
  stopwords: { en: Set<string>; zh: Set<string> };
  _zhDetector: ((text: string, tokens?: string[] | null) => { score: number; matches: number }) | null;
  _ruleEngines: RuleEngines;

  constructor(config: AnalyzerConfig = {}) {
    const defaults: AnalyzerConfigResolved = {
      minTextLength: 2, minEntropy: 1.6, minTokens: 2, maxSimilarity: 0.85,
      validTokenRatio: 0.35, contextWindow: 6, replyThreshold: 0.65, linkFallback: false,

      historyHardBlock: 0.88, softQuestionMin: 0.5, softCtaMin: 0.4,
      repeatPenalty: {
        maxPenalty: 0.5,
        minFactor: 0.18,
        threshold: null
      },

      punct: { questionMarks: ['?', '？'], questionBonus: 0.4 },

      weights: {
        intercept: -2.0,
        question: 1.2, link: 0.2, length: 0.2, entropy: 0.25, semantic: 0.7,
        noveltyChar: 0.7, noveltyTfidf: 0.9, noveltyBm25: 0.6, noveltyJaccard: 0.6,
        callToAction: 0.9, youMention: 0.3, urgency: 0.5,
        emojiPenalty: -0.4, capsPenalty: -0.4,
        toxicityPenaltyEn: -0.8, toxicityPenaltyZh: -1.2,
        repetitionPenalty: -0.5, histCompositePenalty: -2.6,
        shortUtterancePenalty: -1.3, ackPenalty: -1.2,
        punctPenalty: -0.25, repeatCharPenalty: -0.35, digitPenalty: -0.15,
        urlPenalty: -0.1, codePenalty: -0.1, mentionBonus: 0.1, uniqueCharBonus: 0.15,
        simhashPenalty: -0.8,
        senderFatiguePenalty: -1.2,
        groupFatiguePenalty: -0.8,
        senderReplyRatePenalty: -1.0,
        groupReplyRatePenalty: -0.7,
        followupBonus: 0.6,
        explicitMentionBonus: 0.5,
        sessionValence: 0.4,
        sessionSaturationPenalty: -0.8
      },

      stopwords: {},

      // 可选意图函数覆盖
      intentFns: { /* question, cta, urgency, ack */ },

      // 可配置资源（规则引擎等），不在代码中硬编码任何词
      resources: {
        ctaRules: [] // e.g. [{ lang:'zho', type:'regex', pattern:'^(请|麻烦)', weight:0.4 }]
      },

      compliance: {
        enabled: true,
        thresholds: { flag: 0.02, block: 0.06 }
      },

      calibration: {
        temperature: 1.0,          // >1 => softer; <1 => sharper
        platt: null,               // { a, b } => p = sigmoid(a*z + b)
        isotonic: null,            // [{x,y}...] piecewise-linear on raw sigmoid prob
        shrinkAmbiguity: 0.5       // 0..1, shrink toward 0.5 when multi-similarity disagrees
      },

      debug: false
    };

    this.config = {
      ...defaults,
      ...config,
      weights: { ...defaults.weights, ...(config.weights || {}) },
      intentFns: { ...defaults.intentFns, ...(config.intentFns || {}) },
      punct: { ...defaults.punct, ...(config.punct || {}) },
      compliance: { ...defaults.compliance, ...(config.compliance || {}) },
      calibration: { ...defaults.calibration, ...(config.calibration || {}) },
      resources: { ...defaults.resources, ...(config.resources || {}) }
    };

    this.stopwords = buildStopwords(this.config);

    this._zhDetector = createDefaultZhDetector();

    // 编译 CTA 规则引擎（如配置提供则使用；未提供则返回 0）
    this._ruleEngines = {
      cta: compileIntentRules(this.config.resources?.ctaRules || [])
    };

    if (this.config.debug) {
      logger.debug('[Analyzer] 初始化', {
        externalZhDetector: typeof this.config.compliance.zhDetector === 'function',
        swfAvailable: !!SensitiveWordFilter,
        compiledCtaRules: Array.isArray(this.config.resources?.ctaRules) ? this.config.resources.ctaRules.length : 0
      });
    }
  }

  detectLangFor(text: string): LangCode {
    let lang = 'und';
    try { const d = franc((text || '').replace(/\s+/g, ' '), { minLength: 3 }); if (d && d !== 'und') lang = d; } catch {}
    if (lang === 'und') lang = /[\u4e00-\u9fff]/.test(text) ? 'zho' : (/[A-Za-z]/.test(text) ? 'eng' : 'und');
    return lang;
  }

  analyze(currentText: string, historyTexts: string[] = [], meta: AnalyzerMeta = {} as AnalyzerMeta): AnalysisResult {
    const debug = this.config.debug;
    const breakdown: Array<{ name: string; val: number; weight: number; contrib: number }> = [];

    const result: AnalysisResult = {
      original: currentText,
      isWorthReplying: false,
      probability: 0, score: 0, confidence: 1,
      features: {}, reasons: [], policy: { action: 'none', details: [] },
      ...(debug ? { breakdown } : {})
    };
    if (!currentText || typeof currentText !== 'string') { result.reasons.push('EMPTY_OR_INVALID_INPUT'); return result; }

    // ---------- preprocess ----------
    const regex = emojiRegex();
    const emojiCount = (currentText.match(regex) || []).length;
    let cleanText = currentText.replace(regex, ' ');

    const links = linkify.match(cleanText) || [];
    const hasLink = links.length > 0;
    const urlCount = links.length;
    if (hasLink) for (const l of links) cleanText = cleanText.replace(l.raw, ' ');

    const mentionRegex = /(^|\s)@([A-Za-z0-9_.-]+)/g;
    const mentionMatches = [...(cleanText.matchAll(mentionRegex) || [])];
    const mentionCount = mentionMatches.length;
    const hasCode = /```|`[^`]+`/.test(currentText);

    cleanText = winkUtils.string.removePunctuations(cleanText);
    cleanText = cleanText.replace(/\s+/g, ' ').trim();

    Object.assign(result.features, {
      cleanText, hasLink, urlCount, mentionCount, hasCode, emojiCount
    });

    const len = cleanText.length;
    if (len < this.config.minTextLength) result.reasons.push('TEXT_TOO_SHORT');
    const entropy = this.calculateEntropy(cleanText);
    result.features.entropy = entropy;

    let lang = 'und';
    try { const detected = franc(cleanText || '', { minLength: 3 }); if (detected && detected !== 'und') lang = detected; } catch {}
    if (lang === 'und') lang = isLikelyChinese(cleanText) ? 'zho' : (isLikelyLatin(cleanText) ? 'eng' : 'und');
    result.features.language = lang;

    // Chinese sentiment features (based on sentiment-zh_cn_web)，用于后续 follow-up 行为判断
    let cnSentimentScore = 0;
    let cnSentimentComparative = 0;
    let cnSentimentPosCount = 0;
    let cnSentimentNegCount = 0;
    if (sentimentZh && (lang === 'cmn' || lang === 'zho' || isLikelyChinese(cleanText))) {
      try {
        const res = sentimentZh(cleanText);
        if (res && typeof res.score === 'number' && Number.isFinite(res.score)) {
          cnSentimentScore = res.score;
        }
        if (res && typeof res.comparative === 'number' && Number.isFinite(res.comparative)) {
          cnSentimentComparative = res.comparative;
        }
        if (res && Array.isArray(res.positive)) {
          cnSentimentPosCount = res.positive.length;
        }
        if (res && Array.isArray(res.negative)) {
          cnSentimentNegCount = res.negative.length;
        }
      } catch {}
    }
    let cnSentimentValence = 0;
    let cnSentimentStrength = 0;
    if (cnSentimentScore !== 0) {
      const clipped = Math.max(-8, Math.min(8, cnSentimentScore));
      cnSentimentValence = clamp(clipped / 8, -1, 1);
      cnSentimentStrength = Math.abs(cnSentimentValence);
    }
    Object.assign(result.features, {
      cnSentimentScore,
      cnSentimentComparative,
      cnSentimentPosCount,
      cnSentimentNegCount,
      cnSentimentValence,
      cnSentimentStrength
    });

    let tokensAll = [], tokensNoStop = [], doc = null;
    if (lang === 'cmn' || lang === 'zho' || isLikelyChinese(cleanText)) {
      tokensAll = chineseTokensAll(cleanText);
      tokensNoStop = chineseTokensNoStop(cleanText, this.stopwords.zh);
    } else {
      tokensAll = englishTokensAll(cleanText);
      tokensNoStop = englishTokensNoStop(cleanText, this.stopwords.en || new Set());
      try { doc = nlp(cleanText); } catch {}
    }
    const totalTokenCount = tokensAll.length;
    const meaningfulTokenCount = tokensNoStop.length;

    let posBoost = 0; if (doc) { try {
      const nouns = doc.nouns().out('array').length, verbs = doc.verbs().out('array').length, adjs = doc.adjectives().out('array').length;
      posBoost = Math.min(0.15, (nouns + verbs + adjs) / Math.max(1, totalTokenCount) * 0.4);
    } catch {} }

    const semanticBase = totalTokenCount === 0 ? 0 : (meaningfulTokenCount / totalTokenCount);
    const semanticScore = clamp(semanticBase + posBoost, 0, 1);

    Object.assign(result.features, {
      tokens: tokensNoStop, tokensAll,
      totalTokens: totalTokenCount, meaningfulTokens: meaningfulTokenCount,
      semanticScore
    });

    if (len > 5 && entropy < this.config.minEntropy && !hasLink) result.reasons.push('LOW_ENTROPY_GIBBERISH');
    if (totalTokenCount < this.config.minTokens && !hasLink) result.reasons.push('TOO_FEW_TOKENS');
    if (semanticScore < this.config.validTokenRatio && !hasLink) result.reasons.push('LOW_SEMANTIC_VALUE');

    // ---------- context similarities ----------
    const recent = Array.isArray(historyTexts) ? historyTexts.slice(-this.config.contextWindow) : [];
    const { maxSimilarity } = this.checkContextSimilarity(cleanText, recent);
    result.features.maxSimilarity = maxSimilarity;

    const histTokensRaw = recent.map(h => { const hlang = this.detectLangFor(h); return this.tokenize(h, hlang); });

    const tfCurrentTokens = (tokensNoStop && tokensNoStop.length > 1) ? tokensNoStop : charShingles(cleanText, 2);
    const tfHistTokens = histTokensRaw.map((toks, idx) => {
      if (Array.isArray(toks) && toks.length > 1) return toks;
      const hClean = winkUtils.string.removePunctuations((recent[idx] || '')).trim();
      return charShingles(hClean, 2);
    });

    const jac = jaccardMax(tfCurrentTokens, tfHistTokens);
    const ovl = overlapCoefMax(tfCurrentTokens, tfHistTokens);

    let tfidfCos = 0; try { tfidfCos = maxTfidfCosineSimilarityNatural(tfCurrentTokens, tfHistTokens) || 0; } catch { tfidfCos = 0; }
    if (tfidfCos === 0 && (jac > 0 || ovl > 0)) tfidfCos = maxTfidfCosineSimilarityManual(tfCurrentTokens, tfHistTokens) || 0;

    let bm25Max = 0;
    if (bm25Factory && tfHistTokens.length && tfCurrentTokens.length && tfHistTokens.some(t => t && t.length)) {
      try {
        const bm25 = bm25Factory();
        bm25.defineConfig({ fldWeights: { text: 1 } });
        bm25.definePrepTasks([
          (s) => (typeof s === 'string' ? s.toLowerCase() : String(s).toLowerCase()),
          (s) => s.split(/\s+/).filter(Boolean)
        ]);
        tfHistTokens.forEach((tok, i) => { if (Array.isArray(tok) && tok.length) bm25.addDoc({ text: tok.join(' ') }, i); });
        bm25.consolidate();
        const q = tfCurrentTokens.join(' ').toLowerCase();
        if (q) {
          const hits = bm25.search(q) || [];
          const firstHit = hits[0];
          if (firstHit && isNum(firstHit.score)) bm25Max = firstHit.score;
        }
      } catch { bm25Max = 0; }
    }
    if (bm25Max === 0 && (jac > 0 || ovl > 0)) bm25Max = bm25MaxManual(tfCurrentTokens, tfHistTokens);

    const simhashNear = simhashNearnessMax(tfCurrentTokens, tfHistTokens);

    // 新增：MinHash 近似相似度（字符 shingle）
    const minhashNear = minhashNearnessMax(cleanText, recent, 3, 64);

    Object.assign(result.features, {
      tfidfMaxCosine: tfidfCos,
      jaccardMax: jac, overlapCoefMax: ovl,
      bm25Max, bm25MaxNorm: normBm25Score(bm25Max),
      simhashNearnessMax: simhashNear,
      minhashNearnessMax: minhashNear
    });

    // 将多种局部特征组合成“谁最像听谁”的策略（取最大值），
    // 这样能覆盖“完全复读”“局部重合”“顺序打乱”等多种重复形态。
    if (debug) {
      try {
        // debug 仅在调用者设置 config.debug 时输出，避免默认噪音。
        logger.debug('ConversationAnalyzer 相似度特征', {
          cleanTextPreview: cleanText.slice(0, 80),
          historySize: recent.length,
          tfidfMaxCosine: tfidfCos,
          jaccardMax: jac,
          overlapCoefMax: ovl,
          bm25Max,
          bm25MaxNorm: normBm25Score(bm25Max),
          simhashNearnessMax: simhashNear,
          minhashNearnessMax: minhashNear,
          maxSimilarity: result.features.maxSimilarity
        });
      } catch {}
    }

    const hasQuestionPunct = (this.config.punct?.questionMarks || ['?', '？']).some(ch => currentText.includes(ch));
    Object.assign(result.features, {
      youMention: mentionCount > 0 ? 1 : 0,
      capsRatio: countCapsRatio(currentText),
      emojiRatio: currentText.length ? (emojiCount / currentText.length) : 0,
      punctIntensity: punctuationIntensity(currentText),
      repeatCharRatio: repeatCharRatio(currentText),
      uniqueCharRatio: uniqueCharRatio(currentText),
      digitRatio: digitRatio(currentText),
      length: cleanText.length
    });

    // fatigue / 频率 / followup 等来自上层的结构化信号
    const sig = (meta && typeof meta === 'object' ? (meta.signals || meta) : {});
    const senderFatigue = isNum(sig.senderFatigue) ? clamp(sig.senderFatigue, 0, 1) : 0;
    const groupFatigue = isNum(sig.groupFatigue) ? clamp(sig.groupFatigue, 0, 1) : 0;
    const senderReplyRate = isNum(sig.senderReplyCountWindow) ? clamp(sig.senderReplyCountWindow / 10, 0, 1) : 0;
    const groupReplyRate = isNum(sig.groupReplyCountWindow) ? clamp(sig.groupReplyCountWindow / 60, 0, 1) : 0;
    const followup = sig.isFollowupAfterBotReply ? 1 : 0;
    const explicitMention = (sig.mentionedByAt || sig.mentionedByName) ? 1 : 0;

    let sessionValence = 0;
    let sessionSaturation = 0;
    const att = (sig && sig.attentionSession && typeof sig.attentionSession === 'object') ? sig.attentionSession : null;
    if (att) {
      const considered = isNum(att.consideredCount) && att.consideredCount > 0 ? att.consideredCount : 0;
      const replied = isNum(att.repliedCount) && att.repliedCount >= 0 ? att.repliedCount : 0;
      const avgGateProb = isNum(att.avgGateProb) ? clamp(att.avgGateProb, 0, 1) : null;
      const replyRatio = (considered > 0 && isNum(att.replyRatio)) ? clamp(att.replyRatio, 0, 1) : (considered > 0 ? clamp(replied / considered, 0, 1) : null);

      if (avgGateProb != null) {
        sessionValence = clamp((avgGateProb - 0.5) * 2, -1, 1);
      }
      if (replyRatio != null) {
        sessionSaturation = clamp(replyRatio, 0, 1);
      }
    }

    Object.assign(result.features, {
      senderFatigue,
      groupFatigue,
      senderReplyRate,
      groupReplyRate,
      followup,
      explicitMention,
      sessionValence,
      sessionSaturation
    });

    // intents
    const fns = this.config.intentFns || {};
    const qScore = typeof fns.question === 'function'
      ? clamp(fns.question(currentText, lang, { doc, tokensNoStop, tokensAll, punctCfg: this.config.punct }) || 0, 0, 1)
      : defaultQuestionScore(currentText, lang, doc || nlp(''), this.config.punct);

    const ctaRuleScore = this._ruleEngines?.cta?.score(currentText, lang) || 0;

    const capsRatioVal = isNum(result.features.capsRatio) ? result.features.capsRatio : 0;
    const punctIntensityVal = isNum(result.features.punctIntensity) ? result.features.punctIntensity : 0;

    const ctaScore = typeof fns.cta === 'function'
      ? clamp(fns.cta(currentText, lang, { doc, tokensNoStop, tokensAll, features: result.features, ruleScore: ctaRuleScore }) || 0, 0, 1)
      : defaultCtaScore(currentText, lang, { doc: doc || nlp(''), features: { punctIntensity: punctIntensityVal, capsRatio: capsRatioVal, mentionCount }, ruleScore: ctaRuleScore });

    const urgScore = typeof fns.urgency === 'function'
      ? clamp(fns.urgency(currentText, lang, { capsRatio: capsRatioVal, punctIntensity: punctIntensityVal }) || 0, 0, 1)
      : defaultUrgencyScore(currentText, lang, capsRatioVal, punctIntensityVal);

    const ackScore = typeof fns.ack === 'function'
      ? clamp(fns.ack(currentText, lang, { totalTokens: totalTokenCount, semanticScore, hasQuestionPunct, hasLink }) || 0, 0, 1)
      : defaultAckScore(currentText, lang, totalTokenCount, semanticScore, hasQuestionPunct, hasLink);

    // intents 作为通用特征参与后续概率计算，不在此处做特定 follow-up 分类
    Object.assign(result.features, { questionness: qScore, callToAction: ctaScore, urgency: urgScore, ack: ackScore, ctaRuleScore });

    // compliance
    const normalized = normalizeForMatch(currentText);
    const enProf = profaneScoreEn(normalized, (lang === 'eng' ? tokensNoStop : null));

    let zhResult = { score: 0, matches: 0 };
    if (this.config.compliance?.enabled && (lang === 'zho' || isLikelyChinese(normalized))) {
      try {
        const external = this.config.compliance.zhDetector;
        if (typeof external === 'function') {
          const r = external(currentText, tokensNoStop) || { score: 0, matches: 0 };
          zhResult.score = clamp(r.score || 0, 0, 1); zhResult.matches = r.matches || 0;
        } else if (this._zhDetector) {
          const r = this._zhDetector(currentText, tokensNoStop) || { score: 0, matches: 0 };
          zhResult.score = clamp(r.score || 0, 0, 1); zhResult.matches = r.matches || 0;
        }
      } catch (e) {
        if (debug) {
          logger.debug('Chinese detector failed', { err: String(e) });
        }
      }
    }

    result.features.toxicityEn = enProf.score;
    result.features.toxicityZh = zhResult.score;

    if (this.config.compliance?.enabled) {
      const th = this.config.compliance.thresholds || {};
      const flagTh = isNum(th.flag) ? th.flag : 0.02;
      const blockTh = isNum(th.block) ? th.block : 0.06;
      const combinedToxic = clamp(0.6 * enProf.score + 0.8 * zhResult.score, 0, 1);
      if (combinedToxic >= blockTh) { result.policy.action = 'block'; result.reasons.push('POLICY_BLOCKED'); }
      else if (combinedToxic >= flagTh) { result.policy.action = 'flag'; result.reasons.push('POLICY_FLAGGED'); }
      result.policy.details.push(
        { kind: 'profanity-en', score: enProf.score, matches: enProf.matches || 0 },
        { kind: 'profanity-zh', score: zhResult.score, matches: zhResult.matches }
      );
    }

    // ------------- probability -------------
    const w = this.config.weights;
    const lengthVal = isNum(result.features.length) ? result.features.length : cleanText.length;
    const lenNorm = clamp(lengthVal / 80, 0, 1);
    const entropyNorm = clamp((entropy - 1) / 3, 0, 1);
    const noveltyChar = 1 - clamp(result.features.maxSimilarity || 0, 0, 1);
    const noveltyTfidf = 1 - clamp(result.features.tfidfMaxCosine || 0, 0, 1);
    const noveltyBm25 = 1 - clamp(result.features.bm25MaxNorm || 0, 0, 1);
    const noveltyJaccard = 1 - clamp(result.features.jaccardMax || 0, 0, 1);
    const urlNorm = clamp(urlCount / 3, 0, 1);
    const mentionNorm = clamp(mentionCount / 3, 0, 1);
    const shortScore = shortUtteranceScore(totalTokenCount, hasQuestionPunct, hasLink);

    function add(name: string, val: number, weight: number): number {
      if (debug) breakdown.push({ name, val, weight, contrib: (val || 0) * (weight || 0) });
      return (val || 0) * (weight || 0);
    }

    const followupBonusInput = 0;

    let z = 0;
    z += add('intercept', 1, w.intercept);
    z += add('question', qScore, w.question);
    z += add('link', hasLink ? 1 : 0, w.link);
    z += add('length', lenNorm, w.length);
    z += add('entropy', entropyNorm, w.entropy);
    z += add('semantic', result.features.semanticScore || 0, w.semantic);
    z += add('noveltyChar', noveltyChar, w.noveltyChar);
    z += add('noveltyTfidf', noveltyTfidf, w.noveltyTfidf);
    z += add('noveltyBm25', noveltyBm25, w.noveltyBm25);
    z += add('noveltyJaccard', noveltyJaccard, w.noveltyJaccard);
    z += add('callToAction', ctaScore, w.callToAction);
    z += add('youMention', result.features.youMention || 0, w.youMention);
    z += add('urgency', urgScore, w.urgency);
    z += add('emojiPenalty', result.features.emojiRatio || 0, w.emojiPenalty);
    z += add('capsPenalty', result.features.capsRatio || 0, w.capsPenalty);
    z += add('toxicityPenaltyEn', result.features.toxicityEn || 0, w.toxicityPenaltyEn);
    z += add('toxicityPenaltyZh', result.features.toxicityZh || 0, w.toxicityPenaltyZh);
    z += add('punctPenalty', result.features.punctIntensity || 0, w.punctPenalty);
    z += add('repeatCharPenalty', result.features.repeatCharRatio || 0, w.repeatCharPenalty);
    z += add('digitPenalty', result.features.digitRatio || 0, w.digitPenalty);
    z += add('urlPenalty', urlNorm, w.urlPenalty);
    z += add('codePenalty', hasCode ? 1 : 0, w.codePenalty);
    z += add('mentionBonus', mentionNorm, w.mentionBonus);
    z += add('uniqueCharBonus', result.features.uniqueCharRatio || 0, w.uniqueCharBonus);
    z += add('repetitionPenalty', result.features.maxSimilarity || 0, w.repetitionPenalty);
    z += add('senderFatiguePenalty', result.features.senderFatigue || 0, w.senderFatiguePenalty);
    z += add('groupFatiguePenalty', result.features.groupFatigue || 0, w.groupFatiguePenalty);
    z += add('senderReplyRatePenalty', result.features.senderReplyRate || 0, w.senderReplyRatePenalty);
    z += add('groupReplyRatePenalty', result.features.groupReplyRate || 0, w.groupReplyRatePenalty);
    z += add('followupBonus', followupBonusInput, w.followupBonus);
    z += add('explicitMentionBonus', result.features.explicitMention || 0, w.explicitMentionBonus);
    z += add('sessionValence', result.features.sessionValence || 0, w.sessionValence);
    z += add('sessionSaturationPenalty', result.features.sessionSaturation || 0, w.sessionSaturationPenalty);

    const simSignals = [
      result.features.tfidfMaxCosine,
      result.features.bm25MaxNorm,
      result.features.maxSimilarity,
      result.features.jaccardMax,
      result.features.overlapCoefMax,
      result.features.simhashNearnessMax,
      result.features.minhashNearnessMax
    ].filter((v) => isNum(v) && v >= 0);

    let histCompositeSim = 0;
    if (simSignals.length === 1) {
      const first = simSignals[0];
      if (typeof first === 'number') {
        histCompositeSim = clamp(first, 0, 1);
      }
    } else if (simSignals.length > 1) {
      const sorted = simSignals.slice().sort((a, b) => (a ?? 0) - (b ?? 0));
      const trimmed = sorted.length > 2 ? sorted.slice(1, -1) : sorted;
      let sum = 0;
      for (const v of trimmed) sum += v ?? 0;
      const denom = trimmed.length || 1;
      histCompositeSim = clamp(sum / denom, 0, 1);
    }
    result.features.histCompositeSim = histCompositeSim;

    z += add('histCompositePenalty', histCompositeSim, w.histCompositePenalty);
    z += add('shortUtterancePenalty', shortScore, w.shortUtterancePenalty);
    z += add('ackPenalty', ackScore, w.ackPenalty);
    z += add('simhashPenalty', result.features.simhashNearnessMax || 0, w.simhashPenalty);

    let temp = this.config.calibration.temperature || 1.0;
    const platt = this.config.calibration.platt;
    const isotonic = this.config.calibration.isotonic;
    const zScaled = (isNum(temp) && temp > 0) ? (z / temp) : z;
    const zPlatt = (platt && isNum(platt.a) && isNum(platt.b)) ? (platt.a * zScaled + platt.b) : zScaled;
    let p = sigmoid(zPlatt);
    if (Array.isArray(isotonic) && isotonic.length >= 2) {
      const tbl = isotonic.slice().sort((a, b) => a.x - b.x);
      const first = tbl[0];
      const last = tbl[tbl.length - 1];
      if (first && p <= first.x) p = first.y;
      else if (last && p >= last.x) p = last.y;
      else {
        for (let i = 0; i < tbl.length - 1; i++) {
          const a = tbl[i], b = tbl[i + 1];
          if (!a || !b) continue;
          if (p >= a.x && p <= b.x) { const t = (p - a.x) / Math.max(1e-6, (b.x - a.x)); p = a.y + t * (b.y - a.y); break; }
        }
      }
    }

    // 多通道一致性 -> 置信与收缩（新增 minhash 通道已并入）
    const sims = [
      result.features.maxSimilarity,
      result.features.tfidfMaxCosine,
      result.features.bm25MaxNorm,
      result.features.jaccardMax,
      result.features.overlapCoefMax,
      result.features.simhashNearnessMax,
      result.features.minhashNearnessMax
    ].filter(v => isNum(v));
    let confidence = 1;
    if (sims.length >= 2) {
      const mn = Math.min(...sims), mx = Math.max(...sims);
      const spread = clamp(mx - mn, 0, 1);
      confidence = clamp(1 - spread, 0.2, 1);
      const shrink = clamp(this.config.calibration.shrinkAmbiguity || 0, 0, 1);
      p = 0.5 + (p - 0.5) * (1 - shrink * (1 - confidence));
    }
    result.confidence = confidence;

    let pAdjusted = p;

    const repeatCfg = this.config.repeatPenalty || {};
    const repeatThreshold = isNum(repeatCfg.threshold)
      ? clamp(repeatCfg.threshold, 0, 1)
      : this.config.historyHardBlock;
    const maxPenalty = isNum(repeatCfg.maxPenalty) ? clamp(repeatCfg.maxPenalty, 0, 1) : 0.75;
    const minFactor = isNum(repeatCfg.minFactor) ? clamp(repeatCfg.minFactor, 0, 1) : 0.15;

    if (histCompositeSim >= repeatThreshold && !hasLink && qScore < this.config.softQuestionMin && ctaScore < this.config.softCtaMin) {
      const excess = (histCompositeSim - repeatThreshold) / Math.max(1e-6, 1 - repeatThreshold);
      const penalty = maxPenalty * clamp(excess, 0, 1);
      const factor = Math.max(1 - penalty, minFactor);
      pAdjusted = pAdjusted * factor;
      result.reasons.push('HARD_REPEAT_SHRINK');
    }

    result.probability = clamp(pAdjusted, 0, 1);
    result.score = Math.round(result.probability * 100);
    result.isWorthReplying = result.probability >= this.config.replyThreshold;

    if (this.config.compliance?.enabled && result.policy.action === 'block') {
      result.isWorthReplying = false;
      if (!result.reasons.includes('POLICY_BLOCKED')) result.reasons.push('POLICY_BLOCKED');
    }

    if (!result.isWorthReplying) {
      if (histCompositeSim >= this.config.maxSimilarity) result.reasons.push('REPETITIVE_CONTENT');
      if (result.probability < 0.35) result.reasons.push('LOW_REPLY_PROBABILITY');
    }
    if (this.config.linkFallback && hasLink && !result.isWorthReplying && result.probability > 0.35) {
      result.isWorthReplying = true; result.features.linkFallback = true;
      const i = result.reasons.indexOf('LOW_SEMANTIC_VALUE'); if (i >= 0) result.reasons.splice(i, 1);
    }

    // 记录 CTA 规则命中详情（仅 debug）
    if (debug && this._ruleEngines?.cta) {
      result.features.ctaRuleMatches = this._ruleEngines.cta.matched(currentText, lang);
    }

    return result;
  }

  tokenize(text: string, lang: LangCode): string[] {
    if (lang === 'cmn' || lang === 'zho' || isLikelyChinese(text)) return chineseTokensNoStop(text, this.stopwords.zh);
    return englishTokensNoStop(text, this.stopwords.en || new Set());
  }

  checkContextSimilarity(currentText: string, historyTexts: string[]): { maxSimilarity: number; isRepetitive: boolean } {
    let maxSimilarity = 0;
    if (!currentText) return { maxSimilarity: 0, isRepetitive: false };
    const safeCurrent = winkUtils.string.removePunctuations(currentText.replace(emojiRegex(), '')).trim();
    for (const historyMsg of historyTexts || []) {
      if (!historyMsg || typeof historyMsg !== 'string') continue;
      const cleanHistory = winkUtils.string.removePunctuations(historyMsg.replace(emojiRegex(), '')).trim();
      if (!cleanHistory) continue;
      let diceScore = 0; try { diceScore = stringSimilarity.compareTwoStrings(safeCurrent, cleanHistory); } catch {}
      let levenScore = 0; try {
        const editDist = safeCurrent.length > 80 ? fastLeven(safeCurrent, cleanHistory) : leven(safeCurrent, cleanHistory);
        const maxLength = Math.max(safeCurrent.length, cleanHistory.length) || 1; levenScore = 1 - (editDist / maxLength);
      } catch {}
      let jaroScore = 0; try {
        const jaro = (natural as { JaroWinklerDistance?: (a: string, b: string, opts?: unknown, boost?: boolean) => number }).JaroWinklerDistance;
        if (typeof jaro === 'function') {
          jaroScore = jaro(safeCurrent, cleanHistory, undefined, true);
        }
      } catch {}
      const composite = Math.max(diceScore, levenScore, jaroScore);
      if (composite > maxSimilarity) maxSimilarity = composite;
    }
    return { maxSimilarity, isRepetitive: maxSimilarity >= this.config.maxSimilarity };
  }

  calculateEntropy(str: string): number {
    const l = str.length; if (!l) return 0;
    const freq: Record<string, number> = Object.create(null);
    for (let i = 0; i < l; i++) {
      const ch = str[i];
      if (!ch) continue;
      freq[ch] = (freq[ch] || 0) + 1;
    }
    let sum = 0; for (const f of Object.values(freq) as number[]) { const p = Number(f) / l; sum -= p * Math.log2(p); }
    return sum;
  }
}
