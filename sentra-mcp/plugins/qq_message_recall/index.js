import wsCall from '../../src/utils/ws_rpc.js';
import { ok, fail } from '../../src/utils/result.js';

function isTimeoutError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  const code = String(e?.code || '').toUpperCase();
  return (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'ECONNABORTED' ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  );
}

function buildAdvice(kind, ctx = {}) {
  const personaHint = '请结合你当前的预设/人设继续作答：当撤回消息失败时，要说明原因（message_id 参数/时间限制/权限/WS 连接），给替代方案（补参数/说明可能已过可撤回时间）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你撤回一条 QQ 消息，但需要提供 message_id（消息ID，一般是长数字）。你可以把要撤回的那条消息ID或相关引用发我，我来帮你处理。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 message_id（消息ID，通常由上游工具/日志给出）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试撤回消息，但 QQ 侧接口长时间没有响应（像是超时了）。你可以稍后再试，或检查一下 WS 服务是否正常。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS 服务在线（默认 ws://localhost:6702）',
        '稍后重试撤回操作',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试撤回消息，但这次失败了。可能是消息已超出可撤回时间、权限不足，或 WS 服务未连接。我可以帮你说明情况，并给出补救方案。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 message_id 是否正确且仍在可撤回时间窗口内',
      '确认机器人具备撤回该消息的权限',
      '确认 WS 服务在线后重试',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

export default async function handler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const url = String(penv.WS_SDK_URL || 'ws://localhost:6702');
  const timeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || 15000));
  const path = 'message.recall';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  const message_id = Number(args.message_id);
  if (!Number.isFinite(message_id)) return fail('message_id 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_message_recall' }) });
  try {
    const resp = await wsCall({ url, path, args: [message_id], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [message_id], requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_message_recall', message_id }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
