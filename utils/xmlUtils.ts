/**
 * XML处理工具模块
 * 包含XML标签提取、JSON转XML、敏感信息过滤等功能
 */
import extractPath from 'extract-path';
import { XMLParser } from 'fast-xml-parser';

let __xmlParser: XMLParser | undefined;
export function getFastXmlParser(): XMLParser {
  if (__xmlParser) return __xmlParser;
  __xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false
  });
  return __xmlParser;
}

export function tryParseXmlFragment(xmlFragment: unknown, rootTag: string = 'root'): unknown {
  const frag = typeof xmlFragment === 'string' ? xmlFragment : '';
  if (!frag.trim()) return null;
  const root = typeof rootTag === 'string' && rootTag.trim() ? rootTag.trim() : 'root';
  try {
    const wrapped = `<${root}>${frag}</${root}>`;
    const doc = getFastXmlParser().parse(wrapped);
    return doc && typeof doc === 'object' ? (doc as Record<string, unknown>)[root] : null;
  } catch {
    return null;
  }
}

export function tryParseXmlTag(text: unknown, tagName: unknown): unknown {
  const s = typeof text === 'string' ? text : '';
  const name = typeof tagName === 'string' ? tagName.trim() : '';
  if (!s || !name) return null;
  const full = extractFullXMLTag(s, name);
  if (!full) return null;
  const parsed = tryParseXmlFragment(full, 'root');
  if (!parsed || typeof parsed !== 'object') return null;
  return (parsed as Record<string, unknown>)[name] ?? null;
}

// 用户消息中需要过滤的字段（避免冗余）
export const USER_QUESTION_FILTER_KEYS = [
  'segments', 'images', 'videos', 'files', 'records'
];

export function escapeXml(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttr(str: unknown): string {
  return escapeXml(str).replace(/"/g, '&quot;');
}

export function unescapeXml(str: unknown): string {
  if (str == null) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function stripTypedValueWrapper(text: unknown): string {
  const s = String(text || '').trim();
  if (!s) return '';
  const m = s.match(/^<(string|number|boolean|null)>([\s\S]*?)<\/\1>$/i);
  if (!m) return s;
  return String(m[2] || '').trim();
}

export function extractXmlAttrValue(tagXml: unknown, attrName: unknown): string {
  if (!tagXml || typeof tagXml !== 'string') return '';
  const safe = String(attrName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\s${safe}="([^"]*)"`, 'i');
  const m = String(tagXml).match(re);
  return m && m[1] != null ? String(m[1]) : '';
}

export function extractInnerXmlFromFullTag(fullTagXml: unknown, tagName: unknown): string {
  if (!fullTagXml || typeof fullTagXml !== 'string') return '';
  const safe = String(tagName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(fullTagXml)
    .replace(new RegExp(`^<${safe}[^>]*>`, 'i'), '')
    .replace(new RegExp(`<\\/${safe}>\\s*$`, 'i'), '');
}

/**
 * 提取完整的XML标签（包含外层起止标签和属性）
 * @param {string} text - 包含 XML 标签的文本
 * @param {string} tagName - 标签名称
 * @returns {string|null} 完整标签字符串，未找到返回 null
 */
export function extractFullXMLTag(text: string, tagName: string): string | null {
  if (!text || !tagName) return null;
  const regex = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'i');
  const m = text.match(regex);
  return m ? m[0] : null;
}

/**
 * 提取所有完整的XML标签（包含外层起止标签和属性）
 * @param {string} text - 包含 XML 标签的文本
 * @param {string} tagName - 标签名称
 * @returns {Array<string>} 完整标签字符串数组
 */
export function extractAllFullXMLTags(text: string, tagName: string): string[] {
  if (!text || !tagName) return [];
  const regex = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\/${tagName}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    out.push(m[0]);
  }
  return out;
}

/**
 * 生成简单 XML 标签，不转义内容
 * - 在写入前会将常见 XML/HTML 实体（&lt;/&gt;/&amp; 等）还原为原始字符
 */
export function tag(name: string, val: unknown): string {
  const raw = val == null ? '' : String(val);
  const v = escapeXml(unescapeXml(raw));
  return `<${name}>${v}</${name}>`;
}

/**
 * 数值格式化（默认两位小数）；非数值返回空串
 */
export function fmt(n: unknown, digits: number = 2): string {
  if (n == null || Number.isNaN(Number(n))) return '';
  try { return Number(n).toFixed(digits); } catch { return String(n); }
}

/**
 * 检查是否需要在用户提问中过滤的字段
 */
export function shouldFilterInUserQuestion(key: unknown): boolean {
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
export function valueToXMLString(
  value: unknown,
  depth: number = 0,
  maxDepth: number = 100,
  seen: Set<object> = new Set()
): string {
  // 只在极端情况下才限制深度（100层应该足够深了）
  if (depth > maxDepth) {
    return '[MAX_DEPTH_EXCEEDED]';
  }

  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const type = typeof value;

  if (type === 'string') {
    // 先反转义（容错历史数据），再进行 XML 转义，保证最终写入 XML 是合法的
    return escapeXml(unescapeXml(value as string));
  }

  if (type === 'number' || type === 'boolean') {
    return escapeXml(String(value));
  }

  if (type === 'function') {
    return escapeXml('[Function]');
  }

  // 对于复杂对象，检测循环引用
  if (type === 'object' && value !== null) {
    const obj = value as object;
    // 循环引用检测
    if (seen.has(obj)) {
      return '[Circular Reference]';
    }

    // 标记已访问
    const newSeen = new Set(seen);
    newSeen.add(obj);

    // 返回完整JSON表示，不截断
    try {
      const json = JSON.stringify(obj, (key: string, val: unknown) => {
        if (val && typeof val === 'object') {
          const o = val as object;
          if (newSeen.has(o)) return '[Circular]';
          newSeen.add(o);
        }
        return val;
      });
      return escapeXml(json);
    } catch (e) {
      return escapeXml('[Non-Serializable]');
    }
  }

  // 其他类型直接转字符串
  return escapeXml(String(value));
}

function isBlankString(v: unknown): boolean {
  return typeof v === 'string' && v.trim() === '';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isEmptyObject(v: unknown): boolean {
  return isPlainObject(v) && Object.keys(v).length === 0;
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
export function jsonToXMLLines(
  data: unknown,
  indent: number = 1,
  depth: number = 0,
  maxDepth: number = 100,
  filterKeys: string[] = [],
  seen: Set<object> = new Set()
): string[] {
  const lines: string[] = [];
  const indentStr = '  '.repeat(indent);
  if (depth > maxDepth) {
    lines.push(`${indentStr}<value>[MAX_DEPTH_EXCEEDED]</value>`);
    return lines;
  }

  // 循环引用检测
  if (data && typeof data === 'object' && seen.has(data as object)) {
    lines.push(`${indentStr}<value>[Circular Reference]</value>`);
    return lines;
  }

  if (data === null || data === undefined) return lines;
  if (isBlankString(data)) return lines;
  if (Array.isArray(data) && data.length === 0) return lines;
  if (isEmptyObject(data)) return lines;

  // 处理数组
  if (Array.isArray(data)) {
    if (data.length === 0) return lines;

    // 标记已访问
    const newSeen = new Set(seen);
    newSeen.add(data as object);

    (data as unknown[]).forEach((item, index) => {
      const type = typeof item;

      if (item === null || item === undefined) {
        return;
      } else if (type === 'string' || type === 'number' || type === 'boolean') {
        if (type === 'string' && String(item).trim() === '') return;
        const value = valueToXMLString(item, depth, maxDepth, newSeen);
        if (!value) return;
        lines.push(`${indentStr}<item index="${index}">${value}</item>`);
      } else if (Array.isArray(item) || type === 'object') {
        const child = jsonToXMLLines(item, indent + 1, depth + 1, maxDepth, filterKeys, newSeen);
        if (!child || child.length === 0) return;
        lines.push(`${indentStr}<item index="${index}">`);
        lines.push(...child);
        lines.push(`${indentStr}</item>`);
      } else {
        lines.push(`${indentStr}<item index="${index}">${valueToXMLString(item, depth, maxDepth, newSeen)}</item>`);
      }
    });

    return lines;
  }

  // 处理对象
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return lines;

    // 标记已访问
    const newSeen = new Set(seen);
    newSeen.add(obj as object);

    const normalizeTagName = (rawKey: unknown): { tag: string; attrName: string | null } => {
      const k = String(rawKey ?? '');
      // XML tag name: https://www.w3.org/TR/xml/#NT-Name (simplified for common ASCII cases)
      if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) return { tag: k, attrName: null };
      return { tag: 'field', attrName: k };
    };

    keys.forEach((key) => {
      // 过滤指定的键
      if (filterKeys.includes(key)) {
        return;
      }

      const value = obj[key];
      const type = typeof value;

      if (value === null || value === undefined) return;
      if (type === 'string' && String(value).trim() === '') return;
      if (Array.isArray(value) && value.length === 0) return;
      if (isEmptyObject(value)) return;

      const norm = normalizeTagName(key);
      const openTag = norm.attrName
        ? `${indentStr}<${norm.tag} name="${escapeXmlAttr(norm.attrName)}">`
        : `${indentStr}<${norm.tag}>`;
      const closeTag = norm.attrName
        ? `${indentStr}</${norm.tag}>`
        : `${indentStr}</${norm.tag}>`;

      if (type === 'string' || type === 'number' || type === 'boolean') {
        const xmlValue = valueToXMLString(value, depth, maxDepth, newSeen);
        if (!xmlValue) return;
        lines.push(`${openTag}${xmlValue}${closeTag}`);
      } else if (Array.isArray(value)) {
        const child = jsonToXMLLines(value, indent + 1, depth + 1, maxDepth, filterKeys, newSeen);
        if (!child || child.length === 0) return;
        lines.push(openTag);
        lines.push(...child);
        lines.push(closeTag);
      } else if (type === 'object') {
        const child = jsonToXMLLines(value, indent + 1, depth + 1, maxDepth, filterKeys, newSeen);
        if (!child || child.length === 0) return;
        lines.push(openTag);
        lines.push(...child);
        lines.push(closeTag);
      } else {
        const xmlValue = valueToXMLString(value, depth, maxDepth, newSeen);
        if (!xmlValue) return;
        lines.push(`${openTag}${xmlValue}${closeTag}`);
      }
    });

    return lines;
  }

  // 基本类型
  lines.push(`${indentStr}<value>${valueToXMLString(data, depth, maxDepth, seen)}</value>`);
  return lines;
}

export interface AppendXmlBlockLinesOptions {
  indent?: number;
  transformLine?: (line: string) => string;
}

/**
 * 在现有 lines 数组上追加一个简单的多行文本块：
 * <tagName>
 *   line...
 * </tagName>
 * - content 可以是字符串（按 \n 拆分）或字符串数组
 * - 不进行 XML 转义，由调用方自行处理（必要时通过 options.transformLine 注入）
 */
export function appendXmlBlockLines(
  lines: string[],
  tagName: string,
  content: string | string[],
  options: AppendXmlBlockLinesOptions = {}
): void {
  if (!Array.isArray(lines) || !tagName) return;

  const { indent = 0, transformLine } = options;
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);

  const inner: string[] = [];

  if (Array.isArray(content)) {
    for (const raw of content) {
      if (raw == null) continue;
      const value = typeof transformLine === 'function' ? transformLine(String(raw)) : escapeXml(String(raw));
      if (!value) continue;
      inner.push(`${padInner}${value}`);
    }
  } else if (typeof content === 'string') {
    const text = content;
    for (const rawLine of text.split('\n')) {
      const t = rawLine.trim();
      if (!t) continue;
      const value = typeof transformLine === 'function' ? transformLine(t) : escapeXml(t);
      if (!value) continue;
      inner.push(`${padInner}${value}`);
    }
  }

  if (inner.length === 0) return;
  lines.push(`${pad}<${tagName}>`);
  lines.push(...inner);
  lines.push(`${pad}</${tagName}>`);
}

/**
 * 在现有 lines 数组上追加一个简单的 <constraints> 块：
 *   <constraints>
 *     <item>...</item>
 *   </constraints>
 * - items 为字符串数组
 * - 不进行 XML 转义，由调用方自行处理
 */
export function appendConstraintsBlock(lines: string[], items: string[], indent: number = 0): void {
  if (!Array.isArray(lines) || !Array.isArray(items) || items.length === 0) return;

  const pad = '  '.repeat(indent);
  const padItem = '  '.repeat(indent + 1);

  lines.push(`${pad}<constraints>`);
  for (const raw of items) {
    if (!raw) continue;
    lines.push(`${padItem}<item>${escapeXml(String(raw))}</item>`);
  }
  lines.push(`${pad}</constraints>`);
}

export interface ExtractXMLTagOptions {
  trimResult?: boolean;
  removeCodeBlock?: boolean;
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
export function extractXMLTag(
  text: string,
  tagName: string,
  options: ExtractXMLTagOptions = {}
): string | null {
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

  let content = match[1] ?? '';

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
export function extractAllXMLTags(
  text: string,
  tagName: string,
  options: ExtractXMLTagOptions = {}
): string[] {
  const { trimResult = true, removeCodeBlock = true } = options;

  if (!text || !tagName) return [];

  // 预处理
  let processedText = text;
  if (removeCodeBlock) {
    processedText = processedText.replace(/```(?:xml)?\s*([\s\S]*?)```/g, '$1');
  }

  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(processedText)) !== null) {
    let content = match[1] ?? '';
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
export function extractFilesFromContent(
  data: unknown,
  basePath: Array<string | number> = []
): Array<{ key: string; path: string }> {
  const files: Array<{ key: string; path: string }> = [];
  if (!data || typeof data !== 'object') return files;

  const checkAndAdd = (value: string, key: string | number) => {
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

    const addCandidate = (rawCandidate: unknown) => {
      if (!rawCandidate) return;
      const candidate = String(rawCandidate).trim();
      if (!candidate) return;

      // http(s) 开头：直接作为 URL
      if (/^https?:\/\//i.test(candidate)) {
        files.push({ key: keyPath, path: candidate });
        return;
      }

      // 其他情况：作为潜在本地路径，交给 extract-path + 正则兜底
      let localPath: string | null = null;
      try {
        localPath = extractPath(candidate, {
          validateFileExists: false,
          resolveWithFallback: false
        });
      } catch { }

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

  const nextBase = (base: Array<string | number>, part: string | number) => [...base, part];

  if (Array.isArray(data)) {
    (data as unknown[]).forEach((item, i) => {
      if (typeof item === 'string') checkAndAdd(item, i);
      else if (item && typeof item === 'object') files.push(...extractFilesFromContent(item, nextBase(basePath, i)));
    });
  } else {
    Object.entries(data as Record<string, unknown>).forEach(([k, v]) => {
      if (typeof v === 'string') checkAndAdd(v, k);
      else if (v && typeof v === 'object') files.push(...extractFilesFromContent(v, nextBase(basePath, k)));
    });
  }

  // 自动按 path 去重
  const seen = new Set<string>();
  const unique: Array<{ key: string; path: string }> = [];
  for (const f of files) {
    const p = (f && typeof f.path === 'string') ? f.path.trim() : '';
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(f);
  }

  return unique;
}
