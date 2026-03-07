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
  const personaHint = '请结合你当前的预设/人设继续作答：当设置模型展示失败时，要说明原因（参数/机器人状态/WS 连接/权限），给替代方案（补参数/重试/检查服务）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你设置“模型展示文案”，但需要提供 model 和 model_show。你把要设置的值发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 model（模型标识）',
        '提供 model_show（对外展示的文案）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试设置模型展示，但 QQ 侧接口没有及时响应（像是超时了）。你确认机器人与 WS 服务在线后，我可以再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS 服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试设置模型展示，但这次失败了。可能是 WS 服务未连接或机器人离线。我可以帮你排查后再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 model/model_show 已提供且非空',
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
  const path = 'system.setModelShow';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  const model = String(args.model || '');
  const model_show = String(args.model_show || '');
  if (!model) return fail('model 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_system_setModelShow' }) });
  if (!model_show) return fail('model_show 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_system_setModelShow', model }) });
  const payloadArgs = [{ model, model_show }];
  try {
    const resp = await wsCall({ url, path, args: payloadArgs, requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: payloadArgs, requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_system_setModelShow', model, model_show }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
