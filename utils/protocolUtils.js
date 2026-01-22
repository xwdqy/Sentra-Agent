/**
 * Sentra协议处理模块
 * 包含<sentra-result>、<sentra-user-question>、<sentra-response>的构建和解析
 */

import { z } from 'zod';
import { jsonToXMLLines, extractXMLTag, extractAllXMLTags, extractFilesFromContent, valueToXMLString, USER_QUESTION_FILTER_KEYS, extractFullXMLTag, extractAllFullXMLTags, escapeXmlAttr, unescapeXml, stripTypedValueWrapper, extractXmlAttrValue, extractInnerXmlFromFullTag, getFastXmlParser } from './xmlUtils.js';
import { createLogger } from './logger.js';

const logger = createLogger('ProtocolUtils');

function getXmlParser() {
  return getFastXmlParser();
}

function getTextNode(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    if (typeof v['#text'] === 'string') return v['#text'];
  }
  return '';
}

function normalizeToArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function normalizeMentionIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  const seen = new Set();
  for (const mid of ids) {
    const raw = String(mid ?? '').trim();
    if (!raw) continue;
    const lowered = raw.toLowerCase ? raw.toLowerCase() : raw;
    const normalized = (lowered === '@all') ? 'all' : raw;
    if (normalized !== 'all' && !/^\d+$/.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 20) break;
  }
  return out;
}

function sanitizeMentionsBySegment(map, maxSegments) {
  try {
    if (!map || typeof map !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      const idx = String(k ?? '').trim();
      if (!idx || !/^\d+$/.test(idx)) continue;
      const n = parseInt(idx, 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (Number.isFinite(maxSegments) && maxSegments > 0 && n > maxSegments) continue;
      const ids = normalizeMentionIds(Array.isArray(v) ? v : [v]);
      if (ids.length > 0) out[String(n)] = ids;
    }
    return out;
  } catch {
    return {};
  }
}

function pickFirstTypedValue(paramObj) {
  if (!paramObj || typeof paramObj !== 'object') return '';
  if (paramObj.null !== undefined) return null;
  if (paramObj.boolean !== undefined) return parseBooleanLike(stripTypedValueWrapper(unescapeXml(getTextNode(paramObj.boolean))));
  if (paramObj.number !== undefined) return inferScalarForParam(stripTypedValueWrapper(unescapeXml(getTextNode(paramObj.number))));
  if (paramObj.string !== undefined) return stripTypedValueWrapper(unescapeXml(getTextNode(paramObj.string)));

  // Fallback: treat inner text as scalar
  const raw = stripTypedValueWrapper(unescapeXml(getTextNode(paramObj)));
  if (raw) return inferScalarForParam(raw);
  return '';
}

function xmlNodeToJs(value) {
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
      const idx = idxRaw && /^\d+$/.test(idxRaw) ? parseInt(idxRaw, 10) : null;
      const copy = { ...it };
      delete copy.index;
      const v = xmlNodeToJs(copy);
      if (idx == null) arr.push(v);
      else arr[idx] = v;
    }
    return arr;
  }

  const obj = {};
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

function parseArgsContentToObject(argsContent) {
  const trimmed = String(argsContent || '').trim();
  if (!trimmed) return null;

  try {
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}

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

// 内部：将 JS 值渲染为参数 <parameter> 的文本
function paramValueToText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // 对象/数组：用 JSON 字符串表达
  try { return JSON.stringify(v); } catch { return String(v); }
}

// 内部：将 args 对象渲染为 XML 子元素（用于 <args> 或 <sentra-tools><parameter>）
function argsObjectToParamEntries(args = {}) {
  const out = [];
  try {
    for (const [k, v] of Object.entries(args || {})) {
      out.push({ name: k, value: paramValueToText(v) });
    }
  } catch {}
  return out;
}

function parseBooleanLike(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return null;
  if (t === 'true' || t === '1' || t === 'yes') return true;
  if (t === 'false' || t === '0' || t === 'no') return false;
  return null;
}

export function parseReplyGateDecisionFromSentraTools(text) {
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
          }
        }
        if (typeof enter !== 'boolean') continue;
        last = { enter, reason, invokeName: name };
      }
    }
  } catch {}

  if (last) return last;

  try {
    const toolsBlocks = extractAllFullXMLTags(s, 'sentra-tools');
    for (const tb of toolsBlocks) {
      const invokes = extractAllFullXMLTags(tb, 'invoke');
      for (const invokeXml of invokes) {
        const name = (extractXmlAttrValue(invokeXml, 'name') || '').trim();
        if (name !== 'reply_gate_decision') continue;

        let enter = null;
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
          }
        }

        if (typeof enter !== 'boolean') continue;
        last = { enter, reason, invokeName: name };
      }
    }
  } catch {}

  return last;
}

export function parseSendFusionFromSentraTools(text) {
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
        if (name !== 'send_fusion') continue;

        const textSegments = [];
        let reason = '';
        const params = normalizeToArray(invoke?.parameter);
        for (const p of params) {
          const pName = String(p?.name || '').trim();
          if (!pName) continue;
          const val = String(pickFirstTypedValue(p) ?? '').trim();
          if (!val) continue;
          if (pName === 'reason') {
            reason = val;
            continue;
          }
          const m = pName.match(/^text(\d+)$/i);
          if (m) {
            const idx = parseInt(m[1], 10);
            if (Number.isFinite(idx) && idx > 0) {
              textSegments.push({ idx, val });
            }
          }
        }

        textSegments.sort((a, b) => a.idx - b.idx);
        const merged = textSegments.map((x) => x.val);
        if (merged.length === 0) continue;
        last = { textSegments: merged, reason, invokeName: name };
      }
    }
  } catch {}

  if (last) return last;

  try {
    const toolsBlocks = extractAllFullXMLTags(s, 'sentra-tools');
    for (const tb of toolsBlocks) {
      const invokes = extractAllFullXMLTags(tb, 'invoke');
      for (const invokeXml of invokes) {
        const name = (extractXmlAttrValue(invokeXml, 'name') || '').trim();
        if (name !== 'send_fusion') continue;

        const textSegments = [];
        let reason = '';

        const params = extractAllFullXMLTags(invokeXml, 'parameter');
        for (const p of params) {
          const pName = (extractXmlAttrValue(p, 'name') || '').trim();
          if (!pName) continue;

          const paramInner = extractInnerXmlFromFullTag(p, 'parameter');
          const strText = extractXMLTag(p, 'string');
          const raw = strText != null ? strText : paramInner;
          const val = stripTypedValueWrapper(unescapeXml(raw || '')).trim();
          if (!val) continue;

          if (pName === 'reason') {
            reason = val;
            continue;
          }

          const m = pName.match(/^text(\d+)$/i);
          if (m) {
            const idx = parseInt(m[1], 10);
            if (Number.isFinite(idx) && idx > 0) {
              textSegments.push({ idx, val });
            }
          }
        }

        textSegments.sort((a, b) => a.idx - b.idx);
        const merged = textSegments.map((x) => x.val);
        if (merged.length === 0) continue;

        last = { textSegments: merged, reason, invokeName: name };
      }
    }
  } catch {}

  return last;
}

// Zod schema for resource validation
const ResourceSchema = z.object({
  type: z.enum(['image', 'video', 'audio', 'file', 'link']),
  source: z.string(),
  caption: z.string().optional()
});

const SentraResponseSchema = z.object({
  textSegments: z.array(z.string()),
  resources: z.array(ResourceSchema).optional().default([]),
  group_id: z.string().optional(),
  user_id: z.string().optional(),
  replyMode: z.enum(['none', 'first', 'always']).optional().default('none'),
  mentionsBySegment: z.record(z.string(), z.array(z.union([z.string(), z.number()]))).optional().default({})
});

/**
 * 构建 Sentra XML 块：
 * - tool_result -> <sentra-result>
 * - tool_result_group -> <sentra-result-group> 包含多个 <sentra-result>
 */
export function buildSentraResultBlock(ev) {
  try {
    const type = ev?.type;
    if (type === 'tool_result') {
      return buildSingleResultXML(ev);
    }
    if (type === 'tool_result_group' && Array.isArray(ev?.events)) {
      const gid = ev.groupId != null ? String(ev.groupId) : '';
      const gsize = Number(ev.groupSize || ev.events.length);
      const order = Array.isArray(ev.orderIndices) ? ev.orderIndices.join(',') : '';
      const lines = [
        `<sentra-result-group group_id="${gid}" group_size="${gsize}" order="${order}">`
      ];
      for (const item of ev.events) {
        const xml = buildSingleResultXML(item);
        const indented = xml.split('\n').map(l => `  ${l}`).join('\n');
        lines.push(indented);
      }
      // 附带一次性提取到的文件资源（可选）
      const collected = [];
      ev.events.forEach((item, idx) => {
        if (!item || !item.result) return;
        const root = item.result && (item.result.data !== undefined ? item.result.data : item.result);
        if (!root || typeof root !== 'object') return;
        const fromResult = extractFilesFromContent(root, ['events', idx, 'result']);
        collected.push(...fromResult);
      });

      // 去重：按 path 聚合，避免同一文件被多次包含
      const seenPaths = new Set();
      const files = [];
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
    // 发生异常时返回 JSON 包裹，避免终止主流程
    try { return `<sentra-result>${valueToXMLString(JSON.stringify(ev), 0)}</sentra-result>`; } catch { return '<sentra-result></sentra-result>'; }
  }
}

// 内部：构建单个 <sentra-result>（统一字段）
function buildSingleResultXML(ev) {
  const aiName = ev?.aiName || '';
  const step = Number(ev?.plannedStepIndex ?? ev?.stepIndex ?? 0);
  const reason = Array.isArray(ev?.reason) ? ev.reason.join('; ') : (ev?.reason || '');
  const success = ev?.result?.success === true;
  const code = ev?.result?.code || '';
  const provider = ev?.result?.provider || ev?.toolMeta?.provider || '';
  const args = ev?.args || {};
  const data = (ev?.result && (ev.result.data !== undefined ? ev.result.data : ev.result)) || null;

  const err = ev?.result?.error;
  const extra = {};
  if (ev?.result && typeof ev.result === 'object') {
    if (ev.result.advice !== undefined) extra.advice = ev.result.advice;
    if (ev.result.detail !== undefined) extra.detail = ev.result.detail;
  }

  const lines = [`<sentra-result step="${step}" tool="${aiName}" success="${success}">`];
  if (reason) lines.push(`  <reason>${valueToXMLString(reason, 0)}</reason>`);
  // 同时输出 <aiName> 以便旧解析器兼容
  lines.push(`  <aiName>${valueToXMLString(aiName, 0)}</aiName>`);
  // args：同时提供结构化与 JSON 两种表示
  try {
    lines.push('  <args>');
    lines.push(...jsonToXMLLines(args, 2, 0, 6));
    lines.push('  </args>');
  } catch {}
  try {
    const jsonText = JSON.stringify(args || {});
    lines.push(`  <arguments>${valueToXMLString(jsonText, 0)}</arguments>`);
  } catch {}
  // result：拆为 success/code/data/provider
  lines.push('  <result>');
  lines.push(`    <success>${success}</success>`);
  if (code) lines.push(`    <code>${valueToXMLString(code, 0)}</code>`);
  if (provider) lines.push(`    <provider>${valueToXMLString(provider, 0)}</provider>`);
  try {
    lines.push('    <data>');
    lines.push(...jsonToXMLLines(data, 3, 0, 6));
    lines.push('    </data>');
  } catch {
    try { lines.push(`    <data>${valueToXMLString(JSON.stringify(data), 0)}</data>`); } catch {}
  }

  if (err) {
    try {
      lines.push('    <error>');
      lines.push(...jsonToXMLLines(err, 3, 0, 6));
      lines.push('    </error>');
    } catch {
      try { lines.push(`    <error>${valueToXMLString(JSON.stringify(err), 0)}</error>`); } catch {}
    }
  }

  try {
    if (Object.keys(extra).length > 0) {
      lines.push('    <extra>');
      lines.push(...jsonToXMLLines(extra, 3, 0, 6));
      lines.push('    </extra>');
    }
  } catch {}
  lines.push('  </result>');

  // 附带便于调试的元信息（可选）
  if (Array.isArray(ev?.dependsOn) || Array.isArray(ev?.dependedBy)) {
    lines.push('  <dependencies>');
    if (Array.isArray(ev.dependsOn)) lines.push(`    <depends_on>${ev.dependsOn.join(',')}</depends_on>`);
    if (Array.isArray(ev.dependedBy)) lines.push(`    <depended_by>${ev.dependedBy.join(',')}</depended_by>`);
    if (ev.dependsNote) lines.push(`    <note>${valueToXMLString(ev.dependsNote, 0)}</note>`);
    lines.push('  </dependencies>');
  }

  // 附带文件路径（可选）
  const fileRoot = ev?.result && (ev.result.data !== undefined ? ev.result.data : ev.result);
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
 * 构建<sentra-user-question>块（用户提问）
 * 自动过滤segments、images、videos、files、records等冗余字段
 */
export function buildSentraUserQuestionBlock(msg) {
  const xmlLines = ['<sentra-user-question>'];

  const isMerged = !!msg?._merged && Array.isArray(msg?._mergedUsers) && msg._mergedUsers.length > 1 && msg?.type === 'group';

  if (isMerged) {
    const mergedUsers = msg._mergedUsers;
    const mergedLines = [];
    mergedUsers.forEach((u, idx) => {
      if (!u) return;
      const name = (u.sender_name || u.nickname || `User${idx + 1}`).trim();
      const baseText =
        (typeof u.text === 'string' && u.text.trim()) ||
        (u.raw && ((u.raw.summary && String(u.raw.summary).trim()) || (u.raw.text && String(u.raw.text).trim()))) ||
        '';
      if (!baseText) return;
      mergedLines.push(name ? `${name}: ${baseText}` : baseText);
    });

    const mergedText = mergedLines.join('\n\n');

    xmlLines.push('  <mode>group_multi_user_merge</mode>');
    if (msg.group_id != null) {
      xmlLines.push(`  <group_id>${valueToXMLString(String(msg.group_id), 0)}</group_id>`);
    }
    if (msg._mergedPrimarySenderId != null) {
      xmlLines.push(
        `  <primary_sender_id>${valueToXMLString(String(msg._mergedPrimarySenderId), 0)}</primary_sender_id>`
      );
    }
    if (typeof msg.sender_name === 'string' && msg.sender_name.trim()) {
      xmlLines.push(`  <primary_sender_name>${valueToXMLString(msg.sender_name, 0)}</primary_sender_name>`);
    }
    xmlLines.push(`  <user_count>${mergedUsers.length}</user_count>`);
    if (mergedText) {
      xmlLines.push(`  <text>${valueToXMLString(mergedText, 0)}</text>`);
    }

    xmlLines.push('  <multi_user merge="true">');
    mergedUsers.forEach((u, idx) => {
      if (!u) return;
      const uid = u.sender_id != null ? String(u.sender_id) : '';
      const uname = u.sender_name || '';
      const mid = u.message_id != null ? String(u.message_id) : '';
      const text =
        (typeof u.text === 'string' && u.text.trim()) ||
        (u.raw && ((u.raw.summary && String(u.raw.summary).trim()) || (u.raw.text && String(u.raw.text).trim()))) ||
        '';
      const time = u.time_str || (u.raw && u.raw.time_str) || '';

      xmlLines.push(`    <user index="${idx + 1}">`);
      if (uid) xmlLines.push(`      <user_id>${valueToXMLString(uid, 0)}</user_id>`);
      if (uname) xmlLines.push(`      <nickname>${valueToXMLString(uname, 0)}</nickname>`);
      if (mid) xmlLines.push(`      <message_id>${valueToXMLString(mid, 0)}</message_id>`);
      if (text) xmlLines.push(`      <text>${valueToXMLString(text, 0)}</text>`);
      if (time) xmlLines.push(`      <time>${valueToXMLString(time, 0)}</time>`);
      xmlLines.push('    </user>');
    });
    xmlLines.push('  </multi_user>');
  }

  // 递归遍历msg对象，过滤指定的键
  xmlLines.push(...jsonToXMLLines(msg, 1, 0, 6, USER_QUESTION_FILTER_KEYS));

  xmlLines.push('</sentra-user-question>');
  return xmlLines.join('\n');
}

/**
 * 解析<sentra-response>协议
 */
export function parseSentraResponse(response) {
  const hasSentraTag = typeof response === 'string' && response.includes('<sentra-response>');

  let parsed = null;
  try {
    const full = extractFullXMLTag(response, 'sentra-response');
    if (full) {
      const doc = getXmlParser().parse(`<root>${full}</root>`);
      parsed = doc?.root?.['sentra-response'] || null;
    }
  } catch {
    parsed = null;
  }

  if (parsed) {
    let targetGroupId = null;
    let targetUserId = null;
    try {
      const gid = unescapeXml(getTextNode(parsed.group_id).trim());
      const uid = unescapeXml(getTextNode(parsed.user_id).trim());
      const gidOk = gid && /^\d+$/.test(gid);
      const uidOk = uid && /^\d+$/.test(uid);
      if (gidOk && uidOk) {
        logger.warn('检测到同时存在 <group_id> 和 <user_id>，将忽略目标并按当前会话发送');
      } else if (gidOk) {
        targetGroupId = gid;
      } else if (uidOk) {
        targetUserId = uid;
      }
    } catch {}

    const textSegments = [];
    for (let i = 1; i <= 50; i++) {
      const key = `text${i}`;
      if (!(key in parsed)) break;
      const t = unescapeXml(getTextNode(parsed[key]).trim());
      if (t) textSegments.push(t);
    }

    let resources = [];
    try {
      const rb = parsed.resources;
      const items = rb && rb.resource ? (Array.isArray(rb.resource) ? rb.resource : [rb.resource]) : [];
      resources = items.map((it) => {
        const type = unescapeXml(getTextNode(it?.type).trim());
        const source = unescapeXml(getTextNode(it?.source).trim());
        const caption = unescapeXml(getTextNode(it?.caption).trim());
        if (!type || !source) return null;
        const r = { type, source };
        if (caption) r.caption = caption;
        return ResourceSchema.parse(r);
      }).filter(Boolean);
    } catch {}

    let replyMode = 'none';
    let mentionsBySegment = {};
    try {
      const send = parsed.send;
      const rm = String(getTextNode(send?.reply_mode) || '').trim().toLowerCase();
      if (rm === 'first' || rm === 'always') replyMode = rm;

      const mbs = send?.mentions_by_segment;
      const segs = mbs ? normalizeToArray(mbs.segment) : [];
      if (segs.length > 0) {
        const map = {};
        for (const seg of segs) {
          const idxRaw = seg && seg.index != null ? String(seg.index).trim() : '';
          if (!idxRaw || !/^\d+$/.test(idxRaw)) continue;
          const sids = seg?.id;
          const arr = sids ? (Array.isArray(sids) ? sids : [sids]) : [];
          const ids2 = arr.map((v) => unescapeXml(getTextNode(v).trim())).filter(Boolean);
          if (ids2.length > 0) map[idxRaw] = ids2;
        }
        mentionsBySegment = sanitizeMentionsBySegment(map, textSegments.length || 0);
      }
    } catch {}

    let emoji = null;
    try {
      const eb = parsed.emoji;
      const source = unescapeXml(getTextNode(eb?.source).trim());
      const caption = unescapeXml(getTextNode(eb?.caption).trim());
      if (source) {
        emoji = { source };
        if (caption) emoji.caption = caption;
      }
    } catch {}

    try {
      const validated = SentraResponseSchema.parse({
        textSegments,
        resources,
        group_id: targetGroupId || undefined,
        user_id: targetUserId || undefined,
        replyMode,
        mentionsBySegment
      });
      if (emoji) validated.emoji = emoji;

      const hasText = Array.isArray(validated.textSegments)
        && validated.textSegments.some((t) => (t || '').trim());
      const hasResources = Array.isArray(validated.resources) && validated.resources.length > 0;
      const hasEmoji = !!validated.emoji;
      if (!hasText && !hasResources && !hasEmoji) {
        validated.shouldSkip = true;
      }
      return validated;
    } catch {
      const fallback = { textSegments, resources: [], replyMode, mentionsBySegment };
      if (emoji) fallback.emoji = emoji;
      if (textSegments.length === 0) fallback.shouldSkip = true;
      return fallback;
    }
  }

  const responseContent = extractXMLTag(response, 'sentra-response');
  if (!responseContent) {
    if (hasSentraTag) {
      // 存在 <sentra-response> 标签但内容为空：视为“本轮选择保持沉默”，由上层跳过发送
      logger.warn('检测到空的 <sentra-response> 块，将跳过发送');
      return { textSegments: [], resources: [], replyMode: 'none', mentions: [], shouldSkip: true };
    }

    logger.warn('未找到 <sentra-response> 块，将跳过发送');
    return { textSegments: [], resources: [], replyMode: 'none', mentions: [], shouldSkip: true };
  }
  
  let targetGroupId = null;
  let targetUserId = null;
  try {
    const gid = unescapeXml((extractXMLTag(responseContent, 'group_id') || '').trim());
    const uid = unescapeXml((extractXMLTag(responseContent, 'user_id') || '').trim());

    const gidOk = gid && /^\d+$/.test(gid);
    const uidOk = uid && /^\d+$/.test(uid);

    if (gidOk && uidOk) {
      logger.warn('检测到同时存在 <group_id> 和 <user_id>，将忽略目标并按当前会话发送');
    } else if (gidOk) {
      targetGroupId = gid;
    } else if (uidOk) {
      targetUserId = uid;
    }
  } catch {}

  // 提取所有 <text1>, <text2>, <text3> ... 标签
  const textSegments = [];
  let index = 1;
  while (true) {
    const textTag = `text${index}`;
    const textContent = extractXMLTag(responseContent, textTag);
    if (!textContent) break;
    
    // 反转义 XML/HTML 实体（处理模型可能输出的转义字符）
    const unescapedText = unescapeXml(textContent.trim());
    textSegments.push(unescapedText);
    //logger.debug(`提取 <${textTag}>: ${unescapedText.slice(0, 80)}`);
    index++;
  }
  
  // 如果没有文本，直接跳过（保持空数组）
  if (textSegments.length === 0) {
    logger.warn('未找到任何文本段落，保持空数组');
  }
  
  logger.debug(`共提取 ${textSegments.length} 个文本段落`);
  
  // 提取 <resources> 块
  const resourcesBlock = extractXMLTag(responseContent, 'resources');
  let resources = [];
  
  if (resourcesBlock && resourcesBlock.trim()) {
    const resourceTags = extractAllXMLTags(resourcesBlock, 'resource');
    logger.debug(`找到 ${resourceTags.length} 个 <resource> 标签`);
    
    resources = resourceTags
      .map((resourceXML, idx) => {
        try {
          const type = unescapeXml((extractXMLTag(resourceXML, 'type') || '').trim());
          const source = unescapeXml((extractXMLTag(resourceXML, 'source') || '').trim());
          const caption = unescapeXml((extractXMLTag(resourceXML, 'caption') || '').trim());
          
          if (!type || !source) {
            logger.warn(`resource[${idx}] 缺少必需字段`);
            return null;
          }
          
          const resource = { type, source };
          if (caption) resource.caption = caption;
          
          return ResourceSchema.parse(resource);
        } catch (e) {
          logger.warn(`resource[${idx}] 解析或验证失败: ${e.message}`);
          return null;
        }
      })
      .filter(Boolean);
    
    logger.success(`成功解析并验证 ${resources.length} 个 resources`);
  } else {
    logger.debug('无 <resources> 块或为空');
  }
  
  // 提取 <send> 指令（回复/艾特控制）
  const sendBlock = extractXMLTag(responseContent, 'send');
  let replyMode = 'none';
  let mentionsBySegment = {};
  try {
    if (sendBlock && sendBlock.trim()) {
      const rm = (extractXMLTag(sendBlock, 'reply_mode') || '').trim().toLowerCase();
      if (rm === 'first' || rm === 'always') replyMode = rm; // 默认为 none
      const mbsBlock = extractXMLTag(sendBlock, 'mentions_by_segment');
      if (mbsBlock) {
        const segFull = extractAllFullXMLTags(mbsBlock, 'segment') || [];
        const map = {};
        for (const sxml of segFull) {
          const idx = unescapeXml((extractXmlAttrValue(sxml, 'index') || '').trim());
          if (!idx || !/^\d+$/.test(idx)) continue;
          const ids2 = extractAllXMLTags(sxml, 'id') || [];
          const parsedIds = ids2.map(v => unescapeXml((v || '').trim())).filter(Boolean);
          if (parsedIds.length > 0) map[idx] = parsedIds;
        }
        mentionsBySegment = sanitizeMentionsBySegment(map, textSegments.length || 0);
      }
    }
  } catch (e) {
    logger.warn(`<send> 解析失败: ${e.message}`);
    mentionsBySegment = {};
  }

  // 提取 <emoji> 标签（可选，最多一个）
  const emojiBlock = extractXMLTag(responseContent, 'emoji');
  let emoji = null;

  if (emojiBlock && emojiBlock.trim()) {
    try {
      const source = unescapeXml((extractXMLTag(emojiBlock, 'source') || '').trim());
      const caption = unescapeXml((extractXMLTag(emojiBlock, 'caption') || '').trim());

      if (source) {
        emoji = { source };
        if (caption) emoji.caption = caption;
        logger.debug(`找到 <emoji> 标签: ${source.slice(0, 60)}`);
      } else {
        logger.warn('<emoji> 标签缺少 <source> 字段');
      }
    } catch (e) {
      logger.warn(`<emoji> 解析失败: ${e.message}`);
    }
  }

  // 最终验证整体结构
  try {
    const validated = SentraResponseSchema.parse({
      textSegments,
      resources,
      group_id: targetGroupId || undefined,
      user_id: targetUserId || undefined,
      replyMode,
      mentionsBySegment
    });
    //logger.success('协议验证通过');
    //logger.debug(`textSegments: ${validated.textSegments.length} 段`);
    //logger.debug(`resources: ${validated.resources.length} 个`);
    if (emoji) {
      //logger.debug(`emoji: ${emoji.source}`);
      validated.emoji = emoji;  // 添加 emoji 到返回结果
    }

    // 如果既没有有效文本、也没有资源、也没有 emoji，则标记为 shouldSkip，供上层逻辑跳过发送
    const hasText = Array.isArray(validated.textSegments)
      && validated.textSegments.some((t) => (t || '').trim());
    const hasResources = Array.isArray(validated.resources) && validated.resources.length > 0;
    const hasEmoji = !!validated.emoji;

    if (!hasText && !hasResources && !hasEmoji) {
      validated.shouldSkip = true;
    }

    return validated;
  } catch (e) {
    logger.error('协议验证失败', e.errors);
    const hasTag = typeof response === 'string' && response.includes('<sentra-response>');
    let fallback;

    if (textSegments.length === 0) {
      // 解析/验证失败且没有任何有效文本：视为“本轮保持沉默”，由上层跳过发送
      if (hasTag) {
        logger.warn('协议验证失败且 <sentra-response> 中没有有效内容，将跳过发送');
      } else {
        logger.warn('协议验证失败且缺少 <sentra-response>，将跳过发送');
      }
      fallback = { textSegments: [], resources: [], replyMode, mentionsBySegment, shouldSkip: true };
    } else {
      // 保留已提取的文本段落，但不回退为“原文整段发送”
      fallback = { textSegments, resources: [], replyMode, mentionsBySegment };
    }

    if (emoji) fallback.emoji = emoji;  // 即使验证失败也保留 emoji
    return fallback;
  }
}

/**
 * 转换历史对话为 MCP FC 协议格式
 * 从 user 消息中提取 <sentra-result>，转换为对应的 <sentra-tools> assistant 消息
 * 
 * @param {Array} historyConversations - 原始历史对话数组 [{ role, content }]
 * @returns {Array} 转换后的对话数组（不包含 system）
 */
export function convertHistoryToMCPFormat(historyConversations) {
  const mcpConversation = [];
  let convertedCount = 0;
  let skippedCount = 0;

  let bufferedTools = '';

  const pushStandardNoToolPair = (userMsg) => {
    const pendingMessages = extractXMLTag(userMsg.content, 'sentra-pending-messages');
    const uq = extractXMLTag(userMsg.content, 'sentra-user-question') || '';

    if (uq) {
      let userContent = '';
      if (pendingMessages) {
        userContent += `<sentra-pending-messages>\n${pendingMessages}\n</sentra-pending-messages>\n\n`;
      }
      userContent += `<sentra-user-question>\n${uq}\n</sentra-user-question>`;
      mcpConversation.push({ role: 'user', content: userContent });
    } else {
      mcpConversation.push(userMsg);
    }

    let reasonText = extractXMLTag(uq, 'summary') || extractXMLTag(uq, 'text') || '';
    reasonText = (reasonText || '').trim();
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
    mcpConversation.push({ role: 'assistant', content: `${toolsXML}\n\n${resultXML}` });
  };

  const addInvocation = (invocations, seen, aiName, argsContent) => {
    const name = (aiName != null) ? String(aiName).trim() : '';
    if (!name) return;
    const args = argsContent != null ? String(argsContent).trim() : '';
    const key = `${name}|${args}`;
    if (seen.has(key)) return;
    seen.add(key);
    invocations.push({ aiName: name, argsContent: args });
  };

  const extractInvocationsFromResultFullByRegex = (resultFullXml, invocations, seen) => {
    try {
      const aiName = extractXMLTag(resultFullXml, 'aiName');
      const argsJSONText = extractXMLTag(resultFullXml, 'arguments');
      const argsContent = argsJSONText || extractXMLTag(resultFullXml, 'args');
      if (aiName && argsContent != null) {
        addInvocation(invocations, seen, aiName, argsContent);
      }
    } catch {}
  };

  const extractInvocationsAndResultBlocksByParser = (text) => {
    const invocations = [];
    const seen = new Set();
    const groupFullBlocks = extractAllFullXMLTags(text, 'sentra-result-group') || [];
    const singlesFull = extractAllFullXMLTags(text, 'sentra-result') || [];
    const resultBlocksFull = groupFullBlocks.length > 0 ? groupFullBlocks : singlesFull;

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
              } catch {}
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
            } catch {}
          }
          extractInvocationsFromResultFullByRegex(full, invocations, seen);
        }
        return { invocations, resultBlocksFull };
      }
    } catch {}

    return { invocations: [], resultBlocksFull };
  };

  for (const msg of historyConversations) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'system') {
      skippedCount++;
      continue;
    }

    const content = typeof msg.content === 'string' ? msg.content : '';

    // Skip assistant natural language responses in MCP context
    if (msg.role === 'assistant' && content.includes('<sentra-response>')) {
      skippedCount++;
      continue;
    }

    // New format: assistant tools are already present in history
    if (msg.role === 'assistant' && content.includes('<sentra-tools>')) {
      bufferedTools = content;
      continue;
    }

    if (msg.role === 'user') {
      // Legacy combined (result embedded in user message)
      const hasLegacyResults = content.includes('<sentra-result') || content.includes('<sentra-result-group');
      if (hasLegacyResults) {
        const pendingMessages = extractXMLTag(content, 'sentra-pending-messages');
        const userQuestion = extractXMLTag(content, 'sentra-user-question');

        if (userQuestion) {
          let userContent = '';
          if (pendingMessages) {
            userContent += `<sentra-pending-messages>\n${pendingMessages}\n</sentra-pending-messages>\n\n`;
          }
          userContent += `<sentra-user-question>\n${userQuestion}\n</sentra-user-question>`;
          mcpConversation.push({ role: 'user', content: userContent });
        }

        let invocations = [];
        let resultBlocksFull = [];
        try {
          const parsedOut = extractInvocationsAndResultBlocksByParser(content);
          invocations = parsedOut.invocations || [];
          resultBlocksFull = parsedOut.resultBlocksFull || [];
        } catch {
          invocations = [];
          resultBlocksFull = [];
        }

        let combined = '';
        if (invocations.length > 0) {
          combined = buildSentraToolsBatch(invocations);
          convertedCount += invocations.length;
        }
        if (resultBlocksFull.length > 0) {
          const resultsXML = resultBlocksFull.join('\n\n');
          combined = combined ? `${combined}\n\n${resultsXML}` : resultsXML;
        }
        if (combined) {
          mcpConversation.push({ role: 'assistant', content: combined });
        }

        bufferedTools = '';
        continue;
      }

      // New format user base context: contains <sentra-user-question> but no <sentra-result>
      if (content.includes('<sentra-user-question>')) {
        bufferedTools = '';
        mcpConversation.push({ role: 'user', content });
        continue;
      }

      // New format user results-only message
      const hasResultOnly = content.includes('<sentra-result') || content.includes('<sentra-result-group');
      if (hasResultOnly) {
        const groupFullBlocks = extractAllFullXMLTags(content, 'sentra-result-group') || [];
        const singlesFull = extractAllFullXMLTags(content, 'sentra-result') || [];
        const resultBlocksFull = groupFullBlocks.length > 0 ? groupFullBlocks : singlesFull;
        const resultsXML = resultBlocksFull.length > 0 ? resultBlocksFull.join('\n\n') : content;
        const combined = bufferedTools ? `${bufferedTools}\n\n${resultsXML}` : resultsXML;
        mcpConversation.push({ role: 'assistant', content: combined });
        bufferedTools = '';
        convertedCount++;
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
      const hasUq = c.includes('<sentra-user-question>');
      const hasRes = c.includes('<sentra-result') || c.includes('<sentra-result-group');
      if (hasUq && !hasRes) {
        const lastOut = mcpConversation.length ? mcpConversation[mcpConversation.length - 1] : null;
        if (!lastOut || lastOut.role !== 'assistant') {
          pushStandardNoToolPair(last);
        }
      }
    }
  } catch {}

  logger.debug(
    `MCP格式转换: ${historyConversations.length}条 → ${mcpConversation.length}条 (转换${convertedCount}个工具, 跳过${skippedCount}条)`
  );
  return mcpConversation;
}

function inferScalarForParam(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  const n = Number(trimmed);
  if (!Number.isNaN(n)) return n;
  return trimmed;
}

// (string|number|boolean|null|array|object) 渲染为 <parameter> 内部的 XML 行
function renderTypedValueLinesForParam(value, indentLevel = 3) {
  const lines = [];
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
      lines.push(...renderTypedValueLinesForParam(item, indentLevel + 1));
    }
    lines.push(`${pad}</array>`);
    return lines;
  }

  if (t === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      lines.push(`${pad}<object />`);
      return lines;
    }
    lines.push(`${pad}<object>`);
    for (const key of keys) {
      const keyAttr = escapeXmlAttr(String(key));
      const paramPad = '  '.repeat(indentLevel + 1);
      lines.push(`${paramPad}<parameter name="${keyAttr}">`);
      lines.push(...renderTypedValueLinesForParam(value[key], indentLevel + 2));
      lines.push(`${paramPad}</parameter>`);
    }
    lines.push(`${pad}</object>`);
    return lines;
  }

  // 其他类型统一按字符串处理
  lines.push(`${pad}<string>${valueToXMLString(String(value), 0)}</string>`);
  return lines;
}

// 构建单个 typed <parameter> 块
function buildTypedParameterBlock(name, jsValue) {
  const safeName = escapeXmlAttr(String(name));
  const lines = [];
  lines.push(`    <parameter name="${safeName}">`);
  lines.push(...renderTypedValueLinesForParam(jsValue, 3));
  lines.push('    </parameter>');
  return lines;
}

export function buildSentraToolsBlockFromArgsObject(aiName, argsObj) {
  const xmlLines = ['<sentra-tools>'];
  xmlLines.push(`  <invoke name="${escapeXmlAttr(String(aiName || ''))}">`);
  if (argsObj && typeof argsObj === 'object') {
    for (const [key, value] of Object.entries(argsObj)) {
      const paramLines = buildTypedParameterBlock(key, value);
      xmlLines.push(...paramLines);
    }
  }
  xmlLines.push('  </invoke>');
  xmlLines.push('</sentra-tools>');
  return xmlLines.join('\n');
}

export function buildSentraToolsBlockFromInvocations(invocations) {
  const xmlLines = ['<sentra-tools>'];
  const items = Array.isArray(invocations) ? invocations : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const aiName = item.aiName;
    const argsObj = item.args;
    xmlLines.push(`  <invoke name="${escapeXmlAttr(String(aiName || ''))}">`);
    if (argsObj && typeof argsObj === 'object') {
      for (const [key, value] of Object.entries(argsObj)) {
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
 * 从 <args> 内容构建 <sentra-tools> 块（MCP FC 标准格式）
 * 
 * @param {string} aiName - 工具名称
 * @param {string} argsContent - <args> 标签内的内容
 * @returns {string} <sentra-tools> XML 字符串
 */
function buildSentraToolsFromArgs(aiName, argsContent) {
  const xmlLines = ['<sentra-tools>'];
  xmlLines.push(`  <invoke name="${escapeXmlAttr(String(aiName || ''))}">`);

  const parsed = parseArgsContentToObject(argsContent);
  if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) {
      const paramLines = buildTypedParameterBlock(key, value);
      xmlLines.push(...paramLines);
    }
  }

  xmlLines.push('  </invoke>');
  xmlLines.push('</sentra-tools>');
  return xmlLines.join('\n');
}

// 批量构建 <sentra-tools>，包含多个 <invoke>
function buildSentraToolsBatch(items) {
  const xmlLines = ['<sentra-tools>'];
  for (const { aiName, argsContent } of items) {
    xmlLines.push(`  <invoke name="${escapeXmlAttr(String(aiName || ''))}">`);
    const parsed = parseArgsContentToObject(argsContent);
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        const paramLines = buildTypedParameterBlock(key, value);
        xmlLines.push(...paramLines);
      }
    }
    xmlLines.push('  </invoke>');
  }
  xmlLines.push('</sentra-tools>');
  return xmlLines.join('\n');
}
