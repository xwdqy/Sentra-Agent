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
  const personaHint = '请结合你当前的预设/人设继续作答：当设置 QQ 头像失败时，要说明原因（文件路径/格式/WS 连接），给替代方案（提供本地文件路径/重试/检查服务）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你更换 QQ 头像，但当前没有提供 file 参数。你把要使用的头像文件路径或标识发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 file（本地头像文件路径或上传后得到的文件标识）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试设置 QQ 头像，但和 QQ 侧的接口连接超时了。你可以检查一下网络和 WS 服务状态，稍后我们再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS_SDK_URL 对应服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试设置 QQ 头像，但这次失败了。可能是文件路径不可用、格式不支持，或者 WS 服务未连接。我可以帮你换一张图或稍后重试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 file 指向的头像文件存在且可读',
      '如有需要更换一张大小合适的图片',
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
  const path = 'account.setQQAvatar';
  const requestId = `${path}-${Date.now()}`;
  const file = String(args.file || '');
  if (!file) return fail('file 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_account_setQQAvatar' }) });
  try {
    const resp = await wsCall({ url, path, args: [{ file }], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [{ file }], requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_account_setQQAvatar', file }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
