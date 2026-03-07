export type RuntimeReplyAction = 'silent' | 'action' | 'short' | 'delay';

export type DelayPlanLike = {
  whenText?: string;
  fireAt?: number;
  delayMs?: number;
  targetISO?: string;
  timezone?: string;
  parserMethod?: string;
  [key: string]: unknown;
};

export type ReplyDecisionLike = {
  needReply?: boolean;
  action?: unknown;
  delay?: unknown;
  reason?: unknown;
  reason_code?: unknown;
};

export type ReplyActionSchedule = {
  needReply: boolean;
  action: RuntimeReplyAction;
  reason: string;
  delayPlan: DelayPlanLike | null;
  delayWhen: string;
};

type ShortDirectiveBuilder<TMsg> = (msg: TMsg, reason?: string) => string;
type SceneMessageLike = { type?: unknown };

function escapeXmlText(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildShortReplyRootDirectiveXml(msg: SceneMessageLike, reason?: string): string {
  const scene = msg?.type === 'group' ? 'group' : (msg?.type === 'private' ? 'private' : 'unknown');
  const reasonText = reason && String(reason).trim()
    ? String(reason).replace(/\s+/g, ' ').trim()
    : '';
  const reasonCompact = reasonText.length > 120
    ? `${reasonText.slice(0, 120)}...`
    : reasonText;
  const objective = reasonCompact
    ? `Send a very short reaction only (${reasonCompact}).`
    : 'Send a very short reaction only.';
  return [
    '<sentra-root-directive>',
    '  <id>reply_action_short_v1</id>',
    '  <type>reply_action</type>',
    '  <scope>single_turn</scope>',
    `  <target><chat_type>${escapeXmlText(scene)}</chat_type></target>`,
    `  <objective>${escapeXmlText(objective)}</objective>`,
    '  <constraints>',
    '    <item>Output exactly one <sentra-message> block.</item>',
    '    <item>Use at most 2 segments.</item>',
    '    <item>Allowed forms: one short text (<= 12 chars), one sticker image segment, or short text + one sticker image segment.</item>',
    '    <item>Do not call tools or add process narration.</item>',
    '  </constraints>',
    '</sentra-root-directive>'
  ].join('\n');
}

function normalizeAction(rawAction: unknown, fallbackByNeedReply: boolean): RuntimeReplyAction {
  const raw = String(rawAction ?? '').trim().toLowerCase();
  if (raw === 'silent' || raw === 'none') return 'silent';
  if (raw === 'short') return 'short';
  if (raw === 'delay') return 'delay';
  if (raw === 'action') return 'action';
  return fallbackByNeedReply ? 'action' : 'silent';
}

function normalizeDelayPlan(raw: unknown): DelayPlanLike | null {
  if (!raw || typeof raw !== 'object') return null;
  return raw as DelayPlanLike;
}

export function scheduleReplyAction(decision: ReplyDecisionLike | null | undefined): ReplyActionSchedule {
  const needReply = !!decision?.needReply;
  let action = normalizeAction(decision?.action, needReply);
  const delayPlan = normalizeDelayPlan(decision?.delay);
  if (!needReply) {
    action = 'silent';
  } else if (action === 'delay' && !delayPlan) {
    action = 'action';
  }
  const reasonFromDetail = typeof decision?.reason === 'string' ? decision.reason.trim() : '';
  const reasonFromCode = typeof decision?.reason_code === 'string' ? decision.reason_code.trim() : '';
  const reason = reasonFromDetail || reasonFromCode;
  const delayWhen = action === 'delay' ? String(delayPlan?.whenText || '').trim() : '';
  return {
    needReply,
    action,
    reason,
    delayPlan,
    delayWhen
  };
}

export function applyScheduledReplyAction<TMsg extends object>(
  msg: TMsg,
  schedule: ReplyActionSchedule,
  options: { buildShortReplyRootDirectiveXml?: ShortDirectiveBuilder<TMsg> } = {}
): void {
  if (!schedule.needReply || schedule.action === 'silent') return;
  const target = msg as unknown as Record<string, unknown>;
  if (schedule.action === 'short') {
    target._replyAction = 'short';
    const buildShortDirective = typeof options.buildShortReplyRootDirectiveXml === 'function'
      ? options.buildShortReplyRootDirectiveXml
      : ((m: TMsg, reason?: string) => buildShortReplyRootDirectiveXml(m as unknown as SceneMessageLike, reason));
    const rootXml = buildShortDirective(msg, schedule.reason || undefined);
    if (typeof rootXml === 'string' && rootXml.trim()) {
      target._sentraRootDirectiveXml = rootXml;
    }
    return;
  }

  if (schedule.action === 'delay') {
    target._replyAction = 'delay';
    if (schedule.delayPlan) {
      target._delayPlan = schedule.delayPlan;
    }
    return;
  }

  target._replyAction = 'action';
}
