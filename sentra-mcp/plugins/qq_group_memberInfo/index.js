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
  const personaHint = '请结合你当前的预设/人设继续作答：当查询群成员信息失败时，要说明原因（参数/权限/机器人状态/WS 连接），给替代方案（补参数/重试/检查权限）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你查询群成员信息，但需要提供 group_id，以及 user_id 或 user_ids（数字）。你把群号和成员 QQ 号发我一下（单个用 user_id，多个用 user_ids），我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 group_id（群号，数字）',
        '提供 user_id 或 user_ids（成员 QQ 号，数字）',
        '可选 refresh=true（是否强制刷新）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试查询群成员信息，但 QQ 侧接口没有及时响应（像是超时了）。你确认机器人与 WS 服务在线后，我可以再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS 服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试查询群成员信息，但这次失败了。可能是 WS 服务未连接、机器人离线或权限不足。我可以帮你排查后再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 group_id/user_id 正确',
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
  const path = 'group.memberInfo';
  const rawArgs = (args && typeof args === 'object') ? args : {};
  const baseRequestId = String(rawArgs.requestId || `${path}-${Date.now()}`);
  const group_id = Number(rawArgs.group_id);
  if (!Number.isFinite(group_id)) return fail('group_id 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_group_memberInfo' }) });

  const userIds = Array.isArray(rawArgs.user_ids) ? rawArgs.user_ids : [];
  const parsedUserIds = userIds.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  const userIdSingle = Number(rawArgs.user_id);
  const inputs = parsedUserIds.length ? parsedUserIds : (Number.isFinite(userIdSingle) ? [userIdSingle] : []);

  if (!inputs.length) {
    return fail('user_id/user_ids 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_group_memberInfo', group_id }) });
  }

  const refresh = typeof rawArgs.refresh === 'boolean' ? rawArgs.refresh : false;

  const single = async (user_id, index) => {
    const requestId = `${baseRequestId}-${index}`;
    try {
      const resp = await wsCall({ url, path, args: [group_id, user_id, refresh], requestId, timeoutMs });
      return ok({ request: { type: 'sdk', path, args: [group_id, user_id, refresh], requestId }, response: resp });
    } catch (e) {
      const isTimeout = isTimeoutError(e);
      return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_group_memberInfo', group_id, user_id, refresh }) });
    }
  };

  if (inputs.length === 1) {
    return await single(inputs[0], 0);
  }

  const results = [];
  for (let i = 0; i < inputs.length; i++) {
    const user_id = inputs[i];
    const out = await single(user_id, i);
    results.push({ group_id, user_id, ...out });
  }
  return ok({ mode: 'batch', results });
}
