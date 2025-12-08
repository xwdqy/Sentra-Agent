import path from 'node:path';
import fs from 'node:fs/promises';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import { chatCompletion } from '../../src/openai/client.js';
import { toPosix, abs as toAbs } from '../../src/utils/path.js';
import { fileURLToPath } from 'node:url';

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
        const { root } = transformer.transform(${JSON.stringify(markdown)});
        const svg = document.getElementById('markmap');
        
        // 使用 Markmap 内置配置控制缩放和适配
        const mm = Markmap.create(svg, {
          autoFit: true,              // 自动适配视口
          zoom: true,
          pan: true,
          duration: 0,                // 禁用动画
          maxWidth: 0,                // 不限制节点宽度
          initialExpandLevel: -1,     // 展开所有层级
          fitRatio: ${fitRatio},      // 适配比例（0.9 = 留 10% 边距）
          maxInitialScale: ${maxScale}, // 最大初始缩放（防止过度放大）
          paddingX: 8                 // 水平内边距
        }, root);
        
        // 等待渲染完成
        setTimeout(() => { 
          try {
            // 使用内置 fit 方法，传入 maxScale 限制最大缩放
            mm.fit(${maxScale});
            
            // 获取最终渲染信息用于调试
            const svgEl = document.getElementById('markmap');
            const g = svgEl?.querySelector('g');
            if (g) {
              const bbox = g.getBBox();
              const transform = g.getAttribute('transform');
              console.log('MARKMAP_FINAL:', { 
                bbox: { width: bbox.width, height: bbox.height, x: bbox.x, y: bbox.y },
                transform: transform
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
    
    // Wait for DOM and all scripts to be ready
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

// Resolve script tags for either local assets (preferred) or CDN fallback
async function resolveScriptTags(penv = {}) {
  const assetMode = String(penv.MINDMAP_ASSET_MODE || process.env.MINDMAP_ASSET_MODE || 'cdn').toLowerCase();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const assetsDir = path.join(__dirname, 'assets');
  const toFileUrl = (p) => 'file://' + toPosix(p);

  const localD3 = penv.MINDMAP_ASSET_D3_PATH || process.env.MINDMAP_ASSET_D3_PATH || path.join(assetsDir, 'd3.min.js');
  const localLib = penv.MINDMAP_ASSET_LIB_PATH || process.env.MINDMAP_ASSET_LIB_PATH || path.join(assetsDir, 'markmap-lib.min.js');
  const localView = penv.MINDMAP_ASSET_VIEW_PATH || process.env.MINDMAP_ASSET_VIEW_PATH || path.join(assetsDir, 'markmap-view.min.js');

  const buildTags = (d3Src, libSrc, viewSrc) => [
    `<script src="${d3Src}"></script>`,
    `<script src="${libSrc}"></script>`,
    `<script src="${viewSrc}"></script>`
  ].join('\n  ');

  // Helper: check if a file exists
  const exists = async (p) => {
    try { await fs.stat(p); return true; } catch { return false; }
  };

  // Prefer local assets if configured and present
  if (assetMode === 'local') {
    const okD3 = await exists(localD3);
    const okLib = await exists(localLib);
    const okView = await exists(localView);
    if (okD3 && okLib && okView) {
      logger.info?.('mindmap_gen: using local assets', { label: 'PLUGIN', assetsDir: assetsDir });
      return buildTags(toFileUrl(localD3), toFileUrl(localLib), toFileUrl(localView));
    }
    logger.warn?.('mindmap_gen: local assets missing, falling back to CDN', { label: 'PLUGIN', localD3, localLib, localView });
  }

  // CDN fallback
  const cdnD3 = 'https://cdn.jsdelivr.net/npm/d3@6/dist/d3.min.js';
  const cdnLib = 'https://cdn.jsdelivr.net/npm/markmap-lib@0.18.10/dist/browser/index.iife.js';
  const cdnView = 'https://cdn.jsdelivr.net/npm/markmap-view@0.18.10/dist/browser/index.js';
  logger.info?.('mindmap_gen: using CDN assets', { label: 'PLUGIN', cdnD3, cdnLib, cdnView });
  return buildTags(cdnD3, cdnLib, cdnView);
}

function defaultStyleCSS(style) {
  switch (ensureStyle(style)) {
    case 'dark':
      return `body,html{margin:0;height:100%;overflow:hidden;background:#1a1a1a}#markmap{width:100%;height:100%}.markmap-node{color:#fff;font-family:Segoe UI,Microsoft YaHei,Arial,sans-serif}`;
    case 'minimal':
      return `body,html{margin:0;height:100%;overflow:hidden;background:#f8f9fa}#markmap{width:100%;height:100%}.markmap-node{font-weight:300;font-family:Segoe UI,Microsoft YaHei,Arial,sans-serif}`;
    case 'colorful':
      return `body,html{margin:0;height:100%;overflow:hidden;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}#markmap{width:100%;height:100%}.markmap-node{font-weight:bold;font-family:Segoe UI,Microsoft YaHei,Arial,sans-serif}`;
    default:
      return `body,html{margin:0;height:100%;overflow:hidden;background:#fff}#markmap{width:100%;height:100%}.markmap-node{font-family:Segoe UI,Microsoft YaHei,Arial,sans-serif}`;
  }
}

function validateMarkdown(md) {
  if (!md || typeof md !== 'string') return false;
  const lines = md.split('\n').map((l)=>l.trim()).filter(Boolean);
  if (!lines.some((l)=>l.startsWith('#'))) return false;
  if (lines.some((l)=>l.includes('```'))) return false;
  if (!lines.some((l)=>l.startsWith('# '))) return false;
  return true;
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
  const styleCSS = defaultStyleCSS(style);
  const scriptTags = await resolveScriptTags(penv);
  
  // 获取 Markmap 配置参数
  const fitRatio = Number(penv.MINDMAP_FIT_RATIO || process.env.MINDMAP_FIT_RATIO || 0.9);
  const maxScale = Number(penv.MINDMAP_MAX_SCALE || process.env.MINDMAP_MAX_SCALE || 2.0);
  
  const html = htmlTemplate(markdown, { width, height, styleCSS, scriptTags, fitRatio, maxScale });
  const outPngAbs = await ensureDirForFile(outputFile);
  const tempHtml = path.join(path.dirname(outPngAbs), `mindmap-${Date.now()}.html`);
  await fs.writeFile(tempHtml, html, 'utf-8');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox','--allow-file-access-from-files'] });
  let keepTempHtml = false;
  try {
    const page = await browser.newPage();
    
    // Listen to console logs for debugging
    page.on('console', msg => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        logger.warn?.(`mindmap_gen: page ${type}`, { label: 'PLUGIN', text: msg.text() });
      }
    });
    
    // Listen to page errors
    page.on('pageerror', err => {
      logger.error?.('mindmap_gen: page error', { label: 'PLUGIN', error: String(err) });
      keepTempHtml = true;
    });
    
    await page.setViewport({ width, height });
    // Avoid waiting for external network to be fully idle; rely on readiness flag instead
    await page.goto('file://' + toPosix(tempHtml), { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Check if markmap global is available
    const hasMarkmap = await page.evaluate(() => typeof window.markmap !== 'undefined');
    if (!hasMarkmap) {
      keepTempHtml = true;
      throw new Error('window.markmap is undefined - scripts may not have loaded correctly');
    }
    
    // Prefer readiness flag from the page; fallback to a small Node-side delay
    const maxWait = Math.max(1000, Number(waitTime) || 8000);
    const readyTimeout = Math.min(30000, maxWait);
    
    try {
      await page.waitForFunction('window.__MARKMAP_READY__ === true', { timeout: readyTimeout });
      logger.info?.('mindmap_gen: markmap ready', { label: 'PLUGIN' });
    } catch (timeoutErr) {
      keepTempHtml = true;
      const readyState = await page.evaluate(() => window.__MARKMAP_READY__);
      logger.error?.('mindmap_gen: timeout waiting for ready flag', { 
        label: 'PLUGIN', 
        readyState, 
        timeout: readyTimeout,
        tempHtml 
      });
      throw new Error(`Markmap initialization timeout after ${readyTimeout}ms (ready state: ${readyState})`);
    }
    
    // 增加延迟确保 fit() 和缩放完全生效
    await new Promise((r) => setTimeout(r, 800));
    
    // 获取思维导图实际渲染尺寸用于调试
    const bboxInfo = await page.evaluate(() => {
      try {
        const svgEl = document.getElementById('markmap');
        const g = svgEl.querySelector('g');
        if (!g) return null;
        const bbox = g.getBBox();
        return { width: bbox.width, height: bbox.height, x: bbox.x, y: bbox.y };
      } catch (e) {
        return null;
      }
    });
    
    if (bboxInfo) {
      logger.info?.('mindmap_gen: content bbox', { label: 'PLUGIN', bbox: bboxInfo });
    }
    
    // 等待浏览器完成所有重绘和布局（多重 requestAnimationFrame 确保稳定）
    await page.evaluate(() => new Promise(resolve => {
      // 使用多重 RAF 确保所有异步渲染都完成
      const raf = (n) => {
        if (n <= 0) {
          setTimeout(resolve, 200);  // 最后再等 200ms
        } else {
          requestAnimationFrame(() => raf(n - 1));
        }
      };
      raf(3);  // 3 次 RAF
    }));
    
    // 验证 SVG 是否存在
    const svgExists = await page.evaluate(() => {
      const svg = document.getElementById('markmap');
      const g = svg?.querySelector('g');
      return !!g;
    });
    
    if (!svgExists) {
      keepTempHtml = true;
      throw new Error('SVG element not found before screenshot');
    }
    
    logger.info?.('mindmap_gen: ready to screenshot', { label: 'PLUGIN', path: outPngAbs });
    
    // 添加截图超时保护
    const screenshotPromise = page.screenshot({ 
      path: outPngAbs, 
      type: 'png', 
      clip: { x: 0, y: 0, width, height } 
    });
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Screenshot timeout after 30s')), 30000)
    );
    
    await Promise.race([screenshotPromise, timeoutPromise]);
    logger.info?.('mindmap_gen: screenshot saved', { label: 'PLUGIN', path: outPngAbs });
  } finally {
    // 关闭浏览器（带超时保护）
    logger.info?.('mindmap_gen: closing browser', { label: 'PLUGIN' });
    try {
      const closePromise = browser.close();
      const closeTimeout = new Promise((resolve) => setTimeout(resolve, 5000));
      await Promise.race([closePromise, closeTimeout]);
      logger.info?.('mindmap_gen: browser closed', { label: 'PLUGIN' });
    } catch (e) {
      logger.warn?.('mindmap_gen: browser close failed', { label: 'PLUGIN', error: String(e) });
    }
    
    // 清理临时文件
    if (!keepTempHtml) {
      try { 
        await fs.unlink(tempHtml); 
        logger.info?.('mindmap_gen: temp HTML deleted', { label: 'PLUGIN' });
      } catch {}
    } else {
      logger.warn?.('mindmap_gen: temp HTML kept for debugging', { label: 'PLUGIN', path: tempHtml });
    }
  }
  
  logger.info?.('mindmap_gen: render complete', { label: 'PLUGIN', path: outPngAbs });
  const absPath = outPngAbs;
  return { abs: absPath };
}

export default async function handler(args = {}, options = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return { success: false, code: 'INVALID', error: 'prompt is required' };

  const penv = options?.pluginEnv || {};
  const width = Math.max(400, Number(args.width ?? penv.MINDMAP_WIDTH ?? 2400));
  const height = Math.max(300, Number(args.height ?? penv.MINDMAP_HEIGHT ?? 1600));
  const style = ensureStyle(String((args.style ?? penv.MINDMAP_DEFAULT_STYLE ?? 'default')));
  const waitTime = Math.max(1000, Number(args.waitTime ?? penv.MINDMAP_WAIT_TIME ?? 8000));
  const baseDir = 'artifacts';
  const rawName = String(args.filename || '').trim();
  if (!rawName) return { success: false, code: 'INVALID', error: 'filename is required (filename only, no directories)' };
  if (/[\\\/]/.test(rawName)) return { success: false, code: 'INVALID', error: 'filename must not contain path separators' };
  let outputFile = path.join(baseDir, rawName);
  if (!outputFile.toLowerCase().endsWith('.png')) outputFile += '.png';
  const render = args.render !== false;

  // 1) Ask LLM to produce markdown only
  const messages = [
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
  const content = resp.choices?.[0]?.message?.content?.trim() || '';
  if (!validateMarkdown(content)) throw new Error('生成的Markdown内容无效');

  // 2) Optionally render PNG with Puppeteer
  let image = null;
  if (render) {
    try {
      logger.info?.('mindmap_gen: starting render', { label: 'PLUGIN', outputFile });
      image = await renderImage({ markdown: content, outputFile, width, height, style, waitTime, penv });
      logger.info?.('mindmap_gen: render returned', { label: 'PLUGIN', imagePath: image?.abs });
    } catch (e) {
      logger.warn?.('mindmap_gen:render_failed', { label: 'PLUGIN', error: String(e?.message || e) });
    }
  }

  logger.info?.('mindmap_gen: preparing response', { label: 'PLUGIN' });
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
  logger.info?.('mindmap_gen: handler returning success', { label: 'PLUGIN', hasImage: !!image });
  return { success: true, data };
}
