import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import OpenAI from 'openai';
import { abs as toAbs } from '../../src/utils/path.js';
import { ok, fail } from '../../src/utils/result.js';

let _JSDOM;
let _Readability;

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
  const tool = 'web_parser';
  const base = {
    suggested_reply: '',
    next_steps: [],
    persona_hint: '你需要先解释抓取失败/内容不完整的原因，并给用户可执行的替代方案（提供 RSS、换链接、降低频率等）。',
    context: { tool, ...ctx },
  };
  if (kind === 'INVALID_URL') {
    return {
      ...base,
      suggested_reply: '这个 URL 看起来不合法。请提供完整链接（包含 http/https），或把浏览器地址栏里的链接完整复制给我。',
      next_steps: ['提供完整 URL（建议包含 https://）', '确认链接可在浏览器正常打开'],
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      ...base,
      suggested_reply: '抓取网页超时了。你可以稍后重试，或提供该站点的 RSS/站点地图链接以便更快获取内容。',
      next_steps: ['稍后重试', '提供 RSS/Atom 或 sitemap.xml', '降低抓取频率或缩短页面范围'],
    };
  }
  if (kind === 'BLOCKED') {
    return {
      ...base,
      suggested_reply: '目标站点返回的页面可能包含访问限制（例如需要启用 JavaScript、登录、或出现验证提示），导致无法直接提取正文。',
      next_steps: ['尝试换一个可公开访问的页面链接', '如该站提供 RSS/公开 API，优先使用', '如果页面需要登录，请提供可公开的镜像/摘要来源'],
    };
  }
  if (kind === 'VISION_TIMEOUT') {
    return {
      ...base,
      suggested_reply: '页面截图已成功获取，但读图识别超时了。你仍然可以先使用 DOM 抽取的正文；或稍后重试读图识别。',
      next_steps: ['先使用 DOM 抽取结果继续处理', '稍后重试读图识别（vision）', '缩短页面/降低截图分辨率再试'],
    };
  }
  if (kind === 'VISION_ERR') {
    return {
      ...base,
      suggested_reply: '页面截图已成功获取，但读图识别发生异常。你仍然可以先使用 DOM 抽取的正文；或调整 vision 模型/参数再试。',
      next_steps: ['检查 VISION_API_KEY / VISION_BASE_URL / VISION_MODEL 配置', '先使用 DOM 抽取结果继续处理', '如页面文字很小，尝试提高视口或截图质量'],
    };
  }
  return {
    ...base,
    suggested_reply: '抓取网页时发生异常。我可以根据报错调整页面等待策略、资源拦截、或开启截图/读图来提高稳定性，然后再重试。',
    next_steps: ['把目标链接和报错信息发给我', '尝试调整 waitStrategy', '必要时开启 screenshot 或 vision 再试'],
  };
}

function bufferToDataUri(buf, mime = 'image/png') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  return `data:${mime};base64,${b.toString('base64')}`;
}

function safeSlug(s) {
  return String(s || '')
    .trim()
    .replace(/https?:\/\//gi, '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

async function saveWebParserArtifacts({ baseDir, prefix, html, screenshotBuf, screenshotExt, debug }) {
  const outDir = toAbs(baseDir || 'artifacts');
  await fs.mkdir(outDir, { recursive: true });
  const stamp = Date.now();
  const base = `${prefix || 'web'}_${stamp}`;

  const out = { dir: toPosix(outDir), html: null, screenshot: null, debug: null };
  if (typeof html === 'string' && html) {
    const p = path.join(outDir, `${base}.html`);
    await fs.writeFile(p, html, 'utf-8');
    out.html = toPosix(p);
  }
  if (Buffer.isBuffer(screenshotBuf) && screenshotBuf.length) {
    const ext = String(screenshotExt || '.png');
    const p = path.join(outDir, `${base}${ext.startsWith('.') ? ext : `.${ext}`}`);
    await fs.writeFile(p, screenshotBuf);
    out.screenshot = toPosix(p);
  }
  if (debug && typeof debug === 'object') {
    const p = path.join(outDir, `${base}.json`);
    await fs.writeFile(p, JSON.stringify(debug, null, 2), 'utf-8');
    out.debug = toPosix(p);
  }
  return out;
}

function extractTextFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // OpenAI-compatible multimodal may return an array of content parts
    return content
      .map((p) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (typeof p?.text === 'string') return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
  }
  return '';
}

async function runVisionOnScreenshot({ dataUri, prompt, model, apiKey, baseURL, maxTokens }) {
  const items = [{ type: 'text', text: String(prompt || '').trim() || '请提取截图中的主要可读内容。' }];
  items.push({ type: 'image_url', image_url: { url: dataUri } });
  const messages = [{ role: 'user', content: items }];

  const clientOpts = { apiKey };
  if (baseURL) clientOpts.baseURL = baseURL;
  const oai = new OpenAI(clientOpts);
  const payload = { model, messages };
  const mt = Number(maxTokens);
  if (Number.isFinite(mt) && mt > 0) payload.max_tokens = mt;
  const res = await oai.chat.completions.create(payload);
  const raw = res?.choices?.[0]?.message?.content;
  return String(extractTextFromMessageContent(raw) || '').trim();
}

function processUrl(input) {
  try {
    let url = String(input || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    // throws on invalid
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

function resolveBool(v, def = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  return def;
}

function toInt(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }

function normalizeOpenAIBaseURL(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const u = s.replace(/\/+$/g, '');
  if (/\/v\d+$/i.test(u)) return u;
  return `${u}/v1`;
}

function sanitizeDebugUrl(raw) {
  const u = String(raw || '');
  if (!u) return '';
  if (/^data:/i.test(u)) return 'data:(omitted)';
  const maxLen = 260;
  const qPos = u.indexOf('?');
  if (qPos !== -1 && qPos < maxLen) {
    const base = u.slice(0, qPos);
    if (base.length > maxLen) return base.slice(0, maxLen - 1) + '…';
    return base + '?…';
  }
  if (u.length > maxLen) return u.slice(0, maxLen - 1) + '…';
  return u;
}

function resolveConfig(args, pluginEnv = {}, defaultTimeoutMs = 30000) {
  const envTimeout = Number(pluginEnv.WEB_PARSER_TIMEOUT ?? process.env.WEB_PARSER_TIMEOUT);
  const envMaxLen = Number((pluginEnv.WEB_PARSER_MAX_CONTENT_LENGTH ?? process.env.WEB_PARSER_MAX_CONTENT_LENGTH) || (pluginEnv.WEB_PARSER_MAX_BYTES ?? process.env.WEB_PARSER_MAX_BYTES));
  const ua = args?.ua || args?.userAgent || pluginEnv.WEB_PARSER_USER_AGENT || process.env.WEB_PARSER_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 SentraWebParser/1.0.0';
  const uaPlatform = args?.uaPlatform || pluginEnv.WEB_PARSER_UA_PLATFORM || process.env.WEB_PARSER_UA_PLATFORM || undefined;
  let uaMetadata;
  try {
    const rawUaMeta = args?.uaMetadata || pluginEnv.WEB_PARSER_UA_METADATA || process.env.WEB_PARSER_UA_METADATA;
    if (rawUaMeta) uaMetadata = JSON.parse(String(rawUaMeta));
  } catch {}
  const useProxy = resolveBool(pluginEnv.WEB_PARSER_USE_PROXY ?? process.env.WEB_PARSER_USE_PROXY, false);
  const proxyServer = pluginEnv.WEB_PARSER_PROXY_SERVER || process.env.WEB_PARSER_PROXY_SERVER || '';
  const viewportWidth = toInt(pluginEnv.WEB_PARSER_VIEWPORT_WIDTH ?? process.env.WEB_PARSER_VIEWPORT_WIDTH, 1366);
  const viewportHeight = toInt(pluginEnv.WEB_PARSER_VIEWPORT_HEIGHT ?? process.env.WEB_PARSER_VIEWPORT_HEIGHT, 768);
  const maxRetries = Math.max(1, toInt(pluginEnv.WEB_PARSER_MAX_RETRIES ?? process.env.WEB_PARSER_MAX_RETRIES, 2));
  const retryDelay = Math.max(500, toInt(pluginEnv.WEB_PARSER_RETRY_DELAY ?? process.env.WEB_PARSER_RETRY_DELAY, 2000));

  const enableReadability = resolveBool(pluginEnv.WEB_PARSER_ENABLE_READABILITY ?? process.env.WEB_PARSER_ENABLE_READABILITY, true);
  const readabilityMaxHtmlBytes = Math.max(50_000, toInt(pluginEnv.WEB_PARSER_READABILITY_MAX_HTML_BYTES ?? process.env.WEB_PARSER_READABILITY_MAX_HTML_BYTES, 800_000));

  const screenshotFullPage = resolveBool(pluginEnv.WEB_PARSER_SCREENSHOT_FULLPAGE ?? process.env.WEB_PARSER_SCREENSHOT_FULLPAGE, true);
  const screenshotType = String(pluginEnv.WEB_PARSER_SCREENSHOT_TYPE || process.env.WEB_PARSER_SCREENSHOT_TYPE || 'png').toLowerCase();
  const screenshotQuality = toInt(pluginEnv.WEB_PARSER_SCREENSHOT_QUALITY ?? process.env.WEB_PARSER_SCREENSHOT_QUALITY, 80);
  const screenshotMaxMbRaw = pluginEnv.WEB_PARSER_SCREENSHOT_MAX_MB ?? process.env.WEB_PARSER_SCREENSHOT_MAX_MB;
  const screenshotMaxMb = Number(screenshotMaxMbRaw);
  const screenshotMaxBytes = Math.max(
    50_000,
    Number.isFinite(screenshotMaxMb) && screenshotMaxMb > 0
      ? Math.floor(screenshotMaxMb * 1024 * 1024)
      : toInt(pluginEnv.WEB_PARSER_SCREENSHOT_MAX_BYTES ?? process.env.WEB_PARSER_SCREENSHOT_MAX_BYTES, 12 * 1024 * 1024)
  );
  const screenshotMaxHeightPx = Math.max(2000, toInt(pluginEnv.WEB_PARSER_SCREENSHOT_MAX_HEIGHT_PX ?? process.env.WEB_PARSER_SCREENSHOT_MAX_HEIGHT_PX, 16000));
  const screenshotReturnDataUri = resolveBool(pluginEnv.WEB_PARSER_SCREENSHOT_RETURN_DATA_URI ?? process.env.WEB_PARSER_SCREENSHOT_RETURN_DATA_URI, false);

  const visionEnabled = resolveBool(pluginEnv.WEB_PARSER_VISION ?? process.env.WEB_PARSER_VISION, false);
  const screenshotEnabled = resolveBool(pluginEnv.WEB_PARSER_SCREENSHOT ?? process.env.WEB_PARSER_SCREENSHOT, false) || visionEnabled;
  const visionApiKey = String(pluginEnv.WEB_PARSER_VISION_API_KEY || process.env.WEB_PARSER_VISION_API_KEY || pluginEnv.VISION_API_KEY || process.env.VISION_API_KEY || config.llm.apiKey || '');
  const visionBaseURL = normalizeOpenAIBaseURL(pluginEnv.WEB_PARSER_VISION_BASE_URL || process.env.WEB_PARSER_VISION_BASE_URL || pluginEnv.VISION_BASE_URL || process.env.VISION_BASE_URL || config.llm.baseURL || '');
  const visionModel = String(pluginEnv.WEB_PARSER_VISION_MODEL || process.env.WEB_PARSER_VISION_MODEL || pluginEnv.VISION_MODEL || process.env.VISION_MODEL || config.llm.model || '');

  const rawVisionMaxTokens = pluginEnv.WEB_PARSER_VISION_MAX_TOKENS ?? process.env.WEB_PARSER_VISION_MAX_TOKENS;
  const visionMaxTokens = (rawVisionMaxTokens === undefined || rawVisionMaxTokens === null || String(rawVisionMaxTokens).trim() === '' || String(rawVisionMaxTokens).trim() === '-1')
    ? (String(rawVisionMaxTokens).trim() === '-1' ? -1 : 800)
    : toInt(rawVisionMaxTokens, 800);
  const visionPrompt = String(pluginEnv.WEB_PARSER_VISION_PROMPT || process.env.WEB_PARSER_VISION_PROMPT || '请根据截图提取网页的主要可读内容（尽量保留段落结构），忽略导航栏、页脚、按钮、广告和重复元素。').trim();

  const waitStrategy = ((pluginEnv.WEB_PARSER_WAIT_STRATEGY ?? process.env.WEB_PARSER_WAIT_STRATEGY) || 'auto').toLowerCase();
  const maxTotalWaitMs = Math.max(1000, toInt(pluginEnv.WEB_PARSER_MAX_TOTAL_WAIT ?? process.env.WEB_PARSER_MAX_TOTAL_WAIT, 15000));
  const netIdleIdleMs = Math.max(200, toInt(pluginEnv.WEB_PARSER_NETWORK_IDLE_IDLE_MS ?? process.env.WEB_PARSER_NETWORK_IDLE_IDLE_MS, 800));
  const domStableSampleMs = Math.max(100, toInt(pluginEnv.WEB_PARSER_DOM_STABLE_SAMPLE_MS ?? process.env.WEB_PARSER_DOM_STABLE_SAMPLE_MS, 500));
  const domStableSamples = Math.max(2, toInt(pluginEnv.WEB_PARSER_DOM_STABLE_SAMPLES ?? process.env.WEB_PARSER_DOM_STABLE_SAMPLES, 4));
  const scrollSteps = Math.max(0, toInt(pluginEnv.WEB_PARSER_SCROLL_STEPS ?? process.env.WEB_PARSER_SCROLL_STEPS, 6));
  const scrollStepPx = Math.max(200, toInt(pluginEnv.WEB_PARSER_SCROLL_STEP_PX ?? process.env.WEB_PARSER_SCROLL_STEP_PX, 1200));
  const scrollDelayMs = Math.max(50, toInt(pluginEnv.WEB_PARSER_SCROLL_DELAY_MS ?? process.env.WEB_PARSER_SCROLL_DELAY_MS, 250));
  const loadingPatternsVal = (pluginEnv.WEB_PARSER_LOADING_PATTERNS ?? process.env.WEB_PARSER_LOADING_PATTERNS) || 'loading,加载中,请稍候,正在加载,请稍后,please wait,正在编译,processing,spinner';
  const loadingPatterns = Array.isArray(loadingPatternsVal) ? loadingPatternsVal : String(loadingPatternsVal).split(',');
  const loadingPatternsNorm = loadingPatterns.map((s) => String(s).trim()).filter(Boolean);
  const minGoodLen = Math.max(50, toInt(pluginEnv.WEB_PARSER_MIN_GOOD_LEN ?? process.env.WEB_PARSER_MIN_GOOD_LEN, 200));
  const blockTypesVal = (pluginEnv.WEB_PARSER_BLOCK_TYPES ?? process.env.WEB_PARSER_BLOCK_TYPES) || 'image,font,media';
  const blockTypesList = Array.isArray(blockTypesVal) ? blockTypesVal : String(blockTypesVal).split(',');
  const blockTypes = new Set(blockTypesList.map((s) => String(s).trim()).filter(Boolean));
  const waitSelector = String(pluginEnv.WEB_PARSER_WAIT_FOR_SELECTOR || process.env.WEB_PARSER_WAIT_FOR_SELECTOR || '').trim();
  const readyExpression = pluginEnv.WEB_PARSER_READY_EXPRESSION || process.env.WEB_PARSER_READY_EXPRESSION || '';
  const blockUrlVal = pluginEnv.WEB_PARSER_BLOCK_URL_PATTERNS || process.env.WEB_PARSER_BLOCK_URL_PATTERNS || '';
  const blockUrlPatterns = (Array.isArray(blockUrlVal) ? blockUrlVal : String(blockUrlVal).split(',')).map((s)=>String(s).trim()).filter(Boolean);

  const artifactsDir = String(pluginEnv.WEB_PARSER_ARTIFACTS_DIR || process.env.WEB_PARSER_ARTIFACTS_DIR || 'artifacts');
  const saveArtifacts = resolveBool(pluginEnv.WEB_PARSER_SAVE_ARTIFACTS ?? process.env.WEB_PARSER_SAVE_ARTIFACTS, false);
  const saveArtifactsOnEmpty = resolveBool(pluginEnv.WEB_PARSER_SAVE_ARTIFACTS_ON_EMPTY ?? process.env.WEB_PARSER_SAVE_ARTIFACTS_ON_EMPTY, true);

  const timeout = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : defaultTimeoutMs;
  const maxBytes = Number.isFinite(envMaxLen) && envMaxLen > 0 ? envMaxLen : 200000;

  return { timeout, maxBytes, ua, uaPlatform, uaMetadata, useProxy, proxyServer, viewportWidth, viewportHeight, maxRetries, retryDelay,
    waitStrategy, maxTotalWaitMs, netIdleIdleMs, domStableSampleMs, domStableSamples, scrollSteps, scrollStepPx, scrollDelayMs,
    loadingPatterns: loadingPatternsNorm, minGoodLen, blockTypes, waitSelector, readyExpression, blockUrlPatterns,
    enableReadability, readabilityMaxHtmlBytes,
    screenshotEnabled, screenshotFullPage, screenshotType, screenshotQuality, screenshotMaxBytes, screenshotMaxHeightPx, screenshotReturnDataUri,
    visionEnabled, visionApiKey, visionBaseURL, visionModel, visionMaxTokens, visionPrompt,
    artifactsDir, saveArtifacts, saveArtifactsOnEmpty };
}

function extractFromHtml(html) {
  try {
    // Strip scripts/styles/comments and tags
    let cleaned = String(html || '')
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    const titleMatch = cleaned.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // Prefer main/article blocks
    const mainMatch = cleaned.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
    const scope = mainMatch ? mainMatch[1] : (cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || cleaned);

    const text = scope
      .replace(/<[^>]+>/g, ' ') // drop tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    return { title, text, metadata: {} };
  } catch {
    return { title: '', text: '', metadata: {} };
  }
}

async function extractWithReadability(html) {
  try {
    if (!_JSDOM) {
      const mod = await import('jsdom');
      _JSDOM = mod?.JSDOM;
    }
    if (!_Readability) {
      const mod = await import('@mozilla/readability');
      _Readability = mod?.Readability;
    }
    if (!_JSDOM || !_Readability) return null;
    const dom = new _JSDOM(html);
    const article = new _Readability(dom.window.document).parse();
    if (article) {
      const title = (article.title || '').trim();
      const text = (article.textContent || '').replace(/\s+/g, ' ').trim();
      return { title, text, metadata: { by: 'readability' } };
    }
  } catch {}
  return null;
}

function extractMetaQuick(html) {
  const src = String(html || '');
  const pick = (re) => {
    const m = src.match(re);
    return m ? String(m[1] || '').trim() : '';
  };
  const ogTitle = pick(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || pick(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const desc = pick(/name=["']description["'][^>]*content=["']([^"']+)["']/i) || pick(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  const canonical = pick(/rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  const published = pick(/property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i);
  return { ogTitle, desc, canonical, published };
}

function postCleanText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const l of lines) {
    const norm = l.replace(/\s+/g, ' ');
    if (norm.length < 2) continue;
    // Drop obvious boilerplate lines
    if (/^(cookie|cookies|隐私|隐私政策|privacy|terms|免责声明|subscribe|订阅|登录|注册|sign in|sign up)/i.test(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.join('\n');
}

async function extractSmart(html, cfg = {}) {
  const meta = extractMetaQuick(html);
  const useReadability = cfg?.enableReadability !== false;
  const maxHtmlBytes = Number.isFinite(cfg?.readabilityMaxHtmlBytes) ? cfg.readabilityMaxHtmlBytes : 800_000;
  if (useReadability && String(html || '').length <= maxHtmlBytes) {
    const r = await extractWithReadability(html);
    if (r && r.text) {
      const title = r.title || meta.ogTitle || '';
      const text = postCleanText(r.text);
      return { title, text, metadata: { ...meta, ...r.metadata } };
    }
  }
  const basic = extractFromHtml(html);
  return { title: basic.title || meta.ogTitle || '', text: postCleanText(basic.text), metadata: { ...meta, ...basic.metadata } };
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function waitNetworkIdle(page, { idleMs = 800, timeout = 10000 } = {}) {
  let inflight = 0; let last = Date.now();
  const inc = () => { inflight++; last = Date.now(); };
  const dec = () => { inflight = Math.max(0, inflight - 1); last = Date.now(); };
  page.on('request', inc);
  page.on('requestfinished', dec);
  page.on('requestfailed', dec);
  try {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (inflight === 0 && Date.now() - last >= idleMs) return true;
      await sleep(100);
    }
    return false;
  } finally {
    page.off('request', inc);
    page.off('requestfinished', dec);
    page.off('requestfailed', dec);
  }
}

async function waitDomStable(page, { sampleMs = 500, stableSamples = 4, timeout = 10000 } = {}) {
  const start = Date.now();
  let last = null; let stable = 0;
  while (Date.now() - start < timeout) {
    const cur = await page.evaluate(() => {
      const body = document.body;
      const len = body ? (body.innerText || '').length : 0;
      const nodes = document.querySelectorAll('*').length;
      return { len, nodes };
    });
    if (last && cur.len === last.len && cur.nodes === last.nodes) {
      stable += 1;
      if (stable >= stableSamples) return true;
    } else {
      stable = 0;
    }
    last = cur;
    await sleep(sampleMs);
  }
  return false;
}

async function scrollToBottom(page, { steps = 6, stepPx = 1200, delayMs = 250 } = {}) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate((y) => window.scrollBy(0, y), stepPx);
    await sleep(delayMs);
  }
}

function hasLoadingPhrases(text, patterns = []) {
  const s = String(text || '').toLowerCase();
  return patterns.some((p) => p && s.includes(String(p).toLowerCase()));
}

async function tryPuppeteer(url, cfg) {
  const { timeout, ua, uaPlatform, uaMetadata, waitSelector, viewportWidth, viewportHeight, useProxy, proxyServer, maxRetries, retryDelay,
    waitStrategy, maxTotalWaitMs, netIdleIdleMs, domStableSampleMs, domStableSamples, scrollSteps, scrollStepPx, scrollDelayMs,
    loadingPatterns, minGoodLen, blockTypes, readyExpression, blockUrlPatterns, enableReadability, readabilityMaxHtmlBytes,
    screenshotEnabled, screenshotFullPage, screenshotType, screenshotQuality, screenshotMaxBytes, screenshotMaxHeightPx, screenshotReturnDataUri,
    visionEnabled, artifactsDir, saveArtifacts, saveArtifactsOnEmpty } = cfg;
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer'));
  } catch {
    throw new Error('puppeteer not installed');
  }

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor,BlinkGenPropertyTrees',
    '--disable-extensions-http-throttling',
    '--disable-component-extensions-with-background-pages',
    `--window-size=${viewportWidth},${viewportHeight}`,
  ];
  if (useProxy && proxyServer) launchArgs.push(`--proxy-server=${proxyServer}`);
  if (ua) launchArgs.push(`--user-agent=${ua}`);

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let browser;
    try {
      logger.debug?.('web_parser:puppeteer', { attempt, url });
      const launchOpts = { headless: 'new', timeout: Math.min(timeout, 60000), ignoreHTTPSErrors: true, args: launchArgs };
      // Windows tweaks
      if (process.platform === 'win32') {
        launchOpts.args.push('--disable-gpu-sandbox');
      }
      // Linux tweaks
      if (process.platform === 'linux') {
        launchOpts.args.push('--no-zygote','--single-process');
      }
      browser = await puppeteer.launch(launchOpts);
      const page = await browser.newPage();

      const debug = {
        url,
        attempt,
        finalUrl: null,
        documentTitle: null,
        mainResponse: null,
        requestFailed: [],
        requestAborted: [],
        pageErrors: [],
        console: [],
      };

      const pushLimited = (arr, item, max = 50) => {
        if (!Array.isArray(arr)) return;
        if (arr.length >= max) return;
        arr.push(item);
      };

      page.on('pageerror', (e) => pushLimited(debug.pageErrors, String(e?.message || e)));
      page.on('console', (msg) => {
        try {
          pushLimited(debug.console, { type: msg.type?.(), text: msg.text?.() });
        } catch {}
      });
      page.on('requestfailed', (req) => {
        try {
          pushLimited(debug.requestFailed, {
            url: sanitizeDebugUrl(req.url?.() || ''),
            type: req.resourceType?.(),
            errorText: req.failure?.()?.errorText || 'unknown'
          });
        } catch {}
      });

      await page.setViewport({ width: viewportWidth, height: viewportHeight });
      try {
        await page.setUserAgent({ userAgent: ua, userAgentMetadata: uaMetadata, platform: uaPlatform });
      } catch {
        await page.setUserAgent(ua);
      }
      await page.setDefaultNavigationTimeout(timeout);
      await page.setDefaultTimeout(timeout);
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      });

      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const rt = req.resourceType();
        const u = req.url();
        let blockedByType = blockTypes.has(rt);
        // When screenshot/vision is enabled, blocking stylesheets commonly yields blank/skeleton screenshots.
        if ((screenshotEnabled || visionEnabled) && rt === 'stylesheet') blockedByType = false;
        // When vision is enabled, allow images/fonts so the screenshot is visually meaningful.
        if (visionEnabled && (rt === 'image' || rt === 'font')) blockedByType = false;
        const blockedByPattern = blockUrlPatterns.some((s) => s && u.includes(s));
        const blockedByAds = /analytics|tracking|ads/i.test(u);
        if (blockedByType || blockedByPattern || blockedByAds) {
          try {
            pushLimited(debug.requestAborted, {
              url: sanitizeDebugUrl(u || ''),
              type: rt,
              reason: blockedByType ? 'type' : (blockedByPattern ? 'pattern' : 'ads'),
            });
          } catch {}
          req.abort();
        } else {
          req.continue();
        }
      });

      const mainResp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      try {
        debug.finalUrl = page.url();
      } catch {}
      try {
        debug.documentTitle = await page.title();
      } catch {}
      try {
        if (mainResp) {
          debug.mainResponse = {
            url: mainResp.url?.(),
            status: mainResp.status?.(),
            statusText: mainResp.statusText?.(),
            headers: mainResp.headers?.(),
          };
        }
      } catch {}
      try { await page.waitForFunction(() => document.readyState === 'complete', { timeout: Math.min(timeout, 10000) }); } catch {}

      const start = Date.now();
      const remain = () => Math.max(0, maxTotalWaitMs - (Date.now() - start));

      // Auto wait strategy: network idle -> scroll -> DOM stable -> optional selector
      if (waitStrategy === 'auto' || waitStrategy === 'network_idle') {
        if (remain() > 0) await waitNetworkIdle(page, { idleMs: netIdleIdleMs, timeout: Math.min(10000, remain()) });
      }
      if ((waitStrategy === 'auto' || waitStrategy === 'scroll') && remain() > 0) {
        await scrollToBottom(page, { steps: scrollSteps, stepPx: scrollStepPx, delayMs: scrollDelayMs });
      }
      if (waitStrategy === 'auto' || waitStrategy === 'dom_stable') {
        if (remain() > 0) await waitDomStable(page, { sampleMs: domStableSampleMs, stableSamples: domStableSamples, timeout: Math.min(10000, remain()) });
      }
      if (waitSelector && remain() > 0) {
        try { await page.waitForSelector(waitSelector, { timeout: Math.min(8000, remain()) }); } catch {}
      }
      if (readyExpression && remain() > 0) {
        try { await page.waitForFunction(readyExpression, { timeout: Math.min(8000, remain()) }); } catch {}
      }

      // Optional screenshot (after waits, before extraction)
      let screenshot = null;
      let screenshotBuf = null;
      let screenshotExt = '.png';
      if (screenshotEnabled) {
        try {
          const type = (screenshotType === 'jpeg' || screenshotType === 'jpg') ? 'jpeg' : (screenshotType === 'webp' ? 'webp' : 'png');
          screenshotExt = type === 'jpeg' ? '.jpg' : (type === 'webp' ? '.webp' : '.png');
          // Prefer fullPage for vision OCR when possible; will be guarded by max height and fallback.
          let useFullPage = !!screenshotFullPage || !!visionEnabled;
          if (useFullPage && Number.isFinite(screenshotMaxHeightPx) && screenshotMaxHeightPx > 0) {
            try {
              const h = await page.evaluate(() => {
                const de = document.documentElement;
                const b = document.body;
                return Math.max(de?.scrollHeight || 0, b?.scrollHeight || 0, de?.offsetHeight || 0, b?.offsetHeight || 0);
              });
              if (Number.isFinite(Number(h)) && Number(h) > screenshotMaxHeightPx) {
                useFullPage = false;
                logger.debug?.('web_parser:screenshot_fullpage_skip_too_tall', { url, heightPx: Number(h), maxHeightPx: screenshotMaxHeightPx });
              }
            } catch {}
          }

          if (!useFullPage) {
            try {
              await page.evaluate(() => window.scrollTo(0, 0));
              await sleep(200);
            } catch {}
          }

          let shot;
          try {
            shot = await page.screenshot({
              fullPage: useFullPage,
              type,
              quality: (type === 'jpeg' || type === 'webp') ? Math.min(100, Math.max(1, Number(screenshotQuality) || 80)) : undefined,
              captureBeyondViewport: true,
            });
          } catch (e) {
            const msg = String(e?.message || e);
            if (useFullPage && /Page is too large/i.test(msg)) {
              logger.warn?.('web_parser:screenshot_fullpage_too_large_fallback', { url, error: msg });
              try {
                await page.evaluate(() => window.scrollTo(0, 0));
                await sleep(200);
              } catch {}
              shot = await page.screenshot({
                fullPage: false,
                type,
                quality: (type === 'jpeg' || type === 'webp') ? Math.min(100, Math.max(1, Number(screenshotQuality) || 80)) : undefined,
                captureBeyondViewport: true,
              });
            } else {
              throw e;
            }
          }
          const buf = Buffer.from(shot);
          screenshotBuf = buf;
          if (buf.length <= screenshotMaxBytes) {
            const shouldKeepDataUri = screenshotReturnDataUri || visionEnabled;
            screenshot = {
              mime: `image/${type}`,
              bytes: buf.length,
              dataUri: shouldKeepDataUri ? bufferToDataUri(buf, `image/${type}`) : null,
            };
          } else {
            screenshot = { mime: `image/${type}`, bytes: buf.length, dataUri: null, skipped: true, reason: `screenshot too large (${buf.length} > ${screenshotMaxBytes})` };
          }
        } catch (e) {
          logger.warn?.('web_parser:screenshot_failed', { url, error: String(e?.message || e) });
        }
      }

      const html = await page.content();
      let { title, text, metadata } = await extractSmart(html, { enableReadability, readabilityMaxHtmlBytes });
      // If low-quality content, try one more scroll and stability wait within remaining time
      if ((text.length < minGoodLen || hasLoadingPhrases(text, loadingPatterns)) && remain() > 0) {
        await scrollToBottom(page, { steps: Math.ceil(scrollSteps / 2), stepPx: scrollStepPx, delayMs: scrollDelayMs });
        if (remain() > 0) await waitDomStable(page, { sampleMs: domStableSampleMs, stableSamples: domStableSamples, timeout: Math.min(8000, remain()) });
        const html2 = await page.content();
        const ex2 = await extractSmart(html2, { enableReadability, readabilityMaxHtmlBytes });
        if (ex2 && (ex2.text || '').length >= text.length) ({ title, text, metadata } = ex2);
      }
      const finalTitle = String(title || debug.documentTitle || '').trim();
      if (!finalTitle && debug.documentTitle) debug.documentTitle = String(debug.documentTitle);

      const empty = !finalTitle && !String(text || '').trim();
      const suspectScreenshot = screenshotEnabled && (!screenshotBuf || screenshotBuf.length < 12000);
      let artifacts = null;
      if ((saveArtifacts || (saveArtifactsOnEmpty && (empty || suspectScreenshot))) && (html || screenshotBuf || debug)) {
        try {
          const prefix = `web_parser_${safeSlug(debug.finalUrl || url)}`;
          artifacts = await saveWebParserArtifacts({
            baseDir: artifactsDir,
            prefix,
            html,
            screenshotBuf,
            screenshotExt,
            debug
          });
        } catch (e) {
          logger.warn?.('web_parser:save_artifacts_failed', { url, error: String(e?.message || e) });
        }
      }

      return {
        method: 'puppeteer',
        title: finalTitle,
        text,
        metadata,
        screenshot,
        artifacts,
        debug: {
          finalUrl: debug.finalUrl,
          mainResponse: debug.mainResponse,
          requestFailed: debug.requestFailed,
          requestAborted: debug.requestAborted,
        }
      };
    } catch (e) {
      lastErr = e;
      logger.warn?.('web_parser:puppeteer attempt failed', { attempt, error: String(e?.message || e) });
      if (attempt < maxRetries) await sleep(retryDelay * attempt);
    } finally {
      try {
        const closeP = browser?.close();
        await Promise.race([closeP, sleep(2000)]);
      } catch {}
    }
  }
  throw lastErr || new Error('puppeteer failed');
}

export default async function webParserHandler(args, options = {}) {
  const urls = Array.isArray(args?.urls) ? args.urls : [];
  if (urls.length) {
    const results = [];
    for (const u of urls) {
      const resp = await webParserHandler({
        ...args,
        urls: undefined,
        url: u,
      }, options);
      results.push({
        input: String(u ?? ''),
        success: !!resp?.success,
        code: resp?.code,
        data: resp?.data,
        error: resp?.error,
        advice: resp?.advice,
      });
    }
    const anyOk = results.some((r) => r.success);
    if (anyOk) return ok({ mode: 'batch', results });
    return fail('所有网页解析均失败', 'BATCH_FAILED', { detail: { mode: 'batch', results } });
  }

  const url = processUrl(args?.url);
  if (!url) return fail('URL格式无效', 'INVALID_URL', { advice: buildAdvice('INVALID_URL') });

  const prompt = String(args?.prompt || '').trim();
  if (!prompt) {
    return fail('prompt 为必填参数：请说明你希望从该网页获取什么/解决什么问题', 'MISSING_PROMPT', {
      advice: buildAdvice('ERR', { url })
    });
  }

  const penv = options.pluginEnv || {};
  // Derive an overall plugin budget from executor or plugin env, then allocate sub-budgets
  const pluginBudgetMs = Math.max(5000, Number(options.timeoutMs) || Number(penv.PLUGIN_TIMEOUT_MS) || 30000);
  const navTimeoutDefault = Math.max(2500, Math.floor(pluginBudgetMs * 0.45));
  const cfg = resolveConfig({
    ...args,
    maxTotalWaitMs: Math.max(1000, Math.floor(pluginBudgetMs * 0.35))
  }, penv, navTimeoutDefault);
  // If total budget is small (e.g., 25s executor timeout), avoid multiple long retries
  if (pluginBudgetMs <= 25000) {
    cfg.maxRetries = Math.min(cfg.maxRetries, 1);
    cfg.retryDelay = Math.min(cfg.retryDelay, 1000);
  }
  logger.debug?.('web_parser:budget', { pluginBudgetMs, navTimeout: cfg.timeout, maxTotalWaitMs: cfg.maxTotalWaitMs, maxRetries: cfg.maxRetries });

  let result = null;
  let errorPuppeteer = null;
  try {
    result = await tryPuppeteer(url, cfg);
  } catch (e) {
    errorPuppeteer = e;
  }

  if (!result) {
    const err = errorPuppeteer || new Error('无法获取页面');
    const isTimeout = isTimeoutError(err);
    const msg = String(err?.message || err);
    const blocked = /403|forbidden|denied|captcha|cloudflare/i.test(msg);
    return fail(err, isTimeout ? 'TIMEOUT' : (blocked ? 'BLOCKED' : 'FETCH_FAILED'), {
      advice: buildAdvice(isTimeout ? 'TIMEOUT' : (blocked ? 'BLOCKED' : 'ERR'), { url }),
    });
  }

  // Truncate text by maxBytes (char-based)
  let text = result.text || '';
  if (text.length > cfg.maxBytes) {
    text = text.slice(0, cfg.maxBytes) + `\n...[截断 ${text.length - cfg.maxBytes} 字符]`;
  }

  let visionText = '';
  let vision = { success: false, code: 'DISABLED', error: 'WEB_PARSER_VISION 未启用' };
  if (result.method === 'puppeteer' && cfg.visionEnabled) {
    if (!cfg.visionApiKey) {
      vision = { success: false, code: 'NO_VISION_CONFIG', error: '未配置 vision API Key（请设置 WEB_PARSER_VISION_API_KEY / VISION_API_KEY 或全局 llm.apiKey）' };
    } else if (!String(cfg.visionModel || '').trim()) {
      vision = { success: false, code: 'NO_VISION_MODEL', error: '未配置 vision 模型（请设置 WEB_PARSER_VISION_MODEL / VISION_MODEL 或全局 llm.model）' };
    } else {
      const shotUri = result?.screenshot?.dataUri;
      if (!shotUri) {
        vision = { success: false, code: 'NO_SCREENSHOT', error: '未获取到可用截图（可能过大或截图失败）' };
      } else {
        try {
          const v = await runVisionOnScreenshot({
            dataUri: shotUri,
            prompt,
            model: cfg.visionModel,
            apiKey: cfg.visionApiKey,
            baseURL: cfg.visionBaseURL,
            maxTokens: cfg.visionMaxTokens,
          });
          visionText = v;
          if (!String(v || '').trim()) {
            vision = { success: false, code: 'EMPTY', model: cfg.visionModel, error: 'vision 返回为空字符串' };
          } else {
            vision = { success: true, model: cfg.visionModel, text_length: v.length };
          }
        } catch (e) {
          const isTimeout = isTimeoutError(e);
          const msg = String(e?.message || e);
          vision = { success: false, code: isTimeout ? 'TIMEOUT' : 'ERR', error: msg };
          logger.warn?.('web_parser:vision_failed', { url, error: msg });
        }
      }
    }
  }

  const screenshot = result?.screenshot
    ? {
        ...result.screenshot,
        dataUri: cfg.screenshotReturnDataUri ? result.screenshot.dataUri : null,
      }
    : null;

  const data = {
    url,
    method: result.method,
    title: result.title,
    text,
    visionText,
    metadata: result.metadata,
    screenshot,
    vision,
    artifacts: result.artifacts || null,
    debug: result.debug || null,
    puppeteerError: errorPuppeteer ? String(errorPuppeteer.message || errorPuppeteer) : undefined,
  };

  return ok(data);
}
