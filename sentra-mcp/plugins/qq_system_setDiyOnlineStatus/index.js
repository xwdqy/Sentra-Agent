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
  const personaHint = '请结合你当前的预设/人设继续作答：当设置自定义在线状态失败时，要说明原因（face_id/face_type/wording 参数、WS 连接、权限），给替代方案（补参数/稍后重试）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你设置自定义在线状态（小挂件/表情），但需要提供 face_id。你把想用的表情 ID 或配置告诉我，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 face_id（表情/挂件 ID，数字或字符串）',
        '可选提供 face_type/wording（类型与展示文案）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试设置自定义在线状态，但 QQ 侧接口长时间没有响应（像是超时了）。你可以稍后再试，或检查一下 WS 服务是否正常。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS 服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试设置自定义在线状态，但这次失败了。可能是 WS 服务未连接、机器人离线，或 face_id 配置暂不支持。我可以帮你换一个配置或稍后再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 face_id/face_type/wording 等参数是否正确',
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
  const path = 'system.setDiyOnlineStatus';
  const requestId = `${path}-${Date.now()}`;
  const payload = {};
  // face_id: required, number|string
  const hasFaceId = Object.prototype.hasOwnProperty.call(args, 'face_id');
  if (!hasFaceId) return fail('face_id 为必填', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_system_setDiyOnlineStatus' }) });
  const fidRaw = args.face_id;
  const fidNum = Number(fidRaw);
  payload.face_id = Number.isFinite(fidNum) ? fidNum : String(fidRaw);
  // face_type: optional, number|string
  if (Object.prototype.hasOwnProperty.call(args, 'face_type')) {
    const ftRaw = args.face_type;
    const ftNum = Number(ftRaw);
    payload.face_type = Number.isFinite(ftNum) ? ftNum : String(ftRaw);
  }
  // wording: optional string
  if (Object.prototype.hasOwnProperty.call(args, 'wording')) {
    payload.wording = String(args.wording);
  }
  try {
    const resp = await wsCall({ url, path, args: [payload], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [payload], requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_system_setDiyOnlineStatus', payload }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
