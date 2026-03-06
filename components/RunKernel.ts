import { DELAY_RUNTIME_KIND } from '../utils/delayRuntimeConstants.js';
import { DELAY_REASON_CODE, normalizeDelayReasonArgs, normalizeDelayReasonCode } from '../utils/delayReasonCodes.js';

type LoggerLike = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

type DispatchMessageFn = (msg: Record<string, unknown>, taskId?: string | null) => Promise<void>;

export type RunKernelRuntimeEvent = {
  type: 'delay_due_triggered';
  payload: Record<string, unknown>;
} | {
  type: 'runtime_resume_checkpoint';
  payload: Record<string, unknown>;
};

type RunKernelContext = {
  logger?: LoggerLike;
  dispatchMessage: DispatchMessageFn;
};

function escXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildDelayDueRootDirectiveXml(whenTextRaw: unknown, targetIsoRaw: unknown): string {
  const whenText = String(whenTextRaw || '').trim();
  const targetIso = String(targetIsoRaw || '').trim();
  const objective = whenText || targetIso
    ? `The delayed task is now due (when="${whenText}", target_iso="${targetIso}"). Continue from current progress and report now.`
    : 'The delayed task is now due. Continue from current progress and report now.';
  return [
    '<sentra-root-directive>',
    '  <id>delay_due_runtime_v1</id>',
    '  <type>delay_due</type>',
    '  <scope>single_turn</scope>',
    `  <objective>${escXml(objective)}</objective>`,
    '  <constraints>',
    '    <item>This is due-time execution. Do not send another pre-delay acknowledgement.</item>',
    '    <item>If tool results are partial, replay them in original order and then continue normal runtime flow.</item>',
    '    <item>If no tool result is available yet, treat this as due-triggered commitment execution and deliver the promised reply now.</item>',
    '    <item>Produce user-facing sentra-message output only.</item>',
    '  </constraints>',
    '</sentra-root-directive>'
  ].join('\n');
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeDeferredToolResultEvents(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x) => x && typeof x === 'object')
    .map((x) => {
      const item = { ...(x as Record<string, unknown>) };
      if (!(typeof item.type === 'string' && item.type.trim())) {
        item.type = 'tool_result';
      }
      return item;
    });
}

function buildDelayDueMessage(payload: Record<string, unknown>): Record<string, unknown> | null {
  const baseMessage = toObject(payload.baseMessage);
  if (typeof baseMessage._delayReplay === 'object' && baseMessage._delayReplay) {
    return baseMessage;
  }

  const userId = String(
    payload.userId ?? payload.senderId ?? baseMessage.sender_id ?? ''
  ).trim();
  if (!userId) return null;
  const delayWhenText = String(payload.delayWhenText || '').trim();
  const delayTargetISO = String(payload.delayTargetISO || '').trim();
  const reasonCode = normalizeDelayReasonCode(
    payload.reasonCode || payload.reason || DELAY_REASON_CODE.dueReplay,
    DELAY_REASON_CODE.dueReplay
  );
  const reason = String(payload.reason || reasonCode).trim() || reasonCode;
  const reasonArgs = normalizeDelayReasonArgs(payload.reasonArgs);
  const deferredResponseXml = String(payload.deferredResponseXml || '').trim();
  const deferredToolResultEvents = normalizeDeferredToolResultEvents(payload.deferredToolResultEvents);
  const replayCursorRaw = toObject(payload.replayCursor);
  const runId = String(payload.runId || '').trim();
  const delaySessionId = String(payload.delaySessionId || '').trim();

  return {
    ...baseMessage,
    type: String(baseMessage.type || payload.type || (payload.groupId != null ? 'group' : 'private') || 'private'),
    sender_id: String(baseMessage.sender_id || userId).trim(),
    ...(payload.groupId != null ? { group_id: payload.groupId } : {}),
    _replyAction: 'action',
    _sentraRootDirectiveXml: buildDelayDueRootDirectiveXml(delayWhenText, delayTargetISO),
    _delayReplay: {
      kind: DELAY_RUNTIME_KIND.dueReplayPayload,
      jobId: String(payload.jobId || delaySessionId || '').trim(),
      delaySessionId: delaySessionId || undefined,
      runId,
      reason,
      reasonCode,
      reasonArgs,
      hasTool: payload.hasTool === true || deferredToolResultEvents.length > 0,
      delayWhenText,
      delayTargetISO,
      replayCursor: {
        nextOffset: Number.isFinite(Number(replayCursorRaw.nextOffset)) ? Math.max(0, Math.trunc(Number(replayCursorRaw.nextOffset))) : 0,
        totalEvents: Number.isFinite(Number(replayCursorRaw.totalEvents))
          ? Math.max(0, Math.trunc(Number(replayCursorRaw.totalEvents)))
          : deferredToolResultEvents.length,
        status: String(replayCursorRaw.status || '').trim(),
        updatedAt: Number.isFinite(Number(replayCursorRaw.updatedAt)) ? Math.trunc(Number(replayCursorRaw.updatedAt)) : 0
      },
      deferredResponseXml,
      deferredToolResultEvents
    }
  };
}

function parseConversationIdentity(conversationIdRaw: unknown, payloadRaw?: unknown): {
  type: 'private' | 'group';
  senderId: string;
  groupId: string;
} | null {
  const payload = toObject(payloadRaw);
  const fallbackSenderId = String(payload.senderId ?? payload.userId ?? '').trim();
  const fallbackGroupId = String(payload.groupId ?? '').trim();
  const conversationId = String(conversationIdRaw || '').trim();

  if (!conversationId) {
    if (fallbackGroupId && fallbackSenderId) {
      return {
        type: 'group',
        groupId: fallbackGroupId,
        senderId: fallbackSenderId
      };
    }
    if (fallbackSenderId) {
      return {
        type: 'private',
        senderId: fallbackSenderId,
        groupId: ''
      };
    }
    return null;
  }

  const lower = conversationId.toLowerCase();
  if (lower.startsWith('private_') || lower.startsWith('private:')) {
    const senderId = String(conversationId.slice(8) || '').trim();
    if (!senderId) return null;
    return {
      type: 'private',
      senderId,
      groupId: ''
    };
  }

  if (lower.startsWith('u_') || lower.startsWith('u:')) {
    const senderId = String(conversationId.slice(2) || '').trim();
    if (!senderId) return null;
    return {
      type: 'private',
      senderId,
      groupId: ''
    };
  }

  if (lower.startsWith('group_') || lower.startsWith('group:')) {
    const rest = String(conversationId.slice(6) || '').trim();
    const markers = ['_sender_', ':sender:', '_sender:', ':sender_'];
    let markerIndex = -1;
    let markerText = '';
    for (const marker of markers) {
      const idx = rest.toLowerCase().indexOf(marker);
      if (idx >= 0 && (markerIndex < 0 || idx < markerIndex)) {
        markerIndex = idx;
        markerText = marker;
      }
    }
    const groupId = markerIndex >= 0
      ? String(rest.slice(0, markerIndex) || '').trim()
      : rest;
    const senderId = markerIndex >= 0
      ? String(rest.slice(markerIndex + markerText.length) || '').trim()
      : fallbackSenderId;
    if (groupId && senderId) {
      return {
        type: 'group',
        groupId,
        senderId
      };
    }
  }

  if (lower.startsWith('g_') || lower.startsWith('g:')) {
    const groupId = String(conversationId.slice(2) || '').trim();
    if (groupId && fallbackSenderId) {
      return {
        type: 'group',
        groupId,
        senderId: fallbackSenderId
      };
    }
  }

  if (conversationId.includes('|')) {
    const parts = conversationId
      .split('|')
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    let groupId = '';
    let senderId = '';
    for (const part of parts) {
      const p = part.toLowerCase();
      if (!groupId && (p.startsWith('g_') || p.startsWith('g:'))) {
        groupId = String(part.slice(2) || '').trim();
      }
      if (!senderId && (p.startsWith('u_') || p.startsWith('u:'))) {
        senderId = String(part.slice(2) || '').trim();
      }
    }
    if (groupId && (senderId || fallbackSenderId)) {
      return {
        type: 'group',
        groupId,
        senderId: senderId || fallbackSenderId
      };
    }
    if (senderId) {
      return {
        type: 'private',
        senderId,
        groupId: ''
      };
    }
  }

  if (fallbackGroupId && fallbackSenderId) {
    return {
      type: 'group',
      groupId: fallbackGroupId,
      senderId: fallbackSenderId
    };
  }

  if (fallbackSenderId) {
    return {
      type: 'private',
      senderId: fallbackSenderId,
      groupId: ''
    };
  }
  return null;
}

function buildRuntimeResumeRootDirectiveXml(payload: Record<string, unknown>): string {
  const runId = String(payload.runId || '').trim();
  const stage = String(payload.stage || '').trim();
  const objective = String(payload.objective || '').trim();
  const reasonCode = String(payload.reasonCode || payload.lastReasonCode || '').trim();
  const status = String(payload.status || '').trim().toLowerCase();
  const lastCompletedStepIndexRaw = Number(payload.lastCompletedStepIndex);
  const totalStepsRaw = Number(payload.totalSteps);
  const lastCompletedStepIndex = Number.isFinite(lastCompletedStepIndexRaw)
    ? Math.max(-1, Math.trunc(lastCompletedStepIndexRaw))
    : -1;
  const totalSteps = Number.isFinite(totalStepsRaw)
    ? Math.max(0, Math.trunc(totalStepsRaw))
    : 0;
  const summary = objective
    ? `Resume unfinished runtime checkpoint run=${runId}, stage=${stage}, objective=${objective}`
    : `Resume unfinished runtime checkpoint run=${runId}, stage=${stage}`;
  return [
    '<sentra-root-directive>',
    '  <id>runtime_resume_checkpoint_v1</id>',
    '  <type>runtime_resume</type>',
    '  <scope>single_turn</scope>',
    `  <objective>${escXml(summary)}</objective>`,
    '  <constraints>',
    '    <item>This is a runtime resume trigger from checkpoint.</item>',
    '    <item>Continue unfinished work from available evidence; avoid duplicating already finished side-effects.</item>',
    `    <item>reason_code=${escXml(reasonCode || 'runtime_resume_checkpoint')}</item>`,
    `    <item>status=${escXml(status || 'running')}; last_completed_step_index=${lastCompletedStepIndex}; total_steps=${totalSteps}</item>`,
    '  </constraints>',
    '</sentra-root-directive>'
  ].join('\n');
}

function buildRuntimeResumeMessage(payload: Record<string, unknown>): Record<string, unknown> | null {
  const identity = parseConversationIdentity(payload.conversationId, payload);
  if (!identity || !identity.senderId) return null;
  const objective = String(payload.objective || '').trim();
  const text = objective || 'Continue unfinished task.';
  const runId = String(payload.runId || '').trim();
  const lastCompletedStepIndexRaw = Number(payload.lastCompletedStepIndex);
  const totalStepsRaw = Number(payload.totalSteps);
  const lastCompletedStepIndex = Number.isFinite(lastCompletedStepIndexRaw)
    ? Math.max(-1, Math.trunc(lastCompletedStepIndexRaw))
    : -1;
  const totalSteps = Number.isFinite(totalStepsRaw)
    ? Math.max(0, Math.trunc(totalStepsRaw))
    : 0;

  const base: Record<string, unknown> = {
    type: identity.type,
    sender_id: identity.senderId,
    text,
    _proactive: true,
    _proactiveFirst: true,
    _disablePreReply: true,
    _sentraRootDirectiveXml: buildRuntimeResumeRootDirectiveXml(payload),
    _runtimeResume: {
      fromCheckpoint: true,
      runId,
      conversationId: String(payload.conversationId || '').trim(),
      status: String(payload.status || '').trim(),
      stage: String(payload.stage || '').trim(),
      reasonCode: String(payload.reasonCode || payload.lastReasonCode || '').trim(),
      updatedAt: Number(payload.updatedAt || 0),
      objective,
      lastCompletedStepIndex,
      totalSteps
    },
    _taskIdOverride: runId || null
  };
  if (identity.type === 'group' && identity.groupId) {
    base.group_id = identity.groupId;
  }
  return base;
}

export function createRunKernel(ctx: RunKernelContext) {
  const logger = ctx?.logger || {};
  const dispatchMessage = ctx.dispatchMessage;

  const dispatchUserMessage = async (
    msg: Record<string, unknown>,
    taskId: string | null = null
  ) => {
    await dispatchMessage(msg, taskId);
  };

  const dispatchRuntimeEvent = async (event: RunKernelRuntimeEvent): Promise<void> => {
    if (!event || typeof event !== 'object') return;
    if (event.type !== 'delay_due_triggered' && event.type !== 'runtime_resume_checkpoint') {
      logger.debug?.('RunKernel: unsupported runtime event', { type: String((event as { type?: unknown })?.type || '') });
      return;
    }
    const payload = toObject(event.payload);
    if (event.type === 'runtime_resume_checkpoint') {
      const resumeMsg = buildRuntimeResumeMessage(payload);
      if (!resumeMsg) {
        logger.warn?.('RunKernel: runtime_resume_checkpoint skipped (conversation not parseable)', {
          conversationId: String(payload.conversationId || '').trim() || null,
          runId: String(payload.runId || '').trim() || null,
          userId: String(payload.userId || '').trim() || null,
          groupId: String(payload.groupId || '').trim() || null
        });
        return;
      }
      logger.info?.('RunKernel: dispatch runtime_resume_checkpoint', {
        runId: String(payload.runId || '').trim() || null,
        conversationId: String(payload.conversationId || '').trim() || null,
        stage: String(payload.stage || '').trim() || null
      });
      await dispatchMessage(resumeMsg, null);
      return;
    }
    const dueMsg = buildDelayDueMessage(payload);
    if (!dueMsg) {
      logger.warn?.('RunKernel: delay_due_triggered missing senderId/base message', {
        hasPayload: !!payload,
        payloadKeys: Object.keys(payload || {})
      });
      return;
    }
    logger.info?.('RunKernel: dispatch delay_due_triggered', {
      delaySessionId: String(payload.delaySessionId || '').trim() || null,
      runId: String(payload.runId || '').trim() || null
    });
    await dispatchMessage(dueMsg, null);
  };

  return {
    dispatchUserMessage,
    dispatchRuntimeEvent
  };
}

export default {
  createRunKernel
};