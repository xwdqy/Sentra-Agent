import sentimentZh from 'sentiment-zh_cn_web';
import emojiRegex from 'emoji-regex';
import { getEnvInt } from './envHotReloader.js';

const lastAnalyzeAt = new Map();

export function shouldAnalyzeEmotion(text, userid) {
  const content = (text || '').trim();
  if (!content) return false;

  const minLen = getEnvInt('EMO_ANALYZE_MIN_LEN', 3);
  if (minLen > 0 && content.length < minLen) return false;

  let score = 0;
  let comparative = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let tokenCount = 0;
  try {
    const res = sentimentZh(content);
    if (res && typeof res.score === 'number' && Number.isFinite(res.score)) {
      score = res.score;
    }
    if (res && typeof res.comparative === 'number' && Number.isFinite(res.comparative)) {
      comparative = res.comparative;
    }
    if (res && Array.isArray(res.positive)) {
      positiveCount = res.positive.length;
    }
    if (res && Array.isArray(res.negative)) {
      negativeCount = res.negative.length;
    }
    if (res && Array.isArray(res.tokens)) {
      tokenCount = res.tokens.length;
    }
  } catch {}

  const absScore = Math.abs(score);
  const minAbsScore = getEnvInt('EMO_ANALYZE_MIN_ABS_SCORE', 4);
  const strongScore = minAbsScore > 0 && absScore >= minAbsScore;

  const emoTokenCount = positiveCount + negativeCount;
  const hasEnoughEmoTokens = emoTokenCount >= 2;
  let emoDensity = 0;
  if (tokenCount > 0 && emoTokenCount > 0) {
    emoDensity = emoTokenCount / tokenCount;
  }

  const moderatelyEmotional = absScore >= 2 && absScore < minAbsScore;
  const denseEmoWords = hasEnoughEmoTokens && emoDensity >= 0.3;
  const lexicalStrong = strongScore || (moderatelyEmotional && denseEmoWords);

  let hasEmoji = false;
  try {
    const re = emojiRegex();
    hasEmoji = re.test(content);
  } catch {}

  const strongPunct = /[!！?？]{2,}/.test(content);

  if (!lexicalStrong && !hasEmoji && !strongPunct) {
    return false;
  }

  if (!userid) {
    return true;
  }

  const intervalMs = getEnvInt('EMO_ANALYZE_MIN_INTERVAL_MS', 10000);
  if (intervalMs > 0) {
    const now = Date.now();
    const last = lastAnalyzeAt.get(userid) || 0;
    if (now - last < intervalMs) return false;
    lastAnalyzeAt.set(userid, now);
  }

  return true;
}
