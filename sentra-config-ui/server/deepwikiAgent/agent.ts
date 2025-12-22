import { readFileSync } from 'fs';
import { join } from 'path';
import { XMLParser } from 'fast-xml-parser';
import { getDeepwikiTool } from './plugins/registry';

type Role = 'system' | 'user' | 'assistant';

export interface DeepwikiAgentInput {
  messages: Array<{ role: string; content: any }>;
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
}

function sortForKey(v: any): any {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(sortForKey);
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortForKey((v as any)[k]);
    }
    return out;
  }
  return v;
}

function toolCallKey(name: string, args: Record<string, any>): string {
  let payload = '';
  try {
    payload = JSON.stringify(sortForKey(args || {}));
  } catch {
    payload = String(args || '');
  }
  return `${name}::${payload}`;
}

export interface DeepwikiAgentOutput {
  finalText: string;
  trace?: DeepwikiAgentTraceItem[];
  actionRequired?: boolean;
  pendingToolCalls?: Array<{ name: string; args: Record<string, any> }>;
  pendingToolsXml?: string;
  agentState?: DeepwikiAgentState;
  debug?: {
    loops: number;
  };
}

export interface DeepwikiAgentState {
  messages: Array<{ role: Role; content: any }>;
  trace: DeepwikiAgentTraceItem[];
  toolCacheEntries: Array<[string, { success: boolean; data: any; args: any; tool: string }]>;
  loopsDone: number;
  model: string;
  lastToolPlanKey?: string;
}

export interface DeepwikiAgentTraceItem {
  loop: number;
  model_output: string;
  need_tools: boolean | null;
  sentra_tools_xml?: string;
  tool_calls?: Array<{ name: string; args: Record<string, any> }>;
  tool_results_xml?: string;
}

function stripCodeFences(s: string): string {
  const t = String(s || '').trim();
  if (t.startsWith('```')) {
    const firstNl = t.indexOf('\n');
    if (firstNl >= 0) {
      const rest = t.slice(firstNl + 1);
      const endIdx = rest.lastIndexOf('```');
      return endIdx >= 0 ? rest.slice(0, endIdx).trim() : rest.trim();
    }
  }
  return t;
}

function escapeXmlText(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlValue(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXmlAttr(s: string): string {
  return escapeXmlValue(s);
}

function valueToTypedXml(v: any): string {
  if (v === null) return '<null></null>';
  if (v === undefined) return '<null></null>';
  if (Array.isArray(v)) {
    if (v.length === 0) return '<array></array>';
    return `<array>\n${v.map((x) => valueToTypedXml(x)).join('\n')}\n</array>`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, any>);
    if (entries.length === 0) return '<object></object>';
    return `<object>\n${entries
      .map(([k, val]) => `  <parameter name="${escapeXmlAttr(String(k))}">${valueToTypedXml(val)}</parameter>`)
      .join('\n')}\n</object>`;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return `<number>${v}</number>`;
  if (typeof v === 'boolean') return `<boolean>${v ? 'true' : 'false'}</boolean>`;
  return `<string>${escapeXmlValue(String(v))}</string>`;
}

function formatSentraToolsTyped(calls: Array<{ name: string; args: Record<string, any> }>): string {
  const blocks = calls.map((c) => {
    const args = c.args || {};
    const params = Object.entries(args)
      .map(([k, v]) => `    <parameter name="${escapeXmlAttr(String(k))}">${valueToTypedXml(v)}</parameter>`)
      .join('\n');
    return `  <invoke name="${escapeXmlAttr(String(c.name || ''))}">\n${params}\n  </invoke>`;
  });
  return `<sentra-tools>\n${blocks.join('\n')}\n</sentra-tools>`;
}

function extractLastUserText(messages: Array<{ role: string; content: any }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const textPart = c.find((x: any) => x?.type === 'text' && typeof x?.text === 'string');
      if (textPart?.text) return textPart.text;
      const firstStr = c.find((x: any) => typeof x === 'string');
      if (typeof firstStr === 'string') return firstStr;
    }
    return String(c ?? '');
  }
  return '';
}

function loadDeepwikiPrompt(): { system: string; user: string } {
  const fp = join(process.cwd(), 'server', 'deepwikiAgent', 'prompts', 'deepwiki_sentra_xml.json');
  const raw = readFileSync(fp, 'utf-8');
  const parsed = JSON.parse(raw);
  return {
    system: String(parsed?.system || ''),
    user: String(parsed?.user || ''),
  };
}

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => (vars[key] ?? ''));
}

function parseTag(text: string, tag: string): string | null {
  // IMPORTANT: always take the LAST occurrence.
  // Models may emit multiple blocks (e.g., quoting previous rounds), and taking the
  // first match can cause stale need_tools/tools to be re-processed repeatedly.
  const re = new RegExp(`<\\s*${tag}\\s*>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, 'gi');
  const s = String(text || '');
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    last = String(m[1] || '').trim();
  }
  return last;
}

function parseNeedTools(text: string): boolean | null {
  const raw = parseTag(text, 'need_tools');
  if (!raw) return null;

  const t = stripCodeFences(String(raw || '')).trim();
  const v = t.toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;

  // Typed boolean: <need_tools><boolean>true</boolean></need_tools>
  const mBool = v.match(/<\s*boolean\b[^>]*>\s*(true|false)\s*<\s*\/\s*boolean\s*>/i);
  if (mBool) return mBool[1].toLowerCase() === 'true';

  // Some models emit "boolean true" / "boolean: true" etc.
  const mWord = v.match(/\b(true|false)\b/i);
  if (mWord) return mWord[1].toLowerCase() === 'true';

  return null;
}

function parseSentraToolsBlock(text: string): string | null {
  // Take the LAST <sentra-tools> block.
  const re = /<\s*sentra[-_\s]*tools\b[^>]*>([\s\S]*?)<\s*\/\s*sentra[-_\s]*tools\s*>/gi;
  const s = String(text || '');
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    last = String(m[0] || '').trim();
  }
  return last;
}

function decodeXmlEntities(s: string): string {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function safeParseJson(s: string): any | null {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s);
  } catch {
    // naive fallback: try best-effort extract from first { to last } or first [ to last ]
    const iObj = s.indexOf('{');
    const jObj = s.lastIndexOf('}');
    if (iObj >= 0 && jObj > iObj) {
      const t = s.slice(iObj, jObj + 1);
      try { return JSON.parse(t); } catch { }
    }
    const iArr = s.indexOf('[');
    const jArr = s.lastIndexOf(']');
    if (iArr >= 0 && jArr > iArr) {
      const t = s.slice(iArr, jArr + 1);
      try { return JSON.parse(t); } catch { }
    }
  }
  return null;
}

function inferScalarType(raw: string): any {
  const s = decodeXmlEntities(String(raw || '').trim());
  if (!s) return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  // numeric
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isNaN(n)) return n;
  }
  // json objects/arrays (full or embedded)
  if (s.includes('{') || s.includes('[')) {
    const parsed = safeParseJson(s);
    if (parsed !== null) return parsed;
  }
  return s;
}

function parseStructuredXmlValue(raw: string): { matched: boolean; value?: any } {
  const t = String(raw || '').trim();
  if (!t) return { matched: false };

  // <array>...</array>
  const mArr = t.match(/<\s*array\b[^>]*>([\s\S]*?)<\s*\/\s*array\s*>/i);
  if (mArr) {
    return { matched: true, value: parseXmlArray(mArr[1] || '') };
  }
  // self-closing <array />
  const mArrSelf = t.match(/<\s*array\b[^>]*\/\s*>/i);
  if (mArrSelf) {
    return { matched: true, value: [] };
  }

  // <object>...</object>
  const mObj = t.match(/<\s*object\b[^>]*>([\s\S]*?)<\s*\/\s*object\s*>/i);
  if (mObj) {
    return { matched: true, value: parseXmlObject(mObj[1] || '') };
  }
  // self-closing <object />
  const mObjSelf = t.match(/<\s*object\b[^>]*\/\s*>/i);
  if (mObjSelf) {
    return { matched: true, value: {} };
  }

  // <string>...</string>
  const mStr = t.match(/<\s*string\b[^>]*>([\s\S]*?)<\s*\/\s*string\s*>/i);
  if (mStr) {
    return { matched: true, value: decodeXmlEntities(mStr[1] || '') };
  }

  // <number>...</number>
  const mNum = t.match(/<\s*number\b[^>]*>([\s\S]*?)<\s*\/\s*number\s*>/i);
  if (mNum) {
    const n = Number(String(mNum[1] || '').trim());
    if (!Number.isNaN(n)) return { matched: true, value: n };
  }

  // <boolean>...</boolean>
  const mBool = t.match(/<\s*boolean\b[^>]*>([\s\S]*?)<\s*\/\s*boolean\s*>/i);
  if (mBool) {
    const v = String(mBool[1] || '').trim().toLowerCase();
    if (v === 'true' || v === 'false') return { matched: true, value: v === 'true' };
  }

  // <null></null>
  const mNull = t.match(/<\s*null\b[^>]*>([\s\S]*?)<\s*\/\s*null\s*>/i);
  if (mNull) {
    return { matched: true, value: null };
  }

  return { matched: false };
}

function parseXmlArray(inner: string): any[] {
  if (!inner || typeof inner !== 'string') return [];
  const items: any[] = [];
  const reChild = /<\s*(object|string|number|boolean|null|array)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = reChild.exec(inner)) !== null) {
    const block = m[0] || '';
    const parsed = parseStructuredXmlValue(block);
    if (parsed && parsed.matched) {
      items.push((parsed as any).value);
    }
  }
  return items;
}

function parseXmlObject(inner: string): Record<string, any> {
  const obj: Record<string, any> = {};
  if (!inner || typeof inner !== 'string') return obj;
  const seen = new Set<string>();
  const reParam = /<\s*parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = reParam.exec(inner)) !== null) {
    const key = String(m[1] || '').trim();
    const body = String(m[2] || '');
    if (!key || seen.has(key)) continue;
    const parsed = parseStructuredXmlValue(body);
    if (parsed && parsed.matched) {
      obj[key] = (parsed as any).value;
    } else {
      obj[key] = inferScalarType(body);
    }
    seen.add(key);
  }
  return obj;
}

let sentraToolsXmlParser: XMLParser | null = null;

function getSentraToolsXmlParser(): XMLParser {
  if (sentraToolsXmlParser) return sentraToolsXmlParser;
  sentraToolsXmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: false,
    allowBooleanAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  return sentraToolsXmlParser;
}

function extractAstText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((n) => extractAstText(n)).join('');
  }
  if (typeof node === 'object') {
    if (typeof node['#text'] === 'string') {
      return node['#text'];
    }
    let out = '';
    for (const [k, v] of Object.entries(node)) {
      if (k === '#text') continue;
      if (k.startsWith('@_')) continue;
      out += extractAstText(v);
    }
    return out;
  }
  return '';
}

function decodeAstTypedValue(node: any): any {
  if (node == null) return null;
  if (typeof node !== 'object') {
    return inferScalarType(String(node));
  }

  if (Object.prototype.hasOwnProperty.call(node, 'string')) {
    const raw = extractAstText((node as any).string);
    return decodeXmlEntities(raw);
  }
  if (Object.prototype.hasOwnProperty.call(node, 'number')) {
    const raw = extractAstText((node as any).number);
    const n = Number(String(raw).trim());
    return Number.isNaN(n) ? raw : n;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'boolean')) {
    const raw = String(extractAstText((node as any).boolean)).trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'null')) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'array')) {
    return decodeAstArray((node as any).array);
  }
  if (Object.prototype.hasOwnProperty.call(node, 'object')) {
    return decodeAstObject((node as any).object);
  }

  return inferScalarType(extractAstText(node));
}

function decodeAstArray(arrayNode: any): any[] {
  if (arrayNode == null) return [];
  const values: any[] = [];
  const containers = Array.isArray(arrayNode) ? arrayNode : [arrayNode];
  const typeKeys = ['string', 'number', 'boolean', 'null', 'array', 'object'];

  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    for (const key of typeKeys) {
      if (!Object.prototype.hasOwnProperty.call(c, key)) continue;
      const raw = (c as any)[key];
      const items = Array.isArray(raw) ? raw : [raw];
      for (const it of items) {
        const wrapper: any = { [key]: it };
        values.push(decodeAstTypedValue(wrapper));
      }
    }
  }
  return values;
}

function decodeAstObject(objectNode: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (objectNode == null) return out;
  const containers = Array.isArray(objectNode) ? objectNode : [objectNode];

  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    const props: any[] = [];
    if ((c as any).property !== undefined) {
      const list = Array.isArray((c as any).property) ? (c as any).property : [(c as any).property];
      props.push(...list);
    }
    if ((c as any).parameter !== undefined) {
      const list = Array.isArray((c as any).parameter) ? (c as any).parameter : [(c as any).parameter];
      props.push(...list);
    }
    for (const p of props) {
      if (!p || typeof p !== 'object') continue;
      const key = String((p as any)['@_name'] || '').trim();
      if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key] = decodeAstTypedValue(p);
    }
  }

  return out;
}

function isNonEmptyString(v: any): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPlainObject(v: any): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isEditableEnvPath(p: string): boolean {
  const t = p.trim();
  return t === '.env' || /^\.env\.[^/\\]+$/.test(t) || /\/\.env(\.[^/\\]+)?$/.test(t);
}

function validateToolCall(name: string, args: any): string[] {
  const errs: string[] = [];
  const tool = String(name || '').trim();

  if (!isPlainObject(args)) {
    errs.push(`[${tool}] args must be an object`);
    return errs;
  }

  if (tool === 'read_file') {
    if (!isNonEmptyString(args.path)) errs.push('[read_file] missing required parameter: path (string)');
    return errs;
  }

  if (tool === 'list_dir') {
    if (!isNonEmptyString(args.path)) errs.push('[list_dir] missing required parameter: path (string)');
    return errs;
  }

  if (tool === 'edit_file') {
    if (!isNonEmptyString(args.path)) {
      errs.push('[edit_file] missing required parameter: path (string; must be .env or .env.*)');
    } else if (!isEditableEnvPath(args.path)) {
      errs.push(`[edit_file] invalid path: ${JSON.stringify(args.path)} (only .env or .env.* is editable)`);
    }

    if (!Array.isArray(args.operations)) {
      errs.push('[edit_file] missing required parameter: operations (array)');
      return errs;
    }

    for (let i = 0; i < args.operations.length; i++) {
      const op = args.operations[i];
      const prefix = `[edit_file.operations[${i}]]`;
      if (!isPlainObject(op)) {
        errs.push(`${prefix} must be an object`);
        continue;
      }
      const opName = String(op.op || '').trim();
      if (!opName) {
        errs.push(`${prefix} missing required field: op`);
        continue;
      }
      if (opName === 'set') {
        if (!isNonEmptyString(op.key)) errs.push(`${prefix} (set) missing required field: key (string)`);
        if (!Object.prototype.hasOwnProperty.call(op, 'value')) errs.push(`${prefix} (set) missing required field: value`);
      } else if (opName === 'unset') {
        if (!isNonEmptyString(op.key)) errs.push(`${prefix} (unset) missing required field: key (string)`);
      } else if (opName === 'replace_line') {
        if (!isNonEmptyString(op.match)) errs.push(`${prefix} (replace_line) missing required field: match (string)`);
        if (!isNonEmptyString(op.replacement)) errs.push(`${prefix} (replace_line) missing required field: replacement (string)`);
      } else {
        errs.push(`${prefix} unknown op: ${JSON.stringify(opName)} (allowed: set/unset/replace_line)`);
      }
    }

    return errs;
  }

  // Unknown tool
  errs.push(`Unknown tool: ${tool}`);
  return errs;
}

function validateToolCalls(calls: Array<{ name: string; args: Record<string, any> }>): string[] {
  const errs: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const toolName = String(c?.name || '').trim();
    if (!toolName) {
      errs.push(`[tool_calls[${i}]] missing tool name`);
      continue;
    }
    const per = validateToolCall(toolName, c?.args);
    errs.push(...per.map((e) => `[tool_calls[${i}]] ${e}`));
  }
  return errs;
}

// NOTE: we intentionally use parseStructuredXmlValue/parseXmlArray/parseXmlObject
// (same approach as sentra-mcp/src/utils/fc.js) for safer & more complete decoding.

function parseInvokesFast(toolsXml: string): Array<{ name: string; args: Record<string, any> }> {
  const input = stripCodeFences(toolsXml);
  if (!input) return [];

  const wrapped = /<\s*sentra[-_\s]*tools\b/i.test(input) ? input : `<sentra-tools>${input}</sentra-tools>`;
  let ast: any;
  try {
    ast = getSentraToolsXmlParser().parse(wrapped);
  } catch {
    return [];
  }
  if (!ast || typeof ast !== 'object') return [];

  const root = (ast as any)['sentra-tools'] || (ast as any).sentra_tools || ast;
  if (!root || typeof root !== 'object') return [];

  const invokeRaw = (root as any).invoke;
  if (!invokeRaw) return [];
  const invokeArr = Array.isArray(invokeRaw) ? invokeRaw : [invokeRaw];

  const out: Array<{ name: string; args: Record<string, any> }> = [];
  for (const inv of invokeArr) {
    if (!inv || typeof inv !== 'object') continue;
    const name = String((inv as any)['@_name'] || '').trim();
    if (!name) continue;

    const args: Record<string, any> = {};
    const rawParams = (inv as any).parameter;
    const paramsArr = Array.isArray(rawParams) ? rawParams : (rawParams ? [rawParams] : []);

    for (const p of paramsArr) {
      if (!p || typeof p !== 'object') continue;
      const paramName = String((p as any)['@_name'] || '').trim();
      if (!paramName || Object.prototype.hasOwnProperty.call(args, paramName)) continue;

      const txt = extractAstText(p).trim();
      if (txt.includes('{') || txt.includes('[')) {
        const parsed = safeParseJson(txt);
        if (parsed !== null) {
          args[paramName] = parsed;
          continue;
        }
      }

      args[paramName] = decodeAstTypedValue(p);
    }

    out.push({ name, args });
  }

  return out;
}

function parseInvokesFallback(toolsXml: string): Array<{ name: string; args: Record<string, any> }> {
  const xml = stripCodeFences(toolsXml);
  const invokes: Array<{ name: string; args: Record<string, any> }> = [];

  const lower = xml.toLowerCase();
  let cursor = 0;
  while (true) {
    const invokeStart = lower.indexOf('<invoke', cursor);
    if (invokeStart < 0) break;

    const tagEnd = lower.indexOf('>', invokeStart);
    if (tagEnd < 0) break;

    const openTag = xml.slice(invokeStart, tagEnd + 1);
    const nameMatch = openTag.match(/name\s*=\s*["']([^"']+)["']/i);
    const name = String(nameMatch?.[1] || '').trim();

    const closeStart = lower.indexOf('</invoke', tagEnd + 1);
    if (closeStart < 0) break;
    const closeEnd = lower.indexOf('>', closeStart);
    if (closeEnd < 0) break;

    const body = xml.slice(tagEnd + 1, closeStart);
    cursor = closeEnd + 1;

    const args: Record<string, any> = {};
    const bodyLower = body.toLowerCase();
    let pCursor = 0;

    while (true) {
      const pOpen = bodyLower.indexOf('<parameter', pCursor);
      if (pOpen < 0) break;
      const pOpenEnd = bodyLower.indexOf('>', pOpen);
      if (pOpenEnd < 0) break;

      const pOpenTag = body.slice(pOpen, pOpenEnd + 1);
      const keyMatch = pOpenTag.match(/name\s*=\s*["']([^"']+)["']/i);
      const key = String(keyMatch?.[1] || '').trim();

      let depth = 1;
      let scan = pOpenEnd + 1;
      while (depth > 0) {
        const nextOpen = bodyLower.indexOf('<parameter', scan);
        const nextClose = bodyLower.indexOf('</parameter', scan);
        if (nextClose < 0) {
          depth = 0;
          scan = body.length;
          break;
        }
        if (nextOpen >= 0 && nextOpen < nextClose) {
          depth += 1;
          const nextOpenEnd = bodyLower.indexOf('>', nextOpen);
          scan = nextOpenEnd >= 0 ? nextOpenEnd + 1 : nextOpen + 9;
          continue;
        }

        depth -= 1;
        const nextCloseEnd = bodyLower.indexOf('>', nextClose);
        if (nextCloseEnd < 0) {
          scan = body.length;
          break;
        }
        if (depth === 0) {
          const rawVal = String(body.slice(pOpenEnd + 1, nextClose) || '').trim();
          if (key) {
            const parsed = parseStructuredXmlValue(rawVal);
            if (parsed && parsed.matched) {
              args[key] = (parsed as any).value;
            } else {
              args[key] = inferScalarType(rawVal);
            }
          }
          pCursor = nextCloseEnd + 1;
          break;
        }
        scan = nextCloseEnd + 1;
      }

      if (scan >= body.length) {
        pCursor = body.length;
      }
    }

    if (name) invokes.push({ name, args });
  }

  return invokes;
}

function parseInvokes(toolsXml: string): Array<{ name: string; args: Record<string, any> }> {
  const fast = parseInvokesFast(toolsXml);
  if (fast.length > 0) return fast;
  return parseInvokesFallback(toolsXml);
}

async function callUpstreamOnce(params: {
  upstreamUrl: string;
  apiKey: string;
  body: any;
  signal?: AbortSignal;
}): Promise<string> {
  const res = await fetch(params.upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(params.body),
    signal: params.signal,
  } as any);

  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(text);
  }

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  return String(content || '');
}

function formatSentraResult(step: number, tool: string, reason: string, args: any, data: any, success: boolean): string {
  const argsXml = valueToTypedXml(args ?? null);
  const dataXml = valueToTypedXml(data ?? null);
  return `<sentra-result step="${step}" tool="${escapeXmlText(tool)}" success="${success ? 'true' : 'false'}">\n  <reason>${escapeXmlText(reason || '')}</reason>\n  <arguments>${argsXml}</arguments>\n  <data>${dataXml}</data>\n</sentra-result>`;
}


function disabledWriteFileTool(): { success: boolean; data: any } {
  return {
    success: false,
    data: {
      error: 'write_file is disabled. Use edit_file to apply structured edits (only .env* files are editable).',
    },
  };
}

export async function runDeepwikiSentraXmlAgent(params: {
  input: DeepwikiAgentInput;
  upstreamBaseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  resumeState?: DeepwikiAgentState;
  toolConfirmation?: {
    required: boolean;
    confirmed: boolean;
    toolCalls?: Array<{ name: string; args: Record<string, any> }>;
    toolsXml?: string;
  };
  onEvent?: (ev: any) => void;
}): Promise<DeepwikiAgentOutput> {
  const prompt = loadDeepwikiPrompt();

  const emit = (ev: any) => {
    const fn = params.onEvent;
    if (!fn) return;
    try {
      fn({ ...(ev || {}), at: Date.now() });
    } catch {
      // ignore emit failures
    }
  };

  if (!(globalThis as any).fetch) {
    return {
      finalText: 'DeepWiki Agent 运行失败：当前 Node 运行时未提供 global fetch（请升级到 Node.js 18+ 或为服务端注入 fetch polyfill）。',
      debug: { loops: 0 },
    };
  }

  const normalizedBase = params.upstreamBaseUrl.replace(/\/+$/, '');
  const baseWithV1 = /\/v1$/i.test(normalizedBase) ? normalizedBase : `${normalizedBase}/v1`;
  const upstreamUrl = `${baseWithV1}/chat/completions`;

  const fallbackModel = (process.env.DEEPWIKI_MODEL || process.env.MAIN_AI_MODEL || process.env.MODEL_NAME || '').trim();
  const model = (params.input.model || '').trim() || fallbackModel;
  if (!model) {
    return {
      finalText: 'DeepWiki Agent 运行失败：未配置模型。请在 sentra-config-ui/.env 中设置 DEEPWIKI_MODEL（或 MAIN_AI_MODEL / MODEL_NAME）。',
      debug: { loops: 0 },
    };
  }

  const dynamicToolRules =
    `\n\n可用工具（仅下列这些）：\n` +
    `- read_file(path: string, max_chars?: number)\n` +
    `- list_dir(path: string, recursive?: boolean, max_entries?: number)\n\n` +
    `- edit_file(path: string, operations: array)  // 仅允许编辑 .env* 文件，且必须用 operations 增量修改，禁止整文件覆盖\n` +
    `  operations 支持：\n` +
    `  - { op: "set", key: string, value: any }\n` +
    `  - { op: "unset", key: string }\n` +
    `  - { op: "replace_line", match: string, replacement: string }\n\n` +
    `参数类型规范（MCP / sentra-mcp 风格，必须遵守）：\n` +
    `- 所有 <parameter> 的值优先使用 typed XML：<string>/<number>/<boolean>/<null>/<array>/<object>。\n` +
    `- 禁止把复杂对象/数组直接写成纯文本 JSON（除非包在 <string> 且该参数语义就是“字符串”）。\n` +
    `- 对 edit_file：operations 必须是 typed <array>（不要用 <string> 包 JSON，不要传一个长字符串）。\n\n` +
    `正确示例（edit_file）：\n` +
    `<sentra-tools>\n` +
    `  <invoke name="edit_file">\n` +
    `    <parameter name="path"><string>sentra-config-ui/.env</string></parameter>\n` +
    `    <parameter name="operations">\n` +
    `      <array>\n` +
    `        <object>\n` +
    `          <parameter name="op"><string>set</string></parameter>\n` +
    `          <parameter name="key"><string>DEEPWIKI_MODEL</string></parameter>\n` +
    `          <parameter name="value"><string>gpt-4o-mini</string></parameter>\n` +
    `        </object>\n` +
    `      </array>\n` +
    `    </parameter>\n` +
    `  </invoke>\n` +
    `</sentra-tools>\n\n` +
    `重要：\n` +
    `- 除 .env* 外，其他任何路径一律只读：不得调用 edit_file/write_file 修改。\n` +
    `- 严禁重复调用相同工具+相同参数；如果已经拿到所需信息，应输出 need_tools=false 并给出 <sentra-final>。\n`;

  let messages: Array<{ role: Role; content: any }> = [];
  let trace: DeepwikiAgentTraceItem[] = [];
  let toolCache = new Map<string, { success: boolean; data: any; args: any; tool: string }>();
  let baseLoopsDone = 0;
  let lastToolPlanKey = '';

  if (params.resumeState) {
    messages = Array.isArray(params.resumeState.messages) ? (params.resumeState.messages as any) : [];
    trace = Array.isArray(params.resumeState.trace) ? (params.resumeState.trace as any) : [];
    toolCache = new Map(Array.isArray(params.resumeState.toolCacheEntries) ? params.resumeState.toolCacheEntries : []);
    baseLoopsDone = Number.isFinite(params.resumeState.loopsDone as any) ? Number(params.resumeState.loopsDone) : 0;
    lastToolPlanKey = typeof params.resumeState.lastToolPlanKey === 'string' ? params.resumeState.lastToolPlanKey : '';
  } else {
    const orig = Array.isArray(params.input.messages) ? params.input.messages : [];
    const userQuestion = extractLastUserText(orig);
    const nonSystemHistory = orig.filter((m) => m && m.role !== 'system');
    messages = [
      { role: 'system', content: String(prompt.system || '') + dynamicToolRules },
      ...(nonSystemHistory as any),
      { role: 'user', content: renderTemplate(prompt.user, { user_question: userQuestion }) },
    ];
    trace = [];
    toolCache = new Map();
    baseLoopsDone = 0;
    lastToolPlanKey = '';
  }

  // If user already confirmed a previous <sentra-tools>, execute those tools FIRST,
  // then ask model to continue based on <sentra-result>.
  if (params.toolConfirmation?.confirmed && Array.isArray(params.toolConfirmation.toolCalls) && params.toolConfirmation.toolCalls.length > 0) {
    const calls = params.toolConfirmation.toolCalls;
    const toolsXml = String(params.toolConfirmation.toolsXml || '');

    const validationErrors = validateToolCalls(calls as any);
    if (validationErrors.length > 0) {
      emit({ type: 'error', loop: baseLoopsDone || 1, text: `Invalid confirmed tool calls:\n${validationErrors.join('\n')}` });

      // Do NOT execute invalid tool calls. Ask the model to emit a corrected <sentra-tools>.
      // This will still be gated by tool confirmation (required=true, confirmed=false).
      messages = [
        ...messages,
        ...(toolsXml ? ([{ role: 'assistant' as const, content: toolsXml }] as any) : []),
        {
          role: 'user',
          content:
            'The previously confirmed tool calls are INVALID and must NOT be executed. ' +
            'Please output a corrected <sentra-tools> plan that satisfies ALL required parameters and types. ' +
            'Validation errors:\n' +
            validationErrors.join('\n') +
            '\n\nRules: You must output <sentra-deepwiki> with <need_tools>true</need_tools> and a valid <sentra-tools>.',
        },
      ];
    } else {
      const resultXmlBlocks: string[] = [];

      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        const toolName = c.name;
        const args = c.args || {};
        let success = false;
        let data: any = null;

        emit({ type: 'tool_start', tool: toolName, args, loop: baseLoopsDone || 1 });

        const plugin = getDeepwikiTool(toolName);
        if (plugin) {
          const out = plugin.run(args);
          success = out.success;
          data = out.data;
        } else if (toolName === 'write_file') {
          const out = disabledWriteFileTool();
          success = out.success;
          data = out.data;
        } else {
          success = false;
          data = { error: `Unknown tool: ${toolName}` };
        }

        if (plugin?.cacheable) {
          try {
            toolCache.set(toolCallKey(toolName, args), { success, data, args, tool: toolName });
          } catch {
            // ignore cache failure
          }
        }

        const resultXml = formatSentraResult(i, toolName, 'deepwiki-agent', args, data, success);
        resultXmlBlocks.push(resultXml);
        emit({ type: 'tool_result', tool: toolName, success, loop: baseLoopsDone || 1, data: { raw: resultXml } });
      }

      const toolResults = resultXmlBlocks.join('\n\n');

      // Keep trace continuity: do NOT reset loop to 0 on resume.
      // Ideally attach tool_results_xml to the most recent planning trace item.
      const assumedLoop = baseLoopsDone;
      const last = trace.length > 0 ? trace[trace.length - 1] : null;
      if (last && last.loop === assumedLoop) {
        last.sentra_tools_xml = toolsXml || last.sentra_tools_xml;
        last.tool_calls = calls;
        last.tool_results_xml = toolResults;
      } else {
        trace.push({
          loop: assumedLoop || 1,
          model_output: toolsXml || '<sentra-tools>...</sentra-tools>',
          need_tools: true,
          sentra_tools_xml: toolsXml || undefined,
          tool_calls: calls,
          tool_results_xml: toolResults,
        });
      }

      messages = [
        ...messages,
        ...(toolsXml ? ([{ role: 'assistant' as const, content: toolsXml }] as any) : []),
        { role: 'assistant', content: toolResults },
        {
          role: 'user',
          content:
            '用户已确认执行工具。请基于以上 <sentra-result> 继续。若 edit_file 返回 changed=false，表示无需再次修改（禁止重复调用相同 edit_file）。若工具返回 success=false，请先修正参数/路径/策略后再决定是否需要工具。若仍需要工具：只在确有必要且参数不同的情况下再输出新的 <sentra-tools>（不要重复相同工具+相同参数）；否则输出 need_tools=false 并在 <sentra-final> 给出最终答复。',
        },
      ];
    }
  }

  const maxLoops = Math.max(1, Math.min(6, Number(process.env.DEEPWIKI_AGENT_MAX_LOOPS || 4)));
  const remainingLoops = Math.max(0, maxLoops - baseLoopsDone);
  if (remainingLoops <= 0) {
    return {
      finalText: 'Agent 已达到最大迭代次数（续跑时无剩余轮次），已停止。',
      trace,
      debug: { loops: baseLoopsDone },
    };
  }

  for (let loop = baseLoopsDone; loop < baseLoopsDone + remainingLoops; loop++) {
    const llmBody: any = {
      model,
      temperature: params.input.temperature,
      top_p: params.input.top_p,
      max_tokens: params.input.max_tokens,
      stream: false,
      messages,
    };

    const content = await callUpstreamOnce({
      upstreamUrl,
      apiKey: params.apiKey,
      body: llmBody,
      signal: params.signal,
    });

    const cleaned = stripCodeFences(content);
    let needTools = parseNeedTools(cleaned);

    // Salvage: if model omitted/malformed <need_tools> but emitted <sentra-tools>, treat as need_tools=true.
    // Align with sentra-mcp fc.js relaxed parsing philosophy.
    const toolsBlockCandidate = parseSentraToolsBlock(cleaned);
    if (needTools == null && toolsBlockCandidate) {
      needTools = true;
    }

    // Salvage: if model omitted <need_tools> but emitted <sentra-final>, treat as need_tools=false.
    if (needTools == null) {
      const finalCandidate = parseTag(cleaned, 'sentra-final');
      if (finalCandidate && finalCandidate.trim()) {
        needTools = false;
      }
    }

    const planText = parseTag(cleaned, 'plan');
    if (planText && planText.trim()) {
      emit({ type: 'plan', loop: loop + 1, text: planText.trim() });
    }

    const traceItem: DeepwikiAgentTraceItem = {
      loop: loop + 1,
      model_output: cleaned,
      need_tools: needTools,
    };

    // If model failed to follow protocol, just return raw text
    if (needTools == null) {
      trace.push(traceItem);
      return { finalText: cleaned || content, trace, debug: { loops: loop + 1 } };
    }

    if (!needTools) {
      const final = parseTag(cleaned, 'sentra-final');
      trace.push(traceItem);
      emit({ type: 'final', loop: loop + 1, text: (final && final.trim()) ? final.trim() : cleaned });
      return { finalText: (final && final.trim()) ? final.trim() : cleaned, trace, debug: { loops: loop + 1 } };
    }

    const toolsBlock = toolsBlockCandidate || parseSentraToolsBlock(cleaned);
    if (!toolsBlock) {
      trace.push(traceItem);
      return { finalText: 'Agent 输出 need_tools=true 但缺少 <sentra-tools>，无法继续。', trace, debug: { loops: loop + 1 } };
    }

    const calls = parseInvokes(toolsBlock);
    if (calls.length === 0) {
      trace.push(traceItem);
      return { finalText: 'Agent 输出 <sentra-tools> 但未解析到任何 <invoke>，无法继续。', trace, debug: { loops: loop + 1 } };
    }

    // Required-parameter validation: if invalid, ask the model to regenerate a correct tool plan.
    const validationErrors = validateToolCalls(calls as any);
    if (validationErrors.length > 0) {
      // Normalize to strict typed XML for UI display, but do NOT return action_required.
      const normalizedToolsXml = formatSentraToolsTyped(calls);
      traceItem.sentra_tools_xml = normalizedToolsXml;
      traceItem.tool_calls = calls;
      (traceItem as any).tool_validation_errors = validationErrors;
      trace.push(traceItem);

      emit({ type: 'error', loop: loop + 1, text: `Invalid tool calls (required params / types):\n${validationErrors.join('\n')}` });

      messages = [
        ...messages,
        { role: 'assistant', content: normalizedToolsXml },
        {
          role: 'user',
          content:
            'Your <sentra-tools> output is INVALID. Do NOT repeat the same invalid tool calls. ' +
            'Regenerate a corrected <sentra-tools> that includes ALL required parameters and valid operations. ' +
            'Validation errors:\n' +
            validationErrors.join('\n') +
            '\n\nRemember: If need_tools=true you must output <sentra-tools> and must not output <sentra-final>.'
        },
      ];
      continue;
    }

    // Loop guard: if the model repeats the same tool plan again (common with edit failures), stop early
    // with a clear error so we don't burn maxLoops.
    let planKey = '';
    try {
      const callKeys = calls.map((c) => toolCallKey(c.name, c.args || {})).sort();
      planKey = JSON.stringify(callKeys);
    } catch {
      planKey = String(toolsBlock || '');
    }
    if (planKey && lastToolPlanKey && planKey === lastToolPlanKey) {
      trace.push(traceItem);
      return {
        finalText:
          'Agent 检测到重复输出完全相同的工具调用计划（可能是 edit_file 参数/策略/结果未生效导致）。已停止以避免无限循环。请检查上一条 <sentra-result> 的 success/changed/warnings，并调整 operations（避免再次输出相同工具+相同参数）。',
        trace,
        debug: { loops: loop + 1 },
      };
    }
    lastToolPlanKey = planKey;

    // Normalize to strict typed XML for UI display & confirmation.
    const normalizedToolsXml = formatSentraToolsTyped(calls);
    traceItem.sentra_tools_xml = normalizedToolsXml;

    traceItem.tool_calls = calls;

    // Tool confirmation gate: if confirmation is required, ALWAYS stop before executing
    // newly generated tool calls. The only exception is the pre-loop execution of an
    // explicitly confirmed tool batch (handled above).
    if (params.toolConfirmation?.required) {
      trace.push(traceItem);
      emit({ type: 'action_required', loop: loop + 1, toolCalls: calls });
      const agentState: DeepwikiAgentState = {
        messages,
        trace,
        toolCacheEntries: Array.from(toolCache.entries()),
        loopsDone: loop + 1,
        model,
        lastToolPlanKey,
      };
      return {
        finalText:
          '已生成工具调用计划，但需要你确认后才会执行。请在对话框中查看本次将执行的工具与参数，并点击“确认执行”。',
        trace,
        actionRequired: true,
        pendingToolCalls: calls,
        pendingToolsXml: normalizedToolsXml,
        agentState,
        debug: { loops: loop + 1 },
      };
    }

    const resultXmlBlocks: string[] = [];

    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const toolName = c.name;
      const args = c.args || {};

      emit({ type: 'tool_start', tool: toolName, args, loop: loop + 1 });

      let success = false;
      let data: any = null;

      const plugin = getDeepwikiTool(toolName);
      const canCache = !!plugin?.cacheable;
      const cacheKey = canCache ? toolCallKey(toolName, args) : '';
      const cached = canCache ? toolCache.get(cacheKey) : undefined;
      if (cached) {
        success = cached.success;
        data = cached.data;
        const resultXml = formatSentraResult(i, toolName, 'deepwiki-agent (cached)', args, data, success);
        resultXmlBlocks.push(resultXml);
        emit({ type: 'tool_result', tool: toolName, success, loop: loop + 1, data: { raw: resultXml } });
        continue;
      }

      if (plugin) {
        const out = plugin.run(args);
        success = out.success;
        data = out.data;
      } else if (toolName === 'write_file') {
        const out = disabledWriteFileTool();
        success = out.success;
        data = out.data;
      } else {
        success = false;
        data = { error: `Unknown tool: ${toolName}` };
      }

      if (canCache) {
        toolCache.set(cacheKey, { success, data, args, tool: toolName });
      }

      const resultXml = formatSentraResult(i, toolName, 'deepwiki-agent', args, data, success);
      resultXmlBlocks.push(resultXml);
      emit({ type: 'tool_result', tool: toolName, success, loop: loop + 1, data: { raw: resultXml } });
    }

    const toolResults = resultXmlBlocks.join('\n\n');

    traceItem.tool_results_xml = toolResults;
    trace.push(traceItem);

    messages = [
      ...messages,
      { role: 'assistant', content: normalizedToolsXml },
      { role: 'assistant', content: toolResults },
      {
        role: 'user',
        content:
          '请基于以上 <sentra-result> 继续。若 edit_file 返回 changed=false，表示无需再次修改（禁止重复调用相同 edit_file）。若工具返回 success=false，请先修正参数/路径/策略后再决定是否需要工具。若仍需要工具：只在确有必要且参数不同的情况下再输出新的 <sentra-tools>（不要重复相同工具+相同参数）；否则输出 need_tools=false 并在 <sentra-final> 给出最终答复。',
      },
    ];
  }

  return {
    finalText:
      'Agent 达到最大迭代次数仍未产出 <sentra-final>，已停止。\n\n（调试提示：通常是反复 need_tools=true。请查看 agent_trace 最后一轮的 tool_results_xml，确认 success=false 或 changed=false 的原因，并据此调整 operations/路径/策略。）',
    trace,
    debug: { loops: maxLoops },
  };
}
