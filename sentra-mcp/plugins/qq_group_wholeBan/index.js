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
  const personaHint = '请结合你当前的预设/人设继续作答：当设置全员禁言失败时，要说明原因（参数/权限/机器人状态/WS 连接），给替代方案（确认管理员权限/重试）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你开启/关闭全员禁言，但需要提供 group_id（群号）以及 on/enable（true/false）。你把这些信息发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 group_id（群号，数字）',
        '提供 on 或 enable（布尔值 true/false）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试设置全员禁言，但 QQ 侧接口没有及时响应（像是超时了）。你确认机器人与 WS 服务在线后，我可以再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS 服务在线（默认 ws://localhost:6702）',
        '确认机器人具备管理员/群主权限',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试设置全员禁言，但这次失败了。常见原因是机器人权限不足或 WS 服务未连接。我可以帮你排查后再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认机器人是管理员/群主',
      '确认 group_id 正确',
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
  const path = 'group.wholeBan';
  const requestId = String(args.requestId || `${path}-${Date.now()}`);
  const group_id = Number(args.group_id);
  if (!Number.isFinite(group_id)) return fail('group_id 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_group_wholeBan' }) });
  const on = (typeof args.on === 'boolean') ? args.on : (typeof args.enable === 'boolean' ? args.enable : undefined);
  if (typeof on !== 'boolean') return fail('on/enable 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_group_wholeBan', group_id }) });
  try {
    const resp = await wsCall({ url, path, args: [group_id, on], requestId, timeoutMs });
    return ok({ request: { type: 'sdk', path, args: [group_id, on], requestId }, response: resp });
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_group_wholeBan', group_id, on }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
