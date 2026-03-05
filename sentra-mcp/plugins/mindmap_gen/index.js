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
    '你是一个专业的思维导图生成助手。请仅输出用于 Markmap 渲染的 Markdown 文本（不要任何解释或代码块标记）。\n' +
    '规则：\n' +
    '1) 只输出 Markdown 代码，不要解释或 ``` 代码块\n' +
    '2) 使用 # 作为主节点，## 作为一级子节点，### 作为二级子节点（最多 5 级）\n' +
    '3) 结构清晰，中文友好，可包含 emoji\n' +
    '4) 不要包含 HTML 标签或非 Markdown 内容\n'
  );
}

function htmlTemplate(markdown, { width, height, styleCSS, scriptTags, fitRatio = 0.9, maxScale = 2.0 }) {
  // XSS 防护：防止恶意闭合 script 标签
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
          console.error('MARKMAP_INIT_ERROR: markmap global is undefined');
          window.__MARKMAP_READY__ = false;
          return;
        }
        
        const { Transformer, Markmap } = markmap;
        if (!Transformer || !Markmap) {
          console.error('MARKMAP_INIT_ERROR: Transformer or Markmap not found in markmap global');
          window.__MARKMAP_READY__ = false;
          return;
        }
        
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
          paddingX: 8
        }, root);
        
        setTimeout(() => { 
          try {
            mm.fit(${maxScale});
            const svgEl = document.getElementById('markmap');
            const g = svgEl?.querySelector('g');
            if (g) {
              const bbox = g.getBBox();
              console.log('MARKMAP_FINAL:', { 
                bbox: { width: bbox.width, height: bbox.height, x: bbox.x, y: bbox.y },
                transform: g.getAttribute('transform')
              });
            }
          } catch (e) { 
            console.warn('MARKMAP_FIT_ERROR:', e); 
          }
          window.__MARKMAP_READY__ = true;
          console.log('MARKMAP_READY: true');
        }, 500);
      } catch (e) {
        console.error('MARKMAP_INIT_ERROR:', e);
        window.__MARKMAP_READY__ = false;
      }
    }
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(initMarkmap, 100);
      });
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
      logger.info?.('mindmap_gen: using local assets', { label: 'PLUGIN', assetsDir });
      return buildTags(toFileUrl(localD3), toFileUrl(localLib), toFileUrl(localView));
    }
    logger.warn?.('mindmap_gen: local assets missing, falling back to CDN', { label: 'PLUGIN' });
  }

  const cdnD3 = 'https://cdn.jsdelivr.net/npm/d3@6/dist/d3.min.js';
  const cdnLib = 'https://cdn.jsdelivr.net/npm/markmap-lib@0.18.10/dist/browser/index.iife.js';
  const cdnView = 'https://cdn.jsdelivr.net/npm/markmap-view@0.18.10/dist/browser/index.js';
  return buildTags(cdnD3, cdnLib, cdnView);
}

// 动态注入本地字体配置
function defaultStyleCSS(style, fontPaths = {}) {
  let fontFaces = '';
  const fontFamilies =[];

  if (fontPaths.emoji) {
    fontFaces += `@font-face { font-family: 'LocalEmoji'; src: url('${fontPaths.emoji}'); font-display: swap; }\n`;
    fontFamilies.push("'LocalEmoji'");
  }
  if (fontPaths.zh) {
    fontFaces += `@font-face { font-family: 'LocalZh'; src: url('${fontPaths.zh}'); font-display: swap; }\n`;
    fontFamilies.push("'LocalZh'");
  }

  fontFamilies.push("'Segoe UI Emoji'", "'Segoe UI'", "'Microsoft YaHei'", "Arial", "sans-serif");
  const fontFamilyStr = fontFamilies.join(', ');

  const baseNodeStyle = `.markmap-node { font-family: ${fontFamilyStr} !important; }`;

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
  // 放宽校验，允许 Markdown 中出现偶尔的说明性文字，只要存在 # 结构即可
  if (!lines.some((l)=>l.startsWith('# '))) return false;
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
  const personaHint = '请结合你当前的预设/人设继续作答：当思维导图生成失败时，要说明失败原因，给替代方案，并引导用户。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我现在还没拿到要生成思维导图的主题/描述（prompt 为空或 filename 不合规），所以没法开始生成。你把主题和文件名发我一下，我就继续。',
      next_steps:['补充 prompt', '提供 filename（不含目录）'], persona_hint: personaHint, context: ctx,
    };
  }
  if (kind === 'MARKDOWN_INVALID') {
    return {
      suggested_reply: '我生成到了思维导图的文本草稿，但它的结构不符合可渲染的格式，所以这次没法稳定渲染成图。我可以把内容改成更规范的层级结构后再试一次。',
      next_steps:['让我重新排版', '提供大纲我来展开'], persona_hint: personaHint, context: ctx,
    };
  }
  if (kind === 'RENDER_FAILED') {
    return {
      suggested_reply: '我已经生成了思维导图内容，但在渲染成图片时失败了。我可以先把 Markdown 导图文本发给你，或者我们调整参数后再重试。',
      next_steps:['输出文本导图', '稍后重试渲染'], persona_hint: personaHint, context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我在生成/渲染思维导图时卡住了，像是超时了。我可以先给你导图的 Markdown 文本版本，之后再尝试生成图片版。',
      next_steps:['先交付文本导图', '降低内容规模并重试'], persona_hint: personaHint, context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试帮你生成思维导图，但这次工具执行失败了。我可以先按你的主题给一份结构化大纲（文本版），并建议你如何补充要点后再生成图片版。',
    next_steps:['提供导图大纲供选择', '补充一级模块'], persona_hint: personaHint, context: ctx,
  };
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
  const zhFontPathWoff2 = path.join(fontsDir, 'zh.woff2');
  const zhFontPathTtf = path.join(fontsDir, 'zh.ttf');
  const emojiFontPath = path.join(fontsDir, 'emoji.ttf');

  if (await exists(zhFontPathWoff2)) fontPaths.zh = toFileUrl(zhFontPathWoff2);
  else if (await exists(zhFontPathTtf)) fontPaths.zh = toFileUrl(zhFontPathTtf);
  if (await exists(emojiFontPath)) fontPaths.emoji = toFileUrl(emojiFontPath);

  const styleCSS = defaultStyleCSS(style, fontPaths);
  const scriptTags = await resolveScriptTags(penv);
  const fitRatio = Number(penv.MINDMAP_FIT_RATIO || process.env.MINDMAP_FIT_RATIO || 0.9);
  const maxScale = Number(penv.MINDMAP_MAX_SCALE || process.env.MINDMAP_MAX_SCALE || 2.0);
  
  const html = htmlTemplate(markdown, { width, height, styleCSS, scriptTags, fitRatio, maxScale });
  const outPngAbs = await ensureDirForFile(outputFile);
  const tempHtml = path.join(path.dirname(outPngAbs), `mindmap-${Date.now()}.html`);
  
  let browser;
  try {
    // 写入临时文件放入 try 块中，确保抛错时也能走到 finally 删除垃圾文件
    await fs.writeFile(tempHtml, html, 'utf-8');

    browser = await puppeteer.launch({ 
      headless: 'new', 
      args:['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files', '--disable-web-security'] 
    });
    
    const page = await browser.newPage();
    
    page.on('console', msg => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        logger.warn?.(`mindmap_gen: page ${type}`, { label: 'PLUGIN', text: msg.text() });
      }
    });
    
    page.on('pageerror', err => {
      logger.error?.('mindmap_gen: page error', { label: 'PLUGIN', error: String(err) });
    });
    
    await page.setViewport({ width, height });
    await page.goto('file://' + toPosix(tempHtml), { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    const hasMarkmap = await page.evaluate(() => typeof window.markmap !== 'undefined');
    if (!hasMarkmap) {
      throw new Error('window.markmap is undefined - scripts may not have loaded correctly');
    }
    
    const maxWait = Math.max(1000, Number(waitTime) || 8000);
    const readyTimeout = Math.min(30000, maxWait);
    
    try {
      await page.waitForFunction('window.__MARKMAP_READY__ === true', { timeout: readyTimeout });
    } catch (timeoutErr) {
      const readyState = await page.evaluate(() => window.__MARKMAP_READY__);
      throw new Error(`Markmap initialization timeout after ${readyTimeout}ms (readyState: ${readyState})`);
    }
    
    await new Promise((r) => setTimeout(r, 800));
    
    await page.evaluate(() => new Promise(resolve => {
      const raf = (n) => {
        if (n <= 0) setTimeout(resolve, 200);
        else requestAnimationFrame(() => raf(n - 1));
      };
      raf(3);
    }));
    
    const svgExists = await page.evaluate(() => !!document.getElementById('markmap')?.querySelector('g'));
    if (!svgExists) {
      throw new Error('SVG element not found before screenshot');
    }
    
    const screenshotPromise = page.screenshot({ 
      path: outPngAbs, type: 'png', clip: { x: 0, y: 0, width, height } 
    });
    
    let timeoutTimer;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error('Screenshot timeout after 30s')), 30000);
    });
    
    try {
      await Promise.race([screenshotPromise, timeoutPromise]);
      logger.info?.('mindmap_gen: screenshot saved', { label: 'PLUGIN', path: outPngAbs });
    } finally {
      clearTimeout(timeoutTimer); 
    }
    
  } finally {
    if (browser) {
      try {
        const closePromise = browser.close();
        const closeTimeout = new Promise((resolve) => setTimeout(resolve, 5000));
        await Promise.race([closePromise, closeTimeout]);
      } catch (e) {
        logger.warn?.('mindmap_gen: browser close failed', { label: 'PLUGIN', error: String(e) });
      }
    }
    
    const isDebug = String(penv.MINDMAP_DEBUG || process.env.MINDMAP_DEBUG) === 'true';
    if (!isDebug) {
      try { await fs.unlink(tempHtml); } catch {}
    } else {
      logger.info?.('mindmap_gen: temp HTML kept for debugging', { label: 'PLUGIN', path: tempHtml });
    }
  }
  
  return { abs: outPngAbs };
}

export default async function handler(args = {}, options = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return fail('prompt is required', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'mindmap_gen' }) });

  try {
    const penv = options?.pluginEnv || {};
    // OOM 防护：增加边界限制
    const width = Math.min(8000, Math.max(400, Number(args.width ?? penv.MINDMAP_WIDTH ?? 2400)));
    const height = Math.min(6000, Math.max(300, Number(args.height ?? penv.MINDMAP_HEIGHT ?? 1600)));
    const style = ensureStyle(String((args.style ?? penv.MINDMAP_DEFAULT_STYLE ?? 'default')));
    const waitTime = Math.max(1000, Number(args.waitTime ?? penv.MINDMAP_WAIT_TIME ?? 8000));
    
    // 强制过滤非法文件名与路径越界
    let rawName = String(args.filename || '').trim();
    rawName = path.basename(rawName);
    if (!rawName || rawName === '.' || rawName === '..') {
        return fail('filename is invalid (filename only, no paths)', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'mindmap_gen' }) });
    }
    
    let outputFile = path.join('artifacts', rawName);
    if (!outputFile.toLowerCase().endsWith('.png')) outputFile += '.png';
    const render = args.render !== false;

    const messages =[
      { role: 'system', content: generateSystemPrompt() },
      { role: 'user', content: `请根据以下描述生成思维导图：${prompt}` }
    ];
    
    const resp = await chatCompletion({
      messages,
      temperature: 0.2,
      apiKey: penv.MINDMAP_API_KEY || process.env.MINDMAP_API_KEY || config.llm.apiKey,
      baseURL: penv.MINDMAP_BASE_URL || process.env.MINDMAP_BASE_URL || config.llm.baseURL || 'https://yuanplus.chat/v1',
      model: penv.MINDMAP_MODEL || process.env.MINDMAP_MODEL || config.llm.model,
      omitMaxTokens: true
    });
    
    // 智能剥离 LLM 输出外层的代码块标记，提高成功率
    let content = resp.choices?.[0]?.message?.content?.trim() || '';
    content = content.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '').trim();

    if (!validateMarkdown(content)) {
      return fail('生成的Markdown内容无效', 'MARKDOWN_INVALID', {
        advice: buildAdvice('MARKDOWN_INVALID', { tool: 'mindmap_gen', prompt }),
        detail: { prompt, markdown_content: content },
      });
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
      return fail(renderError || 'failed to render mindmap image', 'RENDER_FAILED', {
        advice: buildAdvice('RENDER_FAILED', { tool: 'mindmap_gen', prompt }),
        detail: { prompt, markdown_content: content, width, height, style }
      });
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
    return fail(e, isTimeout ? 'TIMEOUT' : 'ERR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'mindmap_gen', prompt }) });
  }
}