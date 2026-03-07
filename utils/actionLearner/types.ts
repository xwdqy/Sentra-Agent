export const ACTION_LABELS = ['silent', 'short', 'action', 'delay'] as const;

export type ActionLabel = (typeof ACTION_LABELS)[number];

export type ChatType = 'private' | 'group';

export interface ActionPayloadContext {
  format: 'sentra_input_xml' | 'plain_text';
  canonicalContent: string;
  placeholder?: string;
}

export interface ActionFeatureVector {
  version: string;
  dim: number;
  indices: number[];
  values: number[];
  l2Norm: number;
}

export interface ActionFeatureInput {
  text: string;
  chatType: ChatType;
  isMentioned: boolean;
  activeTaskCount: number;
  isFollowupAfterBotReply: boolean;
  payload?: ActionPayloadContext;
}

export interface ActionTeacherSignal {
  source: 'llm_reply_gate_decision';
  action: ActionLabel;
  confidence: number | null;
  reasonCode?: string;
}

export interface ActionOutcomeSignal {
  hasQuickFollowup?: boolean;
  isUserSatisfied?: boolean;
}

export interface ActionTrainingSample {
  sampleId: string;
  ts: number;
  conversationId: string;
  chatType: ChatType;
  text: string;
  payload?: ActionPayloadContext;
  meta: {
    isMentioned: boolean;
    activeTaskCount: number;
    isFollowupAfterBotReply: boolean;
  };
  teacher: ActionTeacherSignal;
  outcome?: ActionOutcomeSignal;
}

export interface ActionPrediction {
  label: ActionLabel;
  probabilities: Record<ActionLabel, number>;
  confidence: number;
  margin: number;
  entropy: number;
}

export interface ActionModelState {
  schemaVersion: string;
  dim: number;
  labels: ActionLabel[];
  alpha: number;
  beta: number;
  l1: number;
  l2: number;
  trainedSamples: number;
  zByLabel: number[][];
  nByLabel: number[][];
}

export interface ActionStoreSampleRecord {
  id: string;
  sample: ActionTrainingSample;
}

export interface ActionLearnerMetrics {
  trained: number;
  skipped: number;
  lastCursor: string;
  elapsedMs: number;
}
