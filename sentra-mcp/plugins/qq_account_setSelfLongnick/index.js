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
  const personaHint = '请结合你当前的预设/人设继续作答：当设置 QQ 个性签名失败时，要说明原因（内容为空/长度/WS 连接），给替代方案（重新提供文案/精简内容/稍后重试）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你修改 QQ 的个性签名（长签），但当前没有提供 longNick 文案。你把想要展示的签名内容发给我，我可以直接帮你设置。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 longNick（新的个性签名内容）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试设置 QQ 个性签名，但接口长时间没有响应（像是超时了）。你可以稍后再试，或者检查一下 WS 服务是否正常。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS_SDK_URL 对应服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试设置 QQ 个性签名，但这次失败了。可能是 WS 服务未连接、机器人离线，或签名内容暂时不被接受。我可以帮你换一段更简短的文案再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 longNick 内容已提供且符合平台要求',
      '如有需要可以先简化/缩短签名内容',
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
  const path = 'account.setSelfLongnick';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  const longNick = String(args.longNick || '');
  if (!longNick) return fail('longNick 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_account_setSelfLongnick' }) });
  try {
    const resp = await wsCall({ url, path, args: [longNick], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [longNick], requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_account_setSelfLongnick', longNick }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
