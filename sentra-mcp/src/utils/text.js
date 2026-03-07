import { truncateTextByTokens } from './tokenizer.js';

// Generic token-based preview clip helper for logs and context snippets.
export function clip(v, max = 256) {
  let s = '';
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  const result = truncateTextByTokens(s, {
    maxTokens: max,
    suffix: '\n...[truncated]'
  });
  return result.text;
}

export default { clip };