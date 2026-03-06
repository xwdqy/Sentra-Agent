import { randomUUID } from 'crypto';
import { createLogger } from '../logger.js';
import { loadActionLearnerConfig, type ActionLearnerConfig } from './config.js';
import { normalizeActionLearnerPayload, normalizeActionLearnerText } from './contentNormalizer.js';
import { ActionFeatureExtractor } from './featureExtractor.js';
import { ActionLexicalPriorEngine } from './lexicalPriorEngine.js';
import { MultiClassFtrlModel } from './modelFtrl.js';
import type {
  ActionFeatureInput,
  ActionLabel,
  ActionModelState,
  ActionPrediction,
  ActionTeacherSignal,
  ActionTrainingSample
} from './types.js';

const logger = createLogger('ActionLearnerRuntime');

type ReliabilityStats = {
  seen: number;
  hit: number;
};

type CalibrationState = {
  correctConfEma: number;
  wrongConfEma: number;
  correctMarginEma: number;
  wrongMarginEma: number;
  correctSeen: number;
  wrongSeen: number;
};

export type RuntimeDecision = {
  action: ActionLabel;
  acceptedByLocal: boolean;
  prediction: ActionPrediction;
  reasonCode: string;
};

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function updateEma(current: number, next: number, alpha: number): number {
  const a = clamp01(alpha);
  return current * (1 - a) + next * a;
}

function normalizeRuntimePayload(
  payload: ActionFeatureInput['payload'] | ActionTrainingSample['payload'] | undefined,
  fallbackText: string
): ActionFeatureInput['payload'] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const content = typeof payload.canonicalContent === 'string'
    ? payload.canonicalContent.trim()
    : '';
  if (!content) return undefined;

  const normalized = normalizeActionLearnerPayload({
    text: fallbackText,
    rawContent: content
  });
  if (!normalized.payload) return undefined;
  return {
    format: normalized.payload.format,
    canonicalContent: normalized.payload.canonicalContent,
    placeholder: normalized.payload.placeholder
  };
}

export class ActionLearnerRuntime {
  private readonly config: ActionLearnerConfig;
  private readonly extractor: ActionFeatureExtractor;
  private readonly model: MultiClassFtrlModel;
  private readonly lexicalPrior: ActionLexicalPriorEngine;
  private readonly modelReliability: ReliabilityStats = { seen: 0, hit: 0 };
  private readonly lexicalReliability: ReliabilityStats = { seen: 0, hit: 0 };
  private readonly fusionReliability: ReliabilityStats = { seen: 0, hit: 0 };
  private readonly calibration: CalibrationState = {
    correctConfEma: 0,
    wrongConfEma: 0,
    correctMarginEma: 0,
    wrongMarginEma: 0,
    correctSeen: 0,
    wrongSeen: 0
  };
  private readonly reliabilityWarmupMin = 120;
  private readonly emaAlpha = 0.06;

  constructor(configOverrides: Partial<ActionLearnerConfig> = {}) {
    this.config = loadActionLearnerConfig(configOverrides || {});
    this.extractor = new ActionFeatureExtractor(this.config);
    this.lexicalPrior = new ActionLexicalPriorEngine();
    this.model = new MultiClassFtrlModel({
      dim: this.config.dim,
      alpha: this.config.alpha,
      beta: this.config.beta,
      l1: this.config.l1,
      l2: this.config.l2,
      softmaxTemperature: this.config.softmaxTemperature
    });
  }

  private buildPredictionFromProbabilities(
    probabilities: Record<ActionLabel, number>
  ): ActionPrediction {
    const ordered = (Object.keys(probabilities) as ActionLabel[])
      .map((label) => ({ label, value: probabilities[label] ?? 0 }))
      .sort((a, b) => b.value - a.value);
    const best = ordered[0]?.value ?? 0;
    const second = ordered[1]?.value ?? 0;

    let entropy = 0;
    for (const label of Object.keys(probabilities) as ActionLabel[]) {
      const p = probabilities[label] ?? 0;
      if (p > 0) entropy += -p * Math.log(p);
    }
    const maxEntropy = Math.log(4);
    const entropyNorm = maxEntropy > 0 ? Math.max(0, Math.min(1, entropy / maxEntropy)) : 0;

    return {
      label: ordered[0]?.label ?? 'action',
      probabilities,
      confidence: best,
      margin: Math.max(0, best - second),
      entropy: entropyNorm
    };
  }

  private blendPredictions(
    modelPred: ActionPrediction,
    lexicalPred: {
      probabilities: Record<ActionLabel, number>;
      confidence: number;
      margin: number;
      candidateCount: number;
      matchedTerms: number;
      minShouldMatch: number;
    } | null
  ): ActionPrediction {
    if (!lexicalPred) return modelPred;

    const modelTrust =
      (this.modelReliability.hit + 1) / (this.modelReliability.seen + 2);
    const lexicalTrust =
      (this.lexicalReliability.hit + 1) / (this.lexicalReliability.seen + 2);
    const trustSum = modelTrust + lexicalTrust;
    const trustWeight = trustSum > 0 ? lexicalTrust / trustSum : 0.5;
    const lexicalEvidence =
      clamp01(lexicalPred.confidence) * clamp01(
        lexicalPred.minShouldMatch > 0
          ? lexicalPred.matchedTerms / lexicalPred.minShouldMatch
          : lexicalPred.confidence
      );
    const adaptiveWeightRaw = trustWeight * lexicalEvidence;
    const lexicalWeight = Math.max(0.08, Math.min(0.85, adaptiveWeightRaw));

    const fused: Record<ActionLabel, number> = {
      silent: 0,
      short: 0,
      action: 0,
      delay: 0
    };
    let total = 0;
    for (const label of Object.keys(fused) as ActionLabel[]) {
      const v = (modelPred.probabilities[label] || 0) * (1 - lexicalWeight) +
        (lexicalPred.probabilities[label] || 0) * lexicalWeight;
      fused[label] = Math.max(0, v);
      total += fused[label];
    }
    if (total > 0) {
      for (const label of Object.keys(fused) as ActionLabel[]) {
        fused[label] /= total;
      }
    }
    return this.buildPredictionFromProbabilities(fused);
  }

  private decideAcceptance(prediction: ActionPrediction): { acceptedByLocal: boolean; reasonCode: string } {
    const warmupSeen = this.fusionReliability.seen;
    if (warmupSeen < this.reliabilityWarmupMin || this.calibration.correctSeen < 40 || this.calibration.wrongSeen < 20) {
      const acceptedByLocal =
        prediction.confidence >= this.config.localAcceptConfidence &&
        prediction.margin >= this.config.localAcceptMargin;
      if (acceptedByLocal) return { acceptedByLocal: true, reasonCode: 'local_accept_warmup' };
      const inGrayZone =
        prediction.confidence >= this.config.grayZoneMin && prediction.confidence < this.config.grayZoneMax;
      return { acceptedByLocal: false, reasonCode: inGrayZone ? 'gray_zone_fallback_warmup' : 'low_confidence_fallback_warmup' };
    }

    const confThr = Math.max(
      0.4,
      Math.min(
        0.92,
        (this.calibration.correctConfEma + this.calibration.wrongConfEma) / 2
      )
    );
    const marginThr = Math.max(
      0.02,
      Math.min(
        0.45,
        (this.calibration.correctMarginEma + this.calibration.wrongMarginEma) / 2
      )
    );
    const acceptedByLocal = prediction.confidence >= confThr && prediction.margin >= marginThr;
    if (acceptedByLocal) return { acceptedByLocal: true, reasonCode: 'local_accept_adaptive' };
    const inGrayZone = prediction.confidence >= Math.max(0.35, confThr - 0.15) && prediction.confidence < confThr;
    return { acceptedByLocal: false, reasonCode: inGrayZone ? 'gray_zone_fallback_adaptive' : 'low_confidence_fallback_adaptive' };
  }

  private updateReliability(predicted: ActionLabel, truth: ActionLabel, channel: ReliabilityStats): void {
    channel.seen += 1;
    if (predicted === truth) channel.hit += 1;
  }

  private updateCalibration(prediction: ActionPrediction, truth: ActionLabel): void {
    const correct = prediction.label === truth;
    if (correct) {
      this.calibration.correctSeen += 1;
      this.calibration.correctConfEma = this.calibration.correctSeen === 1
        ? prediction.confidence
        : updateEma(this.calibration.correctConfEma, prediction.confidence, this.emaAlpha);
      this.calibration.correctMarginEma = this.calibration.correctSeen === 1
        ? prediction.margin
        : updateEma(this.calibration.correctMarginEma, prediction.margin, this.emaAlpha);
      return;
    }
    this.calibration.wrongSeen += 1;
    this.calibration.wrongConfEma = this.calibration.wrongSeen === 1
      ? prediction.confidence
      : updateEma(this.calibration.wrongConfEma, prediction.confidence, this.emaAlpha);
    this.calibration.wrongMarginEma = this.calibration.wrongSeen === 1
      ? prediction.margin
      : updateEma(this.calibration.wrongMarginEma, prediction.margin, this.emaAlpha);
  }

  predict(input: ActionFeatureInput): RuntimeDecision {
    const normalizedText = normalizeActionLearnerText(input.text);
    const normalizedPayload = normalizeRuntimePayload(input.payload, normalizedText);
    const normalizedInput: ActionFeatureInput = {
      ...input,
      text: normalizedText,
      ...(normalizedPayload ? { payload: normalizedPayload } : {})
    };
    const vector = this.extractor.build(normalizedInput);
    const modelPrediction = this.model.predict(vector);
    const lexicalPrediction = this.lexicalPrior.score(normalizedInput.text, normalizedInput.chatType);
    const prediction = this.blendPredictions(modelPrediction, lexicalPrediction);
    const decision = this.decideAcceptance(prediction);

    return {
      action: prediction.label,
      acceptedByLocal: decision.acceptedByLocal,
      prediction,
      reasonCode: decision.reasonCode
    };
  }

  learnFromSample(sample: ActionTrainingSample, sampleWeight = 1): void {
    const text = normalizeActionLearnerText(sample?.text);
    if (!text) return;
    const action = sample?.teacher?.action;
    if (!action) return;
    const normalizedPayload = normalizeRuntimePayload(sample?.payload, text);

    const featureInput = {
      text,
      chatType: sample.chatType,
      isMentioned: !!sample.meta?.isMentioned,
      activeTaskCount: Number(sample.meta?.activeTaskCount || 0),
      isFollowupAfterBotReply: !!sample.meta?.isFollowupAfterBotReply,
      ...(normalizedPayload ? { payload: normalizedPayload } : {})
    };
    const vector = this.extractor.build(featureInput);
    const modelPrediction = this.model.predict(vector);
    const lexicalPrediction = this.lexicalPrior.score(featureInput.text, featureInput.chatType);
    const fusedPrediction = this.blendPredictions(modelPrediction, lexicalPrediction);

    let weight = sampleWeight;
    const confidence = sample.teacher?.confidence;
    if (typeof confidence === 'number' && Number.isFinite(confidence)) {
      const clipped = Math.max(0.1, Math.min(1, confidence));
      weight *= clipped;
    }
    if (sample.outcome?.hasQuickFollowup && action === 'silent') {
      weight *= 0.5;
    }
    if (sample.outcome?.isUserSatisfied) {
      weight *= 1.2;
    }
    this.updateReliability(modelPrediction.label, action, this.modelReliability);
    if (lexicalPrediction) {
      const lexicalLabel = this.buildPredictionFromProbabilities(lexicalPrediction.probabilities).label;
      this.updateReliability(lexicalLabel, action, this.lexicalReliability);
    }
    this.updateReliability(fusedPrediction.label, action, this.fusionReliability);
    this.updateCalibration(fusedPrediction, action);

    this.model.partialFit(vector, action, weight);
    this.lexicalPrior.learnFromSample(sample, weight);
  }

  exportModel(): ActionModelState {
    return this.model.exportState();
  }

  importModel(state: ActionModelState): void {
    this.model.importState(state);
    logger.info('Action learner model loaded', { trainedSamples: this.model.getTrainedSamples() });
  }

  trainedCount(): number {
    return this.model.getTrainedSamples();
  }
}

export type BuildTeacherSampleInput = {
  conversationId: string;
  text: string;
  rawContent?: string;
  botNames?: Array<string | number>;
  chatType: 'private' | 'group';
  isMentioned: boolean;
  activeTaskCount: number;
  isFollowupAfterBotReply: boolean;
  teacher: ActionTeacherSignal;
};

export function buildTeacherSample(input: BuildTeacherSampleInput): ActionTrainingSample {
  const normalizeInput: {
    text: string;
    rawContent?: string;
    botNames?: Array<string | number>;
  } = {
    text: input.text
  };
  if (typeof input.rawContent === 'string') {
    normalizeInput.rawContent = input.rawContent;
  }
  if (Array.isArray(input.botNames) && input.botNames.length > 0) {
    normalizeInput.botNames = input.botNames;
  }
  const normalized = normalizeActionLearnerPayload(normalizeInput);
  const text = normalized.text;
  const teacher: ActionTeacherSignal = {
    source: 'llm_reply_gate_decision',
    action: input.teacher.action,
    confidence:
      typeof input.teacher.confidence === 'number' && Number.isFinite(input.teacher.confidence)
        ? Math.max(0, Math.min(1, input.teacher.confidence))
        : null
  };
  const reasonCode = typeof input.teacher.reasonCode === 'string' ? input.teacher.reasonCode.trim() : '';
  if (reasonCode) {
    teacher.reasonCode = reasonCode;
  }
  const sample: ActionTrainingSample = {
    sampleId: randomUUID(),
    ts: Date.now(),
    conversationId: String(input.conversationId || '').trim() || 'unknown',
    chatType: input.chatType === 'private' ? 'private' : 'group',
    text,
    meta: {
      isMentioned: !!input.isMentioned,
      activeTaskCount: Number.isFinite(input.activeTaskCount) ? Math.max(0, Math.floor(input.activeTaskCount)) : 0,
      isFollowupAfterBotReply: !!input.isFollowupAfterBotReply
    },
    teacher
  };
  if (normalized.payload) {
    sample.payload = normalized.payload;
  }
  return sample;
}
