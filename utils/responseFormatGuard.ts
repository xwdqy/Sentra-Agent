import { createLogger } from './logger.js';
import { randomUUID } from 'node:crypto';
import { extractAllFullXMLTags, tryParseXmlFragment, escapeXml } from './xmlUtils.js';
import { getEnvBool } from './envHotReloader.js';
import { repairSentraResponse } from './formatRepair.js';
import { parseSentraMessage } from './protocolUtils.js';
import type { SentraMessageSegment } from './protocolUtils.js';
import type { ExpectedOutput, GuardResult, ModelFormatFixParams, ChatMessage } from '../src/types.js';
import { tRuntimeFormat } from './i18n/runtimeFormatCatalog.js';
import {
  buildFormatFixRootDirectiveFromContract,
  buildFormatFixSkillHintsFromContract
} from './runtimeFormatContract.js';

const logger = createLogger('ResponseFormatGuard');

function isToolsOnlyExpectedOutput(expectedOutput: unknown): boolean {
  const eo = String(expectedOutput || '').trim().toLowerCase();
  return eo === 'sentra_tools' || eo === 'reply_gate_decision_tools' || eo === 'override_intent_decision_tools';
}

function isToolsOrMessageExpectedOutput(expectedOutput: unknown): boolean {
  const eo = String(expectedOutput || '').trim().toLowerCase();
  return eo === 'sentra_tools_or_message';
}

function extractFirstFullTag(text: unknown, tagName: string): string | null {
  const s = typeof text === 'string' ? text : '';
  if (!s.trim()) return null;
  const blocks = extractAllFullXMLTags(s, tagName);
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  return String(blocks[0] || '').trim() || null;
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
  const data = seg?.data && typeof seg.data === 'object' ? seg.data : {};
  if (type === 'text') {
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    return text.length > 0;
  }
  return hasMeaningfulSegmentData(data);
}

function validateSentraMessageSegments(xml: unknown): { ok: boolean; reason?: string } {
  try {
    const parsed = parseSentraMessage(xml);
    const chatType = typeof parsed?.chat_type === 'string' ? parsed.chat_type.trim().toLowerCase() : '';
    const hasGroup = typeof parsed?.group_id === 'string' && parsed.group_id.trim().length > 0;
    const hasUser = typeof parsed?.user_id === 'string' && parsed.user_id.trim().length > 0;

    if (chatType !== 'group' && chatType !== 'private') {
      return {
        ok: false,
        reason: withSentraMessageReasonTrace(tRuntimeFormat('sentra_message_must_include_chat_type'), xml)
      };
    }
    if (chatType === 'group') {
      if (!hasGroup) {
        return {
          ok: false,
          reason: withSentraMessageReasonTrace(tRuntimeFormat('chat_type_group_requires_group_id'), xml)
        };
      }
      if (hasUser) {
        return {
          ok: false,
          reason: withSentraMessageReasonTrace(tRuntimeFormat('chat_type_group_cannot_include_user_id'), xml)
        };
      }
    }
    if (chatType === 'private') {
      if (!hasUser) {
        return {
          ok: false,
          reason: withSentraMessageReasonTrace(tRuntimeFormat('chat_type_private_requires_user_id'), xml)
        };
      }
      if (hasGroup) {
        return {
          ok: false,
          reason: withSentraMessageReasonTrace(tRuntimeFormat('chat_type_private_cannot_include_group_id'), xml)
        };
      }
    }

    const segments = Array.isArray(parsed?.message) ? parsed.message : [];
    if (segments.length === 0) {
      return {
        ok: false,
        reason: withSentraMessageReasonTrace(tRuntimeFormat('sentra_message_must_contain_segment'), xml)
      };
    }
    const valid = segments.filter((seg) => isValidSentraMessageSegment(seg));
    if (valid.length === 0) {
      return {
        ok: false,
        reason: withSentraMessageReasonTrace(tRuntimeFormat('sentra_message_must_contain_valid_segment'), xml)
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: withSentraMessageReasonTrace(tRuntimeFormat('sentra_message_parse_failed'), xml)
    };
  }
}

function extractOnlySentraToolsBlock(text: unknown): string | null {
  const s = typeof text === 'string' ? text.trim() : String(text ?? '').trim();
  if (!s) return null;
  const blocks = extractAllFullXMLTags(s, 'sentra-tools');
  if (!Array.isArray(blocks) || blocks.length !== 1) return null;
  const merged = String(blocks[0] || '').trim();
  if (!merged) return null;
  if (merged !== s) return null;
  return merged;
}

function isLikelySentraMessageBlock(xml: unknown): boolean {
  if (!xml || typeof xml !== 'string') return false;
  if (!xml.includes('<sentra-message')) return false;
  if (!xml.includes('</sentra-message>')) return false;
  const parsed = tryParseXmlFragment(xml, 'root');
  if (!parsed || typeof parsed !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(parsed, 'sentra-message');
}

export function guardAndNormalizeSentraTools(raw: unknown, opts: { enabled?: boolean } = {}): GuardResult {
  const enabled = opts.enabled ?? getEnvBool('ENABLE_LOCAL_FORMAT_GUARD', true);
  if (!enabled) {
    const response = typeof raw === 'string' ? raw : String(raw ?? '');
    return { ok: true, normalized: response, changed: false };
  }

  const response = typeof raw === 'string' ? raw : String(raw ?? '');
  const trimmed = response.trim();
  if (!trimmed) {
    return { ok: false, normalized: null, changed: false, reason: tRuntimeFormat('guard_empty') };
  }

  const only = extractOnlySentraToolsBlock(trimmed);
  if (only && !only.includes('<sentra-message')) {
    return { ok: true, normalized: only, changed: only !== trimmed };
  }

  const first = extractFirstFullTag(trimmed, 'sentra-tools');
  if (first) {
    try {
      logger.warn(tRuntimeFormat('log_trim_to_first_tools_block'));
    } catch { }
    return { ok: true, normalized: first, changed: true, reason: 'trim_to_first_sentra_tools' };
  }

  return {
    ok: false,
    normalized: null,
    changed: false,
    reason: tRuntimeFormat('guard_missing_sentra_tools')
  };
}

export function guardAndNormalizeSentraToolsOrResponse(raw: unknown, opts: { enabled?: boolean } = {}): GuardResult {
  const enabled = opts.enabled ?? getEnvBool('ENABLE_LOCAL_FORMAT_GUARD', true);
  if (!enabled) {
    const response = typeof raw === 'string' ? raw : String(raw ?? '');
    return { ok: true, normalized: response, changed: false };
  }

  const response = typeof raw === 'string' ? raw : String(raw ?? '');
  const trimmed = response.trim();
  if (!trimmed) {
    return { ok: false, normalized: null, changed: false, reason: tRuntimeFormat('guard_empty') };
  }

  const toolsOnly = extractOnlySentraToolsBlock(trimmed);
  if (toolsOnly && !toolsOnly.includes('<sentra-message')) {
    return { ok: true, normalized: toolsOnly, changed: false };
  }

  const guardedResp = guardAndNormalizeSentraMessage(trimmed, { enabled: true });
  if (guardedResp && guardedResp.ok && guardedResp.normalized) {
    return guardedResp;
  }

  const firstTools = extractFirstFullTag(trimmed, 'sentra-tools');
  if (firstTools) {
    try {
      logger.warn(tRuntimeFormat('log_trim_to_first_tools_block_tools_or_message'));
    } catch { }
    return { ok: true, normalized: firstTools, changed: true, reason: 'trim_to_first_sentra_tools' };
  }

  return {
    ok: false,
    normalized: null,
    changed: false,
    reason: tRuntimeFormat('guard_missing_sentra_tools_or_message')
  };
}

export function guardAndNormalizeSentraMessage(rawResponse: unknown, opts: { enabled?: boolean } = {}): GuardResult {
  const enabled = opts.enabled ?? getEnvBool('ENABLE_LOCAL_FORMAT_GUARD', true);
  if (!enabled) {
    const response = typeof rawResponse === 'string' ? rawResponse : String(rawResponse ?? '');
    return { ok: true, normalized: response, changed: false };
  }

  const response = typeof rawResponse === 'string' ? rawResponse : String(rawResponse ?? '');
  const trimmed = response.trim();
  if (!trimmed) {
    return { ok: false, normalized: null, changed: false, reason: tRuntimeFormat('guard_empty') };
  }

  if (trimmed.startsWith('<sentra-message') && trimmed.endsWith('</sentra-message>') && isLikelySentraMessageBlock(trimmed)) {
    const segCheck = validateSentraMessageSegments(trimmed);
    if (!segCheck.ok) {
      return {
        ok: false,
        normalized: null,
        changed: false,
        reason: segCheck.reason || tRuntimeFormat('invalid_sentra_message_segments')
      };
    }
    return { ok: true, normalized: trimmed, changed: false };
  }

  const first = extractFirstFullTag(trimmed, 'sentra-message');
  if (first && isLikelySentraMessageBlock(first)) {
    const segCheck = validateSentraMessageSegments(first);
    if (!segCheck.ok) {
      return {
        ok: false,
        normalized: null,
        changed: false,
        reason: segCheck.reason || tRuntimeFormat('invalid_sentra_message_segments')
      };
    }
    try {
      logger.warn(tRuntimeFormat('log_trim_to_first_message_block'));
    } catch { }
    return { ok: true, normalized: first, changed: true, reason: 'trim_to_first_sentra_message' };
  }

  return {
    ok: false,
    normalized: null,
    changed: false,
    reason: tRuntimeFormat('guard_missing_sentra_message')
  };
}

export function shouldAttemptModelFormatFix(
  {
    expectedOutput,
    alreadyTried
  }: {
    expectedOutput?: ExpectedOutput;
    lastErrorReason?: string;
    alreadyTried?: boolean;
  } = {}
): boolean {
  if (alreadyTried) return false;
  const enabled = getEnvBool('ENABLE_MODEL_FORMAT_FIX', true);
  if (!enabled) return false;
  const eo = String(expectedOutput || 'sentra_message');
  if (
    eo !== 'sentra_message' &&
    eo !== 'sentra_tools' &&
    eo !== 'sentra_tools_or_message' &&
    eo !== 'reply_gate_decision_tools' &&
    eo !== 'override_intent_decision_tools'
  ) return false;
  return true;
}

export function buildSentraMessageFormatFixRootDirectiveXml({
  lastErrorReason,
  candidateOutput,
  scope = 'single_turn'
}: {
  lastErrorReason?: string;
  candidateOutput?: string;
  scope?: string;
} = {}) {
  const args: {
    expectedOutput: 'sentra_message';
    lastErrorReason?: string;
    candidateOutput?: string;
    scope?: string;
  } = { expectedOutput: 'sentra_message' };
  if (typeof lastErrorReason === 'string') args.lastErrorReason = lastErrorReason;
  if (typeof candidateOutput === 'string') args.candidateOutput = candidateOutput;
  if (typeof scope === 'string') args.scope = scope;
  const doc = buildFormatFixRootDirectiveFromContract(args);
  return doc.replace(
    '<id>format_fix_contract_driven</id>',
    `<id>format_fix_${randomUUID()}</id>`
  );
}

export function buildSentraToolsFormatFixRootDirectiveXml({
  lastErrorReason,
  candidateOutput,
  scope = 'single_turn'
}: {
  lastErrorReason?: string;
  candidateOutput?: string;
  scope?: string;
} = {}) {
  const args: {
    expectedOutput: 'sentra_tools';
    lastErrorReason?: string;
    candidateOutput?: string;
    scope?: string;
  } = { expectedOutput: 'sentra_tools' };
  if (typeof lastErrorReason === 'string') args.lastErrorReason = lastErrorReason;
  if (typeof candidateOutput === 'string') args.candidateOutput = candidateOutput;
  if (typeof scope === 'string') args.scope = scope;
  const doc = buildFormatFixRootDirectiveFromContract(args);
  return doc.replace(
    '<id>format_fix_contract_driven</id>',
    `<id>format_fix_${randomUUID()}</id>`
  );
}

export function buildSentraToolsOrMessageFormatFixRootDirectiveXml({
  lastErrorReason,
  candidateOutput,
  scope = 'single_turn'
}: {
  lastErrorReason?: string;
  candidateOutput?: string;
  scope?: string;
} = {}) {
  const args: {
    expectedOutput: 'sentra_tools_or_message';
    lastErrorReason?: string;
    candidateOutput?: string;
    scope?: string;
  } = { expectedOutput: 'sentra_tools_or_message' };
  if (typeof lastErrorReason === 'string') args.lastErrorReason = lastErrorReason;
  if (typeof candidateOutput === 'string') args.candidateOutput = candidateOutput;
  if (typeof scope === 'string') args.scope = scope;
  const doc = buildFormatFixRootDirectiveFromContract(args);
  return doc.replace(
    '<id>format_fix_contract_driven</id>',
    `<id>format_fix_${randomUUID()}</id>`
  );
}

function buildFormatFixSkillHints(expectedOutput: string, lastErrorReason = ''): string {
  return buildFormatFixSkillHintsFromContract({
    expectedOutput,
    lastErrorReason
  });
}

export async function attemptModelFormatFixWithAgent({
  agent,
  conversations,
  model,
  timeout,
  groupId,
  expectedOutput = 'sentra_message',
  lastErrorReason,
  candidateOutput
}: ModelFormatFixParams = {}) {
  if (!agent || typeof agent.chat !== 'function') return null;
  const conv = Array.isArray(conversations) ? conversations : [];
  const eo = String(expectedOutput || 'sentra_message');
  const fixArgs: { lastErrorReason?: string; candidateOutput?: string; scope?: string } = { scope: 'single_turn' };
  if (typeof lastErrorReason === 'string') fixArgs.lastErrorReason = lastErrorReason;
  if (typeof candidateOutput === 'string') fixArgs.candidateOutput = candidateOutput;

  const rootXml =
    isToolsOnlyExpectedOutput(eo)
      ? buildSentraToolsFormatFixRootDirectiveXml(fixArgs)
      : isToolsOrMessageExpectedOutput(eo)
        ? buildSentraToolsOrMessageFormatFixRootDirectiveXml(fixArgs)
        : buildSentraMessageFormatFixRootDirectiveXml(fixArgs);
  const skillHints = buildFormatFixSkillHints(eo, fixArgs.lastErrorReason || '');

  const fixConversations: ChatMessage[] = [
    ...conv,
    { role: 'system', content: skillHints },
    { role: 'user', content: rootXml }
  ];

  try {
    logger.info('format-fix model attempt start', {
      expectedOutput: eo,
      hasReason: !!String(lastErrorReason || '').trim(),
      group: groupId || 'format_fix'
    });
  } catch { }

  let out: unknown;
  try {
    out = await agent.chat(fixConversations, {
      model,
      temperature: 0.2,
      maxTokens: 600,
      timeout
    });
  } catch (e) {
    try {
      logger.warn(
        tRuntimeFormat('log_format_fix_agent_failed', {
          group: groupId || 'format_fix',
          err: String(e)
        })
      );
    } catch { }
    return null;
  }

  const raw = typeof out === 'string' ? out : String(out ?? '');
  const guarded =
    isToolsOnlyExpectedOutput(eo)
      ? guardAndNormalizeSentraTools(raw)
      : isToolsOrMessageExpectedOutput(eo)
        ? guardAndNormalizeSentraToolsOrResponse(raw)
        : guardAndNormalizeSentraMessage(raw);
  if (guarded && guarded.ok && guarded.normalized) return guarded.normalized;
  try {
    logger.warn('format-fix model attempt returned invalid output', {
      expectedOutput: eo,
      reason: guarded?.reason || 'unknown'
    });
  } catch { }
  return null;
}

export async function repairSentraMessageWithLLM({
  rawText,
  agent,
  model
}: {
  rawText?: string;
  agent?: ModelFormatFixParams['agent'];
  model?: string;
} = {}) {
  const enabled = getEnvBool('ENABLE_FORMAT_REPAIR', true);
  if (!enabled) return null;
  const text = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  if (!text.trim()) return null;
  try {
    const fixed = await repairSentraResponse(text, {
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {})
    });
    const guarded = guardAndNormalizeSentraMessage(fixed);
    if (guarded && guarded.ok && guarded.normalized) {
      return guarded.normalized;
    }
    return fixed;
  } catch {
    return null;
  }
}

export async function runSentraFormatFixPipeline({
  agent,
  conversations,
  model,
  timeout,
  groupId,
  expectedOutput = 'sentra_message',
  lastErrorReason,
  candidateOutput
}: ModelFormatFixParams = {}) {
  const eo = String(expectedOutput || 'sentra_message');
  if (
    eo !== 'sentra_message' &&
    eo !== 'sentra_tools' &&
    eo !== 'sentra_tools_or_message' &&
    eo !== 'reply_gate_decision_tools' &&
    eo !== 'override_intent_decision_tools'
  ) return null;

  const candidate = typeof candidateOutput === 'string' ? candidateOutput : String(candidateOutput ?? '');
  if (!candidate.trim()) return null;

  const guarded =
    isToolsOnlyExpectedOutput(eo)
      ? guardAndNormalizeSentraTools(candidate)
      : isToolsOrMessageExpectedOutput(eo)
        ? guardAndNormalizeSentraToolsOrResponse(candidate)
        : guardAndNormalizeSentraMessage(candidate);
  if (guarded && guarded.ok && guarded.normalized) {
    return guarded.normalized;
  }

  const fixParams: ModelFormatFixParams = {
    expectedOutput: eo,
    candidateOutput: candidate
  };
  if (agent) fixParams.agent = agent;
  if (conversations) fixParams.conversations = conversations;
  if (typeof model === 'string') fixParams.model = model;
  if (typeof timeout === 'number') fixParams.timeout = timeout;
  if (typeof groupId === 'string') fixParams.groupId = groupId;
  if (typeof lastErrorReason === 'string') fixParams.lastErrorReason = lastErrorReason;

  const fixedByModel = await attemptModelFormatFixWithAgent(fixParams);
  if (fixedByModel && typeof fixedByModel === 'string' && fixedByModel.trim()) {
    return fixedByModel;
  }

  if (eo === 'sentra_message') {
    const repairArgs: { rawText: string; agent?: ModelFormatFixParams['agent']; model?: string } = { rawText: candidate };
    if (agent) repairArgs.agent = agent;
    if (typeof model === 'string') repairArgs.model = model;
    const fixedByRepair = await repairSentraMessageWithLLM(repairArgs);
    if (fixedByRepair && typeof fixedByRepair === 'string' && fixedByRepair.trim()) {
      return fixedByRepair;
    }
  }

  return null;
}

export async function runSentraMessageFixPipeline(args: ModelFormatFixParams = {}) {
  return await runSentraFormatFixPipeline({ ...args, expectedOutput: 'sentra_message' });
}
