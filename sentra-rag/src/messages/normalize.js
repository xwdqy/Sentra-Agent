function extractTextFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;

  // Some clients may pass {text: '...'} or {content: '...'}.
  if (typeof content === 'object' && !Array.isArray(content)) {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }

  // OpenAI-style multi-part content: [{type:'text', text:'...'}, ...]
  // Also tolerate arrays containing plain strings.
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const part of content) {
    if (part == null) continue;
    if (typeof part === 'string') {
      if (part.trim()) parts.push(part);
      continue;
    }
    if (typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.trim()) parts.push(part.text);
      continue;
    }
    if (typeof part.text === 'string' && part.text.trim()) {
      parts.push(part.text);
      continue;
    }
    if (typeof part.content === 'string' && part.content.trim()) {
      parts.push(part.content);
      continue;
    }
  }
  return parts.join('\n');
}

export function normalizeMessagesToText(messages) {
  if (!Array.isArray(messages)) {
    return { queryText: '', contextText: '' };
  }

  const userTexts = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    const text = extractTextFromContent(m.content);
    if (role === 'user' && text) userTexts.push(text);
  }

  const queryText = userTexts.length ? userTexts[userTexts.length - 1] : '';
  const contextText = userTexts.slice(Math.max(0, userTexts.length - 3), Math.max(0, userTexts.length - 1)).join('\n');

  return { queryText, contextText };
}
