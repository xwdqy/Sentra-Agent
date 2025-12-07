import { config } from '../../config/index.js';

// 中文：仅保留必填字段的 schema 视图，供“规划期清单展示”，避免上下文噪音
export function requiredOnlySchema(schema = {}) {
  try {
    const props = schema.properties || {};
    const req = Array.isArray(schema.required) ? schema.required : [];
    const picked = {};
    for (const k of req) {
      if (props[k] != null) picked[k] = props[k];
      else picked[k] = {}; // 保留占位，提示为必填
    }
    return {
      type: 'object',
      properties: picked,
      required: req,
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
export function buildPlanningManifest(mcpcore) {
  const tools = mcpcore.getAvailableTools();
  return tools.map((t) => ({
    aiName: t.aiName,
    name: t.name,
    description: t.description || '',
    inputSchema: requiredOnlySchema(t.inputSchema || {}),
    meta: t.meta || {},
  }));
}

// 中文：将 manifest 渲染为简洁的项目符号文本（仅显示必填字段名）
export function manifestToBulletedText(manifest = []) {
  const lines = [];
  for (const m of manifest) {
    const req = Array.isArray(m?.inputSchema?.required) ? m.inputSchema.required : [];
    lines.push(`- aiName: ${m.aiName} | name: ${m.name} | required: [${req.join(', ')}]`);
    if (m.description) lines.push(`  描述: ${m.description}`);
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
      lines.push(`  <param name="${k}">`);
      lines.push(`    <type>${typeStr}</type>`);
      if (enums.length) {
        lines.push(`    <enum>${enums.join(', ')}</enum>`);
      }
      if (desc) {
        lines.push(`    <description>${desc}</description>`);
      }
      lines.push('  </param>');
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
    lines.push('<sentra-mcp-tools>');
    lines.push(`  <summary>共有 ${total} 个 MCP 工具可用于本次任务。以下为工具清单和关键参数概览，仅供你在规划和参数生成时参考。</summary>`);
    (manifest || []).forEach((m, idx) => {
      if (!m) return;
      const aiName = m.aiName || '';
      const name = m.name || '';
      const desc = m.description || '';
      const schema = m.inputSchema || {};
      const req = Array.isArray(schema.required) ? schema.required : [];
      const props = schema.properties || {};
      const index = idx + 1;
      lines.push(`  <tool index="${index}">`);
      if (aiName) lines.push(`    <ai_name>${aiName}</ai_name>`);
      if (name) lines.push(`    <name>${name}</name>`);
      if (desc) lines.push(`    <description>${desc}</description>`);
      if (req.length) lines.push(`    <required_params>${req.join(', ')}</required_params>`);
      if (req.length) {
        lines.push('    <params>');
        for (const k of req) {
          const p = props[k] || {};
          const tRaw = p.type;
          const types = Array.isArray(tRaw) ? tRaw : (tRaw ? [tRaw] : []);
          const typeStr = types.length ? types.join('|') : 'any';
          const desc2 = typeof p.description === 'string' ? p.description : '';
          const enums = Array.isArray(p.enum) ? p.enum : [];
          lines.push(`      <param name="${k}">`);
          lines.push(`        <type>${typeStr}</type>`);
          if (enums.length) {
            lines.push(`        <enum>${enums.join(', ')}</enum>`);
          }
          if (desc2) {
            lines.push(`        <description>${desc2}</description>`);
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
