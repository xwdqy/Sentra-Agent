import type { DelayReasonArgs, DelayReasonCode } from './delayReasonCodes.js';
import { DELAY_RUNTIME_AI_NAME, DELAY_RUNTIME_KIND } from './delayRuntimeConstants.js';

export type DelayReplayToolResultEvent = {
  type?: string;
  runId?: string;
  resultStream?: unknown;
  aiName?: string;
  stepId?: string;
  plannedStepIndex?: number | string;
  stepIndex?: number | string;
  executionIndex?: number | string;
  resultStatus?: string;
  reason?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  events?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type DelayReplayPayload = {
  kind?: typeof DELAY_RUNTIME_KIND.dueReplayPayload | string;
  jobId?: string | number;
  delaySessionId?: string;
  runId?: string;
  orchestratorRunId?: string;
  reason?: string;
  reasonCode?: DelayReasonCode | string;
  reasonArgs?: DelayReasonArgs;
  hasTool?: boolean;
  delayWhenText?: string;
  delayTargetISO?: string;
  replayCursor?: {
    nextOffset?: number;
    totalEvents?: number;
    status?: string;
    updatedAt?: number;
  };
  deferredResponseXml?: string;
  deferredToolResultEvents?: DelayReplayToolResultEvent[];
};

export type DelayDueTriggerJob = {
  kind?: typeof DELAY_RUNTIME_KIND.dueTriggerJob | string;
  jobId?: string | number;
  delaySessionId?: string;
  runId?: string;
  orchestratorRunId?: string;
  createdAt?: number;
  fireAt?: number;
  delayMs?: number;
  type?: string;
  groupId?: string | number | null;
  userId?: string | number | null;
  aiName?: typeof DELAY_RUNTIME_AI_NAME.dueTrigger | string;
  reason?: string;
  reasonCode?: DelayReasonCode | string;
  reasonArgs?: DelayReasonArgs;
  hasTool?: boolean;
  delayWhenText?: string;
  delayTargetISO?: string;
  deferredResponseXml?: string;
  deferredToolResultEvents?: DelayReplayToolResultEvent[];
  [key: string]: unknown;
};
