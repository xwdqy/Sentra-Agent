import { randomUUID } from 'crypto';
import type { ActionLabel, ActionTrainingSample, ChatType } from './types.js';

type LexicalDoc = {
  docId: string;
  label: ActionLabel;
  textNorm: string;
  chatType: ChatType;
  tf: Map<string, number>;
  length: number;
  weight: number;
};

type LexicalPriorResult = {
  probabilities: Record<ActionLabel, number>;
  confidence: number;
  margin: number;
  candidateCount: number;
  minShouldMatch: number;
  matchedTerms: number;
};

const LEXICAL_DEFAULTS = Object.freeze({
  maxDocs: 30000,
  topKDocs: 64,
  bm25K1: 1.2,
  bm25B: 0.75,
  phraseBoost: 1.2,
  exactBoost: 2.4,
  queryContainBoost: 0.8,
  scoreTemperature: 1.3
});

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function normalizeText(raw: unknown): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCjkChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3040 && code <= 0x30ff)
  );
}

function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const words = text
    .split(/[\s,.;!?，。！？；、:："'`~@#$%^&*()_+\-=[\]{}<>|\\/]+/g)
    .map((w) => w.trim())
    .filter(Boolean);

  for (const w of words) {
    out.push(`w:${w}`);
  }

  const chars = Array.from(text).filter((ch) => isCjkChar(ch) || /[a-z0-9]/i.test(ch));
  for (let i = 0; i + 2 <= chars.length; i++) {
    const bg = chars.slice(i, i + 2).join('');
    out.push(`c2:${bg}`);
  }
  for (let i = 0; i + 3 <= chars.length; i++) {
    const tg = chars.slice(i, i + 3).join('');
    out.push(`c3:${tg}`);
  }
  return out;
}

function countTerms(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    const prev = tf.get(t) || 0;
    tf.set(t, prev + 1);
  }
  return tf;
}

function dynamicMinShouldMatch(termCount: number): number {
  if (termCount <= 0) return 0;
  if (termCount <= 2) return termCount;
  if (termCount <= 4) return termCount - 1;
  if (termCount <= 8) return Math.max(2, Math.ceil(termCount * 0.7));
  return Math.max(3, Math.ceil(termCount * 0.6));
}

function safeExp(x: number): number {
  const v = Math.max(-40, Math.min(40, x));
  return Math.exp(v);
}

export class ActionLexicalPriorEngine {
  private readonly docs = new Map<string, LexicalDoc>();
  private readonly docOrder: string[] = [];
  private readonly dedupMap = new Map<string, string>();
  private readonly inverted = new Map<string, Map<string, number>>();
  private readonly df = new Map<string, number>();
  private totalDocLength = 0;

  private readonly maxDocs = LEXICAL_DEFAULTS.maxDocs;
  private readonly topKDocs = LEXICAL_DEFAULTS.topKDocs;
  private readonly bm25K1 = LEXICAL_DEFAULTS.bm25K1;
  private readonly bm25B = LEXICAL_DEFAULTS.bm25B;
  private readonly phraseBoost = LEXICAL_DEFAULTS.phraseBoost;
  private readonly exactBoost = LEXICAL_DEFAULTS.exactBoost;
  private readonly queryContainBoost = LEXICAL_DEFAULTS.queryContainBoost;
  private readonly scoreTemperature = LEXICAL_DEFAULTS.scoreTemperature;

  private avgDocLength(): number {
    const n = this.docs.size;
    if (n <= 0) return 1;
    return Math.max(1, this.totalDocLength / n);
  }

  private makeDedupKey(label: ActionLabel, textNorm: string, chatType: ChatType): string {
    return `${label}|${chatType}|${textNorm}`;
  }

  private removeDoc(docId: string): void {
    const doc = this.docs.get(docId);
    if (!doc) return;
    this.docs.delete(docId);
    this.totalDocLength = Math.max(0, this.totalDocLength - doc.length);

    const dedupKey = this.makeDedupKey(doc.label, doc.textNorm, doc.chatType);
    const mappedId = this.dedupMap.get(dedupKey);
    if (mappedId === docId) this.dedupMap.delete(dedupKey);

    for (const term of doc.tf.keys()) {
      const posting = this.inverted.get(term);
      if (!posting) continue;
      if (posting.delete(docId)) {
        const oldDf = this.df.get(term) || 0;
        const nextDf = Math.max(0, oldDf - 1);
        if (nextDf === 0) {
          this.df.delete(term);
          this.inverted.delete(term);
        } else {
          this.df.set(term, nextDf);
        }
      }
    }
  }

  private ensureCapacity(): void {
    while (this.docs.size > this.maxDocs && this.docOrder.length > 0) {
      const oldest = this.docOrder.shift();
      if (!oldest) continue;
      this.removeDoc(oldest);
    }
  }

  learnFromSample(sample: ActionTrainingSample, sampleWeight: number): void {
    const textNorm = normalizeText(sample?.text);
    if (!textNorm) return;
    const label = sample.teacher?.action;
    if (!label) return;
    const chatType = sample.chatType === 'private' ? 'private' : 'group';

    let weight = Number.isFinite(sampleWeight) ? sampleWeight : 1;
    if (weight <= 0) return;
    const dedupKey = this.makeDedupKey(label, textNorm, chatType);
    const existingId = this.dedupMap.get(dedupKey);
    if (existingId) {
      const existing = this.docs.get(existingId);
      if (existing) {
        existing.weight = Math.min(10, existing.weight + weight * 0.1);
        return;
      }
    }

    const tokens = tokenize(textNorm);
    if (!tokens.length) return;
    const tf = countTerms(tokens);
    const length = Math.max(1, tokens.length);
    const docId = sample.sampleId || randomUUID();
    const doc: LexicalDoc = {
      docId,
      label,
      textNorm,
      chatType,
      tf,
      length,
      weight: Math.max(0.1, Math.min(5, weight))
    };

    this.docs.set(docId, doc);
    this.docOrder.push(docId);
    this.dedupMap.set(dedupKey, docId);
    this.totalDocLength += length;

    for (const [term, termTf] of tf.entries()) {
      let posting = this.inverted.get(term);
      if (!posting) {
        posting = new Map<string, number>();
        this.inverted.set(term, posting);
      }
      if (!posting.has(docId)) {
        this.df.set(term, (this.df.get(term) || 0) + 1);
      }
      posting.set(docId, termTf);
    }

    this.ensureCapacity();
  }

  score(textRaw: unknown, chatTypeRaw: unknown): LexicalPriorResult | null {
    const textNorm = normalizeText(textRaw);
    if (!textNorm) return null;
    const queryTokens = tokenize(textNorm);
    const queryTf = countTerms(queryTokens);
    if (!queryTf.size) return null;
    const queryTerms = Array.from(queryTf.keys());
    let anchorTerms = queryTerms.filter((t) => t.startsWith('w:'));
    let anchorMode: 'word' | 'c3' | 'c2' | 'mixed' = 'word';
    if (anchorTerms.length < 2) {
      anchorTerms = queryTerms.filter((t) => t.startsWith('c3:')).slice(0, 14);
      if (anchorTerms.length) anchorMode = 'c3';
    }
    if (anchorTerms.length < 2) {
      anchorTerms = queryTerms.filter((t) => t.startsWith('c2:')).slice(0, 18);
      if (anchorTerms.length) anchorMode = 'c2';
    }
    if (!anchorTerms.length) {
      anchorTerms = queryTerms.slice(0, 12);
      anchorMode = 'mixed';
    }
    let minShouldMatch = dynamicMinShouldMatch(anchorTerms.length);
    if (anchorMode === 'c3') {
      minShouldMatch = Math.max(2, Math.min(5, Math.ceil(anchorTerms.length * 0.3)));
    } else if (anchorMode === 'c2') {
      minShouldMatch = Math.max(3, Math.min(7, Math.ceil(anchorTerms.length * 0.35)));
    } else if (anchorMode === 'mixed') {
      minShouldMatch = Math.max(2, Math.min(4, Math.ceil(anchorTerms.length * 0.35)));
    }

    const matchedCount = new Map<string, number>();
    for (const term of anchorTerms) {
      const posting = this.inverted.get(term);
      if (!posting) continue;
      for (const docId of posting.keys()) {
        matchedCount.set(docId, (matchedCount.get(docId) || 0) + 1);
      }
    }

    const candidates: Array<{ doc: LexicalDoc; score: number; matchedTerms: number }> = [];
    const N = Math.max(1, this.docs.size);
    const avgLen = this.avgDocLength();
    const queryChatType = chatTypeRaw === 'private' ? 'private' : 'group';

    for (const [docId, count] of matchedCount.entries()) {
      if (count < minShouldMatch) continue;
      const doc = this.docs.get(docId);
      if (!doc) continue;

      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.tf.get(term) || 0;
        if (tf <= 0) continue;
        const df = this.df.get(term) || 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const denom = tf + this.bm25K1 * (1 - this.bm25B + this.bm25B * (doc.length / avgLen));
        score += idf * (tf * (this.bm25K1 + 1)) / Math.max(1e-6, denom);
      }

      if (doc.textNorm === textNorm) {
        score += this.exactBoost;
      } else if (doc.textNorm.includes(textNorm)) {
        score += this.phraseBoost;
      } else if (textNorm.includes(doc.textNorm)) {
        score += this.queryContainBoost;
      }

      if (doc.chatType === queryChatType) {
        score += 0.15;
      }

      score *= doc.weight;
      candidates.push({ doc, score, matchedTerms: count });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, this.topKDocs);
    let maxScore = Number.NEGATIVE_INFINITY;
    for (const c of top) {
      if (c.score > maxScore) maxScore = c.score;
    }
    if (!Number.isFinite(maxScore)) return null;

    const labelScore: Record<ActionLabel, number> = {
      silent: 0,
      short: 0,
      action: 0,
      delay: 0
    };
    let total = 0;
    let bestMatched = 0;
    for (const c of top) {
      const normalized = (c.score - maxScore) / Math.max(1e-6, this.scoreTemperature);
      const w = safeExp(normalized);
      labelScore[c.doc.label] += w;
      total += w;
      if (c.matchedTerms > bestMatched) bestMatched = c.matchedTerms;
    }
    if (!(total > 0)) return null;

    const probabilities: Record<ActionLabel, number> = {
      silent: clamp01(labelScore.silent / total),
      short: clamp01(labelScore.short / total),
      action: clamp01(labelScore.action / total),
      delay: clamp01(labelScore.delay / total)
    };

    const ranked = Object.entries(probabilities)
      .map(([label, value]) => ({ label: label as ActionLabel, value }))
      .sort((a, b) => b.value - a.value);
    const best = ranked[0]?.value ?? 0;
    const second = ranked[1]?.value ?? 0;

    return {
      probabilities,
      confidence: best,
      margin: Math.max(0, best - second),
      candidateCount: top.length,
      minShouldMatch,
      matchedTerms: bestMatched
    };
  }
}
