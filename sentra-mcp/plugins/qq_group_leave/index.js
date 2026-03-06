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
  const personaHint = '请结合你当前的预设/人设继续作答：当退出/解散群聊失败时，要说明原因（参数/权限/WS 连接），并提醒用户操作后果。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你退出或解散一个群，但需要提供 group_id（群号）。你把群号以及是否要解散/仅退出说明一下，我就继续操作。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 group_id（群号，数字）',
        '通过 dismiss=true/false 指定是解散还是仅自己退群（视平台支持）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试退出/解散群聊，但 QQ 侧接口长时间没有响应（像是超时了）。你可以先确认 WS 服务和机器人状态，稍后我再帮你执行。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS 服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试退出/解散群聊，但这次失败了。可能是机器人没有足够权限，或者 WS 服务未连接。我可以先帮你确认群号和权限，再尝试一次。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 group_id 正确且机器人在该群内',
      '确认机器人具备相应权限（管理员/群主）',
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
  const path = 'group.leave';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  const group_id = Number(args.group_id);
  if (!Number.isFinite(group_id)) return fail('group_id 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_group_leave' }) });
  const dismiss = typeof args.dismiss === 'boolean' ? args.dismiss : false;
  try {
    const resp = await wsCall({ url, path, args: [group_id, dismiss], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [group_id, dismiss], requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_group_leave', group_id, dismiss }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
