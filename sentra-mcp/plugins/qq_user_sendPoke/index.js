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
  const personaHint = '请结合你当前的预设/人设继续作答：当戳一戳失败时，要说明原因（user_id/群参数/WS 连接/频率限制），给替代方案（补参数/改为发送消息/稍后重试）。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你给某个 QQ 账号“戳一戳”，但当前没有提供 user_id（QQ号）。你把 QQ 号发我一下，我就可以按你指定的次数去戳。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 user_id（QQ号）',
        '可选提供 times（戳的次数，默认 1，最多 5）',
        '如在群内戳人，可提供 group_id/target_id（视平台支持）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试帮你戳一戳，但与 QQ 侧接口的连接长时间没有响应（像是超时了）。你可以先确认机器人与 WS 服务在线，稍后我再帮你试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS_SDK_URL 对应服务在线（默认 ws://localhost:6702）',
        '稍后重试，或适当减少 times 以避免频率限制',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'ALL_FAILED') {
    return {
      suggested_reply: '我多次尝试帮你戳一戳，但这次所有尝试都失败了。可能是 WS 服务未连接、机器人权限不足，或者当前账号触发了频率限制。我可以帮你改为发送一条带表情的消息，或者稍后再试。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 user_id/group_id/target_id 是否正确',
        '确认机器人在线且有权对目标进行戳一戳操作',
        '如果怀疑是频率限制，可降低 times 或稍后再试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试帮你戳一戳，但这次执行失败了。你可以确认参数和机器人状态，我也可以帮你改为发送一条提示消息来表达相同的意思。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 user_id/群参数正确',
      '确认机器人与 WS 服务在线',
      '必要时改为发送一条文本或表情消息替代戳一戳',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

// 延迟函数（避免戳太快）
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default async function handler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const url = String(penv.WS_SDK_URL || 'ws://localhost:6702');
  const timeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || 15000));
  const path = 'user.sendPoke';
  
  // 从环境变量读取戳一戳行为配置
  const intervalMs = Math.max(100, Number(penv.POKE_INTERVAL_MS || 300));
  const randomInterval = String(penv.POKE_RANDOM_INTERVAL || 'false').toLowerCase() === 'true';
  const randomRangeMs = Math.max(0, Number(penv.POKE_RANDOM_RANGE_MS || 200));
  const retryOnFailure = String(penv.POKE_RETRY_ON_FAILURE || 'false').toLowerCase() === 'true';
  const maxRetries = Math.max(0, Number(penv.POKE_MAX_RETRIES || 1));
  
  const user_id = args.user_id;
  if (!user_id) return fail('user_id 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_user_sendPoke' }) });
  
  // 戳一戳次数（1-5次）
  let times = Number(args.times);
  if (!Number.isFinite(times) || times < 1) times = 1;
  if (times > 5) times = 5;
  
  const callArgs = [Number(user_id)];
  
  // group_id 和 target_id 是可选参数
  if (args.group_id !== undefined) {
    callArgs.push(Number(args.group_id));
    // 如果有 target_id，必须先有 group_id
    if (args.target_id !== undefined) {
      callArgs.push(Number(args.target_id));
    }
  } else if (args.target_id !== undefined) {
    // 没有 group_id 但有 target_id，传 undefined 占位
    callArgs.push(undefined);
    callArgs.push(Number(args.target_id));
  }
  
  const results = [];
  let successCount = 0;
  let totalAttempts = 0;
  
  // 循环戳一戳
  for (let i = 0; i < times; i++) {
    let roundSuccess = false;
    let lastError = null;
    
    // 重试逻辑（如果启用）
    const maxAttempts = retryOnFailure ? (maxRetries + 1) : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        totalAttempts++;
        const requestId = String(args.requestId || `${path}-${Date.now()}-${i + 1}-${attempt}`);
        const resp = await wsCall({ url, path, args: callArgs, requestId, timeoutMs });
        results.push({ 
          round: i + 1, 
          attempt: attempt + 1,
          success: true, 
          response: resp 
        });
        successCount++;
        roundSuccess = true;
        break; // 成功则跳出重试循环
      } catch (e) {
        lastError = String(e?.message || e);
        if (attempt < maxAttempts - 1 && retryOnFailure) {
          // 重试前等待一小段时间
          await sleep(100);
        }
      }
    }
    
    // 如果所有重试都失败，记录失败
    if (!roundSuccess && lastError) {
      results.push({ 
        round: i + 1, 
        success: false, 
        error: lastError,
        attempts: maxAttempts
      });
    }
    
    // 如果还有下一次，等待间隔时间
    if (i < times - 1) {
      const delay = randomInterval 
        ? intervalMs + Math.floor(Math.random() * randomRangeMs)
        : intervalMs;
      await sleep(delay);
    }
  }

  const data = {
    总次数: times,
    成功次数: successCount,
    失败次数: times - successCount,
    总尝试数: totalAttempts,
    配置: {
      间隔时间: randomInterval ? `${intervalMs}-${intervalMs + randomRangeMs}ms (随机)` : `${intervalMs}ms`,
      失败重试: retryOnFailure ? `启用 (最多${maxRetries}次)` : '关闭'
    },
    request: { type: 'sdk', path, args: callArgs },
    results
  };

  // 只要至少一次成功，就视为整体成功（保持原有语义）
  if (successCount > 0) {
    return ok(data, successCount === times ? 'OK' : 'PARTIAL_SUCCESS');
  }

  // 所有轮次都失败，整体视为失败
  const failed = results.filter(r => !r.success);
  const timeoutLike = failed.some(r => isTimeoutError(r?.error));
  const errDetail = failed.map(r => `第${r.round}轮: ${r.error}`).join('；') || '未知原因';
  return fail(`所有戳一戳请求都失败：${errDetail}`, timeoutLike ? 'TIMEOUT' : 'ALL_FAILED', {
    advice: buildAdvice(timeoutLike ? 'TIMEOUT' : 'ALL_FAILED', { tool: 'qq_user_sendPoke', user_id, times }),
    detail: data,
  });
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
