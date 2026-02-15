import { getEnvBool, getEnvInt } from './envHotReloader.js';
import { createLogger } from './logger.js';

const logger = createLogger('GroupReplyMerger');

type MessageLike = {
  group_id?: string | number | null;
  type?: string;
  sender_id?: string | number | null;
  sender_name?: string;
  message_id?: string | number | null;
  text?: string;
  summary?: string;
  time_str?: string;
  [key: string]: unknown;
};

type GroupMergeEntry = {
  senderId: string;
  msg: MessageLike;
  taskId: string;
};

type GroupMergeSession = {
  windowStart: number;
  entries: GroupMergeEntry[];
  timer: NodeJS.Timeout | null;
};

type HandleOneMessage = (msg: MessageLike, taskId?: string | null) => Promise<void> | void;
type CompleteTask = (convKey: string, taskId: string) => Promise<unknown> | void;

type GroupMergeDeps = {
  handleOneMessage?: HandleOneMessage;
  completeTask?: CompleteTask;
};

type HandleGroupReplyArgs = {
  groupId?: string | number | null;
  senderId?: string | number | null;
  bundledMsg?: MessageLike;
  taskId?: string | null;
};

function getMergeConfig(): { enabled: boolean; windowMs: number; maxUsers: number } {
  const enabled = getEnvBool('GROUP_MULTI_USER_MERGE_ENABLED', false) ?? false;
  const windowMs = getEnvInt('GROUP_MULTI_USER_MERGE_WINDOW_MS', 5000) ?? 5000;
  const maxUsers = getEnvInt('GROUP_MULTI_USER_MERGE_MAX_USERS', 2) ?? 2;
  return { enabled, windowMs, maxUsers };
}

const groupSessions = new Map<string, GroupMergeSession>(); // groupKey -> { windowStart, entries, timer }

function normalizeGroupId(groupId: unknown): string {
  return String(groupId || '');
}

function buildMergedMessage(entries: GroupMergeEntry[]): MessageLike {
  const primary = entries[0];
  if (!primary) return {};
  const base = { ...(primary.msg || {}) };

  const mergedUsers = entries.map((item, index) => {
    const m = item.msg || {};
    const text =
      (typeof m.text === 'string' && m.text.trim()) ||
      (typeof m.summary === 'string' && m.summary.trim()) ||
      '';
    return {
      index,
      sender_id: m.sender_id != null ? String(m.sender_id) : '',
      sender_name: m.sender_name || '',
      message_id: m.message_id != null ? String(m.message_id) : '',
      text,
      time_str: m.time_str || '',
      raw: m
    };
  });

  base._merged = true;
  base._mergedUsers = mergedUsers;
  base._mergedPrimarySenderId = primary.senderId;
  base._mergedUserCount = mergedUsers.length;

  return base;
}

async function finalizeGroup(groupKey: string, deps: GroupMergeDeps | null | undefined): Promise<void> {
  const session = groupSessions.get(groupKey);
  if (!session) return;
  groupSessions.delete(groupKey);

  if (session.timer) {
    clearTimeout(session.timer);
  }

  const entries = Array.isArray(session.entries) ? session.entries : [];
  if (entries.length === 0) return;

  const { handleOneMessage, completeTask } = deps || {};
  if (typeof handleOneMessage !== 'function') {
    return;
  }

  const primary = entries[0];
  if (!primary) return;
  const rest: GroupMergeEntry[] = [];
  for (let i = 1; i < entries.length; i++) {
    const item = entries[i];
    if (item) rest.push(item);
  }
  const mergedMsg = entries.length === 1 ? primary.msg : buildMergedMessage(entries);

  try {
    await handleOneMessage(mergedMsg, primary.taskId);
  } catch (e) {
    logger.error('handleOneMessage in group merge failed', e);
  }

  if (Array.isArray(rest) && rest.length > 0 && typeof completeTask === 'function') {
    for (const item of rest) {
      try {
        const g = item && item.msg && item.msg.group_id != null ? String(item.msg.group_id) : '';
        const s = item && item.senderId != null ? String(item.senderId) : '';
        const convKey = g ? `group_${g}_sender_${s}` : `private_${s}`;
        await completeTask(convKey, item.taskId);
      } catch (e) {
        logger.debug('completeTask for merged sender failed', { err: String(e) });
      }
    }
  }
}

export async function handleGroupReplyCandidate(args: HandleGroupReplyArgs | null | undefined, deps: GroupMergeDeps | null | undefined): Promise<void> {
  const { groupId, senderId, bundledMsg, taskId } = args || {};
  const { handleOneMessage } = deps || {};
  const groupKey = normalizeGroupId(groupId);

  if (!handleOneMessage || !groupKey || !bundledMsg || !taskId) {
    if (handleOneMessage && bundledMsg && taskId) {
      await handleOneMessage(bundledMsg, taskId);
    }
    return;
  }

  const { enabled, windowMs, maxUsers } = getMergeConfig();

  if (
    !enabled ||
    windowMs <= 0 ||
    maxUsers <= 1 ||
    bundledMsg.type !== 'group'
  ) {
    await handleOneMessage(bundledMsg, taskId);
    return;
  }

  let session = groupSessions.get(groupKey);
  const entry: GroupMergeEntry = { senderId: String(senderId ?? ''), msg: bundledMsg, taskId: String(taskId) };

  if (!session) {
    const nextSession: GroupMergeSession = {
      windowStart: Date.now(),
      entries: [entry],
      timer: null
    };
    groupSessions.set(groupKey, nextSession);
    nextSession.timer = setTimeout(() => {
      finalizeGroup(groupKey, deps).catch((e) => {
        logger.error('finalizeGroup timer error', e);
      });
    }, windowMs);
    return;
  }

  const existingIndex = session.entries.findIndex((it) => it.senderId === entry.senderId);
  if (existingIndex >= 0) {
    session.entries[existingIndex] = entry;
    return;
  }

  if (session.entries.length < maxUsers) {
    session.entries.push(entry);
    if (session.entries.length >= maxUsers) {
      await finalizeGroup(groupKey, deps);
    }
    return;
  }

  await finalizeGroup(groupKey, deps);

  const newSession: GroupMergeSession = {
    windowStart: Date.now(),
    entries: [entry],
    timer: null
  };
  groupSessions.set(groupKey, newSession);
  newSession.timer = setTimeout(() => {
    finalizeGroup(groupKey, deps).catch((e) => {
      logger.error('finalizeGroup timer error', e);
    });
  }, windowMs);
}
