export const DELAY_REASON_CODE = Object.freeze({
  runtime: 'delay_action_runtime',
  dueReplay: 'delay_due_replay',
  routerReply: 'delay_action_router_reply',
  judgeReply: 'delay_action_judge',
  completed: 'delay_action_completed'
} as const);

export type DelayReasonCode = (typeof DELAY_REASON_CODE)[keyof typeof DELAY_REASON_CODE];

export type DelayReasonArgs = {
  delay_when?: string;
  delay_target_iso?: string;
  [key: string]: unknown;
};

const DELAY_REASON_CODE_SET = new Set<string>(Object.values(DELAY_REASON_CODE));

export function isDelayReasonCode(value: unknown): value is DelayReasonCode {
  return DELAY_REASON_CODE_SET.has(String(value || '').trim());
}

export function normalizeDelayReasonCode(
  value: unknown,
  fallback: DelayReasonCode = DELAY_REASON_CODE.dueReplay
): DelayReasonCode {
  const v = String(value || '').trim();
  return isDelayReasonCode(v) ? v : fallback;
}

export function normalizeDelayReasonArgs(value: unknown): DelayReasonArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

export function buildDelayReasonArgs(delayWhenTextRaw: unknown, delayTargetIsoRaw: unknown): DelayReasonArgs {
  const delayWhenText = String(delayWhenTextRaw || '').trim();
  const delayTargetISO = String(delayTargetIsoRaw || '').trim();
  return {
    delay_when: delayWhenText,
    delay_target_iso: delayTargetISO
  };
}
