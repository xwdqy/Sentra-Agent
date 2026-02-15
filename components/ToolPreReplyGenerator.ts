import { randomUUID } from 'node:crypto';
import { escapeXml } from '../utils/xmlUtils.js';
import path from 'node:path';
import SentraPromptsSDK from 'sentra-prompts';
import type { ChatMessage } from '../src/types.js';

type ToolPreReplyRootOptions = {
  judgeSummary?: string;
  toolNames?: string[];
  skipToolNames?: string[];
  originalRootXml?: string;
  scope?: string;
};

type ChatWithRetryResult = {
  success?: boolean;
  response?: string | null;
  toolsOnly?: boolean;
};

type ChatWithRetryFn = (
  conversations: ChatMessage[],
  options: { model?: string; __sentraExpectedOutput?: string },
  groupId: string
) => Promise<ChatWithRetryResult>;

type ToolPreReplyOptions = {
  chatWithRetry?: ChatWithRetryFn;
  model?: string;
  groupId?: string | null;
  baseConversations?: ChatMessage[];
  userContentNoRoot?: string;
  judgeSummary?: string;
  toolNames?: string[];
  skipToolNames?: string[];
  originalRootXml?: string;
  timeoutMs?: number;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  const timeoutPromise = new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error('TOOL_PREREPLY_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeoutPromise]);
}

function buildToolPreReplyRootDirectiveXml({
  judgeSummary,
  toolNames,
  skipToolNames,
  originalRootXml,
  scope = 'single_turn'
}: ToolPreReplyRootOptions = {}) {
  const summary = String(judgeSummary || '').trim();
  const tools0 = Array.isArray(toolNames) ? toolNames : [];
  const toolList = tools0
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const tools = toolList.filter((t, i) => toolList.indexOf(t) === i);

  const skip0 = Array.isArray(skipToolNames) ? skipToolNames : [];
  const skipList = skip0
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const skipSet = new Set(skipList);

  const focusTools = tools.filter((t) => !skipSet.has(t));
  const skippableTools = tools.filter((t) => skipSet.has(t));
  const focusLine = focusTools.length ? focusTools.join(', ') : '';
  const skippableLine = skippableTools.length ? skippableTools.join(', ') : '';
  const orig = String(originalRootXml || '').trim();

  return [
    '<sentra-root-directive>',
    `  <id>tool_prereply_${randomUUID()}</id>`,
    '  <type>tool_prereply</type>',
    `  <scope>${scope}</scope>`,
    '  <phase>ToolPreReply</phase>',
    '  <objective>你的任务是：在“确实有必要打断用户”的情况下，先生成一段很短的承上启下回复，让用户感知你正在处理，并说明你下一步会优先核实/查询/分析哪些关键方向。注意：对用户可见文本中不要提及“工具/MCP/调用工具/系统提示/协议/流程”等内部细节；不要直接罗列工具名称。若当前输入信息不足（例如只有图片/表情/动画表情且没有明确诉求）、或任务非常轻量无需打断，请输出空的 <sentra-response></sentra-response> 以保持沉默。</objective>',
    '  <allow_tools>false</allow_tools>',
    `  <judge_reason>${escapeXml(summary)}</judge_reason>`,
    (focusLine
      ? [
        `  <focus_tools>${escapeXml(focusLine)}</focus_tools>`
      ].join('\n')
      : ''),
    (skippableLine
      ? [
        `  <skippable_tools>${escapeXml(skippableLine)}</skippable_tools>`
      ].join('\n')
      : ''),
    (orig
      ? [
        `  <original_root_directive>${escapeXml(orig)}</original_root_directive>`
      ].join('\n')
      : ''),
    '__SENTRA_TOOL_PREREPLY_CONSTRAINTS__',
    '</sentra-root-directive>'
  ]
    .filter((x) => x !== '')
    .join('\n');
}

const PROMPTS_CONFIG_PATH = path.resolve('./sentra-prompts/sentra.config.json');
let cachedToolPreReplyConstraintsXml: string | null = null;

async function getToolPreReplyConstraintsXml(): Promise<string> {
  try {
    if (cachedToolPreReplyConstraintsXml) return cachedToolPreReplyConstraintsXml;
    const raw = await SentraPromptsSDK(
      "{{sentra_tool_prereply_constraints}}",
      PROMPTS_CONFIG_PATH
    );
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text) {
      cachedToolPreReplyConstraintsXml = text;
      return text;
    }
  } catch {
    // ignore
  }
  return '';
}

export async function generateToolPreReply({
  chatWithRetry,
  model,
  groupId,
  baseConversations,
  userContentNoRoot,
  judgeSummary,
  toolNames,
  skipToolNames,
  originalRootXml,
  timeoutMs
}: ToolPreReplyOptions = {}): Promise<string | null> {
  if (typeof chatWithRetry !== 'function') return null;
  const baseConv = Array.isArray(baseConversations) ? baseConversations : [];
  const userBase = typeof userContentNoRoot === 'string' ? userContentNoRoot : '';

  const constraintsXml = await getToolPreReplyConstraintsXml();

  const rootOptions: ToolPreReplyRootOptions = {};
  if (judgeSummary !== undefined) rootOptions.judgeSummary = judgeSummary;
  if (toolNames !== undefined) rootOptions.toolNames = toolNames;
  if (skipToolNames !== undefined) rootOptions.skipToolNames = skipToolNames;
  if (originalRootXml !== undefined) rootOptions.originalRootXml = originalRootXml;
  const rootXmlRaw = buildToolPreReplyRootDirectiveXml(rootOptions);

  const rootXml = rootXmlRaw.replace(
    '__SENTRA_TOOL_PREREPLY_CONSTRAINTS__',
    constraintsXml || ''
  );

  const fullUserContent = userBase ? `${rootXml}\n\n${userBase}` : rootXml;

  const safeGroupId = groupId ?? '';
  let result = null;
  try {
    result = await withTimeout(
      chatWithRetry(
        [...baseConv, { role: 'user', content: fullUserContent }],
        {
          ...(model ? { model } : {}),
          __sentraExpectedOutput: 'sentra_response'
        },
        safeGroupId
      ),
      timeoutMs
    );
  } catch {
    return null;
  }

  if (!result || !result.success || !result.response || result.toolsOnly) {
    return null;
  }

  return result.response;
}
