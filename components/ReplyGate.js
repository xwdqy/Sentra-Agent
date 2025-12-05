import { getEnv, getEnvBool } from '../utils/envHotReloader.js';
import { ConversationAnalyzer } from './gate/analyzer.js';

function clamp01(x) {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function isReplyGateEnabled() {
  return getEnvBool('REPLY_GATE_ENABLED', true);
}

function getBotNames() {
  try {
    const raw = getEnv('BOT_NAMES', '');
    if (!raw.trim()) return [];
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

let sharedConversationAnalyzer = null;

/**
 * 评估一条群聊消息是否值得进入 LLM 决策或直接回复。
 * 不使用本地 ML 模型，只基于分词、token 统计和结构化信号。
 *
 * 返回决策：
 * - decision = 'ignore'  : 直接判定不回复
 * - decision = 'reply'   : 直接判定需要回复（无需再走决策 LLM）
 * - decision = 'llm'     : 交给 LLM 决策（灰度区间）
 */
export function assessReplyWorth(msg, signals = {}, options = {}) {
  const scene = msg?.type || 'unknown';
  const rawText = ((msg?.text && String(msg.text)) || (msg?.summary && String(msg.summary)) || '').trim();

  if (!isReplyGateEnabled()) {
    return {
      decision: 'llm',
      score: 0,
      normalizedScore: 1,
      reason: 'reply_gate_disabled',
      debug: { scene, rawTextLength: rawText.length }
    };
  }

  const isGroup = scene === 'group';

  // 私聊的 worth 评估交给上层（目前私聊默认必回）
  if (!isGroup) {
    return {
      decision: 'llm',
      score: 0,
      reason: 'non_group_message',
      debug: { scene, rawTextLength: rawText.length }
    };
  }

  if (!rawText) {
    // 群消息没有任何文本内容：通常不值得回复
    return {
      decision: 'ignore',
      score: 0,
      normalizedScore: 0,
      reason: 'empty_text',
      debug: { scene, rawTextLength: 0 }
    };
  }

  let historyTexts = [];
  const decisionContext = options?.decisionContext || null;
  if (decisionContext && typeof decisionContext === 'object') {
    const pushTexts = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const m of arr) {
        const t = (m && typeof m.text === 'string' ? m.text.trim() : '');
        if (t) historyTexts.push(t);
      }
    };
    pushTexts(decisionContext.group_recent_messages);
    pushTexts(decisionContext.sender_recent_messages);
  }

  const analyzer = sharedConversationAnalyzer || (sharedConversationAnalyzer = new ConversationAnalyzer());
  let analysis;
  try {
    analysis = analyzer.analyze(rawText, historyTexts, { signals });
  } catch (e) {
    // 分析器异常时回退为保守：交给 LLM 决策
    return {
      decision: 'llm',
      score: 0,
      normalizedScore: 1,
      reason: 'analyzer_error',
      debug: { scene, rawTextLength: rawText.length, error: String(e) }
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

    // 当前消息：优先用上游解析好的 mentionedByAt / mentionedByName 信号
    if (signals && (signals.mentionedByAt || signals.mentionedByName)) {
      mentionCount += 1;
    } else if (rawText) {
      const textLower = rawText.toLowerCase();
      if (namesLower.some((n) => n && textLower.includes(n))) {
        mentionCount += 1;
      }
    }

    // 历史消息：最多再加 2 次
    const decisionContext = options?.decisionContext || null;
    if (decisionContext && typeof decisionContext === 'object' && mentionCount < 3) {
      const scanArr = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const m of arr) {
          if (mentionCount >= 3) break;
          const t = (m && typeof m.text === 'string' ? m.text.toLowerCase() : '');
          if (!t) continue;
          if (namesLower.some((n) => n && t.includes(n))) {
            mentionCount += 1;
            if (mentionCount >= 3) break;
          }
        }
      };
      // 先看最近的发送者，再看群整体
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

  let decision = 'llm';
  let reasonBase = '';

  if (analysis?.policy && analysis.policy.action === 'block') {
    // 合规 / 风险拦截：一律不推给 LLM
    decision = 'ignore';
    reasonBase = 'policy_blocked';
  } else {
    // 去掉每条消息的随机抽样，改为确定性决策：
    // - 概率极低时直接视为噪声，忽略
    // - 其余情况统一交给上层（会话级累积 + LLM）决策
    const veryLowThreshold = 0.02;
    if (finalProbability <= veryLowThreshold) {
      decision = 'ignore';
      reasonBase = 'below_min_threshold';
    } else {
      decision = 'llm';
      reasonBase = 'pass_to_llm';
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
