// 将 HTML 字符串或本地文件渲染为图片的插件实现
// 基于 Puppeteer 最佳实践，支持智能等待、自定义样式注入、元素截图等功能
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../src/logger/index.js';
import { abs as toAbs, toPosix, toFileUrl } from '../../src/utils/path.js';
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
  const personaHint = '请结合你当前的预设/人设继续作答：当网页渲染截图失败时，要说明原因、给替代方案（换输入/修正路径/简化 HTML/稍后重试），并引导用户补充更可复现的信息。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我需要你提供要渲染的网页内容：要么给 html 字符串，要么给本地 file 路径。当前参数不完整，所以我没法开始截图。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 args.html（HTML 片段或完整页面）或 args.file（本地文件路径）',
        '如有样式/脚本可提供 css/js 字段（可选）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'UNSUPPORTED') {
    return {
      suggested_reply: '这个截图工具目前不支持 url 参数（只支持 html 或本地文件 file）。你把网页内容贴出来，或者把页面保存成 html 文件路径给我，我就能继续渲染截图。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '把网页保存为本地 .html 文件并传 file 路径',
        '或直接提供 html 字符串（支持片段）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'NO_PUPPETEER') {
    return {
      suggested_reply: '我这边无法启动渲染引擎（puppeteer 未安装或加载失败），所以暂时没法截图。我可以先帮你把 HTML/CSS 调整好，等环境就绪后再截图，或者换其他方式导出。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认运行环境已安装 puppeteer 依赖',
        '如果你只需要 HTML，我也可以先输出可直接打开的文件内容',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'FILE_NOT_FOUND') {
    return {
      suggested_reply: '我没找到你提供的本地文件路径，所以没法渲染截图。你确认一下路径是否存在、是否有权限访问，然后再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '检查 file 路径是否真实存在（建议用绝对路径）',
        '确认文件可读权限',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'SELECTOR_NOT_FOUND') {
    return {
      suggested_reply: '我已经打开页面了，但你给的 selector 没匹配到任何元素，所以没法按指定区域截图。你可以换一个更准确的选择器，或者让我先整页截图给你确认结构。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '先不传 selector，整页截图确认 DOM 结构',
        '提供更稳定的选择器（id/class/data-testid）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我在渲染截图时卡住了，像是加载/渲染超时了。我可以先按更保守的等待策略重试，或者你把页面内容简化后再截图。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试或简化 HTML（减少外链资源）',
        '把 wait_for 改成 load 或减少需要等待的资源',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试渲染网页并截图，但这次执行失败了。我可以帮你定位是哪段资源/脚本导致渲染失败，并给你一个更稳的渲染策略后再试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '提供更小的可复现 HTML 片段（最小复现）',
      '如果有外链资源加载失败，可以改成本地或内联',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

// 智能等待策略：根据页面类型自动选择合适的等待条件
async function smartWait(page, strategy = 'auto') {
  const strat = String(strategy || 'auto').toLowerCase();
  
  if (strat === 'load') {
    // 仅等待 load 事件，适合静态页面
    return;
  } else if (strat === 'networkidle') {
    // 等待网络空闲，适合有异步请求的页面
    try {
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 });
    } catch (e) {
      logger.debug?.('web_render_image:networkidle timeout, continuing', { error: String(e?.message || e) });
    }
  } else {
    // auto: 智能等待 - 先等 DOM ready，再等网络趋于稳定
    try {
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
    } catch {}
    try {
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 });
    } catch {}
  }
}

// 等待所有图片加载完成（包括 img、背景图、懒加载）
async function waitForImages(page, timeout = 15000) {
  try {
    await page.evaluate(async (timeoutMs) => {
      const start = Date.now();
      
      // 1. 获取所有 <img> 标签
      const imgs = Array.from(document.querySelectorAll('img'));
      
      // 2. 等待每个图片完成加载
      const promises = imgs.map((img) => {
        return new Promise((resolve) => {
          // 已经加载完成
          if (img.complete && img.naturalWidth > 0) {
            resolve();
            return;
          }
          
          // 监听加载完成或失败
          const onLoad = () => {
            img.removeEventListener('load', onLoad);
            img.removeEventListener('error', onError);
            resolve();
          };
          const onError = () => {
            img.removeEventListener('load', onLoad);
            img.removeEventListener('error', onError);
            resolve(); // 即使失败也继续，避免阻塞
          };
          
          img.addEventListener('load', onLoad);
          img.addEventListener('error', onError);
          
          // 超时保护
          setTimeout(() => {
            img.removeEventListener('load', onLoad);
            img.removeEventListener('error', onError);
            resolve();
          }, timeoutMs);
        });
      });
      
      // 3. 等待所有图片（带总超时）
      await Promise.race([
        Promise.all(promises),
        new Promise(resolve => setTimeout(resolve, timeoutMs))
      ]);
      
      const elapsed = Date.now() - start;
      return { loaded: imgs.length, elapsed };
    }, timeout);
  } catch (e) {
    logger.debug?.('web_render_image: waitForImages failed', { error: String(e?.message || e) });
  }
}

// 等待字体加载完成
async function waitForFonts(page, timeout = 5000) {
  try {
    await page.evaluate(async (timeoutMs) => {
      if (!document.fonts || typeof document.fonts.ready !== 'object') {
        return { status: 'unsupported' };
      }
      
      await Promise.race([
        document.fonts.ready,
        new Promise(resolve => setTimeout(resolve, timeoutMs))
      ]);
      
      return { status: 'loaded', count: document.fonts.size };
    }, timeout);
  } catch (e) {
    logger.debug?.('web_render_image: waitForFonts failed', { error: String(e?.message || e) });
  }
}

// 构建完整 HTML（处理片段、添加基础结构）
function buildFullHtml(htmlFragment) {
  const trimmed = String(htmlFragment || '').trim();
  if (!trimmed) return '';
  
  // 如果已经是完整 HTML，直接返回
  if (/<!doctype\s+html>/i.test(trimmed) && /<\/html>/i.test(trimmed)) {
    return trimmed;
  }
  
  // 片段补全为完整页面
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Render</title>
</head>
<body>
${trimmed}
</body>
</html>`;
}

// 将 HTML 中的本地绝对路径（如 E:\path\to\file.png 或 E:/path/to/file.png）
// 自动重写为 file:/// 协议，便于浏览器正确加载本地资源
function rewriteLocalPaths(html) {
  try {
    const replacer = (match, attr, quote, p) => {
      try {
        const raw = String(p).trim();
        // 已经是 URL 的情况，直接跳过。特殊处理 file://E:/... 规范化为 file:///E:/...
        if (/^(data:|blob:|file:|https?:|about:|javascript:|#|\/\/)/i.test(raw)) {
          if (/^file:\/\/[A-Za-z]:\//i.test(raw) && !/^file:\/\//i.test(raw.replace(/^file:\/\//i, 'file:///'))) {
            const fixed = raw.replace(/^file:\/\/(?=[A-Za-z]:\/)/i, 'file:///');
            return `${attr}=${quote}${fixed}${quote}`;
          }
          return match;
        }

        // 规范化分隔符，仅处理形如 C:/ 或 C:\ 起始的 Windows 盘符绝对路径
        const normalized = raw.replace(/\\/g, '/');
        if (/^[A-Za-z]:\//.test(normalized)) {
          const fileHref = toFileUrl(normalized);
          if (fileHref) return `${attr}=${quote}${fileHref}${quote}`;
        }
      } catch {}
      return match;
    };
    return String(html).replace(/\b(src|href)=(['"])([^'"]+)\2/gi, replacer);
  } catch {
    return html;
  }
}

export default async function handler(args = {}, options = {}) {
  let browser = null;
  let page = null;
  
  try {
    const penv = options?.pluginEnv || {};

    // === 1. 解析输入参数 ===
    const htmlRaw = String(args.html || '').trim();
    const file = String(args.file || '').trim();
    const css = String(args.css || '').trim();
    const js = String(args.js || '').trim();
    const selector = String(args.selector || '').trim();
    const fullPage = args.fullPage !== false; // 默认整页截图
    const wait_for = String(args.wait_for || 'auto').toLowerCase();

    // url 参数已不再支持
    if (typeof args.url === 'string' && args.url.trim()) {
      return fail('web_render_image 插件仅支持 html 或 file 参数，不再支持 url。', 'UNSUPPORTED', { advice: buildAdvice('UNSUPPORTED', { tool: 'web_render_image' }) });
    }

    // 至少提供 html 或 file 之一
    if (!htmlRaw && !file) {
      return fail('必须提供 html 或 file 参数之一', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'web_render_image' }) });
    }

    // === 2. 准备输出目录和文件名 ===
    const artifactsDir = toAbs('artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });
    
    const timestamp = Date.now();
    const fileName = `render_${timestamp}.png`;
    const outPath = path.join(artifactsDir, fileName);

    // === 3. 启动 Puppeteer（最新最佳实践）===
    let puppeteer;
    try {
      ({ default: puppeteer } = await import('puppeteer'));
    } catch (e) {
      return fail('puppeteer 未安装或加载失败', 'NO_PUPPETEER', { advice: buildAdvice('NO_PUPPETEER', { tool: 'web_render_image' }) });
    }

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--allow-file-access-from-files',
    ];
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: launchArgs,
      timeout: 30000,
      ignoreHTTPSErrors: true,
    });
    
    page = await browser.newPage();
    
    // 监听资源加载失败事件（用于调试）
    const failedResources = [];
    page.on('requestfailed', (request) => {
      const url = request.url();
      const failure = request.failure();
      failedResources.push({ url, reason: failure?.errorText || 'unknown' });
      logger.debug?.('web_render_image: 资源加载失败', { 
        url: url.slice(0, 100), 
        reason: failure?.errorText 
      });
    });
    
    // 自适应视口：默认 1366x768（适合大多数场景）
    await page.setViewport({
      width: 1366,
      height: 768,
      deviceScaleFactor: 2, // 2倍像素比，提升截图清晰度
    });

    // === 4. 加载页面内容 ===
    let fileUrl;
    if (htmlRaw) {
      // 渲染 HTML 字符串：写入临时文件并使用 file:// 打开，确保本地资源可访问
      const fullHtml = buildFullHtml(htmlRaw);
      const safeHtml = rewriteLocalPaths(fullHtml);
      const tempHtmlPath = path.join(artifactsDir, `render_${timestamp}.html`);
      await fs.writeFile(tempHtmlPath, safeHtml, 'utf-8');
      fileUrl = toFileUrl(tempHtmlPath);
    } else {
      // 加载本地文件
      const absFile = toAbs(file);
      const exists = await fs.stat(absFile).then(() => true).catch(() => false);
      if (!exists) {
        return fail(`文件不存在: ${absFile}`, 'FILE_NOT_FOUND', { advice: buildAdvice('FILE_NOT_FOUND', { tool: 'web_render_image', file: absFile }) });
      }
      fileUrl = toFileUrl(absFile);
    }
    
    // 🔥 统一使用 'load' 或 'networkidle2'，确保资源加载
    const waitUntil = wait_for === 'domcontentloaded' ? 'domcontentloaded' : (wait_for === 'networkidle' ? 'networkidle2' : 'load');
    await page.goto(fileUrl, {
      waitUntil,
      timeout: 30000,
    });

    // === 5. 注入自定义样式和脚本 ===
    if (css) {
      try {
        await page.addStyleTag({ content: css });
      } catch (e) {
        logger.warn?.('web_render_image: CSS 注入失败', { error: String(e?.message || e) });
      }
    }
    
    if (js) {
      try {
        await page.addScriptTag({ content: js });
      } catch (e) {
        logger.warn?.('web_render_image: JS 注入失败', { error: String(e?.message || e) });
      }
    }

    // === 6. 智能等待页面渲染完成 ===
    await smartWait(page, wait_for);
    
    // === 6.5. 等待图片和字体加载完成 ===
    await waitForImages(page, 15000);
    await waitForFonts(page, 5000);
    
    // 额外等待 500ms，确保渲染稳定
    await new Promise(resolve => setTimeout(resolve, 500));

    // === 7. 截图 ===
    if (selector) {
      // 截取指定元素
      const element = await page.$(selector);
      if (!element) {
        return fail(`选择器未匹配到元素: ${selector}`, 'SELECTOR_NOT_FOUND', { advice: buildAdvice('SELECTOR_NOT_FOUND', { tool: 'web_render_image', selector }) });
      }
      await element.screenshot({
        path: outPath,
        type: 'png',
      });
    } else {
      // 整页或视口截图
      await page.screenshot({
        path: outPath,
        type: 'png',
        fullPage,
      });
    }

    // === 8. 返回结果 ===
    const stat = await fs.stat(outPath);
    const absPosix = toPosix(outPath);
    const md = `![${path.basename(outPath)}](${absPosix})`;

    return ok({
      action: 'web_render_image',
      path_markdown: md,
      size_bytes: stat.size,
      format: 'png',
      viewport: { width: 1366, height: 768, scale: 2 },
      source: htmlRaw ? 'html' : 'file',
      failed_resources: failedResources.length > 0 ? failedResources : undefined,
    });
  } catch (e) {
    logger.error?.('web_render_image: 渲染失败', { label: 'PLUGIN', error: String(e?.message || e), stack: e?.stack });
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'RENDER_ERROR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'RENDER_ERROR', { tool: 'web_render_image' }) });
  } finally {
    // 确保资源清理（最佳实践）
    try {
      if (page) await page.close();
    } catch (e) {
      logger.debug?.('web_render_image: page.close() 失败', { error: String(e?.message || e) });
    }
    try {
      if (browser) await browser.close();
    } catch (e) {
      logger.debug?.('web_render_image: browser.close() 失败', { error: String(e?.message || e) });
    }
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
