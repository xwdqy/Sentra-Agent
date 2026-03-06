import { tokenCounter } from '../src/token-counter.js';

export type TokenTruncateOptions = {
  maxTokens: number;
  modelName?: string;
  suffix?: string;
};

export type TokenTruncateResult = {
  text: string;
  truncated: boolean;
  tokens: number;
  originalTokens: number;
  omittedTokens: number;
};

function safeCountTokens(text: string, modelName?: string): number {
  try {
    return tokenCounter.countTokens(text, modelName);
  } catch {
    return 0;
  }
}

export function countTextTokens(input: unknown, modelName?: string): number {
  return safeCountTokens(String(input ?? ''), modelName);
}

export function truncateTextByTokens(input: unknown, options: TokenTruncateOptions): TokenTruncateResult {
  const text = String(input ?? '');
  const maxTokensRaw = Number(options?.maxTokens);
  const maxTokens = Number.isFinite(maxTokensRaw) ? Math.max(1, Math.floor(maxTokensRaw)) : 0;
  const modelName = options?.modelName;
  const suffix = typeof options?.suffix === 'string' ? options.suffix : '';
  const originalTokens = safeCountTokens(text, modelName);

  if (!maxTokens || originalTokens <= maxTokens) {
    return {
      text,
      truncated: false,
      tokens: originalTokens,
      originalTokens,
      omittedTokens: 0
    };
  }

  const suffixTokens = suffix ? safeCountTokens(suffix, modelName) : 0;
  const bodyBudget = Math.max(0, maxTokens - suffixTokens);
  let left = 0;
  let right = text.length;
  let bestLength = 0;

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const candidate = text.slice(0, middle);
    const tokenCount = safeCountTokens(candidate, modelName);
    if (tokenCount <= bodyBudget) {
      bestLength = middle;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }

  let output = text.slice(0, bestLength);
  if (suffix) output += suffix;
  let outputTokens = safeCountTokens(output, modelName);
  if (outputTokens > maxTokens) {
    let trimLeft = 0;
    let trimRight = output.length;
    let trimBest = 0;
    while (trimLeft <= trimRight) {
      const middle = Math.floor((trimLeft + trimRight) / 2);
      const candidate = output.slice(0, middle);
      const tokenCount = safeCountTokens(candidate, modelName);
      if (tokenCount <= maxTokens) {
        trimBest = middle;
        trimLeft = middle + 1;
      } else {
        trimRight = middle - 1;
      }
    }
    output = output.slice(0, trimBest);
    outputTokens = safeCountTokens(output, modelName);
  }

  return {
    text: output,
    truncated: true,
    tokens: outputTokens,
    originalTokens,
    omittedTokens: Math.max(0, originalTokens - outputTokens)
  };
}
