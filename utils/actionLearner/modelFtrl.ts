import { ACTION_LABELS, type ActionFeatureVector, type ActionLabel, type ActionModelState, type ActionPrediction } from './types.js';

export type MultiClassFtrlConfig = {
  dim: number;
  alpha: number;
  beta: number;
  l1: number;
  l2: number;
  softmaxTemperature?: number;
  labels?: ActionLabel[];
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function safeDiv(num: number, den: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

export class MultiClassFtrlModel {
  private readonly dim: number;
  private readonly alpha: number;
  private readonly beta: number;
  private readonly l1: number;
  private readonly l2: number;
  private readonly softmaxTemperature: number;
  private readonly labels: ActionLabel[];
  private readonly zByLabel: Float32Array[];
  private readonly nByLabel: Float32Array[];
  private trainedSamples = 0;

  constructor(config: MultiClassFtrlConfig) {
    this.dim = Number.isFinite(config.dim) && config.dim > 0 ? Math.floor(config.dim) : 8192;
    this.alpha = Number.isFinite(config.alpha) && config.alpha > 0 ? config.alpha : 0.05;
    this.beta = Number.isFinite(config.beta) && config.beta >= 0 ? config.beta : 1;
    this.l1 = Number.isFinite(config.l1) && config.l1 >= 0 ? config.l1 : 0;
    this.l2 = Number.isFinite(config.l2) && config.l2 >= 0 ? config.l2 : 0;
    this.softmaxTemperature =
      Number.isFinite(config.softmaxTemperature) && Number(config.softmaxTemperature) > 0
        ? Number(config.softmaxTemperature)
        : 1;
    this.labels = Array.isArray(config.labels) && config.labels.length ? config.labels.slice() : ACTION_LABELS.slice();
    this.zByLabel = this.labels.map(() => new Float32Array(this.dim));
    this.nByLabel = this.labels.map(() => new Float32Array(this.dim));
  }

  private weightFor(labelIndex: number, featureIndex: number): number {
    const z = this.zByLabel[labelIndex]?.[featureIndex] ?? 0;
    const n = this.nByLabel[labelIndex]?.[featureIndex] ?? 0;
    if (Math.abs(z) <= this.l1) return 0;
    const sign = z < 0 ? -1 : 1;
    const denom = (this.beta + Math.sqrt(Math.max(0, n))) / this.alpha + this.l2;
    return -(z - sign * this.l1) / denom;
  }

  private binaryScores(x: ActionFeatureVector): number[] {
    const scores = new Array<number>(this.labels.length).fill(0);
    const size = Math.min(x.indices.length, x.values.length);
    for (let classIndex = 0; classIndex < this.labels.length; classIndex++) {
      let sum = 0;
      for (let i = 0; i < size; i++) {
        const idx = x.indices[i];
        const value = x.values[i];
        if (idx == null || value == null) continue;
        if (!Number.isFinite(idx) || !Number.isFinite(value)) continue;
        if (idx < 0 || idx >= this.dim) continue;
        const w = this.weightFor(classIndex, idx);
        sum += w * value;
      }
      scores[classIndex] = sum;
    }
    return scores;
  }

  private classProbabilities(scores: number[]): number[] {
    if (!scores.length) return [];
    const invTemp = 1 / this.softmaxTemperature;
    let maxLogit = Number.NEGATIVE_INFINITY;
    const logits: number[] = new Array(scores.length).fill(0);
    for (let i = 0; i < scores.length; i++) {
      const logit = (scores[i] ?? 0) * invTemp;
      logits[i] = logit;
      if (logit > maxLogit) maxLogit = logit;
    }
    if (!Number.isFinite(maxLogit)) {
      const uniform = 1 / scores.length;
      return scores.map(() => uniform);
    }
    const exps: number[] = new Array(scores.length).fill(0);
    let total = 0;
    for (let i = 0; i < logits.length; i++) {
      const shifted = (logits[i] ?? 0) - maxLogit;
      const ev = Math.exp(Math.max(-60, Math.min(60, shifted)));
      exps[i] = ev;
      total += ev;
    }
    if (!Number.isFinite(total) || total <= 0) {
      const uniform = 1 / scores.length;
      return scores.map(() => uniform);
    }
    return exps.map((v) => v / total);
  }

  predict(x: ActionFeatureVector): ActionPrediction {
    const scores = this.binaryScores(x);
    const probs = this.classProbabilities(scores);
    if (!probs.length) {
      return {
        label: this.labels[0] || 'action',
        probabilities: {
          silent: 0,
          short: 0,
          action: 1,
          delay: 0
        },
        confidence: 1,
        margin: 1,
        entropy: 0
      };
    }
    let best = 0;
    let second = 0;
    for (let i = 0; i < probs.length; i++) {
      const pi = probs[i] ?? 0;
      const pBest = probs[best] ?? 0;
      const pSecond = probs[second] ?? 0;
      if (pi > pBest) {
        second = best;
        best = i;
      } else if (i !== best && pi > pSecond) {
        second = i;
      }
    }

    let entropy = 0;
    for (const p of probs) {
      const v = clamp01(p);
      if (v > 0) entropy += -v * Math.log(v);
    }
    const maxEntropy = Math.log(Math.max(2, probs.length));
    const normalizedEntropy = clamp01(safeDiv(entropy, maxEntropy));

    const probabilities = {} as Record<ActionLabel, number>;
    for (let i = 0; i < this.labels.length; i++) {
      const label = this.labels[i];
      if (!label) continue;
      probabilities[label] = clamp01(probs[i] ?? 0);
    }

    return {
      label: this.labels[best] || 'action',
      probabilities,
      confidence: clamp01(probs[best] ?? 0),
      margin: clamp01((probs[best] ?? 0) - (probs[second] ?? 0)),
      entropy: normalizedEntropy
    };
  }

  partialFit(x: ActionFeatureVector, target: ActionLabel, sampleWeight = 1): void {
    const targetIndex = this.labels.indexOf(target);
    if (targetIndex < 0) return;
    if (!Number.isFinite(sampleWeight) || sampleWeight <= 0) return;

    const scores = this.binaryScores(x);
    const probs = this.classProbabilities(scores);
    const size = Math.min(x.indices.length, x.values.length);

    for (let classIndex = 0; classIndex < this.labels.length; classIndex++) {
      const y = classIndex === targetIndex ? 1 : 0;
      const p = probs[classIndex] ?? 0;
      const error = (p - y) * sampleWeight;
      const zArr = this.zByLabel[classIndex];
      const nArr = this.nByLabel[classIndex];
      if (!zArr || !nArr) continue;
      for (let i = 0; i < size; i++) {
        const idx = x.indices[i];
        const value = x.values[i];
        if (idx == null || value == null) continue;
        if (!Number.isFinite(idx) || !Number.isFinite(value)) continue;
        if (idx < 0 || idx >= this.dim) continue;
        const g = error * value;
        const oldN = nArr[idx] ?? 0;
        const newN = oldN + g * g;
        const w = this.weightFor(classIndex, idx);
        const sigma = (Math.sqrt(newN) - Math.sqrt(oldN)) / this.alpha;
        zArr[idx] = (zArr[idx] ?? 0) + g - sigma * w;
        nArr[idx] = newN;
      }
    }
    this.trainedSamples += 1;
  }

  getTrainedSamples(): number {
    return this.trainedSamples;
  }

  exportState(): ActionModelState {
    return {
      schemaVersion: 'ftrl_ovr_v1',
      dim: this.dim,
      labels: this.labels.slice(),
      alpha: this.alpha,
      beta: this.beta,
      l1: this.l1,
      l2: this.l2,
      trainedSamples: this.trainedSamples,
      zByLabel: this.zByLabel.map((arr) => Array.from(arr)),
      nByLabel: this.nByLabel.map((arr) => Array.from(arr))
    };
  }

  importState(state: ActionModelState): void {
    if (!state || state.schemaVersion !== 'ftrl_ovr_v1') {
      throw new Error('unsupported model schema');
    }
    if (state.dim !== this.dim) {
      throw new Error(`model dim mismatch: expected ${this.dim}, got ${state.dim}`);
    }
    if (!Array.isArray(state.labels) || state.labels.length !== this.labels.length) {
      throw new Error('model labels mismatch');
    }
    for (let i = 0; i < this.labels.length; i++) {
      if (state.labels[i] !== this.labels[i]) {
        throw new Error('model labels order mismatch');
      }
    }

    for (let i = 0; i < this.labels.length; i++) {
      const zSrc = state.zByLabel[i] || [];
      const nSrc = state.nByLabel[i] || [];
      const zTarget = this.zByLabel[i];
      const nTarget = this.nByLabel[i];
      if (!zTarget || !nTarget) continue;
      zTarget.fill(0);
      nTarget.fill(0);
      const max = Math.min(this.dim, zSrc.length, nSrc.length);
      for (let j = 0; j < max; j++) {
        const z = Number(zSrc[j]);
        const n = Number(nSrc[j]);
        zTarget[j] = Number.isFinite(z) ? z : 0;
        nTarget[j] = Number.isFinite(n) ? n : 0;
      }
    }
    this.trainedSamples = Number.isFinite(state.trainedSamples) ? Math.max(0, Math.floor(state.trainedSamples)) : 0;
  }
}
