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
  const personaHint = '请结合你当前的预设/人设继续作答：当修改 QQ 个人资料失败时，要说明原因（参数/格式/WS 连接/机器人状态），给替代方案（补参数/重试/检查服务）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你修改 QQ 个人资料，但当前参数不完整或不合法。你至少需要提供 nickname/personal_note/sex 其中一个，并且 sex 只能是 0/1/2。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 nickname（昵称）或 personal_note（签名）',
        '如需设置性别：sex 只能是 "0"(未知)/"1"(男)/"2"(女)',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试修改 QQ 资料，但连接没有及时响应（像是超时了）。你确认机器人与 WS 服务在线后，我可以再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS_SDK_URL 对应服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试修改 QQ 资料，但这次执行失败了。可能是 WS 服务未连接、机器人离线或参数不支持。我可以帮你排查后再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认提供了至少一个字段：nickname/personal_note/sex',
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
  const path = 'account.setQQProfile';
  const requestId = `${path}-${Date.now()}`;
  const payload = {};
  if (args.nickname !== undefined) payload.nickname = String(args.nickname);
  if (args.personal_note !== undefined) payload.personal_note = String(args.personal_note);
  if (args.sex !== undefined) {
    const sx = String(args.sex);
    if (sx === '0' || sx === '1' || sx === '2') payload.sex = sx; else {
      return fail('sex 仅允许 "0"|"1"|"2"', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_account_setQQProfile', sex: sx }) });
    }
  }
  if (!('nickname' in payload) && !('personal_note' in payload) && !('sex' in payload)) {
    return fail('至少提供 nickname/personal_note/sex 其中一个', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_account_setQQProfile' }) });
  }
  try {
    const resp = await wsCall({ url, path, args: [payload], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [payload], requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_account_setQQProfile', payload }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
