import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../src/types.js';
import { escapeXml } from '../utils/xmlUtils.js';
import { parseSentraToolsInvocations } from '../utils/protocolUtils.js';
import {
  buildSentraContractPolicyText,
  buildSentraRootDirectiveFromContract,
  getSentraContractParameterEnum,
  getSentraContractRequiredInvokeName,
  getSentraContractOutputInstruction,
} from '../utils/sentraToolsContractEngine.js';

export type RuntimeSignalAction = 'cancel' | 'supplement' | 'replan' | 'append' | 'ignore';

const RUNTIME_SIGNAL_CONTRACT_ID = 'runtime_signal_action_decision';
const RUNTIME_SIGNAL_INVOKE_NAME =
  getSentraContractRequiredInvokeName(RUNTIME_SIGNAL_CONTRACT_ID, 'runtime_signal_action_decision') ||
  'runtime_signal_action_decision';
const RUNTIME_SIGNAL_ALLOWED_ACTIONS = new Set(
  getSentraContractParameterEnum(RUNTIME_SIGNAL_CONTRACT_ID, 'action')
    .map((x) => String(x || '').trim().toLowerCase())
    .filter(Boolean)
);
const RUNTIME_SIGNAL_OUTPUT_INSTRUCTION = getSentraContractOutputInstruction(RUNTIME_SIGNAL_CONTRACT_ID);
const RUNTIME_SIGNAL_POLICY_TEXT = buildSentraContractPolicyText(RUNTIME_SIGNAL_CONTRACT_ID);

type ChatWithRetryResult = {
  success?: boolean;
  toolsOnly?: boolean;
  rawToolsXml?: string;
  response?: string | null;
};

type ChatWithRetryFn = (
  conversations: ChatMessage[],
  options: { model?: string; __sentraExpectedOutput?: string },
  groupId: string
) => Promise<ChatWithRetryResult>;

export type RuntimeSignalActionResolution = {
  action: RuntimeSignalAction;
  reason: string;
  confidence: number | null;
  rawToolsXml: string;
  repaired: boolean;
};

type ResolveRuntimeSignalActionOptions = {
  chatWithRetry?: ChatWithRetryFn;
  model?: string;
  systemPrompt?: string;
  groupId?: string | null;
  objective?: string;
  signalText: string;
  signalMeta?: string;
  timeoutMs?: number;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  const timeoutPromise = new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error('RUNTIME_SIGNAL_ACTION_RESOLVER_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeoutPromise]);
}

function normalizeAction(raw: unknown): RuntimeSignalAction {
  const s = String(raw || '').trim().toLowerCase();
  if (RUNTIME_SIGNAL_ALLOWED_ACTIONS.has(s)) {
    return s as RuntimeSignalAction;
  }
  return 'ignore';
}

function normalizeReason(raw: unknown): string {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > 240 ? s.slice(0, 240) : s;
}

function toConfidence(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 1) return null;
  return n;
}

function buildRootDirectiveXml({
  attempt,
  maxAttempts,
  previousRawOutput = ''
}: {
  attempt: number;
  maxAttempts: number;
  previousRawOutput?: string;
}): string {
  const prev = String(previousRawOutput || '').trim();
  const extraBlocks: string[] = [
    '  <attempt_meta>',
    `    <attempt>${attempt}</attempt>`,
    `    <max_attempts>${maxAttempts}</max_attempts>`,
    '  </attempt_meta>'
  ];
  if (prev) {
    extraBlocks.push(
      '  <repair_hint>',
      '    <item>Previous output failed parsing/validation; regenerate valid sentra-tools XML only.</item>',
      `    <previous_output>${escapeXml(prev)}</previous_output>`,
      '  </repair_hint>'
    );
  }
  return buildSentraRootDirectiveFromContract({
    contractId: RUNTIME_SIGNAL_CONTRACT_ID,
    idPrefix: `runtime_signal_action_resolver_${randomUUID()}`,
    scope: 'single_turn',
    phaseOverride: 'RuntimeSignalActionResolver',
    objectiveOverride: 'Decide one runtime action for the currently running task, and output sentra-tools only.',
    extraBlocks
  });
}

function buildUserInputXml({
  objective,
  signalText,
  signalMeta
}: {
  objective: string;
  signalText: string;
  signalMeta: string;
}): string {
  return [
    '<runtime-signal-input>',
    `  <objective>${escapeXml(objective || '')}</objective>`,
    `  <signal_text>${escapeXml(signalText || '')}</signal_text>`,
    `  <signal_meta>${escapeXml(signalMeta || '')}</signal_meta>`,
    '</runtime-signal-input>'
  ].join('\n');
}

function parseResolution(rawToolsXml: string): RuntimeSignalActionResolution | null {
  const raw = String(rawToolsXml || '').trim();
  if (!raw) return null;
  const invokes = parseSentraToolsInvocations(raw);
  if (!Array.isArray(invokes) || invokes.length === 0) return null;

  const invoke = invokes.find((x) => String(x.aiName || '').trim() === RUNTIME_SIGNAL_INVOKE_NAME) || invokes[0];
  const args = (invoke?.args && typeof invoke.args === 'object') ? invoke.args : {};
  const action = normalizeAction(args.action);
  const reason = normalizeReason(args.reason);
  const confidence = toConfidence(args.confidence);

  return {
    action,
    reason,
    confidence,
    rawToolsXml: raw,
    repaired: false
  };
}

export async function resolveRuntimeSignalActionByModel({
  chatWithRetry,
  model,
  systemPrompt = '',
  groupId,
  objective = '',
  signalText,
  signalMeta = '',
  timeoutMs
}: ResolveRuntimeSignalActionOptions): Promise<RuntimeSignalActionResolution | null> {
  if (typeof chatWithRetry !== 'function') return null;
  const signal = String(signalText || '').trim();
  if (!signal) return null;

  const safeGroupId = String(groupId || '');
  const maxAttempts = 2;
  let previousRaw = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const rootXml = buildRootDirectiveXml({
      attempt,
      maxAttempts,
      previousRawOutput: previousRaw
    });
    const userXml = buildUserInputXml({
      objective: String(objective || '').trim(),
      signalText: signal,
      signalMeta: String(signalMeta || '').trim()
    });
    const userContent = `${rootXml}\n\n${userXml}`;
    const conversations: ChatMessage[] = [];
    const system = String(systemPrompt || '').trim();
    const contractConstraint = [
      '<sentra-protocol>',
      RUNTIME_SIGNAL_OUTPUT_INSTRUCTION,
      RUNTIME_SIGNAL_POLICY_TEXT,
      '</sentra-protocol>'
    ].join('\n');
    const systemCombined = [system, contractConstraint].filter(Boolean).join('\n\n');
    if (systemCombined) {
      conversations.push({ role: 'system', content: systemCombined });
    }
    conversations.push({ role: 'user', content: userContent });
    let result: ChatWithRetryResult | null = null;
    try {
      result = await withTimeout(
        chatWithRetry(
          conversations,
          {
            ...(model ? { model } : {}),
            __sentraExpectedOutput: 'sentra_tools'
          },
          safeGroupId
        ),
        timeoutMs
      );
    } catch {
      result = null;
    }
    if (!result || !result.success) continue;

    const rawToolsXml = String(
      (result.toolsOnly && result.rawToolsXml)
        ? result.rawToolsXml
        : (typeof result.response === 'string' ? result.response : '')
    ).trim();
    if (!rawToolsXml) continue;

    const parsed = parseResolution(rawToolsXml);
    if (parsed) {
      return {
        ...parsed,
        repaired: attempt > 1
      };
    }
    previousRaw = rawToolsXml;
  }

  return null;
}
