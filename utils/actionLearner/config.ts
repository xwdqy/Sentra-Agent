export type ActionLearnerConfig = {
  enabled: boolean;
  namespace: string;
  dim: number;
  charNgramMin: number;
  charNgramMax: number;
  wordNgramMin: number;
  wordNgramMax: number;
  maxTextLength: number;
  alpha: number;
  beta: number;
  l1: number;
  l2: number;
  softmaxTemperature: number;
  localAcceptConfidence: number;
  localAcceptMargin: number;
  grayZoneMin: number;
  grayZoneMax: number;
  trainerIntervalMs: number;
  trainerBatchSize: number;
  minTeacherConfidence: number;
  sampleStreamMaxLen: number;
};

export const ACTION_LEARNER_DEFAULTS = Object.freeze({
  enabled: true,
  namespace: 'sentra_action_learner',
  dim: 8192,
  charNgramMin: 2,
  charNgramMax: 4,
  wordNgramMin: 1,
  wordNgramMax: 2,
  maxTextLength: 1024,
  alpha: 0.05,
  beta: 1.0,
  l1: 0.0001,
  l2: 0.0001,
  softmaxTemperature: 1.0,
  localAcceptConfidence: 0.78,
  localAcceptMargin: 0.22,
  grayZoneMin: 0.45,
  grayZoneMax: 0.78,
  trainerIntervalMs: 5000,
  trainerBatchSize: 128,
  minTeacherConfidence: 0.7,
  sampleStreamMaxLen: 200000
});

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  }
  return fallback;
}

export function loadActionLearnerConfig(overrides: Partial<ActionLearnerConfig> = {}): ActionLearnerConfig {
  const raw = { ...ACTION_LEARNER_DEFAULTS, ...(overrides || {}) };
  const dim = clampInt(raw.dim, ACTION_LEARNER_DEFAULTS.dim, 1024, 262144);
  const charNgramMin = clampInt(
    raw.charNgramMin,
    ACTION_LEARNER_DEFAULTS.charNgramMin,
    1,
    8
  );
  const charNgramMax = clampInt(
    raw.charNgramMax,
    ACTION_LEARNER_DEFAULTS.charNgramMax,
    charNgramMin,
    8
  );
  const wordNgramMin = clampInt(
    raw.wordNgramMin,
    ACTION_LEARNER_DEFAULTS.wordNgramMin,
    1,
    4
  );
  const wordNgramMax = clampInt(
    raw.wordNgramMax,
    ACTION_LEARNER_DEFAULTS.wordNgramMax,
    wordNgramMin,
    4
  );

  return {
    enabled: toBoolean(raw.enabled, ACTION_LEARNER_DEFAULTS.enabled),
    namespace: String(raw.namespace || ACTION_LEARNER_DEFAULTS.namespace).trim() || ACTION_LEARNER_DEFAULTS.namespace,
    dim,
    charNgramMin,
    charNgramMax,
    wordNgramMin,
    wordNgramMax,
    maxTextLength: clampInt(
      raw.maxTextLength,
      ACTION_LEARNER_DEFAULTS.maxTextLength,
      64,
      16384
    ),
    alpha: clampFloat(raw.alpha, ACTION_LEARNER_DEFAULTS.alpha, 1e-6, 1),
    beta: clampFloat(raw.beta, ACTION_LEARNER_DEFAULTS.beta, 0, 10),
    l1: clampFloat(raw.l1, ACTION_LEARNER_DEFAULTS.l1, 0, 10),
    l2: clampFloat(raw.l2, ACTION_LEARNER_DEFAULTS.l2, 0, 10),
    softmaxTemperature: clampFloat(
      raw.softmaxTemperature,
      ACTION_LEARNER_DEFAULTS.softmaxTemperature,
      0.1,
      5
    ),
    localAcceptConfidence: clampFloat(
      raw.localAcceptConfidence,
      ACTION_LEARNER_DEFAULTS.localAcceptConfidence,
      0,
      1
    ),
    localAcceptMargin: clampFloat(
      raw.localAcceptMargin,
      ACTION_LEARNER_DEFAULTS.localAcceptMargin,
      0,
      1
    ),
    grayZoneMin: clampFloat(
      raw.grayZoneMin,
      ACTION_LEARNER_DEFAULTS.grayZoneMin,
      0,
      1
    ),
    grayZoneMax: clampFloat(
      raw.grayZoneMax,
      ACTION_LEARNER_DEFAULTS.grayZoneMax,
      0,
      1
    ),
    trainerIntervalMs: clampInt(
      raw.trainerIntervalMs,
      ACTION_LEARNER_DEFAULTS.trainerIntervalMs,
      500,
      120000
    ),
    trainerBatchSize: clampInt(
      raw.trainerBatchSize,
      ACTION_LEARNER_DEFAULTS.trainerBatchSize,
      1,
      4096
    ),
    minTeacherConfidence: clampFloat(
      raw.minTeacherConfidence,
      ACTION_LEARNER_DEFAULTS.minTeacherConfidence,
      0,
      1
    ),
    sampleStreamMaxLen: clampInt(
      raw.sampleStreamMaxLen,
      ACTION_LEARNER_DEFAULTS.sampleStreamMaxLen,
      1000,
      2000000
    )
  };
}
