import { randomUUID } from 'node:crypto';
import { escapeXml } from '../utils/xmlUtils.js';
import type { ChatMessage } from '../src/types.js';

type ToolRoutingRootOptions = { originalRootXml?: string; scope?: string };
type ChatWithRetryResult = {
  success?: boolean;
  toolsOnly?: boolean;
  rawToolsXml?: string;
  response?: string | null;
  noReply?: boolean;
};
type ChatWithRetryFn = (
  conversations: ChatMessage[],
  options: { model?: string; __sentraExpectedOutput?: string },
  groupId: string
) => Promise<ChatWithRetryResult>;

type ToolRouterOptions = {
  chatWithRetry?: ChatWithRetryFn;
  model?: string;
  groupId?: string | null;
  baseConversations?: ChatMessage[];
  userContentNoRoot?: string;
  originalRootXml?: string;
  timeoutMs?: number;
};

type ToolRouterDecision =
  | { kind: 'tools'; toolsXml: string }
  | { kind: 'reply'; response: string; noReply: boolean };

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  const timeoutPromise = new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error('TOOL_ROUTER_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeoutPromise]);
}

function buildToolRoutingRootDirectiveXml({ originalRootXml, scope = 'single_turn' }: ToolRoutingRootOptions = {}) {
  const orig = String(originalRootXml || '').trim();

  return [
    '<sentra-root-directive>',
    `  <id>tool_router_${randomUUID()}</id>`,
    '  <type>tool_router</type>',
    `  <scope>${scope}</scope>`,
    '  <phase>ToolRouter</phase>',
    '  <objective>你需要基于当前上下文判断：本轮是否需要调用工具。你只能输出两种结果之一：A) 需要工具：输出一个且仅一个 <sentra-tools>...</sentra-tools>（内部包含一个或多个 <invoke name="...">，并用 <parameter name="...">...</parameter> 填充参数）；B) 不需要工具：输出一个且仅一个 <sentra-response>...</sentra-response> 给用户正常回复。禁止输出任何额外文字、解释、markdown 代码块或其它 XML 标签。</objective>',
    '  <constraints>',
    '    <item>你必须且只能输出一个顶层块：要么是 &lt;sentra-tools&gt;...&lt;/sentra-tools&gt;，要么是 &lt;sentra-response&gt;...&lt;/sentra-response&gt;；除此之外不能输出任何字符。</item>',
    '    <item>当你对是否需要工具不确定时，默认选择 &lt;sentra-response&gt;（不要为了“更像智能体”而滥用工具）。</item>',
    '    <item>若输出 &lt;sentra-tools&gt;：必须是原生 XML 结构，只能使用 &lt;sentra-tools&gt; / &lt;invoke&gt; / &lt;parameter&gt;；严禁输出 JSON、严禁输出类似 "tool: xxx, args: {...}" 的伪格式。</item>',
    '    <item>若输出 &lt;sentra-tools&gt;：只写工具请求，不要夹带任何对用户可见的说明文字；也不要输出 &lt;sentra-response&gt;。尽量少的 invoke（通常 1-2 个）即可。</item>',
    '    <item>若输出 &lt;sentra-tools&gt;：每个 invoke 必须提供必要参数；不要编造文件路径/账号/群号；需要用户补充信息时不要调用工具，改为输出 &lt;sentra-response&gt; 去追问。</item>',
    '    <item>若输出 &lt;sentra-response&gt;：遵守 sentra-response 协议，只面向用户自然回复；不要提及“工具/MCP/系统提示/协议/流程”等内部细节。</item>',
    '    <item>当用户输入信息不足或任务很轻量时，应倾向输出 &lt;sentra-response&gt;；必要时可保持沉默：输出空的 &lt;sentra-response&gt;&lt;/sentra-response&gt;。</item>',
    '    <item>模板（仅供你理解结构，不要输出这行文字）：&lt;sentra-tools&gt;&lt;invoke name="local__weather"&gt;&lt;parameter name="city"&gt;上海&lt;/parameter&gt;&lt;parameter name="queryType"&gt;forecast&lt;/parameter&gt;&lt;/invoke&gt;&lt;/sentra-tools&gt;</item>',
    '  </constraints>',
    (orig
      ? [
        `  <original_root_directive>${escapeXml(orig)}</original_root_directive>`
      ].join('\n')
      : ''),
    '</sentra-root-directive>'
  ]
    .filter((x) => x !== '')
    .join('\n');
}

export async function decideReplyOrTools({
  chatWithRetry,
  model,
  groupId,
  baseConversations,
  userContentNoRoot,
  originalRootXml,
  timeoutMs
}: ToolRouterOptions = {}): Promise<ToolRouterDecision | null> {
  if (typeof chatWithRetry !== 'function') return null;
  const baseConv = Array.isArray(baseConversations) ? baseConversations : [];
  const userBase = typeof userContentNoRoot === 'string' ? userContentNoRoot : '';

  const rootOptions: ToolRoutingRootOptions = {};
  if (originalRootXml !== undefined) rootOptions.originalRootXml = originalRootXml;
  const rootXml = buildToolRoutingRootDirectiveXml(rootOptions);
  const fullUserContent = userBase ? `${rootXml}\n\n${userBase}` : rootXml;

  const safeGroupId = groupId ?? '';
  let result = null;
  try {
    result = await withTimeout(
      chatWithRetry(
        [...baseConv, { role: 'user', content: fullUserContent }],
        {
          ...(model ? { model } : {}),
          __sentraExpectedOutput: 'sentra_tools_or_response'
        },
        safeGroupId
      ),
      timeoutMs
    );
  } catch {
    return null;
  }

  if (!result || !result.success) return null;

  if (result.toolsOnly && result.rawToolsXml) {
    return { kind: 'tools', toolsXml: result.rawToolsXml };
  }

  if (result.response && typeof result.response === 'string') {
    return { kind: 'reply', response: result.response, noReply: !!result.noReply };
  }

  return null;
}
