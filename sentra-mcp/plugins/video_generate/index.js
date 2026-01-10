import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import OpenAI from 'openai';
import mime from 'mime-types';
import { httpRequest } from '../../src/utils/http.js';

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
  const personaHint = '请结合你当前的预设/人设继续作答：当视频生成失败时，要解释原因、给替代方案（改提示词/降低复杂度/重试/换思路），并引导用户补充更具体需求。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我现在还没拿到你想生成的视频内容描述（prompt 为空），所以没法开始生成。你把主题、风格、时长/镜头感等要求发我一下，我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '补充 prompt：主体 + 场景 + 风格 + 镜头语言（例如“手持跟拍、电影感、慢动作”）',
        '如果有时长/比例/分镜偏好也可以说明',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我刚才在生成/拉取视频时卡住了，像是接口或网络超时了。我可以先基于你的描述给你一版更容易生成的提示词，或者我们稍后重试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试，或把 prompt 简化成更明确的主体/动作/场景',
        '减少过长的描述，先生成一个“短、清晰”的版本再迭代',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'NO_VIDEO_LINK') {
    return {
      suggested_reply: '我已经尝试生成视频，但返回内容里没有可用的视频直链（可能返回了描述文本，或链接被包装在不可解析的格式里），所以这次生成失败了。我可以把提示词改得更强约束，然后再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '缩短提示词，明确要求“必须输出至少 1 个可下载视频直链（mp4/webm）”',
        '如果你愿意，也可以改成“先给分镜脚本，再生成视频”',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'NO_LOCAL_VIDEO') {
    return {
      suggested_reply: '我拿到了视频链接线索，但在把视频下载保存成可用的本地文件时失败了，所以没法稳定交付结果。我们可以重试下载，或者换一种生成方式。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试（可能是链接失效/站点限制/网络波动）',
        '换更稳定的链接来源或调整关键词',
        '如果你允许只返回外链（不落地文件），也可以告诉我',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试帮你生成视频，但这次工具执行失败了。我可以先根据你的需求给你一版更稳的提示词/分镜建议，并提供几种替代方案（重试/换风格/拆解需求）。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '补充：主体、动作、场景、镜头风格、氛围音乐/节奏感（如需要）',
      '我也可以先给你 3-5 条不同风格的提示词供选择',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

function isHttpUrl(s) {
  try { const u = new URL(String(s)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

function htmlUnescapeBasic(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function isLikelyVideoUrl(url) {
  if (!isHttpUrl(url)) return false;
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    if (/(\.mp4|\.webm|\.mov|\.mkv|\.m4v)(?:$|\?)/i.test(url)) return true;
    if (/(\.mp4|\.webm|\.mov|\.mkv|\.m4v)$/.test(p)) return true;
    return false;
  } catch {
    return false;
  }
}

function findHtmlMediaSrcLinks(html) {
  const s = String(html || '');
  const out = [];

  const push = (rawUrl) => {
    const u = htmlUnescapeBasic(String(rawUrl || '').trim());
    if (!u) return;
    out.push(u);
  };

  const reVideo = /<video\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi;
  let m;
  while ((m = reVideo.exec(s)) !== null) push(m[2]);

  const reSource = /<source\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi;
  while ((m = reSource.exec(s)) !== null) push(m[2]);

  return out;
}

function findBareVideoUrls(text) {
  const s = String(text || '');
  const re = /(https?:\/\/[^\s"'<>]+(?:\.mp4|\.webm|\.mov|\.mkv|\.m4v)(?:\?[^\s"'<>]+)?)/gi;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    out.push(String(m[1] || '').trim());
  }
  return out;
}

function collectVideoUrlCandidates(text) {
  const markdownLinks = findMarkdownLinks(text).map((l) => String(l?.url || '').trim()).filter((u) => isHttpUrl(u));
  const htmlLinks = findHtmlMediaSrcLinks(text).filter((u) => isHttpUrl(u));
  const bareLinks = findBareVideoUrls(text).filter((u) => isHttpUrl(u));
  const all = [...markdownLinks, ...htmlLinks, ...bareLinks];
  const seen = new Set();
  const candidates = [];
  for (const u of all) {
    const key = String(u || '').trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(key);
  }
  return candidates;
}

function findMarkdownLinks(md) {
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  const out = [];
  let m; while ((m = re.exec(String(md || ''))) !== null) {
    const text = String(m[1] || '').trim();
    const url = String(m[2] || '').trim();
    out.push({ text, url });
  }
  return out;
}

function hasVideoLink(md) {
  const candidates = collectVideoUrlCandidates(md);
  return candidates.length > 0;
}

async function collectVerifiedLocalMarkdownVideos(md) {
  const links = findMarkdownLinks(md);
  const locals = [];
  for (const l of links) {
    const target = String(l?.url || '').trim();
    if (!target) continue;
    if (isHttpUrl(target)) continue;
    if (!path.isAbsolute(target)) continue;
    try {
      await fs.access(target);
      locals.push({ text: l.text || 'video', path: target });
    } catch {
      continue;
    }
  }
  if (!locals.length) return '';
  return locals.map((v) => `[${v.text}](${String(v.path).replace(/\\/g, '/')})`).join('\n');
}

async function downloadVideosAndRewrite(md, prefix = 'video') {
  const candidates = collectVideoUrlCandidates(md);
  if (!candidates.length) return md;

  const baseDir = 'artifacts';
  await fs.mkdir(baseDir, { recursive: true });

  const map = new Map();
  let idx = 0;
  for (const url of candidates) {
    try {
      const res = await httpRequest({
        method: 'GET',
        url,
        timeoutMs: 60000,
        responseType: 'arraybuffer',
        validateStatus: () => true,
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
      let ct = (res.headers?.['content-type'] || '').split(';')[0].trim();
      if (!ct) {
        try { const u = new URL(url); ct = String(mime.lookup(u.pathname) || ''); } catch {}
      }
      // Skip non-video links
      const isVideo = (ct && ct.startsWith('video/'));
      if (!isVideo) continue;

      const buf = Buffer.from(res.data);
      let ext = '';
      if (ct && ct.startsWith('video/')) {
        const e = mime.extension(ct);
        if (e) ext = `.${e}`;
      }
      if (!ext) {
        try { const u = new URL(url); ext = path.extname(u.pathname) || '.mp4'; } catch { ext = '.mp4'; }
      }
      const name = `${prefix}_${Date.now()}_${idx++}${ext}`;
      const abs = path.resolve(baseDir, name);
      await fs.writeFile(abs, buf);
      const absMd = String(abs).replace(/\\/g, '/');
      map.set(url, absMd);
    } catch (e) {
      logger.warn?.('video_generate:download_failed', { label: 'PLUGIN', url, error: String(e?.message || e) });
    }
  }

  let out = String(md || '').replace(/\[([^\]]*)\]\(([^)]+)\)/g, (full, text, url) => {
    const key = String(url || '').trim();
    if (map.has(key)) return `[${text}](${map.get(key)})`;
    return full;
  });

  out = out.replace(/(<video\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)(\2)/gi, (full, prefix2, q, url, suffix2) => {
    const key = htmlUnescapeBasic(String(url || '').trim());
    if (!map.has(key)) return full;
    return `${prefix2}${q}${map.get(key)}${suffix2}`;
  });
  out = out.replace(/(<source\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)(\2)/gi, (full, prefix2, q, url, suffix2) => {
    const key = htmlUnescapeBasic(String(url || '').trim());
    if (!map.has(key)) return full;
    return `${prefix2}${q}${map.get(key)}${suffix2}`;
  });

  const appended = [];
  for (const [src, local] of map.entries()) {
    if (!isLikelyVideoUrl(src)) continue;
    appended.push(`[Download video](${local})`);
  }
  if (appended.length) {
    out = `${out}\n\n${appended.join('\n')}`;
  }

  return out;
}

export default async function handler(args = {}, options = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return { success: false, code: 'INVALID', error: 'prompt is required', advice: buildAdvice('INVALID', { tool: 'video_generate' }) };

  const penv = options?.pluginEnv || {};
  const apiKey = penv.VIDEO_API_KEY || process.env.VIDEO_API_KEY || config.llm.apiKey;
  const baseURL = penv.VIDEO_BASE_URL || process.env.VIDEO_BASE_URL || config.llm.baseURL;
  const model = String(penv.VIDEO_MODEL || process.env.VIDEO_MODEL || config.llm.model || '').trim();

  const oai = new OpenAI({ apiKey, baseURL });

  const system = 'You are a video generation assistant. Respond with a short description plus at least one Markdown link to a downloadable video file (e.g., [Download video](https://.../file.mp4)). The link must be a direct file URL (mp4/webm/mov/mkv). Do not include code fences.';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: prompt }
  ];

  try {
    const stream = await oai.chat.completions.create({ model, messages, stream: true });
    let content = '';
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || '';
      if (delta) {
        content += delta;
        if (typeof options?.onStream === 'function') {
          try { options.onStream({ type: 'delta', delta, content }); } catch {}
        }
      }
    }
    if (!hasVideoLink(content)) {
      return { success: false, code: 'NO_VIDEO_LINK', error: 'response has no usable video link', data: { prompt, content }, advice: buildAdvice('NO_VIDEO_LINK', { tool: 'video_generate', prompt }) };
    }
    const rewritten = await downloadVideosAndRewrite(content, 'video');
    const localMarkdown = await collectVerifiedLocalMarkdownVideos(rewritten);
    if (!localMarkdown) {
      return { success: false, code: 'NO_LOCAL_VIDEO', error: 'unable to download video to local markdown', data: { prompt, content: rewritten }, advice: buildAdvice('NO_LOCAL_VIDEO', { tool: 'video_generate', prompt }) };
    }
    return { success: true, data: { prompt, content: localMarkdown } };
  } catch (e) {
    logger.warn?.('video_generate:request_failed', { label: 'PLUGIN', error: String(e?.message || e) });
    const isTimeout = isTimeoutError(e);
    return { success: false, code: isTimeout ? 'TIMEOUT' : 'ERR', error: String(e?.message || e), advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'video_generate', prompt }) };
  }
}
