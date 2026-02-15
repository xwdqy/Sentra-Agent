import { createLogger } from './logger.js';
import { randomUUID } from 'node:crypto';
import { extractAllFullXMLTags, tryParseXmlFragment, escapeXml } from './xmlUtils.js';
import { getEnvBool } from './envHotReloader.js';
import { repairSentraResponse } from './formatRepair.js';
import type { ExpectedOutput, GuardResult, ModelFormatFixParams, ChatMessage } from '../src/types.js';

const logger = createLogger('ResponseFormatGuard');

function extractFirstFullTag(text: unknown, tagName: string): string | null {
  const s = typeof text === 'string' ? text : '';
  if (!s.trim()) return null;
  const blocks = extractAllFullXMLTags(s, tagName);
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  return String(blocks[0] || '').trim() || null;
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
    return { ok: false, normalized: null, changed: false, reason: '响应为空' };
  }

  const only = extractOnlySentraToolsBlock(trimmed);
  if (only && !only.includes('<sentra-response')) {
    return { ok: true, normalized: only, changed: only !== trimmed };
  }

  // Try to extract the first full <sentra-tools> block.
  const first = extractFirstFullTag(trimmed, 'sentra-tools');
  if (first) {
    try {
      logger.warn('检测到 sentra-tools 外存在额外内容，已本地截取第一段 sentra-tools 放行');
    } catch { }
    return { ok: true, normalized: first, changed: true, reason: 'trim_to_first_sentra_tools' };
  }

  return {
    ok: false,
    normalized: null,
    changed: false,
    reason: '缺少或无法解析 <sentra-tools> 标签'
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
    return { ok: false, normalized: null, changed: false, reason: '响应为空' };
  }

  const toolsOnly = extractOnlySentraToolsBlock(trimmed);
  if (toolsOnly && !toolsOnly.includes('<sentra-response')) {
    return { ok: true, normalized: toolsOnly, changed: false };
  }

  const guardedResp = guardAndNormalizeSentraResponse(trimmed, { enabled: true });
  if (guardedResp && guardedResp.ok && guardedResp.normalized) {
    return guardedResp;
  }

  // Prefer tools block as fallback.
  const firstTools = extractFirstFullTag(trimmed, 'sentra-tools');
  if (firstTools) {
    try {
      logger.warn('tools_or_response: 已本地截取第一段 sentra-tools 放行');
    } catch { }
    return { ok: true, normalized: firstTools, changed: true, reason: 'trim_to_first_sentra_tools' };
  }

  return {
    ok: false,
    normalized: null,
    changed: false,
    reason: '缺少或无法解析 <sentra-tools>/<sentra-response> 标签'
  };
}

function isLikelySentraResponseBlock(xml: unknown): boolean {
  if (!xml || typeof xml !== 'string') return false;
  if (!xml.includes('<sentra-response')) return false;
  if (!xml.includes('</sentra-response>')) return false;
  const parsed = tryParseXmlFragment(xml, 'root');
  if (!parsed || typeof parsed !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(parsed, 'sentra-response');
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

export function guardAndNormalizeSentraResponse(rawResponse: unknown, opts: { enabled?: boolean } = {}): GuardResult {
  const enabled = opts.enabled ?? getEnvBool('ENABLE_LOCAL_FORMAT_GUARD', true);
  if (!enabled) {
    const response = typeof rawResponse === 'string' ? rawResponse : String(rawResponse ?? '');
    return { ok: true, normalized: response, changed: false };
  }

  const response = typeof rawResponse === 'string' ? rawResponse : String(rawResponse ?? '');
  const trimmed = response.trim();
  if (!trimmed) {
    return { ok: false, normalized: null, changed: false, reason: '响应为空' };
  }

  // If already a pure block, keep it.
  if (trimmed.startsWith('<sentra-response') && trimmed.endsWith('</sentra-response>') && isLikelySentraResponseBlock(trimmed)) {
    return { ok: true, normalized: trimmed, changed: false };
  }

  // Prefer: extract the first full <sentra-response>...</sentra-response> block and drop the rest.
  const first = extractFirstFullTag(trimmed, 'sentra-response');
  if (first && isLikelySentraResponseBlock(first)) {
    try {
      logger.warn('检测到 sentra-response 外存在额外内容，已本地截取第一段 sentra-response 放行');
    } catch { }
    return { ok: true, normalized: first, changed: true, reason: 'trim_to_first_sentra_response' };
  }

  return {
    ok: false,
    normalized: null,
    changed: false,
    reason: '缺少或无法解析 <sentra-response> 标签'
  };
}

export function shouldAttemptModelFormatFix({ expectedOutput, lastErrorReason, alreadyTried }: {
  expectedOutput?: ExpectedOutput;
  lastErrorReason?: string;
  alreadyTried?: boolean;
} = {}): boolean {
  if (alreadyTried) return false;
  const enabled = getEnvBool('ENABLE_MODEL_FORMAT_FIX', true);
  if (!enabled) return false;
  const eo = String(expectedOutput || 'sentra_response');
  if (eo !== 'sentra_response' && eo !== 'sentra_tools' && eo !== 'sentra_tools_or_response') return false;
  const reason = String(lastErrorReason || '').trim();
  if (!reason) return true;
  return true;
}

export function buildSentraResponseFormatFixRootDirectiveXml({
  lastErrorReason,
  candidateOutput,
  scope = 'single_turn'
}: {
  lastErrorReason?: string | undefined;
  candidateOutput?: string | undefined;
  scope?: string | undefined;
} = {}) {
  const reason = String(lastErrorReason || '').trim();
  const candidate = String(candidateOutput || '').trim();
  return [
    '<sentra-root-directive>',
    `  <id>format_fix_${randomUUID()}</id>`,
    '  <type>format_fix</type>',
    `  <scope>${scope}</scope>`,
    '  <phase>FormatFix</phase>',
    '  <objective>你的任务是：修复 candidate_output 的格式，使其符合 Sentra 协议。你必须保留原意与资源信息（如有），但最终输出必须严格合规。</objective>',
    '  <allow_tools>false</allow_tools>',
    (reason
      ? `  <last_error>${escapeXml(reason)}</last_error>`
      : ''),
    (candidate
      ? [
        '  <candidate_output>',
        `    ${escapeXml(candidate)}`,
        '  </candidate_output>'
      ].join('\n')
      : ''),
    '  <constraints>',
    '    <item>你必须且只能输出一个顶层块：<sentra-response>...</sentra-response>；除此之外不要输出任何字符、解释、前后缀。</item>',
    '    <item>禁止输出 <sentra-tools>、<sentra-result>、<sentra-user-question> 等任何只读标签。</item>',
    '    <item>如果 candidate_output 缺少必需字段，请以最小改动补齐：至少包含一个非空 <text1>，并包含 <resources></resources>（若无资源）。</item>',
    '  </constraints>',
    '</sentra-root-directive>'
  ]
    .filter((x) => x !== '')
    .join('\n');
}

export function buildSentraToolsFormatFixRootDirectiveXml({
  lastErrorReason,
  candidateOutput,
  scope = 'single_turn'
}: {
  lastErrorReason?: string | undefined;
  candidateOutput?: string | undefined;
  scope?: string | undefined;
} = {}) {
  const reason = String(lastErrorReason || '').trim();
  const candidate = String(candidateOutput || '').trim();
  return [
    '<sentra-root-directive>',
    `  <id>format_fix_${randomUUID()}</id>`,
    '  <type>format_fix</type>',
    `  <scope>${scope}</scope>`,
    '  <phase>FormatFix</phase>',
    '  <objective>你的任务是：修复 candidate_output 的格式，使其符合 Sentra 协议。你必须保留原意与参数信息（如有），但最终输出必须严格合规。</objective>',
    '  <allow_tools>true</allow_tools>',
    (reason ? `  <last_error>${escapeXml(reason)}</last_error>` : ''),
    (candidate
      ? [
        '  <candidate_output>',
        `    ${escapeXml(candidate)}`,
        '  </candidate_output>'
      ].join('\n')
      : ''),
    '  <constraints>',
    '    <item>你必须且只能输出一个顶层块：<sentra-tools>...</sentra-tools>；除此之外不要输出任何字符、解释、前后缀。</item>',
    '    <item>禁止输出 <sentra-response>、<sentra-result>、<sentra-user-question> 等任何只读或用户可见标签。</item>',
    '    <item><sentra-tools> 内必须是合法 XML，只能包含 <invoke name="..."> 与其子 <parameter name="...">...。</item>',
    '  </constraints>',
    '</sentra-root-directive>'
  ]
    .filter((x) => x !== '')
    .join('\n');
}

export function buildSentraToolsOrResponseFormatFixRootDirectiveXml({
  lastErrorReason,
  candidateOutput,
  scope = 'single_turn'
}: {
  lastErrorReason?: string | undefined;
  candidateOutput?: string | undefined;
  scope?: string | undefined;
} = {}) {
  const reason = String(lastErrorReason || '').trim();
  const candidate = String(candidateOutput || '').trim();
  return [
    '<sentra-root-directive>',
    `  <id>format_fix_${randomUUID()}</id>`,
    '  <type>format_fix</type>',
    `  <scope>${scope}</scope>`,
    '  <phase>FormatFix</phase>',
    '  <objective>你的任务是：修复 candidate_output 的格式，使其符合 Sentra 协议。你必须保留原意，但最终输出必须严格合规。</objective>',
    '  <allow_tools>true</allow_tools>',
    (reason ? `  <last_error>${escapeXml(reason)}</last_error>` : ''),
    (candidate
      ? [
        '  <candidate_output>',
        `    ${escapeXml(candidate)}`,
        '  </candidate_output>'
      ].join('\n')
      : ''),
    '  <constraints>',
    '    <item>你必须且只能输出一个顶层块，除此之外不能输出任何额外文本。</item>',
    '    <item>本轮必须且只能输出二选一：<sentra-tools>...</sentra-tools> 或 <sentra-response>...</sentra-response>。</item>',
    '    <item>若输出 <sentra-tools>：禁止输出 <sentra-response>/<sentra-result>/<sentra-user-question>。</item>',
    '    <item>若输出 <sentra-response>：禁止输出 <sentra-tools>/<sentra-result>/<sentra-user-question>。</item>',
    '  </constraints>',
    '</sentra-root-directive>'
  ]
    .filter((x) => x !== '')
    .join('\n');
}

export async function attemptModelFormatFixWithAgent({
  agent,
  conversations,
  model,
  timeout,
  groupId,
  expectedOutput = 'sentra_response',
  lastErrorReason,
  candidateOutput
}: ModelFormatFixParams = {}) {
  if (!agent || typeof agent.chat !== 'function') return null;
  const conv = Array.isArray(conversations) ? conversations : [];
  const eo = String(expectedOutput || 'sentra_response');
  const fixArgs: { lastErrorReason?: string; candidateOutput?: string; scope?: string } = { scope: 'single_turn' };
  if (typeof lastErrorReason === 'string') fixArgs.lastErrorReason = lastErrorReason;
  if (typeof candidateOutput === 'string') fixArgs.candidateOutput = candidateOutput;
  const rootXml =
    eo === 'sentra_tools'
      ? buildSentraToolsFormatFixRootDirectiveXml(fixArgs)
      : eo === 'sentra_tools_or_response'
        ? buildSentraToolsOrResponseFormatFixRootDirectiveXml(fixArgs)
        : buildSentraResponseFormatFixRootDirectiveXml(fixArgs);

  // 复用原上下文，追加一次“格式修复 root 指令”作为 user turn
  const fixConversations: ChatMessage[] = [...conv, { role: 'user', content: rootXml }];

  let out;
  try {
    out = await agent.chat(fixConversations, {
      model,
      temperature: 0.2,
      maxTokens: 600,
      timeout
    });
  } catch (e) {
    try {
      logger.warn(`[${groupId || 'format_fix'}] 模型格式修复调用失败`, { err: String(e) });
    } catch { }
    return null;
  }

  const raw = typeof out === 'string' ? out : String(out ?? '');
  const guarded =
    eo === 'sentra_tools'
      ? guardAndNormalizeSentraTools(raw)
      : eo === 'sentra_tools_or_response'
        ? guardAndNormalizeSentraToolsOrResponse(raw)
        : guardAndNormalizeSentraResponse(raw);
  if (guarded && guarded.ok && guarded.normalized) return guarded.normalized;
  return null;
}

export async function repairSentraResponseWithLLM({ rawText, agent, model }: {
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
    const guarded = guardAndNormalizeSentraResponse(fixed);
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
  expectedOutput = 'sentra_response',
  lastErrorReason,
  candidateOutput
}: ModelFormatFixParams = {}) {
  const eo = String(expectedOutput || 'sentra_response');
  if (eo !== 'sentra_response' && eo !== 'sentra_tools' && eo !== 'sentra_tools_or_response') return null;
  const candidate = typeof candidateOutput === 'string' ? candidateOutput : String(candidateOutput ?? '');
  if (!candidate.trim()) return null;

  // 1) local guard (extract first block)
  const guarded =
    eo === 'sentra_tools'
      ? guardAndNormalizeSentraTools(candidate)
      : eo === 'sentra_tools_or_response'
        ? guardAndNormalizeSentraToolsOrResponse(candidate)
        : guardAndNormalizeSentraResponse(candidate);
  if (guarded && guarded.ok && guarded.normalized) {
    return guarded.normalized;
  }

  // 2) model format_fix (root directive)
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

  // 3) LLM repair tool (sentra_response only)
  if (eo === 'sentra_response') {
    const repairArgs: { rawText: string; agent?: ModelFormatFixParams['agent']; model?: string } = { rawText: candidate };
    if (agent) repairArgs.agent = agent;
    if (typeof model === 'string') repairArgs.model = model;
    const fixedByRepair = await repairSentraResponseWithLLM(repairArgs);
    if (fixedByRepair && typeof fixedByRepair === 'string' && fixedByRepair.trim()) {
      return fixedByRepair;
    }
  }

  return null;
}

export async function runSentraResponseFixPipeline(args: ModelFormatFixParams = {}) {
  return await runSentraFormatFixPipeline({ ...args, expectedOutput: 'sentra_response' });
}
