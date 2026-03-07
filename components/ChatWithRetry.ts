import { createLogger } from '../utils/logger.js';
import { tokenCounter } from '../src/token-counter.js';
import { getEnv, getEnvInt, getEnvBool } from '../utils/envHotReloader.js';
import { extractAllFullXMLTags, extractXMLTag, extractXmlAttrValue, tryParseXmlFragment } from '../utils/xmlUtils.js';
import { preprocessPlainModelOutput } from './OutputPreprocessor.js';
import { parseSentraMessage, parseSentraToolsInvocations } from '../utils/protocolUtils.js';
import type { ExpectedOutput, FormatCheckResult, ChatMessage, ModelFormatFixParams } from '../src/types.js';
import type { SentraMessageSegment } from '../utils/protocolUtils.js';
import { tRuntimeFormat } from '../utils/i18n/runtimeFormatCatalog.js';
import {
  guardAndNormalizeSentraMessage,
  shouldAttemptModelFormatFix,
  attemptModelFormatFixWithAgent,
  runSentraFormatFixPipeline
} from '../utils/responseFormatGuard.js';
import {
  buildSentraContractPolicyText,
  getSentraContractParameterEnum,
  getSentraContractRequiredInvokeName,
  getSentraContractOutputInstruction,
} from '../utils/sentraToolsContractEngine.js';

const logger = createLogger('ChatWithRetry');
const REPLY_GATE_CONTRACT_ID = 'reply_gate_decision';
const OVERRIDE_CONTRACT_ID = 'override_intent_decision';
const REPLY_GATE_INVOKE_NAME =
  getSentraContractRequiredInvokeName(REPLY_GATE_CONTRACT_ID, 'reply_gate_decision') ||
  'reply_gate_decision';
const OVERRIDE_INVOKE_NAME =
  getSentraContractRequiredInvokeName(OVERRIDE_CONTRACT_ID, 'override_intent_decision') ||
  'override_intent_decision';
const OVERRIDE_ALLOWED_DECISIONS = new Set(
  getSentraContractParameterEnum(OVERRIDE_CONTRACT_ID, 'decision')
    .map((x) => String(x || '').trim().toLowerCase())
    .filter(Boolean)
);
const REPLY_GATE_OUTPUT_INSTRUCTION = getSentraContractOutputInstruction(REPLY_GATE_CONTRACT_ID);
const REPLY_GATE_POLICY_TEXT = buildSentraContractPolicyText(REPLY_GATE_CONTRACT_ID);
const OVERRIDE_OUTPUT_INSTRUCTION = getSentraContractOutputInstruction(OVERRIDE_CONTRACT_ID);
const OVERRIDE_POLICY_TEXT = buildSentraContractPolicyText(OVERRIDE_CONTRACT_ID);

type ChatOptions = Record<string, unknown> & {
  model?: string;
  timeout?: number;
  __sentraExpectedOutput?: ExpectedOutput;
};

type EarlyTerminateEvent = {
  reason?: string;
  partial?: string;
};

type ChatAgent = {
  chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<string | null>;
};

function getMaxResponseRetries(): number {
  const raw = getEnvInt('MAX_RESPONSE_RETRIES', 2);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 2;
}

function getMaxResponseTokens(): number {
  const raw = getEnvInt('MAX_RESPONSE_TOKENS', 260);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 260;
}

function isStrictFormatCheckEnabled(): boolean {
  const v = getEnvBool('ENABLE_STRICT_FORMAT_CHECK', true);
  return v === undefined ? true : v;
}

function isFormatRepairEnabled(): boolean {
  const v = getEnvBool('ENABLE_FORMAT_REPAIR', true);
  return v === undefined ? true : v;
}

function extractFirstSentraMessageBlock(text: unknown): string | null {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('<sentra-message>');
  if (start < 0) return null;
  const end = text.indexOf('</sentra-message>', start);
  if (end < 0) return null;
  return text.substring(start, end + '</sentra-message>'.length);
}

function extractOnlySentraMessageBlock(text: unknown): string | null {
  const s = String(text || '').trim();
  if (!s) return null;
  const normalized = extractFirstSentraMessageBlock(s);
  if (!normalized) return null;
  const trimmed = s.trim();
  const normTrimmed = String(normalized || '').trim();
  if (trimmed !== normTrimmed) return null;
  return normTrimmed;
}

function extractOnlySentraToolsBlock(text: unknown): string | null {
  const s = String(text || '').trim();
  if (!s) return null;
  const blocks = extractAllFullXMLTags(s, 'sentra-tools');
  if (blocks.length !== 1) return null;
  const first = blocks[0];
  if (!first) return null;
  const merged = first.trim();
  if (merged !== s) return null;
  return merged;
}

function normalizeToArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function getSentraMessageRootNode(xml: unknown): Record<string, unknown> | null {
  const parsed = tryParseXmlFragment(xml, 'root');
  if (!parsed || typeof parsed !== 'object') return null;
  const rootObj = parsed as Record<string, unknown>;
  const raw = rootObj['sentra-message'];
  const node = Array.isArray(raw)
    ? raw.find((item) => item && typeof item === 'object')
    : raw;
  return node && typeof node === 'object' ? node as Record<string, unknown> : null;
}

function diagnoseSentraMessageShape(xml: unknown): string[] {
  const issues: string[] = [];
  const root = getSentraMessageRootNode(xml);
  if (!root) {
    issues.push('shape:no_sentra_message_root');
    return issues;
  }
  const hasMessageContainer = root.message != null;
  const directSegments = normalizeToArray((root as Record<string, unknown>).segment);
  const messageNode = (root as Record<string, unknown>).message;
  const messageSegments = normalizeToArray(
    messageNode && typeof messageNode === 'object'
      ? (messageNode as Record<string, unknown>).segment
      : undefined
  );

  if (!hasMessageContainer) {
    issues.push('shape:missing_message_container');
    if (directSegments.length > 0) issues.push('shape:segment_not_under_message');
    return issues;
  }

  if (messageSegments.length === 0) {
    issues.push('shape:message_without_segment');
    if (directSegments.length > 0) issues.push('shape:segment_not_under_message');
  }
  return issues;
}

function withSentraMessageReasonTrace(baseReason: string, xml: unknown): string {
  const reason = String(baseReason || '').trim() || tRuntimeFormat('invalid_sentra_message_segments');
  const issues = diagnoseSentraMessageShape(xml);
  if (!issues.length) return reason;
  return `${reason} [trace:${issues.join('|')}]`;
}

function validateSentraToolsOnlyFormat(response: unknown): FormatCheckResult {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: tRuntimeFormat('empty_or_non_string_response') };
  }

  const normalized = extractOnlySentraToolsBlock(response);
  if (!normalized) {
    return { valid: false, reason: tRuntimeFormat('missing_sentra_tools_block') };
  }

  if (normalized.includes('<sentra-message>')) {
    return { valid: false, reason: tRuntimeFormat('unexpected_sentra_message_block') };
  }

  return { valid: true, normalized };
}

function validateSentraToolsOrResponseFormat(response: unknown): FormatCheckResult {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: tRuntimeFormat('empty_or_non_string_response') };
  }

  const toolsXml = extractOnlySentraToolsBlock(response);
  if (toolsXml) {
    if (toolsXml.includes('<sentra-message>')) {
      return { valid: false, reason: tRuntimeFormat('unexpected_sentra_message_block') };
    }
    return { valid: true, normalized: toolsXml, toolsOnly: true, rawToolsXml: toolsXml };
  }

  const respXml = extractOnlySentraMessageBlock(response);
  if (respXml) {
    const msgCheck = validateSentraMessageSegments(respXml);
    if (!msgCheck.valid) {
      return { valid: false, reason: msgCheck.reason || tRuntimeFormat('invalid_sentra_message_segments') };
    }
    return { valid: true, normalized: respXml };
  }

  return {
    valid: false,
    reason: tRuntimeFormat('must_output_one_tools_or_message_block')
  };
}


function hasMeaningfulSegmentData(value: unknown, depth = 0): boolean {
  if (value == null) return false;
  if (depth > 3) return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulSegmentData(item, depth + 1));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return false;
    for (const [, v] of entries) {
      if (hasMeaningfulSegmentData(v, depth + 1)) return true;
    }
    return false;
  }
  return false;
}

function isValidSentraMessageSegment(seg: SentraMessageSegment): boolean {
  const type = typeof seg?.type === 'string' ? seg.type.trim().toLowerCase() : '';
  if (!type) return false;
  const data = seg?.data && typeof seg.data === 'object'
    ? seg.data
    : {};
  if (type === 'text') {
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    return text.length > 0;
  }
  return hasMeaningfulSegmentData(data);
}

function validateSentraMessageSegments(xml: unknown): { valid: boolean; reason?: string } {
  try {
    const parsed = parseSentraMessage(xml);
    const segments = Array.isArray(parsed?.message) ? parsed.message : [];
    if (segments.length === 0) {
      return {
        valid: false,
        reason: withSentraMessageReasonTrace(tRuntimeFormat('sentra_message_must_contain_segment'), xml)
      };
    }
    const validSegments = segments.filter((seg) => isValidSentraMessageSegment(seg));
    if (validSegments.length === 0) {
      return {
        valid: false,
        reason: withSentraMessageReasonTrace(tRuntimeFormat('sentra_message_must_contain_valid_segment'), xml)
      };
    }
    return { valid: true };
  } catch {
    return {
      valid: false,
      reason: withSentraMessageReasonTrace(tRuntimeFormat('sentra_message_parse_failed'), xml)
    };
  }
}

function validateReplyGateDecisionToolsFormat(response: unknown): FormatCheckResult {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: tRuntimeFormat('empty_or_non_string_response') };
  }

  const normalized = extractOnlySentraToolsBlock(response);
  if (!normalized) {
    return { valid: false, reason: tRuntimeFormat('missing_sentra_tools_block') };
  }

  if (normalized.includes('<sentra-message>')) {
    return { valid: false, reason: tRuntimeFormat('unexpected_sentra_message_block') };
  }

  const decision = parseReplyGateDecisionFromXml(normalized);
  if (!decision || typeof decision.enter !== 'boolean') {
    return { valid: false, reason: tRuntimeFormat('invalid_reply_gate_decision_enter') };
  }

  return {
    valid: true,
    normalized
  };
}

function validateOverrideDecisionToolsFormat(response: unknown): FormatCheckResult {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: tRuntimeFormat('empty_or_non_string_response') };
  }

  const repaired = repairOverrideDecisionToolsOutput(response);
  let toolsXml = repaired || extractOnlySentraToolsBlock(response);
  if (!toolsXml) {
    return { valid: false, reason: tRuntimeFormat('missing_sentra_tools_block') };
  }

  if (toolsXml.includes('<sentra-message>')) {
    return { valid: false, reason: tRuntimeFormat('unexpected_sentra_message_block') };
  }

  const invocations = parseSentraToolsInvocations(toolsXml);
  const invoke = invocations.find((it) => String(it?.aiName || '').trim() === OVERRIDE_INVOKE_NAME);
  if (!invoke) {
    return { valid: false, reason: tRuntimeFormat('missing_override_intent_invoke') };
  }

  const decision = String(invoke?.args?.decision ?? '').trim().toLowerCase();
  if (!decision) {
    return { valid: false, reason: tRuntimeFormat('invalid_override_decision_value') };
  }
  if (OVERRIDE_ALLOWED_DECISIONS.size > 0 && !OVERRIDE_ALLOWED_DECISIONS.has(decision)) {
    return { valid: false, reason: tRuntimeFormat('invalid_override_decision_value') };
  }

  return {
    valid: true,
    normalized: toolsXml
  };
}

function repairOverrideDecisionToolsOutput(raw: unknown): string {
  if (!raw || typeof raw !== 'string') return '';
  const text = String(raw);
  const toolsBlock = extractOnlySentraToolsBlock(text);
  if (toolsBlock) return toolsBlock;

  // Try to recover from invoke-only output.
  const invokeBlocks = extractAllFullXMLTags(text, 'invoke');
  const overrideInvoke = invokeBlocks.find((block) => String(extractXmlAttrValue(block, 'name') || '').trim() === OVERRIDE_INVOKE_NAME);
  if (overrideInvoke) {
    return `<sentra-tools>\n${overrideInvoke}\n</sentra-tools>`;
  }

  // Try to recover from bare decision/fields.
  const decision = String(extractXMLTag(text, 'decision') || '').trim();
  const reason = String(extractXMLTag(text, 'reason') || '').trim();
  const confidence = String(extractXMLTag(text, 'confidence') || '').trim();
  if (decision) {
    return [
      '<sentra-tools>',
      `  <invoke name="${OVERRIDE_INVOKE_NAME}">`,
      `    <parameter name="decision"><string>${decision}</string></parameter>`,
      `    <parameter name="confidence"><number>${confidence || '0.5'}</number></parameter>`,
      `    <parameter name="reason"><string>${reason || tRuntimeFormat('repaired_override_decision')}</string></parameter>`,
      '  </invoke>',
      '</sentra-tools>'
    ].join('\n');
  }

  return '';
}

function parseReplyGateDecisionFromXml(rawText: unknown): { enter: boolean; action: string; reason: string } | null {
  const raw = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  if (!raw.trim()) return null;

  const invocations = parseSentraToolsInvocations(raw);
  const invoke = invocations.find((it) => String(it?.aiName || '').trim() === REPLY_GATE_INVOKE_NAME);
  if (invoke && invoke.args && typeof invoke.args === 'object') {
    const args = invoke.args as Record<string, unknown>;
    const enterRaw = args.enter;
    const enter =
      typeof enterRaw === 'boolean'
        ? enterRaw
        : String(enterRaw ?? '').trim().toLowerCase() === 'true'
          ? true
          : String(enterRaw ?? '').trim().toLowerCase() === 'false'
            ? false
            : null;
    if (typeof enter !== 'boolean') return null;
    const action = String(args.action ?? '').trim().toLowerCase();
    const reason = String(args.reason ?? '').trim();
    return { enter, action, reason };
  }
  return null;
}

function validateResponseFormat(response: unknown, expectedOutput: ExpectedOutput = 'sentra_message'): FormatCheckResult {
  const expected = expectedOutput;

  if (expected === 'reply_gate_decision_tools') {
    return validateReplyGateDecisionToolsFormat(response);
  }

  if (expected === 'override_intent_decision_tools') {
    return validateOverrideDecisionToolsFormat(response);
  }

  if (expected === 'sentra_tools') {
    return validateSentraToolsOnlyFormat(response);
  }

  if (expected === 'sentra_tools_or_message') {
    return validateSentraToolsOrResponseFormat(response);
  }

  if (!response || typeof response !== 'string') {
    return { valid: false, reason: tRuntimeFormat('empty_or_non_string_response') };
  }

  // Special-case: When we EXPECT <sentra-message> but the model outputs ONLY <sentra-tools>,
  // allow the upper layer to decide how to handle it (fallback/restart) in normal mode.
  // Tool-only output is treated as a control signal and is bubbled to the upper layer.
  const toolsOnlyXml = extractOnlySentraToolsBlock(response);
  if (toolsOnlyXml) {
    return { valid: true, toolsOnly: true, rawToolsXml: toolsOnlyXml };
  }

  const normalized = extractFirstSentraMessageBlock(response);
  if (!normalized) {
    return { valid: false, reason: tRuntimeFormat('missing_sentra_message_block') };
  }

  // Target routing tags are REQUIRED by protocol, but we do NOT fail strict format checks on missing/duplicate tags.
  // Rationale: The upper layer (MessagePipeline) will auto-inject / normalize the target tag based on current chat.
  // This avoids unnecessary retries for otherwise well-formed <sentra-message>.
  let missingTarget = false;
  let targetConflict = false;
  try {
    const hasGroup = normalized.includes('<group_id>') && normalized.includes('</group_id>');
    const hasUser = normalized.includes('<user_id>') && normalized.includes('</user_id>');
    missingTarget = !hasGroup && !hasUser;
    targetConflict = hasGroup && hasUser;
  } catch { }

  // Enforce: output MUST be exactly one <sentra-message> block (no extra text/tags outside)
  try {
    const trimmed = String(response || '').trim();
    const normTrimmed = String(normalized || '').trim();
    if (trimmed !== normTrimmed) {
      return { valid: false, reason: tRuntimeFormat('extra_content_outside_sentra_message') };
    }
  } catch { }

  const forbiddenTags = [
    '<sentra-tools>',
    '<sentra-result>',
    '<sentra-result-group>',
    '<sentra-input>',
    '<sentra-pending-messages>',
    '<sentra-emo>',
    '<sentra-memory>'
  ];

  for (const tag of forbiddenTags) {
    if (normalized.includes(tag)) {
      return { valid: false, reason: tRuntimeFormat('forbidden_readonly_tag', { tag }) };
    }
  }

  const msgCheck = validateSentraMessageSegments(normalized);
  if (!msgCheck.valid) {
    return { valid: false, reason: msgCheck.reason || tRuntimeFormat('invalid_sentra_message_segments') };
  }

  return { valid: true, normalized };
}

function getFormatCheckReason(check: FormatCheckResult): string {
  if (check.valid === false) return check.reason;
  return '';
}

function collectTokenPayloadFromData(
  value: unknown,
  keyPath: string,
  out: string[],
  depth = 0
): void {
  if (value == null || depth > 8) return;

  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return;
    out.push(`${keyPath}:${s}`);
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(`${keyPath}:${String(value)}`);
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectTokenPayloadFromData(value[i], `${keyPath}[${i}]`, out, depth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries) {
      const nextPath = keyPath ? `${keyPath}.${k}` : k;
      collectTokenPayloadFromData(v, nextPath, out, depth + 1);
    }
  }
}

function extractAndCountTokens(response: string): { text: string; tokens: number } {
  const payloadParts: string[] = [];
  try {
    const parsed = parseSentraMessage(response);
    const segments = Array.isArray(parsed?.message) ? parsed.message : [];
    for (const seg of segments) {
      if (!isValidSentraMessageSegment(seg)) continue;
      const type = String(seg?.type || '').trim().toLowerCase();
      if (!type) continue;
      payloadParts.push(`segment.type:${type}`);
      const data = seg?.data && typeof seg.data === 'object' ? seg.data : {};
      collectTokenPayloadFromData(data, 'segment.data', payloadParts);
    }
  } catch {
    // Keep empty payload; caller will continue to noReply/non-text checks.
  }

  const combinedPayload = payloadParts.join('\n');
  const tokens = tokenCounter.countTokens(combinedPayload);
  return { text: combinedPayload, tokens };
}

function hasNonTextPayload(response: string): boolean {
  try {
    const parsed = parseSentraMessage(response);
    const segments = Array.isArray(parsed?.message) ? parsed.message : [];
    for (const seg of segments) {
      const type = typeof seg?.type === 'string' ? seg.type.trim().toLowerCase() : '';
      if (!type || type === 'text') continue;
      if (isValidSentraMessageSegment(seg)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isModelFixSupportedExpectedOutput(expectedOutput: ExpectedOutput): boolean {
  return (
    expectedOutput === 'sentra_message' ||
    expectedOutput === 'sentra_tools' ||
    expectedOutput === 'sentra_tools_or_message' ||
    expectedOutput === 'reply_gate_decision_tools' ||
    expectedOutput === 'override_intent_decision_tools'
  );
}

function buildProtocolReminder(expectedOutput: ExpectedOutput = 'sentra_message', lastFormatReason = ''): string {
  const escapeXml = (v: unknown) => {
    try {
      return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    } catch {
      return '';
    }
  };

  const reason = lastFormatReason ? escapeXml(lastFormatReason) : '';
  const expected = escapeXml(expectedOutput || 'sentra_message');
  const isToolsOnly = expectedOutput === 'sentra_tools' || expectedOutput === 'reply_gate_decision_tools' || expectedOutput === 'override_intent_decision_tools';
  const isToolsOrResponse = expectedOutput === 'sentra_tools_or_message';

  const outputRule = isToolsOnly
    ? `    <item>${escapeXml(tRuntimeFormat('c_single_tools_only'))}</item>`
    : isToolsOrResponse
      ? `    <item>${escapeXml(tRuntimeFormat('c_tools_or_message_only'))}</item>`
      : `    <item>${escapeXml(tRuntimeFormat('c_single_message_only'))}</item>`;

  return [
    '<sentra-root-directive>',
    '  <id>format_retry_v1</id>',
    '  <type>format_repair</type>',
    '  <scope>single_turn</scope>',
    `  <objective>${escapeXml(tRuntimeFormat('protocol_fix_objective'))}</objective>`,
    `  <expected_output>${expected}</expected_output>`,
    ...(reason ? [`  <last_error>${reason}</last_error>`] : []),
    '  <constraints>',
    `    <item>${escapeXml(tRuntimeFormat('c_xml_only'))}</item>`,
    outputRule,
    `    <item>${escapeXml(tRuntimeFormat('c_message_structure'))}</item>`,
    `    <item>${escapeXml(tRuntimeFormat('c_text_segment_non_empty'))}</item>`,
    `    <item>${escapeXml(tRuntimeFormat('c_route_required'))}</item>`,
    '  </constraints>',
    '  <output_template>',
    '    <sentra-message>',
    '      <group_id_or_user_id>...</group_id_or_user_id>',
    '      <message>',
    '        <segment index="1"><type>text</type><data><text>...</text></data></segment>',
    '      </message>',
    '    </sentra-message>',
    '  </output_template>',
    '</sentra-root-directive>'
  ].join('\n');
}
function buildOverrideDecisionToolsReminder(): string {
  return [
    'CRITICAL OUTPUT RULES:',
    OVERRIDE_OUTPUT_INSTRUCTION,
    OVERRIDE_POLICY_TEXT
  ].join('\n');
}
function buildReplyGateDecisionToolsReminder(): string {
  return [
    'CRITICAL OUTPUT RULES:',
    REPLY_GATE_OUTPUT_INSTRUCTION,
    REPLY_GATE_POLICY_TEXT
  ].join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function appendRootDirectiveToLastUserMessage(conversations: ChatMessage[], rootDirective: string): ChatMessage[] {
  const conv = Array.isArray(conversations) ? conversations : [];
  if (!rootDirective || typeof rootDirective !== 'string') return conv;
  const out = conv.map((m) => (m && typeof m === 'object' ? { ...m } : m)) as ChatMessage[];
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (!msg || msg.role !== 'user') continue;
    const prev = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
    msg.content = prev ? `${prev}\n\n${rootDirective}` : rootDirective;
    return out;
  }
  out.push({ role: 'user', content: rootDirective });
  return out;
}

function getResponsePreview(payload: unknown): string {
  if (payload == null) return '[empty]';
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (!text) return '[empty]';
    return text;
  } catch (e) {
    if (e instanceof Error) {
      return `[unserializable: ${e.message}]`;
    }
    return `[unserializable: ${String(e)}]`;
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return tRuntimeFormat('reason_unknown_error');
  }
}

function getErrorResponseData(err: unknown): unknown {
  if (!err || typeof err !== 'object') return undefined;
  if (!('response' in err)) return undefined;
  const response = (err as { response?: { data?: unknown } }).response;
  return response?.data;
}

export async function chatWithRetry(
  agent: ChatAgent,
  conversations: ChatMessage[],
  modelOrOptions: string | ChatOptions,
  groupId?: string
): Promise<{
  response: string | null;
  rawResponse?: string | null;
  retries: number;
  success: boolean;
  reason?: string;
  tokens?: number;
  text?: string;
  noReply?: boolean;
  toolsOnly?: boolean;
  rawToolsXml?: string;
}> {
  let retries = 0;
  let lastError: unknown = null;
  let lastResponse: string | null = null;
  let lastFormatReason = '';
  let appendRepairTried = false;

  const maxResponseRetries = getMaxResponseRetries();
  const maxResponseTokens = getMaxResponseTokens();
  const strictFormatCheck = isStrictFormatCheckEnabled();
  const formatRepairEnabled = isFormatRepairEnabled();

  const options: ChatOptions =
    typeof modelOrOptions === 'string'
      ? { model: modelOrOptions }
      : (modelOrOptions || {});

  const expectedOutput = (options.__sentraExpectedOutput || 'sentra_message') as ExpectedOutput;
  const chatOptions: ChatOptions = { ...options };
  delete chatOptions.__sentraExpectedOutput;

  while (retries <= maxResponseRetries) {
    try {
      const attemptIndex = retries + 1;
      logger.debug(`[${groupId}] ${tRuntimeFormat('log_attempt', { attempt: attemptIndex })}`);

      let convThisTry = conversations;
      if (strictFormatCheck && lastFormatReason) {
        const reminder =
          expectedOutput === 'reply_gate_decision_tools'
            ? buildReplyGateDecisionToolsReminder()
            : expectedOutput === 'override_intent_decision_tools'
              ? buildOverrideDecisionToolsReminder()
              : buildProtocolReminder(expectedOutput, lastFormatReason);
        convThisTry = Array.isArray(conversations)
          ? [...conversations, { role: 'system', content: reminder }]
          : conversations;
        logger.info(`[${groupId}] ${tRuntimeFormat('log_protocol_reminder_injected', { reason: lastFormatReason })}`);
      }

      let response = await agent.chat(convThisTry, {
        ...chatOptions,
        expectedOutput,
        onEarlyTerminate: (event: EarlyTerminateEvent) => {
          logger.info(`[${groupId}] ${tRuntimeFormat('log_stream_early_terminated', { reason: event?.reason || 'unknown' })}`);
        }
      });
      const rawResponse = response;
      if (typeof response === 'string') {
        response = preprocessPlainModelOutput(response);
      } else {
        response = null;
      }

      // 本地格式守卫：优先提取/截断为第一段 <sentra-message>，减少无意义重试
      if (expectedOutput === 'sentra_message' && typeof response === 'string' && response.trim()) {
        const guarded = guardAndNormalizeSentraMessage(response);
        if (guarded && guarded.ok && typeof guarded.normalized === 'string' && guarded.normalized.trim()) {
          response = guarded.normalized;
        }
      }
      lastResponse = response;

      let modelFormatFixTried = false;

      if (strictFormatCheck) {
        let formatCheck = validateResponseFormat(response, expectedOutput);

        // 在进入重试前，优先用 root directive 让模型“就地修复格式”，减少无意义重试
        if (!formatCheck.valid && isModelFixSupportedExpectedOutput(expectedOutput)) {
          const allowFix = shouldAttemptModelFormatFix({
            expectedOutput,
            lastErrorReason: getFormatCheckReason(formatCheck),
            alreadyTried: modelFormatFixTried
          });

          if (allowFix) {
            modelFormatFixTried = true;
            logger.info(`[${groupId}] model format-fix attempt: expected=${expectedOutput} reason=${getFormatCheckReason(formatCheck)}`);
            try {
              const fixParams: ModelFormatFixParams = {
                agent,
                conversations: convThisTry,
                expectedOutput,
                lastErrorReason: getFormatCheckReason(formatCheck)
              };
              if (typeof chatOptions.model === 'string') fixParams.model = chatOptions.model;
              if (typeof chatOptions.timeout === 'number') fixParams.timeout = chatOptions.timeout;
              if (typeof groupId === 'string') fixParams.groupId = groupId;
              if (typeof response === 'string') fixParams.candidateOutput = response;
              const fixed = await attemptModelFormatFixWithAgent(fixParams);
              if (fixed && typeof fixed === 'string' && fixed.trim()) {
                response = fixed;
                lastResponse = response;
                formatCheck = validateResponseFormat(response, expectedOutput);
                if (!formatCheck.valid) {
                  logger.warn(
                    `[${groupId}] model format-fix output still invalid: reason=${getFormatCheckReason(formatCheck)}`
                  );
                }
              }
            } catch (e) {
              logger.warn(
                `[${groupId}] model format-fix attempt failed: ${getErrorMessage(e)}`
              );
            }
          }
        }

        if (!formatCheck.valid) {
          lastFormatReason = getFormatCheckReason(formatCheck);
          logger.warn(`[${groupId}] ${tRuntimeFormat('log_format_check_failed', { reason: getFormatCheckReason(formatCheck) })}`);
          logger.debug(`[${groupId}] ${tRuntimeFormat('log_raw_response_on_format_failed', { preview: getResponsePreview(response) })}`);

          if (
            expectedOutput === 'sentra_message' &&
            !appendRepairTried &&
            typeof response === 'string' &&
            response.trim()
          ) {
            appendRepairTried = true;
            try {
              const rootDirective = buildProtocolReminder(expectedOutput, lastFormatReason);
              const convRepaired = appendRootDirectiveToLastUserMessage(convThisTry, rootDirective);
              let repaired = await agent.chat(convRepaired, {
                ...chatOptions,
                expectedOutput,
                onEarlyTerminate: (event: EarlyTerminateEvent) => {
                  logger.info(`[${groupId}] ${tRuntimeFormat('log_stream_early_terminated', { reason: event?.reason || 'unknown' })}`);
                }
              });
              if (typeof repaired === 'string') {
                repaired = preprocessPlainModelOutput(repaired);
              }
              if (expectedOutput === 'sentra_message' && typeof repaired === 'string' && repaired.trim()) {
                const guarded = guardAndNormalizeSentraMessage(repaired);
                if (guarded && guarded.ok && typeof guarded.normalized === 'string' && guarded.normalized.trim()) {
                  repaired = guarded.normalized;
                }
              }
              const repairedCheck = validateResponseFormat(repaired, expectedOutput);
              if (repairedCheck.valid && !repairedCheck.toolsOnly) {
                logger.success(`[${groupId}] ${tRuntimeFormat('log_format_fix_success_append_root')}`);
                return { response: repaired, rawResponse: repaired, retries, success: true };
              }
            } catch (e) {
              logger.warn(`[${groupId}] ${tRuntimeFormat('log_format_fix_append_root_failed', { reason: getErrorMessage(e) })}`);
            }
          }

          if (retries < maxResponseRetries) {
            retries++;
            logger.debug(`[${groupId}] ${tRuntimeFormat('log_retry_after_format_fail', { attempt: retries + 1 })}`);
            await sleep(1000);
            continue;
          }

          const allowRepair = isModelFixSupportedExpectedOutput(expectedOutput);
          if (allowRepair && formatRepairEnabled && typeof response === 'string' && response.trim()) {
            try {
              const fixParams: ModelFormatFixParams = {
                agent,
                conversations: convThisTry,
                expectedOutput,
                lastErrorReason: getFormatCheckReason(formatCheck)
              };
              if (typeof chatOptions.model === 'string') fixParams.model = chatOptions.model;
              if (typeof chatOptions.timeout === 'number') fixParams.timeout = chatOptions.timeout;
              if (typeof groupId === 'string') fixParams.groupId = groupId;
              if (typeof response === 'string') fixParams.candidateOutput = response;
              const repaired = await runSentraFormatFixPipeline(fixParams);
              if (repaired && typeof repaired === 'string' && repaired.trim()) {
                const repairedCheck = validateResponseFormat(repaired, expectedOutput);
                if (repairedCheck.valid) {
                  logger.success(`[${groupId}] ${tRuntimeFormat('log_format_fix_pipeline_success')}`);
                  return { response: repaired, rawResponse: repaired, retries, success: true };
                }
                logger.debug(`[${groupId}] ${tRuntimeFormat('log_format_fix_pipeline_failed_preview', { preview: getResponsePreview(repaired) })}`);
              }
            } catch (e) {
              logger.warn(`[${groupId}] ${tRuntimeFormat('log_format_fix_pipeline_failed', { reason: getErrorMessage(e) })}`);
            }
          }

          logger.error(`[${groupId}] ${tRuntimeFormat('log_format_final_failed')}`);
          logger.error(`[${groupId}] ${tRuntimeFormat('log_last_raw_response', { preview: getResponsePreview(lastResponse) })}`);
          return { response: null, retries, success: false, reason: getFormatCheckReason(formatCheck) };
        }

        if (formatCheck.toolsOnly) {
          logger.warn(`[${groupId}] ${tRuntimeFormat('log_expected_message_got_tools')}`);
          return {
            response: null,
            rawResponse,
            retries,
            success: true,
            toolsOnly: true,
            rawToolsXml: formatCheck.rawToolsXml || (typeof rawResponse === 'string' ? rawResponse : String(rawResponse ?? ''))
          };
        }

        if (formatCheck.normalized && formatCheck.normalized !== response) {
          response = formatCheck.normalized;
          lastResponse = response;
        }
      }

      const responseText = typeof response === 'string' ? response : String(response ?? '');
      let tokenText = '';
      let tokens = 0;
      if (expectedOutput === 'reply_gate_decision_tools') {
        const decision = parseReplyGateDecisionFromXml(responseText);
        tokenText = decision && typeof decision.reason === 'string' ? decision.reason : '';
        tokens = tokenCounter.countTokens(tokenText || '');
      } else if (expectedOutput === 'override_intent_decision_tools') {
        const invokes = parseSentraToolsInvocations(responseText);
        const override = invokes.find((it) => String(it?.aiName || '').trim() === OVERRIDE_INVOKE_NAME);
        tokenText = String(override?.args?.reason ?? '').trim();
        tokens = tokenCounter.countTokens(tokenText || '');
      } else {
        const tokenInfo = extractAndCountTokens(responseText);
        tokenText = tokenInfo.text;
        tokens = tokenInfo.tokens;
      }
      const text = tokenText || '';
      logger.debug(`[${groupId}] ${tRuntimeFormat('log_token_stats', { tokens, length: text.length })}`);

      if (maxResponseTokens > 0 && tokens > maxResponseTokens) {
        logger.warn(`[${groupId}] ${tRuntimeFormat('log_token_exceeded', { tokens, max: maxResponseTokens })}`);
        logger.debug(`[${groupId}] ${tRuntimeFormat('log_raw_response_on_token_exceeded', { preview: getResponsePreview(response) })}`);
        if (retries < maxResponseRetries) {
          retries++;
          logger.debug(`[${groupId}] ${tRuntimeFormat('log_retry_after_token_exceeded', { attempt: retries + 1 })}`);
          await sleep(500);
          continue;
        }
        logger.error(`[${groupId}] ${tRuntimeFormat('log_token_final_failed')}`);
        logger.error(`[${groupId}] ${tRuntimeFormat('log_last_raw_response', { preview: getResponsePreview(lastResponse) })}`);
        return {
          response: null,
          retries,
          success: false,
          reason: tRuntimeFormat('reason_token_exceeded', { tokens, max: maxResponseTokens })
        };
      }

      const noReply =
        expectedOutput === 'reply_gate_decision_tools' ||
          expectedOutput === 'override_intent_decision_tools' ||
          expectedOutput === 'sentra_tools' ||
          expectedOutput === 'sentra_tools_or_message'
          ? false
          : (tokens === 0 && !hasNonTextPayload(responseText));
      if (noReply) {
        logger.warn(`[${groupId}] ${tRuntimeFormat('log_no_reply_by_zero_token')}`);
      }
      const limitDisplay = maxResponseTokens > 0 ? maxResponseTokens : 'unlimited';
      logger.success(`[${groupId}] ${tRuntimeFormat('log_ai_success', { tokens, limit: limitDisplay })}`);
      return { response, rawResponse, retries, success: true, tokens, text, noReply };
    } catch (error) {
      logger.error(`[${groupId}] ${tRuntimeFormat('log_ai_request_failed_attempt', { attempt: retries + 1 })}`, error);
      lastError = error;
      lastFormatReason = '';
      const responseData = getErrorResponseData(error);
      if (responseData !== undefined) {
        logger.error(`[${groupId}] ${tRuntimeFormat('log_api_error_data', { preview: getResponsePreview(responseData) })}`);
      }
      if (retries < maxResponseRetries) {
        retries++;
        logger.warn(`[${groupId}] ${tRuntimeFormat('log_retry_after_network_error', { attempt: retries + 1 })}`);
        await sleep(1000);
        continue;
      }
      logger.error(`[${groupId}] ${tRuntimeFormat('log_ai_request_failed_final', { max: maxResponseRetries })}`);
      if (lastResponse) {
        logger.error(`[${groupId}] ${tRuntimeFormat('log_last_success_response', { preview: getResponsePreview(lastResponse) })}`);
      }
      return { response: null, retries, success: false, reason: getErrorMessage(lastError) };
    }
  }

  return {
    response: null,
    retries,
    success: false,
    reason: lastError ? getErrorMessage(lastError) : tRuntimeFormat('reason_unknown_error')
  };
}









