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
  const personaHint = '请结合你当前的预设/人设继续作答：当获取群成员列表失败时，要说明原因（参数/权限/WS 连接），给替代方案（补参数/检查权限/稍后重试）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你获取群成员列表，但需要提供 group_id（群号）。你把群号发我一下，我就可以继续查询。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 group_id（群号，数字）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试获取群成员列表，但 QQ 侧接口长时间没有响应（像是超时了）。你可以确认机器人与 WS 服务在线，稍后我再帮你查一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS 服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试获取群成员列表，但这次失败了。可能是 WS 服务未连接、机器人不在该群或权限不足。我可以帮你确认群号和权限后再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 group_id 是否正确且机器人在该群内',
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
  const path = 'group.memberList';
  const rawArgs = (args && typeof args === 'object') ? args : {};
  const baseRequestId = String(rawArgs.requestId || `${path}-${Date.now()}`);

  const groupIds = Array.isArray(rawArgs.group_ids) ? rawArgs.group_ids : [];
  const parsedGroupIds = groupIds.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  const groupIdSingle = Number(rawArgs.group_id);
  const inputs = parsedGroupIds.length ? parsedGroupIds : (Number.isFinite(groupIdSingle) ? [groupIdSingle] : []);

  if (!inputs.length) {
    return fail('group_id/group_ids 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_group_memberList' }) });
  }

  const single = async (group_id, index) => {
    const requestId = `${baseRequestId}-${index}`;
    try {
      const resp = await wsCall({ url, path, args: [group_id], requestId, timeoutMs });
      return ok({ request: { type: 'sdk', path, args: [group_id], requestId }, response: resp });
    } catch (e) {
      const isTimeout = isTimeoutError(e);
      return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'qq_group_memberList', group_id }) });
    }
  };

  if (inputs.length === 1) {
    return await single(inputs[0], 0);
  }

  const results = [];
  for (let i = 0; i < inputs.length; i++) {
    const group_id = inputs[i];
    const out = await single(group_id, i);
    results.push({ group_id, ...out });
  }
  return ok({ mode: 'batch', results });
}
