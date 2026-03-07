import { DateTime } from 'luxon';
import { createLogger } from './logger.js';
import { getEnv } from './envHotReloader.js';
import type { ChatMessage, ModelFormatFixParams } from '../src/types.js';
import { countTextTokens, truncateTextByTokens } from './tokenTextTruncator.js';
import { parseSentraToolsInvocations } from './protocolUtils.js';
import { runSentraFormatFixPipeline } from './responseFormatGuard.js';
import { escapeXml, escapeXmlAttr } from './xmlUtils.js';
import {
  buildSentraContractPolicyText,
  buildSentraRootDirectiveFromContract,
  getSentraContractOutputInstruction,
  getSentraToolsContract
} from './sentraToolsContractEngine.js';

const logger = createLogger('ContextCompressor');

const SUMMARY_CONTRACT_ID = 'context_summary_emit';
const SUMMARY_CONTRACT = getSentraToolsContract(SUMMARY_CONTRACT_ID);
const SUMMARY_OUTPUT_SPEC = SUMMARY_CONTRACT.outputSpec && typeof SUMMARY_CONTRACT.outputSpec === 'object'
  ? SUMMARY_CONTRACT.outputSpec as Record<string, unknown>
  : {};
const SUMMARY_REQUIRED_INVOKE = SUMMARY_OUTPUT_SPEC.requiredInvoke && typeof SUMMARY_OUTPUT_SPEC.requiredInvoke === 'object'
  ? SUMMARY_OUTPUT_SPEC.requiredInvoke as Record<string, unknown>
  : {};
const SUMMARY_INVOKE_NAME = String(SUMMARY_REQUIRED_INVOKE.name || 'emit_context_summary').trim() || 'emit_context_summary';
const SUMMARY_CONTRACT_POLICY_TEXT = buildSentraContractPolicyText(SUMMARY_CONTRACT_ID);
const SUMMARY_CONTRACT_OUTPUT_INSTRUCTION = getSentraContractOutputInstruction(SUMMARY_CONTRACT_ID);

const SUMMARY_MAX_RETRIES = 2;
const SUMMARY_PREVIEW_MAX_CHARS = 2000;
const SUMMARY_OUTPUT_SHAPE_EXAMPLE = String(
  SUMMARY_OUTPUT_SPEC.shapeExample ||
  [
    '<sentra-tools>',
    `  <invoke name="${SUMMARY_INVOKE_NAME}">`,
    '    <parameter name="summary"><string>...</string></parameter>',
    '    <parameter name="keywords"><array><string>...</string></array></parameter>',
    '    <parameter name="eventBoard"><array><string>...</string></array></parameter>',
    '    <parameter name="artifacts"><array><object><string name="captain">...</string></object></array></parameter>',
    '    <parameter name="confidence"><number>0.8</number></parameter>',
    '  </invoke>',
    '</sentra-tools>'
  ].join('\n')
);

const HISTORY_MAX_TOKENS = (() => {
  const direct = Number(getEnv('CONTEXT_SUMMARY_HISTORY_MAX_TOKENS', '0'));
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const legacyChars = Number(getEnv('CONTEXT_SUMMARY_HISTORY_MAX_CHARS', '8000'));
  if (Number.isFinite(legacyChars) && legacyChars > 0) return Math.max(120, Math.floor(legacyChars / 4));
  return 2000;
})();

const BOT_PRIMARY_NAME = (() => {
  try {
    const raw = String(getEnv('BOT_NAMES', '') ?? '');
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list[0] || 'you';
  } catch {
    return 'you';
  }
})();

const SUMMARY_SYSTEM_PROMPT_TEMPLATE = [
  'You are "{{bot_name}}", the primary AI agent in {{scene}}.',
  'Read the XML evidence and output ONLY one sentra-tools call for context summary.',
  '',
  'Output contract:',
  '{{contract_output_instruction}}',
  '{{contract_policy_text}}',
  '',
  'Summary policy:',
  '- Output summary in Chinese.',
  '- Keep key user goals, constraints, deliverables, outcomes.',
  '- Keep concrete entities for keywords.',
  '- eventBoard must be actionable and complete sentences.',
  '- No markdown or extra prose outside sentra-tools.'
].join('\n');

const SUMMARY_REPAIR_PROMPT_TEMPLATE = [
  '<sentra-summary-repair>',
  '  <attempt>{{attempt}}</attempt>',
  '  <max_attempts>{{max_attempts}}</max_attempts>',
  '  <failure_reason>{{failure_reason}}</failure_reason>',
  '  <required_output>',
  '    <rule>{{contract_output_instruction}}</rule>',
  '    <rule>{{contract_policy_text}}</rule>',
  '    <rule>Do not output any extra text.</rule>',
  '  </required_output>',
  '  <failure_detail>{{failure_detail}}</failure_detail>',
  '  <required_shape_example>{{required_shape_example}}</required_shape_example>',
  '  <last_response_preview>{{last_response_preview}}</last_response_preview>',
  '</sentra-summary-repair>'
].join('\n');

type SummaryArtifact = {
  captain?: string;
  type?: string;
  kind?: string;
  outputPath?: string;
  originalPath?: string;
  path?: string;
  url?: string;
  note?: string;
};

type ParsedSummaryOutput = {
  summary: string;
  confidence: number | null;
  keywords: string[];
  eventBoard: string[];
  artifacts: SummaryArtifact[];
};

export type CompressContextResult = {
  summary: string;
  keywords: string[];
  eventBoard: string[];
  artifacts: SummaryArtifact[];
  confidence: number | null;
  messages: ChatMessage[];
  model?: string;
};

type SummaryHistoryEntry = {
  index: number;
  role: string;
  content: string;
  tokens: number;
  truncated: boolean;
};

interface ContextSummaryOptions {
  historyConversations?: ChatMessage[];
  chatType?: 'group' | 'private';
  groupId?: string;
  userId?: string;
  timeStart?: number;
  timeEnd?: number;
  maxSummarySentences?: number;
  presetText?: string;
}

interface CompressContextParams extends ContextSummaryOptions {
  agent?: { chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
  model?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  timeout?: number;
}

function renderPromptText(template: string, vars: Record<string, unknown>): string {
  const tpl = String(template || '');
  if (!tpl) return '';
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : ''
  ));
}

function clipText(raw: unknown, max = SUMMARY_PREVIEW_MAX_CHARS): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeStringList(input: unknown, maxItems = 24, maxLen = 120): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const text = String(item ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeArtifacts(input: unknown, maxItems = 32): SummaryArtifact[] {
  if (!Array.isArray(input)) return [];
  const out: SummaryArtifact[] = [];
  const seen = new Set<string>();
  for (const row of input) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const captain = String(rec.captain ?? rec.name ?? rec.title ?? '').trim();
    const type = String(rec.type ?? '').trim();
    const kind = String(rec.kind ?? '').trim();
    const outputPath = String(rec.outputPath ?? rec.path ?? rec.file ?? '').trim();
    const originalPath = String(rec.originalPath ?? '').trim();
    const url = String(rec.url ?? rec.link ?? '').trim();
    const note = String(rec.note ?? rec.desc ?? '').trim();
    if (!captain && !outputPath && !originalPath && !url && !note) continue;
    const key = `${captain.toLowerCase()}|${outputPath.toLowerCase()}|${originalPath.toLowerCase()}|${url.toLowerCase()}|${note.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...(captain ? { captain: captain.slice(0, 120) } : {}),
      ...(type ? { type: type.slice(0, 80) } : {}),
      ...(kind ? { kind: kind.slice(0, 80) } : {}),
      ...(outputPath ? { outputPath: outputPath.slice(0, 1200) } : {}),
      ...(originalPath ? { originalPath: originalPath.slice(0, 1200) } : {}),
      ...(url ? { url: url.slice(0, 1200) } : {}),
      ...(note ? { note: note.slice(0, 240) } : {})
    });
    if (out.length >= maxItems) break;
  }
  return out;
}

async function buildSummarySystemPrompt({ chatType, botName }: { chatType?: string; botName?: string }) {
  const scene = chatType === 'group'
    ? 'a multi-user QQ group chat'
    : 'a one-to-one QQ private chat';
  return renderPromptText(SUMMARY_SYSTEM_PROMPT_TEMPLATE, {
    bot_name: botName || BOT_PRIMARY_NAME,
    scene,
    contract_output_instruction: SUMMARY_CONTRACT_OUTPUT_INSTRUCTION,
    contract_policy_text: SUMMARY_CONTRACT_POLICY_TEXT
  });
}

async function buildSummaryRootDirectiveXml(): Promise<string> {
  return buildSentraRootDirectiveFromContract({
    contractId: SUMMARY_CONTRACT_ID,
    idPrefix: 'context_summary',
    scope: 'single_turn',
    phaseOverride: 'ContextSummary',
    objectiveOverride: 'Summarize XML evidence and output one structured sentra-tools call.'
  });
}

function formatTimeRange({ timeStart, timeEnd, timezone = 'Asia/Shanghai' }: {
  timeStart?: number;
  timeEnd?: number;
  timezone?: string;
} = {}) {
  if (!timeStart && !timeEnd) return 'not_specified';
  try {
    const fmt = (ms: number) => DateTime.fromMillis(ms).setZone(timezone).toFormat('yyyy-LL-dd HH:mm:ss');
    const startStr = timeStart ? fmt(timeStart) : 'unknown_start';
    const endStr = timeEnd ? fmt(timeEnd) : 'unknown_end_or_now';
    return `${startStr} ~ ${endStr}`;
  } catch {
    const startStr = timeStart ? new Date(timeStart).toISOString() : 'unknown_start';
    const endStr = timeEnd ? new Date(timeEnd).toISOString() : 'unknown_end_or_now';
    return `${startStr} ~ ${endStr}`;
  }
}

function normalizeHistoryRole(roleLike: unknown): string {
  const role = String(roleLike || '').trim().toLowerCase();
  if (role === 'assistant') return BOT_PRIMARY_NAME;
  if (role === 'user') return 'user';
  return role || 'system';
}

function buildSummaryHistoryEntries(
  historyConversations: ChatMessage[] | undefined,
  maxTokens = HISTORY_MAX_TOKENS
): SummaryHistoryEntry[] {
  if (!Array.isArray(historyConversations) || historyConversations.length === 0) return [];

  const out: SummaryHistoryEntry[] = [];
  let usedTokens = 0;

  for (let i = 0; i < historyConversations.length; i++) {
    const msg = historyConversations[i];
    if (!msg || typeof msg.content !== 'string') continue;
    const rawContent = String(msg.content || '').trim();
    if (!rawContent) continue;

    const role = normalizeHistoryRole(msg.role);
    const overheadTokens = 16;
    const contentTokens = countTextTokens(rawContent);

    if (usedTokens + overheadTokens + contentTokens <= maxTokens) {
      out.push({ index: i + 1, role, content: rawContent, tokens: contentTokens, truncated: false });
      usedTokens += overheadTokens + contentTokens;
      continue;
    }

    const remain = Math.max(0, maxTokens - usedTokens - overheadTokens);
    if (remain <= 0) break;

    const clipped = truncateTextByTokens(rawContent, { maxTokens: remain, suffix: ' ...' }).text.trim();
    if (!clipped) break;
    out.push({ index: i + 1, role, content: clipped, tokens: countTextTokens(clipped), truncated: true });
    break;
  }

  return out;
}

function buildSummaryRequestXml(options: ContextSummaryOptions = {}): string {
  const {
    historyConversations,
    chatType = 'group',
    groupId,
    userId,
    timeStart,
    timeEnd,
    maxSummarySentences = 1
  } = options;

  const historyEntries = buildSummaryHistoryEntries(historyConversations, HISTORY_MAX_TOKENS);
  const timeRange = formatTimeRange({
    ...(timeStart !== undefined ? { timeStart } : {}),
    ...(timeEnd !== undefined ? { timeEnd } : {})
  });

  const lines: string[] = [];
  lines.push('<sentra-context-summary-input>');
  lines.push('  <meta>');
  lines.push(`    <chat_type>${escapeXml(chatType === 'group' ? 'group' : 'private')}</chat_type>`);
  if (groupId) lines.push(`    <group_id>${escapeXml(groupId)}</group_id>`);
  if (userId) lines.push(`    <user_id>${escapeXml(userId)}</user_id>`);
  lines.push(`    <time_range timezone="Asia/Shanghai">${escapeXml(timeRange)}</time_range>`);
  lines.push('  </meta>');

  lines.push('  <summary_policy>');
  lines.push(`    <max_sentences>${Math.max(1, Math.floor(maxSummarySentences || 1))}</max_sentences>`);
  lines.push('    <language>zh-CN</language>');
  lines.push('    <focus>goal,facts,constraints,deliverables,outcomes</focus>');
  lines.push('  </summary_policy>');

  lines.push('  <output_schema>');
  lines.push('    <required>summary,keywords,eventBoard</required>');
  lines.push('    <summary_type>string</summary_type>');
  lines.push('    <keywords_type>array[string]</keywords_type>');
  lines.push('    <event_board_type>array[string] via parameter name eventBoard</event_board_type>');
  lines.push('    <artifacts_type>array[object captain/outputPath/originalPath/url/type/kind/note] (optional)</artifacts_type>');
  lines.push('  </output_schema>');

  lines.push(`  <history_messages count="${historyEntries.length}">`);
  for (const item of historyEntries) {
    lines.push(
      `    <message index="${escapeXmlAttr(String(item.index))}" role="${escapeXmlAttr(item.role)}" truncated="${item.truncated ? 'true' : 'false'}">`
    );
    lines.push(`      <content>${escapeXml(item.content)}</content>`);
    lines.push('    </message>');
  }
  lines.push('  </history_messages>');

  lines.push('  <summarize_task>');
  lines.push('    <instruction>Generate concise Chinese summary from XML evidence.</instruction>');
  lines.push(`    <instruction>Return only one sentra-tools invoke named ${SUMMARY_INVOKE_NAME}.</instruction>`);
  lines.push('  </summarize_task>');
  lines.push('</sentra-context-summary-input>');
  return lines.join('\n');
}

function buildContextSummaryFewShotMessages(): ChatMessage[] {
  const root = [
    '<sentra-root-directive>',
    '  <id>context_summary_demo</id>',
    '  <type>context_summary</type>',
    '  <constraints>',
    '    <item>Output sentra-tools only.</item>',
    `    <item>Use invoke name ${SUMMARY_INVOKE_NAME}.</item>`,
    '    <item>Use parameter wrappers for each field.</item>',
    '  </constraints>',
    '</sentra-root-directive>'
  ].join('\n');

  const user1 = [
    root,
    '',
    '<sentra-context-summary-input>',
    '  <meta><chat_type>private</chat_type><user_id>2166683295</user_id></meta>',
    '  <history_messages count="2">',
    '    <message index="1" role="user"><content>在私聊里，雨安说：画一个八重神子。</content></message>',
    '    <message index="2" role="assistant"><content>&lt;sentra-message&gt;已回传图片&lt;/sentra-message&gt;</content></message>',
    '  </history_messages>',
    '</sentra-context-summary-input>'
  ].join('\n');

  const assistant1 = [
    '<sentra-tools>',
    `  <invoke name="${SUMMARY_INVOKE_NAME}">`,
    '    <parameter name="summary"><string>雨安在私聊要求绘制八重神子，当前已完成图片交付。</string></parameter>',
    '    <parameter name="keywords"><array><string>雨安</string><string>八重神子</string><string>绘图</string></array></parameter>',
    '    <parameter name="eventBoard"><array><string>用户偏好二次元角色绘图，后续相似需求可直接走出图能力。</string></array></parameter>',
    '    <parameter name="confidence"><number>0.92</number></parameter>',
    '  </invoke>',
    '</sentra-tools>'
  ].join('\n');

  return [
    { role: 'user', content: user1 },
    { role: 'assistant', content: assistant1 }
  ];
}

function buildSummaryParseFailureReason(raw: string, args: Record<string, unknown>): string {
  const text = String(raw || '');
  const invokePattern = new RegExp(`<invoke\\b[^>]*name=["']${SUMMARY_INVOKE_NAME}["'][^>]*>[\\s\\S]*?<\\/invoke>`, 'i');
  const invokeBlock = (text.match(invokePattern) || [])[0] || '';
  const hasNamedTypedNodeDirectly = /<(string|number|array|object|boolean)\b[^>]*\bname\s*=\s*["'][^"']+["'][^>]*>/i.test(invokeBlock);
  const hasParameterWrapper = /<parameter\b[^>]*\bname\s*=\s*["'][^"']+["'][^>]*>/i.test(invokeBlock);
  if (hasNamedTypedNodeDirectly && !hasParameterWrapper) {
    return 'invalid_xml_shape: named typed nodes were placed directly under invoke; each field must be wrapped by parameter.';
  }
  if (Object.prototype.hasOwnProperty.call(args, 'event_board')) {
    return 'invalid_parameter_name: use parameter name eventBoard (camelCase), not event_board.';
  }
  if (Object.prototype.hasOwnProperty.call(args, 'eventboard')) {
    return 'invalid_parameter_name: use parameter name eventBoard (camelCase), not eventboard.';
  }
  return 'missing_required_parameters: required parameter names are summary, keywords, eventBoard.';
}

async function buildSummaryRepairPrompt(
  lastResponse: string,
  reason: string,
  failureDetail: string,
  attempt: number,
  maxAttempts: number
): Promise<string> {
  return renderPromptText(SUMMARY_REPAIR_PROMPT_TEMPLATE, {
    attempt,
    max_attempts: maxAttempts,
    failure_reason: escapeXml(reason),
    failure_detail: escapeXml(failureDetail),
    contract_output_instruction: escapeXml(SUMMARY_CONTRACT_OUTPUT_INSTRUCTION),
    contract_policy_text: escapeXml(SUMMARY_CONTRACT_POLICY_TEXT),
    required_shape_example: escapeXml(SUMMARY_OUTPUT_SHAPE_EXAMPLE),
    last_response_preview: escapeXml(clipText(lastResponse, SUMMARY_PREVIEW_MAX_CHARS))
  });
}

function parseSummaryFromToolsOutput(raw: unknown): { parsed: ParsedSummaryOutput | null; invokeFound: boolean; reason: string } {
  const text = String(raw ?? '').trim();
  if (!text) return { parsed: null, invokeFound: false, reason: 'empty_response' };

  const invokes = parseSentraToolsInvocations(text);
  if (!Array.isArray(invokes) || invokes.length === 0) {
    return { parsed: null, invokeFound: false, reason: 'no_sentra_tools_invocation' };
  }

  const invoke = invokes.find((it) => String(it?.aiName || '').trim() === SUMMARY_INVOKE_NAME);
  if (!invoke) return { parsed: null, invokeFound: false, reason: `missing_invoke_${SUMMARY_INVOKE_NAME}` };

  const args = invoke.args && typeof invoke.args === 'object' ? invoke.args as Record<string, unknown> : {};
  const hasSummary = Object.prototype.hasOwnProperty.call(args, 'summary');
  const hasKeywords = Object.prototype.hasOwnProperty.call(args, 'keywords');
  const hasEventBoard = Object.prototype.hasOwnProperty.call(args, 'eventBoard');
  if (!hasSummary || !hasKeywords || !hasEventBoard) {
    return { parsed: null, invokeFound: true, reason: buildSummaryParseFailureReason(text, args) };
  }

  const summary = String(args.summary ?? '').trim();
  if (!summary) return { parsed: null, invokeFound: true, reason: 'missing_or_empty_summary' };
  if (!Array.isArray(args.keywords)) return { parsed: null, invokeFound: true, reason: 'keywords_not_array' };
  if (!Array.isArray(args.eventBoard)) return { parsed: null, invokeFound: true, reason: 'event_board_not_array' };

  const confidenceRaw = Number(args.confidence);
  const confidence = Number.isFinite(confidenceRaw) && confidenceRaw >= 0 && confidenceRaw <= 1 ? confidenceRaw : null;

  return {
    parsed: {
      summary,
      confidence,
      keywords: normalizeStringList(args.keywords, 24, 80),
      eventBoard: normalizeStringList(args.eventBoard, 32, 2000),
      artifacts: Array.isArray(args.artifacts) ? normalizeArtifacts(args.artifacts, 48) : []
    },
    invokeFound: true,
    reason: ''
  };
}

export async function buildContextSummaryMessages(options: ContextSummaryOptions = {}): Promise<ChatMessage[]> {
  const { chatType = 'group', presetText } = options;
  const baseSystem = await buildSummarySystemPrompt({ chatType, botName: BOT_PRIMARY_NAME });
  const rootDirectiveXml = await buildSummaryRootDirectiveXml();
  const requestXml = buildSummaryRequestXml(options);

  let systemContent = baseSystem;
  if (presetText && typeof presetText === 'string' && presetText.trim()) {
    systemContent = [
      baseSystem,
      '',
      '---',
      '',
      'Below is your long-term persona preset. Keep the same identity and tone while summarizing:',
      presetText.trim()
    ].join('\n');
  }

  const fewShotMessages = buildContextSummaryFewShotMessages();
  return [
    { role: 'system', content: systemContent },
    ...fewShotMessages,
    { role: 'user', content: `${rootDirectiveXml}\n\n${requestXml}` }
  ];
}

export async function compressContext(params: CompressContextParams = {}): Promise<CompressContextResult> {
  const {
    agent,
    historyConversations,
    chatType = 'group',
    groupId,
    userId,
    timeStart,
    timeEnd,
    maxSummarySentences = 1,
    model,
    presetText,
    apiBaseUrl,
    apiKey,
    timeout
  } = params;

  if (!agent || typeof agent.chat !== 'function') {
    throw new Error('compressContext: agent.chat(messages, options) is required');
  }

  if (!Array.isArray(historyConversations) || historyConversations.length === 0) {
    return {
      summary: '',
      keywords: [],
      eventBoard: [],
      artifacts: [],
      confidence: null,
      messages: [],
      ...(model ? { model } : {})
    };
  }

  const summaryOptions: ContextSummaryOptions = {
    historyConversations,
    chatType,
    maxSummarySentences,
    ...(groupId !== undefined ? { groupId } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(timeStart !== undefined ? { timeStart } : {}),
    ...(timeEnd !== undefined ? { timeEnd } : {}),
    ...(presetText !== undefined ? { presetText } : {})
  };

  const conversation: ChatMessage[] = await buildContextSummaryMessages(summaryOptions);
  const options = {
    ...(model ? { model } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(Number.isFinite(Number(timeout)) && Number(timeout) > 0 ? { timeout: Number(timeout) } : {})
  };

  logger.debug(
    `compressContext: chatType=${chatType} groupId=${groupId || ''} userId=${userId || ''} ` +
    `historyCount=${historyConversations.length}, maxSummarySentences=${maxSummarySentences}`
  );

  const maxAttempts = SUMMARY_MAX_RETRIES + 1;
  let lastReason = 'unknown_parse_error';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await agent.chat(conversation, options);
    const responseText = String(response ?? '').trim();
    const parsed = parseSummaryFromToolsOutput(responseText);

    if (parsed.parsed) {
      logger.info(
        `compressContext: summary done chatType=${chatType} groupId=${groupId || ''} ` +
        `historyCount=${historyConversations.length}, summaryLength=${parsed.parsed.summary.length}, attempt=${attempt}`
      );
      return {
        summary: parsed.parsed.summary,
        keywords: parsed.parsed.keywords,
        eventBoard: parsed.parsed.eventBoard,
        artifacts: parsed.parsed.artifacts,
        confidence: parsed.parsed.confidence,
        messages: conversation,
        ...(model ? { model } : {})
      };
    }

    lastReason = parsed.reason || 'invalid_structured_summary_output';
    const failureDetail = parsed.reason || buildSummaryParseFailureReason(responseText, {});

    let repairCandidate = responseText;
    let formatFixApplied = false;
    let formatFixReason = '';
    try {
      const fixParams: ModelFormatFixParams = {
        expectedOutput: 'sentra_tools',
        candidateOutput: responseText
      };
      if (agent) fixParams.agent = agent as unknown as NonNullable<ModelFormatFixParams['agent']>;
      if (conversation.length > 0) fixParams.conversations = conversation;
      if (typeof model === 'string' && model.trim()) fixParams.model = model;
      if (typeof options.timeout === 'number' && Number.isFinite(options.timeout) && options.timeout > 0) {
        fixParams.timeout = options.timeout;
      }
      if (typeof groupId === 'string' && groupId.trim()) fixParams.groupId = groupId;
      if (lastReason) fixParams.lastErrorReason = lastReason;
      const fixed = await runSentraFormatFixPipeline(fixParams);
      if (typeof fixed === 'string' && fixed.trim()) {
        formatFixApplied = fixed.trim() !== responseText;
        repairCandidate = fixed.trim();
        const reparsed = parseSummaryFromToolsOutput(repairCandidate);
        if (reparsed.parsed) {
          logger.info('compressContext: summary parsed after format-fix pipeline', {
            attempt,
            maxAttempts,
            originalReason: lastReason,
            historyCount: historyConversations.length
          });
          return {
            summary: reparsed.parsed.summary,
            keywords: reparsed.parsed.keywords,
            eventBoard: reparsed.parsed.eventBoard,
            artifacts: reparsed.parsed.artifacts,
            confidence: reparsed.parsed.confidence,
            messages: conversation,
            ...(model ? { model } : {})
          };
        }
        formatFixReason = reparsed.reason || 'format_fix_output_parse_failed';
      }
    } catch (e) {
      logger.warn('compressContext: format-fix pipeline failed', { attempt, maxAttempts, reason: String(e) });
    }

    logger.warn('compressContext: structured summary parse failed', {
      attempt,
      maxAttempts,
      reason: lastReason,
      formatFixApplied,
      formatFixReason,
      invokeFound: parsed.invokeFound,
      responsePreview: clipText(responseText, SUMMARY_PREVIEW_MAX_CHARS)
    });

    if (attempt >= maxAttempts) break;

    conversation.push({ role: 'assistant', content: repairCandidate || '<empty_response />' });
    conversation.push({
      role: 'user',
      content: await buildSummaryRepairPrompt(repairCandidate, lastReason, failureDetail, attempt + 1, maxAttempts)
    });
  }

  throw new Error(`compressContext: failed to parse ${SUMMARY_INVOKE_NAME} after ${maxAttempts} attempts (${lastReason})`);
}
