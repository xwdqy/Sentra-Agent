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
        
        const finalizeRender = () => {
          setTimeout(() => { 
            try {
              mm.fit(${maxScale});
              const svgEl = document.getElementById('markmap');
              const g = svgEl?.querySelector('g');
              if (g) {
                const bbox = g.getBBox();
              }
            } catch (e) { 
               console.warn('MARKMAP_FIT_ERROR:', e); 
            }
            window.__MARKMAP_READY__ = true;
          }, 800);
        };

        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(finalizeRender).catch(finalizeRender);
        } else {
          finalizeRender();
        }

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

  // 1. Emoji 优先级最高
  if (fontPaths.emoji) fontFamilies.push("'LocalEmoji'");
  
  // 2. 本地中文字体拥有第二高优先级：让它彻底接管数字和字母，呈现原汁原味的哥特倾斜数字
  if (fontPaths.zh) fontFamilies.push("'LocalZh'");
  
  // 3. 兜底字体
  fontFamilies.push("Arial", "'Microsoft YaHei'", "sans-serif");

  const fontFamilyStr = fontFamilies.join(', ');

  // 去除多余的强制排版属性，尊重方正字体的原版设计
  const baseNodeStyle = `
    .markmap-node { 
      font-family: ${fontFamilyStr} !important; 
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
  const personaHint = '请结合你当前的预设/人设继续作答：当思维导图生成失败时，要说明失败原因，给替代方案。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我现在还没拿到要生成思维导图的主题/描述。你把主题和文件名发我一下，我就继续。',
      next_steps:['补充 prompt', '提供 filename（不含目录）'], persona_hint: personaHint, context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试帮你生成思维导图，但这次工具执行失败了。我可以先给你文本大纲，或稍后重试。',
    next_steps:['提供导图大纲供选择', '稍后重试'], persona_hint: personaHint, context: ctx,
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
  const emojiFontPathWoff2 = path.join(fontsDir, 'emoji.woff2');
  const emojiFontPathTtf = path.join(fontsDir, 'emoji.ttf');

  if (await exists(zhFontPathWoff2)) fontPaths.zh = toFileUrl(zhFontPathWoff2);
  else if (await exists(zhFontPathTtf)) fontPaths
