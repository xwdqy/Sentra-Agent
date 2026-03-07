/**
 * Sentra protocol utilities.
 * Includes builders/parsers for <sentra-result>, <sentra-input>, and <sentra-message>.
 */

import { jsonToXMLLines, extractXMLTag, extractFilesFromContent, valueToXMLString, extractFullXMLTag, extractAllFullXMLTags, escapeXmlAttr, unescapeXml, stripTypedValueWrapper, extractXmlAttrValue, extractInnerXmlFromFullTag, getFastXmlParser } from './xmlUtils.js';
import { createLogger } from './logger.js';
import type { ChatMessage } from '../src/types.js';

const logger = createLogger('ProtocolUtils');

export interface SentraMessageResource {
  type: string;
  source: string;
  caption?: string | undefined;
  segment_index?: number | undefined;
}

export interface SentraMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface ParsedSentraMessage {
  message: SentraMessageSegment[];
  textSegments: string[];
  resources: SentraMessageResource[];
  group_id?: string | undefined;
  user_id?: string | undefined;
  chat_type?: 'group' | 'private' | string;
  sender_id?: string | undefined;
  sender_name?: string | undefined;
  message_id?: string | undefined;
  shouldSkip?: boolean;
}

type AnyRecord = Record<string, unknown>;
type XmlRecord = Record<string, unknown>;

type ParamValue =
  | string
  | number
  | boolean
  | null
  | ParamValue[]
  | { [key: string]: ParamValue };

type ToolInvocationArgsContent = { aiName: string; argsContent: string };
type ToolInvocationArgsObject = { aiName: string; args?: Record<string, ParamValue> };

type ToolResultEvent = {
  type?: 'tool_result' | string;
  aiName?: string;
  stepId?: string;
  plannedStepIndex?: number;
  stepIndex?: number;
  resultStatus?: string;
  dependsOnStepIds?: string[];
  dependedByStepIds?: string[];
  dependsNote?: string;
  reason?: string;
  result?: { data?: unknown; success?: boolean; code?: string; provider?: string } | unknown;
  [key: string]: unknown;
};

type ToolResultGroupEvent = ToolResultEvent & {
  type?: 'tool_result_group' | string;
  groupId?: string | number;
  groupSize?: number;
  orderStepIds?: string[];
  events?: ToolResultEvent[];
};

type RawUserMeta = { summary?: string; text?: string; time_str?: string };
export type MergedUser = {
  sender_id?: string | number | null;
  sender_name?: string;
  name?: string;
  nickname?: string;
  message_id?: string | number | null;
  text?: string;
  summary?: string;
  raw?: RawUserMeta;
  time_str?: string;
};
export type UserQuestionMessage = {
  type?: string;
  group_id?: string | number | null;
  sender_id?: string | number | null;
  sender_name?: string;
  message_id?: string | number | null;
  text?: string;
  raw?: RawUserMeta;
  time_str?: string;
  _merged?: boolean;
  _mergedUsers?: MergedUser[];
  _mergedPrimarySenderId?: string | number;
  [key: string]: unknown;
};

type SentraMessagePacket = {
  group_id?: string | number;
  user_id?: string | number;
  chat_type?: 'group' | 'private' | string;
  sender_id?: string | number;
  sender_name?: string;
  message_id?: string | number;
  message?: Array<{ type?: string; data?: Record<string, unknown> }>;
};

const SUPPORTED_SENTRA_MESSAGE_SEGMENT_TYPES = new Set([
  'text',
  'reply',
  'at',
  'image',
  'file',
  'video',
  'record',
  'music',
  'poke',
  'recall'
]);

function safeInt(v: unknown, fallback: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function getXmlParser() {
  return getFastXmlParser();
}

function getTextNode(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    if (typeof v['#text'] === 'string') return v['#text'];
  }
  return '';
}

function normalizeToArray<T = any>(v: any): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function parseTypedArrayValue(node: any): any[] {
  if (node == null) return [];
  const out: any[] = [];
  const typedKeys = ['string', 'number', 'boolean', 'null', 'array', 'object'];

  const pushTyped = (key: string, value: any) => {
    if (key === 'string') {
      out.push(stripTypedValueWrapper(unescapeXml(getTextNode(value))).trim());
      return;
    }
    if (key === 'number') {
      out.push(inferScalarForParam(stripTypedValueWrapper(unescapeXml(getTextNode(value)))));
      return;
    }
    if (key === 'boolean') {
      out.push(parseBooleanLike(stripTypedValueWrapper(unescapeXml(getTextNode(value)))));
      return;
    }
    if (key === 'null') {
      out.push(null);
      return;
    }
    if (key === 'array') {
      out.push(parseTypedArrayValue(value));
      return;
    }
    if (key === 'object') {
      out.push(parseTypedObjectValue(value));
    }
  };

  if (Array.isArray(node)) {
    for (const part of node) {
      out.push(...parseTypedArrayValue(part));
    }
    return out;
  }

  if (typeof node !== 'object') {
    out.push(inferScalarForParam(String(node)));
    return out;
  }

  const itemNodes = normalizeToArray((node as AnyRecord).item);
  if (itemNodes.length > 0) {
    for (const itemNode of itemNodes) {
      out.push(parseTypedValue(itemNode));
    }
    return out;
  }

  for (const key of typedKeys) {
    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
    const values = normalizeToArray((node as AnyRecord)[key]);
    for (const value of values) pushTyped(key, value);
  }

  return out;
}

function parseTypedObjectValue(node: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!node || typeof node !== 'object') return out;
  const params = normalizeToArray((node as AnyRecord).parameter);
  for (const p of params) {
    if (!p || typeof p !== 'object') continue;
    const key = String((p as AnyRecord).name || '').trim();
    if (!key) continue;
    out[key] = parseTypedValue(p);
  }
  return out;
}

function parseTypedValue(paramObj: any): any {
  if (!paramObj || typeof paramObj !== 'object') return '';
  if (paramObj.null !== undefined) return null;
  if (paramObj.boolean !== undefined) return parseBooleanLike(stripTypedValueWrapper(unescapeXml(getTextNode(paramObj.boolean))));
  if (paramObj.number !== undefined) return inferScalarForParam(stripTypedValueWrapper(unescapeXml(getTextNode(paramObj.number))));
  if (paramObj.string !== undefined) return stripTypedValueWrapper(unescapeXml(getTextNode(paramObj.string))).trim();
  if (paramObj.array !== undefined) return parseTypedArrayValue(paramObj.array);
  if (paramObj.object !== undefined) return parseTypedObjectValue(paramObj.object);
  return '';
}

function pickFirstTypedValue(paramObj: any): any {
  const typedValue = parseTypedValue(paramObj);
  if (typedValue !== '') return typedValue;

  // Fallback: treat inner text as scalar
  const raw = stripTypedValueWrapper(unescapeXml(getTextNode(paramObj)));
  if (raw) return inferScalarForParam(raw);
  return '';
}

function xmlNodeToJs(value: any): any {
  if (value == null) return null;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return inferScalarForParam(String(value));
  }

  if (Array.isArray(value)) {
    return value.map((v) => xmlNodeToJs(v));
  }

  if (typeof value !== 'object') {
    return inferScalarForParam(String(value));
  }

  const keys = Object.keys(value);
  const hasItem = Object.prototype.hasOwnProperty.call(value, 'item');
  if (hasItem) {
    const items = normalizeToArray(value.item);
    const arr = [];
    for (const it of items) {
      if (it == null) continue;
      if (typeof it !== 'object') {
        arr.push(inferScalarForParam(String(it)));
        continue;
      }
      const idxRaw = it.index != null ? String(it.index) : '';
      const idx = idxRaw && /^\d+$/.test(idxRaw) ? safeInt(idxRaw, -1) : null;
      const copy = { ...it };
      delete copy.index;
      const v = xmlNodeToJs(copy);
      if (idx == null) arr.push(v);
      else arr[idx] = v;
    }
    return arr;
  }

  const obj: Record<string, any> = {};
  const text = (value['#text'] != null) ? String(value['#text']).trim() : '';

  // Special handling for <field name="...">...</field>
  if (Object.prototype.hasOwnProperty.call(value, 'field')) {
    const fields = normalizeToArray(value.field);
    for (const f of fields) {
      if (!f || typeof f !== 'object') continue;
      const k = f.name != null ? String(f.name) : '';
      if (!k) continue;
      const copy = { ...f };
      delete copy.name;
      const v = xmlNodeToJs(copy);
      obj[k] = v;
    }
  }

  for (const k of keys) {
    if (k === '#text' || k === 'field' || k === 'name' || k === 'index') continue;
    const raw = value[k];
    if (raw == null) continue;

    if (Array.isArray(raw)) {
      obj[k] = raw.map((v) => xmlNodeToJs(v));
    } else {
      obj[k] = xmlNodeToJs(raw);
    }
  }

  // Pure text node
  if (Object.keys(obj).length === 0 && text) {
    return inferScalarForParam(text);
  }

  return obj;
}

function parseArgsContentToObject(argsContent: any): any {
  const trimmed = String(argsContent || '').trim();
  if (!trimmed) return null;

  try {
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch { }

  try {
    const doc = getXmlParser().parse(`<root>${trimmed}</root>`);
    const root = doc?.root;
    if (!root || typeof root !== 'object') return null;
    const payload = root.args && typeof root.args === 'object' ? root.args : root;
    const obj = xmlNodeToJs(payload);
    if (obj && typeof obj === 'object') return obj;
    return null;
  } catch {
    return null;
  }
}

// 鍐呴儴锛氬皢 JS 鍊兼覆鏌撲负鍙傛暟 <parameter> 鐨勬枃鏈?
function paramValueToText(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // 瀵硅薄/鏁扮粍锛氱敤 JSON 瀛楃涓茶〃杈?
  try { return JSON.stringify(v); } catch { return String(v); }
}

// 鍐呴儴锛氬皢 args 瀵硅薄娓叉煋涓?XML 瀛愬厓绱狅紙鐢ㄤ簬 <args> 鎴?<sentra-tools><parameter>锛?
function argsObjectToParamEntries(args: any = {}): Array<{ name: string; value: string }> {
  const out = [];
  try {
    for (const [k, v] of Object.entries(args || {})) {
      out.push({ name: k, value: paramValueToText(v) });
    }
  } catch { }
  return out;
}

function parseBooleanLike(s: any): boolean | null {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return null;
  if (t === 'true' || t === '1' || t === 'yes') return true;
  if (t === 'false' || t === '0' || t === 'no') return false;
  return null;
}

export function parseReplyGateDecisionFromSentraTools(text: unknown): any {
  const s = typeof text === 'string' ? text : '';
  if (!s || !s.includes('<sentra-tools>')) return null;

  let last = null;

  try {
    const toolsBlocks = extractAllFullXMLTags(s, 'sentra-tools');
    for (const tb of toolsBlocks) {
      const doc = getXmlParser().parse(`<root>${tb}</root>`);
      const tools = doc?.root?.['sentra-tools'];
      if (!tools) continue;
      const invokes = normalizeToArray(tools.invoke);
      for (const invoke of invokes) {
        const name = String(invoke?.name || '').trim();
        if (name !== 'reply_gate_decision') continue;

        let enter = null;
        let action = '';
        let delayWhen = '';
        let reason = '';
        const params = normalizeToArray(invoke?.parameter);
        for (const p of params) {
          const pName = String(p?.name || '').trim();
          if (!pName) continue;
          if (pName === 'enter') {
            const v = pickFirstTypedValue(p);
            if (typeof v === 'boolean') enter = v;
            continue;
          }
          if (pName === 'reason') {
            const v = pickFirstTypedValue(p);
            reason = String(v ?? '').trim();
            continue;
          }
          if (pName === 'action') {
            const v = pickFirstTypedValue(p);
            action = String(v ?? '').trim().toLowerCase();
            continue;
          }
          if (pName === 'delay_when') {
            const v = pickFirstTypedValue(p);
            delayWhen = String(v ?? '').trim();
          }
        }
        if (typeof enter !== 'boolean') continue;
        if (!action) {
          action = enter ? 'action' : 'silent';
        }
        if (action === 'silent') enter = false;
        else enter = true;
        last = { enter, action, delayWhen, reason, invokeName: name };
      }
    }
  } catch { }

  if (last) return last;

  try {
    const toolsBlocks = extractAllFullXMLTags(s, 'sentra-tools');
    for (const tb of toolsBlocks) {
      const invokes = extractAllFullXMLTags(tb, 'invoke');
      for (const invokeXml of invokes) {
        const name = (extractXmlAttrValue(invokeXml, 'name') || '').trim();
        if (name !== 'reply_gate_decision') continue;

        let enter = null;
        let action = '';
        let delayWhen = '';
        let reason = '';

        const params = extractAllFullXMLTags(invokeXml, 'parameter');
        for (const p of params) {
          const pName = (extractXmlAttrValue(p, 'name') || '').trim();
          if (!pName) continue;

          const paramInner = extractInnerXmlFromFullTag(p, 'parameter');

          if (pName === 'enter') {
            const boolText = extractXMLTag(p, 'boolean');
            const raw = boolText != null ? boolText : paramInner;
            const parsed = parseBooleanLike(stripTypedValueWrapper(unescapeXml(raw || '')));
            if (typeof parsed === 'boolean') {
              enter = parsed;
            }
            continue;
          }

          if (pName === 'reason') {
            const strText = extractXMLTag(p, 'string');
            const raw = strText != null ? strText : paramInner;
            reason = stripTypedValueWrapper(unescapeXml(raw || '')).trim();
            continue;
          }

          if (pName === 'action') {
            const strText = extractXMLTag(p, 'string');
            const raw = strText != null ? strText : paramInner;
            action = stripTypedValueWrapper(unescapeXml(raw || '')).trim().toLowerCase();
            continue;
          }

          if (pName === 'delay_when') {
            const strText = extractXMLTag(p, 'string');
            const raw = strText != null ? strText : paramInner;
            delayWhen = stripTypedValueWrapper(unescapeXml(raw || '')).trim();
          }
        }

        if (typeof enter !== 'boolean') continue;
        if (!action) {
          action = enter ? 'action' : 'silent';
        }
        if (action === 'silent') enter = false;
        else enter = true;
        last = { enter, action, delayWhen, reason, invokeName: name };
      }
    }
  } catch { }

  return last;
}

export function parseSentraToolsInvocations(text: unknown): Array<{ aiName: string; args: AnyRecord }> {
  const s = String(text || '').trim();
  if (!s) return [];

  const maybeParseJson = (v: unknown) => {
    if (v == null) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v;
    if (typeof v === 'object') return v;
    const t = String(v).trim();
    if (!t) return '';
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    }
    return t;
  };

  const out: Array<{ aiName: string; args: AnyRecord }> = [];
  try {
    const toolsBlocks = extractAllFullXMLTags(s, 'sentra-tools');
    const blocks = toolsBlocks.length > 0 ? toolsBlocks : [s];
    for (const tb of blocks) {
      if (!tb || !String(tb).includes('<sentra-tools')) continue;
      const doc = getXmlParser().parse(`<root>${tb}</root>`);
      const tools = doc?.root?.['sentra-tools'];
      if (!tools) continue;
      const invokes = normalizeToArray(tools.invoke);
      for (const invoke of invokes) {
        const name = String(invoke?.name || '').trim();
        if (!name) continue;
        const args: AnyRecord = {};
        const params = normalizeToArray(invoke?.parameter);
        for (const p of params) {
          const pName = String(p?.name || '').trim();
          if (!pName) continue;
          const v = pickFirstTypedValue(p);
          args[pName] = maybeParseJson(v);
        }
        out.push({ aiName: name, args });
      }
    }
  } catch {
    return [];
  }

  return out;
}

/**
 * 鏋勫缓 Sentra XML 鍧楋細
 * - tool_result -> <sentra-result>
 * - tool_result_group -> <sentra-result-group> 鍖呭惈澶氫釜 <sentra-result>
 */
export function buildSentraResultBlock(ev: ToolResultEvent | ToolResultGroupEvent): string {
  try {
    const type = ev?.type;
    if (type === 'tool_result') {
      return buildSingleResultXML(ev);
    }
    if (type === 'tool_result_group' && Array.isArray(ev?.events)) {
      const gid = ev.groupId != null ? String(ev.groupId) : '';
      const gsize = Number(ev.groupSize || ev.events.length);
      const events = Array.isArray(ev.events) ? ev.events : [];
      const orderStepIds = resolveOrderStepIds(ev, events);
      const groupStatusRaw = typeof ev?.resultStatus === 'string' ? ev.resultStatus : '';
      const groupStatus = String(groupStatusRaw).toLowerCase() === 'final' ? 'final' : 'progress';
      const lines = [
        '<sentra-result-group>',
        `  <step_group_id>${valueToXMLString(gid, 0)}</step_group_id>`,
        `  <group_size>${valueToXMLString(gsize, 0)}</group_size>`,
        `  <order_step_ids>${valueToXMLString(orderStepIds.join(','), 0)}</order_step_ids>`,
        `  <status>${valueToXMLString(groupStatus, 0)}</status>`
      ];
      for (const item of events) {
        const xml = buildSingleResultXML({
          ...(item && typeof item === 'object' ? item : {}),
          resultStatus: (item && typeof item === 'object' && typeof item.resultStatus === 'string')
            ? item.resultStatus
            : groupStatus
        });
        const indented = xml.split('\n').map(l => `  ${l}`).join('\n');
        lines.push(indented);
      }
      // 闄勫甫涓€娆℃€ф彁鍙栧埌鐨勬枃浠惰祫婧愶紙鍙€夛級
      const collected: Array<{ key: string; path: string }> = [];
      events.forEach((item: ToolResultEvent, idx: number) => {
        if (!item || !item.result) return;
        const root = item.result && (item.result as { data?: unknown }).data !== undefined
          ? (item.result as { data?: unknown }).data
          : item.result;
        if (!root || typeof root !== 'object') return;
        const fromResult = extractFilesFromContent(root, ['events', idx, 'result']);
        collected.push(...fromResult);
      });

      // 鍘婚噸锛氭寜 path 鑱氬悎锛岄伩鍏嶅悓涓€鏂囦欢琚娆″寘鍚?
      const seenPaths = new Set();
      const files: Array<{ key: string; path: string }> = [];
      for (const f of collected) {
        const p = (f && typeof f.path === 'string') ? f.path.trim() : '';
        if (!p || seenPaths.has(p)) continue;
        seenPaths.add(p);
        files.push(f);
      }

      if (files.length > 0) {
        lines.push('  <extracted_files>');
        for (const f of files) {
          lines.push('    <file>');
          lines.push(`      <key>${f.key}</key>`);
          lines.push(`      <path>${valueToXMLString(f.path, 0)}</path>`);
          lines.push('    </file>');
        }
        lines.push('  </extracted_files>');
      }
      lines.push('</sentra-result-group>');
      return lines.join('\n');
    }
    return '';
  } catch (e) {
    // 鍙戠敓寮傚父鏃惰繑鍥?JSON 鍖呰９锛岄伩鍏嶇粓姝富娴佺▼
    try { return `<sentra-result>${valueToXMLString(JSON.stringify(ev), 0)}</sentra-result>`; } catch { return '<sentra-result></sentra-result>'; }
  }
}

// 鍐呴儴锛氭瀯寤哄崟涓?<sentra-result>锛堢粺涓€瀛楁锛?
function resolveStepId(ev: ToolResultEvent): string {
  const fromEvent = typeof ev?.stepId === 'string' ? ev.stepId.trim() : '';
  if (fromEvent) return fromEvent;
  const idx = Number(ev?.plannedStepIndex ?? ev?.stepIndex ?? 0);
  return Number.isFinite(idx) ? `step_${idx}` : 'step_0';
}

function resolveOrderStepIds(ev: ToolResultGroupEvent, events: ToolResultEvent[]): string[] {
  const fromEvent = Array.isArray(ev?.orderStepIds)
    ? ev.orderStepIds.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
    : [];
  if (fromEvent.length > 0) return fromEvent;
  return events.map((item) => resolveStepId(item));
}

function buildSingleResultXML(ev: ToolResultEvent): string {
  const aiName = ev?.aiName || '';
  const stepId = resolveStepId(ev);
  const reason = Array.isArray(ev?.reason) ? ev.reason.join('; ') : (ev?.reason || '');
  const result = (ev && ev.result && typeof ev.result === 'object')
    ? (ev.result as Record<string, unknown>)
    : null;
  const success = result?.success === true;
  const statusRaw = typeof ev?.resultStatus === 'string' ? ev.resultStatus : '';
  const status = String(statusRaw).toLowerCase() === 'final' ? 'final' : 'progress';
  const code = typeof result?.code === 'string' ? result.code : '';
  const toolMeta = (ev && ev.toolMeta && typeof ev.toolMeta === 'object')
    ? (ev.toolMeta as Record<string, unknown>)
    : null;
  const provider = typeof result?.provider === 'string'
    ? result.provider
    : (toolMeta && typeof toolMeta.provider === 'string' ? toolMeta.provider : '');
  const data = result && Object.prototype.hasOwnProperty.call(result, 'data')
    ? result.data
    : (ev?.result ?? null);

  const err = result && Object.prototype.hasOwnProperty.call(result, 'error') ? result.error : undefined;
  const extra: AnyRecord = {};
  if (result) {
    if (Object.prototype.hasOwnProperty.call(result, 'advice')) extra.advice = result.advice;
    if (Object.prototype.hasOwnProperty.call(result, 'detail')) extra.detail = result.detail;
  }

  const lines = [
    '<sentra-result>',
    `  <step_id>${valueToXMLString(stepId, 0)}</step_id>`,
    `  <tool>${valueToXMLString(aiName, 0)}</tool>`,
    `  <success>${success}</success>`,
    `  <status>${valueToXMLString(status, 0)}</status>`
  ];
  if (reason) lines.push(`  <reason>${valueToXMLString(reason, 0)}</reason>`);
  // 鍚屾椂杈撳嚭 <aiName> 浠ヤ究鏃цВ鏋愬櫒鍏煎
  lines.push(`  <aiName>${valueToXMLString(aiName, 0)}</aiName>`);
  try {
    const completion = ev?.completion as { state?: string; mustAnswerFromResult?: boolean; instruction?: string } | undefined;
    if (completion && typeof completion === 'object') {
      const state = typeof completion.state === 'string' ? completion.state : '';
      const must = completion.mustAnswerFromResult === true;
      const instr = typeof completion.instruction === 'string' ? completion.instruction : '';
      lines.push('  <completion>');
      if (state) lines.push(`    <state>${valueToXMLString(state, 0)}</state>`);
      lines.push(`    <must_answer_from_result>${must}</must_answer_from_result>`);
      if (instr) lines.push(`    <instruction>${valueToXMLString(instr, 0)}</instruction>`);
      lines.push('  </completion>');
    }
  } catch { }
  // args锛氬悓鏃舵彁渚涚粨鏋勫寲涓?JSON 涓ょ琛ㄧず
  // result锛氭媶涓?success/code/data/provider
  lines.push('  <result>');
  lines.push(`    <success>${success}</success>`);
  if (code) lines.push(`    <code>${valueToXMLString(code, 0)}</code>`);
  if (provider) lines.push(`    <provider>${valueToXMLString(provider, 0)}</provider>`);
  try {
    lines.push('    <data>');
    lines.push(...jsonToXMLLines(data, 3, 0, 6));
    lines.push('    </data>');
  } catch {
    try { lines.push(`    <data>${valueToXMLString(JSON.stringify(data), 0)}</data>`); } catch { }
  }

  if (err) {
    try {
      lines.push('    <error>');
      lines.push(...jsonToXMLLines(err, 3, 0, 6));
      lines.push('    </error>');
    } catch {
      try { lines.push(`    <error>${valueToXMLString(JSON.stringify(err), 0)}</error>`); } catch { }
    }
  }

  try {
    if (Object.keys(extra).length > 0) {
      lines.push('    <extra>');
      lines.push(...jsonToXMLLines(extra, 3, 0, 6));
      lines.push('    </extra>');
    }
  } catch { }
  lines.push('  </result>');

  // 闄勫甫渚夸簬璋冭瘯鐨勫厓淇℃伅锛堝彲閫夛級
  if (Array.isArray(ev?.dependsOnStepIds) || Array.isArray(ev?.dependedByStepIds)) {
    lines.push('  <dependencies>');
    if (Array.isArray(ev.dependsOnStepIds)) lines.push(`    <depends_on_step_ids>${ev.dependsOnStepIds.join(',')}</depends_on_step_ids>`);
    if (Array.isArray(ev.dependedByStepIds)) lines.push(`    <depended_by_step_ids>${ev.dependedByStepIds.join(',')}</depended_by_step_ids>`);
    if (ev.dependsNote) lines.push(`    <note>${valueToXMLString(ev.dependsNote, 0)}</note>`);
    lines.push('  </dependencies>');
  }

  // 闄勫甫鏂囦欢璺緞锛堝彲閫夛級
  const fileRoot = result && Object.prototype.hasOwnProperty.call(result, 'data')
    ? result.data
    : ev?.result;
  const files = fileRoot ? extractFilesFromContent(fileRoot) : [];
  lines.push('  <extracted_files>');
  if (files.length > 0) {
    for (const f of files) {
      lines.push('    <file>');
      lines.push(`      <key>${f.key}</key>`);
      lines.push(`      <path>${valueToXMLString(f.path, 0)}</path>`);
      lines.push('    </file>');
    }
  } else {
    lines.push('    <no_resource>true</no_resource>');
  }
  lines.push('  </extracted_files>');

  lines.push('</sentra-result>');
  return lines.join('\n');
}

/**
 * Message protocol helpers.
 */
function isPositiveIntegerString(value: string): boolean {
  const s = String(value || '').trim();
  if (!/^\d+$/.test(s)) return false;
  try {
    return BigInt(s) > 0n;
  } catch {
    const n = Number(s);
    return Number.isFinite(n) && n > 0;
  }
}

function trimStringDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((v) => trimStringDeep(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = trimStringDeep(v);
    }
    return out;
  }
  return value;
}

function normalizeSegmentMessageId(value: unknown): string {
  if (value == null) return '';
  const s = String(value).trim();
  if (!s || s === '0') return '';
  return s;
}

function withSegmentMessageId(
  segments: Array<{ type?: string; data?: Record<string, unknown> }>,
  messageId: unknown
): Array<{ type?: string; data?: Record<string, unknown> }> {
  const normalized = normalizeSegmentMessageId(messageId);
  if (!normalized) return segments;
  return segments.map((seg) => {
    const data = seg && seg.data && typeof seg.data === 'object'
      ? { ...seg.data }
      : {};
    data.message_id = normalized;
    return { ...seg, data };
  });
}

type SentraInputBuildOptions = {
  currentMessage?: Record<string, unknown> | null;
  pendingMessagesXml?: string;
  historyMessagesXml?: string;
  toolResultsXml?: string;
};

function normalizeMessageSegments(msg: Record<string, unknown> | null | undefined): Array<{ type: string; data: Record<string, unknown> }> {
  if (!msg || typeof msg !== 'object') return [];
  const rawSegs = Array.isArray(msg.message)
    ? msg.message
    : (Array.isArray(msg.segments) ? msg.segments : []);
  const out: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (const seg of rawSegs) {
    if (!seg || typeof seg !== 'object') continue;
    const s = seg as { type?: unknown; data?: unknown };
    const type = typeof s.type === 'string' ? s.type.trim().toLowerCase() : '';
    if (!type) continue;
    const rawData = s.data && typeof s.data === 'object' ? s.data as Record<string, unknown> : {};
    const data = trimStringDeep(rawData) as Record<string, unknown>;
    out.push({ type, data });
  }
  if (out.length > 0) return out;

  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (text) return [{ type: 'text', data: { text } }];
  return [];
}

function normalizeObjectArray(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    out.push(trimStringDeep(item) as Record<string, unknown>);
  }
  return out;
}

function mergeUniqueObjects(
  primary: Array<Record<string, unknown>>,
  secondary: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const pushOne = (item: Record<string, unknown>) => {
    try {
      const key = JSON.stringify(item);
      if (seen.has(key)) return;
      seen.add(key);
    } catch {
      // ignore dedup on stringify failure
    }
    out.push(item);
  };

  for (const item of primary) pushOne(item);
  for (const item of secondary) pushOne(item);
  return out;
}

function pickCurrentForwards(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  const own = normalizeObjectArray((msg as any).forwards);
  const replyMedia = (msg as any).reply && typeof (msg as any).reply === 'object'
    ? ((msg as any).reply as Record<string, unknown>).media
    : undefined;
  const reply = replyMedia && typeof replyMedia === 'object'
    ? normalizeObjectArray((replyMedia as Record<string, unknown>).forwards)
    : [];
  return mergeUniqueObjects(own, reply);
}

function pickCurrentCards(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  const own = normalizeObjectArray((msg as any).cards);
  const replyMedia = (msg as any).reply && typeof (msg as any).reply === 'object'
    ? ((msg as any).reply as Record<string, unknown>).media
    : undefined;
  const reply = replyMedia && typeof replyMedia === 'object'
    ? normalizeObjectArray((replyMedia as Record<string, unknown>).cards)
    : [];
  return mergeUniqueObjects(own, reply);
}

function emitInputSection(lines: string[], tag: string, raw: unknown) {
  const content = typeof raw === 'string' ? raw.trim() : '';
  if (!content) return;
  if (content.includes(`<${tag}>`) && content.includes(`</${tag}>`)) {
    lines.push(content);
    return;
  }
  lines.push(`  <${tag}>`);
  lines.push(content);
  lines.push(`  </${tag}>`);
}

export function buildSentraInputBlock({
  currentMessage,
  pendingMessagesXml = '',
  historyMessagesXml = '',
  toolResultsXml = ''
}: SentraInputBuildOptions = {}): string {
  const msg = currentMessage && typeof currentMessage === 'object' ? currentMessage : {};
  const lines: string[] = ['<sentra-input>'];

  lines.push('  <current_messages>');
  lines.push('    <sentra-message>');
  const typeRaw = typeof msg.type === 'string' ? msg.type.trim().toLowerCase() : '';
  const chatType = typeRaw === 'group' || typeRaw === 'private'
    ? typeRaw
    : (msg.group_id != null ? 'group' : (msg.sender_id != null ? 'private' : ''));
  if (chatType) lines.push(`    <chat_type>${valueToXMLString(chatType, 0)}</chat_type>`);

  const groupId = msg.group_id != null ? String(msg.group_id).trim() : '';
  const senderId = msg.sender_id != null ? String(msg.sender_id).trim() : '';
  if (chatType === 'group' && groupId && isPositiveIntegerString(groupId)) {
    lines.push(`    <group_id>${valueToXMLString(groupId, 0)}</group_id>`);
  } else if (chatType === 'private' && senderId && isPositiveIntegerString(senderId)) {
    lines.push(`    <user_id>${valueToXMLString(senderId, 0)}</user_id>`);
  }
  if (senderId && isPositiveIntegerString(senderId)) {
    lines.push(`    <sender_id>${valueToXMLString(senderId, 0)}</sender_id>`);
  }

  const senderName = typeof msg.sender_name === 'string' ? msg.sender_name.trim() : '';
  if (senderName) lines.push(`    <sender_name>${valueToXMLString(senderName, 0)}</sender_name>`);

  const eventType = typeof (msg as any).event_type === 'string'
    ? String((msg as any).event_type).trim().toLowerCase()
    : '';
  const isPokeEvent = eventType === 'poke';
  const messageId = msg.message_id != null ? String(msg.message_id).trim() : '';

  lines.push('    <message>');
  const rawSegs = normalizeMessageSegments(msg);
  const segs = isPokeEvent ? rawSegs : withSegmentMessageId(rawSegs, messageId);
  let idx = 1;
  for (const seg of segs) {
    lines.push(`      <segment index="${idx}">`);
    lines.push(`        <type>${valueToXMLString(seg.type, 0)}</type>`);
    lines.push('        <data>');
    lines.push(...jsonToXMLLines(seg.data, 5, 0, 6));
    lines.push('        </data>');
    lines.push('      </segment>');
    idx += 1;
  }
  lines.push('    </message>');

  const forwards = pickCurrentForwards(msg);
  if (forwards.length > 0) {
    lines.push('    <forwards>');
    for (let i = 0; i < forwards.length; i++) {
      lines.push(`      <forward index="${i + 1}">`);
      lines.push(...jsonToXMLLines(forwards[i], 6, 0, 8));
      lines.push('      </forward>');
    }
    lines.push('    </forwards>');
  }

  const cards = pickCurrentCards(msg);
  if (cards.length > 0) {
    lines.push('    <cards>');
    for (let i = 0; i < cards.length; i++) {
      lines.push(`      <card index="${i + 1}">`);
      lines.push(...jsonToXMLLines(cards[i], 6, 0, 8));
      lines.push('      </card>');
    }
    lines.push('    </cards>');
  }

  lines.push('    </sentra-message>');
  lines.push('  </current_messages>');

  emitInputSection(lines, 'sentra-pending-messages', pendingMessagesXml);
  emitInputSection(lines, 'sentra-history-messages', historyMessagesXml);
  emitInputSection(lines, 'sentra-tool-results', toolResultsXml);

  lines.push('</sentra-input>');
  return lines.join('\n');
}

export function buildSentraMessageBlock(packet: SentraMessagePacket): string {
  const xmlLines = ['<sentra-message>'];

  const gid = packet?.group_id != null ? String(packet.group_id).trim() : '';
  const uid = packet?.user_id != null ? String(packet.user_id).trim() : '';
  const senderId = packet?.sender_id != null ? String(packet.sender_id).trim() : '';
  const chatTypeRaw = typeof packet?.chat_type === 'string' ? packet.chat_type.trim().toLowerCase() : '';
  const inferredChatType = chatTypeRaw || (gid ? 'group' : ((uid || senderId) ? 'private' : ''));
  if (inferredChatType) {
    xmlLines.push(`  <chat_type>${valueToXMLString(inferredChatType, 0)}</chat_type>`);
  }
  if (inferredChatType === 'group' && gid && isPositiveIntegerString(gid)) {
    xmlLines.push(`  <group_id>${valueToXMLString(gid, 0)}</group_id>`);
  } else if (inferredChatType === 'private') {
    const privateId = uid && isPositiveIntegerString(uid)
      ? uid
      : (senderId && isPositiveIntegerString(senderId) ? senderId : '');
    if (privateId) {
      xmlLines.push(`  <user_id>${valueToXMLString(privateId, 0)}</user_id>`);
    }
  } else if (!inferredChatType) {
    if (gid && isPositiveIntegerString(gid)) {
      xmlLines.push(`  <group_id>${valueToXMLString(gid, 0)}</group_id>`);
    } else if (uid && isPositiveIntegerString(uid)) {
      xmlLines.push(`  <user_id>${valueToXMLString(uid, 0)}</user_id>`);
    }
  }
  if (senderId) {
    xmlLines.push(`  <sender_id>${valueToXMLString(senderId, 0)}</sender_id>`);
  }
  if (typeof packet?.sender_name === 'string' && packet.sender_name.trim()) {
    xmlLines.push(`  <sender_name>${valueToXMLString(packet.sender_name.trim(), 0)}</sender_name>`);
  }

  const rawSegments = Array.isArray(packet?.message) ? packet.message : [];
  const packetMessageId = packet?.message_id != null ? String(packet.message_id).trim() : '';
  const segments = withSegmentMessageId(rawSegments, packetMessageId);
  xmlLines.push('  <message>');
  let index = 1;
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const type = typeof seg.type === 'string' ? seg.type.trim() : '';
    if (!type) continue;
    const dataRaw = seg.data && typeof seg.data === 'object' ? seg.data : {};
    const data = trimStringDeep(dataRaw);
    xmlLines.push(`    <segment index="${index}">`);
    xmlLines.push(`      <type>${valueToXMLString(type, 0)}</type>`);
    xmlLines.push('      <data>');
    xmlLines.push(...jsonToXMLLines(data, 4, 0, 6));
    xmlLines.push('      </data>');
    xmlLines.push('    </segment>');
    index += 1;
  }
  xmlLines.push('  </message>');
  xmlLines.push('</sentra-message>');
  return xmlLines.join('\n');
}

function hasMeaningfulMessageData(value: unknown, depth = 0): boolean {
  if (value == null) return false;
  if (depth > 3) return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some((x) => hasMeaningfulMessageData(x, depth + 1));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return false;
    return entries.some(([, v]) => hasMeaningfulMessageData(v, depth + 1));
  }
  return false;
}

function isMeaningfulSentraSegment(seg: SentraMessageSegment | null | undefined): boolean {
  if (!seg || typeof seg !== 'object') return false;
  const type = String(seg.type || '').trim().toLowerCase();
  if (!type) return false;
  if (!SUPPORTED_SENTRA_MESSAGE_SEGMENT_TYPES.has(type)) return false;
  const data = seg.data && typeof seg.data === 'object' ? seg.data : {};

  if (type === 'text') {
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    return text.length > 0;
  }
  if (type === 'music') {
    const provider = typeof data.type === 'string' ? data.type.trim().toLowerCase() : '';
    const id = data.id == null ? '' : String(data.id).trim();
    return provider.length > 0 && id.length > 0;
  }
  if (type === 'poke') {
    const userId = data.user_id == null ? '' : String(data.user_id).trim();
    const groupId = data.group_id == null ? '' : String(data.group_id).trim();
    if (!/^\d+$/.test(userId)) return false;
    if (groupId && !/^\d+$/.test(groupId)) return false;
    return true;
  }
  if (type === 'recall') {
    const messageId = data.message_id == null ? '' : String(data.message_id).trim();
    if (!/^\d+$/.test(messageId)) return false;
    try {
      return BigInt(messageId) > 0n;
    } catch {
      const n = Number(messageId);
      return Number.isFinite(n) && n > 0;
    }
  }
  return hasMeaningfulMessageData(data);
}

export function parseSentraMessage(response: unknown): ParsedSentraMessage {
  const raw = typeof response === 'string' ? response : String(response ?? '');
  if (!raw.trim()) {
    return { message: [], textSegments: [], resources: [], shouldSkip: true };
  }

  try {
    const full = extractFullXMLTag(raw, 'sentra-message');
    if (full) {
      const doc = getXmlParser().parse(`<root>${full}</root>`);
      const root = doc?.root?.['sentra-message'];
      if (root) {
        const out: ParsedSentraMessage = {
          message: [],
          textSegments: [],
          resources: []
        };

        const gid = unescapeXml(getTextNode(root?.group_id).trim());
        const uid = unescapeXml(getTextNode(root?.user_id).trim());
        if (gid && /^\d+$/.test(gid)) out.group_id = gid;
        if (uid && /^\d+$/.test(uid)) out.user_id = uid;

        const chatType = unescapeXml(getTextNode(root?.chat_type).trim()).toLowerCase();
        if (chatType) out.chat_type = chatType;

        const senderId = unescapeXml(getTextNode(root?.sender_id).trim());
        if (senderId) out.sender_id = senderId;
        const senderName = unescapeXml(getTextNode(root?.sender_name).trim());
        if (senderName) out.sender_name = senderName;
        let messageId = unescapeXml(getTextNode(root?.message_id).trim());

        const segments = normalizeToArray(root?.message?.segment);
        let segIndex = 0;
        for (const seg of segments) {
          const type = unescapeXml(getTextNode(seg?.type).trim()).toLowerCase();
          if (!type) continue;
          if (!SUPPORTED_SENTRA_MESSAGE_SEGMENT_TYPES.has(type)) continue;
          const dataObj = xmlNodeToJs(seg?.data);
          const data = dataObj && typeof dataObj === 'object' ? dataObj as Record<string, unknown> : {};
          out.message.push({ type, data });
          segIndex += 1;
          if (!messageId) {
            const segMessageId = normalizeSegmentMessageId((data as Record<string, unknown>).message_id);
            if (segMessageId) messageId = segMessageId;
          }

          if (type === 'text') {
            const textVal = typeof data.text === 'string' ? String(data.text).trim() : '';
            if (textVal) out.textSegments.push(textVal);
          } else {
            const source = typeof data.file === 'string'
              ? String(data.file).trim()
              : (typeof data.source === 'string' ? String(data.source).trim() : '');
            const caption = typeof data.caption === 'string' ? String(data.caption).trim() : '';
            if (source) {
              out.resources.push({
                type: type === 'audio' ? 'record' : type,
                source,
                ...(caption ? { caption } : {}),
                segment_index: segIndex
              });
            }
          }
        }
        if (messageId) out.message_id = messageId;

        const hasResources = out.resources.length > 0;
        const hasMeaningfulSegments = out.message.some((seg) => isMeaningfulSentraSegment(seg));
        if (!hasMeaningfulSegments && !hasResources) out.shouldSkip = true;
        return out;
      }
    }
  } catch { }

  return { message: [], textSegments: [], resources: [], shouldSkip: true };
}

export function applySentraMessageSegmentMessageId(raw: unknown, messageId: unknown): string {
  const input = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  const normalized = normalizeSegmentMessageId(messageId);
  if (!input || !normalized) return input;
  try {
    const parsed = parseSentraMessage(input);
    if (!parsed || parsed.shouldSkip || !Array.isArray(parsed.message) || parsed.message.length === 0) {
      return input;
    }
    const packet: SentraMessagePacket = {
      message_id: normalized,
      message: parsed.message
    };
    if (parsed.chat_type) packet.chat_type = parsed.chat_type;
    if (parsed.group_id) packet.group_id = parsed.group_id;
    if (parsed.user_id) packet.user_id = parsed.user_id;
    if (parsed.sender_id) packet.sender_id = parsed.sender_id;
    if (parsed.sender_name) packet.sender_name = parsed.sender_name;
    return buildSentraMessageBlock(packet);
  } catch {
    return input;
  }
}

export function applySentraMessageSegmentMessageIds(
  raw: unknown,
  entries: Array<{ segmentIndex?: number; messageId?: string | number | null }> | null | undefined
): string {
  const input = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!input) return input;
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return input;
  const mapping = new Map<number, string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const idxRaw = Number((item as { segmentIndex?: unknown }).segmentIndex);
    if (!Number.isFinite(idxRaw) || idxRaw <= 0) continue;
    const idx = Math.floor(idxRaw);
    const id = normalizeSegmentMessageId((item as { messageId?: unknown }).messageId);
    if (!id) continue;
    mapping.set(idx, id);
  }
  if (mapping.size === 0) return input;
  try {
    const parsed = parseSentraMessage(input);
    if (!parsed || parsed.shouldSkip || !Array.isArray(parsed.message) || parsed.message.length === 0) {
      return input;
    }
    const nextMessage = parsed.message.map((seg, i) => {
      const segmentIndex = i + 1;
      const mapped = mapping.get(segmentIndex);
      if (!mapped) return seg;
      const data = seg && seg.data && typeof seg.data === 'object'
        ? { ...seg.data, message_id: mapped }
        : { message_id: mapped };
      return { ...seg, data };
    });

    const packet: SentraMessagePacket = {
      message: nextMessage
    };
    if (parsed.chat_type) packet.chat_type = parsed.chat_type;
    if (parsed.group_id) packet.group_id = parsed.group_id;
    if (parsed.user_id) packet.user_id = parsed.user_id;
    if (parsed.sender_id) packet.sender_id = parsed.sender_id;
    if (parsed.sender_name) packet.sender_name = parsed.sender_name;
    return buildSentraMessageBlock(packet);
  } catch {
    return input;
  }
}

/**
 * 杞崲鍘嗗彶瀵硅瘽涓?MCP FC 鍗忚鏍煎紡
 * 浠?user 娑堟伅涓彁鍙?<sentra-result>锛岃浆鎹负瀵瑰簲鐨?<sentra-tools> assistant 娑堟伅
 * 
 * @param {Array} historyConversations - 鍘熷鍘嗗彶瀵硅瘽鏁扮粍 [{ role, content }]
 * @returns {Array} 杞崲鍚庣殑瀵硅瘽鏁扮粍锛堜笉鍖呭惈 system锛?
 */
export function convertHistoryToMCPFormat(historyConversations: ChatMessage[]): ChatMessage[] {
  const mcpConversation: ChatMessage[] = [];
  let convertedCount = 0;
  let skippedCount = 0;

  let bufferedTools = '';

  const normalizeTimestampMs = (raw: unknown): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n < 1e11) return Math.floor(n * 1000);
    if (n > 1e15) return Math.floor(n / 1000);
    return Math.floor(n);
  };

  const pushWithTimestamp = (role: 'user' | 'assistant', content: unknown, timestampRaw: unknown) => {
    const text = typeof content === 'string' ? content : String(content ?? '');
    const row = { role, content: text } as ChatMessage & { timestamp?: number };
    const ts = normalizeTimestampMs(timestampRaw);
    if (ts > 0) row.timestamp = ts;
    mcpConversation.push(row);
  };

  const extractReasonFromSentraInput = (content: string): string => {
    const src = typeof content === 'string' ? content : '';
    if (!src) return '';
    const inputFull = extractFullXMLTag(src, 'sentra-input') || src;
    try {
      const doc = getXmlParser().parse(`<root>${inputFull}</root>`);
      const inputNode = doc?.root?.['sentra-input'];
      const current = inputNode?.current_messages;
      const currentMessage = current?.['sentra-message'] || current?.sentra_message || current;
      const segments = normalizeToArray(currentMessage?.message?.segment);
      for (const seg of segments) {
        const type = String(getTextNode(seg?.type) || '').trim().toLowerCase();
        if (type !== 'text') continue;
        const text = String(getTextNode(seg?.data?.text) || '').trim();
        if (text) return text;
      }
    } catch { }
    const currentXml = extractXMLTag(inputFull, 'current_messages') || '';
    const fallback = String(extractXMLTag(currentXml, 'text') || extractXMLTag(inputFull, 'text') || '').trim();
    return fallback;
  };

  const pushStandardNoToolPair = (userMsg: ChatMessage) => {
    const userContent = typeof userMsg.content === 'string' ? userMsg.content : '';
    const ts = normalizeTimestampMs((userMsg as unknown as { timestamp?: unknown })?.timestamp);
    pushWithTimestamp('user', userContent, ts);

    let reasonText = extractReasonFromSentraInput(userContent).trim();
    if (!reasonText) reasonText = 'No tool required for this message.';

    const toolsXML = [
      '<sentra-tools>',
      '  <invoke name="none">',
      '    <parameter name="no_tool">true</parameter>',
      `    <parameter name="reason">${valueToXMLString(reasonText, 0)}</parameter>`,
      '  </invoke>',
      '</sentra-tools>'
    ].join('\n');

    const ev = {
      type: 'tool_result',
      aiName: 'none',
      plannedStepIndex: 0,
      reason: reasonText,
      result: {
        success: true,
        code: 'NO_TOOL',
        provider: 'system',
        data: { no_tool: true, reason: reasonText }
      }
    };
    const resultXML = buildSentraResultBlock(ev);
    pushWithTimestamp('assistant', `${toolsXML}\n\n${resultXML}`, ts);
  };

  const addInvocation = (
    invocations: ToolInvocationArgsContent[],
    seen: Set<string>,
    aiName: unknown,
    argsContent: unknown
  ) => {
    const name = (aiName != null) ? String(aiName).trim() : '';
    if (!name) return;
    const args = argsContent != null ? String(argsContent).trim() : '';
    const key = `${name}|${args}`;
    if (seen.has(key)) return;
    seen.add(key);
    invocations.push({ aiName: name, argsContent: args });
  };

  const extractInvocationsFromResultFullByRegex = (
    resultFullXml: string,
    invocations: ToolInvocationArgsContent[],
    seen: Set<string>
  ) => {
    try {
      const aiName = extractXMLTag(resultFullXml, 'aiName');
      const argsJSONText = extractXMLTag(resultFullXml, 'arguments');
      const argsContent = argsJSONText || extractXMLTag(resultFullXml, 'args');
      if (aiName && argsContent != null) {
        addInvocation(invocations, seen, aiName, argsContent);
      }
    } catch { }
  };

  const extractInvocationsAndResultBlocksByParser = (text: string): {
    invocations: ToolInvocationArgsContent[];
    resultBlocksFull: string[];
  } => {
    const invocations: ToolInvocationArgsContent[] = [];
    const seen = new Set<string>();
    const groupFullBlocks: string[] = extractAllFullXMLTags(text, 'sentra-result-group') || [];
    const singlesFull: string[] = extractAllFullXMLTags(text, 'sentra-result') || [];
    const resultBlocksFull: string[] = groupFullBlocks.length > 0 ? groupFullBlocks : singlesFull;

    try {
      if (groupFullBlocks.length > 0) {
        for (const groupFull of groupFullBlocks) {
          let groupNode = null;
          try {
            const doc = getXmlParser().parse(`<root>${groupFull}</root>`);
            groupNode = doc?.root?.['sentra-result-group'] || null;
          } catch {
            groupNode = null;
          }

          const resultFulls = extractAllFullXMLTags(groupFull, 'sentra-result') || [];
          const nodes = groupNode ? normalizeToArray(groupNode['sentra-result']) : [];
          const maxLen = Math.max(nodes.length, resultFulls.length);
          for (let i = 0; i < maxLen; i++) {
            const node = nodes[i];
            const aiName = node ? getTextNode(node.aiName).trim() : '';
            const argsJSONText = node ? getTextNode(node.arguments).trim() : '';
            if (aiName && argsJSONText) {
              addInvocation(invocations, seen, aiName, argsJSONText);
              continue;
            }

            if (aiName && node && node.args && typeof node.args === 'object') {
              try {
                const obj = xmlNodeToJs(node.args);
                const jsonText = JSON.stringify(obj || {});
                addInvocation(invocations, seen, aiName, jsonText);
                continue;
              } catch { }
            }

            const fallbackFull = resultFulls[i];
            if (fallbackFull) {
              extractInvocationsFromResultFullByRegex(fallbackFull, invocations, seen);
            }
          }
        }
        return { invocations, resultBlocksFull };
      }

      if (singlesFull.length > 0) {
        for (const full of singlesFull) {
          let node = null;
          try {
            const doc = getXmlParser().parse(`<root>${full}</root>`);
            node = doc?.root?.['sentra-result'] || null;
          } catch {
            node = null;
          }

          const aiName = node ? getTextNode(node.aiName).trim() : '';
          const argsJSONText = node ? getTextNode(node.arguments).trim() : '';
          if (aiName && argsJSONText) {
            addInvocation(invocations, seen, aiName, argsJSONText);
            continue;
          }

          if (aiName && node && node.args && typeof node.args === 'object') {
            try {
              const obj = xmlNodeToJs(node.args);
              const jsonText = JSON.stringify(obj || {});
              addInvocation(invocations, seen, aiName, jsonText);
              continue;
            } catch { }
          }
          extractInvocationsFromResultFullByRegex(full, invocations, seen);
        }
        return { invocations, resultBlocksFull };
      }
    } catch { }

    return { invocations: [], resultBlocksFull };
  };

  for (const msg of historyConversations) {
    if (!msg || typeof msg !== 'object') continue;
    const sourceTimestamp = normalizeTimestampMs((msg as unknown as { timestamp?: unknown })?.timestamp);
    if (msg.role === 'system') {
      skippedCount++;
      continue;
    }

    const content = typeof msg.content === 'string' ? msg.content : '';

    // Skip assistant natural language responses in MCP context.
    if (msg.role === 'assistant' && content.includes('<sentra-message>')) {
      skippedCount++;
      continue;
    }

    // New format: assistant tools are already present in history
    if (msg.role === 'assistant' && content.includes('<sentra-tools>')) {
      bufferedTools = content;
      continue;
    }

    if (msg.role === 'user') {
      const hasInput = content.includes('<sentra-input>');
      const hasResult = content.includes('<sentra-result') || content.includes('<sentra-result-group');

      // User context-only turn (<sentra-input>)
      if (hasInput && !hasResult) {
        bufferedTools = '';
        pushWithTimestamp('user', content, sourceTimestamp);
        continue;
      }

      // Result callback turn (can be results-only, or input+results in same user message)
      if (hasResult) {
        if (hasInput) {
          pushWithTimestamp('user', content, sourceTimestamp);
        }

        let invocations: ToolInvocationArgsContent[] = [];
        let resultBlocksFull: string[] = [];
        try {
          const parsedOut = extractInvocationsAndResultBlocksByParser(content);
          invocations = parsedOut.invocations || [];
          resultBlocksFull = parsedOut.resultBlocksFull || [];
        } catch {
          invocations = [];
          resultBlocksFull = [];
        }

        const groupFullBlocks = extractAllFullXMLTags(content, 'sentra-result-group') || [];
        const singlesFull = extractAllFullXMLTags(content, 'sentra-result') || [];
        const canonicalResultBlocks = resultBlocksFull.length > 0
          ? resultBlocksFull
          : (groupFullBlocks.length > 0 ? groupFullBlocks : singlesFull);
        const resultsXML = canonicalResultBlocks.length > 0 ? canonicalResultBlocks.join('\n\n') : content;

        let toolsXML = bufferedTools;
        if (!toolsXML && invocations.length > 0) {
          toolsXML = buildSentraToolsBatch(invocations);
          convertedCount += invocations.length;
        }

        const combined = toolsXML ? `${toolsXML}\n\n${resultsXML}` : resultsXML;
        pushWithTimestamp('assistant', combined, sourceTimestamp);
        bufferedTools = '';
        if (invocations.length === 0) convertedCount++;
        continue;
      }

      // Fallback: non-xml user content
      mcpConversation.push(msg);
      continue;
    }

    // Any other assistant content: keep
    if (msg.role === 'assistant') {
      mcpConversation.push(msg);
      continue;
    }
  }

  // If we saw an orphan base user message without any tool/result, insert a standard no-tool pair
  // (best-effort: scan tail)
  try {
    const last = historyConversations && historyConversations.length
      ? historyConversations[historyConversations.length - 1]
      : null;
    if (last && last.role === 'user') {
      const c = typeof last.content === 'string' ? last.content : '';
      const hasInput = c.includes('<sentra-input>');
      const hasRes = c.includes('<sentra-result') || c.includes('<sentra-result-group');
      if (hasInput && !hasRes) {
        const lastOut = mcpConversation.length ? mcpConversation[mcpConversation.length - 1] : null;
        if (!lastOut || lastOut.role !== 'assistant') {
          pushStandardNoToolPair(last);
        }
      }
    }
  } catch { }

  logger.debug(`MCP format converted: ${historyConversations.length} -> ${mcpConversation.length} (converted=${convertedCount}, skipped=${skippedCount})`);
  return mcpConversation;
}

function inferScalarForParam(text: unknown): string | number | boolean | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+$/.test(trimmed)) {
    try {
      const bi = BigInt(trimmed);
      const max = BigInt(Number.MAX_SAFE_INTEGER);
      const min = BigInt(Number.MIN_SAFE_INTEGER);
      if (bi > max || bi < min) {
        return trimmed;
      }
    } catch { }
  }
  const n = Number(trimmed);
  if (!Number.isNaN(n)) return n;
  return trimmed;
}

// (string|number|boolean|null|array|object) 娓叉煋涓?<parameter> 鍐呴儴鐨?XML 琛?
function renderTypedValueLinesForParam(value: ParamValue, indentLevel = 3): string[] {
  const lines: string[] = [];
  const pad = '  '.repeat(indentLevel);

  if (value === null) {
    lines.push(`${pad}<null></null>`);
    return lines;
  }

  const t = typeof value;

  if (t === 'string') {
    lines.push(`${pad}<string>${valueToXMLString(value, 0)}</string>`);
    return lines;
  }

  if (t === 'number') {
    lines.push(`${pad}<number>${String(value)}</number>`);
    return lines;
  }

  if (t === 'boolean') {
    lines.push(`${pad}<boolean>${value ? 'true' : 'false'}</boolean>`);
    return lines;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}<array />`);
      return lines;
    }
    lines.push(`${pad}<array>`);
    for (const item of value) {
      lines.push(...renderTypedValueLinesForParam(item as ParamValue, indentLevel + 1));
    }
    lines.push(`${pad}</array>`);
    return lines;
  }

  if (t === 'object') {
    const obj = value as Record<string, ParamValue>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      lines.push(`${pad}<object />`);
      return lines;
    }
    lines.push(`${pad}<object>`);
    for (const key of keys) {
      const keyAttr = escapeXmlAttr(String(key));
      const paramPad = '  '.repeat(indentLevel + 1);
      lines.push(`${paramPad}<parameter name="${keyAttr}">`);
      const nextVal = obj[key] ?? '';
      lines.push(...renderTypedValueLinesForParam(nextVal, indentLevel + 2));
      lines.push(`${paramPad}</parameter>`);
    }
    lines.push(`${pad}</object>`);
    return lines;
  }

  // 鍏朵粬绫诲瀷缁熶竴鎸夊瓧绗︿覆澶勭悊
  lines.push(`${pad}<string>${valueToXMLString(String(value), 0)}</string>`);
  return lines;
}

// 鏋勫缓鍗曚釜 typed <parameter> 鍧?
function buildTypedParameterBlock(name: string, jsValue: ParamValue): string[] {
  const safeName = escapeXmlAttr(String(name));
  const lines = [];
  lines.push(`    <parameter name="${safeName}">`);
  lines.push(...renderTypedValueLinesForParam(jsValue, 3));
  lines.push('    </parameter>');
  return lines;
}

export function buildSentraToolsBlockFromArgsObject(
  aiName: string,
  argsObj?: Record<string, ParamValue> | null
): string {
  const xmlLines = ['<sentra-tools>'];
  xmlLines.push(`  <invoke name="${escapeXmlAttr(String(aiName || ''))}">`);
  if (argsObj && typeof argsObj === 'object') {
    const entries = Object.entries(argsObj as Record<string, ParamValue>);
    for (const [key, value] of entries) {
      const paramLines = buildTypedParameterBlock(key, value);
      xmlLines.push(...paramLines);
    }
  }
  xmlLines.push('  </invoke>');
  xmlLines.push('</sentra-tools>');
  return xmlLines.join('\n');
}

export function buildSentraToolsBlockFromInvocations(invocations: ToolInvocationArgsObject[]): string {
  const xmlLines = ['<sentra-tools>'];
  const items = Array.isArray(invocations) ? invocations : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const aiName = item.aiName;
    const argsObj = item.args;
    xmlLines.push(`  <invoke name="${escapeXmlAttr(String(aiName || ''))}">`);
    if (argsObj && typeof argsObj === 'object') {
      const entries = Object.entries(argsObj as Record<string, ParamValue>);
      for (const [key, value] of entries) {
        const paramLines = buildTypedParameterBlock(key, value);
        xmlLines.push(...paramLines);
      }
    }
    xmlLines.push('  </invoke>');
  }
  xmlLines.push('</sentra-tools>');
  return xmlLines.join('\n');
}

/**
 * 浠?<args> 鍐呭鏋勫缓 <sentra-tools> 鍧楋紙MCP FC 鏍囧噯鏍煎紡锛?
 * 
 * @param {string} aiName - 宸ュ叿鍚嶇О
 * @param {string} argsContent - <args> 鏍囩鍐呯殑鍐呭
 * @returns {string} <sentra-tools> XML 瀛楃涓?
 */
function buildSentraToolsFromArgs(aiName: string, argsContent: string): string {
  const xmlLines = ['<sentra-tools>'];
  xmlLines.push(`  <invoke name="${escapeXmlAttr(String(aiName || ''))}">`);

  const parsed = parseArgsContentToObject(argsContent);
  if (parsed && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, ParamValue>);
    for (const [key, value] of entries) {
      const paramLines = buildTypedParameterBlock(key, value);
      xmlLines.push(...paramLines);
    }
  }

  xmlLines.push('  </invoke>');
  xmlLines.push('</sentra-tools>');
  return xmlLines.join('\n');
}

// 鎵归噺鏋勫缓 <sentra-tools>锛屽寘鍚涓?<invoke>
function buildSentraToolsBatch(items: ToolInvocationArgsContent[]): string {
  const xmlLines = ['<sentra-tools>'];
  for (const { aiName, argsContent } of items) {
    xmlLines.push(`  <invoke name="${escapeXmlAttr(String(aiName || ''))}">`);
    const parsed = parseArgsContentToObject(argsContent);
    if (parsed && typeof parsed === 'object') {
      const entries = Object.entries(parsed as Record<string, ParamValue>);
      for (const [key, value] of entries) {
        const paramLines = buildTypedParameterBlock(key, value);
        xmlLines.push(...paramLines);
      }
    }
    xmlLines.push('  </invoke>');
  }
  xmlLines.push('</sentra-tools>');
  return xmlLines.join('\n');
}





