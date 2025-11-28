import wsCall from '../../src/utils/ws_rpc.js';

function decodeHtmlEntities(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // 处理 &#123; / &#x1F600; 这类数字实体
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : _;
  });
  out = out.replace(/&#(\d+);/g, (_, dec) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) ? String.fromCharCode(code) : _;
  });
  return out;
}

function splitTextSegments(text) {
  if (!text || typeof text !== 'string') return [];
  const unescaped = decodeHtmlEntities(text.trim());
  // 按空行拆段，保证列表等结构仍在同一段内
  const rawSegments = unescaped.split(/\n{2,}/);
  const out = [];
  for (const seg of rawSegments) {
    const s = seg.replace(/^\s+|\s+$/g, '');
    if (!s) continue;
    out.push(s);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

/**
 * QQ平台：主动发送私聊消息（文本 + 多媒体）
 *
 * 支持两种发送模式：
 * - combined：将所有文本和多媒体资源尽量合并为一条消息发送；
 * - separate：为每段文本和每个资源分别发送一条消息（中间可配置延迟）。
 */
export default async function handler(args = {}, options = {}) {
  const penv = options?.pluginEnv || {};
  const url = String(penv.WS_SDK_URL || 'ws://localhost:6702');
  const timeoutMs = Math.max(1000, Number(penv.WS_SDK_TIMEOUT_MS || 15000));
  const delayMs = Math.max(0, Number(penv.WS_SDK_DELAY_MS || 0));
  const sdkPath = 'send.private';

  const userIdRaw = args.user_id ?? args.qq ?? args.userId;
  const user_id = Number(userIdRaw);
  if (!Number.isFinite(user_id) || user_id <= 0) {
    return { success: false, code: 'INVALID_USER_ID', error: `user_id 无效: ${userIdRaw}` };
  }

  // 归一化文本：支持字符串或字符串数组，自动做 HTML 实体反转义并按空行拆段
  const texts = [];
  const textRaw = args.text;
  if (typeof textRaw === 'string') {
    const segs = splitTextSegments(textRaw);
    texts.push(...segs);
  } else if (Array.isArray(textRaw)) {
    for (const t of textRaw) {
      const segs = splitTextSegments(String(t ?? ''));
      texts.push(...segs);
    }
  }

  // 归一化资源
  const resources = [];
  const resourcesRaw = Array.isArray(args.resources) ? args.resources : [];
  for (const r of resourcesRaw) {
    if (!r) continue;
    const type = String(r.type || '').toLowerCase();
    const path = r.path != null ? String(r.path) : '';
    if (!path) continue;
    if (!['image', 'video', 'record', 'file'].includes(type)) continue;
    const caption = r.caption != null ? decodeHtmlEntities(String(r.caption)) : undefined;
    resources.push({ type, path, caption });
  }

  if (!texts.length && !resources.length) {
    return { success: false, code: 'EMPTY_CONTENT', error: 'text 和 resources 不能同时为空' };
  }

  const sendModeRaw = typeof args.send_mode === 'string' ? String(args.send_mode).toLowerCase() : 'separate';
  const sendMode = sendModeRaw === 'combined' ? 'combined' : 'separate';

  const baseRequestId = String(args.requestId || `${sdkPath}-${Date.now()}`);

  const buildPartsForResource = (res) => {
    const parts = [];
    if (res.caption) {
      parts.push({ type: 'text', data: { text: res.caption } });
    }
    let napcatType = 'file';
    if (res.type === 'image') napcatType = 'image';
    else if (res.type === 'video') napcatType = 'video';
    else if (res.type === 'record') napcatType = 'record';
    parts.push({ type: napcatType, data: { file: res.path } });
    return parts;
  };

  // 组装待发送的消息列表（每一项对应一次 send.private 调用）
  const messagesToSend = [];

  if (sendMode === 'combined') {
    const parts = [];
    for (const t of texts) {
      parts.push({ type: 'text', data: { text: t } });
    }
    for (const res of resources) {
      const resParts = buildPartsForResource(res);
      parts.push(...resParts);
    }

    let msgArg;
    // 仅有一段纯文本时，可以直接用字符串形式
    if (parts.length === 1 && parts[0].type === 'text') {
      msgArg = parts[0].data.text;
    } else {
      msgArg = parts;
    }
    messagesToSend.push({ msgArg });
  } else {
    // separate 模式：每段文本、每个资源分别发送
    for (const t of texts) {
      messagesToSend.push({ msgArg: t });
    }
    for (const res of resources) {
      const resParts = buildPartsForResource(res);
      messagesToSend.push({ msgArg: resParts });
    }
  }

  const sdkCalls = [];
  let successCount = 0;
  let failedCount = 0;
  const errors = [];

  for (let i = 0; i < messagesToSend.length; i++) {
    const { msgArg } = messagesToSend[i];
    const requestId = `${baseRequestId}-${i + 1}`;
    const callArgs = [user_id, msgArg];
    const sdkRequest = { type: 'sdk', path: sdkPath, args: callArgs, requestId };

    try {
      const resp = await wsCall({ url, path: sdkPath, args: callArgs, requestId, timeoutMs });
      successCount += 1;
      sdkCalls.push({ index: i, success: true, request: sdkRequest, response: resp });
    } catch (err) {
      failedCount += 1;
      const errStr = String(err);
      errors.push(errStr);
      sdkCalls.push({ index: i, success: false, request: sdkRequest, error: errStr });
    }

    if (delayMs > 0 && i < messagesToSend.length - 1) {
      await sleep(delayMs);
    }
  }

  const total = messagesToSend.length;

  if (successCount === total) {
    const msg = total === 1
      ? '已向指定好友发送 1 条私聊消息'
      : `已向指定好友发送 ${total} 条私聊消息`;
    return {
      success: true,
      message: msg,
      data: {
        summary: msg,
        user_id: String(user_id),
        total,
        success_count: successCount,
        failed_count: failedCount,
        sdk_calls: sdkCalls
      }
    };
  }

  if (successCount > 0) {
    const msg = `部分成功：${successCount}/${total} 条私聊消息发送成功`;
    return {
      success: true,
      code: 'PARTIAL_SUCCESS',
      message: msg,
      error: errors.join('；') || undefined,
      data: {
        summary: msg,
        user_id: String(user_id),
        total,
        success_count: successCount,
        failed_count: failedCount,
        sdk_calls: sdkCalls
      }
    };
  }

  const msg = `发送失败：${total} 条私聊消息全部发送失败`;
  return {
    success: false,
    code: 'ALL_FAILED',
    message: msg,
    error: errors.join('；') || msg,
    data: {
      summary: msg,
      user_id: String(user_id),
      total,
      success_count: successCount,
      failed_count: failedCount,
      sdk_calls: sdkCalls
    }
  };
}

