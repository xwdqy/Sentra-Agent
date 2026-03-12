import path from 'node:path';
import fs from 'node:fs/promises';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import { chatCompletion } from '../../src/openai/client.js';
import { toPosix, abs as toAbs } from '../../src/utils/path.js';
import { fileURLToPath } from 'node:url';
import { ok, fail } from '../../src/utils/result.js';

const STYLES = new Set(['default','colorful','dark','minimal','anime','cyberpunk','nature','business','code','academic','creative','retro']);

function ensureStyle(style) { return STYLES.has(style) ? style : 'default'; }

function generateSystemPrompt() {
  return (
    '你是一个专业的思维导图生成助手。请仅输出用于 Markmap 渲染的 Markdown 文本。\n' +
    '核心规则：\n' +
    '1) 严禁偷懒，必须将思维导图展开到最深层级（包含具体的数据、数值、描述），不要只给出一级大纲。\n' +
    '2) 只输出纯 Markdown 代码，不要解释，不要使用 ``` 代码块标记。\n' +
    '3) 使用 # 为根节点，## 为一级，### 为二级，依此类推（最多 5 级）。\n' +
    '4) 必须使用标准的半角数字和符号，严禁在数字中间插入空格，严禁使用全角数字。\n' +
    '5) 结构清晰，中文友好，可包含 emoji 表情。\n'
  );
}

function htmlTemplate(markdown, { width, height, styleCSS, scriptTags, fitRatio = 0.95, maxScale = 2.0 }) {
  const safeMarkdownJson = JSON.stringify(markdown).replace(/</g, '\\u003c');
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${scriptTags}
  <style>${styleCSS}</style>
</head>
<body>
  <svg id="markmap" width="${width}" height="${height}"></svg>
  <script>
    function initMarkmap() {
      try {
        if (typeof markmap === 'undefined') {
          window.__MARKMAP_READY__ = false;
          return;
        }
        
        const { Transformer, Markmap } = markmap;
        const transformer = new Transformer();
        const { root } = transformer.transform(${safeMarkdownJson});
        const svg = document.getElementById('markmap');
        
        const mm = Markmap.create(svg, {
          autoFit: true,
          zoom: true,
          pan: true,
          duration: 0,
          maxWidth: 0,
          initialExpandLevel: -1,
          fitRatio: ${fitRatio},
          maxInitialScale: ${maxScale},
          paddingX: 12
        }, root);
        
        const finalizeRender = () => {
          setTimeout(() => { 
            try { mm.fit(${maxScale}); } catch (e) { console.warn('FIT_ERR:', e); }
            window.__MARKMAP_READY__ = true;
          }, 800); 
        };

        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(finalizeRender).catch(finalizeRender);
        } else {
          finalizeRender();
        }

      } catch (e) {
        window.__MARKMAP_READY__ = false;
      }
    }
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(initMarkmap, 100));
    } else {
      setTimeout(initMarkmap, 100);
    }
  </script>
</body>
</html>`;
}

async function resolveScriptTags(penv = {}) {
  const assetMode = String(penv.MINDMAP_ASSET_MODE || process.env.MINDMAP_ASSET_MODE || 'cdn').toLowerCase();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const assetsDir = path.join(__dirname, 'assets');
  const toFileUrl = (p) => 'file://' + toPosix(p);

  // 修复了重复声明变量的 SyntaxError
  const localD3 = penv.MINDMAP_ASSET_D3_PATH || process.env.MINDMAP_ASSET_D3_PATH || path.join(assetsDir, 'd3.min.js');
  const localLib = penv.MINDMAP_ASSET_LIB_PATH || process.env.MINDMAP_ASSET_LIB_PATH || path.join(assetsDir, 'markmap-lib.min.js');
  const localView = penv.MINDMAP_ASSET_VIEW_PATH || process.env.MINDMAP_ASSET_VIEW_PATH || path.join(assetsDir, 'markmap-view.min.js');

  const buildTags = (d3Src, libSrc, viewSrc) =>[
    `<script src="${d3Src}"></script>`,
    `<script src="${libSrc}"></script>`,
    `<script src="${viewSrc}"></script>`
  ].join('\n  ');

  const exists = async (p) => {
    try { await fs.stat(p); return true; } catch { return false; }
  };

  if (assetMode === 'local') {
    if (await exists(localD3) && await exists(localLib) && await exists(localView)) {
      return buildTags(toFileUrl(localD3), toFileUrl(localLib), toFileUrl(localView));
    }
  }

  const cdnD3 = 'https://cdn.jsdelivr.net/npm/d3@6/dist/d3.min.js';
  const cdnLib = 'https://cdn.jsdelivr.net/npm/markmap-lib@0.18.10/dist/browser/index.iife.js';
  const cdnView = 'https://cdn.jsdelivr.net/npm/markmap-view@0.18.10/dist/browser/index.js';
  return buildTags(cdnD3, cdnLib, cdnView);
}

function defaultStyleCSS(style, fontPaths = {}) {
  let fontFaces = '';
  const fontFamilies =[];

  if (fontPaths.emoji) {
    const formatStr = fontPaths.emoji.endsWith('.woff2') ? "format('woff2')" : "format('truetype')";
    fontFaces += `@font-face { font-family: 'LocalEmoji'; src: url('${fontPaths.emoji}') ${formatStr}; font-display: block; }\n`;
  }
  if (fontPaths.zh) {
    const formatStr = fontPaths.zh.endsWith('.woff2') ? "format('woff2')" : "format('truetype')";
    fontFaces += `@font-face { font-family: 'LocalZh'; src: url('${fontPaths.zh}') ${formatStr}; font-display: block; }\n`;
  }

  // 1. 中文字体排第一优先级：让它接管所有汉字、数字、西文字母（展示绝美的哥特倾斜数字）
  if (fontPaths.zh) fontFamilies.push("'LocalZh'");
  // 2. Emoji 字体排第二优先级：仅用于处理中文字体没有的表情符号
  if (fontPaths.emoji) fontFamilies.push("'LocalEmoji'");
  // 3. 兜底回退
  fontFamilies.push("serif");

  const fontFamilyStr = fontFamilies.join(', ');

  // 深度穿透，开启比例数字(proportional-nums)和高级字距(kern)
  const baseNodeStyle = `
    svg { font-family: ${fontFamilyStr} !important; }
    .markmap-node, .markmap-node div, .markmap-node span {
      font-family: ${fontFamilyStr} !important;
      font-variant-numeric: proportional-nums !important;
      font-feature-settings: "pnum" 1, "kern" 1, "tnum" 0, "liga" 1 !important;
      letter-spacing: -0.2px !important;
      word-spacing: -0.8px !important;
      line-height: 1.3;
    }
  `;

  switch (ensureStyle(style)) {
    case 'dark':
      return `${fontFaces}body,html{margin:0;height:100%;overflow:hidden;background:#1a1a1a}#markmap{width:100%;height:100%}${baseNodeStyle}.markmap-node{color:#fff;}`;
    case 'minimal':
      return `${fontFaces}body,html{margin:0;height:100%;overflow:hidden;background:#f8f9fa}#markmap{width:100%;height:100%}${baseNodeStyle}.markmap-node{font-weight:300;}`;
    case 'colorful':
      return `${fontFaces}body,html{margin:0;height:100%;overflow:hidden;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}#markmap{width:100%;height:100%}${baseNodeStyle}.markmap-node{font-weight:bold;}`;
    default:
      return `${fontFaces}body,html{margin:0;height:100%;overflow:hidden;background:#fff}#markmap{width:100%;height:100%}${baseNodeStyle}`;
  }
}

function validateMarkdown(md) {
  if (!md || typeof md !== 'string') return false;
  const lines = md.split('\n').map((l)=>l.trim()).filter(Boolean);
  if (!lines.some((l)=>l.startsWith('#'))) return false;
  return true;
}

function isTimeoutError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  const code = String(e?.code || '').toUpperCase();
  return (
    code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' ||
    code === 'ECONNABORTED' || msg.includes('timeout') || msg.includes('timed out')
  );
}

function buildAdvice(kind, ctx = {}) {
  const personaHint = '请结合你当前的预设/人设继续作答。';
  if (kind === 'INVALID') {
    return { suggested_reply: '我现在还没拿到要生成思维导图的主题/描述。你把主题和文件名发我一下，我就继续。', context: ctx };
  }
  return { suggested_reply: '我尝试帮你生成思维导图，但这次渲染失败或超时了。我可以先给你文本大纲，或稍后重试。', context: ctx };
}

async function ensureDirForFile(filePath) {
  const outAbs = toAbs(filePath);
  const dir = path.dirname(outAbs);
  await fs.mkdir(dir, { recursive: true });
  return outAbs;
}

async function renderImage({ markdown, outputFile, width, height, style, waitTime, penv }) {
  let puppeteer;
  try { ({ default: puppeteer } = await import('puppeteer')); } catch { throw new Error('puppeteer not installed'); }
  
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fontsDir = path.join(__dirname, 'assets', 'fonts');
  const toFileUrl = (p) => 'file://' + toPosix(p);

  const exists = async (p) => {
    try { await fs.access(p); return true; } catch { return false; }
  };

  const fontPaths = {};
  
  if (await exists(path.join(fontsDir, 'zh.woff2'))) fontPaths.zh = toFileUrl(path.join(fontsDir, 'zh.woff2'));
  else if (await exists(path.join(fontsDir, 'zh.ttf'))) fontPaths.zh = toFileUrl(path.join(fontsDir, 'zh.ttf'));
  
  if (await exists(path.join(fontsDir, 'emoji.woff2'))) fontPaths.emoji = toFileUrl(path.join(fontsDir, 'emoji.woff2'));
  else if (await exists(path.join(fontsDir, 'emoji.ttf'))) fontPaths.emoji = toFileUrl(path.join(fontsDir, 'emoji.ttf'));

  const styleCSS = defaultStyleCSS(style, fontPaths);
  const scriptTags = await resolveScriptTags(penv);
  const fitRatio = Number(penv.MINDMAP_FIT_RATIO || process.env.MINDMAP_FIT_RATIO || 0.95);
  const maxScale = Number(penv.MINDMAP_MAX_SCALE || process.env.MINDMAP_MAX_SCALE || 2.0);
  
  const html = htmlTemplate(markdown, { width, height, styleCSS, scriptTags, fitRatio, maxScale });
  const outPngAbs = await ensureDirForFile(outputFile);
  const tempHtml = path.join(path.dirname(outPngAbs), `mindmap-${Date.now()}.html`);
  
  let browser;
  try {
    await fs.writeFile(tempHtml, html, 'utf-8');

    browser = await puppeteer.launch({ 
      headless: 'new', 
      args:['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files', '--disable-web-security'] 
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto('file://' + toPosix(tempHtml), { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    const maxWait = Math.max(1000, Number(waitTime) || 8000);
    const readyTimeout = Math.min(30000, maxWait);
    
    try {
      await page.waitForFunction('window.__MARKMAP_READY__ === true', { timeout: readyTimeout });
    } catch (timeoutErr) {}
    
    await new Promise((r) => setTimeout(r, 600)); // 额外预留重绘时间
    
    const screenshotPromise = page.screenshot({ path: outPngAbs, type: 'png', clip: { x: 0, y: 0, width, height } });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Screenshot timeout')), 30000));
    
    await Promise.race([screenshotPromise, timeoutPromise]);
  } finally {
    if (browser) await browser.close().catch(()=>{});
    try { await fs.unlink(tempHtml); } catch {}
  }
  
  return { abs: outPngAbs };
}

export default async function handler(args = {}, options = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return fail('prompt is required', 'INVALID', { advice: buildAdvice('INVALID') });

  try {
    const penv = options?.pluginEnv || {};
    const width = Math.min(8000, Math.max(400, Number(args.width ?? penv.MINDMAP_WIDTH ?? 2400)));
    const height = Math.min(6000, Math.max(300, Number(args.height ?? penv.MINDMAP_HEIGHT ?? 1600)));
    const style = ensureStyle(String((args.style ?? penv.MINDMAP_DEFAULT_STYLE ?? 'default')));
    const waitTime = Math.max(1000, Number(args.waitTime ?? penv.MINDMAP_WAIT_TIME ?? 8000));
    
    const render = typeof args.render === 'string' ? args.render.toLowerCase() !== 'false' : args.render !== false;

    let outputFile = null;
    if (render) {
      let rawName = String(args.filename || 'mindmap.png').trim();
      rawName = path.basename(rawName);
      if (!rawName || rawName === '.' || rawName === '..') rawName = 'mindmap.png';
      outputFile = path.join('artifacts', rawName);
      if (!outputFile.toLowerCase().endsWith('.png')) outputFile += '.png';
    }

    const messages =[
      { role: 'system', content: generateSystemPrompt() },
      { role: 'user', content: `请详细展开生成思维导图：${prompt}` }
    ];
    
    const resp = await chatCompletion({
      messages,
      temperature: 0.2,
      apiKey: penv.MINDMAP_API_KEY || process.env.MINDMAP_API_KEY || config.llm.apiKey,
      baseURL: penv.MINDMAP_BASE_URL || process.env.MINDMAP_BASE_URL || config.llm.baseURL || 'https://yuanplus.chat/v1',
      model: penv.MINDMAP_MODEL || process.env.MINDMAP_MODEL || config.llm.model,
      omitMaxTokens: true
    });
    
    let content = resp.choices?.[0]?.message?.content?.trim() || '';
    content = content.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '').trim();

    // =============== 核心清洗：修正 AI 的异常格式输出 ===============
    // 1. 全角转半角 (uff10-uff19 为数字 0-9)
    content = content.replace(/[\uff10-\uff19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    // 2. 清除全角冒号和全角空格
    content = content.replace(/\uff1a/g, ':').replace(/\u3000/g, ' ');
    // 3. 自动合并数字中间被拆分的空格（例: 2 4 ℃ -> 24℃）
    content = content.replace(/(\d)\s+(?=[\d℃C:%：])/g, '$1');
    // 4. 清洗冒号后面的多余空格
    content = content.replace(/([:：])\s+(?=\d)/g, '$1');
    // ================================================================

    if (!validateMarkdown(content)) {
      return fail('生成的Markdown内容无效', 'MARKDOWN_INVALID', { advice: buildAdvice('MARKDOWN_INVALID') });
    }

    let image = null;
    let renderError = null;
    if (render) {
      try {
        image = await renderImage({ markdown: content, outputFile, width, height, style, waitTime, penv });
      } catch (e) {
        renderError = String(e?.message || e);
        logger.warn?.('mindmap_gen:render_failed', { label: 'PLUGIN', error: renderError });
      }
    }

    if (render && !image?.abs) {
      return fail(renderError || 'failed to render mindmap image', 'RENDER_FAILED', { advice: buildAdvice('RENDER_FAILED') });
    }

    const data = {
      prompt,
      markdown_content: content,
      path_markdown: image?.abs ? `![${path.basename(image.abs)}](${image.abs})` : null,
      width,
      height,
      style,
      generation_info: {
        model: resp.model,
        created: resp.created,
        baseURL: (penv.MINDMAP_BASE_URL || process.env.MINDMAP_BASE_URL || config.llm.baseURL || 'https://yuanplus.chat/v1')
      }
    };
    return ok(data);
  } catch (e) {
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR') });
  }
}
