/**
 * XML澶勭悊宸ュ叿妯″潡
 * 鍖呭惈XML鏍囩鎻愬彇銆丣SON杞琗ML銆佹晱鎰熶俊鎭繃婊ょ瓑鍔熻兘
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

function extractNodeText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((v) => extractNodeText(v)).join('');
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj['#text'] === 'string') return obj['#text'];
    let out = '';
    for (const [k, v] of Object.entries(obj)) {
      if (k === '#text') continue;
      out += extractNodeText(v);
    }
    return out;
  }
  return '';
}

export function collectXmlTagTextValues(xmlFragment: unknown, tagNames: string[]): string[] {
  const xml = typeof xmlFragment === 'string' ? xmlFragment : String(xmlFragment ?? '');
  if (!xml.trim()) return [];
  const set = new Set((Array.isArray(tagNames) ? tagNames : [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean));
  if (set.size === 0) return [];
  const root = tryParseXmlFragment(xml, 'root');
  if (!root || typeof root !== 'object') return [];
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (k === '#text') continue;
      const lower = String(k || '').toLowerCase();
      if (set.has(lower)) {
        const text = unescapeXml(extractNodeText(v)).trim();
        if (text) out.push(text);
      }
      walk(v);
    }
  };
  walk(root);
  return out;
}

// 鐢ㄦ埛娑堟伅涓渶瑕佽繃婊ょ殑瀛楁锛堥伩鍏嶅啑浣欙級
export const USER_QUESTION_FILTER_KEYS = [
  'message', 'segments', 'images', 'videos', 'files', 'records'
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
  try {
    const parsed = tryParseXmlFragment(s, 'typed_value') as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return s;
    const keys = Object.keys(parsed).filter((k) => k !== '#text');
    if (keys.length !== 1) return s;
    const keyName = keys[0];
    if (!keyName) return s;
    const key = String(keyName).toLowerCase();
    if (!['string', 'number', 'boolean', 'null'].includes(key)) return s;
    const node = (parsed as Record<string, unknown>)[keyName];
    if (node == null) return '';
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      return String(node).trim();
    }
    if (typeof node === 'object' && node && typeof (node as Record<string, unknown>)['#text'] === 'string') {
      return String((node as Record<string, unknown>)['#text']).trim();
    }
    return '';
  } catch {
    return s;
  }
}

export function extractXmlAttrValue(tagXml: unknown, attrName: unknown): string {
  if (!tagXml || typeof tagXml !== 'string') return '';
  const xml = String(tagXml);
  const attr = String(attrName || '').trim();
  if (!attr) return '';
  let quote: '"' | '\'' | '' = '';
  let end = -1;
  for (let i = 0; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '>') {
      end = i;
      break;
    }
  }
  if (end < 0) return '';
  const openTag = xml.slice(0, end + 1);
  try {
    const parsed = tryParseXmlFragment(openTag, 'root_tag') as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return '';
    const firstKey = Object.keys(parsed).find((k) => k !== '#text');
    if (!firstKey) return '';
    const node = (parsed as Record<string, unknown>)[firstKey];
    if (!node || typeof node !== 'object') return '';
    const val = (node as Record<string, unknown>)[attr];
    return val == null ? '' : String(val);
  } catch {
    return '';
  }
}

export function extractInnerXmlFromFullTag(fullTagXml: unknown, tagName: unknown): string {
  if (!fullTagXml || typeof fullTagXml !== 'string') return '';
  const xml = String(fullTagXml);
  const tag = String(tagName || '').trim().toLowerCase();
  if (!tag) return '';
  const openStart = xml.indexOf('<');
  if (openStart < 0) return '';
  let quote: '"' | '\'' | '' = '';
  let openEnd = -1;
  for (let i = openStart; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '>') {
      openEnd = i;
      break;
    }
  }
  if (openEnd < 0) return '';
  const closeTag = `</${tag}>`;
  const lower = xml.toLowerCase();
  const closeStart = lower.lastIndexOf(closeTag);
  if (closeStart < 0 || closeStart < openEnd) return '';
  return xml.slice(openEnd + 1, closeStart);
}

/**
 * 鎻愬彇瀹屾暣鐨刋ML鏍囩锛堝寘鍚灞傝捣姝㈡爣绛惧拰灞炴€э級
 * @param {string} text - 鍖呭惈 XML 鏍囩鐨勬枃鏈? * @param {string} tagName - 鏍囩鍚嶇О
 * @returns {string|null} 瀹屾暣鏍囩瀛楃涓诧紝鏈壘鍒拌繑鍥?null
 */
export function extractFullXMLTag(text: string, tagName: string): string | null {
  if (!text || !tagName) return null;
  const s = String(text);
  const tag = String(tagName).trim();
  if (!tag) return null;
  const lower = s.toLowerCase();
  const lowerTag = tag.toLowerCase();
  const isBoundary = (ch: string) => ch === '' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '>' || ch === '/';
  const findTagEnd = (from: number): number => {
    let quote: '"' | '\'' | '' = '';
    for (let i = from; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === '\'') {
        quote = ch;
        continue;
      }
      if (ch === '>') return i;
    }
    return -1;
  };
  const isSelfClosing = (openEnd: number): boolean => {
    for (let i = openEnd - 1; i >= 0; i--) {
      const ch = s[i];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
      return ch === '/';
    }
    return false;
  };

  let scan = 0;
  while (scan < s.length) {
    const openPos = lower.indexOf(`<${lowerTag}`, scan);
    if (openPos < 0) return null;
    const afterName = lower[openPos + lowerTag.length + 1] || '';
    if (!isBoundary(afterName)) {
      scan = openPos + 1;
      continue;
    }
    const firstOpenEnd = findTagEnd(openPos);
    if (firstOpenEnd < 0) return null;
    if (isSelfClosing(firstOpenEnd)) {
      return s.slice(openPos, firstOpenEnd + 1);
    }
    let depth = 1;
    let cursor = firstOpenEnd + 1;
    while (cursor < s.length) {
      const nextLt = lower.indexOf('<', cursor);
      if (nextLt < 0) return null;
      if (lower.startsWith('<!--', nextLt)) {
        const endComment = lower.indexOf('-->', nextLt + 4);
        if (endComment < 0) return null;
        cursor = endComment + 3;
        continue;
      }
      const isClose = lower.startsWith(`</${lowerTag}`, nextLt);
      const isOpen = lower.startsWith(`<${lowerTag}`, nextLt);
      if (!isClose && !isOpen) {
        const skipEnd = findTagEnd(nextLt);
        if (skipEnd < 0) return null;
        cursor = skipEnd + 1;
        continue;
      }
      const nameAfter = lower[nextLt + lowerTag.length + (isClose ? 2 : 1)] || '';
      if (!isBoundary(nameAfter)) {
        cursor = nextLt + 1;
        continue;
      }
      const tagEnd = findTagEnd(nextLt);
      if (tagEnd < 0) return null;
      if (isClose) {
        depth -= 1;
        if (depth === 0) {
          return s.slice(openPos, tagEnd + 1);
        }
      } else if (!isSelfClosing(tagEnd)) {
        depth += 1;
      }
      cursor = tagEnd + 1;
    }
    return null;
  }
  return null;
}

/**
 * 鎻愬彇鎵€鏈夊畬鏁寸殑XML鏍囩锛堝寘鍚灞傝捣姝㈡爣绛惧拰灞炴€э級
 * @param {string} text - 鍖呭惈 XML 鏍囩鐨勬枃鏈? * @param {string} tagName - 鏍囩鍚嶇О
 * @returns {Array<string>} 瀹屾暣鏍囩瀛楃涓叉暟缁? */
export function extractAllFullXMLTags(text: string, tagName: string): string[] {
  if (!text || !tagName) return [];
  const out: string[] = [];
  const s = String(text);
  let cursor = 0;
  while (cursor < s.length) {
    const sliced = s.slice(cursor);
    const full = extractFullXMLTag(sliced, tagName);
    if (!full) break;
    out.push(full);
    const offset = s.indexOf(full, cursor);
    if (offset < 0) break;
    cursor = offset + full.length;
  }
  return out;
}

/**
 * 鐢熸垚绠€鍗?XML 鏍囩锛屼笉杞箟鍐呭
 * - 鍦ㄥ啓鍏ュ墠浼氬皢甯歌 XML/HTML 瀹炰綋锛?lt;/&gt;/&amp; 绛夛級杩樺師涓哄師濮嬪瓧绗? */
export function tag(name: string, val: unknown): string {
  const raw = val == null ? '' : String(val);
  const v = escapeXml(unescapeXml(raw));
  return `<${name}>${v}</${name}>`;
}

/**
 * 鏁板€兼牸寮忓寲锛堥粯璁や袱浣嶅皬鏁帮級锛涢潪鏁板€艰繑鍥炵┖涓? */
export function fmt(n: unknown, digits: number = 2): string {
  if (n == null || Number.isNaN(Number(n))) return '';
  try { return Number(n).toFixed(digits); } catch { return String(n); }
}

/**
 * 妫€鏌ユ槸鍚﹂渶瑕佸湪鐢ㄦ埛鎻愰棶涓繃婊ょ殑瀛楁
 */
export function shouldFilterInUserQuestion(key: unknown): boolean {
  return USER_QUESTION_FILTER_KEYS.includes(String(key).toLowerCase());
}

/**
 * 灏嗕换鎰忓€艰浆鎹负瀛楃涓诧紙涓嶈繘琛孹ML杞箟锛? * 閬靛惊 Sentra XML 鍗忚锛氫繚鐣欏師濮嬪唴瀹癸紝閬垮厤褰卞搷 HTML/浠ｇ爜娓叉煋
 * @param {*} value - 瑕佽浆鎹㈢殑鍊? * @param {number} depth - 褰撳墠閫掑綊娣卞害
 * @param {number} maxDepth - 鏈€澶ч€掑綊娣卞害闄愬埗
 * @param {Set} seen - 鐢ㄤ簬妫€娴嬪惊鐜紩鐢ㄧ殑瀵硅薄闆嗗悎
 * @returns {string} 杞崲鍚庣殑瀛楃涓诧紙鍘熷鍐呭锛屼笉杞箟锛? */
export function valueToXMLString(
  value: unknown,
  depth: number = 0,
  maxDepth: number = 100,
  seen: Set<object> = new Set()
): string {
  // 鍙湪鏋佺鎯呭喌涓嬫墠闄愬埗娣卞害锛?00灞傚簲璇ヨ冻澶熸繁浜嗭級
  if (depth > maxDepth) {
    return '[MAX_DEPTH_EXCEEDED]';
  }

  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  const type = typeof value;

  if (type === 'string') {
    // 鍏堝弽杞箟锛堝閿欏巻鍙叉暟鎹級锛屽啀杩涜 XML 杞箟锛屼繚璇佹渶缁堝啓鍏?XML 鏄悎娉曠殑
    return escapeXml(unescapeXml(value as string));
  }

  if (type === 'number' || type === 'boolean') {
    return escapeXml(String(value));
  }

  if (type === 'function') {
    return escapeXml('[Function]');
  }

  // Complex object: guard against circular references before serialization.
  if (type === 'object' && value !== null) {
    const obj = value as object;
    // Circular reference short-circuit.
    if (seen.has(obj)) {
      return '[Circular Reference]';
    }

    // Track visited nodes for JSON stringify replacer.
    const newSeen = new Set(seen);
    newSeen.add(obj);

    // 杩斿洖瀹屾暣JSON琛ㄧず锛屼笉鎴柇
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

  // 鍏朵粬绫诲瀷鐩存帴杞瓧绗︿覆
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
 * 閫掑綊灏咼SON瀵硅薄杞崲涓篨ML鏍囩
 * @param {*} data - 瑕佽浆鎹㈢殑鏁版嵁
 * @param {number} indent - 缂╄繘绾у埆
 * @param {number} depth - 褰撳墠閫掑綊娣卞害
 * @param {number} maxDepth - 鏈€澶ч€掑綊娣卞害闄愬埗
 * @param {Array<string>} filterKeys - 闇€瑕佽繃婊ょ殑閿悕鍒楄〃
 * @param {Set} seen - 鐢ㄤ簬妫€娴嬪惊鐜紩鐢ㄧ殑瀵硅薄闆嗗悎
 * @returns {Array<string>} XML琛屾暟缁? */
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

  // Circular reference guard for recursive XML serialization.
  if (data && typeof data === 'object' && seen.has(data as object)) {
    lines.push(`${indentStr}<value>[Circular Reference]</value>`);
    return lines;
  }

  if (data === null || data === undefined) return lines;
  if (isBlankString(data)) return lines;
  if (Array.isArray(data) && data.length === 0) return lines;
  if (isEmptyObject(data)) return lines;

  // 澶勭悊鏁扮粍
  if (Array.isArray(data)) {
    if (data.length === 0) return lines;

    // Mark current array as visited.
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

  // 澶勭悊瀵硅薄
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return lines;

    // Mark current object as visited.
    const newSeen = new Set(seen);
    newSeen.add(obj as object);

    const normalizeTagName = (rawKey: unknown): { tag: string; attrName: string | null } => {
      const k = String(rawKey ?? '');
      // XML tag name: https://www.w3.org/TR/xml/#NT-Name (simplified for common ASCII cases)
      if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) return { tag: k, attrName: null };
      return { tag: 'field', attrName: k };
    };

    keys.forEach((key) => {
      // 杩囨护鎸囧畾鐨勯敭
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

  // 鍩烘湰绫诲瀷
  lines.push(`${indentStr}<value>${valueToXMLString(data, depth, maxDepth, seen)}</value>`);
  return lines;
}

export interface AppendXmlBlockLinesOptions {
  indent?: number;
  transformLine?: (line: string) => string;
}

/**
 * 鍦ㄧ幇鏈?lines 鏁扮粍涓婅拷鍔犱竴涓畝鍗曠殑澶氳鏂囨湰鍧楋細
 * <tagName>
 *   line...
 * </tagName>
 * - content 鍙互鏄瓧绗︿覆锛堟寜 \n 鎷嗗垎锛夋垨瀛楃涓叉暟缁? * - 涓嶈繘琛?XML 杞箟锛岀敱璋冪敤鏂硅嚜琛屽鐞嗭紙蹇呰鏃堕€氳繃 options.transformLine 娉ㄥ叆锛? */
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
 * 鍦ㄧ幇鏈?lines 鏁扮粍涓婅拷鍔犱竴涓畝鍗曠殑 <constraints> 鍧楋細
 *   <constraints>
 *     <item>...</item>
 *   </constraints>
 * - items 涓哄瓧绗︿覆鏁扮粍
 * - 涓嶈繘琛?XML 杞箟锛岀敱璋冪敤鏂硅嚜琛屽鐞? */
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
 * 鎻愬彇XML鏍囩鍐呭
 * @param {string} text - 鍖呭惈 XML 鏍囩鐨勬枃鏈? * @param {string} tagName - 鏍囩鍚嶇О
 * @param {Object} options - 閫夐」
 * @param {boolean} options.trimResult - 鏄惁 trim 缁撴灉锛堥粯璁?true锛? * @param {boolean} options.removeCodeBlock - 鏄惁绉婚櫎 ```xml 浠ｇ爜鍧楁爣璁帮紙榛樿 true锛? * @returns {string|null} 鎻愬彇鐨勫唴瀹癸紝鏈壘鍒拌繑鍥?null
 */
export function extractXMLTag(
  text: string,
  tagName: string,
  options: ExtractXMLTagOptions = {}
): string | null {
  const { trimResult = true, removeCodeBlock = true } = options;

  if (!text || !tagName) return null;

  const stripCodeFences = (input: string): string => {
    let out = '';
    let i = 0;
    while (i < input.length) {
      const start = input.indexOf('```', i);
      if (start < 0) {
        out += input.slice(i);
        break;
      }
      out += input.slice(i, start);
      const lineEnd = input.indexOf('\n', start + 3);
      if (lineEnd < 0) break;
      const fenceClose = input.indexOf('```', lineEnd + 1);
      if (fenceClose < 0) {
        out += input.slice(lineEnd + 1);
        break;
      }
      out += input.slice(lineEnd + 1, fenceClose);
      i = fenceClose + 3;
    }
    return out;
  };

  let processedText = String(text);
  if (removeCodeBlock) {
    processedText = stripCodeFences(processedText);
  }

  const full = extractFullXMLTag(processedText, tagName);
  if (!full) return null;

  let content = extractInnerXmlFromFullTag(full, tagName);
  if (trimResult) {
    content = content.trim();
  }

  return content;
}
/**
 * 鎻愬彇鎵€鏈夐噸澶嶇殑XML鏍囩
 * @param {string} text - 鍖呭惈 XML 鏍囩鐨勬枃鏈? * @param {string} tagName - 鏍囩鍚嶇О
 * @param {Object} options - 閫夐」
 * @param {boolean} options.trimResult - 鏄惁 trim 缁撴灉锛堥粯璁?true锛? * @param {boolean} options.removeCodeBlock - 鏄惁绉婚櫎浠ｇ爜鍧楁爣璁帮紙榛樿 true锛? * @returns {Array<string>} 鎻愬彇鐨勫唴瀹规暟缁? */
export function extractAllXMLTags(
  text: string,
  tagName: string,
  options: ExtractXMLTagOptions = {}
): string[] {
  const { trimResult = true, removeCodeBlock = true } = options;

  if (!text || !tagName) return [];

  const stripCodeFences = (input: string): string => {
    let out = '';
    let i = 0;
    while (i < input.length) {
      const start = input.indexOf('```', i);
      if (start < 0) {
        out += input.slice(i);
        break;
      }
      out += input.slice(i, start);
      const lineEnd = input.indexOf('\n', start + 3);
      if (lineEnd < 0) break;
      const fenceClose = input.indexOf('```', lineEnd + 1);
      if (fenceClose < 0) {
        out += input.slice(lineEnd + 1);
        break;
      }
      out += input.slice(lineEnd + 1, fenceClose);
      i = fenceClose + 3;
    }
    return out;
  };

  let processedText = String(text);
  if (removeCodeBlock) {
    processedText = stripCodeFences(processedText);
  }

  const matches: string[] = [];
  const fullTags = extractAllFullXMLTags(processedText, tagName);
  for (const full of fullTags) {
    let content = extractInnerXmlFromFullTag(full, tagName);
    if (trimResult) {
      content = content.trim();
    }
    matches.push(content);
  }

  return matches;
}
/**
 * 鎻愬彇鏂囦欢璺緞锛堢敤浜庡伐鍏风粨鏋滐級
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
    // 璺宠繃绀轰緥/鏍蜂緥瀛楁锛屼緥濡?toolMeta.responseExample
    if (keyPathLower.includes('responseexample')) return;
    const text = value;
    const trimmed = text.trim();

    if (!trimmed) return;

    // 鍙粠 Markdown 褰㈠紡鐨勯摼鎺?鍥剧墖涓彁鍙栵細![](...) 鎴?[](...)
    const mdRegex = /!\[[^\]]*\]\(([^)]+)\)|\[[^\]]*\]\(([^)]+)\)/g;

    const addCandidate = (rawCandidate: unknown) => {
      if (!rawCandidate) return;
      const candidate = String(rawCandidate).trim();
      if (!candidate) return;

      // http(s) 寮€澶达細鐩存帴浣滀负 URL
      if (/^https?:\/\//i.test(candidate)) {
        files.push({ key: keyPath, path: candidate });
        return;
      }

      // 鍏朵粬鎯呭喌锛氫綔涓烘綔鍦ㄦ湰鍦拌矾寰勶紝浜ょ粰 extract-path + 姝ｅ垯鍏滃簳
      let localPath: string | null = null;
      try {
        localPath = extractPath(candidate, {
          validateFileExists: false,
          resolveWithFallback: false
        });
      } catch { }

      if (!localPath) {
        // 绠€鍗曞厹搴曪細Windows 鐩樼璺緞鎴?Unix 椋庢牸鐨?/dir/file.ext
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
      // m[1] 瀵瑰簲 ![](...)锛宮[2] 瀵瑰簲 [](...)
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

  // 鑷姩鎸?path 鍘婚噸
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


