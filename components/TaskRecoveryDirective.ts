import { escapeXml } from '../utils/xmlUtils.js';

type TaskPromise = { content?: string; evidence?: string; fulfilled?: boolean };
type TaskToolCall = { name?: string; code?: string; success?: boolean | null };
type TaskRecoveryTask = {
  taskId?: string;
  status?: string;
  summary?: string;
  reason?: string;
  timestamp?: string;
  promises?: TaskPromise[];
  toolCalls?: TaskToolCall[];
};
type TaskRecoveryOptions = {
  task?: TaskRecoveryTask | null;
  chatType?: string;
  groupId?: string | number;
  userId?: string | number;
};

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') {
    if (value == null) return '';
    return String(value);
  }
  return value;
}

function pickShortText(value: unknown): string {
  const raw = normalizeText(value).trim();
  if (!raw) return '';
  return raw;
}

function formatPromises(promises: TaskPromise[] | undefined): string {
  if (!Array.isArray(promises) || promises.length === 0) return '';
  return promises
    .map((p, i) => {
      const content = pickShortText(p?.content);
      const evidence = pickShortText(p?.evidence);
      const fulfilled = p?.fulfilled ? 'true' : 'false';
      return [
        '    <item>',
        `      <index>${i + 1}</index>`,
        `      <content>${escapeXml(content || '')}</content>`,
        `      <fulfilled>${fulfilled}</fulfilled>`,
        `      <evidence>${escapeXml(evidence || '')}</evidence>`,
        '    </item>'
      ].join('\n');
    })
    .join('\n');
}

function formatToolCalls(toolCalls: TaskToolCall[] | undefined): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  return toolCalls
    .map((t, i) => {
      const name = pickShortText(t?.name);
      const code = pickShortText(t?.code);
      const hasSuccess = typeof t?.success === 'boolean';
      const success = hasSuccess ? (t?.success ? 'true' : 'false') : '';
      return [
        '    <item>',
        `      <index>${i + 1}</index>`,
        `      <name>${escapeXml(name || '')}</name>`,
        ...(hasSuccess ? [`      <success>${success}</success>`] : []),
        `      <code>${escapeXml(code || '')}</code>`,
        '    </item>'
      ].join('\n');
    })
    .join('\n');
}

export function buildTaskRecoveryRootDirectiveXml(options: TaskRecoveryOptions = {}): string {
  const {
    task,
    chatType,
    groupId,
    userId
  } = options || {};

  const taskId = pickShortText(task?.taskId);
  const status = pickShortText(task?.status);
  const summary = pickShortText(task?.summary);
  const reason = pickShortText(task?.reason);
  const timestamp = pickShortText(task?.timestamp);
  const objectiveParts = [];

  objectiveParts.push('你正在处理一个未完成的任务，需要尽可能推进到完成。');
  objectiveParts.push('重要：这是“补全/恢复任务”回合，系统会给你旧任务的上下文，但你必须优先依据当前会话内的最新信息判断该任务是否仍然需要执行。');
  objectiveParts.push('如果你判断该任务已经在后续对话中被完成/替代/取消，或当前任务已过时不应再执行：你必须保持沉默，输出一个空的 <sentra-response></sentra-response>（不要追加任何解释）。');
  objectiveParts.push('只有当你确信任务仍未完成且仍然需要推进时，才继续执行补全。');
  if (summary) {
    objectiveParts.push(`任务摘要：${summary}`);
  }
  if (reason) {
    objectiveParts.push(`未完成原因：${reason}`);
  }
  objectiveParts.push('如果缺少关键信息，请提出具体问题；如果工具失败，尝试重试或给出替代方案。');
  objectiveParts.push('若本轮仍无法完成，请直接告知当前现状与原因，不要继续重试。');
  objectiveParts.push('最终回复只对用户说结果或需要的补充信息，不要提到内部任务文件或流程。');

  const objective = objectiveParts.join(' ');
  const promiseXml = formatPromises(task?.promises);
  const toolCallXml = formatToolCalls(task?.toolCalls);

  const lines = [];
  lines.push('<sentra-root-directive>');
  lines.push('  <id>task_recovery_v1</id>');
  lines.push('  <type>proactive</type>');
  lines.push('  <scope>conversation</scope>');
  lines.push('  <target>');
  lines.push(`    <chat_type>${escapeXml(chatType || 'private')}</chat_type>`);
  if (groupId) {
    lines.push(`    <group_id>${escapeXml(String(groupId))}</group_id>`);
  }
  if (userId) {
    lines.push(`    <user_id>${escapeXml(String(userId))}</user_id>`);
  }
  lines.push('  </target>');
  lines.push(`  <objective>${escapeXml(objective)}</objective>`);
  lines.push('  <task_context>');
  if (taskId) {
    lines.push(`    <task_id>${escapeXml(taskId)}</task_id>`);
  }
  if (status) {
    lines.push(`    <status>${escapeXml(status)}</status>`);
  }
  if (timestamp) {
    lines.push(`    <timestamp>${escapeXml(timestamp)}</timestamp>`);
  }
  if (summary) {
    lines.push(`    <summary>${escapeXml(summary)}</summary>`);
  }
  if (reason) {
    lines.push(`    <reason>${escapeXml(reason)}</reason>`);
  }
  if (promiseXml) {
    lines.push('    <promises>');
    lines.push(promiseXml);
    lines.push('    </promises>');
  }
  if (toolCallXml) {
    lines.push('    <tool_calls>');
    lines.push(toolCallXml);
    lines.push('    </tool_calls>');
  }
  lines.push('  </task_context>');
  lines.push('</sentra-root-directive>');
  return lines.join('\n');
}
