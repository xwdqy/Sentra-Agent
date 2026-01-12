import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import OpenAI from 'openai';
import mime from 'mime-types';
import { httpRequest } from '../../src/utils/http.js';
import { toAbsoluteLocalPath } from '../../src/utils/path.js';
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
  const personaHint = '请结合你当前的预设/人设继续作答：当图片理解失败时，要说明原因（路径/网络/格式/接口），给替代方案（换图/换链接/重试/补充问题），并引导用户补充可用输入。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我需要你提供图片列表（images）以及你希望我分析的具体问题（prompt）。当前参数不完整，所以我没法开始分析。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 images：URL 或本地绝对路径数组，例如：["E:/a.png"]',
        '提供 prompt：你希望我关注什么（内容/文字/OCR/风格/瑕疵/对比等）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'INVALID_PATH') {
    return {
      suggested_reply: '我没法读取你提供的本地图片路径：本插件要求本地图片必须是“绝对路径”。你把完整路径发我一下，我就能继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '使用绝对路径，例如：E:/images/demo.png 或 C:/Users/.../a.jpg',
        '确认文件存在且有读取权限',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我在读取/分析图片时卡住了，像是网络或接口超时了。我可以先给你一个不依赖工具的分析思路，或者我们稍后重试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试，或减少图片数量',
        '如果是 URL 图片，建议换更稳定的直链或先下载成本地文件再分析',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试分析你提供的图片，但这次工具执行失败了。我可以先根据你的问题给你一套排查/分析思路；如果你愿意，我们也可以换更清晰/更少的图片再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '提供更清晰的图片或减少图片数量',
      '告诉我你最关心的区域/文字位置（如“右上角的文字”）',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

function isHttpUrl(s) {
  try { const u = new URL(String(s)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

async function readImageAsBase64WithMime(src, convertGif = false) {
  let buf; let type = '';
  if (isHttpUrl(src)) {
    const res = await httpRequest({
      method: 'GET',
      url: src,
      timeoutMs: 30000,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`fetch image failed: ${res.status}`);
    buf = Buffer.from(res.data);
    const ct = (res.headers?.['content-type'] || '').split(';')[0].trim();
    if (ct && ct.startsWith('image/')) type = ct;
    if (!type) {
      try { const u = new URL(String(src)); type = mime.lookup(u.pathname) || ''; } catch {}
    }
  } else {
    // treat as local absolute path
    const p = toAbsoluteLocalPath(src);
    if (!p) {
      throw new Error('local image path must be absolute');
    }
    buf = await fs.readFile(p);
    type = String(mime.lookup(p) || '');
  }
  if (!type || !type.startsWith('image/')) {
    // fallback to a common image type, but we do NOT expose base64 outwards
    type = 'image/png';
  }
  
  // GIF优化：某些视觉模型不支持 image/gif，可配置是否转换为 image/jpeg
  // 注意：这里只是改变 MIME 类型标识，实际内容仍是原始格式
  // 大多数视觉模型会根据实际内容自动识别，而不是严格依赖 MIME 类型
  if (convertGif && (type === 'image/gif' || src.toLowerCase().endsWith('.gif'))) {
    type = 'image/jpeg';
  }
  
  const dataUri = `data:${type};base64,${buf.toString('base64')}`;
  return { uri: dataUri, mime: type, size: buf.length };
}

export default async function handler(args = {}, options = {}) {
  const images0 = Array.isArray(args.images) ? args.images : [];
  const imageSingle = (args.image !== undefined && args.image !== null) ? String(args.image) : '';
  const images = [
    ...(imageSingle ? [imageSingle] : []),
    ...images0
  ];
  const prompt = String(args.prompt || '').trim();
  if (!images.length) return fail('image/images is required (a url/absolute path string or an array of urls/absolute paths)', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'image_vision_read' }) });
  if (!prompt) return fail('prompt is required', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'image_vision_read', images_count: images.length }) });

  // plugin-level env
  const penv = options?.pluginEnv || {};
  const apiKey = penv.VISION_API_KEY || process.env.VISION_API_KEY || config.llm.apiKey;
  const baseURL = penv.VISION_BASE_URL || process.env.VISION_BASE_URL || config.llm.baseURL;
  const model = penv.VISION_MODEL || process.env.VISION_MODEL || config.llm.model;
  const convertGif = String(penv.VISION_CONVERT_GIF || process.env.VISION_CONVERT_GIF || 'false').toLowerCase() === 'true';

  const oai = new OpenAI({ apiKey, baseURL });

  logger.info?.('image_vision_read:config', { label: 'PLUGIN', baseURL, model, imageCount: images.length, convertGif });

  // prepare vision messages: a single user message with mixed text+images
  const items = [];
  if (prompt) items.push({ type: 'text', text: prompt });
  // read all images and build data URIs with detected MIME in parallel
  let prepared;
  try {
    prepared = await Promise.all(images.map((src) => readImageAsBase64WithMime(src, convertGif)));
  } catch (e) {
    logger.warn?.('image_vision_read:load_image_failed', { label: 'PLUGIN', error: String(e?.message || e) });
    const msg = String(e?.message || e);
    const lower = msg.toLowerCase();
    const isTimeout = isTimeoutError(e);
    const invalidPath = lower.includes('must be absolute');
    const code = isTimeout ? 'TIMEOUT' : (invalidPath ? 'INVALID_PATH' : 'IMAGE_READ_ERR');
    const adviceKind = isTimeout ? 'TIMEOUT' : (invalidPath ? 'INVALID_PATH' : 'ERR');
    return fail(e, code, { advice: buildAdvice(adviceKind, { tool: 'image_vision_read', images_count: images.length }) });
  }
  for (const it of prepared) items.push({ type: 'image_url', image_url: { url: it.uri } });

  const messages = [
    { role: 'user', content: items }
  ];

  try {
    logger.info?.('image_vision_read:calling_api', { label: 'PLUGIN', model });
    const res = await oai.chat.completions.create({ model, messages });
    const content = res?.choices?.[0]?.message?.content || '';
    logger.info?.('image_vision_read:api_success', { label: 'PLUGIN', responseLength: content?.length || 0 });
    // 仅返回所需字段：prompt、图片描述与摘要统计
    const formats = Array.from(new Set((prepared || []).map((x) => x.mime))).filter(Boolean);
    return ok({ prompt, description: content, image_count: images.length, formats });
  } catch (e) {
    logger.warn?.('image_vision_read:request_failed', { label: 'PLUGIN', error: String(e?.message || e), stack: e?.stack });
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'image_vision_read', images_count: images.length }) });
  }
}
