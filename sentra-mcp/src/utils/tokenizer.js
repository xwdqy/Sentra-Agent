import { get_encoding, encoding_for_model } from 'tiktoken';

const _encCache = new Map();

function getEncoder(model) {
  const key = String(model || '').trim() || '__default__';
  const cached = _encCache.get(key);
  if (cached) return cached;

  let enc;
  try {
    if (key === '__default__' || key === 'cl100k_base') {
      enc = get_encoding('cl100k_base');
    } else {
      enc = encoding_for_model(key);
    }
  } catch {
    enc = get_encoding('cl100k_base');
  }

  _encCache.set(key, enc);
  return enc;
}

export function countTokens(text, opts = {}) {
  const s = String(text ?? '');
  const model = opts?.model;
  const enc = getEncoder(model);
  return enc.encode(s).length;
}

export function fitToTokenLimit(text, opts = {}) {
  const s = String(text ?? '');
  const maxTokens = Number(opts?.maxTokens);
  const model = opts?.model;

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return {
      text: s,
      tokens: countTokens(s, { model }),
      truncated: false,
    };
  }

  let total = countTokens(s, { model });
  if (total <= maxTokens) {
    return { text: s, tokens: total, truncated: false };
  }

  let low = 0;
  let high = s.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const cand = s.slice(0, mid);
    const t = countTokens(cand, { model });
    if (t <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const out = s.slice(0, Math.max(0, low));
  total = countTokens(out, { model });

  return {
    text: out,
    tokens: total,
    truncated: out.length !== s.length,
  };
}

export function truncateTextByTokens(text, opts = {}) {
  const raw = String(text ?? '');
  const maxTokens = Number(opts?.maxTokens);
  const model = opts?.model;
  const suffix = typeof opts?.suffix === 'string' ? opts.suffix : '';

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    const tokens = countTokens(raw, { model });
    return {
      text: raw,
      tokens,
      originalTokens: tokens,
      truncated: false,
      omittedTokens: 0,
      omittedChars: 0,
    };
  }

  const max = Math.max(1, Math.floor(maxTokens));
  const originalTokens = countTokens(raw, { model });
  if (originalTokens <= max) {
    return {
      text: raw,
      tokens: originalTokens,
      originalTokens,
      truncated: false,
      omittedTokens: 0,
      omittedChars: 0,
    };
  }

  const suffixTokens = suffix ? countTokens(suffix, { model }) : 0;
  const bodyBudget = Math.max(0, max - suffixTokens);
  let body = '';

  if (bodyBudget > 0) {
    const fitted = fitToTokenLimit(raw, { maxTokens: bodyBudget, model });
    body = fitted.text;
  }

  let out = suffix ? `${body}${suffix}` : body;
  let outTokens = countTokens(out, { model });

  if (outTokens > max) {
    const fittedAll = fitToTokenLimit(out, { maxTokens: max, model });
    out = fittedAll.text;
    outTokens = fittedAll.tokens;
  }

  return {
    text: out,
    tokens: outTokens,
    originalTokens,
    truncated: true,
    omittedTokens: Math.max(0, originalTokens - outTokens),
    omittedChars: Math.max(0, raw.length - out.length),
  };
}
