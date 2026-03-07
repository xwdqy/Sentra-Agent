import { getEnv, getEnvBool } from '../utils/envHotReloader.js';
import { ConversationAnalyzer } from './gate/analyzer.js';
import { REPLY_GATE_REASON, tReplyGate } from '../utils/i18n/replyGateCatalog.js';

type MsgLike = { type?: string; text?: string; summary?: string };
type RecentMessage = { text?: string };
type DecisionContext = {
  group_recent_messages?: RecentMessage[];
  sender_recent_messages?: RecentMessage[];
};
type ReplyGateSignals = {
  mentionedByAt?: boolean;
  mentionedByName?: boolean;
  isFollowupAfterBotReply?: boolean;
  senderReplyCountWindow?: number;
  groupReplyCountWindow?: number;
  senderFatigue?: number;
  groupFatigue?: number;
  attentionSession?: {
    consideredCount?: number;
    repliedCount?: number;
    avgAnalyzerProb?: number;
    avgGateProb?: number;
    avgFusedProb?: number;
    replyRatio?: number;
  };
  [key: string]: unknown;
};
type ReplyGateOptions = { decisionContext?: DecisionContext | null };
type AnalysisResult = ReturnType<ConversationAnalyzer['analyze']>;
type ReplyGateDecision = 'ignore' | 'llm' | 'reply';
type ReplyGateResult = {
  decision: ReplyGateDecision;
  score: number;
  normalizedScore?: number;
  reason: string;
  debug?: Record<string, unknown>;
};

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function isReplyGateEnabled() {
  return getEnvBool('REPLY_GATE_ENABLED', true);
}

function getBotNames(): string[] {
  try {
    const raw = String(getEnv('BOT_NAMES', '') ?? '');
    if (!raw.trim()) return [];
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function getReplyGateAccumBaseline() {
  const raw = parseFloat(String(getEnv('REPLY_GATE_ACCUM_BASELINE', '0.1') ?? '0.1'));
  return Number.isFinite(raw) ? raw : 0.1;
}

let sharedConversationAnalyzer: ConversationAnalyzer | null = null;

/**
 * 评估群聊消息是否值得进入 LLM 决策。
 * 基于文本与结构化信号输出 ignore/llm/reply。
 */
export function assessReplyWorth(
  msg: MsgLike | null | undefined,
  signals: ReplyGateSignals = {},
  options: ReplyGateOptions = {}
): ReplyGateResult {
  const scene = msg?.type || 'unknown';
  const rawText = String(
    msg?.text ??
    (msg as { summary_text?: unknown })?.summary_text ??
    (msg as { objective_text?: unknown })?.objective_text ??
    ''
  ).trim();

  if (!isReplyGateEnabled()) {
    return {
      decision: 'llm',
      score: 0,
      normalizedScore: 1,
      reason: REPLY_GATE_REASON.disabled,
      debug: {
        scene,
        rawTextLength: rawText.length,
        reasonText: tReplyGate(REPLY_GATE_REASON.disabled)
      }
    };
  }

  const isGroup = scene === 'group';
  if (!isGroup) {
    return {
      decision: 'llm',
      score: 0,
      reason: REPLY_GATE_REASON.nonGroupMessage,
      debug: {
        scene,
        rawTextLength: rawText.length,
        reasonText: tReplyGate(REPLY_GATE_REASON.nonGroupMessage)
      }
    };
  }

  if (!rawText) {
    return {
      decision: 'ignore',
      score: 0,
      normalizedScore: 0,
      reason: REPLY_GATE_REASON.emptyText,
      debug: {
        scene,
        rawTextLength: 0,
        reasonText: tReplyGate(REPLY_GATE_REASON.emptyText)
      }
    };
  }

  const historyTexts: string[] = [];
  const decisionContext = options.decisionContext || null;
  if (decisionContext && typeof decisionContext === 'object') {
    const pushTexts = (arr: RecentMessage[] | undefined) => {
      if (!Array.isArray(arr)) return;
      for (const m of arr) {
        const t = m && typeof m.text === 'string' ? m.text.trim() : '';
        if (t) historyTexts.push(t);
      }
    };
    pushTexts(decisionContext.group_recent_messages);
    pushTexts(decisionContext.sender_recent_messages);
  }

  const analyzer =
    sharedConversationAnalyzer ||
    (sharedConversationAnalyzer = new ConversationAnalyzer({
      debug: true
    }));

  let analysis: AnalysisResult;
  try {
    analysis = analyzer.analyze(rawText, historyTexts, { signals });
  } catch (e) {
    return {
      decision: 'llm',
      score: 0,
      normalizedScore: 1,
      reason: REPLY_GATE_REASON.analyzerError,
      debug: {
        scene,
        rawTextLength: rawText.length,
        error: String(e),
        reasonText: tReplyGate(REPLY_GATE_REASON.analyzerError)
      }
    };
  }

  const rawProb = typeof analysis?.probability === 'number' && Number.isFinite(analysis.probability)
    ? analysis.probability
    : (typeof analysis?.score === 'number' && Number.isFinite(analysis.score) ? analysis.score / 100 : 0);
  let probability = clamp01(rawProb);

  const botNames = getBotNames();
  if (botNames.length > 0 && probability > 0) {
    const namesLower = botNames.map((n) => (n || '').toLowerCase()).filter(Boolean);
    let mentionCount = 0;

    if (signals && (signals.mentionedByAt || signals.mentionedByName)) {
      mentionCount += 1;
    } else if (rawText) {
      const textLower = rawText.toLowerCase();
      if (namesLower.some((n) => n && textLower.includes(n))) {
        mentionCount += 1;
      }
    }

    if (decisionContext && typeof decisionContext === 'object' && mentionCount < 3) {
      const scanArr = (arr: RecentMessage[] | undefined) => {
        if (!Array.isArray(arr)) return;
        for (const m of arr) {
          if (mentionCount >= 3) break;
          const t = m && typeof m.text === 'string' ? m.text.toLowerCase() : '';
          if (!t) continue;
          if (namesLower.some((n) => n && t.includes(n))) {
            mentionCount += 1;
            if (mentionCount >= 3) break;
          }
        }
      };
      scanArr(decisionContext.sender_recent_messages);
      scanArr(decisionContext.group_recent_messages);
    }

    const effectiveMentions = Math.min(Math.max(mentionCount, 0), 3);
    if (effectiveMentions > 0) {
      const factor = Math.pow(1.4, effectiveMentions);
      probability = clamp01(probability * factor);
    }
  }

  const finalProbability = Math.min(probability, 0.55);

  let decision: ReplyGateDecision = 'llm';
  let reasonBase: string = REPLY_GATE_REASON.passToLlm;

  if (analysis?.policy && analysis.policy.action === 'block') {
    decision = 'ignore';
    reasonBase = REPLY_GATE_REASON.policyBlocked;
  } else {
    let veryLowThreshold = 0.02;
    if (signals.isFollowupAfterBotReply && !(signals.mentionedByAt || signals.mentionedByName)) {
      const baseline = getReplyGateAccumBaseline();
      veryLowThreshold = clamp01(Math.max(veryLowThreshold, baseline));
    }
    if (finalProbability <= veryLowThreshold) {
      decision = 'ignore';
      reasonBase = REPLY_GATE_REASON.belowMinThreshold;
    } else {
      decision = 'llm';
      reasonBase = REPLY_GATE_REASON.passToLlm;
    }
  }

  const score = typeof analysis?.score === 'number' && Number.isFinite(analysis.score)
    ? analysis.score
    : Math.round(finalProbability * 100);

  const reasons = Array.isArray(analysis?.reasons) ? analysis.reasons : [];
  const reasonSuffix = reasons.length ? reasons.join('|') : '';
  const reason = `conversation_analyzer:${reasonBase}${reasonSuffix ? `:${reasonSuffix}` : ''}`;

  return {
    decision,
    score,
    normalizedScore: finalProbability,
    reason,
    debug: {
      scene,
      rawTextLength: rawText.length,
      reasonCode: reasonBase,
      reasonText: tReplyGate(reasonBase),
      analyzer: {
        probability,
        isWorthReplying: !!analysis?.isWorthReplying,
        confidence: typeof analysis?.confidence === 'number' ? clamp01(analysis.confidence) : 1,
        reasons,
        policy: analysis?.policy || null
      }
    }
  };
}
