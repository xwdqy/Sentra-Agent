// 将 HTML 字符串或本地文件渲染为图片的插件实现
// 基于 Puppeteer 最佳实践，支持智能等待、自定义样式注入、元素截图等功能
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../../src/logger/index.js';
import { abs as toAbs, toPosix, toFileUrl } from '../../src/utils/path.js';

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
      return { success: false, code: 'UNSUPPORTED', error: 'web_render_image 插件仅支持 html 或 file 参数，不再支持 url。' };
    }

    // 至少提供 html 或 file 之一
    if (!htmlRaw && !file) {
      return { success: false, code: 'INVALID', error: '必须提供 html 或 file 参数之一' };
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
      return { success: false, code: 'NO_PUPPETEER', error: 'puppeteer 未安装或加载失败' };
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
        return { success: false, code: 'FILE_NOT_FOUND', error: `文件不存在: ${absFile}` };
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
        return { success: false, code: 'SELECTOR_NOT_FOUND', error: `选择器未匹配到元素: ${selector}` };
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

    return {
      success: true,
      data: {
        action: 'web_render_image',
        path_markdown: md,
        size_bytes: stat.size,
        format: 'png',
        viewport: { width: 1366, height: 768, scale: 2 },
        source: htmlRaw ? 'html' : 'file',
        failed_resources: failedResources.length > 0 ? failedResources : undefined,
      },
    };
  } catch (e) {
    logger.error?.('web_render_image: 渲染失败', { label: 'PLUGIN', error: String(e?.message || e), stack: e?.stack });
    return {
      success: false,
      code: 'RENDER_ERROR',
      error: String(e?.message || e),
    };
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
