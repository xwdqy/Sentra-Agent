import {
  buildTerminalRuntimeManifestEntry,
  pinTerminalRuntimeInManifest
} from '../../runtime/terminal/spec.js';

function escapeXmlEntities(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatScore(value, digits = 4) {
  const n = toFiniteNumber(value);
  if (n === null) return '';
  return String(Number(n.toFixed(digits)));
}

function extractRequiredGroups(schema = {}) {
  try {
    const groups = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.required) && node.required.length) {
        groups.push(node.required.map(String));
      }
      const variants = [];
      if (Array.isArray(node.anyOf)) variants.push(...node.anyOf);
      if (Array.isArray(node.oneOf)) variants.push(...node.oneOf);
      if (Array.isArray(node.allOf)) variants.push(...node.allOf);
      for (const v of variants) visit(v);
    };
    visit(schema);
    const seen = new Set();
    const uniq = [];
    for (const g of groups) {
      const key = JSON.stringify(g.slice().sort());
      if (!seen.has(key)) { seen.add(key); uniq.push(g); }
    }
    return uniq;
  } catch {
    return [];
  }
}

function summarizeConditionalRequired(schema = {}) {
  try {
    const groups = extractRequiredGroups(schema);
    if (!groups.length) return '';
    const baseReq = Array.isArray(schema.required) ? schema.required.map(String) : [];
    const filtered = groups.filter((g) => {
      if (!baseReq.length) return true;
      const keyA = JSON.stringify(g.slice().sort());
      const keyB = JSON.stringify(baseReq.slice().sort());
      return keyA !== keyB;
    });
    if (!filtered.length) return '';
    const parts = filtered.map((g) => `[${g.join(', ')}]`).join(' OR ');
    return `CONDITIONAL(anyOf/oneOf): one of ${parts}`;
  } catch {
    return '';
  }
}

// 中文：仅保留必填字段的 schema 视图，供“规划期清单展示”，避免上下文噪音
export function requiredOnlySchema(schema = {}) {
  try {
    const props = schema.properties || {};
    const req = Array.isArray(schema.required) ? schema.required : [];
    const groups = extractRequiredGroups(schema);
    const allKeys = new Set();
    for (const k of req) allKeys.add(String(k));
    for (const g of groups) for (const k of g) allKeys.add(String(k));
    const picked = {};
    for (const k of Array.from(allKeys)) {
      if (props[k] != null) picked[k] = props[k];
      else picked[k] = {};
    }
    const anyOfSlim = (() => {
      const out = [];
      const variants = Array.isArray(schema.anyOf) ? schema.anyOf : [];
      for (const v of variants) {
        if (v && typeof v === 'object' && Array.isArray(v.required) && v.required.length) {
          out.push({ required: v.required.map(String) });
        }
      }
      return out.length ? out : undefined;
    })();
    return {
      type: 'object',
      properties: picked,
      required: req,
      ...(anyOfSlim ? { anyOf: anyOfSlim } : {}),
      additionalProperties: schema.additionalProperties !== undefined ? schema.additionalProperties : true,
    };
  } catch {
    return { type: 'object', properties: {}, required: [], additionalProperties: true };
  }
}

// 中文：将“工具上下文”组织为 system 文本，供预思考阶段使用（避免一次性传入过多 schema 细节导致 token 暴涨）
export function buildToolContextSystem(manifest = []) {
  const maxDescLen = 140;
  const lines = ['可用工具上下文（仅概要）：'];
  for (const m of manifest) {
    const req = Array.isArray(m?.inputSchema?.required) ? m.inputSchema.required : [];
    let desc = String(m.description || '');
    if (desc.length > maxDescLen) desc = desc.slice(0, maxDescLen) + ` ..(+${desc.length - maxDescLen})`;
    lines.push(`- ${m.name} (${m.aiName}) | required: [${req.join(', ')}] | ${desc}`);
  }
  return lines.join('\n');
}

// 中文：构造“规划期”使用的工具清单（只展示必填字段的 schema）
export function buildPlanningManifest(mcpcore, options = {}) {
  const tools = mcpcore.getAvailableTools();
  const base = tools.map((t) => ({
    aiName: t.aiName,
    name: t.name,
    provider: t.provider || '',
    executor: 'mcp',
    actionRef: '',
    description: t.description || '',
    inputSchema: requiredOnlySchema(t.inputSchema || {}),
    meta: t.meta || {},
    skillDoc: t.skillDoc || null,
  }));
  const includeRuntimeExecutors = options.includeRuntimeExecutors !== false;
  if (!includeRuntimeExecutors) return base;
  const runtimeEntry = buildTerminalRuntimeManifestEntry();
  return pinTerminalRuntimeInManifest([...
    base, {
    ...runtimeEntry,
    // Keep full runtime terminal schema so arggen can see shell/execution knobs
    // (terminalType/sessionMode/timeout/etc.) instead of command-only.
    inputSchema: runtimeEntry.inputSchema || {},
  }], { insertIfMissing: true });
}

// 中文：将 manifest 渲染为简洁的项目符号文本（仅显示必填字段名）
export function manifestToBulletedText(manifest = []) {
  const lines = [];
  for (const m of manifest) {
    const req = Array.isArray(m?.inputSchema?.required) ? m.inputSchema.required : [];
    const skill = m?.skillDoc && typeof m.skillDoc === 'object' ? m.skillDoc : null;
    const whenToUse = Array.isArray(skill?.whenToUse)
      ? skill.whenToUse.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3)
      : [];
    const whenNotToUse = Array.isArray(skill?.whenNotToUse)
      ? skill.whenNotToUse.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 2)
      : [];
    const successCriteria = Array.isArray(skill?.successCriteria)
      ? skill.successCriteria.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4)
      : [];
    const executor = String(m?.executor || '').trim();
    const actionRef = String(m?.actionRef || '').trim();
    const executorText = executor ? ` | executor: ${executor}` : '';
    const actionText = actionRef ? ` | action: ${actionRef}` : '';
    lines.push(`- aiName: ${m.aiName} | name: ${m.name}${executorText}${actionText} | required: [${req.join(', ')}]`);
    if (m.description) lines.push(`  描述: ${m.description}`);
    if (whenToUse.length) lines.push(`  when_to_use: ${whenToUse.join(' | ')}`);
    if (whenNotToUse.length) lines.push(`  when_not_to_use: ${whenNotToUse.join(' | ')}`);
    if (successCriteria.length) lines.push(`  success_criteria: ${successCriteria.join(' | ')}`);
  }
  return lines.join('\n');
}

// 中文：将“必填字段”的类型与枚举约束输出为易读文本，帮助模型严格遵循 schema
export function summarizeRequiredFieldsDetail(schema = {}) {
  try {
    const req = Array.isArray(schema.required) ? schema.required : [];
    const props = schema.properties || {};
    const out = [];
    for (const k of req) {
      const p = props[k] || {};
      const t = p.type ? String(p.type) : 'any';
      let extra = '';
      if (Array.isArray(p.enum) && p.enum.length) {
        extra += ` | enum: [${p.enum.join(', ')}]`;
      }
      out.push(`- ${k}: type=${t}${extra}`);
    }
    const cond = summarizeConditionalRequired(schema);
    if (cond) out.push(cond);
    return out.join('\n');
  } catch {
    return '';
  }
}

export function summarizeRequiredFieldsDetailXml(schema = {}) {
  try {
    const req = Array.isArray(schema.required) ? schema.required : [];
    const props = schema.properties || {};
    const lines = [];
    lines.push('<params>');
    for (const k of req) {
      const p = props[k] || {};
      const tRaw = p.type;
      const types = Array.isArray(tRaw) ? tRaw : (tRaw ? [tRaw] : []);
      const typeStr = types.length ? types.join('|') : 'any';
      const desc = typeof p.description === 'string' ? p.description : '';
      const enums = Array.isArray(p.enum) ? p.enum : [];
      lines.push(`  <param name="${escapeXmlEntities(k)}">`);
      lines.push(`    <type>${escapeXmlEntities(typeStr)}</type>`);
      if (enums.length) {
        lines.push(`    <enum>${escapeXmlEntities(enums.join(', '))}</enum>`);
      }
      if (desc) {
        lines.push(`    <description>${escapeXmlEntities(desc)}</description>`);
      }
      lines.push('  </param>');
    }
    const cond = summarizeConditionalRequired(schema);
    if (cond) {
      lines.push('  <conditional_required>');
      lines.push(`    <rule>${escapeXmlEntities(cond)}</rule>`);
      lines.push('  </conditional_required>');
    }
    lines.push('</params>');
    return lines.join('\n');
  } catch {
    return '';
  }
}

export function manifestToXmlToolsCatalog(manifest = []) {
  try {
    const lines = [];
    const total = Array.isArray(manifest) ? manifest.length : 0;
    const rerankHintCount = (manifest || []).filter((m) => m && m.rerank && typeof m.rerank === 'object').length;

    lines.push('<sentra-mcp-tools>');
    lines.push(`  <summary>${escapeXmlEntities(`共有 ${total} 个 MCP 工具可用于本次任务。以下为工具清单和关键参数概览，仅供你在规划和参数生成时参考。${rerankHintCount > 0 ? `其中 ${rerankHintCount} 个工具附带 rerank_hint（rank/probability/final_score），可作为软优先级参考。` : ''}`)}</summary>`);
    (manifest || []).forEach((m, idx) => {
      if (!m) return;
      const aiName = m.aiName || '';
      const name = m.name || '';
      const executor = m.executor || '';
      const actionRef = m.actionRef || '';
      const desc = m.description || '';
      const schema = m.inputSchema || {};
      const req = Array.isArray(schema.required) ? schema.required : [];
      const props = schema.properties || {};
      const skill = m.skillDoc || null;
      const whenToUse = Array.isArray(skill?.whenToUse)
        ? skill.whenToUse.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3)
        : [];
      const whenNotToUse = Array.isArray(skill?.whenNotToUse)
        ? skill.whenNotToUse.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 2)
        : [];
      const successCriteria = Array.isArray(skill?.successCriteria)
        ? skill.successCriteria.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4)
        : [];
      const index = idx + 1;
      lines.push(`  <tool index="${escapeXmlEntities(index)}">`);
      if (aiName) lines.push(`    <ai_name>${escapeXmlEntities(aiName)}</ai_name>`);
      if (name) lines.push(`    <name>${escapeXmlEntities(name)}</name>`);
      if (executor) lines.push(`    <executor>${escapeXmlEntities(executor)}</executor>`);
      if (actionRef) lines.push(`    <action_ref>${escapeXmlEntities(actionRef)}</action_ref>`);
      if (desc) lines.push(`    <description>${escapeXmlEntities(desc)}</description>`);
      if (whenToUse.length) {
        lines.push('    <when_to_use>');
        for (const hint of whenToUse) {
          lines.push(`      <hint>${escapeXmlEntities(hint)}</hint>`);
        }
        lines.push('    </when_to_use>');
      }
      if (whenNotToUse.length) {
        lines.push('    <when_not_to_use>');
        for (const hint of whenNotToUse) {
          lines.push(`      <hint>${escapeXmlEntities(hint)}</hint>`);
        }
        lines.push('    </when_not_to_use>');
      }
      if (successCriteria.length) {
        lines.push('    <success_criteria>');
        for (const hint of successCriteria) {
          lines.push(`      <rule>${escapeXmlEntities(hint)}<\/rule>`);
        }
        lines.push('    </success_criteria>');
      }
      const rr = (m.rerank && typeof m.rerank === 'object') ? m.rerank : null;
      if (rr) {
        const rank = toFiniteNumber(rr.rank);
        const probability = formatScore(rr.probability, 6);
        const finalScore = formatScore(rr.final, 4);
        const intentScore = formatScore(rr.intent, 4);
        const relevanceScore = formatScore(rr.relevance, 4);
        const trustScore = formatScore(rr.trust, 4);
        const hasRerank = (rank !== null && rank > 0)
          || !!probability
          || !!finalScore
          || !!intentScore
          || !!relevanceScore
          || !!trustScore;
        if (hasRerank) {
          lines.push('    <rerank_hint>');
          if (rank !== null && rank > 0) lines.push(`      <rank>${escapeXmlEntities(Math.floor(rank))}</rank>`);
          if (probability) lines.push(`      <probability>${escapeXmlEntities(probability)}</probability>`);
          if (finalScore) lines.push(`      <final_score>${escapeXmlEntities(finalScore)}</final_score>`);
          if (intentScore) lines.push(`      <intent_score>${escapeXmlEntities(intentScore)}</intent_score>`);
          if (relevanceScore) lines.push(`      <relevance_score>${escapeXmlEntities(relevanceScore)}</relevance_score>`);
          if (trustScore) lines.push(`      <trust_score>${escapeXmlEntities(trustScore)}</trust_score>`);
          lines.push('    </rerank_hint>');
        }
      }
      if (req.length) {
        lines.push(`    <required_params>${escapeXmlEntities(req.join(', '))}</required_params>`);
      }
      if (req.length) {
        lines.push('    <params>');
        for (const k of req) {
          const p = props[k] || {};
          const tRaw = p.type;
          const types = Array.isArray(tRaw) ? tRaw : (tRaw ? [tRaw] : []);
          const typeStr = types.length ? types.join('|') : 'any';
          const desc2 = typeof p.description === 'string' ? p.description : '';
          const enums = Array.isArray(p.enum) ? p.enum : [];
          lines.push(`      <param name="${escapeXmlEntities(k)}">`);
          lines.push(`        <type>${escapeXmlEntities(typeStr)}</type>`);
          if (enums.length) {
            lines.push(`        <enum>${escapeXmlEntities(enums.join(', '))}</enum>`);
          }
          if (desc2) {
            lines.push(`        <description>${escapeXmlEntities(desc2)}</description>`);
          }
          lines.push('      </param>');
        }
        lines.push('    </params>');
      }
      lines.push('  </tool>');
    });
    lines.push('</sentra-mcp-tools>');
    return lines.join('\n');
  } catch {
    return '<sentra-mcp-tools></sentra-mcp-tools>';
  }
}
