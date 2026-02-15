import { createLogger } from '../utils/logger.js';
import { tokenCounter } from '../src/token-counter.js';
import { getEnv, getEnvInt, getEnvBool } from '../utils/envHotReloader.js';
import { extractAllFullXMLTags } from '../utils/xmlUtils.js';
import { preprocessPlainModelOutput } from './OutputPreprocessor.js';
import { parseReplyGateDecisionFromSentraTools, parseSentraResponse } from '../utils/protocolUtils.js';
import type { ExpectedOutput, FormatCheckResult, ChatMessage, ModelFormatFixParams } from '../src/types.js';
import {
  guardAndNormalizeSentraResponse,
  shouldAttemptModelFormatFix,
  attemptModelFormatFixWithAgent,
  runSentraFormatFixPipeline
} from '../utils/responseFormatGuard.js';

const logger = createLogger('ChatWithRetry');

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

function extractFirstSentraResponseBlock(text: unknown): string | null {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('<sentra-response>');
  if (start < 0) return null;
  const end = text.indexOf('</sentra-response>', start);
  if (end < 0) return null;
  return text.substring(start, end + '</sentra-response>'.length);
}

function extractOnlySentraResponseBlock(text: unknown): string | null {
  const s = String(text || '').trim();
  if (!s) return null;
  const normalized = extractFirstSentraResponseBlock(s);
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

function validateSentraToolsOnlyFormat(response: unknown): FormatCheckResult {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: 'empty or non-string response' };
  }

  const normalized = extractOnlySentraToolsBlock(response);
  if (!normalized) {
    return { valid: false, reason: 'missing <sentra-tools> block' };
  }

  if (normalized.includes('<sentra-response>')) {
    return { valid: false, reason: 'unexpected <sentra-response> block' };
  }

  return { valid: true, normalized };
}

function validateSentraToolsOrResponseFormat(response: unknown): FormatCheckResult {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: 'empty or non-string response' };
  }

  const toolsXml = extractOnlySentraToolsBlock(response);
  if (toolsXml) {
    if (toolsXml.includes('<sentra-response>')) {
      return { valid: false, reason: 'unexpected <sentra-response> block' };
    }
    return { valid: true, normalized: toolsXml, toolsOnly: true, rawToolsXml: toolsXml };
  }

  const respXml = extractOnlySentraResponseBlock(response);
  if (respXml) {
    return { valid: true, normalized: respXml };
  }

  return {
    valid: false,
    reason: 'must output exactly one top-level <sentra-tools> or <sentra-response> block'
  };
}

function validateReplyGateDecisionToolsFormat(response: unknown): FormatCheckResult {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: 'empty or non-string response' };
  }

  const normalized = extractOnlySentraToolsBlock(response);
  if (!normalized) {
    return { valid: false, reason: 'missing <sentra-tools> block' };
  }

  if (normalized.includes('<sentra-response>')) {
    return { valid: false, reason: 'unexpected <sentra-response> block' };
  }

  const decision = parseReplyGateDecisionFromSentraTools(normalized);
  if (!decision || typeof decision.enter !== 'boolean') {
    return { valid: false, reason: 'invalid reply_gate_decision enter value' };
  }

  return {
    valid: true,
    normalized
  };
}

function validateOverrideDecisionToolsFormat(response: unknown): FormatCheckResult {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: 'empty or non-string response' };
  }

  const repaired = repairOverrideDecisionToolsOutput(response);
  let toolsXml = repaired || extractOnlySentraToolsBlock(response);
  if (!toolsXml) {
    return { valid: false, reason: 'missing <sentra-tools> block' };
  }

  if (toolsXml.includes('<sentra-response>')) {
    return { valid: false, reason: 'unexpected <sentra-response> block' };
  }

  const invokeMatch = toolsXml.match(/<invoke[^>]*name=["']override_intent_decision["'][^>]*>([\s\S]*?)<\/invoke>/i);
  if (!invokeMatch) {
    return { valid: false, reason: 'missing override_intent_decision invoke' };
  }

  const body = invokeMatch[1] || '';
  let decision = '';
  const decisionMatch = body.match(/<parameter[^>]*name=["']decision["'][^>]*>[\s\S]*?<string>([\s\S]*?)<\/string>[\s\S]*?<\/parameter>/i);
  if (decisionMatch) {
    const decisionValue = decisionMatch[1];
    if (typeof decisionValue === 'string') {
      decision = decisionValue.trim().toLowerCase();
    }
  } else {
    const decisionBareMatch = body.match(/<parameter[^>]*name=["']decision["'][^>]*>([\s\S]*?)<\/parameter>/i);
    if (decisionBareMatch) {
      const decisionValue = decisionBareMatch[1];
      if (typeof decisionValue === 'string') {
        decision = decisionValue.trim().toLowerCase();
      }
    } else {
      const decisionTagMatch = body.match(/<decision>([\s\S]*?)<\/decision>/i);
      if (decisionTagMatch) {
        const decisionValue = decisionTagMatch[1];
        if (typeof decisionValue === 'string') {
          decision = decisionValue.trim().toLowerCase();
        }
      }
    }
  }
  const allowed = new Set(['reply', 'pending', 'cancel_and_restart', 'cancel_only']);
  if (!decision || !allowed.has(decision)) {
    return { valid: false, reason: 'invalid override decision value' };
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
  const invokeMatch = text.match(/<invoke[^>]*name=["']override_intent_decision["'][^>]*>[\s\S]*?<\/invoke>/i);
  if (invokeMatch) {
    return `<sentra-tools>\n${invokeMatch[0]}\n</sentra-tools>`;
  }

  // Try to recover from bare decision/fields.
  const decisionMatch = text.match(/<decision>([\s\S]*?)<\/decision>/i);
  const reasonMatch = text.match(/<reason>([\s\S]*?)<\/reason>/i);
  const confMatch = text.match(/<confidence>([\s\S]*?)<\/confidence>/i);
  if (decisionMatch) {
    const decisionValue = decisionMatch[1];
    const decision = typeof decisionValue === 'string' ? decisionValue.trim() : '';
    const reasonValue = reasonMatch ? reasonMatch[1] : '';
    const reason = typeof reasonValue === 'string' ? reasonValue.trim() : '';
    const confValue = confMatch ? confMatch[1] : '';
    const confidence = typeof confValue === 'string' ? confValue.trim() : '';
    return [
      '<sentra-tools>',
      '  <invoke name="override_intent_decision">',
      `    <parameter name="decision"><string>${decision}</string></parameter>`,
      `    <parameter name="confidence"><number>${confidence || '0.5'}</number></parameter>`,
      `    <parameter name="reason"><string>${reason || 'repaired override decision'}</string></parameter>`,
      '  </invoke>',
      '</sentra-tools>'
    ].join('\n');
  }

  return '';
}
function validateResponseFormat(response: unknown, expectedOutput: ExpectedOutput = 'sentra_response'): FormatCheckResult {
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

  if (expected === 'sentra_tools_or_response') {
    return validateSentraToolsOrResponseFormat(response);
  }

  if (!response || typeof response !== 'string') {
    return { valid: false, reason: '响应为空或非字符串' };
  }

  // Special-case: When we EXPECT <sentra-response> but the model outputs ONLY <sentra-tools>,
  // allow the upper layer to decide how to handle it (fallback/restart) in normal mode.
  // Tool-only output is treated as a control signal and is bubbled to the upper layer.
  const toolsOnlyXml = extractOnlySentraToolsBlock(response);
  if (toolsOnlyXml) {
    return { valid: true, toolsOnly: true, rawToolsXml: toolsOnlyXml };
  }

  const normalized = extractFirstSentraResponseBlock(response);
  if (!normalized) {
    return { valid: false, reason: '缺少 <sentra-response> 标签' };
  }

  // Target routing tags are REQUIRED by protocol, but we do NOT fail strict format checks on missing/duplicate tags.
  // Rationale: The upper layer (MessagePipeline) will auto-inject / normalize the target tag based on current chat.
  // This avoids unnecessary retries for otherwise well-formed <sentra-response>.
  let missingTarget = false;
  let targetConflict = false;
  try {
    const hasGroup = normalized.includes('<group_id>') && normalized.includes('</group_id>');
    const hasUser = normalized.includes('<user_id>') && normalized.includes('</user_id>');
    missingTarget = !hasGroup && !hasUser;
    targetConflict = hasGroup && hasUser;
  } catch { }

  // Enforce: output MUST be exactly one <sentra-response> block (no extra text/tags outside)
  try {
    const trimmed = String(response || '').trim();
    const normTrimmed = String(normalized || '').trim();
    if (trimmed !== normTrimmed) {
      return { valid: false, reason: '检测到 <sentra-response> 外存在额外内容（不允许）' };
    }
  } catch { }

  const forbiddenTags = [
    '<sentra-tools>',
    '<sentra-result>',
    '<sentra-result-group>',
    '<sentra-user-question>',
    '<sentra-pending-messages>',
    '<sentra-emo>',
    '<sentra-memory>'
  ];

  for (const tag of forbiddenTags) {
    if (normalized.includes(tag)) {
      return { valid: false, reason: `包含非法的只读标签: ${tag}` };
    }
  }

  return { valid: true, normalized };
}

function getFormatCheckReason(check: FormatCheckResult): string {
  if (check.valid === false) return check.reason;
  return '';
}

function extractAndCountTokens(response: string): { text: string; tokens: number } {
  const textMatches = response.match(/<text\d+>([\s\S]*?)<\/text\d+>/g) || [];
  const texts = textMatches
    .map((match: string) => {
      const content = match.replace(/<\/?text\d+>/g, '').trim();
      return content;
    })
    .filter(Boolean);

  const combinedText = texts.join(' ');
  const tokens = tokenCounter.countTokens(combinedText);

  return { text: combinedText, tokens };
}

function hasNonTextPayload(response: string): boolean {
  try {
    const parsed = parseSentraResponse(response);
    const hasResources = parsed && Array.isArray(parsed.resources) && parsed.resources.length > 0;
    const hasEmoji = parsed && parsed.emoji && parsed.emoji.source;
    return !!(hasResources || hasEmoji);
  } catch {
    return false;
  }
}

function buildProtocolReminder(expectedOutput: ExpectedOutput = 'sentra_response', lastFormatReason = ''): string {
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
  const expected = escapeXml(expectedOutput || 'sentra_response');

  const isToolsOnly = expectedOutput === 'sentra_tools' || expectedOutput === 'reply_gate_decision_tools' || expectedOutput === 'override_intent_decision_tools';
  const isToolsOrResponse = expectedOutput === 'sentra_tools_or_response';

  return [
    '<sentra-root-directive>',
    '  <id>format_retry_v1</id>',
    '  <type>format_repair</type>',
    '  <scope>single_turn</scope>',
    '  <objective>修复上一条输出的格式，并重新输出最终给用户看的内容。</objective>',
    `  <expected_output>${expected}</expected_output>`,
    ...(reason ? [`  <last_error>${reason}</last_error>`] : []),
    '  <constraints>',
    '    <item>你必须且只能输出一个顶层块，除此之外不能输出任何额外文本。</item>',
    ...(isToolsOnly
      ? ['    <item>本轮只能输出 &lt;sentra-tools&gt;...&lt;/sentra-tools&gt;，禁止输出任何其它内容或标签（包括 sentra-response/sentra-result/sentra-user-question 等）。</item>']
      : isToolsOrResponse
        ? ['    <item>本轮必须且只能输出二选一：&lt;sentra-tools&gt;...&lt;/sentra-tools&gt; 或 &lt;sentra-response&gt;...&lt;/sentra-response&gt;，除此之外禁止输出任何字符。</item>']
        : ['    <item>本轮只能输出 &lt;sentra-response&gt;...&lt;/sentra-response&gt;，禁止输出任何其它 sentra-xxx 标签（包括 sentra-tools/sentra-result/sentra-user-question/sentra-pending-messages 等）。</item>']),
    '    <item>&lt;sentra-response&gt; 内只能包含允许字段：&lt;group_id&gt; 或 &lt;user_id&gt;（二选一且仅一个）、&lt;textN&gt;、&lt;resources&gt;、可选 &lt;emoji&gt;、可选 &lt;send&gt;。</item>',
    '    <item>目标路由标签必须显式写出：群聊用 &lt;group_id&gt;...&lt;/group_id&gt;；私聊用 &lt;user_id&gt;...&lt;/user_id&gt;；两者不可同时出现。</item>',
    '    <item>不要输出任何“工具/字段/返回值/执行步骤”的叙述；只说用户能理解的人话。</item>',
    '  </constraints>',
    '  <output_template>',
    '    <sentra-response>',
    '      <group_id_or_user_id>...</group_id_or_user_id>',
    '      <text1>...</text1>',
    '      <resources></resources>',
    '    </sentra-response>',
    '  </output_template>',
    '</sentra-root-directive>'
  ].join('\n');
}

function buildOverrideDecisionToolsReminder(): string {
  return [
    'CRITICAL OUTPUT RULES:',
    '1) Output exactly ONE <sentra-tools>...</sentra-tools> block with ONE <invoke name="override_intent_decision">.',
    '2) The invoke must include decision(string) / confidence(number) / reason(string).',
    '3) Do NOT output any <sentra-response> block.',
    '4) Do NOT wrap XML in markdown fences.'
  ].join('\n');
}
function buildReplyGateDecisionToolsReminder(): string {
  return [
    'CRITICAL OUTPUT RULES:',
    '1) Output exactly ONE <sentra-tools>...</sentra-tools> block with ONE <invoke name="reply_gate_decision">.',
    '2) The invoke must include enter(boolean) and reason(string).',
    '3) Do NOT output any <sentra-response> block or extra text.',
    '4) Do NOT wrap XML in markdown fences.'
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
    return 'unknown error';
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

  const expectedOutput = (options.__sentraExpectedOutput || 'sentra_response') as ExpectedOutput;
  const chatOptions: ChatOptions = { ...options };
  delete chatOptions.__sentraExpectedOutput;

  while (retries <= maxResponseRetries) {
    try {
      const attemptIndex = retries + 1;
      logger.debug(`[${groupId}] AI请求第${attemptIndex}次尝试`);

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
        logger.info(`[${groupId}] 协议复述注入: ${lastFormatReason}`);
      }

      let response = await agent.chat(convThisTry, {
        ...chatOptions,
        expectedOutput,
        onEarlyTerminate: (event: EarlyTerminateEvent) => {
          logger.info(`[${groupId}] 流式早终止: ${event?.reason || 'unknown'}`);
        }
      });
      const rawResponse = response;
      if (typeof response === 'string') {
        response = preprocessPlainModelOutput(response);
      } else {
        response = null;
      }

      // 本地格式守卫：优先提取/截断为第一段 <sentra-response>，减少无意义重试
      if (expectedOutput === 'sentra_response' && typeof response === 'string' && response.trim()) {
        const guarded = guardAndNormalizeSentraResponse(response);
        if (guarded && guarded.ok && typeof guarded.normalized === 'string' && guarded.normalized.trim()) {
          response = guarded.normalized;
        }
      }
      lastResponse = response;

      let modelFormatFixTried = false;

      if (strictFormatCheck) {
        let formatCheck = validateResponseFormat(response, expectedOutput);

        // 在进入重试前，优先用 root directive 让模型“就地修复格式”，减少无意义重试
        if (!formatCheck.valid && (expectedOutput === 'sentra_response' || expectedOutput === 'sentra_tools' || expectedOutput === 'sentra_tools_or_response')) {
          const allowFix = shouldAttemptModelFormatFix({
            expectedOutput,
            lastErrorReason: getFormatCheckReason(formatCheck),
            alreadyTried: modelFormatFixTried
          });

          if (allowFix) {
            modelFormatFixTried = true;
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
              }
            } catch { }
          }
        }

        if (!formatCheck.valid) {
          lastFormatReason = getFormatCheckReason(formatCheck);
          logger.warn(`[${groupId}] 格式验证失败: ${getFormatCheckReason(formatCheck)}`);
          logger.debug(`[${groupId}] 原始响应片段(格式失败): ${getResponsePreview(response)}`);

          if (
            expectedOutput === 'sentra_response' &&
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
                  logger.info(`[${groupId}] 修复流式早终止: ${event?.reason || 'unknown'}`);
                }
              });
              if (typeof repaired === 'string') {
                repaired = preprocessPlainModelOutput(repaired);
              }
              if (expectedOutput === 'sentra_response' && typeof repaired === 'string' && repaired.trim()) {
                const guarded = guardAndNormalizeSentraResponse(repaired);
                if (guarded && guarded.ok && typeof guarded.normalized === 'string' && guarded.normalized.trim()) {
                  repaired = guarded.normalized;
                }
              }
              const repairedCheck = validateResponseFormat(repaired, expectedOutput);
              if (repairedCheck.valid && !repairedCheck.toolsOnly) {
                logger.success(`[${groupId}] 格式修复成功(追加root指令)`);
                return { response: repaired, rawResponse: repaired, retries, success: true };
              }
            } catch (e) {
              logger.warn(`[${groupId}] 追加root指令修复失败: ${getErrorMessage(e)}`);
            }
          }

          if (retries < maxResponseRetries) {
            retries++;
            logger.debug(`[${groupId}] 格式验证失败，直接重试（第${retries + 1}次）...`);
            await sleep(1000);
            continue;
          }

          const allowRepair = expectedOutput === 'sentra_response' || expectedOutput === 'sentra_tools' || expectedOutput === 'sentra_tools_or_response';
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
                  logger.success(`[${groupId}] 格式已自动修复`);
                  return { response: repaired, rawResponse: repaired, retries, success: true };
                }
                logger.debug(`[${groupId}] 修复后仍不合规，修复响应片段: ${getResponsePreview(repaired)}`);
              }
            } catch (e) {
              logger.warn(`[${groupId}] 格式修复失败: ${getErrorMessage(e)}`);
            }
          }

          logger.error(`[${groupId}] 格式验证失败-最终: 已达最大重试次数`);
          logger.error(`[${groupId}] 最后原始响应片段: ${getResponsePreview(lastResponse)}`);
          return { response: null, retries, success: false, reason: getFormatCheckReason(formatCheck) };
        }

        if (formatCheck.toolsOnly) {
          logger.warn(
            `[${groupId}] 期望 <sentra-response> 但收到纯 <sentra-tools>，将上抛 toolsOnly 交由上层回退处理`
          );
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
      if (expectedOutput === 'reply_gate_decision_tools') {
        const decision = parseReplyGateDecisionFromSentraTools(responseText);
        tokenText = decision && typeof decision.reason === 'string' ? decision.reason : '';
      } else if (expectedOutput === 'override_intent_decision_tools') {
        const raw = responseText;
        let reasonText = '';
        const reasonMatch = raw.match(/<parameter[^>]*name=["']reason["'][^>]*>[\s\S]*?<string>([\s\S]*?)<\/string>[\s\S]*?<\/parameter>/i);
        if (reasonMatch) {
          const reasonValue = reasonMatch[1];
          if (typeof reasonValue === 'string') {
            reasonText = reasonValue.trim();
          }
        } else {
          const reasonBareMatch = raw.match(/<parameter[^>]*name=["']reason["'][^>]*>([\s\S]*?)<\/parameter>/i);
          if (reasonBareMatch) {
            const reasonValue = reasonBareMatch[1];
            if (typeof reasonValue === 'string') {
              reasonText = reasonValue.trim();
            }
          } else {
            const reasonTagMatch = raw.match(/<reason>([\s\S]*?)<\/reason>/i);
            if (reasonTagMatch) {
              const reasonValue = reasonTagMatch[1];
              if (typeof reasonValue === 'string') {
                reasonText = reasonValue.trim();
              }
            }
          }
        }
        tokenText = reasonText;
      } else {
        tokenText = extractAndCountTokens(responseText).text;
      }
      const tokens = tokenCounter.countTokens(tokenText || '');
      const text = tokenText || '';
      logger.debug(`[${groupId}] Token统计: ${tokens} tokens, 文本长度: ${text.length}`);

      if (maxResponseTokens > 0 && tokens > maxResponseTokens) {
        logger.warn(`[${groupId}] Token超限: ${tokens} > ${maxResponseTokens}`);
        logger.debug(`[${groupId}] 原始响应片段(Token超限): ${getResponsePreview(response)}`);
        if (retries < maxResponseRetries) {
          retries++;
          logger.debug(`[${groupId}] Token超限，直接重试（第${retries + 1}次）...`);
          await sleep(500);
          continue;
        }
        logger.error(`[${groupId}] Token超限-最终: 已达最大重试次数`);
        logger.error(`[${groupId}] 最后原始响应片段: ${getResponsePreview(lastResponse)}`);
        return {
          response: null,
          retries,
          success: false,
          reason: `Token超限: ${tokens}>${maxResponseTokens}`
        };
      }

      const noReply =
        expectedOutput === 'reply_gate_decision_tools' ||
          expectedOutput === 'override_intent_decision_tools' ||
          expectedOutput === 'sentra_tools' ||
          expectedOutput === 'sentra_tools_or_response'
          ? false
          : (tokens === 0 && !hasNonTextPayload(responseText));
      if (noReply) {
        logger.warn(
          `[${groupId}] Token统计为 0，本轮按“保持沉默/不回复”处理（不应向用户发送任何内容）`
        );
      }
      const limitDisplay = maxResponseTokens > 0 ? maxResponseTokens : 'unlimited';
      logger.success(`[${groupId}] AI响应成功 (${tokens}/${limitDisplay} tokens)`);
      return { response, rawResponse, retries, success: true, tokens, text, noReply };
    } catch (error) {
      logger.error(`[${groupId}] AI请求失败 - 第${retries + 1}次尝试`, error);
      lastError = error;
      lastFormatReason = '';
      const responseData = getErrorResponseData(error);
      if (responseData !== undefined) {
        logger.error(`[${groupId}] API失败响应体: ${getResponsePreview(responseData)}`);
      }
      if (retries < maxResponseRetries) {
        retries++;
        logger.warn(`[${groupId}] 网络错误，1秒后第${retries + 1}次重试...`);
        await sleep(1000);
        continue;
      }
      logger.error(`[${groupId}] AI请求失败 - 已达最大重试次数${maxResponseRetries}次`);
      if (lastResponse) {
        logger.error(`[${groupId}] 最后成功响应片段: ${getResponsePreview(lastResponse)}`);
      }
      return { response: null, retries, success: false, reason: getErrorMessage(lastError) };
    }
  }

  return {
    response: null,
    retries,
    success: false,
    reason: lastError ? getErrorMessage(lastError) : '未知错误'
  };
}


