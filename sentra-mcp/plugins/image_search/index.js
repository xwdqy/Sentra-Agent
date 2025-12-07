import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { decode } from 'html-entities';
import qs from 'qs';
import archiver from 'archiver';
import logger from '../../src/logger/index.js';
import { abs as toAbs } from '../../src/utils/path.js';

function toMarkdownPath(abs) {
  const label = path.basename(abs);
  const mdPath = String(abs).replace(/\\/g, '/');
  return `![${label}](${mdPath})`;
}

/**
 * 判断字符串是否为空
 */
function isStrEmpty(x) {
  return (!x && x !== 0 && x !== false) || x === "null";
}

/**
 * 归一化可选字符串参数（空串视为 null）
 */
function normalizeOptionalString(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * 移除对象中的空值
 */
function removeEmptyObject(x) {
  if (Array.isArray(x)) return x;
  
  return Object.keys(x)
    .filter(key => {
      const value = x[key];
      return value || value === "" || value === 0 || value === false;
    })
    .reduce((acc, key) => {
      return { ...acc, [key]: x[key] };
    }, {});
}

/**
 * 生成签名
 * @param {Object} params - 要签名的参数对象
 * @param {string} secretKey - 密钥（可选，默认使用内置密钥）
 * @returns {Object} 包含原始参数和sign字段的对象
 */
function generateSign(params = {}, secretKey = "d9fd3ec394") {
  try {
    // 深拷贝并移除空值
    const cleanedParams = JSON.parse(JSON.stringify(removeEmptyObject(params)));
    
    // 对键进行排序
    const sortedKeys = Object.keys(cleanedParams).sort();
    
    // 构建只包含非对象类型值的对象
    const processedParams = {};
    sortedKeys.forEach(key => {
      const value = cleanedParams[key];
      // 只处理非对象类型的值
      if (typeof value !== "object") {
        const strValue = value?.toString()?.trim() || "";
        processedParams[key] = strValue;
      }
    });
    
    // 转换为查询字符串（不进行URL编码）
    let queryString = qs.stringify(processedParams, {
      encode: false,
      filter: (prefix, value) => {
        // 过滤空值
        if (!isStrEmpty(value)) {
          return value;
        }
      }
    });
    
    // 追加密钥
    queryString += `&key=${secretKey}`;
    
    // 生成MD5哈希并转为大写
    const sign = crypto.createHash('md5').update(queryString).digest('hex').toUpperCase();
    
    logger.debug?.('sign:generated', { 
      label: 'PLUGIN',
      queryString: queryString.substring(0, 100) + '...',
      sign: sign.substring(0, 16) + '...'
    });
    
    // 返回包含原始参数和sign的对象
    return {
      ...cleanedParams,
      sign
    };
  } catch (e) {
    logger.error?.('sign:generation_failed', { label: 'PLUGIN', error: String(e?.message || e) });
    throw new Error(`签名生成失败: ${e.message}`);
  }
}

/**
 * 计算请求头中的timestamp
 * 格式: ${秒级时间戳}${校验码}
 * 校验码 = (时间戳 ^ 334) % 1000，补齐3位
 */
function computeTimestamp(overscan = 0) {
  const timestamp = parseInt(((Date.now() + overscan) / 1000).toString(), 10);
  const checksum = ((timestamp ^ 334) % 1000).toString().padStart(3, '0');
  return `${timestamp}${checksum}`;
}

/**
 * Fisher-Yates 洗牌算法（原地修改）
 */
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 深度随机打乱算法
 * 策略：
 * 1. 随机3-5次混合打乱
 * 2. Fisher-Yates + 随机排序 + 随机反转 + 随机分段重组
 * 3. 最后再进行一次 Fisher-Yates
 */
function deepShuffle(array) {
  if (!array.length) return array;
  
  const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const shuffleCount = getRandomInt(3, 5);
  let results = [...array];
  
  for (let i = 0; i < shuffleCount; i++) {
    // Fisher-Yates 洗牌
    results = shuffleArray(results);
    
    // 随机排序
    results.sort(() => Math.random() - 0.5);
    
    // 随机反转
    if (Math.random() > 0.5) {
      results.reverse();
    }
    
    // 随机分段重组
    if (Math.random() > 0.5) {
      const splitIndex = Math.floor(results.length / 2);
      const firstHalf = results.slice(0, splitIndex);
      const secondHalf = results.slice(splitIndex);
      results = [...secondHalf, ...firstHalf];
    }
  }
  
  // 最后再进行一次 Fisher-Yates
  return shuffleArray(results);
}

/**
 * 智能筛选 + 深度随机打乱
 * 优先选择前60%高相关性图片，不足时补充后40%
 * 然后进行深度洗牌确保随机性
 */
function smartShuffleWithRelevance(array, needCount) {
  if (!array.length) return array;
  
  // 计算前60%的数量（高相关性区域）
  const highRelevanceCount = Math.ceil(array.length * 0.6);
  const highRelevance = array.slice(0, highRelevanceCount);
  const lowRelevance = array.slice(highRelevanceCount);
  
  let selected = [];
  
  // 优先从高相关性区域选取
  if (highRelevance.length >= needCount) {
    selected = highRelevance.slice(0, needCount);
  } else {
    selected = [...highRelevance];
    const remaining = needCount - selected.length;
    if (remaining > 0 && lowRelevance.length > 0) {
      selected.push(...lowRelevance.slice(0, remaining));
    }
  }
  
  // 对选中的图片进行深度洗牌
  return deepShuffle(selected);
}

/**
 * 带超时的 fetch 封装
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  
  try {
    const res = await fetch(url, { 
      ...options, 
      signal: controller.signal 
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error(`请求超时 (${timeoutMs}ms): ${url}`);
    }
    throw e;
  }
}

/**
 * 带重试的 fetch JSON
 */
async function fetchJsonWithRetry(url, options = {}, retries = 3, timeoutMs = 20000) {
  let lastError;
  
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      
      const json = await res.json();
      return json;
      
    } catch (e) {
      lastError = e;
      logger.warn?.('fetch:retry', { 
        label: 'PLUGIN', 
        attempt: i + 1, 
        maxRetries: retries,
        error: String(e?.message || e),
        url: url.substring(0, 100)
      });
      
      if (i < retries - 1) {
        // 指数退避：1s, 2s, 4s...
        const delay = Math.pow(2, i) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * 带重试的 fetch 文本
 */
async function fetchTextWithRetry(url, options = {}, retries = 3, timeoutMs = 20000) {
  let lastError;
  
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      
      const text = await res.text();
      return text;
      
    } catch (e) {
      lastError = e;
      logger.warn?.('fetch:retry_text', { 
        label: 'PLUGIN', 
        attempt: i + 1, 
        maxRetries: retries,
        error: String(e?.message || e),
        url: url.substring(0, 100)
      });
      
      if (i < retries - 1) {
        // 指数退避：1s, 2s, 4s...
        const delay = Math.pow(2, i) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * 从URL猜测文件扩展名
 */
function guessExtFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').pop() || '');
    const m = last.match(/\.[a-zA-Z0-9]{2,5}$/);
    return m ? m[0].toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * 从Content-Type获取扩展名
 */
function extFromContentType(ct) {
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/heic': '.heic',
    'image/heif': '.heif',
  };
  return map[ct] || '';
}

/**
 * 流式下载文件（带进度跟踪）
 */
async function downloadToFile(url, absPath, headers = {}, timeoutMs = 120000) {
  const res = await fetchWithTimeout(url, { headers }, timeoutMs);
  
  if (!res.ok) {
    throw new Error(`下载失败: HTTP ${res.status} ${res.statusText}`);
  }
  
  const ct = (res.headers?.get?.('content-type') || '').split(';')[0].trim();
  
  if (!res.body) {
    throw new Error('响应体为空');
  }
  
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  
  // 进度跟踪 Transform Stream
  let downloaded = 0;
  const logInterval = 2 * 1024 * 1024; // 2MB
  let lastLog = 0;
  
  const { Transform } = await import('node:stream');
  const progressTransform = new Transform({
    transform(chunk, encoding, callback) {
      downloaded += chunk.length;
      if (downloaded - lastLog >= logInterval) {
        logger.debug?.('download:progress', { 
          label: 'PLUGIN', 
          downloadedMB: (downloaded / 1024 / 1024).toFixed(2),
          file: path.basename(absPath)
        });
        lastLog = downloaded;
      }
      callback(null, chunk);
    }
  });
  
  await pipeline(
    res.body,
    progressTransform,
    fssync.createWriteStream(absPath)
  );
  
  return { size: downloaded, contentType: ct };
}

/**
 * 创建 ZIP 压缩包
 */
async function createZip(files, zipPath) {
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  
  return new Promise((resolve, reject) => {
    const output = fssync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    let totalSize = 0;
    
    output.on('close', () => {
      resolve({ size: archive.pointer(), path: zipPath });
    });
    
    archive.on('error', reject);
    output.on('error', reject);
    
    archive.on('progress', (progress) => {
      if (progress.fs.totalBytes - totalSize > 5 * 1024 * 1024) { // 每5MB记录一次
        totalSize = progress.fs.totalBytes;
        logger.debug?.('zip:progress', { 
          label: 'PLUGIN', 
          processedMB: (progress.fs.processedBytes / 1024 / 1024).toFixed(2),
          totalMB: (progress.fs.totalBytes / 1024 / 1024).toFixed(2)
        });
      }
    });
    
    archive.pipe(output);
    
    for (const file of files) {
      if (fssync.existsSync(file.path)) {
        archive.file(file.path, { name: path.basename(file.path) });
      }
    }
    
    archive.finalize();
  });
}

/**
 * 简单 HTML 实体解码（用于 Bing 搜索结果 JSON 片段）
 */
function decodeHtmlEntities(str) {
  if (!str) return '';
  try {
    return decode(String(str));
  } catch {
    return String(str);
  }
}

const BING_FILTERS = {
  imageType: {
    photo: '+filterui:photo-photo',
    clipart: '+filterui:photo-clipart',
    linedrawing: '+filterui:photo-linedrawing',
    animated: '+filterui:photo-animatedgif',
    transparent: '+filterui:photo-transparent',
  },
  size: {
    small: '+filterui:imagesize-small',
    medium: '+filterui:imagesize-medium',
    large: '+filterui:imagesize-large',
    wallpaper: '+filterui:imagesize-wallpaper',
    all: '',
  },
  color: {
    coloronly: '+filterui:color-color',
    bw: '+filterui:color-bw',
    red: '+filterui:color-red',
    orange: '+filterui:color-orange',
    yellow: '+filterui:color-yellow',
    green: '+filterui:color-green',
    teal: '+filterui:color-teal',
    blue: '+filterui:color-blue',
    purple: '+filterui:color-purple',
    pink: '+filterui:color-pink',
    white: '+filterui:color-white',
    gray: '+filterui:color-gray',
    black: '+filterui:color-black',
    brown: '+filterui:color-brown',
  },
  layout: {
    square: '+filterui:aspect-square',
    wide: '+filterui:aspect-wide',
    tall: '+filterui:aspect-tall',
  },
  freshness: {
    day: '+filterui:age-lt1440',
    week: '+filterui:age-lt10080',
    month: '+filterui:age-lt43200',
  },
  license: {
    share: '+filterui:license-L2_L3_L4_L5_L6_L7',
    sharecommercially: '+filterui:license-L2_L3_L4',
    modify: '+filterui:license-L2_L3_L5_L6',
    modifycommercially: '+filterui:license-L2_L3',
    public: '+filterui:license-L1',
  },
};

/**
 * 解析 Bing 图片搜索 HTML
 */
function parseBingImages(html, maxCount) {
  const images = [];
  const regex = /m=\s*"({[^"]+})"/g;
  let match;
  
  while ((match = regex.exec(html)) !== null) {
    try {
      const jsonStr = decodeHtmlEntities(match[1]);
      const data = JSON.parse(jsonStr);
      const originalUrl = data.murl || data.turl;
      if (!originalUrl) continue;
      images.push({
        source: 'bing',
        url: originalUrl,
        thumbnailUrl: data.turl || '',
        title: data.t || '',
        description: data.desc || '',
        sourceUrl: data.purl || '',
        width: data.expw || 0,
        height: data.exph || 0,
        md5: data.md5 || '',
        contentId: data.cid || '',
        mediaId: data.mid || '',
      });
      if (images.length >= maxCount) break;
    } catch {
      // 忽略解析错误
    }
  }
  
  // 去重
  const seen = new Set();
  const unique = [];
  for (const img of images) {
    const key = img.md5 || img.url;
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(img);
    }
  }
  return unique;
}

/**
 * Bing 图片搜索
 */
async function searchBingImages(query, count, options = {}) {
  const {
    first = 1,
    timeoutMs = 15000,
    retries = 3,
    headers = {},
    imageType = null,
    size = null,
    color = null,
    layout = null,
    freshness = null,
    license = null,
  } = options;
  
  try {
    const needCount = Math.max(1, count || 1);
    const perPageMax = needCount * 10;

    logger.info?.('bing:search_start', {
      label: 'PLUGIN',
      query,
      needCount,
      perPageMax,
      imageType: imageType || 'any',
      size: size || 'any',
    });

    const buildUrl = (firstVal) => {
      const urlObj = new URL('https://cn.bing.com/images/search');
      urlObj.searchParams.append('q', query);
      urlObj.searchParams.append('form', 'HDRSC3');
      urlObj.searchParams.append('first', String(firstVal));

      const qftParts = [];
      if (imageType && BING_FILTERS.imageType[imageType]) {
        qftParts.push(BING_FILTERS.imageType[imageType]);
      }
      if (size && BING_FILTERS.size[size]) {
        qftParts.push(BING_FILTERS.size[size]);
      }
      if (color && BING_FILTERS.color[color]) {
        qftParts.push(BING_FILTERS.color[color]);
      }
      if (layout && BING_FILTERS.layout[layout]) {
        qftParts.push(BING_FILTERS.layout[layout]);
      }
      if (freshness && BING_FILTERS.freshness[freshness]) {
        qftParts.push(BING_FILTERS.freshness[freshness]);
      }
      if (license && BING_FILTERS.license[license]) {
        qftParts.push(BING_FILTERS.license[license]);
      }
      if (qftParts.length) {
        urlObj.searchParams.append('qft', qftParts.join(''));
      }

      return urlObj.toString();
    };

    const fetchPage = async (firstVal) => {
      const url = buildUrl(firstVal);
      const html = await fetchTextWithRetry(
        url,
        {
          method: 'GET',
          headers: {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9',
            ...headers,
          },
        },
        retries,
        timeoutMs
      );

      return parseBingImages(html, perPageMax);
    };

    const allImages = [];

    // 第 1 页
    const page1 = await fetchPage(first);
    allImages.push(...page1);

    // 第 2 页（简单按 50 条一页估算偏移）
    const secondFirst = first + 50;
    const page2 = await fetchPage(secondFirst);
    allImages.push(...page2);

    // 跨页再去重
    const seen = new Set();
    const unique = [];
    for (const img of allImages) {
      const key = img.md5 || img.url;
      if (key && !seen.has(key)) {
        seen.add(key);
        unique.push(img);
      }
    }

    logger.info?.('bing:search_success', {
      label: 'PLUGIN',
      query,
      requested: needCount,
      parsed: unique.length,
      page1: page1.length,
      page2: page2.length,
    });

    const shuffled = smartShuffleWithRelevance(unique, needCount);
    return shuffled.slice(0, needCount);
  } catch (e) {
    logger.error?.('bing:search_failed', {
      label: 'PLUGIN',
      query,
      error: String(e?.message || e),
    });
    return [];
  }
}

/**
 * 搜图神器壁纸搜索 API
 */
async function searchWallpapers(query, count, options = {}) {
  const {
    timeoutMs = 15000,
    retries = 3,
    page = 0,
    searchMode = 'ACCURATE_SEARCH',
    sort = '0'
  } = options;
  
  try {
    logger.info?.('wallpaper:search_start', { 
      label: 'PLUGIN', 
      query, 
      count, 
      page,
      searchMode 
    });
    
    // 构建请求参数
    const baseParams = {
      product_id: '52',
      version_code: '29116',
      page: String(page),
      search_word: query,
      maxWidth: '99999',
      minWidth: '0',
      maxHeight: '99999',
      minHeight: '0',
      searchMode: searchMode,
      sort: sort
    };
    
    // 生成签名
    const signedParams = generateSign(baseParams);
    
    // 构建表单数据
    const formBody = Object.keys(signedParams)
      .map(key => {
        const value = signedParams[key];
        return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      })
      .join('&');
    
    // 生成时间戳
    const timestamp = computeTimestamp();
    
    // 发送请求
    const data = await fetchJsonWithRetry(
      'https://wallpaper.soutushenqi.com/v1/wallpaper/list',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'accept': 'application/json',
          'timestamp': timestamp,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: formBody
      },
      retries,
      timeoutMs
    );
    
    // 检查响应
    if (!data || data.code !== 200) {
      throw new Error(`API返回错误: ${data?.message || data?.error_msg || 'Unknown'}`);
    }
    
    if (!data.data || !Array.isArray(data.data)) {
      logger.warn?.('wallpaper:empty_result', { label: 'PLUGIN', query });
      return [];
    }
    
    // 提取并过滤有效的图片URL
    const imageUrls = data.data
      .filter(item => {
        // 过滤掉低质量图片（fw480是缩略图标识）
        return item.largeUrl && !item.largeUrl.includes('fw480');
      })
      .map(item => ({
        url: item.largeUrl,
        source: 'wallpaper',
        id: item.id || crypto.randomUUID(),
        title: item.title || query,
        tags: item.tags || [],
        width: item.width || 0,
        height: item.height || 0,
      }));
    
    const uniqueUrls = Array.from(
      new Map(imageUrls.map(item => [item.url, item])).values()
    );
    
    const result = uniqueUrls.slice(0, count);
    
    logger.info?.('wallpaper:search_success', { 
      label: 'PLUGIN', 
      query,
      total: data.data.length,
      filtered: imageUrls.length,
      unique: uniqueUrls.length,
      returned: result.length
    });
    
    return result;
    
  } catch (e) {
    logger.error?.('wallpaper:search_failed', { 
      label: 'PLUGIN', 
      query,
      error: String(e?.message || e),
      stack: e?.stack
    });
    return [];
  }
}

/**
 * Unsplash 搜索 API
 */
async function searchUnsplash(query, count, options = {}) {
  const {
    accessKey,
    timeoutMs = 20000,
    retries = 3,
    headers = {}
  } = options;
  
  if (!accessKey || accessKey === 'YOUR_ACCESS_KEY_HERE') {
    logger.warn?.('unsplash:no_key', { label: 'PLUGIN' });
    return [];
  }
  
  try {
    logger.info?.('unsplash:search_start', { 
      label: 'PLUGIN', 
      query, 
      count
    });
    
    const params = new URLSearchParams({
      query,
      per_page: String(Math.min(count, 30)), // API限制
      client_id: accessKey,
    });
    
    const url = `https://api.unsplash.com/search/photos?${params.toString()}`;
    
    const data = await fetchJsonWithRetry(
      url,
      { headers: { ...headers, 'Accept-Version': 'v1' } },
      retries,
      timeoutMs
    );
    
    if (!Array.isArray(data?.results)) {
      throw new Error('Invalid Unsplash API response');
    }
    
    const results = data.results.slice(0, count).map(photo => ({
      ...photo,
      source: 'unsplash',
      url: photo.urls?.regular || photo.urls?.full,
    }));
    
    logger.info?.('unsplash:search_success', { 
      label: 'PLUGIN', 
      query,
      total: data.total,
      returned: results.length
    });
    
    return results;
    
  } catch (e) {
    logger.error?.('unsplash:search_failed', { 
      label: 'PLUGIN', 
      query,
      error: String(e?.message || e)
    });
    return [];
  }
}

export default async function handler(args = {}, options = {}) {
  const query = String(args.query || '').trim();
  const count = Number(args.count || 0);
  
  // 参数验证
  if (!query) {
    return { 
      success: false, 
      code: 'INVALID_PARAM', 
      error: 'query参数是必需的' 
    };
  }
  
  if (!count || count < 1) {
    return { 
      success: false, 
      code: 'INVALID_PARAM', 
      error: 'count参数必须是大于0的整数' 
    };
  }
  
  // 环境配置
  const penv = options?.pluginEnv || {};
  const accessKey = String(penv.UNSPLASH_ACCESS_KEY || process.env.UNSPLASH_ACCESS_KEY || '');
  const hasUnsplashKey = accessKey && accessKey !== 'YOUR_ACCESS_KEY_HERE';
  
  const baseDir = String(penv.UNSPLASH_BASE_DIR || process.env.UNSPLASH_BASE_DIR || 'artifacts');
  const maxCount = Number(penv.UNSPLASH_MAX_COUNT || process.env.UNSPLASH_MAX_COUNT || 10);
  const zipThreshold = Number(penv.UNSPLASH_ZIP_THRESHOLD || process.env.UNSPLASH_ZIP_THRESHOLD || 3);
  const quality = String(penv.UNSPLASH_QUALITY || process.env.UNSPLASH_QUALITY || 'regular');
  const fetchTimeoutMs = Number(penv.UNSPLASH_FETCH_TIMEOUT_MS || process.env.UNSPLASH_FETCH_TIMEOUT_MS || 20000);
  const downloadTimeoutMs = Number(penv.UNSPLASH_DOWNLOAD_TIMEOUT_MS || process.env.UNSPLASH_DOWNLOAD_TIMEOUT_MS || 120000);
  const concurrency = Math.max(1, Math.min(20, Number(penv.UNSPLASH_CONCURRENCY || process.env.UNSPLASH_CONCURRENCY || 5)));
  const userAgent = String(penv.UNSPLASH_USER_AGENT || process.env.UNSPLASH_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36');
  const retries = Math.max(1, Number(penv.UNSPLASH_RETRIES || process.env.UNSPLASH_RETRIES || 3));
  
  const finalCount = Math.min(count, maxCount);
  
  if (count > maxCount) {
    logger.info?.('count_limited', { 
      label: 'PLUGIN', 
      requestedCount: count, 
      maxCount, 
      actualCount: finalCount 
    });
  }
  
  // 解析 provider 顺序（仅来自环境变量 IMAGE_SEARCH_PROVIDERS，未配置则使用默认顺序，默认以 Bing 为第一源）
  let providers = [];
  const envProviders = String(penv.IMAGE_SEARCH_PROVIDERS || process.env.IMAGE_SEARCH_PROVIDERS || '').trim();
  if (envProviders) {
    providers = envProviders
      .split(',')
      .map(p => p.trim().toLowerCase())
      .filter(Boolean);
  }
  if (!providers.length) {
    providers = hasUnsplashKey ? ['bing', 'wallpaper', 'unsplash'] : ['bing', 'wallpaper'];
  }
  providers = providers.filter(p => ['bing', 'wallpaper', 'unsplash'].includes(p));
  if (!providers.length) {
    providers = hasUnsplashKey ? ['bing', 'wallpaper', 'unsplash'] : ['bing', 'wallpaper'];
  }
  // 去重保持顺序
  providers = [...new Set(providers)];

  // Bing 专用筛选参数（非法取值回退为默认）
  let bingImageType = normalizeOptionalString(args.bingImageType) || 'photo';
  const allowedImageTypes = Object.keys(BING_FILTERS.imageType || {});
  if (!allowedImageTypes.includes(bingImageType)) {
    logger.warn?.('bing:param_image_type_invalid', {
      label: 'PLUGIN',
      value: bingImageType,
    });
    bingImageType = 'photo';
  }
  let bingSize = normalizeOptionalString(args.bingSize) || 'wallpaper';
  const allowedSizes = Object.keys(BING_FILTERS.size || {});
  if (!allowedSizes.includes(bingSize)) {
    logger.warn?.('bing:param_size_invalid', {
      label: 'PLUGIN',
      value: bingSize,
    });
    bingSize = 'wallpaper';
  }
  const allowedColors = ['all', ...Object.keys(BING_FILTERS.color || {})];
  let bingColor = normalizeOptionalString(args.bingColor) || 'all';
  if (!allowedColors.includes(bingColor)) {
    logger.warn?.('bing:param_color_invalid', {
      label: 'PLUGIN',
      value: bingColor,
    });
    bingColor = 'all';
  }
  const allowedLayouts = ['all', ...Object.keys(BING_FILTERS.layout || {})];
  let bingLayout = normalizeOptionalString(args.bingLayout) || 'all';
  if (!allowedLayouts.includes(bingLayout)) {
    logger.warn?.('bing:param_layout_invalid', {
      label: 'PLUGIN',
      value: bingLayout,
    });
    bingLayout = 'all';
  }
  const allowedFreshness = ['all', ...Object.keys(BING_FILTERS.freshness || {})];
  let bingFreshness = normalizeOptionalString(args.bingFreshness) || 'all';
  if (!allowedFreshness.includes(bingFreshness)) {
    logger.warn?.('bing:param_freshness_invalid', {
      label: 'PLUGIN',
      value: bingFreshness,
    });
    bingFreshness = 'all';
  }
  const allowedLicenses = ['all', ...Object.keys(BING_FILTERS.license || {})];
  let bingLicense = normalizeOptionalString(args.bingLicense) || 'all';
  if (!allowedLicenses.includes(bingLicense)) {
    logger.warn?.('bing:param_license_invalid', {
      label: 'PLUGIN',
      value: bingLicense,
    });
    bingLicense = 'all';
  }

  const headers = {
    'user-agent': userAgent,
    'accept': 'application/json',
  };
  
  try {
    logger.info?.('handler:start', { 
      label: 'PLUGIN', 
      query, 
      requestedCount: count, 
      actualCount: finalCount, 
      hasUnsplashKey,
      providers
    });
    
    const allPhotos = [];
    
    for (const provider of providers) {
      const remaining = finalCount - allPhotos.length;
      if (remaining <= 0) break;
      
      if (provider === 'bing') {
        const bingHeaders = {
          'user-agent': userAgent,
        };
        const results = await searchBingImages(query, remaining, {
          timeoutMs: fetchTimeoutMs,
          retries,
          headers: bingHeaders,
          imageType: bingImageType,
          size: bingSize,
          color: bingColor !== 'all' ? bingColor : null,
          layout: bingLayout !== 'all' ? bingLayout : null,
          freshness: bingFreshness !== 'all' ? bingFreshness : null,
          license: bingLicense !== 'all' ? bingLicense : null,
        });
        allPhotos.push(...results);
      } else if (provider === 'wallpaper') {
        const results = await searchWallpapers(query, remaining, {
          timeoutMs: fetchTimeoutMs,
          retries
        });
        allPhotos.push(...results);
      } else if (provider === 'unsplash') {
        if (!hasUnsplashKey) {
          logger.info?.('skip_unsplash', { 
            label: 'PLUGIN', 
            message: 'Unsplash补充跳过（无API Key）',
            remaining 
          });
          continue;
        }
        const results = await searchUnsplash(query, remaining, {
          accessKey,
          timeoutMs: fetchTimeoutMs,
          retries,
          headers
        });
        allPhotos.push(...results);
      }
    }
    
    // 检查是否有结果
    if (!allPhotos.length) {
      return { 
        success: false, 
        code: 'NO_RESULT', 
        error: `未找到与 "${query}" 相关的图片` 
      };
    }
    
    // 统计来源
    const sourceStats = allPhotos.reduce((acc, p) => {
      acc[p.source] = (acc[p.source] || 0) + 1;
      return acc;
    }, {});
    
    logger.info?.('search:total_results', { 
      label: 'PLUGIN', 
      total: allPhotos.length, 
      sources: sourceStats 
    });
    
    const shuffledPhotos = smartShuffleWithRelevance(allPhotos, finalCount);
    
    logger.info?.('shuffle:complete', { 
      label: 'PLUGIN', 
      original: allPhotos.length,
      selected: shuffledPhotos.length 
    });
    
    const baseAbs = toAbs(baseDir);
    const sessionId = crypto.randomUUID().slice(0, 8);
    const sessionDir = path.join(baseAbs, `unsplash_${sessionId}`);
    await fs.mkdir(sessionDir, { recursive: true });
    
    logger.info?.('session:created', { 
      label: 'PLUGIN', 
      sessionId, 
      sessionDir 
    });
    
    logger.info?.('download:start', { 
      label: 'PLUGIN', 
      total: shuffledPhotos.length, 
      concurrency 
    });
    
    const downloadTasks = shuffledPhotos.map((photo, i) => {
      const photoId = photo.id || `photo_${i}`;
      const photoSource = photo.source || 'unknown';
      
      // 根据来源提取下载URL
      let downloadUrl;
      if (photoSource === 'wallpaper') {
        downloadUrl = photo.url;
      } else if (photoSource === 'unsplash') {
        const urlMap = {
          full: photo.urls?.full,
          regular: photo.urls?.regular,
          small: photo.urls?.small,
          thumb: photo.urls?.thumb,
        };
        downloadUrl = urlMap[quality] || photo.url || photo.urls?.regular || photo.urls?.full;
      } else {
        downloadUrl = photo.url || photo.urls?.regular;
      }
      
      if (!downloadUrl) {
        logger.warn?.('download:no_url', { 
          label: 'PLUGIN', 
          photoId, 
          index: i + 1, 
          source: photoSource 
        });
        return () => Promise.resolve(null);
      }
      
      let ext = guessExtFromUrl(downloadUrl) || '.jpg';
      let fileName = `${sessionId}_${String(i + 1).padStart(3, '0')}_${photoSource}_${photoId}${ext}`;
      let absPath = path.join(sessionDir, fileName);
      
      return async () => {
        try {
          logger.info?.('download:file_start', { 
            label: 'PLUGIN', 
            index: i + 1,
            total: shuffledPhotos.length,
            photoId, 
            source: photoSource 
          });
          
          const { size, contentType } = await downloadToFile(
            downloadUrl, 
            absPath, 
            headers, 
            downloadTimeoutMs
          );
          
          let finalPath = absPath;
          
          const ctExt = extFromContentType(contentType);
          if (ctExt && ctExt !== ext) {
            const newFileName = `${sessionId}_${String(i + 1).padStart(3, '0')}_${photoSource}_${photoId}${ctExt}`;
            const newPath = path.join(sessionDir, newFileName);
            try {
              await fs.rename(absPath, newPath);
              finalPath = newPath;
              ext = ctExt;
              fileName = newFileName;
            } catch (err) {
              logger.warn?.('download:rename_failed', { 
                label: 'PLUGIN', 
                index: i + 1, 
                photoId, 
                source: photoSource, 
                error: String(err?.message || err) 
              });
            }
          }
          
          logger.info?.('download:file_success', { 
            label: 'PLUGIN', 
            index: i + 1,
            total: shuffledPhotos.length,
            photoId, 
            source: photoSource, 
            sizeMB: (size / 1024 / 1024).toFixed(2),
            fileName
          });
          
          return {
            path: finalPath,
            path_markdown: toMarkdownPath(finalPath),
            size,
            contentType,
            photoId,
            source: photoSource,
            author: photo.user?.name || 'Unknown',
            author_url: photo.user?.links?.html || '',
            download_location: photo.links?.download_location || '',
            title: photo.title || photo.alt_description || query,
            width: photo.width || 0,
            height: photo.height || 0,
          };
        } catch (e) {
          logger.error?.('download:file_failed', { 
            label: 'PLUGIN', 
            index: i + 1,
            total: shuffledPhotos.length,
            photoId, 
            source: photoSource, 
            error: String(e?.message || e) 
          });
          return null;
        }
      };
    });
    
    // 并发执行下载任务
    const files = [];
    for (let i = 0; i < downloadTasks.length; i += concurrency) {
      const batch = downloadTasks.slice(i, i + concurrency);
      const batchNum = Math.floor(i / concurrency) + 1;
      const totalBatches = Math.ceil(downloadTasks.length / concurrency);
      
      logger.info?.('download:batch_start', { 
        label: 'PLUGIN', 
        batch: batchNum,
        totalBatches,
        batchSize: batch.length 
      });
      
      const results = await Promise.all(batch.map(task => task()));
      const successCount = results.filter(Boolean).length;
      
      logger.info?.('download:batch_complete', { 
        label: 'PLUGIN', 
        batch: batchNum,
        totalBatches,
        success: successCount,
        failed: batch.length - successCount
      });
      
      files.push(...results.filter(Boolean));
    }
    
    // 检查下载结果
    if (!files.length) {
      return { 
        success: false, 
        code: 'DOWNLOAD_FAILED', 
        error: '所有图片下载失败，请检查网络连接或稍后重试' 
      };
    }
    
    logger.info?.('download:complete', { 
      label: 'PLUGIN', 
      total: downloadTasks.length,
      success: files.length,
      failed: downloadTasks.length - files.length
    });
    
    const unsplashFiles = files.filter(f => f.source === 'unsplash' && f.download_location);
    if (unsplashFiles.length > 0) {
      logger.info?.('unsplash:trigger_downloads', { 
        label: 'PLUGIN', 
        count: unsplashFiles.length 
      });
      
      for (const file of unsplashFiles) {
        try {
          await fetchWithTimeout(
            file.download_location, 
            { headers: { ...headers, Authorization: `Client-ID ${accessKey}` } }, 
            5000
          );
        } catch (e) {
          logger.warn?.('unsplash:trigger_failed', { 
            label: 'PLUGIN', 
            photoId: file.photoId,
            error: String(e?.message || e)
          });
        }
      }
    }
    
    const downloadedSourceStats = files.reduce((acc, f) => {
      acc[f.source] = (acc[f.source] || 0) + 1;
      return acc;
    }, {});
    
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    
    logger.info?.('stats:final', { 
      label: 'PLUGIN', 
      totalFiles: files.length,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
      sources: downloadedSourceStats
    });
    
    const data = {
      action: 'unsplash_search',
      query,
      requested_count: count,
      actual_count: finalCount,
      downloaded: files.length,
      failed: shuffledPhotos.length - files.length,
      sources: downloadedSourceStats,
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      total_size: totalSize,
      total_size_mb: (totalSize / 1024 / 1024).toFixed(2),
    };
    
    if (files.length > zipThreshold) {
      logger.info?.('zip:start', { 
        label: 'PLUGIN', 
        fileCount: files.length, 
        threshold: zipThreshold 
      });
      
      const zipName = `images_${query.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}_${sessionId}.zip`;
      const zipPath = path.join(baseAbs, zipName);
      
      const { size: zipSize } = await createZip(files, zipPath);
      
      logger.info?.('zip:complete', { 
        label: 'PLUGIN', 
        zipSizeMB: (zipSize / 1024 / 1024).toFixed(2),
        compressionRatio: ((1 - zipSize / totalSize) * 100).toFixed(1) + '%'
      });
      
      const sourceInfo = Object.entries(downloadedSourceStats)
        .map(([k, v]) => `${k}:${v}张`)
        .join(', ');
      
      data.zip_path = zipPath;
      data.zip_path_markdown = toMarkdownPath(zipPath);
      data.zip_size = zipSize;
      data.zip_size_mb = (zipSize / 1024 / 1024).toFixed(2);
      data.compression_ratio = ((1 - zipSize / totalSize) * 100).toFixed(1) + '%';
      data.status = 'OK_ZIPPED';
      data.summary = `✅ 成功搜索并下载 ${files.length} 张关于 "${query}" 的图片（${sourceInfo}），已打包为 ZIP 文件（${(zipSize / 1024 / 1024).toFixed(2)}MB，压缩率 ${data.compression_ratio}）。`;
      data.notice = `📦 图片已打包为 ZIP，请解压查看。文件列表见 file_list 字段。`;
      data.file_list = files.map((f, i) => ({
        index: i + 1,
        filename: path.basename(f.path),
        source: f.source,
        size_mb: (f.size / 1024 / 1024).toFixed(2),
        title: f.title,
      }));
      
    } else {
      // 直接模式：返回每个文件的详细信息
      data.files = files.map((f, i) => ({
        index: i + 1,
        path: f.path,
        path_markdown: f.path_markdown,
        filename: path.basename(f.path),
        size: f.size,
        size_mb: (f.size / 1024 / 1024).toFixed(2),
        contentType: f.contentType,
        source: f.source,
        author: f.author,
        author_url: f.author_url,
        title: f.title,
        width: f.width,
        height: f.height,
      }));
      
      data.status = 'OK_DIRECT';
      
      const sourceInfo = Object.entries(downloadedSourceStats)
        .map(([k, v]) => `${k}:${v}张`)
        .join(', ');
      
      data.summary = `✅ 成功搜索并下载 ${files.length} 张关于 "${query}" 的图片（${sourceInfo}），已保存至本地。总大小：${(totalSize / 1024 / 1024).toFixed(2)}MB。`;
    }
    
    logger.info?.('handler:complete', { 
      label: 'PLUGIN', 
      status: data.status, 
      fileCount: files.length,
      query
    });
    
    return { success: true, data };
    
  } catch (e) {
    logger.error?.('handler:error', { 
      label: 'PLUGIN', 
      query,
      error: String(e?.message || e), 
      stack: e?.stack 
    });
    
    return { 
      success: false, 
      code: 'INTERNAL_ERROR', 
      error: String(e?.message || e),
      details: e?.stack 
    };
  }
}