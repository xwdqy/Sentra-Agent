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
  const personaHint = '请结合你当前的预设/人设继续作答：当 QQ 群名片修改失败时，要说明原因（参数/权限/机器人状态/WS 连接），给替代方案（补参数/确认管理员权限/重试），并引导用户提供必要信息。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你修改群成员名片，但当前参数不完整（需要 group_id、user_id 和 card）。你把要改的群号、成员 QQ 号和名片内容发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 group_id（群号，数字）',
        '提供 user_id（成员 QQ 号，数字）',
        '提供 card（名片内容）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试修改群名片，但和 QQ 侧的连接/接口没有及时响应（像是超时了）。你确认一下机器人是否在线、WS 服务是否正常，然后我可以再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS_SDK_URL 对应的服务在线（默认 ws://localhost:6702）',
        '确认机器人在目标群内且具备改名片权限（通常需要管理员/群主）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试修改群名片，但这次执行失败了。常见原因是机器人权限不足、目标群/成员信息不正确，或者 WS 服务未连接。我可以帮你逐项排查后再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 group_id/user_id 是否正确',
      '确认机器人具备群管理权限',
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
  const path = 'group.setCard';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  const group_id = Number(args.group_id);
  const user_id = Number(args.user_id);
  const card = String(args.card || '');
  if (!Number.isFinite(group_id)) return fail('group_id 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_group_setCard' }) });
  if (!Number.isFinite(user_id)) return fail('user_id 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_group_setCard', group_id }) });
  if (!card) return fail('card 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_group_setCard', group_id, user_id }) });
  try {
    const resp = await wsCall({ url, path, args: [group_id, user_id, card], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [group_id, user_id, card], requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_group_setCard', group_id, user_id }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
