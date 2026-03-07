import fs from 'fs';
import path from 'path';
import { OpenAIEmbeddings } from '@langchain/openai';
import { getEnv, getEnvTimeoutMs, onEnvReload } from './envHotReloader.js';
import {
  RUNTIME_SKILL_DEFAULTS,
  RUNTIME_SKILL_GUIDES_DIR,
  RUNTIME_SKILL_LIMITS
} from './runtimeSkillConstants.js';
import { resolveProjectAssetPath } from './pathResolver.js';

export type RuntimeSkillMode =
  | 'auto'
  | 'full'
  | 'router'
  | 'response_only'
  | 'tools_only'
  | 'must_be_sentra_message'
  | 'must_be_sentra_tools'
  | string;

export type RuntimeSkillHint = {
  stage?: string;
  userText?: string;
  toolText?: string;
};

export type RuntimeSkillRef = {
  id: string;
  uuid: string;
  title: string;
  priority: number;
  confidence: number;
  score: number;
  reason: string;
};

export type RuntimeSkillSelection = {
  refs: RuntimeSkillRef[];
  signal: string;
  systemBlock: string;
  skillRefsXml: string;
};

type TriggerConfig = {
  keywords: string[];
  regex: string[];
};

type SkillManifest = {
  id: string;
  uuid: string;
  title: string;
  summary: string;
  selection: 'auto' | 'manual';
  runtimeDynamic: boolean;
  when: string[];
  deps: string[];
  priority: number;
  triggers: TriggerConfig;
  guideFile: string;
};

type LoadedGuide = SkillManifest & {
  guideContent: string;
  compiledRegex: RegExp[];
};

type SkillResolverOptions = {
  maxSkills?: number;
  minConfidence?: number;
  minScore?: number;
  maxUserSignalChars?: number;
  maxToolSignalChars?: number;
};

type CandidateRow = {
  guide: LoadedGuide;
  index: number;
  relevance01: number;
  intent01: number;
  lexical01: number;
  priority01: number;
  confidence01: number;
  score: number;
  final01: number;
  reason: string;
  queryRel: number[];
  docVector?: number[];
};

type QueryBundle = {
  queries: string[];
  queryWeights: number[];
  signal: string;
};

const MODE_ALIASES: Record<string, string> = {
  auto: 'full',
  full: 'full',
  router: 'router',
  response_only: 'response_only',
  tools_only: 'tools_only',
  must_be_sentra_message: 'response_only',
  must_be_sentra_tools: 'tools_only'
};

const WEIGHT_BASE = Object.freeze({
  relevance: 0.72,
  intent: 0.16,
  priority: 0.08,
  lexical: 0.04
});

const COVERAGE_SELECT = Object.freeze({
  score: 0.72,
  coverage: 0.22,
  redundancy: 0.08
});

const RRF_CONFIG = Object.freeze({
  rankK: 60,
  rerankWeight: 0.78,
  coarseWeight: 0.22
});

const STABILITY_CONFIG = Object.freeze({
  dynamicSkillBonus: 0.03,
  candidateWindowMultiplier: 3,
  stickyBoost: 0.035,
  stickySignalOverlapMin: 0.32,
  stickyMaxAgeMs: 10 * 60 * 1000,
  depBoostCap: 0.08
});

type StickySelectionSnapshot = {
  ids: string[];
  signal: string;
  at: number;
};

const stickySelectionMemory = new Map<string, StickySelectionSnapshot>();

let cacheLoadedAtMs = 0;
let cacheDirStamp = '';
let cacheGuides: LoadedGuide[] = [];

let embeddingClient: OpenAIEmbeddings | null = null;
let embeddingClientKey = '';
let embeddingInitFailed = false;

type VectorCacheItem = { vector: number[]; at: number };
const embeddingVectorCache = new Map<string, VectorCacheItem>();
const EMBEDDING_CACHE_MAX_ITEMS = 512;
const EMBEDDING_CACHE_TTL_MS = 10 * 60 * 1000;

function normalizeMode(raw: unknown): string {
  const key = String(raw || 'full').trim().toLowerCase();
  return MODE_ALIASES[key] || 'full';
}

function clamp(num: number, min: number, max: number): number {
  if (!Number.isFinite(num)) return min;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function clamp01(num: number): number {
  return clamp(num, 0, 1);
}

function escapeXml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hashFNV1a(text: string): string {
  let h = 2166136261;
  const src = String(text || '');
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function safeReadText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(String(raw || '').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const s = String(item || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function parseRegexPattern(rawPattern: string): RegExp | null {
  const raw = String(rawPattern || '').trim();
  if (!raw) return null;
  const m = raw.match(/^\/([\s\S]+)\/([a-z]*)$/i);
  try {
    if (m && m[1]) return new RegExp(m[1], m[2] || 'i');
    return new RegExp(raw, 'i');
  } catch {
    return null;
  }
}

function getGuidesRootDir(): string {
  return resolveProjectAssetPath(RUNTIME_SKILL_GUIDES_DIR, {
    importMetaUrl: import.meta.url,
    probePaths: ['.'],
    probeMode: 'any',
    maxParentLevels: 4
  });
}

function computeDirStamp(rootDir: string): string {
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((x) => x.isDirectory())
      .map((x) => x.name)
      .sort();
    const parts: string[] = [];
    for (const name of entries) {
      const sub = path.resolve(rootDir, name);
      const manifest = path.resolve(sub, 'skill.json');
      const guide = path.resolve(sub, 'guide.md');
      let a = '0';
      let b = '0';
      try { a = String(fs.statSync(manifest).mtimeMs || 0); } catch { }
      try { b = String(fs.statSync(guide).mtimeMs || 0); } catch { }
      parts.push(`${name}:${a}:${b}`);
    }
    return parts.join('|');
  } catch {
    return '';
  }
}

function normalizeManifest(raw: Record<string, unknown>, folderName: string): SkillManifest | null {
  const id = String(raw.id || folderName || '').trim();
  const guideFile = String(raw.guideFile || 'guide.md').trim() || 'guide.md';
  if (!id) return null;
  const when = toStringArray(raw.when).map((x) => x.toLowerCase());
  const triggersRaw = raw.triggers && typeof raw.triggers === 'object'
    ? raw.triggers as Record<string, unknown>
    : {};
  const triggers: TriggerConfig = {
    keywords: toStringArray(triggersRaw.keywords).map((x) => x.toLowerCase()),
    regex: toStringArray(triggersRaw.regex)
  };
  const selectionRaw = String(raw.selection || 'manual').trim().toLowerCase();
  const selection = selectionRaw === 'auto' ? 'auto' : 'manual';
  const runtimeDynamic = raw.runtimeDynamic === true;
  const deps = toStringArray(raw.deps);
  const priorityValue = Number(raw.priority);
  const priority = Number.isFinite(priorityValue) ? priorityValue : 1000;
  return {
    id,
    uuid: String(raw.uuid || '').trim(),
    title: String(raw.title || id).trim() || id,
    summary: String(raw.summary || '').trim(),
    selection,
    runtimeDynamic,
    when: when.length ? when : ['*'],
    deps,
    priority,
    triggers,
    guideFile
  };
}

function modeAllowed(skill: SkillManifest, mode: string): boolean {
  const when = Array.isArray(skill.when) ? skill.when : ['*'];
  if (when.includes('*')) return true;
  if (when.includes(mode)) return true;
  if (mode === 'router' && when.includes('full')) return true;
  return false;
}

function sanitizeSignal(raw: unknown, maxChars: number): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  const noXml = s.replace(/<[^>]+>/g, ' ');
  const normalized = noXml.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function limitText(text: string, maxChars: number): string {
  const src = String(text || '').trim();
  if (!src) return '';
  if (src.length <= maxChars) return src;
  return src.slice(0, maxChars);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len <= 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = Number(a[i] ?? NaN);
    const bv = Number(b[i] ?? NaN);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (!(na > 0) || !(nb > 0)) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normalizeScores(values: number[]): number[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return values.map(() => 0);
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  if (!(hi > lo)) return values.map(() => 1);
  return values.map((v) => {
    if (!Number.isFinite(v)) return 0;
    return clamp01((v - lo) / (hi - lo));
  });
}

function buildRankPositions(values: number[]): number[] {
  const scores = Array.isArray(values) ? values : [];
  const indices = scores.map((_, idx) => idx);
  indices.sort((a, b) => {
    const aScore = Number(scores[a] ?? -Infinity);
    const bScore = Number(scores[b] ?? -Infinity);
    if (bScore !== aScore) return bScore - aScore;
    return a - b;
  });
  const out = new Array<number>(scores.length).fill(scores.length);
  for (let i = 0; i < indices.length; i++) {
    const idx = Number(indices[i]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= out.length) continue;
    out[idx] = i;
  }
  return out;
}

function reciprocalRank(rank: number, k: number): number {
  const r = Number(rank);
  if (!Number.isFinite(r) || r < 0) return 0;
  const kk = Math.max(1, Number(k) || 60);
  return 1 / (kk + r + 1);
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const s = String(value || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function tokenizeSignal(raw: string): Set<string> {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return new Set<string>();
  const tokens = text
    .replace(/[^\p{L}\p{N}_\-\s]+/gu, ' ')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2)
    .slice(0, 128);
  return new Set<string>(tokens);
}

function jaccardOverlap(aRaw: string, bRaw: string): number {
  const a = tokenizeSignal(aRaw);
  const b = tokenizeSignal(bRaw);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const token of a) {
    if (b.has(token)) inter += 1;
  }
  const union = a.size + b.size - inter;
  if (!(union > 0)) return 0;
  return clamp01(inter / union);
}

function appendReason(reason: string, piece: string): string {
  const base = String(reason || '').trim();
  const add = String(piece || '').trim();
  if (!add) return base;
  if (!base) return add;
  if (base.includes(add)) return base;
  const merged = `${base}, ${add}`;
  const parts = merged.split(',').map((x) => x.trim()).filter(Boolean);
  return parts.slice(0, 6).join(', ');
}

function pruneStickySelectionMemory(maxItems = 96): void {
  if (stickySelectionMemory.size <= maxItems) return;
  const ordered = Array.from(stickySelectionMemory.entries())
    .sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0));
  const excess = stickySelectionMemory.size - maxItems;
  for (let i = 0; i < excess; i++) {
    const key = ordered[i]?.[0];
    if (!key) continue;
    stickySelectionMemory.delete(key);
  }
}

function buildSkillDoc(guide: LoadedGuide): string {
  const keywords = Array.isArray(guide.triggers.keywords)
    ? guide.triggers.keywords.slice(0, 16).join(', ')
    : '';
  const lines = [
    `skill_id: ${guide.id}`,
    `title: ${guide.title}`,
    `summary: ${guide.summary || ''}`,
    `priority: ${guide.priority}`,
    `when: ${(Array.isArray(guide.when) ? guide.when.join(', ') : '')}`,
    `keywords: ${keywords}`,
    `guide_excerpt: ${limitText(guide.guideContent || '', 1400)}`
  ];
  return lines.join('\n').trim();
}

function computeKeywordRegexSignal(guide: LoadedGuide, queryText: string): { score01: number; reason: string } {
  const text = String(queryText || '').trim().toLowerCase();
  if (!text) return { score01: 0, reason: '' };
  let keywordHits = 0;
  const keywordReasons: string[] = [];
  for (const kw of guide.triggers.keywords) {
    const key = String(kw || '').trim().toLowerCase();
    if (!key) continue;
    if (text.includes(key)) {
      keywordHits += 1;
      if (keywordReasons.length < 2) keywordReasons.push(`kw:${key}`);
    }
  }
  const keywordRatio = guide.triggers.keywords.length > 0
    ? clamp01(keywordHits / guide.triggers.keywords.length)
    : 0;

  let regexHits = 0;
  const regexReasons: string[] = [];
  for (const rx of guide.compiledRegex) {
    try {
      rx.lastIndex = 0;
      if (rx.test(text)) {
        regexHits += 1;
        if (regexReasons.length < 2) regexReasons.push(`re:${rx.source}`);
      }
    } catch {
      // ignore regex runtime failures
    }
  }
  const regexRatio = guide.compiledRegex.length > 0
    ? clamp01(regexHits / guide.compiledRegex.length)
    : 0;

  const score01 = clamp01((keywordRatio * 0.38) + (regexRatio * 0.62));
  const reasons = [...keywordReasons, ...regexReasons].slice(0, 3).join(', ');
  return { score01, reason: reasons };
}

function buildQueryBundle(hint: RuntimeSkillHint, maxUserSignalChars: number, maxToolSignalChars: number): QueryBundle {
  const userSignal = sanitizeSignal(hint.userText, maxUserSignalChars);
  const toolSignal = sanitizeSignal(hint.toolText, maxToolSignalChars);
  const merged = dedupeStrings([userSignal, toolSignal].filter(Boolean)).join('\n');
  if (!merged) return { queries: [], queryWeights: [], signal: '' };

  const queriesRaw: string[] = [];
  if (userSignal) queriesRaw.push(userSignal);
  if (toolSignal) queriesRaw.push(toolSignal);
  if (userSignal && toolSignal) {
    const fuse = `${userSignal}\n${toolSignal}`.trim();
    if (fuse) queriesRaw.push(fuse);
  }
  const queries = dedupeStrings(queriesRaw).map((q) => limitText(q, 1800));
  if (queries.length === 0) return { queries: [], queryWeights: [], signal: '' };

  let weights: number[];
  if (queries.length === 1) {
    weights = [1];
  } else {
    const base = queries.map((_, idx) => {
      if (idx === 0) return 1.2;
      if (idx === 1 && toolSignal) return 0.95;
      return 0.85;
    });
    const sum = base.reduce((acc, x) => acc + x, 0);
    weights = base.map((x) => x / (sum || 1));
  }

  return { queries, queryWeights: weights, signal: merged };
}

function getEmbeddingSettings(): {
  apiKey: string;
  model: string;
  baseURL: string;
  timeoutMs: number;
} {
  const apiKey = String(getEnv('EMBEDDING_API_KEY', getEnv('API_KEY')) || '').trim();
  const model = String(getEnv('EMBEDDING_MODEL', 'qwen3-embedding-4b') || 'qwen3-embedding-4b').trim();
  const baseURL = String(getEnv('EMBEDDING_API_BASE_URL', getEnv('API_BASE_URL')) || '').trim();
  const timeoutMs = getEnvTimeoutMs('BUNDLE_EMBEDDING_TIMEOUT_MS', 8000, 300000);
  return { apiKey, model, baseURL, timeoutMs };
}

function resetEmbeddingClient(): void {
  embeddingClient = null;
  embeddingClientKey = '';
  embeddingInitFailed = false;
}

onEnvReload((payload) => {
  const changed = new Set<string>([
    ...(Array.isArray(payload?.added) ? payload.added : []),
    ...(Array.isArray(payload?.updated) ? payload.updated : []),
    ...(Array.isArray(payload?.removed) ? payload.removed : [])
  ]);
  if (
    changed.has('EMBEDDING_API_KEY')
    || changed.has('EMBEDDING_API_BASE_URL')
    || changed.has('EMBEDDING_MODEL')
    || changed.has('API_KEY')
    || changed.has('API_BASE_URL')
  ) {
    resetEmbeddingClient();
  }
});

function getEmbeddingClient(): OpenAIEmbeddings | null {
  if (embeddingClient) return embeddingClient;
  if (embeddingInitFailed) return null;

  const settings = getEmbeddingSettings();
  if (!settings.apiKey) {
    embeddingInitFailed = true;
    return null;
  }
  const key = `${settings.baseURL}|${settings.model}|${hashFNV1a(settings.apiKey)}`;
  if (embeddingClient && embeddingClientKey === key) return embeddingClient;
  try {
    const clientConfig: { apiKey: string; model: string; configuration?: { baseURL: string } } = {
      apiKey: settings.apiKey,
      model: settings.model
    };
    if (settings.baseURL) clientConfig.configuration = { baseURL: settings.baseURL };
    embeddingClient = new OpenAIEmbeddings(clientConfig);
    embeddingClientKey = key;
  } catch {
    embeddingInitFailed = true;
    embeddingClient = null;
    embeddingClientKey = '';
  }
  return embeddingClient;
}

async function withTimeout<T>(factory: () => Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = Math.max(2000, Math.min(300000, Number(timeoutMs) || 20000));
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      factory(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${timeout}`)), timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readVectorCache(key: string): number[] | null {
  const item = embeddingVectorCache.get(key);
  if (!item) return null;
  if (Date.now() - item.at > EMBEDDING_CACHE_TTL_MS) {
    embeddingVectorCache.delete(key);
    return null;
  }
  return Array.isArray(item.vector) ? item.vector : null;
}

function writeVectorCache(key: string, vector: number[]): void {
  if (!Array.isArray(vector) || vector.length === 0) return;
  embeddingVectorCache.set(key, { vector, at: Date.now() });
  if (embeddingVectorCache.size <= EMBEDDING_CACHE_MAX_ITEMS) return;
  const entries = Array.from(embeddingVectorCache.entries())
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, Math.max(1, embeddingVectorCache.size - EMBEDDING_CACHE_MAX_ITEMS));
  for (const [k] of entries) embeddingVectorCache.delete(k);
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const client = getEmbeddingClient();
  if (!client) return [];
  const settings = getEmbeddingSettings();
  const clean = texts.map((x) => limitText(String(x || '').trim(), 2800));
  if (!clean.length) return [];

  const out = new Array<number[]>(clean.length).fill([]);
  const missIndices: number[] = [];
  const missTexts: string[] = [];
  for (let i = 0; i < clean.length; i++) {
    const text = String(clean[i] || '');
    if (!text) continue;
    const cacheKey = `${embeddingClientKey}|${hashFNV1a(text)}`;
    const cached = readVectorCache(cacheKey);
    if (cached) {
      out[i] = cached;
      continue;
    }
    missIndices.push(i);
    missTexts.push(text);
  }

  if (missTexts.length > 0) {
    try {
      const vectors = await withTimeout(
        () => client.embedDocuments(missTexts),
        settings.timeoutMs
      );
      for (let i = 0; i < missIndices.length; i++) {
        const idx = Number(missIndices[i]);
        if (!Number.isInteger(idx) || idx < 0 || idx >= out.length) continue;
        const vec = Array.isArray(vectors?.[i]) ? vectors[i] : [];
        const normalized = Array.isArray(vec)
          ? vec.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
          : [];
        out[idx] = normalized;
        const text = String(clean[idx] || '');
        if (normalized.length > 0) {
          const cacheKey = `${embeddingClientKey}|${hashFNV1a(text)}`;
          writeVectorCache(cacheKey, normalized);
        }
      }
    } catch {
      return [];
    }
  }

  return out;
}

function buildRerankUrl(baseURL: string): string {
  const root = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!root) return '';
  if (/\/rerank$/i.test(root)) return root;
  if (/\/v\d+$/i.test(root)) return `${root}/rerank`;
  return `${root}/v1/rerank`;
}

async function rerankDocuments(
  query: string,
  documents: string[],
  settings: { baseURL: string; apiKey: string; model: string; timeoutMs: number }
): Promise<Array<{ index: number; score: number }>> {
  const q = String(query || '').trim();
  const docs = (Array.isArray(documents) ? documents : []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!q || docs.length === 0) return [];
  const url = buildRerankUrl(settings.baseURL);
  if (!url) return [];

  const controller = new AbortController();
  const timeout = Math.max(2000, Math.min(300000, Number(settings.timeoutMs) || 20000));
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const payload = {
      model: settings.model || 'BAAI/bge-reranker-v2-m3',
      query: q,
      documents: docs,
      top_n: docs.length
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => ({})) as { results?: Array<{ index?: number; relevance_score?: number }> };
    const list = Array.isArray(json?.results) ? json.results : [];
    return list
      .map((x) => ({ index: Number(x?.index), score: Number(x?.relevance_score || 0) }))
      .filter((x) => Number.isInteger(x.index) && x.index >= 0 && Number.isFinite(x.score));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function getRerankSettings(): {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
} {
  const baseURL = String(getEnv('RERANK_BASE_URL', '') || '').trim();
  const apiKey = String(getEnv('RERANK_API_KEY', '') || '').trim();
  const model = String(getEnv('RERANK_MODEL', 'BAAI/bge-reranker-v2-m3') || 'BAAI/bge-reranker-v2-m3').trim();
  const timeoutMs = getEnvTimeoutMs('RERANK_TIMEOUT_MS', 20000, 300000);
  return { baseURL, apiKey, model, timeoutMs };
}

async function resolveGuideRelevance(
  guides: LoadedGuide[],
  queryBundle: QueryBundle
): Promise<{
  relevanceByGuide: number[];
  queryRelByGuide: number[][];
  docVectors: number[][];
  usedOnlineRerank: boolean;
}> {
  const docs = guides.map((g) => buildSkillDoc(g));
  const queryCount = queryBundle.queries.length;
  if (!docs.length || queryCount === 0) {
    return {
      relevanceByGuide: guides.map(() => 0),
      queryRelByGuide: guides.map(() => []),
      docVectors: guides.map(() => []),
      usedOnlineRerank: false
    };
  }

  const vectors = await embedTexts([...queryBundle.queries, ...docs]);
  const queryVecs = vectors.slice(0, queryCount);
  const docVecs = vectors.slice(queryCount);

  let coarseByGuide = guides.map(() => 0);
  let perQueryRelByGuide = guides.map(() => queryBundle.queries.map(() => 0));

  const hasVectors = queryVecs.length === queryCount
    && docVecs.length === docs.length
    && queryVecs.every((v) => Array.isArray(v) && v.length > 0)
    && docVecs.every((v) => Array.isArray(v) && v.length > 0);

  if (hasVectors) {
    const raw: number[][] = [];
    for (let qi = 0; qi < queryVecs.length; qi++) {
      const row: number[] = [];
      for (let di = 0; di < docVecs.length; di++) {
        row.push(cosineSimilarity(queryVecs[qi] as number[], docVecs[di] as number[]));
      }
      raw.push(row);
    }
    const normByQuery = raw.map((row) => normalizeScores(row));
    perQueryRelByGuide = guides.map((_, di) => {
      return normByQuery.map((row) => Number(row?.[di] || 0));
    });
    coarseByGuide = guides.map((_, di) => {
      const relList = perQueryRelByGuide[di] || [];
      if (!relList.length) return 0;
      const weighted = relList.reduce((acc, rel, qi) => acc + (rel * (queryBundle.queryWeights[qi] || 0)), 0);
      const maxRel = Math.max(...relList);
      return clamp01((weighted * 0.85) + (maxRel * 0.15));
    });
  }

  const rerankSettings = getRerankSettings();
  const canOnlineRerank = !!rerankSettings.baseURL
    && !!rerankSettings.apiKey
    && !!rerankSettings.model;

  if (!canOnlineRerank) {
    return {
      relevanceByGuide: coarseByGuide,
      queryRelByGuide: perQueryRelByGuide,
      docVectors: docVecs,
      usedOnlineRerank: false
    };
  }

  const queryTasks = queryBundle.queries.map((query) => rerankDocuments(query, docs, rerankSettings));
  const settled = await Promise.all(queryTasks);
  const valid = settled.filter((arr) => Array.isArray(arr) && arr.length > 0);
  if (valid.length === 0) {
    return {
      relevanceByGuide: coarseByGuide,
      queryRelByGuide: perQueryRelByGuide,
      docVectors: docVecs,
      usedOnlineRerank: false
    };
  }

  const rankFusion = guides.map(() => 0);
  let onlineHitCount = 0;

  for (let qi = 0; qi < settled.length; qi++) {
    const qWeight = Number(queryBundle.queryWeights[qi] || 0);
    if (!(qWeight > 0)) continue;
    const coarseRanks = buildRankPositions(
      guides.map((_, di) => Number(perQueryRelByGuide[di]?.[qi] || 0))
    );

    const list = settled[qi];
    const rerankRankByGuide = new Array<number>(guides.length).fill(-1);
    if (Array.isArray(list) && list.length > 0) {
      const rerankSorted = list
        .map((item) => ({
          idx: Number(item?.index),
          score: Number(item?.score || 0)
        }))
        .filter((x) => Number.isInteger(x.idx) && x.idx >= 0 && x.idx < guides.length)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.idx - b.idx;
        });

      if (rerankSorted.length > 0) {
        onlineHitCount += 1;
        const normalized = normalizeScores(rerankSorted.map((x) => x.score));
        for (let rank = 0; rank < rerankSorted.length; rank++) {
          const item = rerankSorted[rank];
          if (!item) continue;
          const idx = item.idx;
          rerankRankByGuide[idx] = rank;
          const relRow = perQueryRelByGuide[idx];
          if (!relRow) continue;
          relRow[qi] = Math.max(Number(relRow[qi] || 0), Number(normalized[rank] || 0));
        }
      }
    }

    for (let di = 0; di < guides.length; di++) {
      const coarseRank = Number(coarseRanks[di] || 0);
      const coarseRrf = reciprocalRank(coarseRank, RRF_CONFIG.rankK);
      const rerankRank = Number(rerankRankByGuide[di] || -1);
      const rerankRrf = rerankRank >= 0
        ? reciprocalRank(rerankRank, RRF_CONFIG.rankK)
        : 0;
      const fused = rerankRank >= 0
        ? ((RRF_CONFIG.rerankWeight * rerankRrf) + (RRF_CONFIG.coarseWeight * coarseRrf))
        : coarseRrf;
      const currentFusion = Number(rankFusion[di] || 0);
      rankFusion[di] = currentFusion + (qWeight * fused);
    }
  }

  const fusedValues = normalizeScores(rankFusion);
  const coarseValues = normalizeScores(coarseByGuide);
  const relevanceByGuide = guides.map((_, idx) => {
    const fused = Number(fusedValues[idx] || 0);
    const coarse = Number(coarseValues[idx] || 0);
    return clamp01((fused * 0.9) + (coarse * 0.1));
  });

  return {
    relevanceByGuide,
    queryRelByGuide: perQueryRelByGuide,
    docVectors: docVecs,
    usedOnlineRerank: onlineHitCount > 0
  };
}

function buildSystemBlock(items: Array<{ guide: LoadedGuide; ref: RuntimeSkillRef }>): string {
  if (!items.length) return '';
  const lines: string[] = [];
  lines.push('## Dynamic Skill Block [ADVISORY]');
  lines.push('- Runtime-selected sub-skill guidance from semantic retrieval + reranking.');
  lines.push('- Advisory only. Core mode/output contracts remain authoritative.');
  lines.push('- Ordering policy: model score desc, then priority asc as tie-break.');
  lines.push('');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    lines.push(`### ${i + 1}. ${item.guide.title} [RULE-ID: ${item.ref.uuid || 'N/A'}; PRIORITY: ${item.ref.priority}]`);
    lines.push(
      `<!-- dynamic_skill id=${item.ref.id}; priority=${item.ref.priority}; confidence=${item.ref.confidence.toFixed(3)}; score=${item.ref.score.toFixed(3)} -->`
    );
    if (item.ref.reason) lines.push(`> trigger: ${item.ref.reason}`);
    if (item.guide.guideContent) lines.push(item.guide.guideContent);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function buildSkillRefsXml(refs: RuntimeSkillRef[], stage: string): string {
  if (!refs.length) return '';
  const lines: string[] = [];
  lines.push('<sentra-skills>');
  lines.push('  <objective>Use refs to locate matching dynamic skill guidance in system prompt.</objective>');
  for (const ref of refs) {
    lines.push('  <sentra-skill>');
    lines.push(`    <id>${escapeXml(ref.id)}</id>`);
    lines.push(`    <uuid>${escapeXml(ref.uuid || '')}</uuid>`);
    lines.push(`    <priority>${escapeXml(String(ref.priority))}</priority>`);
    lines.push('  </sentra-skill>');
  }
  lines.push('</sentra-skills>');
  return lines.join('\n');
}

function loadGuides(): LoadedGuide[] {
  const rootDir = getGuidesRootDir();
  const stamp = computeDirStamp(rootDir);
  if (cacheGuides.length > 0 && cacheDirStamp === stamp && Date.now() - cacheLoadedAtMs < 3000) {
    return cacheGuides;
  }

  const out: LoadedGuide[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    cacheGuides = [];
    cacheDirStamp = stamp;
    cacheLoadedAtMs = Date.now();
    return cacheGuides;
  }

  for (const entry of entries) {
    if (!entry || !entry.isDirectory()) continue;
    const folder = path.resolve(rootDir, entry.name);
    const manifestPath = path.resolve(folder, 'skill.json');
    const raw = safeReadJson(manifestPath);
    if (!raw) continue;
    const manifest = normalizeManifest(raw, entry.name);
    if (!manifest) continue;
    const guidePath = path.resolve(folder, manifest.guideFile || 'guide.md');
    const guideContent = safeReadText(guidePath).trim();
    const compiledRegex = manifest.triggers.regex
      .map((x) => parseRegexPattern(x))
      .filter((x): x is RegExp => !!x);
    out.push({
      ...manifest,
      guideContent,
      compiledRegex
    });
  }

  out.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id.localeCompare(b.id);
  });

  cacheGuides = out;
  cacheDirStamp = stamp;
  cacheLoadedAtMs = Date.now();
  return cacheGuides;
}

function selectByCoverage(rows: CandidateRow[], maxSkills: number, queryCount: number): CandidateRow[] {
  if (rows.length <= maxSkills) return rows.slice();

  const selected: CandidateRow[] = [];
  const selectedSet = new Set<number>();
  const coverage = new Array<number>(queryCount).fill(0);

  const applyPick = (row: CandidateRow) => {
    if (selectedSet.has(row.index)) return;
    selected.push(row);
    selectedSet.add(row.index);
    for (let i = 0; i < coverage.length; i++) {
      const current = Number(coverage[i] || 0);
      coverage[i] = Math.max(current, Number(row.queryRel[i] || 0));
    }
  };

  for (let qi = 0; qi < queryCount; qi++) {
    if (selected.length >= maxSkills) break;
    let best: CandidateRow | null = null;
    let bestVal = -1;
    for (const row of rows) {
      if (selectedSet.has(row.index)) continue;
      const val = Number(row.queryRel[qi] || 0) * 0.86 + row.final01 * 0.14;
      if (val > bestVal) {
        bestVal = val;
        best = row;
      }
    }
    if (best) applyPick(best);
  }

  while (selected.length < maxSkills) {
    let best: CandidateRow | null = null;
    let bestGain = -Infinity;
    for (const row of rows) {
      if (selectedSet.has(row.index)) continue;
      let nextCoverageSum = 0;
      let currentCoverageSum = 0;
      for (let i = 0; i < coverage.length; i++) {
        const current = Number(coverage[i] || 0);
        currentCoverageSum += current;
        nextCoverageSum += Math.max(current, Number(row.queryRel[i] || 0));
      }
      const coverageGain = clamp01(nextCoverageSum - currentCoverageSum);

      let redundancy = 0;
      if (Array.isArray(row.docVector) && row.docVector.length > 0) {
        for (const picked of selected) {
          if (!Array.isArray(picked.docVector) || picked.docVector.length === 0) continue;
          redundancy = Math.max(redundancy, cosineSimilarity(row.docVector, picked.docVector));
        }
      }

      const gain =
        (COVERAGE_SELECT.score * row.final01)
        + (COVERAGE_SELECT.coverage * coverageGain)
        - (COVERAGE_SELECT.redundancy * redundancy);
      if (gain > bestGain) {
        bestGain = gain;
        best = row;
      }
    }
    if (!best) break;
    applyPick(best);
  }

  return selected.slice(0, maxSkills);
}

export async function resolveRuntimeSkillGuides(
  mode: RuntimeSkillMode,
  hint: RuntimeSkillHint = {},
  options: SkillResolverOptions = {}
): Promise<RuntimeSkillSelection> {
  const normalizedMode = normalizeMode(mode || 'full');
  const maxSkills = clamp(
    Number(options.maxSkills || RUNTIME_SKILL_DEFAULTS.maxSkills),
    RUNTIME_SKILL_LIMITS.minMaxSkills,
    RUNTIME_SKILL_LIMITS.maxMaxSkills
  );
  const minConfidence = clamp(
    Number(options.minConfidence || RUNTIME_SKILL_DEFAULTS.minConfidence),
    RUNTIME_SKILL_LIMITS.minConfidence,
    RUNTIME_SKILL_LIMITS.maxConfidence
  );
  const minScore = Math.max(
    RUNTIME_SKILL_LIMITS.minScore,
    Number(options.minScore || RUNTIME_SKILL_DEFAULTS.minScore)
  );
  const maxUserSignalChars = Math.max(
    RUNTIME_SKILL_LIMITS.minSignalChars,
    Number(options.maxUserSignalChars || RUNTIME_SKILL_DEFAULTS.maxUserSignalChars)
  );
  const maxToolSignalChars = Math.max(
    RUNTIME_SKILL_LIMITS.minSignalChars,
    Number(options.maxToolSignalChars || RUNTIME_SKILL_DEFAULTS.maxToolSignalChars)
  );

  const queryBundle = buildQueryBundle(hint, maxUserSignalChars, maxToolSignalChars);
  if (!queryBundle.signal) {
    return { refs: [], signal: '', systemBlock: '', skillRefsXml: '' };
  }

  const stage = String(hint.stage || 'runtime').trim() || 'runtime';
  const allAutoGuides = loadGuides()
    .filter((x) => x.selection === 'auto')
    .filter((x) => modeAllowed(x, normalizedMode));
  const guides = allAutoGuides;
  if (!guides.length) {
    return { refs: [], signal: queryBundle.signal, systemBlock: '', skillRefsXml: '' };
  }

  const relevanceResolved = await resolveGuideRelevance(guides, queryBundle);
  const priorityValues = guides.map((g) => Number(g.priority || 1000));
  const normalizedPriority = normalizeScores(priorityValues.map((p) => -p));

  const rows: CandidateRow[] = guides.map((guide, idx) => {
    const relevance01 = clamp01(Number(relevanceResolved.relevanceByGuide[idx] || 0));
    const queryRelRow = relevanceResolved.queryRelByGuide[idx];
    const queryRel = Array.isArray(queryRelRow)
      ? queryRelRow
      : queryBundle.queries.map(() => 0);
    const intent01 = clamp01(
      queryRel.reduce((acc, rel, qi) => acc + (rel * (queryBundle.queryWeights[qi] || 0)), 0)
    );
    const lexical = computeKeywordRegexSignal(guide, queryBundle.signal);
    const lexical01 = clamp01(lexical.score01);
    const priority01 = clamp01(Number(normalizedPriority[idx] || 0));

    const hasOnlineRerank = relevanceResolved.usedOnlineRerank;
    const intentBoost = clamp01((queryBundle.queries.length - 1) / 3);
    const relevanceW = hasOnlineRerank ? 0.74 : 0.66;
    const intentW = WEIGHT_BASE.intent + (0.03 * intentBoost);
    const priorityW = WEIGHT_BASE.priority;
    const lexicalW = Math.max(0.02, 1 - relevanceW - intentW - priorityW);
    const dynamicBonus = guide.runtimeDynamic ? STABILITY_CONFIG.dynamicSkillBonus : 0;
    const final01 = clamp01(
      (relevanceW * relevance01)
      + (intentW * intent01)
      + (priorityW * priority01)
      + (lexicalW * lexical01)
      + dynamicBonus
    );
    const confidence01 = final01;
    const score = (final01 * 3.0) + (intent01 * 0.2);

    const reasonParts: string[] = [];
    reasonParts.push(`rel:${relevance01.toFixed(3)}`);
    if (intent01 > 0.05) reasonParts.push(`intent:${intent01.toFixed(3)}`);
    if (lexical.reason) reasonParts.push(lexical.reason);
    if (guide.runtimeDynamic) reasonParts.push('dyn:1');
    reasonParts.push(relevanceResolved.usedOnlineRerank ? 'rr:online' : 'rr:coarse');

    const rowBase = {
      guide,
      index: idx,
      relevance01,
      intent01,
      lexical01,
      priority01,
      confidence01,
      score,
      final01,
      reason: reasonParts.slice(0, 4).join(', '),
      queryRel
    };
    const docVector = relevanceResolved.docVectors[idx];
    if (Array.isArray(docVector) && docVector.length > 0) {
      return { ...rowBase, docVector };
    }
    return rowBase;
  });

  const stickyKey = `${normalizedMode}|${stage}`;
  const stickySnapshot = stickySelectionMemory.get(stickyKey);
  const stickyFresh = !!stickySnapshot
    && (Date.now() - Number(stickySnapshot.at || 0) <= STABILITY_CONFIG.stickyMaxAgeMs);
  const stickyOverlap = stickyFresh
    ? jaccardOverlap(queryBundle.signal, String(stickySnapshot?.signal || ''))
    : 0;
  const stickyIds = stickyFresh && stickyOverlap >= STABILITY_CONFIG.stickySignalOverlapMin
    ? new Set<string>(Array.isArray(stickySnapshot?.ids) ? stickySnapshot!.ids : [])
    : new Set<string>();

  if (stickyIds.size > 0) {
    for (const row of rows) {
      if (!stickyIds.has(row.guide.id)) continue;
      row.final01 = clamp01(row.final01 + STABILITY_CONFIG.stickyBoost);
      row.score = (row.final01 * 3.0) + (row.intent01 * 0.2);
      row.reason = appendReason(row.reason, `sticky:${stickyOverlap.toFixed(2)}`);
    }
  }

  const rowById = new Map<string, CandidateRow>();
  for (const row of rows) {
    if (!row || !row.guide?.id) continue;
    rowById.set(row.guide.id, row);
  }
  const depBoostById = new Map<string, number>();
  const depParents = [...rows]
    .sort((a, b) => {
      if (b.final01 !== a.final01) return b.final01 - a.final01;
      if (a.guide.priority !== b.guide.priority) return a.guide.priority - b.guide.priority;
      return a.guide.id.localeCompare(b.guide.id);
    })
    .slice(0, Math.max(maxSkills * STABILITY_CONFIG.candidateWindowMultiplier, 10));

  for (let rank = 0; rank < depParents.length; rank++) {
    const parent = depParents[rank];
    if (!parent) continue;
    const deps = Array.isArray(parent.guide.deps) ? parent.guide.deps : [];
    if (!deps.length) continue;
    const rankDecay = 1 / (1 + (rank * 0.35));
    const baseBoost = 0.045 * parent.final01 * rankDecay;
    for (const depIdRaw of deps) {
      const depId = String(depIdRaw || '').trim();
      if (!depId || depId === parent.guide.id) continue;
      const depRow = rowById.get(depId);
      if (!depRow) continue;
      const old = Number(depBoostById.get(depId) || 0);
      depBoostById.set(depId, Math.min(STABILITY_CONFIG.depBoostCap, old + baseBoost));
    }
  }

  if (depBoostById.size > 0) {
    for (const row of rows) {
      const boost = Number(depBoostById.get(row.guide.id) || 0);
      if (!(boost > 0)) continue;
      row.final01 = clamp01(row.final01 + boost);
      row.score = (row.final01 * 3.0) + (row.intent01 * 0.2);
      row.reason = appendReason(row.reason, `dep:+${boost.toFixed(3)}`);
    }
  }

  const filtered = rows
    .filter((row) => row.score >= minScore)
    .filter((row) => row.confidence01 >= minConfidence)
    .sort((a, b) => {
      if (b.final01 !== a.final01) return b.final01 - a.final01;
      if (b.score !== a.score) return b.score - a.score;
      if (a.guide.priority !== b.guide.priority) return a.guide.priority - b.guide.priority;
      return a.guide.id.localeCompare(b.guide.id);
    });

  const rankedRows = filtered.length > 0
    ? filtered
    : [...rows].sort((a, b) => {
      if (b.final01 !== a.final01) return b.final01 - a.final01;
      if (b.score !== a.score) return b.score - a.score;
      if (a.guide.priority !== b.guide.priority) return a.guide.priority - b.guide.priority;
      return a.guide.id.localeCompare(b.guide.id);
    });

  const candidateWindowSize = Math.min(
    rankedRows.length,
    Math.max(maxSkills + 2, maxSkills * STABILITY_CONFIG.candidateWindowMultiplier)
  );
  const candidates = rankedRows.slice(0, candidateWindowSize);
  const selectedRows = selectByCoverage(candidates, maxSkills, queryBundle.queries.length);
  const refs: RuntimeSkillRef[] = selectedRows.map((row) => ({
    id: row.guide.id,
    uuid: row.guide.uuid,
    title: row.guide.title,
    priority: Number.isFinite(row.guide.priority) ? row.guide.priority : 1000,
    confidence: Number(row.confidence01.toFixed(4)),
    score: Number(row.score.toFixed(4)),
    reason: row.reason
  }));

  const joined = selectedRows.map((row, i) => ({ guide: row.guide, ref: refs[i] }))
    .filter((x): x is { guide: LoadedGuide; ref: RuntimeSkillRef } => !!x && !!x.ref);

  stickySelectionMemory.set(stickyKey, {
    ids: refs.map((x) => x.id).filter(Boolean).slice(0, maxSkills),
    signal: queryBundle.signal,
    at: Date.now()
  });
  pruneStickySelectionMemory();

  return {
    refs,
    signal: queryBundle.signal,
    systemBlock: buildSystemBlock(joined),
    skillRefsXml: buildSkillRefsXml(refs, stage)
  };
}
