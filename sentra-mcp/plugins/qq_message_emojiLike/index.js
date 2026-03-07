import wsCall from '../../src/utils/ws_rpc.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, fail } from '../../src/utils/result.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const faceMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'face-map.json'), 'utf-8'));

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
  const personaHint = '请结合你当前的预设/人设继续作答：当贴表情失败时，要说明原因（message_id/emoji_id/WS 连接/权限），给替代方案（补真实ID/换表情/重试），并引导用户提供必要信息。';
  if (kind === 'INVALID_MESSAGE_ID') {
    return {
      suggested_reply: '我想帮你给那条消息贴表情，但 message_id 不是有效的“纯数字消息ID”。你需要从上下文里拿到真实的消息ID（通常是长数字），不要用占位符。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '从聊天/引用消息/工具上下文中取到真实 message_id（纯数字字符串）',
        '如果你能提供那条消息的引用/截图/上下文，我也可以帮你定位',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我可以帮你贴表情，但当前参数不完整（需要 message_id 和 emoji_id/emoji_ids）。你把要贴的消息ID和表情ID发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 message_id（纯数字字符串）',
        '提供 emoji_id 或 emoji_ids（表情ID，数字或数组）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'INVALID_EMOJI_ID') {
    return {
      suggested_reply: '我收到了要贴的表情ID，但其中有不合法的值（必须是数字且在可用范围内）。你可以换一个有效的表情ID再试。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '从 face-map.json 对应的有效表情ID列表中选择',
        '如果不确定，告诉我你想表达的情绪（感谢/点赞/尴尬/吃瓜等），我来选一个合适的ID',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我尝试贴表情，但和 QQ 侧接口的连接没有及时响应（像是超时了）。你确认一下机器人是否在线、WS 服务是否正常，然后我可以再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 WS_SDK_URL 对应服务在线（默认 ws://localhost:6702）',
        '稍后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'ALL_FAILED') {
    return {
      suggested_reply: '我尝试给这条消息贴表情，但这次全部失败了。常见原因是 WS 服务未连接、机器人离线、或当前账号/协议不支持该操作。我可以帮你排查后再试。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认机器人在线且有权限执行该动作',
        '确认 WS 服务可用并能正常调用 message.emojiLike',
        '如果一直失败，可以换成发送一条带表情的文字消息作为替代互动',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试贴表情，但这次执行失败了。我可以帮你换一个表情/重试，或者先确认机器人与 WS 服务状态再继续。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '确认 message_id/emoji_id 正确',
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
  const sdkPath = 'message.emojiLike';
  const requestId = String(args.requestId || `${sdkPath}-${Date.now()}`);
  
  // 容错：自动转换 message_id 为字符串（AI 有时会传数字）
  const message_id = args.message_id != null ? String(args.message_id) : undefined;
  // 向后兼容：支持 emoji_id（单数）和 emoji_ids（复数）
  const emoji_ids_raw = args.emoji_ids !== undefined ? args.emoji_ids : args.emoji_id;
  
  // 参数校验
  if (!message_id) {
    return fail('message_id 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_message_emojiLike' }) });
  }
  // message_id 必须是纯数字字符串（如 "7379279827384728374"）
  if (!/^[0-9]+$/.test(String(message_id))) {
    return fail(
      `message_id 必须是纯数字字符串（如 "7379279827384728374"），当前值: "${message_id}"`,
      'INVALID_MESSAGE_ID',
      { advice: buildAdvice('INVALID_MESSAGE_ID', { tool: 'qq_message_emojiLike', message_id }) }
    );
  }
  const messageIdNum = Number(message_id);
  if (!Number.isFinite(messageIdNum) || messageIdNum <= 0) {
    return fail(
      `message_id 无法转换为有效的正数: "${message_id}"`,
      'INVALID_MESSAGE_ID',
      { advice: buildAdvice('INVALID_MESSAGE_ID', { tool: 'qq_message_emojiLike', message_id }) }
    );
  }
  
  // 规范化 emoji_ids 为数组（支持单个数字或数组）
  const emoji_ids = Array.isArray(emoji_ids_raw) ? emoji_ids_raw : [emoji_ids_raw];
  
  if (!emoji_ids.length) {
    return fail('emoji_ids 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'qq_message_emojiLike', message_id }) });
  }
  
  // 验证所有表情ID
  for (const id of emoji_ids) {
    if (!Number.isFinite(Number(id))) {
      return fail(`emoji_id "${id}" 必须是有效的数字`, 'INVALID', {
        advice: buildAdvice('INVALID_EMOJI_ID', { tool: 'qq_message_emojiLike', message_id, emoji_id: id })
      });
    }
  }
  
  // 去重（避免重复贴同一个表情）
  const uniqueEmojiIds = [...new Set(emoji_ids.map(id => Number(id)))];
  
  // 循环调用 SDK 为每个表情贴上
  const results = [];
  const successList = [];
  const failedList = [];
  
  for (const emoji_id of uniqueEmojiIds) {
    const callArgs = [Number(message_id), Number(emoji_id)];
    const faceInfo = faceMap.faces[String(emoji_id)];
    const emojiName = faceInfo?.name || '未知表情';
    const emojiType = faceInfo?.type ? faceMap.types[String(faceInfo.type)] : '未知类型';
    
    const perRequestId = `${requestId}-${emoji_id}`;
    const sdkRequest = { type: 'sdk', path: sdkPath, args: callArgs, requestId: perRequestId };
    try {
      const resp = await wsCall({ url, path: sdkPath, args: callArgs, requestId: perRequestId, timeoutMs });
      successList.push({ emoji_id, emoji_name: emojiName, emoji_type: emojiType });
      results.push({ emoji_id, emoji_name: emojiName, success: true, sdk: { request: sdkRequest, response: resp } });
    } catch (err) {
      const errStr = String(err);
      failedList.push({ emoji_id, emoji_name: emojiName, error: errStr });
      results.push({ emoji_id, emoji_name: emojiName, success: false, error: errStr, sdk: { request: sdkRequest, error: errStr } });
    }
  }
  
  // 构建返回结果
  const totalCount = uniqueEmojiIds.length;
  const successCount = successList.length;
  const failedCount = failedList.length;
  
  if (successCount === totalCount) {
    // 全部成功
    const emojiNames = successList.map(e => `[${e.emoji_name}]`).join(' + ');
    return ok({
      summary: `实际行为：已成功给消息 ${message_id} 贴上 ${successCount} 个表情：${successList.map(e => `[${e.emoji_name}]（ID: ${e.emoji_id}，类型: ${e.emoji_type}）`).join('、')}`,
      message_id: String(message_id),
      total: totalCount,
      success_count: successCount,
      emojis: successList,
      sdk_calls: results
    }, 'OK', { detail: { message: `已给消息贴上 ${successCount} 个表情：${emojiNames}` } });
  } else if (successCount > 0) {
    // 部分成功
    const successNames = successList.map(e => `[${e.emoji_name}]`).join(' + ');
    const failedNames = failedList.map(e => `[${e.emoji_name}]`).join(' + ');
    return ok({
      summary: `实际行为：给消息 ${message_id} 贴表情部分成功。成功 ${successCount} 个：${successList.map(e => `[${e.emoji_name}]（ID: ${e.emoji_id}）`).join('、')}；失败 ${failedCount} 个：${failedList.map(e => `[${e.emoji_name}]（原因: ${e.error}）`).join('、')}`,
      message_id: String(message_id),
      total: totalCount,
      success_count: successCount,
      failed_count: failedCount,
      emojis_success: successList,
      emojis_failed: failedList,
      sdk_calls: results
    }, 'PARTIAL_SUCCESS', { detail: { message: `部分成功：已贴上 ${successCount} 个表情（${successNames}），${failedCount} 个失败（${failedNames}）` } });
  } else {
    // 全部失败
    const failedNames = failedList.map(e => `[${e.emoji_name}]`).join(' + ');
    const timeoutLike = failedList.some((x) => isTimeoutError(x?.error));
    return fail(
      `所有表情贴加失败：${failedList.map(e => `[${e.emoji_name}]: ${e.error}`).join('；')}`,
      timeoutLike ? 'TIMEOUT' : 'ALL_FAILED',
      {
        advice: buildAdvice(timeoutLike ? 'TIMEOUT' : 'ALL_FAILED', { tool: 'qq_message_emojiLike', message_id, failed_count: failedCount }),
        detail: {
          message: `全部失败：无法给消息贴上表情（${failedNames}）`,
          summary: `实际行为：给消息 ${message_id} 贴表情失败。失败 ${failedCount} 个：${failedList.map(e => `[${e.emoji_name}]（原因: ${e.error}）`).join('、')}`,
          message_id: String(message_id),
          total: totalCount,
          failed_count: failedCount,
          emojis_failed: failedList,
          sdk_calls: results
        }
      }
    );
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
