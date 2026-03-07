import fs from 'node:fs';
import path from 'node:path';
import MarkdownIt from 'markdown-it';

const skillMdParser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

const WHEN_TO_USE_TITLES = new Set([
  'when to use',
  'when-to-use',
  'typical scenarios',
  'use cases',
  'usage scenarios',
  '\u4f7f\u7528\u573a\u666f',
  '\u9002\u7528\u573a\u666f',
  '\u4f55\u65f6\u4f7f\u7528',
  '\u4ec0\u4e48\u65f6\u5019\u7528',
]);

const WHEN_NOT_TO_USE_TITLES = new Set([
  'when not to use',
  'when-not-to-use',
  'non-goals',
  'limitations',
  'avoid when',
  '\u4e0d\u9002\u7528\u573a\u666f',
  '\u4f55\u65f6\u4e0d\u4f7f\u7528',
  '\u4ec0\u4e48\u65f6\u5019\u4e0d\u7528',
  '\u4e0d\u8981\u4f7f\u7528',
]);

const SUCCESS_CRITERIA_TITLES = new Set([
  'success criteria',
  'success-criteria',
  'acceptance criteria',
  'definition of done',
  'done criteria',
  '\u9a8c\u6536\u6807\u51c6',
  '\u6210\u529f\u6761\u4ef6',
  '\u5b8c\u6210\u6807\u51c6',
]);

function normalizeHeading(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeHintLine(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*+\u2022]\s*/, '')
    .trim();
}

function stripBom(s) {
  if (!s) return '';
  const str = String(s);
  return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

export function extractUsageHints(raw) {
  try {
    const text = stripBom(String(raw ?? ''));
    const tokens = skillMdParser.parse(text, {});
    const out = { whenToUse: [], whenNotToUse: [], successCriteria: [] };
    let section = '';
    let inParagraph = false;
    let inListItem = false;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t) continue;

      if (t.type === 'heading_open') {
        const headingText = normalizeHeading(tokens[i + 1]?.content || '');
        if (WHEN_TO_USE_TITLES.has(headingText)) {
          section = 'whenToUse';
        } else if (WHEN_NOT_TO_USE_TITLES.has(headingText)) {
          section = 'whenNotToUse';
        } else if (SUCCESS_CRITERIA_TITLES.has(headingText)) {
          section = 'successCriteria';
        } else {
          section = '';
        }
        inParagraph = false;
        inListItem = false;
        continue;
      }

      if (!section) continue;

      if (t.type === 'paragraph_open') {
        inParagraph = true;
        continue;
      }
      if (t.type === 'paragraph_close') {
        inParagraph = false;
        continue;
      }
      if (t.type === 'list_item_open') {
        inListItem = true;
        continue;
      }
      if (t.type === 'list_item_close') {
        inListItem = false;
        continue;
      }
      if (t.type !== 'inline') continue;
      if (!inParagraph && !inListItem) continue;

      const line = normalizeHintLine(t.content);
      if (!line) continue;
      const arr = out[section];
      if (!arr.includes(line)) arr.push(line);
    }

    return {
      whenToUse: out.whenToUse.slice(0, 4),
      whenNotToUse: out.whenNotToUse.slice(0, 4),
      successCriteria: out.successCriteria.slice(0, 10),
    };
  } catch {
    return { whenToUse: [], whenNotToUse: [], successCriteria: [] };
  }
}

/**
 * Parse skill Markdown.
 *
 * NOTE: We intentionally do NOT support YAML frontmatter anymore.
 * skill.md should be plain Markdown.
 * Returns { attributes: object, body: string, raw: string }
 */
export function parseSkillMarkdown(raw) {
  const text = stripBom(String(raw ?? ''));
  const usageHints = extractUsageHints(text);
  return {
    attributes: {},
    body: text,
    raw: text,
    whenToUse: usageHints.whenToUse,
    whenNotToUse: usageHints.whenNotToUse,
    successCriteria: usageHints.successCriteria,
  };
}

export function buildDefaultSkillMarkdown({ toolName = '' } = {}) {
  const name = String(toolName || '').trim() || 'plugin';
  return `# ${name}

## Capability

- Describe what this tool can do in one sentence.

## Real-world impact

- Unknown/depends on implementation; be conservative and verify inputs carefully.

## When to use

- Use when the user explicitly requests this capability and the required inputs can be extracted from context or asked via a follow-up question.

## When not to use

- Do not use when inputs are missing and cannot be reliably inferred. Ask a follow-up question instead.
- Do not fabricate IDs, paths, URLs, tokens, or example values.

## Success Criteria

- Success should be decided from real execution evidence in the tool result payload.
- status should indicate success (success=true and success code when provided).
- Define plugin-specific output evidence fields that must be present and non-empty.
- Define retry guidance for transient failures, arg/schema failures, and tool-side failures.

## Input

- Required fields:
  - See tool schema

- Prefer batch/array fields when the schema provides both singular and plural versions (e.g., query/queries, file/files, keyword/keywords).
- Prefer real values extracted from conversation history or prior tool results; do not use placeholders.

## Output

- The tool returns structured data. If it produces local files, paths must be absolute paths.

## Failure modes

- If execution fails, explain the reason and provide actionable next steps (e.g., correct inputs, retry later, narrow scope).
`;
}

function safeReadFileSync(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

export function readSkillDocFromPluginDir(pluginAbsDir) {
  const abs = String(pluginAbsDir || '');
  if (!abs) return null;
  const skillPath = path.join(abs, 'skill.md');
  const skillExamplePath = path.join(abs, 'skill.example.md');
  const rawSkill = safeReadFileSync(skillPath);
  const rawExample = rawSkill ? null : safeReadFileSync(skillExamplePath);

  const toolName = (() => {
    try {
      return path.basename(abs);
    } catch {
      return '';
    }
  })();

  const rawText = rawSkill || rawExample || buildDefaultSkillMarkdown({ toolName });
  const parsed = parseSkillMarkdown(rawText);
  const sourcePath = rawSkill ? skillPath : (rawExample ? skillExamplePath : skillPath);
  const defaultSource = rawSkill ? undefined : (rawExample ? 'example' : 'generated');
  return {
    path: sourcePath,
    format: 'md',
    raw: parsed.raw,
    attributes: parsed.attributes,
    body: parsed.body,
    whenToUse: Array.isArray(parsed.whenToUse) ? parsed.whenToUse : [],
    whenNotToUse: Array.isArray(parsed.whenNotToUse) ? parsed.whenNotToUse : [],
    successCriteria: Array.isArray(parsed.successCriteria) ? parsed.successCriteria : [],
    updatedAt: (() => {
      try {
        if (rawSkill) {
          const st = fs.statSync(skillPath);
          return st.mtimeMs;
        }
        if (rawExample) {
          const st = fs.statSync(skillExamplePath);
          return st.mtimeMs;
        }
        return 0;
      } catch {
        return 0;
      }
    })(),
    isDefault: !rawSkill,
    defaultSource,
  };
}

export function toXmlCData(text) {
  const s = String(text ?? '');
  return s.replace(/]]>/g, ']]]]><![CDATA[>');
}
