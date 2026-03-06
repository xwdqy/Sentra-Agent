import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');
const TARGET_FILES = new Set(['skill.md', 'skill.example.md']);

const WHEN_TO_USE_ALIASES = new Set([
  'when to use',
  'typical scenarios',
  'use cases',
  'usage scenarios',
  '使用场景',
  '适用场景',
  '何时使用',
  '什么时候用',
]);

const WHEN_NOT_TO_USE_ALIASES = new Set([
  'when not to use',
  'non-goals',
  'limitations',
  'avoid when',
  'when not to',
  '不适用场景',
  '禁止场景',
  '何时不使用',
  '什么时候不用',
  '不要使用',
  '不该使用',
  '不建议使用',
  '禁用场景',
  '禁用条件',
  '不适用条件',
]);

const DEFAULT_WHEN_TO_USE = [
  '用户目标与本工具能力直接匹配。',
  '能够提供并确认满足本工具的入参要求。',
];

const DEFAULT_WHEN_NOT_TO_USE = [
  '无法满足入参要求或参数约束时，不要调用。',
  '请求超出工具能力边界时，不要调用。',
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, out);
    else if (ent.isFile() && TARGET_FILES.has(ent.name)) out.push(abs);
  }
  return out;
}

function normalizeHeadingTitle(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (WHEN_TO_USE_ALIASES.has(key)) return 'When to use';
  if (WHEN_NOT_TO_USE_ALIASES.has(key)) return 'When not to use';
  return String(raw || '').trim();
}

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function shortDesc(desc) {
  const d = String(desc || '').replace(/\s+/g, ' ').trim();
  if (!d) return '';
  const m = d.match(/^(.*?[。；;.!?])(?:\s|$)/);
  const first = (m && m[1]) ? m[1].trim() : d;
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of list || []) {
    const s = String(item || '').trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function asTypeList(typeRaw) {
  if (Array.isArray(typeRaw)) return typeRaw.map(String);
  if (typeRaw) return [String(typeRaw)];
  return [];
}

function collectParamGroups(schema = {}) {
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const groups = [];
  const pushReqGroup = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.required) && node.required.length) {
      groups.push(node.required.map(String));
    }
  };
  pushReqGroup({ required });
  for (const key of ['anyOf', 'oneOf']) {
    const arr = Array.isArray(schema[key]) ? schema[key] : [];
    for (const node of arr) pushReqGroup(node);
  }

  const uniq = [];
  const seen = new Set();
  for (const g of groups) {
    const norm = uniqueStrings(g).sort();
    if (!norm.length) continue;
    const sig = JSON.stringify(norm);
    if (seen.has(sig)) continue;
    seen.add(sig);
    uniq.push(norm);
  }
  return uniq;
}

function formatFieldList(fields = []) {
  return fields.map((f) => `\`${f}\``).join('、');
}

function formatParamGroups(groups = []) {
  return groups.map((g) => `(${formatFieldList(g)})`).join(' 或 ');
}

function collectConstraintHints(schema = {}) {
  const props = (schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object')
    ? schema.properties
    : {};
  const hints = [];

  for (const [name, def] of Object.entries(props)) {
    if (!def || typeof def !== 'object') continue;
    if (Array.isArray(def.enum) && def.enum.length) {
      const enums = def.enum.slice(0, 8).map((v) => `\`${String(v)}\``).join(' / ');
      hints.push(`\`${name}\` 仅支持 ${enums}`);
      continue;
    }
    const t = asTypeList(def.type);
    if ((t.includes('integer') || t.includes('number'))
      && (Number.isFinite(def.minimum) || Number.isFinite(def.maximum))) {
      const min = Number.isFinite(def.minimum) ? String(def.minimum) : '-inf';
      const max = Number.isFinite(def.maximum) ? String(def.maximum) : '+inf';
      hints.push(`\`${name}\` 取值范围需在 ${min} 到 ${max}`);
      continue;
    }
    if (t.includes('array') && (Number.isFinite(def.minItems) || Number.isFinite(def.maxItems))) {
      const min = Number.isFinite(def.minItems) ? String(def.minItems) : '0';
      const max = Number.isFinite(def.maxItems) ? String(def.maxItems) : 'inf';
      hints.push(`\`${name}\` 数量范围需在 ${min} 到 ${max}`);
      continue;
    }
    if (t.includes('string') && (Number.isFinite(def.minLength) || Number.isFinite(def.maxLength))) {
      const min = Number.isFinite(def.minLength) ? String(def.minLength) : '0';
      const max = Number.isFinite(def.maxLength) ? String(def.maxLength) : 'inf';
      hints.push(`\`${name}\` 长度范围需在 ${min} 到 ${max}`);
      continue;
    }
    if (typeof def.pattern === 'string' && def.pattern.trim()) {
      hints.push(`\`${name}\` 需匹配指定格式（pattern）`);
      continue;
    }
  }

  return uniqueStrings(hints).slice(0, 3);
}

function classifyIntent(description) {
  const d = String(description || '').toLowerCase();
  const readWords = [
    '查询', '读取', '获取', '搜索', '解析', '分析', '查看',
    'query', 'read', 'get', 'search', 'parse', 'analy', 'list'
  ];
  const writeWords = [
    '发送', '设置', '修改', '删除', '移除', '禁言', '撤回', '退出', '写入', '生成', '执行',
    'send', 'set', 'update', 'modify', 'delete', 'remove', 'ban', 'recall', 'leave', 'write', 'generate', 'execute'
  ];
  const readScore = readWords.reduce((acc, w) => acc + (d.includes(w) ? 1 : 0), 0);
  const writeScore = writeWords.reduce((acc, w) => acc + (d.includes(w) ? 1 : 0), 0);
  if (writeScore > readScore) return 'write';
  if (readScore > writeScore) return 'read';
  return 'neutral';
}

function keyHintsFromProperties(schema = {}) {
  const props = (schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object')
    ? schema.properties
    : {};
  const keys = Object.keys(props);
  if (!keys.length) return { route: [], arrays: [], focus: [] };

  const route = keys.filter((k) => ['group_id', 'user_id', 'chat_type'].includes(k));
  const arrays = keys.filter((k) => {
    const t = asTypeList(props[k]?.type);
    return t.includes('array');
  });

  const priority = [
    'query', 'queries', 'keyword', 'keywords', 'prompt', 'content', 'text',
    'url', 'urls', 'repoUrl', 'repoUrls', 'path', 'paths', 'file', 'files',
    'city', 'cities', 'group_id', 'user_id'
  ];
  const focus = [];
  for (const p of priority) if (keys.includes(p)) focus.push(p);
  for (const k of keys) if (!focus.includes(k)) focus.push(k);

  return {
    route: uniqueStrings(route),
    arrays: uniqueStrings(arrays),
    focus: focus.slice(0, 4),
  };
}

function genWhenToUse({ description, schema }) {
  const bullets = [];
  const desc = shortDesc(description);
  if (desc) bullets.push(`目标与工具能力一致：${desc}`);

  const groups = collectParamGroups(schema);
  if (groups.length > 1) {
    bullets.push(`可提供以下任一入参组合：${formatParamGroups(groups)}。`);
  } else if (groups.length === 1) {
    bullets.push(`可提供必需入参：${formatFieldList(groups[0])}。`);
  } else {
    const { focus } = keyHintsFromProperties(schema);
    if (focus.length) bullets.push(`已明确关键输入字段：${formatFieldList(focus)}。`);
  }

  const { arrays, route } = keyHintsFromProperties(schema);
  if (arrays.length) bullets.push(`需要批量处理时，优先使用数组字段：${formatFieldList(arrays)}。`);
  if (route.length) bullets.push(`目标路由已明确：${formatFieldList(route)}。`);

  const intent = classifyIntent(description);
  if (intent === 'write') bullets.push('你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。');
  if (intent === 'read') bullets.push('你需要查询或解析结果，而不是执行修改类操作。');

  return uniqueStrings(bullets).slice(0, 4);
}

function genWhenNotToUse({ description, schema }) {
  const bullets = [];
  const groups = collectParamGroups(schema);
  if (groups.length > 1) {
    bullets.push(`无法满足任一入参组合时不要调用：${formatParamGroups(groups)}。`);
  } else if (groups.length === 1) {
    bullets.push(`缺少必需入参时不要调用：${formatFieldList(groups[0])}。`);
  } else {
    bullets.push('缺少关键输入且无法从上下文可靠推断时，不要调用。');
  }

  const { route } = keyHintsFromProperties(schema);
  if (route.length) bullets.push(`路由不明确时不要调用（需明确 ${formatFieldList(route)}）。`);

  const constraints = collectConstraintHints(schema);
  if (constraints.length) bullets.push(`参数不满足约束时不要调用：${constraints.join('；')}。`);

  const intent = classifyIntent(description);
  if (intent === 'write') bullets.push('仅希望查询信息、且不希望产生副作用时，不要调用。');
  if (intent === 'read') bullets.push('需要执行发送/修改/删除等动作时，不要调用。');

  const d = String(description || '').toLowerCase();
  if (d.includes('does not send messages') || d.includes('does not send')) {
    bullets.push('该工具仅返回数据，不负责直接发送消息；若目标是发消息，不要仅调用此工具。');
  }

  return uniqueStrings(bullets).slice(0, 4);
}

function parseMarkdownSections(text) {
  const lines = text.split('\n');
  const headingIdx = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (m) headingIdx.push({ index: i, title: normalizeHeadingTitle(m[1]) });
  }

  if (!headingIdx.length) {
    return {
      preface: text.trimEnd(),
      sections: [],
    };
  }

  const preface = lines.slice(0, headingIdx[0].index).join('\n').trimEnd();
  const sections = [];
  for (let i = 0; i < headingIdx.length; i++) {
    const start = headingIdx[i].index;
    const end = i + 1 < headingIdx.length ? headingIdx[i + 1].index : lines.length;
    const body = lines.slice(start + 1, end).join('\n').trim();
    sections.push({
      title: headingIdx[i].title,
      body,
    });
  }
  return { preface, sections };
}

function insertOrReplaceWhenSections(parsed, whenToUseBullets, whenNotBullets) {
  const out = [];
  let seenUse = false;
  let seenNot = false;

  for (const sec of parsed.sections) {
    const title = sec.title;
    if (title === 'When to use') {
      if (seenUse) continue;
      seenUse = true;
      out.push({ title, body: whenToUseBullets.map((b) => `- ${b}`).join('\n') });
      continue;
    }
    if (title === 'When not to use') {
      if (seenNot) continue;
      seenNot = true;
      out.push({ title, body: whenNotBullets.map((b) => `- ${b}`).join('\n') });
      continue;
    }
    out.push(sec);
  }

  const insertIdx = out.findIndex((s) => /^input$/i.test(s.title) || s.title === '输入');
  const useSection = { title: 'When to use', body: whenToUseBullets.map((b) => `- ${b}`).join('\n') };
  const notSection = { title: 'When not to use', body: whenNotBullets.map((b) => `- ${b}`).join('\n') };

  if (!seenUse && !seenNot) {
    if (insertIdx >= 0) out.splice(insertIdx, 0, useSection, notSection);
    else out.push(useSection, notSection);
  } else if (!seenUse) {
    if (insertIdx >= 0) out.splice(insertIdx, 0, useSection);
    else out.push(useSection);
  } else if (!seenNot) {
    const useIdx = out.findIndex((s) => s.title === 'When to use');
    if (useIdx >= 0) out.splice(useIdx + 1, 0, notSection);
    else if (insertIdx >= 0) out.splice(insertIdx, 0, notSection);
    else out.push(notSection);
  }

  return out;
}

function serializeMarkdown(preface, sections, eol = '\n', hadTrailingNewline = true) {
  const chunks = [];
  if (preface && preface.trim()) chunks.push(preface.trimEnd());
  for (const sec of sections) {
    const body = String(sec.body || '').trim();
    chunks.push(`## ${sec.title}${body ? `\n\n${body}` : ''}`);
  }
  let out = chunks.join('\n\n');
  if (hadTrailingNewline) out += '\n';
  if (eol !== '\n') out = out.replace(/\n/g, eol);
  return out;
}

function loadConfigForSkillFile(skillPath) {
  const pluginDir = path.dirname(skillPath);
  const cfgPath = path.join(pluginDir, 'config.json');
  if (!fs.existsSync(cfgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const files = walk(PLUGINS_DIR);
  let updated = 0;

  for (const file of files) {
    const cfg = loadConfigForSkillFile(file);
    if (!cfg || typeof cfg !== 'object') continue;
    const raw = fs.readFileSync(file, 'utf8');
    const eol = detectEol(raw);
    const hadTrailingNewline = /\r?\n$/.test(raw);
    const normalized = raw.replace(/\r\n/g, '\n');

    const schema = (cfg.inputSchema && typeof cfg.inputSchema === 'object') ? cfg.inputSchema : {};
    const description = String(cfg.description || '');
    const whenToUse = genWhenToUse({ description, schema });
    const whenNot = genWhenNotToUse({ description, schema });

    const parsed = parseMarkdownSections(normalized);
    const nextSections = insertOrReplaceWhenSections(
      parsed,
      whenToUse.length ? whenToUse : DEFAULT_WHEN_TO_USE,
      whenNot.length ? whenNot : DEFAULT_WHEN_NOT_TO_USE
    );
    const next = serializeMarkdown(parsed.preface, nextSections, eol, hadTrailingNewline);

    if (next !== raw) {
      fs.writeFileSync(file, next, 'utf8');
      updated++;
    }
  }

  console.log(`Normalized usage sections for ${updated}/${files.length} skill markdown files.`);
}

main();
