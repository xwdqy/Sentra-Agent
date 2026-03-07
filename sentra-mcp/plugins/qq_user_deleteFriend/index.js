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
  const personaHint = '请结合你当前的预设/人设继续作答：当删除好友失败时，要说明原因（user_id 参数/关系状态/WS 连接/权限），并提醒用户这是不可逆操作。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你删除 QQ 好友，但需要提供 user_id（对方 QQ 号）。你确定后把 QQ 号发我，我会提醒你这是不可逆操作再继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 user_id（对方 QQ 号）',
        '再次确认你确实希望删除该好友',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试删除好友，但 QQ 侧接口长时间没有响应（像是超时了）。你可以稍后再试，或检查一下 WS 服务是否正常。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS 服务在线（默认 ws://localhost:6702）',
        '稍后再次尝试删除',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试删除好友，但这次失败了。可能是 WS 服务未连接、关系状态异常，或当前账号权限不足。我可以帮你确认 QQ 号和当前关系，再决定是否再次尝试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 user_id 是否正确且当前确实是好友',
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
  const path = 'user.deleteFriend';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  const user_id = Number(args.user_id);
  if (!Number.isFinite(user_id)) return fail('user_id 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_user_deleteFriend' }) });
  try {
    const resp = await wsCall({ url, path, args: [user_id], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [user_id], requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_user_deleteFriend', user_id }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
