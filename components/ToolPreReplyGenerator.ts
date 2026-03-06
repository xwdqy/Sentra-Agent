import { randomUUID } from 'node:crypto';
import { escapeXml } from '../utils/xmlUtils.js';
import path from 'node:path';
import SentraPromptsSDK from 'sentra-prompts';
import type { ChatMessage } from '../src/types.js';

type ToolPreReplyRootOptions = {
  judgeSummary?: string;
  toolNames?: string[];
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
  originalRootXml,
  scope = 'single_turn'
}: ToolPreReplyRootOptions = {}) {
  const summary = String(judgeSummary || '').trim();
  const tools0 = Array.isArray(toolNames) ? toolNames : [];
  const toolList = tools0
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const tools = toolList.filter((t, i) => toolList.indexOf(t) === i);

  const focusLine = tools.length ? tools.join(', ') : '';
  const orig = String(originalRootXml || '').trim();

  return [
    '<sentra-root-directive>',
    `  <id>tool_prereply_${randomUUID()}</id>`,
    '  <type>tool_prereply</type>',
    `  <scope>${scope}</scope>`,
    '  <phase>ToolPreReply</phase>',
    '  <objective>Your task is to generate a very short pre-reply only when interruption is truly necessary, so the user knows processing is in progress and what you will verify/check next. The user-facing text must not mention internal details such as tools, MCP, system prompts, protocol, or workflow. If current input is insufficient (for example image-only message with no explicit request), or the task is lightweight and does not need interruption, return an empty &lt;sentra-message&gt;&lt;/sentra-message&gt;.</objective>',
    '  <allow_tools>false</allow_tools>',
    `  <judge_reason>${escapeXml(summary)}</judge_reason>`,
    (focusLine
      ? [
        `  <focus_tools>${escapeXml(focusLine)}</focus_tools>`
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
          __sentraExpectedOutput: 'sentra_message'
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

