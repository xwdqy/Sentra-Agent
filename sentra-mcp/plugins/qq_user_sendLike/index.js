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
  const personaHint = '请结合你当前的预设/人设继续作答：当点赞失败时，要说明原因（参数/机器人状态/WS 连接/频率限制），给替代方案（补参数/降低次数/稍后重试）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你给指定用户点赞，但需要提供 user_id（QQ号）和 times（次数）。你把这两个参数发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 user_id（数字）',
        '提供 times（数字，建议不要太大，避免频率限制）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试点赞，但 QQ 侧接口没有及时响应（像是超时了）。你确认机器人与 WS 服务在线后，我可以再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS 服务在线（默认 ws://localhost:6702）',
        '稍后重试或降低 times',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试点赞，但这次失败了。可能是 WS 服务未连接、机器人离线或触发了频率限制。我可以帮你降低次数或稍后重试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 user_id/times 正确',
      '降低 times 或稍后重试',
      '确认 WS 服务在线',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

export default async function handler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const url = String(penv.WS_SDK_URL || 'ws://localhost:6702');
  const timeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || 15000));
  const path = 'user.sendLike';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  const user_id = Number(args.user_id);
  if (!Number.isFinite(user_id)) return fail('user_id 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_user_sendLike' }) });
  const times = Number(args.times);
  if (!Number.isFinite(times)) return fail('times 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_user_sendLike', user_id }) });
  try {
    const resp = await wsCall({ url, path, args: [user_id, times], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [user_id, times], requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_user_sendLike', user_id, times }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
