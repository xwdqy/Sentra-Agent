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
  const personaHint = '请结合你当前的预设/人设继续作答：当设置在线状态失败时，要说明原因（参数/机器人状态/WS 连接/权限），给替代方案（补参数/重试/检查服务）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你设置在线状态，但当前参数不完整或格式不对（status/ext_status/battery_status 都需要是整数）。你把要设置的状态值发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 status（整数）',
        '提供 ext_status（整数）',
        '提供 battery_status（整数）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试设置在线状态，但 QQ 侧接口没有及时响应（像是超时了）。你确认一下机器人是否在线、WS 服务是否可用，然后我可以再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS_SDK_URL 对应服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试设置在线状态，但这次执行失败了。可能是 WS 服务未连接、机器人离线或权限/参数不支持。我可以帮你排查后再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认参数是整数且在可用范围',
      '确认机器人与 WS 服务在线',
      '稍后重试',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

export default async function handler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const url = String(penv.WS_SDK_URL || 'ws://localhost:6702');
  const timeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || 15000));
  const path = 'system.setOnlineStatus';
  const requestId = `${path}-${Date.now()}`;
  const sraw = args.status;
  const eraw = (args.ext_status !== undefined) ? args.ext_status : args.extStatus;
  const braw = (args.battery_status !== undefined) ? args.battery_status : args.batteryStatus;
  const status = Number(sraw);
  const ext_status = Number(eraw);
  const battery_status = Number(braw);
  if (!Number.isFinite(status)) return fail('status 为必填，需为整数', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_system_setOnlineStatus' }) });
  if (!Number.isFinite(ext_status)) return fail('ext_status 为必填，需为整数', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_system_setOnlineStatus', status }) });
  if (!Number.isFinite(battery_status)) return fail('battery_status 为必填，需为整数', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_system_setOnlineStatus', status, ext_status }) });
  const argsArr = [{ status, ext_status, battery_status }];
  try {
    const resp = await wsCall({ url, path, args: argsArr, requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: argsArr, requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_system_setOnlineStatus', status, ext_status, battery_status }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
