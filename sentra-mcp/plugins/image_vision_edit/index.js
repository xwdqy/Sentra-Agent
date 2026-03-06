import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import OpenAI from 'openai';
import mime from 'mime-types';
import { httpRequest } from '../../src/utils/http.js';
import { toAbsoluteLocalPath } from '../../src/utils/path.js';
import { ok, fail } from '../../src/utils/result.js';
import {
  resolveModelFailoverPolicy,
  resolvePluginModelCandidates,
  runWithModelFailover,
} from '../../src/utils/plugin_llm_failover.js';

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
  const personaHint = '请结合你当前的预设/人设继续作答：当图片编辑失败时，要说明原因（提示词语言/图片读取/接口/输出格式），给替代方案（改提示词/换图/重试），并引导用户补充更明确的编辑需求。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我需要你提供待编辑的图片列表（images）和编辑指令（prompt）。当前参数不完整，所以我没法开始编辑。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 images：URL 或本地绝对路径数组',
        '提供 prompt：清晰描述要改什么（如“remove background / add sunglasses / change to watercolor”）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'PROMPT_NOT_ENGLISH') {
    return {
      suggested_reply: '这个图片编辑工具目前要求 prompt 必须是英文（为了让模型更稳定地执行编辑指令）。你把中文需求发我也行，我可以先帮你翻译成合适的英文指令，然后再继续编辑。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '告诉我你的中文需求，我会转换成更准确的英文 prompt',
        '尽量用短句 + 动词开头：remove/replace/add/change/enhance',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'INVALID_PATH') {
    return {
      suggested_reply: '我没法读取你提供的本地图片路径：本插件要求本地图片必须是“绝对路径”。你把完整路径发我一下，我就能继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '使用绝对路径，例如：E:/images/demo.png',
        '确认文件存在且有读取权限',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'NO_MD_IMAGE') {
    return {
      suggested_reply: '我已经尝试执行图片编辑，但模型没有按要求返回可用的 Markdown 图片结果，所以这次没法交付。我们可以把英文编辑指令写得更明确一点，然后重试。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '把 prompt 写得更具体：目标对象 + 动作 + 风格 + 约束（e.g. "keep background unchanged"）',
        '必要时分两步编辑：先做主要变更，再做风格化',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我在读取/编辑图片时卡住了，像是网络或接口超时了。我们可以稍后重试，或者先用更少的图片/更短的指令跑一版。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试或减少图片数量',
        '把 prompt 简化为一句明确的英文指令',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试编辑图片，但这次工具执行失败了。我可以先根据你的描述给你一版更稳的英文编辑指令，并建议你如何拆解成可执行的步骤后再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '告诉我你最想改的 1-2 个点（先做最关键的）',
      '如果你有参考图/目标风格，也可以提供',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

function isHttpUrl(s) {
  try { const u = new URL(String(s)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

async function readImageAsBase64WithMime(src) {
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
    const p = toAbsoluteLocalPath(src);
    if (!p) {
      throw new Error('local image path must be absolute');
    }
    buf = await fs.readFile(p);
    type = String(mime.lookup(p) || '');
  }
  if (!type || !type.startsWith('image/')) type = 'image/png';
  const dataUri = `data:${type};base64,${buf.toString('base64')}`;
  return { uri: dataUri, mime: type, size: buf.length };
}

function isEnglishPrompt(s) {
  const text = String(s || '');
  // reject if contains obvious CJK characters
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) return false;
  // require majority ASCII letters/punctuations
  const ascii = (text.match(/[\x00-\x7F]/g) || []).length;
  return ascii >= Math.ceil(text.length * 0.8);
}

function hasMarkdownImage(s) {
  return /!\[[^\]]*\]\([^)]+\)/i.test(String(s || ''));
}

function isDataImageBase64(url) {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(String(url || '').trim());
}

function sanitizeDetailText(text, maxLen = 4000) {
  let s = String(text || '');
  s = s.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, 'data:image/...;base64,(omitted)');
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}...(truncated)`;
  return s;
}

async function downloadImagesAndRewrite(md) {
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const urls = new Set();
  const dataUrls = new Set();
  let m;
  while ((m = re.exec(md)) !== null) {
    const url = String(m[2] || '').trim();
    if (!url) continue;
    if (isDataImageBase64(url)) {
      dataUrls.add(url);
      continue;
    }
    if (isHttpUrl(url)) urls.add(url);
  }
  if (urls.size === 0 && dataUrls.size === 0) return md;
  const baseDir = 'artifacts';
  await fs.mkdir(baseDir, { recursive: true });

  const map = new Map();
  const dataMap = new Map();
  let idx = 0;
  for (const url of urls) {
    try {
      const res = await httpRequest({
        method: 'GET',
        url,
        timeoutMs: 60000,
        responseType: 'arraybuffer',
        validateStatus: () => true,
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(res.data);
      let ct = (res.headers?.['content-type'] || '').split(';')[0].trim();
      if (!ct) {
        try { const u = new URL(url); ct = String(mime.lookup(u.pathname) || ''); } catch {}
      }
      let ext = '';
      if (ct && ct.startsWith('image/')) {
        const e = mime.extension(ct);
        if (e) ext = `.${e}`;
      }
      if (!ext) {
        try { const u = new URL(url); ext = path.extname(u.pathname) || '.png'; } catch { ext = '.png'; }
      }
      const name = `edit_${Date.now()}_${idx++}${ext}`;
      const abs = path.resolve(baseDir, name);
      await fs.writeFile(abs, buf);
      // 最终反馈要求绝对路径（Markdown中使用正斜杠以避免转义问题）
      const absMd = String(abs).replace(/\\/g, '/');
      map.set(url, absMd);
    } catch {
      // ignore this url; keep original link
    }
  }

  for (const dataUrl of dataUrls) {
    try {
      const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/i);
      if (!match) continue;
      const mimeType = (match[1] || '').trim() || 'image/png';
      const b64 = String(match[2] || '').trim().replace(/\s+/g, '');
      if (!b64) continue;
      const buf = Buffer.from(b64, 'base64');
      let ext = '';
      if (mimeType && mimeType.toLowerCase().startsWith('image/')) {
        const e = mime.extension(mimeType);
        if (e) ext = `.${e}`;
      }
      if (!ext) ext = '.png';
      const name = `edit_${Date.now()}_${idx++}${ext}`;
      const abs = path.resolve(baseDir, name);
      await fs.writeFile(abs, buf);
      const absMd = String(abs).replace(/\\/g, '/');
      dataMap.set(dataUrl, absMd);
    } catch {
      // ignore decode errors; keep original data URL
    }
  }

  return md.replace(re, (full, alt, url) => {
    const key = String(url || '').trim();
    if (map.has(key)) return `![${alt}](${map.get(key)})`;
    if (dataMap.has(key)) return `![${alt}](${dataMap.get(key)})`;
    return full;
  });
}

export default async function handler(args = {}, options = {}) {
  const images = Array.isArray(args.images) ? args.images : [];
  const prompt = String(args.prompt || '').trim();
  if (!images.length) return fail('images is required (array of urls or absolute paths)', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'image_vision_edit' }) });
  if (!prompt) return fail('prompt is required', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'image_vision_edit', images_count: images.length }) });
  if (!isEnglishPrompt(prompt)) return fail('prompt must be English only', 'PROMPT_NOT_ENGLISH', { advice: buildAdvice('PROMPT_NOT_ENGLISH', { tool: 'image_vision_edit' }) });

  const penv = options?.pluginEnv || {};
  const apiKey = penv.VISION_API_KEY || process.env.VISION_API_KEY || config.llm.apiKey;
  const baseURL = penv.VISION_BASE_URL || process.env.VISION_BASE_URL || config.llm.baseURL;
  const modelArg = String(args.model || '').trim();
  const modelCandidates = resolvePluginModelCandidates({
    pluginEnv: penv,
    primaryKey: 'VISION_MODEL',
    explicitModel: modelArg,
    defaultModel: config.llm.model,
  });
  const model = String(modelCandidates[0] || '').trim();
  const failoverPolicy = resolveModelFailoverPolicy(penv);

  const oai = new OpenAI({ apiKey, baseURL });

  // prepare messages
  const items = [];
  if (prompt) items.push({ type: 'text', text: prompt });
  let prepared;
  try {
    prepared = await Promise.all(images.map((src) => readImageAsBase64WithMime(src)));
  } catch (e) {
    logger.warn?.('image_vision_edit:load_image_failed', { label: 'PLUGIN', error: String(e?.message || e) });
    const msg = String(e?.message || e);
    const lower = msg.toLowerCase();
    const isTimeout = isTimeoutError(e);
    const invalidPath = lower.includes('must be absolute');
    const code = isTimeout ? 'TIMEOUT' : (invalidPath ? 'INVALID_PATH' : 'IMAGE_READ_ERR');
    const adviceKind = isTimeout ? 'TIMEOUT' : (invalidPath ? 'INVALID_PATH' : 'ERR');
    return fail(e, code, { advice: buildAdvice(adviceKind, { tool: 'image_vision_edit', images_count: images.length }) });
  }
  for (const it of prepared) items.push({ type: 'image_url', image_url: { url: it.uri } });

  const messages = [
    { role: 'user', content: items }
  ];

  try {
    const { value: res, model: usedModel } = await runWithModelFailover({
      models: modelCandidates,
      policy: failoverPolicy,
      tag: 'image_vision_edit',
      meta: { baseURL },
      execute: async (pickedModel) => oai.chat.completions.create({ model: pickedModel, messages }),
    });
    const content = res?.choices?.[0]?.message?.content || '';
    const okFlag = hasMarkdownImage(content);
    if (okFlag) {
      const rewritten = await downloadImagesAndRewrite(content);
      return ok({ prompt, content: rewritten, model: usedModel });
    }
    return fail('response has no markdown image', 'NO_MD_IMAGE', {
      advice: buildAdvice('NO_MD_IMAGE', { tool: 'image_vision_edit', prompt }),
      detail: { prompt, content: sanitizeDetailText(content) },
    });
  } catch (e) {
    logger.warn?.('image_vision_edit:request_failed', { label: 'PLUGIN', error: String(e?.message || e) });
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'image_vision_edit', prompt }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
