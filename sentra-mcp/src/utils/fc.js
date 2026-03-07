// Function-call fallback utilities: parse <sentra-tools> blocks and build instructions
// Prompts are loaded from JSON under src/agent/prompts/ via loader.
import { loadPrompt, renderTemplate, pickLocalizedPrompt, resolvePromptLocale } from '../agent/prompts/loader.js';
import { XMLParser } from 'fast-xml-parser';
import { buildToolResultContract } from './tool_artifacts.js';

/**
 * Extract <sentra-tools> ... </sentra-tools> blocks from text and parse to calls
 * Returns array of { name: string, arguments: any } using the Sentra XML Protocol.
 *
 * XML format (Sentra XML Protocol):
 * <sentra-tools>
 *   <invoke name="tool_name">
 *     <parameter name="param1"><string>value1</string></parameter>
 *     <parameter name="param2"><object>...</object></parameter>
 *   </invoke>
 * </sentra-tools>
 */
export function parseFunctionCalls(text = '', opts = {}) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const blocks = extractAllFullXmlTagsOrdered(text, ['sentra-tools', 'sentra_tools']);
  for (const block of blocks) {
    const lower = String(block || '').toLowerCase();
    const tagName = lower.includes('<sentra_tools') ? 'sentra_tools' : 'sentra-tools';
    const raw = extractInnerXmlFromFullTag(block, tagName).trim();
    if (!raw) continue;
    // Parse Sentra XML tool call
    const xmlCall = parseSentraXML(raw);
    if (xmlCall) {
      out.push(xmlCall);
    }
  }
  return out;
}

function isTagBoundary(ch) {
  return ch === '' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '>' || ch === '/';
}

function findTagEnd(text, from) {
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
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
}

function isSelfClosingTag(text, openEnd) {
  for (let i = openEnd - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
    return ch === '/';
  }
  return false;
}

function extractFullXmlTagAt(text, tagName, openPos) {
  const s = String(text || '');
  const tag = String(tagName || '').trim();
  if (!s || !tag || openPos < 0 || openPos >= s.length) return null;
  const lower = s.toLowerCase();
  const lowerTag = tag.toLowerCase();
  if (!lower.startsWith(`<${lowerTag}`, openPos)) return null;
  const afterName = lower[openPos + lowerTag.length + 1] || '';
  if (!isTagBoundary(afterName)) return null;

  const firstOpenEnd = findTagEnd(s, openPos);
  if (firstOpenEnd < 0) return null;
  if (isSelfClosingTag(s, firstOpenEnd)) return s.slice(openPos, firstOpenEnd + 1);

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
      const skipEnd = findTagEnd(s, nextLt);
      if (skipEnd < 0) return null;
      cursor = skipEnd + 1;
      continue;
    }

    const nameAfter = lower[nextLt + lowerTag.length + (isClose ? 2 : 1)] || '';
    if (!isTagBoundary(nameAfter)) {
      cursor = nextLt + 1;
      continue;
    }

    const tagEnd = findTagEnd(s, nextLt);
    if (tagEnd < 0) return null;

    if (isClose) {
      depth -= 1;
      if (depth === 0) return s.slice(openPos, tagEnd + 1);
    } else if (!isSelfClosingTag(s, tagEnd)) {
      depth += 1;
    }
    cursor = tagEnd + 1;
  }
  return null;
}

function findNextOpenPos(text, tagName, from) {
  const s = String(text || '');
  const lower = s.toLowerCase();
  const lowerTag = String(tagName || '').trim().toLowerCase();
  if (!lowerTag) return -1;
  let pos = lower.indexOf(`<${lowerTag}`, from);
  while (pos >= 0) {
    const afterName = lower[pos + lowerTag.length + 1] || '';
    if (isTagBoundary(afterName)) return pos;
    pos = lower.indexOf(`<${lowerTag}`, pos + 1);
  }
  return -1;
}

function extractAllFullXmlTagsOrdered(text, tagNames) {
  const s = String(text || '');
  const tags = (Array.isArray(tagNames) ? tagNames : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  if (!s || tags.length === 0) return [];

  const out = [];
  let cursor = 0;
  while (cursor < s.length) {
    let bestPos = -1;
    let bestTag = '';
    for (const tag of tags) {
      const pos = findNextOpenPos(s, tag, cursor);
      if (pos < 0) continue;
      if (bestPos < 0 || pos < bestPos) {
        bestPos = pos;
        bestTag = tag;
      }
    }
    if (bestPos < 0 || !bestTag) break;

    const full = extractFullXmlTagAt(s, bestTag, bestPos);
    if (!full) {
      cursor = bestPos + 1;
      continue;
    }
    out.push(full);
    cursor = bestPos + full.length;
  }
  return out;
}

function extractInnerXmlFromFullTag(fullTagXml, tagName) {
  const xml = String(fullTagXml || '');
  const tag = String(tagName || '').trim().toLowerCase();
  if (!xml || !tag) return '';
  const openStart = xml.indexOf('<');
  if (openStart < 0) return '';
  const openEnd = findTagEnd(xml, openStart);
  if (openEnd < 0) return '';

  const lower = xml.toLowerCase();
  const closeStart = lower.lastIndexOf(`</${tag}`);
  if (closeStart < 0 || closeStart < openEnd) return '';
  return xml.slice(openEnd + 1, closeStart);
}

/**
 * Build instruction text to ask the model to emit a single <function_call> block for a given function
 */
export async function buildFunctionCallInstruction({ name, parameters, locale = 'en' } = {}) {
  const prettySchema = parameters ? JSON.stringify(parameters, null, 2) : '{}';
  const req = Array.isArray(parameters?.required) ? parameters.required : [];
  const reqHintEn = req.length
    ? `- Must include required fields: ${req.join(', ')}`
    : '- If no required fields: include only necessary fields, avoid extras';

  const arrayFields = [];
  if (parameters && typeof parameters === 'object' && parameters.properties && typeof parameters.properties === 'object') {
    for (const [key, value] of Object.entries(parameters.properties)) {
      const type = value && value.type;
      if (type === 'array' || (Array.isArray(type) && type.includes('array'))) {
        arrayFields.push(key);
      }
    }
  }

  let reqHint = reqHintEn;
  if (arrayFields.length > 0) {
    const list = arrayFields.join(', ');
    reqHint += `\n- The following parameters are array-typed in the schema and intended for batching: ${list}. Merge similar targets into one call.`;
  } else {
    reqHint += '\n- Prefer batched calls when array-typed fields exist (cities/queries/keywords/etc.).';
  }

  const pf = await loadPrompt('fc_function_sentra');
  const tpl = pickLocalizedPrompt(pf, resolvePromptLocale(locale));
  return renderTemplate(tpl, { name, schema: prettySchema, req_hint: reqHint });
}

/**
 * Build planning instruction to emit emit_plan function call with plan schema and allowed tool names.
 */
export async function buildPlanFunctionCallInstruction({ allowedAiNames = [], locale = 'en' } = {}) {
  const allow = Array.isArray(allowedAiNames) && allowedAiNames.length ? allowedAiNames.join(', ') : '(none)';
  const hasAllow = Array.isArray(allowedAiNames) && allowedAiNames.length > 0;
  const schemaHint = JSON.stringify({
    overview: 'string (optional)',
    steps: [{
      stepId: 'string (required, unique)',
      executor: 'string (optional: mcp|sandbox)',
      actionRef: 'string (optional, e.g. terminal.run for sandbox)',
      aiName: 'string (required, from allowed list)',
      reason: ['string', 'string'],
      nextStep: 'string',
      draftArgs: { '...': '...' },
      dependsOnStepIds: ['string stepId array (optional)']
    }]
  }, null, 2);

  const pf = await loadPrompt('fc_plan_sentra');
  const localeResolved = resolvePromptLocale(locale);
  const isZh = localeResolved === 'zh';
  const tpl = pickLocalizedPrompt(pf, localeResolved);

  const pfReq = await loadPrompt('fc_plan_require_line');
  const localeKey = isZh ? 'zh' : 'en';
  const reqBlock = (pfReq && pfReq[localeKey]) || {};
  const rawReqTpl = hasAllow ? reqBlock.has_allow : reqBlock.no_allow;
  const require_line = renderTemplate(rawReqTpl || '', { allowed_list: allow });

  return renderTemplate(tpl, {
    allowed_list: allow,
    require_line,
    schema_hint: schemaHint,
  });
}

/**
 * Build policy text describing usage & constraints for function_call markers.
 */
export async function buildFCPolicy({ locale = 'en' } = {}) {
  const pf = await loadPrompt('fc_policy_sentra');
  const localeResolved = resolvePromptLocale(locale);
  const isZh = localeResolved === 'zh';
  const tpl = pickLocalizedPrompt(pf, localeResolved);
  const base = renderTemplate(tpl, { tag: '<sentra-tools>' });

  const batchSectionZh = '\n\n## 批量调用与数组参数（效率优先）\n\n- 优先用数组参数一次处理多个同类目标。\n- 避免把可批量的任务拆成多次几乎相同的调用。';
  const batchSectionEn = '\n\n## Batch Calls and Array Parameters (Efficiency First)\n\n- Prefer array-typed parameters to process multiple similar targets in one call.\n- Avoid splitting batchable work into many nearly identical calls.';

  return base + (isZh ? batchSectionZh : batchSectionEn);
}

function safeParseJson(s) {
  if (typeof s !== 'string') return null;
  try {
    // Arguments/data blocks are XML text nodes and may contain escaped entities.
    return JSON.parse(unescapeXmlEntities(s));
  } catch {
    // naive fallback: try best-effort extract from first { to last }
    const decoded = unescapeXmlEntities(s);
    const i = decoded.indexOf('{');
    const j = decoded.lastIndexOf('}');
    if (i >= 0 && j > i) {
      const t = decoded.slice(i, j + 1);
      try { return JSON.parse(t); } catch {}
    }
  }
  return null;
}

// Simple XML entity unescape (kept local to avoid cross-module deps)
function unescapeXmlEntities(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function escapeXmlEntities(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Dedicated XML parser instance for <sentra-tools> blocks.
// We disable automatic value/attribute parsing so that type decoding is
// entirely controlled by our own typed node protocol
// (<string>/<number>/<boolean>/<null>/<array>/<object>).
const sentraToolsXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

const sentraResultXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  allowBooleanAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  stopNodes: ['*.arguments', '*.data']
});

// Best-effort parser for typed XML value blocks like
// <array><object>...</object></array> or <object><parameter ...>...</parameter></object>
function parseStructuredXmlValue(raw) {
  if (!raw) return { matched: false };
  const t = stripCodeFences(String(raw)).trim();
  if (!t) return { matched: false };
  try {
    const parsed = sentraToolsXmlParser.parse(`<root>${t}</root>`);
    const root = parsed && typeof parsed === 'object' ? parsed.root : null;
    if (!root || typeof root !== 'object') return { matched: false };
    const typeKeys = ['array', 'object', 'string', 'number', 'boolean', 'null'];
    const hitKey = typeKeys.find((k) => Object.prototype.hasOwnProperty.call(root, k));
    if (!hitKey) return { matched: false };
    const wrapper = { [hitKey]: root[hitKey] };
    return { matched: true, value: decodeAstTypedValue(wrapper) };
  } catch {
    return { matched: false };
  }
}

function parseXmlArray(inner) {
  if (!inner || typeof inner !== 'string') return [];
  const parsed = parseStructuredXmlValue(`<array>${inner}</array>`);
  if (!parsed || !parsed.matched || !Array.isArray(parsed.value)) return [];
  return parsed.value;
}

function parseXmlObject(inner) {
  if (!inner || typeof inner !== 'string') return {};
  const parsed = parseStructuredXmlValue(`<object>${inner}</object>`);
  if (!parsed || !parsed.matched || parsed.value == null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return {};
  }
  return parsed.value;
}

// Extract concatenated text content from a fast-xml-parser AST node.
function extractAstText(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((n) => extractAstText(n)).join('');
  }
  if (typeof node === 'object') {
    // Prefer explicit text node when present
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

function decodeAstTypedValue(node) {
  if (node == null) return null;
  if (typeof node !== 'object') {
    return inferScalarType(String(node));
  }

  if (Object.prototype.hasOwnProperty.call(node, 'string')) {
    // For tool arguments we expect XML-escaped special chars; decode them so
    // downstream tools receive raw text (HTML, code, etc.).
    const raw = extractAstText(node.string);
    return unescapeXmlEntities(raw);
  }
  if (Object.prototype.hasOwnProperty.call(node, 'number')) {
    const raw = extractAstText(node.number);
    const n = Number(String(raw).trim());
    return Number.isNaN(n) ? raw : n;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'boolean')) {
    const raw = String(extractAstText(node.boolean)).trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'null')) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(node, 'array')) {
    return decodeAstArray(node.array);
  }
  if (Object.prototype.hasOwnProperty.call(node, 'object')) {
    return decodeAstObject(node.object);
  }

  // Fallback: treat whole node as scalar text
  return inferScalarType(extractAstText(node));
}

function decodeAstArray(arrayNode) {
  if (arrayNode == null) return [];
  const values = [];
  const containers = Array.isArray(arrayNode) ? arrayNode : [arrayNode];
  const typeKeys = ['string', 'number', 'boolean', 'null', 'array', 'object'];

  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    for (const key of typeKeys) {
      if (!Object.prototype.hasOwnProperty.call(c, key)) continue;
      const raw = c[key];
      const items = Array.isArray(raw) ? raw : [raw];
      for (const it of items) {
        const wrapper = { [key]: it };
        values.push(decodeAstTypedValue(wrapper));
      }
    }
  }
  return values;
}

function decodeAstObject(objectNode) {
  const out = {};
  if (objectNode == null) return out;
  const containers = Array.isArray(objectNode) ? objectNode : [objectNode];

  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    const props = [];
    if (c.property !== undefined) {
      const list = Array.isArray(c.property) ? c.property : [c.property];
      props.push(...list);
    }
    if (c.parameter !== undefined) {
      const list = Array.isArray(c.parameter) ? c.parameter : [c.parameter];
      props.push(...list);
    }
    for (const p of props) {
      if (!p || typeof p !== 'object') continue;
      const key = String(p['@_name'] || '').trim();
      if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key] = decodeAstTypedValue(p);
    }
  }
  return out;
}

function parseSentraXMLFast(raw) {
  if (!raw) return null;
  const inner = stripCodeFences(raw);
  const wrapped = `<sentra-tools>${inner}</sentra-tools>`;
  let ast;
  try {
    ast = sentraToolsXmlParser.parse(wrapped);
  } catch {
    return null;
  }
  if (!ast || typeof ast !== 'object') return null;

  const root = ast['sentra-tools'] || ast.sentra_tools || ast;
  if (!root || typeof root !== 'object') return null;

  let invoke = root.invoke;
  if (!invoke) return null;
  if (Array.isArray(invoke)) invoke = invoke[0];
  if (!invoke || typeof invoke !== 'object') return null;

  const name = String(invoke['@_name'] || '').trim();
  if (!name) return null;

  const rawParams = invoke.parameter;
  const paramsArr = Array.isArray(rawParams) ? rawParams : (rawParams ? [rawParams] : []);
  const args = {};

  for (const p of paramsArr) {
    if (!p || typeof p !== 'object') continue;
    const paramName = String(p['@_name'] || '').trim();
    if (!paramName || Object.prototype.hasOwnProperty.call(args, paramName)) continue;

    // First try JSON if the entire parameter body is a raw JSON string
    const txt = extractAstText(p).trim();
    if ((txt.startsWith('{') && txt.endsWith('}')) || (txt.startsWith('[') && txt.endsWith(']'))) {
      const parsed = safeParseJson(txt);
      if (parsed !== null) {
        args[paramName] = parsed;
        continue;
      }
    }

    // Then apply typed-node decoding (<string>/<number>/<boolean>/<null>/<array>/<object>)
    const val = decodeAstTypedValue(p);
    args[paramName] = val;
  }

  // Some tools have no required args. Empty parameter lists are valid.
  return { name, arguments: args };
}
/**
 * Main Sentra XML parser entry: use fast-xml-parser AST mapping
 * for well-formed <sentra-tools> blocks. Malformed or non-XML
 * content simply yields null and is ignored.
 */
function parseSentraXML(raw) {
  if (!raw) return null;
  return parseSentraXMLFast(raw);
}

/**
 * Infer scalar type from string value
 * - Numbers: convert to number
 * - Booleans: convert to boolean
 * - null: convert to null
 * - Others: keep as string (preserve spaces)
 */
function inferScalarType(value) {
  if (typeof value !== 'string') return value;
  
  const trimmed = value.trim();
  
  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  
  // null
  if (trimmed === 'null') return null;
  
  // Number
  if (trimmed !== '' && !isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  
  // String (preserve original spacing)
  return value;
}

function stripCodeFences(s) {
  const t = String(s || '').trim();
  if (t.startsWith('```')) {
    // remove starting fence line
    const firstNl = t.indexOf('\n');
    if (firstNl >= 0) {
      const rest = t.slice(firstNl + 1);
      // remove ending fence if present
      const endIdx = rest.lastIndexOf('```');
      return endIdx >= 0 ? rest.slice(0, endIdx).trim() : rest.trim();
    }
  }
  return t;
}

function valueToTypedXml(value) {
  if (value === null || value === undefined) {
    return '<null></null>';
  }
  if (typeof value === 'string') {
    return `<string>${escapeXmlEntities(value)}</string>`;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return `<number>${escapeXmlEntities(String(value))}</number>`;
    return `<string>${escapeXmlEntities(String(value))}</string>`;
  }
  if (typeof value === 'boolean') {
    return `<boolean>${value ? 'true' : 'false'}</boolean>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '<array></array>';
    const inner = value.map((v) => valueToTypedXml(v)).join('');
    return `<array>${inner}</array>`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '<object></object>';
    const props = entries.map(([k, v]) => {
      const safeKey = escapeXmlEntities(String(k ?? ''));
      return `<parameter name="${safeKey}">${valueToTypedXml(v)}</parameter>`;
    }).join('');
    return `<object>${props}</object>`;
  }
  return `<string>${escapeXmlEntities(String(value))}</string>`;
}

/**
 * Format a tool call to Sentra XML format
 * @param {string} name - Tool name
 * @param {Object} args - Tool arguments
 * @returns {string} XML formatted tool call
 */
export function formatSentraToolCall(name, args = {}) {
  const safeName = escapeXmlEntities(String(name ?? ''));
  const params = Object.entries(args || {}).map(([key, value]) => {
    const safeKey = escapeXmlEntities(String(key ?? ''));
    const typed = valueToTypedXml(value);
    return `    <parameter name="${safeKey}">${typed}</parameter>`;
  }).join('\n');
  
  return `<sentra-tools>
  <invoke name="${safeName}">
${params}
  </invoke>
</sentra-tools>`;
}

/**
 * Format a tool result to Sentra XML format
 * @param {Object} params
 * @param {number} params.stepIndex - Legacy fallback index (used only when stepId is missing)
 * @param {string} params.stepId - Unique step identifier
 * @param {string} params.aiName - Tool name
 * @param {string|Array} params.reason - Reason for using the tool
 * @param {Object} params.args - Tool arguments
 * @param {Object} params.result - Tool execution result
 * @returns {string} XML formatted result
 */
export function formatSentraResult({
  stepIndex,
  stepId,
  aiName,
  reason,
  args,
  result,
  includeResultData = false
}) {
  const reasonText = Array.isArray(reason) ? reason.join('; ') : String(reason || '');
  const contract = buildToolResultContract(result || {});
  const success = contract.success === true;
  const code = String(contract.code || '');
  const provider = String(contract.provider || '');

  const fallbackId = Number.isFinite(Number(stepIndex)) ? `step_${Number(stepIndex)}` : 'step_0';
  const safeStepId = escapeXmlEntities(
    (typeof stepId === 'string' && stepId.trim()) ? stepId.trim() : fallbackId
  );
  const safeTool = escapeXmlEntities(String(aiName ?? ''));
  const safeSuccess = escapeXmlEntities(String(success));
  const safeCode = escapeXmlEntities(code);
  const safeProvider = escapeXmlEntities(provider);
  const safeReason = escapeXmlEntities(reasonText);
  const argsXml = valueToTypedXml(args || {});
  const dataSource = (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'data'))
    ? result.data
    : result;
  const dataXml = includeResultData
    ? `\n  <data>${valueToTypedXml(dataSource)}</data>`
    : '';
  const ref = contract.resultRef && typeof contract.resultRef === 'object' ? contract.resultRef : null;
  const refXml = ref
    ? [
      '  <result_ref>',
      `    <uuid>${escapeXmlEntities(String(ref.uuid || ''))}</uuid>`,
      `    <path>${escapeXmlEntities(String(ref.path || ''))}</path>`,
      `    <type>${escapeXmlEntities(String(ref.type || ''))}</type>`,
      `    <role>${escapeXmlEntities(String(ref.role || ''))}</role>`,
      `    <hash>${escapeXmlEntities(String(ref.hash || ''))}</hash>`,
      `    <size>${escapeXmlEntities(String(ref.size ?? ''))}</size>`,
      '  </result_ref>'
    ].join('\n')
    : '  <result_ref />';
  const uuids = Array.isArray(contract.artifactUuids) ? contract.artifactUuids : [];
  const idsXml = uuids.map((u) => `    <uuid>${escapeXmlEntities(String(u || ''))}</uuid>`).join('\n');
  const errXml = contract.error ? `\n  <error>${escapeXmlEntities(String(contract.error || ''))}</error>` : '';
  
  return `<sentra-result>
  <step_id>${safeStepId}</step_id>
  <tool>${safeTool}</tool>
  <success>${safeSuccess}</success>
  <code>${safeCode}</code>
  <provider>${safeProvider}</provider>
  <reason>${safeReason}</reason>
  <args>${argsXml}</args>
  ${dataXml}
  ${refXml}
  <artifact_uuids>
${idsXml}
  </artifact_uuids>${errXml}
</sentra-result>`;
}

/**
 * Format message text into unified <sentra-input> XML.
 * @param {string} text
 * @returns {string}
 */
export function formatSentraInput(text) {
  const safe = escapeXmlEntities(String(text ?? ''));
  return `<sentra-input><current_messages><sentra-message><chat_type>system_task</chat_type><message><segment index="1"><type>text</type><data><text>${safe}</text></data></segment></message></sentra-message></current_messages></sentra-input>`;
}

// Backward-compatible alias: some older stage modules still import this name.
export function formatSentraUserQuestion(question) {
  return formatSentraInput(question);
}

/**
 * Parse <sentra-result> XML format
 * Returns { stepIndex, aiName, reason, args, result, success }
 */
function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

function findFirstTagNode(node, tagName) {
  if (!node || typeof node !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(node, tagName)) {
    const hit = node[tagName];
    return Array.isArray(hit) ? hit[0] : hit;
  }
  for (const v of Object.values(node)) {
    const found = findFirstTagNode(v, tagName);
    if (found) return found;
  }
  return null;
}

function parseTrailingDigits(s, fallback = 0) {
  const str = String(s || '');
  let end = str.length - 1;
  while (end >= 0 && str[end] >= '0' && str[end] <= '9') end -= 1;
  const numText = str.slice(end + 1);
  const n = Number.parseInt(numText, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseSentraResult(text) {
  if (!text || typeof text !== 'string') return null;
  const withoutFences = stripCodeFences(text);

  try {
    const wrapped = `<root>${withoutFences}</root>`;
    const doc = sentraResultXmlParser.parse(wrapped);
    const sr = findFirstTagNode(doc?.root || doc, 'sentra-result');
    if (!sr || typeof sr !== 'object') return null;

    const readNodeText = (node) => String(extractAstText(node)).trim();
    const stepId = (typeof sr['@_step_id'] === 'string' && sr['@_step_id'].trim())
      ? sr['@_step_id'].trim()
      : readNodeText(sr.step_id);
    let stepIndex = parseInt(String(sr['@_step'] ?? ''), 10);
    if (!Number.isFinite(stepIndex)) stepIndex = parseTrailingDigits(stepId, 0);
    const aiName = typeof sr['@_tool'] === 'string' && sr['@_tool'].trim()
      ? sr['@_tool'].trim()
      : readNodeText(sr.tool || sr.aiName);
    const successRaw = sr['@_success'] ?? readNodeText(sr.success) ?? 'true';
    const success = String(successRaw).toLowerCase() === 'true';
    const code = typeof sr['@_code'] === 'string' && sr['@_code'].trim()
      ? sr['@_code'].trim()
      : readNodeText(sr.code);
    const provider = typeof sr['@_provider'] === 'string' && sr['@_provider'].trim()
      ? sr['@_provider'].trim()
      : readNodeText(sr.provider);
    if (!aiName) return null;

    const reasonRaw = typeof sr.reason === 'string' ? sr.reason : readNodeText(sr.reason);
    const reason = reasonRaw ? unescapeXmlEntities(reasonRaw) : '';
    const argsNode = sr.args !== undefined ? sr.args : sr.arguments;
    const rawArgs = typeof argsNode === 'string' ? argsNode : '';
    const dataNode = sr.data;
    const rawData = typeof dataNode === 'string' ? dataNode : '';

    let args = {};
    if (argsNode && typeof argsNode === 'object') {
      const decoded = decodeAstTypedValue(argsNode);
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        args = decoded;
      }
    } else if (rawArgs) {
      const jsonArgs = safeParseJson(rawArgs);
      if (jsonArgs && typeof jsonArgs === 'object') {
        args = jsonArgs;
      } else {
        const parsed = parseStructuredXmlValue(rawArgs);
        if (parsed && parsed.matched) {
          args = parsed.value;
        }
      }
    }

    let data = null;
    if (dataNode && typeof dataNode === 'object') {
      const decoded = decodeAstTypedValue(dataNode);
      if (decoded !== undefined) {
        data = decoded;
      }
    }
    if (rawData) {
      const jsonData = safeParseJson(rawData);
      if (jsonData !== null && jsonData !== undefined) {
        data = jsonData;
      } else {
        const parsed = parseStructuredXmlValue(rawData);
        if (parsed && parsed.matched) {
          data = parsed.value;
        } else {
          data = rawData;
        }
      }
    }
    const refNodeRaw = Array.isArray(sr.result_ref) ? sr.result_ref[0] : sr.result_ref;
    const resultRef = (refNodeRaw && typeof refNodeRaw === 'object')
      ? {
        uuid: String(refNodeRaw['@_uuid'] || readNodeText(refNodeRaw.uuid) || ''),
        path: String(refNodeRaw['@_path'] || readNodeText(refNodeRaw.path) || ''),
        type: String(refNodeRaw['@_type'] || readNodeText(refNodeRaw.type) || ''),
        role: String(refNodeRaw['@_role'] || readNodeText(refNodeRaw.role) || ''),
        hash: String(refNodeRaw['@_hash'] || readNodeText(refNodeRaw.hash) || ''),
        size: Number.isFinite(Number(refNodeRaw['@_size']))
          ? Number(refNodeRaw['@_size'])
          : (Number.isFinite(Number(readNodeText(refNodeRaw.size))) ? Number(readNodeText(refNodeRaw.size)) : null),
      }
      : null;
    const uuidsNode = sr.artifact_uuids;
    const uuidItemsRaw = toArray(uuidsNode?.uuid);
    const artifactUuids = uuidItemsRaw.map((x) => String(x || '').trim()).filter(Boolean);
    const resultObj = {
      success,
      code,
      provider,
      resultRef,
      artifactUuids,
    };
    const errText = typeof sr.error === 'string' ? sr.error.trim() : readNodeText(sr.error);
    if (errText) resultObj.error = unescapeXmlEntities(errText);
    if (data !== null && data !== undefined) resultObj.data = data;
    return { stepIndex, stepId: stepId || undefined, aiName, reason, args, result: resultObj, success };
  } catch {
    return null;
  }
}

/**
 * Parse <sentra-input> XML and return plain text from message segments.
 */
export function parseSentraInput(text) {
  if (!text || typeof text !== 'string') return null;
  const withoutFences = stripCodeFences(text);
  try {
    const wrapped = `<root>${withoutFences}</root>`;
    const doc = sentraResultXmlParser.parse(wrapped);
    const input = findFirstTagNode(doc?.root || doc, 'sentra-input');
    const current = input && typeof input === 'object'
      ? findFirstTagNode(input, 'current_messages')
      : null;
    const currentMessage = current && typeof current === 'object'
      ? findFirstTagNode(current, 'sentra-message')
      : null;
    const message = currentMessage && typeof currentMessage === 'object'
      ? findFirstTagNode(currentMessage, 'message')
      : null;
    const segmentsRaw = message && typeof message === 'object' ? (message.segment ?? message.segments?.segment) : null;
    const segments = Array.isArray(segmentsRaw) ? segmentsRaw : (segmentsRaw ? [segmentsRaw] : []);
    const texts = [];
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue;
      const type = String(seg.type || '').trim().toLowerCase();
      if (type !== 'text') continue;
      const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
      const value = typeof data.text === 'string' ? data.text : '';
      if (value.trim()) texts.push(unescapeXmlEntities(value.trim()));
    }
    if (texts.length > 0) return texts.join('\n');
    return null;
  } catch {
    return null;
  }
}

export default { 
  parseFunctionCalls, 
  buildFunctionCallInstruction, 
  buildPlanFunctionCallInstruction, 
  buildFCPolicy,
  formatSentraToolCall,
  formatSentraResult,
  formatSentraInput,
  formatSentraUserQuestion,
  parseSentraResult,
  parseSentraInput
};


