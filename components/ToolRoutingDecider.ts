import { parseSentraToolsInvocations } from '../utils/protocolUtils.js';
import type { ChatMessage } from '../src/types.js';
import { buildSentraRootDirectiveFromContract } from '../utils/sentraToolsContractEngine.js';

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

export type ExecutionPathDecision = {
  path: 'skills' | 'mcp';
  reasons: string[];
  confidence: number | null;
  rawToolsXml: string;
};

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
  const args: {
    contractId: string;
    idPrefix: string;
    scope: string;
    extraFields?: Record<string, string>;
  } = {
    contractId: 'tool_router_decision',
    idPrefix: 'tool_router',
    scope
  };
  if (orig) args.extraFields = { original_root_directive: orig };
  return buildSentraRootDirectiveFromContract(args);
}

function buildExecutionPathRootDirectiveXml({ originalRootXml, scope = 'single_turn' }: ToolRoutingRootOptions = {}) {
  const orig = String(originalRootXml || '').trim();
  const args: {
    contractId: string;
    idPrefix: string;
    scope: string;
    extraFields?: Record<string, string>;
  } = {
    contractId: 'execution_path_decision',
    idPrefix: 'execution_path_router',
    scope
  };
  if (orig) args.extraFields = { original_root_directive: orig };
  return buildSentraRootDirectiveFromContract(args);
}

function normalizeExecutionPath(raw: unknown): 'skills' | 'mcp' {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'mcp' ? 'mcp' : 'skills';
}

function toConfidence(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 1) return null;
  return n;
}

function parseReasons(rawReasons: unknown, rawReasonFallback: unknown): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const clipped = text.length > 240 ? text.slice(0, 240) : text;
    out.push(clipped);
  };
  if (Array.isArray(rawReasons)) {
    for (const item of rawReasons) push(item);
  } else {
    push(rawReasons);
  }
  if (out.length === 0) {
    push(rawReasonFallback);
  }
  return out.slice(0, 6);
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
          __sentraExpectedOutput: 'sentra_tools_or_message'
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

export async function decideExecutionPath({
  chatWithRetry,
  model,
  groupId,
  baseConversations,
  userContentNoRoot,
  originalRootXml,
  timeoutMs
}: ToolRouterOptions = {}): Promise<ExecutionPathDecision | null> {
  if (typeof chatWithRetry !== 'function') return null;
  const baseConv = Array.isArray(baseConversations) ? baseConversations : [];
  const userBase = typeof userContentNoRoot === 'string' ? userContentNoRoot : '';

  const rootOptions: ToolRoutingRootOptions = {};
  if (originalRootXml !== undefined) rootOptions.originalRootXml = originalRootXml;
  const rootXml = buildExecutionPathRootDirectiveXml(rootOptions);
  const fullUserContent = userBase ? `${rootXml}\n\n${userBase}` : rootXml;
  const safeGroupId = groupId ?? '';

  let result = null;
  try {
    result = await withTimeout(
      chatWithRetry(
        [...baseConv, { role: 'user', content: fullUserContent }],
        {
          ...(model ? { model } : {}),
          __sentraExpectedOutput: 'sentra_tools'
        },
        safeGroupId
      ),
      timeoutMs
    );
  } catch {
    return null;
  }

  if (!result || !result.success) return null;

  const rawToolsXml = String(
    (result.toolsOnly && result.rawToolsXml)
      ? result.rawToolsXml
      : (typeof result.response === 'string' ? result.response : '')
  ).trim();
  if (!rawToolsXml) return null;
  const invokes = parseSentraToolsInvocations(rawToolsXml);
  if (!Array.isArray(invokes) || invokes.length === 0) return null;

  const decisionInvoke = invokes.find((x) => String(x.aiName || '').trim() === 'execution_path_decision') || invokes[0];
  const args = decisionInvoke && decisionInvoke.args && typeof decisionInvoke.args === 'object'
    ? decisionInvoke.args
    : {};
  const reasons = parseReasons(
    (args as Record<string, unknown>).reasons,
    (args as Record<string, unknown>).reason
  );

  return {
    path: normalizeExecutionPath((args as Record<string, unknown>).path),
    reasons,
    confidence: toConfidence((args as Record<string, unknown>).confidence),
    rawToolsXml
  };
}
