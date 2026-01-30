import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../logger/index.js';

function parseScalar(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((x) => String(x).trim())
      .filter(Boolean)
      .map((x) => {
        const y = x.replace(/^['"]|['"]$/g, '').trim();
        return y;
      });
  }
  return s;
}

function parseFrontmatterYaml(yamlText) {
  const out = {};
  const lines = String(yamlText ?? '').split(/\r?\n/);
  const stack = [{ indent: -1, container: out, parent: null, key: null, pendingArray: false }];

  const ensureArrayContext = (ctx) => {
    if (!ctx) return;
    if (Array.isArray(ctx.container)) return;
    if (!ctx.pendingArray) return;
    if (!ctx.parent || !ctx.key) return;
    const arr = [];
    ctx.parent[ctx.key] = arr;
    ctx.container = arr;
    ctx.pendingArray = false;
  };

  for (const rawLine of lines) {
    const line0 = String(rawLine ?? '');
    const trimmed = line0.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;

    const indent = line0.match(/^\s*/)?.[0]?.length ?? 0;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const ctx = stack[stack.length - 1];

    if (trimmed.startsWith('- ')) {
      ensureArrayContext(ctx);
      if (!Array.isArray(ctx.container)) continue;
      const itemRaw = trimmed.slice(2).trim();
      const item = parseScalar(itemRaw);
      ctx.container.push(item);
      continue;
    }

    const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    if (!ctx.container || typeof ctx.container !== 'object' || Array.isArray(ctx.container)) continue;

    const key = m[1];
    const rhs = m[2];

    if (!rhs) {
      const child = {};
      ctx.container[key] = child;
      stack.push({ indent, container: child, parent: ctx.container, key, pendingArray: true });
      continue;
    }

    ctx.container[key] = parseScalar(rhs);
  }

  return out;
}

function splitFrontmatter(md) {
  const s = String(md ?? '');
  if (!s.startsWith('---')) return { frontmatter: null, body: s };
  const lines = s.split(/\r?\n/);
  if (lines.length < 3) return { frontmatter: null, body: s };
  if (lines[0].trim() !== '---') return { frontmatter: null, body: s };

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: null, body: s };
  const frontmatter = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  return { frontmatter, body };
}

function readSkillMetaFromYamlFile(absPath) {
  try {
    if (!absPath) return null;
    if (!fs.existsSync(absPath)) return null;
    const raw = fs.readFileSync(absPath, 'utf-8');
    const meta = parseFrontmatterYaml(raw);
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

function normalizeKeywords(meta) {
  const kw = meta?.keywords ?? meta?.match?.keywords;
  if (Array.isArray(kw)) return kw.map((x) => String(x).trim()).filter(Boolean);
  if (typeof kw === 'string') {
    return kw
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return [];
}

function getCanonicalSkillsDir() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '../..');
  return path.join(root, 'skills');
}

export function loadSkills(skillsDir) {
  const candidates = [];
  if (skillsDir) candidates.push(path.resolve(skillsDir));
  if (process.env.SKILLS_DIR) candidates.push(path.resolve(process.env.SKILLS_DIR));
  try {
    candidates.push(getCanonicalSkillsDir());
  } catch {}
  candidates.push(path.resolve(process.cwd(), 'skills'));

  const seen = new Set();
  const uniq = [];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (!seen.has(abs)) {
      seen.add(abs);
      uniq.push(abs);
    }
  }

  const baseDir = uniq.find((d) => fs.existsSync(d));
  if (!baseDir) {
    try { logger.info('未找到可用的 skills 目录', { label: 'SKILL', candidates: uniq }); } catch {}
    return [];
  }

  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (e) {
    try { logger.warn('读取 skills 目录失败', { label: 'SKILL', baseDir, error: String(e) }); } catch {}
    return [];
  }

  const dirNames = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      const n = String(name || '');
      if (!n) return false;
      // skip template/hidden dirs such as _TEMPLATE
      if (n.startsWith('_') || n.startsWith('.')) return false;
      return true;
    });
  const skills = [];

  for (const dirName of dirNames) {
    const absDir = path.join(baseDir, dirName);

    const yamlPath = path.join(absDir, 'SKILL.yaml');
    const ymlPath = path.join(absDir, 'SKILL.yml');
    const mdPath = path.join(absDir, 'SKILL.md');

    const metaPath = fs.existsSync(yamlPath) ? yamlPath : (fs.existsSync(ymlPath) ? ymlPath : null);
    const skillPath = fs.existsSync(mdPath) ? mdPath : null;
    if (!metaPath || !skillPath) {
      try { logger.warn('Skill 缺少必要文件（需要 SKILL.yaml/.yml + SKILL.md）', { label: 'SKILL', dirName, metaPath: metaPath || null, skillPath: skillPath || null }); } catch {}
      continue;
    }
    try {
      let meta = {};
      let body = '';
      const loaded = readSkillMetaFromYamlFile(metaPath);
      if (loaded) meta = loaded;
      body = fs.readFileSync(skillPath, 'utf-8');

      const enabledRaw = meta?.enabled;
      const enabled = enabledRaw === undefined ? true : Boolean(enabledRaw);
      const name = String(meta?.name || dirName).trim();
      const description = String(meta?.description || '').trim();
      const priority = Number.isFinite(Number(meta?.priority)) ? Number(meta.priority) : 0;
      const keywords = normalizeKeywords(meta);

      skills.push({
        id: dirName,
        name,
        description,
        keywords,
        enabled,
        priority,
        baseDir,
        dirName,
        absDir,
        skillPath,
        metaPath,
        _meta: meta,
        _bodyCached: body,
      });
    } catch (e) {
      try { logger.warn('解析 Skill 失败（跳过）', { label: 'SKILL', dirName, error: String(e) }); } catch {}
    }
  }

  const enabledCount = skills.filter((s) => s.enabled).length;
  try {
    logger.info('Skills 扫描完成', { label: 'SKILL', baseDir, total: skills.length, enabled: enabledCount });
  } catch {}

  return skills;
}

export function selectSkills({ objective, judge, skills, topN = 5 }) {
  const text = `${String(objective || '')}\n${String(judge?.summary || '')}`.toLowerCase();
  const toolNames = Array.isArray(judge?.toolNames) ? judge.toolNames.map((x) => String(x)) : [];

  const scored = (Array.isArray(skills) ? skills : [])
    .filter((s) => s && s.enabled)
    .map((s) => {
      let score = 0;
      const name = String(s.name || '').toLowerCase();
      const desc = String(s.description || '').toLowerCase();

      if (name && text.includes(name)) score += 3;
      if (desc) {
        const tokens = desc.split(/\s+/).filter(Boolean).slice(0, 16);
        for (const t of tokens) {
          if (t.length >= 2 && text.includes(t)) score += 1;
        }
      }

      const kws = Array.isArray(s.keywords) ? s.keywords : [];
      for (const k of kws) {
        const kk = String(k || '').toLowerCase().trim();
        if (!kk) continue;
        if (text.includes(kk)) score += 5;
      }

      const toolPolicy = s?._meta?.tool_policy || s?._meta?.toolPolicy;
      const allow = Array.isArray(toolPolicy?.allow) ? toolPolicy.allow : [];
      if (allow.length && toolNames.length) {
        const allowSet = new Set(allow.map((x) => String(x)));
        for (const t of toolNames) {
          if (allowSet.has(t)) score += 2;
        }
      }

      score += Number.isFinite(Number(s.priority)) ? Number(s.priority) / 100 : 0;

      return { skill: s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, Math.max(0, Number(topN) || 0)).map((x) => x.skill);
}

export function buildSkillsOverlayText({ skills, selected }) {
  const all = Array.isArray(skills) ? skills : [];
  const sel = Array.isArray(selected) ? selected : [];

  const maxList = 24;
  const maxKw = 8;

  const lines = [];
  lines.push('可用 Skills（仅元信息）:');
  for (const s of all.filter((x) => x && x.enabled).slice(0, maxList)) {
    const kws = (Array.isArray(s.keywords) ? s.keywords : []).slice(0, maxKw).join(', ');
    const desc = String(s.description || '');
    const desc2 = desc.length > 120 ? `${desc.slice(0, 120)}..(+${desc.length - 120})` : desc;
    lines.push(`- ${s.id}: ${desc2}${kws ? ` | keywords: ${kws}` : ''}`);
  }
  if (all.filter((x) => x && x.enabled).length > maxList) {
    lines.push(`(仅展示前 ${maxList} 个 skills)`);
  }

  if (sel.length) {
    lines.push('本次已自动选择 Skills:');
    for (const s of sel) {
      lines.push(`- ${s.id}: ${String(s.description || '')}`);
    }
    lines.push('使用原则: 规划/参生时优先遵循已选择 Skills 的流程与约束；若与用户明确要求冲突，以用户要求为准。');
  } else {
    lines.push('本次未选择任何 Skills。');
  }

  return lines.join('\n');
}

export function getSkillBody(skill) {
  if (!skill) return '';
  try {
    if (typeof skill._bodyCached === 'string' && skill._bodyCached.trim()) {
      return skill._bodyCached;
    }
  } catch {}
  try {
    const raw = fs.readFileSync(String(skill.skillPath || ''), 'utf-8');
    return String(raw || '');
  } catch {
    return '';
  }
}

export function buildSelectedSkillsInstructionsText({ selected, maxCharsPerSkill = 1800 }) {
  const sel = Array.isArray(selected) ? selected : [];
  if (!sel.length) return '';
  const m = Number(maxCharsPerSkill);
  const limit = Number.isFinite(m) && m > 200 ? Math.floor(m) : 1800;
  const lines = [];
  lines.push('已选择 Skills（结构化指令；供规划/参数生成/反思参考）：');
  for (const s of sel) {
    const body = getSkillBody(s);
    const bodyTrim = String(body || '').trim();
    const clipped = bodyTrim.length > limit ? `${bodyTrim.slice(0, limit)}... (len=${bodyTrim.length})` : bodyTrim;

    const id = String(s.id || '').trim();
    const name = String(s.name || '').trim();
    const desc = String(s.description || '').trim();
    const kws = Array.isArray(s.keywords) ? s.keywords.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
    const toolPolicy = s?._meta?.tool_policy || s?._meta?.toolPolicy || null;
    const allow = Array.isArray(toolPolicy?.allow) ? toolPolicy.allow.map((x) => String(x).trim()).filter(Boolean).slice(0, 24) : [];
    const deny = Array.isArray(toolPolicy?.deny) ? toolPolicy.deny.map((x) => String(x).trim()).filter(Boolean).slice(0, 24) : [];

    lines.push(`\n<skill id="${id}">`);
    if (name) lines.push(`<name>${name}</name>`);
    if (desc) lines.push(`<description>${desc}</description>`);
    if (kws.length) lines.push(`<keywords>${kws.join(', ')}</keywords>`);
    if (allow.length || deny.length) {
      lines.push('<tool_policy>');
      if (allow.length) lines.push(`<allow>${allow.join(', ')}</allow>`);
      if (deny.length) lines.push(`<deny>${deny.join(', ')}</deny>`);
      lines.push('</tool_policy>');
    }
    if (clipped) {
      lines.push('<content>');
      lines.push(clipped);
      lines.push('</content>');
    }
    lines.push('</skill>');
  }
  return lines.join('\n');
}

export function toPublicSkillMeta(skill) {
  if (!skill) return null;
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    keywords: Array.isArray(skill.keywords) ? skill.keywords : [],
    enabled: Boolean(skill.enabled),
    priority: Number.isFinite(Number(skill.priority)) ? Number(skill.priority) : 0,
    dirName: skill.dirName,
  };
}
