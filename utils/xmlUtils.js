/**
 * XML处理工具模块
 * 包含XML标签提取、JSON转XML、敏感信息过滤等功能
 */
import extractPathModule from 'extract-path';

const extractPath = extractPathModule.default || extractPathModule;

// 敏感字段列表
const SENSITIVE_KEYS = [
  'apikey', 'api_key', 'api-key', 'token', 'access_token', 'refresh_token', 'authorization',
  'cookie', 'cookies', 'set-cookie', 'password', 'secret', 'session', 'x-api-key'
];

// 用户消息中需要过滤的字段（避免冗余）
export const USER_QUESTION_FILTER_KEYS = [
  'segments', 'images', 'videos', 'files', 'records'
];

export function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttr(str) {
  return escapeXml(str).replace(/"/g, '&quot;');
}

export function unescapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * 检查是否为敏感字段
 */
export function isSensitiveKey(key = '') {
  return SENSITIVE_KEYS.includes(String(key).toLowerCase());
}

/**
 * 提取完整的XML标签（包含外层起止标签和属性）
 * @param {string} text - 包含 XML 标签的文本
 * @param {string} tagName - 标签名称
 * @returns {string|null} 完整标签字符串，未找到返回 null
 */
export function extractFullXMLTag(text, tagName) {
  if (!text || !tagName) return null;
  const regex = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\/${tagName}>`, 'i');
  const m = text.match(regex);
  return m ? m[0] : null;
}

/**
 * 提取所有完整的XML标签（包含外层起止标签和属性）
 * @param {string} text - 包含 XML 标签的文本
 * @param {string} tagName - 标签名称
 * @returns {Array<string>} 完整标签字符串数组
 */
export function extractAllFullXMLTags(text, tagName) {
  if (!text || !tagName) return [];
  const regex = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\/${tagName}>`, 'gi');
  const out = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    out.push(m[0]);
  }
  return out;
}

/**
 * 生成简单 XML 标签，不转义内容
 * - 在写入前会将常见 XML/HTML 实体（&lt;/&gt;/&amp; 等）还原为原始字符
 */
export function tag(name, val) {
  const raw = val == null ? '' : String(val);
  const v = unescapeXml(raw);
  return `<${name}>${v}</${name}>`;
}

/**
 * 数值格式化（默认两位小数）；非数值返回空串
 */
export function fmt(n, digits = 2) {
  if (n == null || Number.isNaN(Number(n))) return '';
  try { return Number(n).toFixed(digits); } catch { return String(n); }
}

/**
 * 检查是否需要在用户提问中过滤的字段
 */
export function shouldFilterInUserQuestion(key) {
  return USER_QUESTION_FILTER_KEYS.includes(String(key).toLowerCase());
}

/**
 * 将任意值转换为字符串（不进行XML转义）
 * 遵循 Sentra XML 协议：保留原始内容，避免影响 HTML/代码渲染
 * @param {*} value - 要转换的值
 * @param {number} depth - 当前递归深度
 * @param {number} maxDepth - 最大递归深度限制
 * @param {Set} seen - 用于检测循环引用的对象集合
 * @returns {string} 转换后的字符串（原始内容，不转义）
 */
export function valueToXMLString(value, depth = 0, maxDepth = 100, seen = new Set()) {
  // 只在极端情况下才限制深度（100层应该足够深了）
  if (depth > maxDepth) {
    return '[MAX_DEPTH_EXCEEDED]';
  }
  
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  
  const type = typeof value;
  
  if (type === 'string') {
    // 将常见 XML/HTML 实体还原为原始字符，再原样写入
    return unescapeXml(value);
  }
  
  if (type === 'number' || type === 'boolean') {
    return String(value);
  }
  
  if (type === 'function') {
    return '[Function]';
  }
  
  // 对于复杂对象，检测循环引用
  if (type === 'object' && value !== null) {
    // 循环引用检测
    if (seen.has(value)) {
      return '[Circular Reference]';
    }
    
    // 标记已访问
    const newSeen = new Set(seen);
    newSeen.add(value);
    
    // 返回完整JSON表示，不截断
    try {
      return JSON.stringify(value, (key, val) => {
        if (val && typeof val === 'object') {
          if (newSeen.has(val)) return '[Circular]';
          newSeen.add(val);
        }
        return val;
      });
    } catch (e) {
      return '[Non-Serializable]';
    }
  }
  
  // 其他类型直接转字符串
  return String(value);
}

/**
 * 递归将JSON对象转换为XML标签
 * @param {*} data - 要转换的数据
 * @param {number} indent - 缩进级别
 * @param {number} depth - 当前递归深度
 * @param {number} maxDepth - 最大递归深度限制
 * @param {Array<string>} filterKeys - 需要过滤的键名列表
 * @param {Set} seen - 用于检测循环引用的对象集合
 * @returns {Array<string>} XML行数组
 */
export function jsonToXMLLines(data, indent = 1, depth = 0, maxDepth = 100, filterKeys = [], seen = new Set()) {
  const lines = [];
  const indentStr = '  '.repeat(indent);
  
  // 只在极端情况下才限制深度（100层应该足够深了）
  if (depth > maxDepth) {
    lines.push(`${indentStr}<value>[MAX_DEPTH_EXCEEDED]</value>`);
    return lines;
  }
  
  // 循环引用检测
  if (data && typeof data === 'object' && seen.has(data)) {
    lines.push(`${indentStr}<value>[Circular Reference]</value>`);
    return lines;
  }
  
  if (data === null || data === undefined) {
    return lines;
  }
  
  // 处理数组
  if (Array.isArray(data)) {
    if (data.length === 0) return lines;
    
    // 标记已访问
    const newSeen = new Set(seen);
    newSeen.add(data);
    
    data.forEach((item, index) => {
      const type = typeof item;
      
      if (item === null || item === undefined) {
        lines.push(`${indentStr}<item index="${index}">null</item>`);
      } else if (type === 'string' || type === 'number' || type === 'boolean') {
        const value = valueToXMLString(item, depth, maxDepth, newSeen);
        lines.push(`${indentStr}<item index="${index}">${value}</item>`);
      } else if (Array.isArray(item) || type === 'object') {
        lines.push(`${indentStr}<item index="${index}">`);
        lines.push(...jsonToXMLLines(item, indent + 1, depth + 1, maxDepth, filterKeys, newSeen));
        lines.push(`${indentStr}</item>`);
      } else {
        lines.push(`${indentStr}<item index="${index}">${valueToXMLString(item, depth, maxDepth, newSeen)}</item>`);
      }
    });
    
    return lines;
  }
  
  // 处理对象
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    if (keys.length === 0) return lines;
    
    // 标记已访问
    const newSeen = new Set(seen);
    newSeen.add(data);
    
    keys.forEach(key => {
      // 过滤指定的键
      if (filterKeys.includes(key)) {
        return;
      }
      
      // 过滤敏感字段
      if (isSensitiveKey(key)) {
        lines.push(`${indentStr}<${key}>[REDACTED]</${key}>`);
        return;
      }
      
      const value = data[key];
      const type = typeof value;
      
      if (value === null) {
        lines.push(`${indentStr}<${key}>null</${key}>`);
      } else if (value === undefined) {
        // 跳过undefined字段
        return;
      } else if (type === 'string' || type === 'number' || type === 'boolean') {
        const xmlValue = valueToXMLString(value, depth, maxDepth, newSeen);
        lines.push(`${indentStr}<${key}>${xmlValue}</${key}>`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          lines.push(`${indentStr}<${key}></${key}>`);
        } else {
          lines.push(`${indentStr}<${key}>`);
          lines.push(...jsonToXMLLines(value, indent + 1, depth + 1, maxDepth, filterKeys, newSeen));
          lines.push(`${indentStr}</${key}>`);
        }
      } else if (type === 'object') {
        lines.push(`${indentStr}<${key}>`);
        lines.push(...jsonToXMLLines(value, indent + 1, depth + 1, maxDepth, filterKeys, newSeen));
        lines.push(`${indentStr}</${key}>`);
      } else {
        lines.push(`${indentStr}<${key}>${valueToXMLString(value, depth, maxDepth, newSeen)}</${key}>`);
      }
    });
    
    return lines;
  }
  
  // 基本类型
  lines.push(`${indentStr}<value>${valueToXMLString(data, depth, maxDepth, seen)}</value>`);
  return lines;
}

/**
 * 提取XML标签内容
 * @param {string} text - 包含 XML 标签的文本
 * @param {string} tagName - 标签名称
 * @param {Object} options - 选项
 * @param {boolean} options.trimResult - 是否 trim 结果（默认 true）
 * @param {boolean} options.removeCodeBlock - 是否移除 ```xml 代码块标记（默认 true）
 * @returns {string|null} 提取的内容，未找到返回 null
 */
export function extractXMLTag(text, tagName, options = {}) {
  const { trimResult = true, removeCodeBlock = true } = options;
  
  if (!text || !tagName) return null;
  
  // 预处理：移除可能的代码块标记
  let processedText = text;
  if (removeCodeBlock) {
    // 移除 ```xml ... ``` 或 ``` ... ```
    processedText = processedText.replace(/```(?:xml)?\s*([\s\S]*?)```/g, '$1');
  }
  
  // 尝试匹配：<tag>content</tag> 或 <tag>\ncontent\n</tag>
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = processedText.match(regex);
  
  if (!match) return null;
  
  let content = match[1];
  
  // 可选的 trim
  if (trimResult) {
    content = content.trim();
  }
  
  return content;
}

/**
 * 提取所有重复的XML标签
 * @param {string} text - 包含 XML 标签的文本
 * @param {string} tagName - 标签名称
 * @param {Object} options - 选项
 * @param {boolean} options.trimResult - 是否 trim 结果（默认 true）
 * @param {boolean} options.removeCodeBlock - 是否移除代码块标记（默认 true）
 * @returns {Array<string>} 提取的内容数组
 */
export function extractAllXMLTags(text, tagName, options = {}) {
  const { trimResult = true, removeCodeBlock = true } = options;
  
  if (!text || !tagName) return [];
  
  // 预处理
  let processedText = text;
  if (removeCodeBlock) {
    processedText = processedText.replace(/```(?:xml)?\s*([\s\S]*?)```/g, '$1');
  }
  
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const matches = [];
  let match;
  
  while ((match = regex.exec(processedText)) !== null) {
    let content = match[1];
    if (trimResult) {
      content = content.trim();
    }
    matches.push(content);
  }
  
  return matches;
}

/**
 * 提取文件路径（用于工具结果）
 */
export function extractFilesFromContent(data, basePath = []) {
  const files = [];
  if (!data || typeof data !== 'object') return files;
  
  const checkAndAdd = (value, key) => {
    if (typeof value !== 'string') return;
    const keyPath = [...basePath, key].join('.');
    const keyPathLower = keyPath.toLowerCase();
    // 跳过示例/样例字段，例如 toolMeta.responseExample
    if (keyPathLower.includes('responseexample')) return;
    const text = value;
    const trimmed = text.trim();

    if (!trimmed) return;

    // 只从 Markdown 形式的链接/图片中提取：![](...) 或 [](...)
    const mdRegex = /!\[[^\]]*\]\(([^)]+)\)|\[[^\]]*\]\(([^)]+)\)/g;

    const addCandidate = (rawCandidate) => {
      if (!rawCandidate) return;
      const candidate = String(rawCandidate).trim();
      if (!candidate) return;

      // http(s) 开头：直接作为 URL
      if (/^https?:\/\//i.test(candidate)) {
        files.push({ key: keyPath, path: candidate });
        return;
      }

      // 其他情况：作为潜在本地路径，交给 extract-path + 正则兜底
      let localPath = null;
      try {
        localPath = extractPath(candidate, {
          validateFileExists: false,
          resolveWithFallback: false
        });
      } catch {}

      if (!localPath) {
        // 简单兜底：Windows 盘符路径或 Unix 风格的 /dir/file.ext
        const m2 = candidate.match(/([A-Za-z]:[\\/][^*?"<>|]+?\.[A-Za-z0-9]{2,5}|\/(?:[^\s]+\/)*[^\s]+\.[A-Za-z0-9]{2,5})/);
        if (m2 && m2[1]) {
          localPath = m2[1];
        }
      }

      if (localPath && typeof localPath === 'string') {
        const normalized = localPath.trim();
        if (!normalized) return;
        files.push({ key: keyPath, path: normalized });
      }
    };

    let m;
    while ((m = mdRegex.exec(trimmed)) !== null) {
      // m[1] 对应 ![](...)，m[2] 对应 [](...)
      const candidate = m[1] ?? m[2];
      addCandidate(candidate);
    }
  };
  
  if (Array.isArray(data)) {
    data.forEach((item, i) => {
      if (typeof item === 'string') checkAndAdd(item, i);
      else files.push(...extractFilesFromContent(item, [...basePath, i]));
    });
  } else {
    Object.entries(data).forEach(([k, v]) => {
      if (typeof v === 'string') checkAndAdd(v, k);
      else if (v && typeof v === 'object') files.push(...extractFilesFromContent(v, [...basePath, k]));
    });
  }

  // 自动按 path 去重（优先保留第一次出现的 key）
  const seen = new Set();
  const unique = [];
  for (const f of files) {
    const p = (f && typeof f.path === 'string') ? f.path.trim() : '';
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(f);
  }
  
  return unique;
}
