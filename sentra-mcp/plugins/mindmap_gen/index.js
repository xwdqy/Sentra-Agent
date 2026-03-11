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
          autoFit: true, zoom: true, pan: true, duration: 0,
          maxWidth: 0, initialExpandLevel: -1, fitRatio: ${fitRatio},
          maxInitialScale: ${maxScale}, paddingX: 8
        }, root);
        
        const finalizeRender = () => {
          setTimeout(() => { 
            try { mm.fit(${maxScale}); } catch (e) {}
            window.__MARKMAP_READY__ = true;
          }, 800);
        };

        // 强制等待所有资源（尤其是字体）加载
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
  const localD3 = path.join(assetsDir, 'd3.min.js');
  const localLib = path.join(assetsDir, 'markmap-lib.min.js');
  const localView = path.join(assetsDir, 'markmap-view.min.js');
  const exists = async (p) => { try { await fs.stat(p); return true; } catch { return false; } };

  if (assetMode === 'local' && await exists(localD3) && await exists(localLib) && await exists(localView)) {
    return `<script src="${toFileUrl(localD3)}"></script><script src="${toFileUrl(localLib)}"></script><script src="${toFileUrl(localView)}"></script>`;
  }
  return `<script src="https://cdn.jsdelivr.net/npm/d3@6"></script><script src="https://cdn.jsdelivr.net/npm/markmap-lib@0.18.10"></script><script src="https://cdn.jsdelivr.net/npm/markmap-view@0.18.10"></script>`;
}

function defaultStyleCSS(style, fontPaths = {}) {
  let fontFaces = '';
  const families = [];
  
  if (fontPaths.emoji) {
    fontFaces += `@font-face { font-family: 'LocalEmoji'; src: url('${fontPaths.emoji}'); font-display: block; }\n`;
    families.push("'LocalEmoji'");
  }
  if (fontPaths.zh) {
    fontFaces += `@font-face { font-family: 'LocalZh'; src: url('${fontPaths.zh}'); font-display: block; }\n`;
    families.push("'LocalZh'");
  }
  
  // 关键：剔除 Arial，只保留 serif 作为最后的物理回退，强制让 LocalZh 处理数字
  families.push("serif");
  const familyStr = families.join(', ');

  // 核心修复：针对 .markmap-node 及其内部所有 div/span 强制应用字体
  const baseNodeStyle = `
    .markmap-node, .markmap-node div, .markmap-node span { 
      font-family: ${familyStr} !important; 
      font-feature-settings: "kern" 1, "liga" 1; /* 开启高级字距调节 */
    }
    svg { font-family: ${familyStr} !important; }
  `;

  switch (ensureStyle(style)) {
    case 'dark': return `${fontFaces}body,html{margin:0;height:100%;overflow:hidden;background:#1a1a1a}#markmap{width:100%;height:100%}${baseNodeStyle}.markmap-node{color:#fff;}`;
    case 'colorful': return `${fontFaces}body,html{margin:0;height:100%;overflow:hidden;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}#markmap{width:100%;height:100%}${baseNodeStyle}.markmap-node{font-weight:bold;}`;
    default: return `${fontFaces}body,html{margin:0;height:100%;overflow:hidden;background:#fff}#markmap{width:100%;height:100%}${baseNodeStyle}`;
  }
}

async function renderImage({ markdown, outputFile, width, height, style, penv }) {
  let puppeteer;
  try { ({ default: puppeteer } = await import('puppeteer')); } catch { throw new Error('puppeteer not installed'); }
  
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fontsDir = path.join(__dirname, 'assets', 'fonts');
  const toFileUrl = (p) => 'file://' + toPosix(p);
  const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

  const fontPaths = {};
  if (await exists(path.join(fontsDir, 'zh.woff2'))) fontPaths.zh = toFileUrl(path.join(fontsDir, 'zh.woff2'));
  else if (await exists(path.join(fontsDir, 'zh.ttf'))) fontPaths.zh = toFileUrl(path.join(fontsDir, 'zh.ttf'));
  if (await exists(path.join(fontsDir, 'emoji.woff2'))) fontPaths.emoji = toFileUrl(path.join(fontsDir, 'emoji.woff2'));
  else if (await exists(path.join(fontsDir, 'emoji.ttf'))) fontPaths.emoji = toFileUrl(path.join(fontsDir, 'emoji.ttf'));

  const styleCSS = defaultStyleCSS(style, fontPaths);
  const scriptTags = await resolveScriptTags(penv);
  const html = htmlTemplate(markdown, { width, height, styleCSS, scriptTags, fitRatio: 0.9, maxScale: 2.0 });
  
  const outPngAbs = toAbs(outputFile);
  await fs.mkdir(path.dirname(outPngAbs), { recursive: true });
  const tempHtml = path.join(path.dirname(outPngAbs), `temp-${Date.now()}.html`);
  
  let browser;
  try {
    await fs.writeFile(tempHtml, html, 'utf-8');
    browser = await puppeteer.launch({ 
      headless: 'new', 
      args:['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files', '--disable-web-security'] 
    });
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto('file://' + toPosix(tempHtml), { waitUntil: 'domcontentloaded' });
    
    // 等待字体就绪标志
    await page.waitForFunction('window.__MARKMAP_READY__ === true', { timeout: 30000 });
    await new Promise(r => setTimeout(r, 600)); // 额外等待重绘
    
    await page.screenshot({ path: outPngAbs, clip: { x: 0, y: 0, width, height } });
  } finally {
    if (browser) await browser.close();
    try { await fs.unlink(tempHtml); } catch {}
  }
  return { abs: outPngAbs };
}

export default async function handler(args = {}, options = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return fail('prompt is required');

  try {
    const penv = options?.pluginEnv || {};
    const width = Math.min(8000, Number(args.width || 2400));
    const height = Math.min(6000, Number(args.height || 1600));
    const style = String(args.style || 'default');
    const rawName = path.basename(String(args.filename || 'weather_map.png'));
    const outputFile = path.join('artifacts', rawName);

    const resp = await chatCompletion({
      messages: [{ role: 'system', content: generateSystemPrompt() }, { role: 'user', content: prompt }],
      temperature: 0.2,
      omitMaxTokens: true
    });
    
    let content = resp.choices?.[0]?.message?.content?.trim() || '';
    content = content.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '').trim();

    // 强力清洗全角数字和空格
    content = content.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    content = content.replace(/\u3000/g, ' ');
    // 消除数字间的干扰空格
    content = content.replace(/(\d)\s+(?=\d|℃|C|:|%)/gi, '$1').replace(/(:)\s+(?=\d)/g, '$1');

    const image = await renderImage({ markdown: content, outputFile, width, height, style, penv });

    return ok({
      prompt,
      markdown_content: content,
      path_markdown: `![mindmap](${image.abs})`,
      width, height, style
    });
  } catch (e) {
    return fail(String(e));
  }
}
