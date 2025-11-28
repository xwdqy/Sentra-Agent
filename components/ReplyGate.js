import { textSegmentation } from '../src/segmentation.js';
import { tokenCounter } from '../src/token-counter.js';
import emojiRegex from 'emoji-regex';
import natural from 'natural';
import LinkifyIt from 'linkify-it';

const DEFAULT_MODEL = process.env.REPLY_DECISION_MODEL || process.env.MAIN_AI_MODEL || 'gpt-4o-mini';
const linkify = new LinkifyIt();
const EMOJI_REGEX = emojiRegex();
const WORD_CHAR_REGEX = /[\p{L}\p{N}]/u;
const PUNCT_OR_SYMBOL_REGEX = /[\p{P}\p{S}]/gu;

function clamp01(x) {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function computeTextSimilarity(a, b) {
  const s1 = (a || '').trim();
  const s2 = (b || '').trim();
  if (!s1 || !s2) return 0;
  try {
    const sim = natural.JaroWinklerDistance(s1.toLowerCase(), s2.toLowerCase());
    if (typeof sim === 'number' && Number.isFinite(sim)) {
      return sim;
    }
    return 0;
  } catch {
    return 0;
  }
}

function computeInterestScore(rawText, signals = {}, context = {}) {
  const text = (rawText || '').trim();
  if (!text) {
    return { score: 0, details: { reason: 'empty_text' } };
  }

  let score = 0;
  const details = {};
  const decisionContext = context.decisionContext || null;
  const compactText = text.replace(/\s+/g, '');
  const hasWordLikeChars = WORD_CHAR_REGEX.test(text);
  const emojiMatches = EMOJI_REGEX ? text.match(EMOJI_REGEX) || [] : [];
  const emojiCount = emojiMatches.length;
  const textWithoutEmoji = EMOJI_REGEX ? text.replace(EMOJI_REGEX, '').trim() : text.trim();
  const punctuationOnly = compactText.length > 0
    && compactText.replace(PUNCT_OR_SYMBOL_REGEX, '').length === 0
    && !hasWordLikeChars
    && emojiCount === 0;

  if (punctuationOnly && !signals.isFollowupAfterBotReply) {
    score -= 3;
    details.punctuationOnly = -3;
  }

  // 基础统计：分词 & token
  let segStats = null;
  let tokenStats = null;
  try {
    segStats = textSegmentation.getSegmentationStats(text, { useSegmentation: true });
  } catch {
    segStats = null;
  }

  try {
    tokenStats = tokenCounter.getTextStats(text, DEFAULT_MODEL);
  } catch {
    tokenStats = { tokenCount: 0, charCount: text.length, wordCount: 0 };
  }

  const tokenCount = tokenStats.tokenCount || 0;
  const charCount = tokenStats.charCount || text.length;

  // 1) 提及信号（显式 @ / 名称提及）
  if (signals.mentionedByAt) {
    score += 5;
    details.mentionByAt = 5;
  }
  if (!signals.mentionedByAt && signals.mentionedByName) {
    score += 3;
    details.mentionByName = 3;
  }

  // 2) 文本长度 & token 数
  if (tokenCount >= 8 && tokenCount <= 256) {
    score += 2;
    details.tokenRange = 2;
  } else if (tokenCount > 512) {
    score -= 2;
    details.tooLong = -2;
  } else if (tokenCount >= 3 && tokenCount < 8 && hasWordLikeChars) {
    score += 0.5;
    details.shortButMeaningful = 0.5;
  }

  // 3) 内容丰富度（基于分词统计）
  if (segStats) {
    const { segmentCount, averageSegmentLength, primaryLanguage } = segStats;
    if (segmentCount > 5) {
      score += 1;
      details.segmentCount = 1;
    }
    if (averageSegmentLength > 2 && averageSegmentLength < 20) {
      score += 0.5;
      details.avgSegmentLen = 0.5;
    }
    const segments = Array.isArray(segStats.segments) ? segStats.segments : [];
    if (segments.length > 0) {
      const normalizedTokens = segments.map((t) => String(t).trim()).filter(Boolean);
      const totalTokens = normalizedTokens.length;
      if (totalTokens > 0) {
        const uniqueTokens = new Set(normalizedTokens);
        const lexicalDiversity = uniqueTokens.size / totalTokens;
        details.lexicalDiversity = Number(lexicalDiversity.toFixed(3));
        if (totalTokens >= 5) {
          if (lexicalDiversity < 0.3) {
            score -= 1;
            details.lowLexicalDiversity = -1;
          } else if (lexicalDiversity > 0.7 && totalTokens >= 8) {
            score += 0.5;
            details.highLexicalDiversity = 0.5;
          }
        }
      }
    }
    // 单一字符重复占比很高，通常是笑声/拉长音等低信息内容
    const uniqueChars = new Set(text.split(''));
    const uniqueRatio = uniqueChars.size / Math.max(1, charCount);
    if (uniqueRatio < 0.4 && charCount >= 4) {
      score -= 1.5;
      details.lowUniqueCharRatio = -1.5;
    }
    // 标点占比很高时，通常不是需要复杂回复的消息
    if (segStats.languageBlocks && Array.isArray(segStats.languageBlocks)) {
      const punctuationLen = segStats.languageBlocks
        .filter((b) => b.language === 'punctuation')
        .reduce((sum, b) => sum + (b.text?.length || 0), 0);
      const punctRatio = punctuationLen / Math.max(1, charCount);
      if (punctRatio > 0.6 && tokenCount < 16) {
        score -= 1.5;
        details.highPunctuationRatio = -1.5;
      }
    }
    // 只有极少分词且没有任何文字信息时，才认为是低价值
    if (segmentCount <= 3 && charCount <= 8 && !hasWordLikeChars) {
      score -= 1;
      details.veryShortLowInfo = -1;
    }
  }

  if (emojiCount > 0) {
    const emojiRatio = emojiCount / Math.max(1, charCount);
    details.emojiCount = emojiCount;
    details.emojiRatio = Number.isFinite(emojiRatio) ? Number(emojiRatio.toFixed(3)) : 0;

    const emojiOnly = textWithoutEmoji.length === 0;
    if (emojiOnly && !signals.isFollowupAfterBotReply) {
      score -= 2.5;
      details.emojiOnly = -2.5;
    } else if (emojiRatio > 0.7 && tokenCount < 32) {
      score -= 1.5;
      details.highEmojiRatio = -1.5;
    } else if (emojiRatio > 0.4 && tokenCount < 32) {
      score -= 1;
      details.mediumEmojiRatio = -1;
    }
  }
  let urlMatches = [];
  try {
    urlMatches = linkify.match(text) || [];
  } catch {
    urlMatches = [];
  }
  if (urlMatches.length > 0) {
    const urlCharLen = urlMatches.reduce((sum, m) => sum + (m?.raw?.length || 0), 0);
    const urlRatio = urlCharLen / Math.max(1, charCount);
    details.urlCount = urlMatches.length;
    details.urlCharRatio = Number.isFinite(urlRatio) ? Number(urlRatio.toFixed(3)) : 0;
    const penaltyFactor = signals.isFollowupAfterBotReply ? 0.5 : 1;
    if (urlRatio > 0.8 && tokenCount < 64) {
      const delta = 2 * penaltyFactor;
      score -= delta;
      details.highUrlRatio = -delta;
    } else if (urlRatio > 0.5 && tokenCount < 64) {
      const delta = 1.5 * penaltyFactor;
      score -= delta;
      details.mediumUrlRatio = -delta;
    }
  }

  let senderMaxSimilarity = 0;
  let groupMaxSimilarity = 0;
  if (decisionContext && typeof decisionContext === 'object') {
    const { sender_recent_messages: senderRecent, group_recent_messages: groupRecent } = decisionContext;
    if (Array.isArray(senderRecent) && senderRecent.length > 0) {
      for (const m of senderRecent) {
        const prevText = (m && (m.text || '')).trim();
        if (!prevText) continue;
        const sim = computeTextSimilarity(text, prevText);
        if (sim > senderMaxSimilarity) {
          senderMaxSimilarity = sim;
        }
      }
    }
    if (Array.isArray(groupRecent) && groupRecent.length > 0) {
      for (const m of groupRecent) {
        const prevText = (m && (m.text || '')).trim();
        if (!prevText) continue;
        const sim = computeTextSimilarity(text, prevText);
        if (sim > groupMaxSimilarity) {
          groupMaxSimilarity = sim;
        }
      }
    }
  }
  if (senderMaxSimilarity > 0) {
    details.senderMaxSimilarity = Number(senderMaxSimilarity.toFixed(3));
  }
  if (groupMaxSimilarity > 0) {
    details.groupMaxSimilarity = Number(groupMaxSimilarity.toFixed(3));
  }

  if (senderMaxSimilarity >= 0.9 && tokenCount <= 32 && !signals.isFollowupAfterBotReply) {
    score -= 1.5;
    details.recentSenderDuplicate = -1.5;
  } else if (senderMaxSimilarity >= 0.8 && tokenCount <= 32 && !signals.isFollowupAfterBotReply) {
    score -= 1;
    details.recentSenderNearDuplicate = -1;
  }

  // 5) 上下文信号：follow-up、fatigue 等
  if (signals.isFollowupAfterBotReply) {
    score += 2;
    details.followup = 2;
  }

  if (typeof signals.senderFatigue === 'number') {
    const penalty = signals.senderFatigue * 3;
    score -= penalty;
    details.senderFatigue = -penalty;
  }

  if (typeof signals.groupFatigue === 'number') {
    const penalty = signals.groupFatigue * 2;
    score -= penalty;
    details.groupFatigue = -penalty;
  }

  // 近期机器人对该用户/群回复过多时，适当再减一点分
  if (typeof signals.senderReplyCountWindow === 'number' && signals.senderReplyCountWindow > 5) {
    score -= 0.5;
    details.senderReplyCount = -0.5;
  }
  if (typeof signals.groupReplyCountWindow === 'number' && signals.groupReplyCountWindow > 30) {
    score -= 0.5;
    details.groupReplyCount = -0.5;
  }

  return { score, details, tokenCount };
}

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
  const isGroup = scene === 'group';

  const rawText = ((msg?.text && String(msg.text)) || (msg?.summary && String(msg.summary)) || '').trim();

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
      reason: 'empty_text',
      debug: { scene, rawTextLength: 0 }
    };
  }

  const { score, details, tokenCount } = computeInterestScore(rawText, signals, options);

  const highThreshold = typeof options.highThreshold === 'number'
    ? options.highThreshold
    : parseFloat(process.env.REPLY_GATE_HIGH_THRESHOLD || '3');
  const lowThreshold = typeof options.lowThreshold === 'number'
    ? options.lowThreshold
    : parseFloat(process.env.REPLY_GATE_LOW_THRESHOLD || '0');

  let decision = 'llm';
  let reason = '';

  if (score <= lowThreshold) {
    decision = 'ignore';
    reason = 'low_interest_score';
  } else {
    decision = 'llm';
    reason = score >= highThreshold ? 'high_interest_score' : 'ambiguous_score_range';
  }

  // 将 score 映射到 0-1 区间，便于上层作为置信度参考
  const normalizedScore = clamp01((score - lowThreshold) / Math.max(1e-6, highThreshold - lowThreshold));

  return {
    decision,
    score,
    normalizedScore,
    reason,
    debug: {
      scene,
      rawTextLength: rawText.length,
      tokenCount,
      details
    }
  };
}
