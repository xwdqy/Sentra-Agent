import { extractFullXMLTag } from '../utils/xmlUtils.js';

export function preprocessPlainModelOutput(raw: unknown): string {
  const input = typeof raw === 'string' ? raw : String(raw ?? '');
  let s = input;

  // 1) Strip leading <think>/<thinking>/<reasoning> blocks (and similar) only when they are at the very start.
  //    Some models output multiple consecutive think blocks; keep stripping until none remains.
  //    We intentionally do NOT remove mid-text occurrences to avoid breaking user content.
  try {
    const maxLoops = 8;
    const thinkTags = ['think', 'thinking', 'reasoning'] as const;
    for (let i = 0; i < maxLoops; i++) {
      const trimmedStart = s.replace(/^\uFEFF/, '').trimStart();
      let stripped = false;
      for (const tag of thinkTags) {
        const full = extractFullXMLTag(trimmedStart, tag);
        if (!full || !trimmedStart.startsWith(full)) continue;
        s = trimmedStart.slice(full.length);
        stripped = true;
        break;
      }
      if (!stripped) break;
    }
  } catch {}

  // 2) Strip markdown code fences around the XML when fences contain a sentra block.
  //    Handle ``` / ```xml and ~~~ variants. Only unwrap when the fenced content contains sentra-message/tools.
  try {
    const unwrapFence = (text: unknown): string | null => {
      const t = String(text || '');
      const fenceMatch = t.match(/^\s*(```+|~~~+)\s*([a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n\1\s*$/);
      if (!fenceMatch) return null;
      const inner = String(fenceMatch[3] || '').trim();
      if (!inner) return null;
      const hasSentra =
        inner.includes('<sentra-message>') ||
        inner.includes('<sentra-tools>') ||
        inner.includes('</sentra-message>') ||
        inner.includes('</sentra-tools>');
      if (!hasSentra) return null;
      return inner;
    };

    // Some models wrap additional text around fences; we only unwrap when the entire content is fenced.
    const unwrapped = unwrapFence(s);
    if (unwrapped) s = unwrapped;
  } catch {}

  // Final normalize: trim only outer whitespace.
  try {
    s = String(s).trim();
  } catch {}

  return s;
}
