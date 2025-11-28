import { createLogger } from '../utils/logger.js';
import { appendTeachingLog } from '../utils/presetTeachingLogViewer.js';

const logger = createLogger('PresetTeaching');

function parseWhitelist(raw) {
  const text = (raw || '').trim();
  if (!text) return { mode: 'off', set: new Set() };
  if (text === '*') return { mode: 'all', set: new Set() };
  const parts = text.split(',').map(s => s.trim()).filter(Boolean);
  return { mode: 'list', set: new Set(parts) };
}

function isUserInWhitelist(userId, config) {
  if (!userId) return false;
  const id = String(userId);
  if (!config || config.mode === 'off') return false;
  if (config.mode === 'all') return true;
  return config.set.has(id);
}

function clonePreset(presetJson) {
  try {
    return JSON.parse(JSON.stringify(presetJson));
  } catch {
    return null;
  }
}

function parsePath(path) {
  const result = [];
  if (!path || typeof path !== 'string') return result;
  const parts = path.split('.');
  for (const part of parts) {
    if (!part) continue;
    const re = /(\w+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(part)) !== null) {
      if (m[1]) {
        result.push(m[1]);
      } else if (m[2]) {
        result.push(Number(m[2]));
      }
    }
  }
  return result;
}

function getParentAndKey(target, pathArr) {
  if (!target || typeof target !== 'object') return null;
  if (!Array.isArray(pathArr) || pathArr.length === 0) return null;
  let parent = target;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const key = pathArr[i];
    if (typeof key === 'number') {
      if (!Array.isArray(parent) || key < 0 || key >= parent.length) return null;
      parent = parent[key];
    } else {
      if (parent[key] === undefined || parent[key] === null || typeof parent[key] !== 'object') {
        parent[key] = {};
      }
      parent = parent[key];
    }
  }
  return { parent, lastKey: pathArr[pathArr.length - 1] };
}

function applyOperation(base, op) {
  if (!op || typeof op !== 'object') return false;
  const type = String(op.op || '').toLowerCase();
  const pathStr = op.path;
  const value = op.value;

  const pathArr = parsePath(pathStr);
  if (!pathArr.length) return false;

  const info = getParentAndKey(base, pathArr);
  if (!info) return false;
  const { parent, lastKey } = info;

  if (type === 'add') {
    if (Array.isArray(parent) && typeof lastKey === 'number') {
      // add into array by index (insert/overwrite)
      parent[lastKey] = value;
      return true;
    }
    if (Array.isArray(parent) && lastKey === 'push') {
      parent.push(value);
      return true;
    }
    parent[lastKey] = value;
    return true;
  }

  if (type === 'update') {
    if (Array.isArray(parent)) {
      if (typeof lastKey !== 'number' || lastKey < 0 || lastKey >= parent.length) return false;
      parent[lastKey] = value;
      return true;
    }
    if (!(lastKey in parent)) return false;
    parent[lastKey] = value;
    return true;
  }

  if (type === 'delete') {
    if (Array.isArray(parent)) {
      if (typeof lastKey !== 'number' || lastKey < 0 || lastKey >= parent.length) return false;
      parent.splice(lastKey, 1);
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(parent, lastKey)) {
      delete parent[lastKey];
      return true;
    }
    return false;
  }

  if (type === 'toggle') {
    if (Array.isArray(parent)) {
      if (typeof lastKey !== 'number' || lastKey < 0 || lastKey >= parent.length) return false;
      if (typeof parent[lastKey] === 'boolean') {
        parent[lastKey] = !parent[lastKey];
        return true;
      }
      if (typeof value === 'boolean') {
        parent[lastKey] = value;
        return true;
      }
      return false;
    }
    if (!(lastKey in parent)) {
      if (typeof value === 'boolean') {
        parent[lastKey] = value;
        return true;
      }
      return false;
    }
    if (typeof parent[lastKey] === 'boolean') {
      parent[lastKey] = !parent[lastKey];
      return true;
    }
    if (typeof value === 'boolean') {
      parent[lastKey] = value;
      return true;
    }
    return false;
  }

  return false;
}

function applyOperations(presetJson, operations = []) {
  const base = clonePreset(presetJson);
  if (!base) return null;
  let changed = false;

  for (const op of operations) {
    const ok = applyOperation(base, op);
    if (ok) {
      changed = true;
      logger.debug('PresetTeaching: applied operation', op);
    } else {
      logger.debug('PresetTeaching: skipped invalid operation', op);
    }
  }

  return changed ? base : null;
}

function pathPartsToString(parts) {
  if (!Array.isArray(parts) || !parts.length) return '';
  let out = '';
  for (const part of parts) {
    if (typeof part === 'number') {
      out += `[${part}]`;
    } else {
      out += out ? `.${part}` : part;
    }
  }
  return out;
}
function truncatePreview(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function buildTeachingNodesFromPreset(presetJson) {
  const nodes = [];
  const indexById = Object.create(null);

  // meta.*
  if (presetJson && typeof presetJson.meta === 'object' && presetJson.meta) {
    const meta = presetJson.meta;
    for (const key of Object.keys(meta)) {
      const val = meta[key];
      const t = typeof val;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') continue;
      const path = `meta.${key}`;
      const id = `meta:${key}`;
      const node = {
        id,
        kind: 'meta',
        path,
        title: path,
        preview: truncatePreview(val, 200),
        valueType: t
      };
      nodes.push(node);
      indexById[id] = node;
    }
  }

  // parameters.*（递归收集叶子节点）
  function walkParamNode(node, parts, depth = 0) {
    if (!node) return;
    if (depth > 5) return;
    const t = typeof node;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      const path = pathPartsToString(parts);
      if (!path) return;
      const idSuffix = path.startsWith('parameters.') ? path.slice('parameters.'.length) : path;
      const id = `param:${idSuffix}`;
      const title = path;
      const preview = truncatePreview(node, 200);
      const n = {
        id,
        kind: 'parameter',
        path,
        title,
        preview,
        valueType: t
      };
      nodes.push(n);
      indexById[id] = n;
      return;
    }

    if (Array.isArray(node)) {
      const maxLen = 4;
      const len = Math.min(node.length, maxLen);
      for (let i = 0; i < len; i++) {
        walkParamNode(node[i], [...parts, i], depth + 1);
      }
      return;
    }

    if (t === 'object') {
      for (const key of Object.keys(node || {})) {
        walkParamNode(node[key], [...parts, key], depth + 1);
      }
    }
  }

  if (presetJson && typeof presetJson.parameters === 'object' && presetJson.parameters) {
    walkParamNode(presetJson.parameters, ['parameters'], 0);
  }

  // rules 数组：按 id 拆分关键字段
  if (Array.isArray(presetJson?.rules)) {
    const rules = presetJson.rules;
    const maxRules = 16;
    const len = Math.min(rules.length, maxRules);
    for (let i = 0; i < len; i++) {
      const rule = rules[i];
      if (!rule || typeof rule !== 'object') continue;
      const ruleId = typeof rule.id === 'string' && rule.id ? rule.id : `rule_${i}`;

      if (typeof rule.enabled === 'boolean') {
        const path = `rules[${i}].enabled`;
        const id = `rule:${ruleId}.enabled`;
        const node = {
          id,
          kind: 'rule',
          path,
          title: `rule ${ruleId} enabled`,
          preview: String(rule.enabled),
          valueType: 'boolean'
        };
        nodes.push(node);
        indexById[id] = node;
      }

      if (rule.behavior && typeof rule.behavior.instruction === 'string') {
        const path = `rules[${i}].behavior.instruction`;
        const id = `rule:${ruleId}.instruction`;
        const node = {
          id,
          kind: 'rule',
          path,
          title: `rule ${ruleId} instruction`,
          preview: truncatePreview(rule.behavior.instruction, 400),
          valueType: 'string'
        };
        nodes.push(node);
        indexById[id] = node;
      }
    }
  }

  // 将节点列表挂到索引上，便于后续解析时做更灵活的匹配
  indexById.__nodes = nodes;

  return { nodes, indexById };
}

function buildEditablePathsSummaryFromNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return '';
  const seen = new Set();
  const paths = [];
  for (const n of nodes) {
    const p = n && n.path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
    if (paths.length >= 200) break;
  }
  return paths.map((p) => `- ${p}`).join('\n');
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(str) {
  return escapeXml(str).replace(/"/g, '&quot;');
}

function buildTeachingInputXml({ nodes, conversationText }) {
  const lines = [];
  const list = Array.isArray(nodes) ? nodes.slice(0, 64) : [];

  lines.push('<sentra-agent-preset-edit-input>');
  lines.push('  <nodes>');
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (!n) continue;
    lines.push(
      `    <node index="${i + 1}" id="${escapeXmlAttr(n.id || '')}" kind="${escapeXmlAttr(
        n.kind || 'other'
      )}" path="${escapeXmlAttr(n.path || '')}">`
    );
    if (n.title) {
      lines.push(`      <title>${escapeXml(n.title)}</title>`);
    }
    if (n.preview) {
      lines.push(`      <preview>${escapeXml(n.preview)}</preview>`);
    }
    lines.push('    </node>');
  }
  lines.push('  </nodes>');
  lines.push('  <conversation>');
  lines.push(escapeXml(conversationText || ''));
  lines.push('  </conversation>');
  lines.push('</sentra-agent-preset-edit-input>');

  return lines.join('\n');
}

function extractFirstTagBlock(text, tagName) {
  if (!text) return null;
  // 允许关闭标签前存在空格，例如 </tagName >
  const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, 'i');
  const m = text.match(re);
  return m ? m[0] : null;
}

function extractTagText(xml, tagName) {
  if (!xml) return '';
  // 同样允许关闭标签前存在空格
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\/${tagName}\\s*>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function castValueForNode(raw, node) {
  const valueType = node && node.valueType;
  if (valueType === 'boolean') {
    const t = String(raw ?? '').trim().toLowerCase();
    if (t === 'true' || t === '1') return true;
    if (t === 'false' || t === '0') return false;
    return !!t;
  }
  if (valueType === 'number') {
    const n = Number(raw);
    if (!Number.isNaN(n)) return n;
    return raw;
  }
  return String(raw ?? '');
}

function findNodeForTarget(nodeIndex, rawId) {
  if (!nodeIndex || !rawId) return null;

  const raw = String(rawId);
  const key = raw.trim();
  if (!key) return null;

  // 1) 直接按 id 命中
  const direct = nodeIndex[key];
  if (direct && direct.path) return direct;

  const nodesList = Array.isArray(nodeIndex.__nodes) ? nodeIndex.__nodes : null;
  if (!nodesList || !nodesList.length) return null;

  // 2) 若 target_node_id 是数字，按 <node index> 解析（1-based）
  if (/^\d+$/.test(key)) {
    const idx = Number(key) - 1;
    if (idx >= 0 && idx < nodesList.length) {
      const byIndex = nodesList[idx];
      if (byIndex && byIndex.path) return byIndex;
    }
  }

  // 3) 构造一批候选 key 变体（去空格、处理斜杠等）
  const variants = new Set();
  variants.add(key);
  variants.add(key.replace(/\s+/g, ''));
  variants.add(key.replace(/\/+?/g, '.'));

  // 4) 用候选 key 对 id/path 做直接匹配
  for (const v of variants) {
    for (const n of nodesList) {
      if (!n) continue;
      if (n.id === v || n.path === v) return n;
    }
  }

  // 5) 更宽松的后缀/前缀匹配：允许省略 meta:/param:/rule: 前缀，或只写后缀
  const suffixCandidates = new Set();
  for (const v of variants) {
    suffixCandidates.add(v);
    const trimmed = v
      .replace(/^param:/, '')
      .replace(/^meta:/, '')
      .replace(/^rule:/, '');
    suffixCandidates.add(trimmed);
  }

  for (const n of nodesList) {
    if (!n) continue;
    const id = n.id || '';
    const path = n.path || '';

    if (!id && !path) continue;

    for (const s of suffixCandidates) {
      if (!s) continue;

      // 允许省略前缀形式，例如 appearance.description / meta.description / Rhythm_of_Connection_Core.instruction
      if (id === `param:${s}` || id === `meta:${s}` || id === `rule:${s}`) {
        return n;
      }

      if (id && (id === s || id.endsWith(`.${s}`))) {
        return n;
      }

      if (path && (path === s || path.endsWith(`.${s}`) || path.endsWith(`]${s}`))) {
        return n;
      }
    }
  }

  return null;
}

function parseEditPlanXml(text, nodeIndex) {
  const xml = extractFirstTagBlock(text, 'sentra-agent-preset-edit-plan');
  if (!xml) {
    return { operations: null, error: 'missing <sentra-agent-preset-edit-plan> block' };
  }

  const decisionRaw = extractTagText(xml, 'decision');
  const decision = (decisionRaw || '').trim().toLowerCase();

  // 新版协议：所有编辑指令必须放在 <edit_operations> 下的若干 <edit_operation> 中
  // 放宽 </edit_operation> 关闭标签匹配，兼容 </edit_operation > 写法
  const opBlocks = xml.match(/<edit_operation\b[^>]*>[\s\S]*?<\/edit_operation\s*>/gi) || [];
  if ((!opBlocks || opBlocks.length === 0) && decision === 'no_change') {
    return { operations: [], error: null };
  }

  const operations = [];
  const unknownTargets = [];
  const nodesList = nodeIndex && Array.isArray(nodeIndex.__nodes) ? nodeIndex.__nodes : [];

  for (const block of opBlocks) {
    // 新版 schema：edit_type / target_index / target_id / new_value / change_reason
    const typeRaw = extractTagText(block, 'edit_type');
    const indexRaw = extractTagText(block, 'target_index');
    const nodeIdRaw = extractTagText(block, 'target_id');
    if (!typeRaw || (!indexRaw && !nodeIdRaw)) continue;

    const editType = typeRaw.trim().toLowerCase();
    if (!['add', 'update', 'delete', 'toggle'].includes(editType)) continue;

    let node = null;

    // 1) 首选使用 target_index（基于输入 <node index="N"> 的 1-based 序号）
    if (indexRaw && nodesList && nodesList.length > 0) {
      const idx = parseInt(String(indexRaw).trim(), 10);
      if (Number.isInteger(idx) && idx >= 1 && idx <= nodesList.length) {
        const candidate = nodesList[idx - 1];
        if (candidate && candidate.path) {
          node = candidate;
        }
      }
    }

    // 2) 若 index 缺失或解析失败，再尝试 target_id 解析
    if (!node && nodeIdRaw) {
      node = findNodeForTarget(nodeIndex, nodeIdRaw);
    }

    if (!node || !node.path) {
      const indexStr = String(indexRaw || '').trim();
      const idStr = String(nodeIdRaw || '').trim();
      const marker = indexStr ? `index:${indexStr}` : idStr ? `id:${idStr}` : '';
      if (marker) unknownTargets.push(marker);
      continue;
    }

    const newValRaw = extractTagText(block, 'new_value');
    const reasonRaw = extractTagText(block, 'change_reason');
    const value = castValueForNode(newValRaw, node);

    operations.push({
      op: editType,
      path: node.path,
      value,
      reason: reasonRaw || ''
    });
  }

  if (!operations.length) {
    // 额外输出一些调试信息，帮助定位 index/id 匹配问题
    try {
      const perOperation = [];
      try {
        const maxDebugOps = 8;
        const limitedBlocks = Array.isArray(opBlocks) ? opBlocks.slice(0, maxDebugOps) : [];
        for (const block of limitedBlocks) {
          const blockStr = typeof block === 'string' ? block : String(block ?? '');
          const typeRawDbg = extractTagText(blockStr, 'edit_type');
          const indexRawDbg = extractTagText(blockStr, 'target_index');
          const nodeIdRawDbg = extractTagText(blockStr, 'target_id');

          let resolvedNode = null;
          if (indexRawDbg && nodesList && nodesList.length > 0) {
            const idxDbg = parseInt(String(indexRawDbg).trim(), 10);
            if (Number.isInteger(idxDbg) && idxDbg >= 1 && idxDbg <= nodesList.length) {
              resolvedNode = nodesList[idxDbg - 1] || null;
            }
          }

          if (!resolvedNode && nodeIdRawDbg) {
            resolvedNode = findNodeForTarget(nodeIndex, nodeIdRawDbg) || null;
          }

          perOperation.push({
            editTypeRaw: typeRawDbg,
            indexRaw: indexRawDbg,
            nodeIdRaw: nodeIdRawDbg,
            resolvedPath: resolvedNode && resolvedNode.path ? resolvedNode.path : null,
            resolvedId: resolvedNode && resolvedNode.id ? resolvedNode.id : null,
            blockPreview: blockStr.slice(0, 200)
          });
        }
      } catch {}

      const debugSnapshot = {
        decision,
        opBlockCount: opBlocks.length,
        nodeCount: nodesList.length,
        unknownTargets,
        samplePaths: Array.isArray(nodesList)
          ? nodesList.slice(0, 80).map((n, idx) => ({ index: idx + 1, id: n.id, path: n.path }))
          : [],
        // 仅截取前若干个 edit_operation 块作参考，避免日志过长
        opBlocksPreview: opBlocks.slice(0, 4),
        perOperation
      };
      logger.warn('PresetTeaching: parseEditPlanXml: no operations resolved', debugSnapshot);
    } catch {}

    const detail = unknownTargets.length
      ? `no valid <edit_operation> entries with known target node (index/id); unknown=${JSON.stringify(unknownTargets)}`
      : 'no valid <edit_operation> entries with known target node (index/id)';
    return { operations: null, error: detail };
  }

  return { operations, error: null };
}

async function runEditPlanWithRetry({ agent, model, messages, nodeIndex, groupId, userId }) {
  const maxAttempts = 2;
  let lastError = '';
  let lastRaw = '';
  let operations = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let reply;
    try {
      reply = await agent.chat(messages, {
        model,
        temperature: 0
      });
    } catch (e) {
      return { operations: null, error: `chat_failed: ${String(e)}`, raw: '' };
    }

    const text = typeof reply === 'string' ? reply : String(reply ?? '');
    lastRaw = text;

    const parsed = parseEditPlanXml(text, nodeIndex);
    if (!parsed.error) {
      operations = parsed.operations;
      break;
    }

    lastError = parsed.error;

    messages = [
      ...messages,
      {
        role: 'user',
        content: [
          '上一次输出的 <sentra-agent-preset-edit-plan> XML 无法被一个简单的 XML 解析器正确解析。',
          `解析错误: ${lastError}`,
          '',
          '请重新执行同一任务，并且只输出一个**修正后的** <sentra-agent-preset-edit-plan> XML 块：',
          '- 不要输出 markdown 代码块。',
          '- 不要在 XML 外输出任何解释或对话。',
          '- 确保所有标签成对闭合、嵌套正确。',
          '- 当 <decision>no_change</decision> 时，可以让 <edit_operations> 为空。'
        ].join('\n')
      }
    ];
  }

  if (!operations) {
    const rawSnippet = typeof lastRaw === 'string' ? lastRaw.slice(0, 800) : '';
    logger.warn('PresetTeaching: XML edit plan parse failed after retries', {
      groupId,
      userId,
      lastError,
      rawSnippet
    });
    return { operations: null, error: lastError, raw: lastRaw };
  }

  return { operations, error: null, raw: lastRaw };
}

/**
 * 根据最近对话和当前 JSON 预设，判断是否需要教导并返回更新后的预设
 * 只负责生成新的 JSON，不直接写文件或更新全局变量
 */
export async function maybeTeachPreset(options = {}) {
  const {
    agent,
    userId,
    groupId,
    chatType,
    presetJson,
    conversationText
  } = options;

  const enabled = (process.env.AGENT_PRESET_TEACHING_ENABLED || 'false') === 'true';
  if (!enabled) return null;

  if (!agent || typeof agent.chat !== 'function') return null;
  if (!presetJson || typeof presetJson !== 'object' || Array.isArray(presetJson)) return null;

  const wlConfig = parseWhitelist(process.env.AGENT_PRESET_TEACHING_WHITELIST || '');
  if (!isUserInWhitelist(userId, wlConfig)) {
    return null;
  }

  const model = process.env.AGENT_PRESET_TEACHING_MODEL || process.env.MAIN_AI_MODEL;
  const historyText = typeof conversationText === 'string' ? conversationText : '';

  const { nodes, indexById } = buildTeachingNodesFromPreset(presetJson);
  if (!Array.isArray(nodes) || nodes.length === 0) {
    logger.info('PresetTeaching: 当前预设中未检测到可编辑节点，跳过教导');
    return null;
  }

  const inputXml = buildTeachingInputXml({ nodes, conversationText: historyText });
  const editablePathsSummary = buildEditablePathsSummaryFromNodes(nodes);

  const systemPrompt = [
    'You are an internal Sentra XML sub-agent responsible for MAINTAINING the BOT\'s agent preset JSON (its own persona card, i.e. <sentra-agent-preset>).',
    'Your ONLY output is a machine-parsable XML edit plan that updates this preset when the whitelisted TEACHER is clearly teaching new persona details.',
    '',
    '## Input you receive',
    'You will receive ONE and ONLY ONE <sentra-agent-preset-edit-input> XML block as the user message. It contains:',
    '- <nodes>: a list of editable preset nodes, each with attributes id / kind / path and child <title> / <preview>.',
    '- <conversation>: the current and recent conversation context in Chinese（包含用户与助手的往来对话，可能含 Sentra XML 片段，仅供理解意图）。',
    '',
    'Below is a summary of the editable JSON paths (for reference only, DO NOT echo them back):',
    editablePathsSummary || '(no editable paths summary)',
    '',
    '## Your high-level task',
    '1. 仔细阅读 <conversation>，判断本轮是否存在**清晰的“教导/改设定”意图**：',
    '   - 例如：用户在教外貌、衣服、人设背景、说话风格、行为规则等。',
    '2. 如果**没有**明确教导意图：',
    '   - 输出一个 <sentra-agent-preset-edit-plan>，其中 <decision>no_change</decision>，<edit_operations> 为空。',
    '3. 如果**有**明确教导意图：',
    '   - 输出一个 <sentra-agent-preset-edit-plan>，其中 <decision>update</decision>，并给出**极少量、精确**的 <edit_operation> 列表。',
    '   - 每个 <edit_operation> 必须引用 <nodes> 里已经存在的一个节点，并且通过 <target_index> 指定该节点（数值来自输入 <node index="N"> 属性）。',
    '',
    '## STRICT output format (single XML block, no markdown)',
    '你必须严格按照下述结构输出，且只能输出这一段 XML（不要使用任何旧的 <operations>/<operation>/<op> 标签）：',
    '<sentra-agent-preset-edit-plan>',
    '  <decision>update|no_change</decision>',
    '  <edit_operations>',
    '    <edit_operation index="1">',
    '      <edit_type>update|add|delete|toggle</edit_type>',
    '      <target_index>ONE_OF_NODE_INDICES_FROM_INPUT</target_index>',
    '      <!-- 可选：你也可以附带 <target_id>，其内容必须逐字复制自对应 <node id="..."> 属性 -->',
    '      <new_value>NEW_VALUE_IN_CHINESE</new_value>',
    '      <change_reason>中文解释为什么需要这次修改（引用用户的话语）</change_reason>',
    '    </edit_operation>',
    '    <!-- more <edit_operation> elements if needed -->',
    '  </edit_operations>',
    '</sentra-agent-preset-edit-plan>',
    '',
    '禁止事项：',
    '- 不要输出 markdown 代码块或 ``` 包裹。',
    '- 不要输出 <sentra-response> 或其它 Sentra 协议标签。',
    '- 不要在 XML 前后添加任何解释性文本、对话或说明。',
    '- 不要凭空创造不存在于 <nodes> 列表中的 <target_index> 或 <target_id>。',
    '',
    '## Operation selection guidelines',
    '- **外貌/衣服/身份/说话风格** 等设定：',
    '  - 优先选择已有 parameter 节点（如 param:appearance.description、param:style_and_tone.length_limit）。',
    '  - 在 <edit_operation> 中使用 <edit_type>update</edit_type>，并在 <new_value> 中给出**完整的新文本**（而不是只给差分）。',
    '- **行为规则（rules）**：',
    '  - 若只是调整表述或语气，在 <edit_operation> 中使用 <edit_type>update</edit_type> 修改对应 rule 的 behavior.instruction。',
    '  - 若只是开关某条规则，在 <edit_operation> 中使用 <edit_type>toggle</edit_type> 或 <edit_type>update</edit_type> 针对 enabled 节点。',
    '  - 只有当用户明确说“新增/再加一条规则”等时，才使用 <edit_type>add</edit_type>。',
    '- 若本轮对话只是闲聊或无关内容，必须输出 <decision>no_change</decision> 且让 <edit_operations> 为空。',
    '- <new_value> 和 <change_reason> 内的自然语言都必须是地道中文，不要包含 XML 标签或转义实体。',
    '',
    '## Example 1: 修改外貌衣服（update parameter）',
    'Teaching intent (from <conversation>):',
    '  用户: 以后别说黑色连帽衫了，我现在想让你设定成穿**白色连衣裙**，其余外貌不变。',
    '',
    'Good edit plan example（假设在输入 XML 中，该节点的 index="12"）：',
    '<sentra-agent-preset-edit-plan>',
    '  <decision>update</decision>',
    '  <edit_operations>',
    '    <edit_operation index="1">',
    '      <edit_type>update</edit_type>',
    '      <target_index>12</target_index>',
    '      <!-- 可选：<target_id>param:appearance.description</target_id> -->',
    '      <new_value>最佳质量、超细节、高分辨率、青春活力、动漫风格。女性角色，温柔可爱。黑色长发，双马尾。黑色眼睛。穿着白色连衣裙，带少量黑色配饰。</new_value>',
    '      <change_reason>用户明确要求把衣服从黑色连帽衫改成白色连衣裙，其余外貌保持一致。</change_reason>',
    '    </edit_operation>',
    '  </edit_operations>',
    '</sentra-agent-preset-edit-plan>',
    '',
    '## Example 2: 调整行为规则文案（update rule instruction）',
    'Teaching intent (from <conversation>):',
    '  用户: 群聊里不用叫大家“XX大人”了，改成直接叫昵称就行。',
    '',
    'Good edit plan example（假设对应 rule 节点的 index="25"）：',
    '<sentra-agent-preset-edit-plan>',
    '  <decision>update</decision>',
    '  <edit_operations>',
    '    <edit_operation index="1">',
    '      <edit_type>update</edit_type>',
    '      <target_index>25</target_index>',
    '      <!-- 可选：<target_id>rule:Group_Chat_Protocol.instruction</target_id> -->',
    '      <new_value>在群聊中自然融入，直接使用群友昵称称呼对方，不再使用“XX大人”。</new_value>',
    '      <change_reason>用户要求群聊称呼从“XX大人”改为直接叫昵称。</change_reason>',
    '    </edit_operation>',
    '  </edit_operations>',
    '</sentra-agent-preset-edit-plan>',
    '',
    '## Example 3: 没有教导意图（no_change）',
    'Teaching intent (from <conversation>):',
    '  用户只是和 BOT 闲聊日常，没有提到修改设定或角色。',
    '',
    'Expected edit plan:',
    '<sentra-agent-preset-edit-plan>',
    '  <decision>no_change</decision>',
    '  <edit_operations></edit_operations>',
    '</sentra-agent-preset-edit-plan>',
    '',
    '你在真正输出时：',
    '- 只能输出**一段** <sentra-agent-preset-edit-plan>，不要包含本说明或示例内容。',
    '- 必须根据当前 <nodes> 列表中的实际顺序选择正确的 <target_index>（数值来自 <node index="N">）。'
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: inputXml }
  ];

  logger.info('PresetTeaching: 开始教导检查(XML 工作流)', {
    groupId,
    userId,
    model,
    nodeCount: nodes.length
  });

  const { operations, error } = await runEditPlanWithRetry({
    agent,
    model,
    messages,
    nodeIndex: indexById,
    groupId,
    userId
  });

  if (error) {
    logger.warn('PresetTeaching: XML 编辑计划解析失败，跳过教导', {
      groupId,
      userId,
      error
    });
    return null;
  }

  if (!operations.length) {
    logger.info('PresetTeaching: 本轮未检测到需要修改预设的指令');
    return null;
  }

  const updated = applyOperations(presetJson, operations);
  if (!updated) {
    logger.info('PresetTeaching: 所有操作均无效或未产生变化');
    return null;
  }

  try {
    appendTeachingLog({
      time: new Date().toISOString(),
      userId,
      groupId,
      chatType,
      model,
      operations,
      presetMetaBefore: presetJson && typeof presetJson.meta === 'object' ? presetJson.meta : null,
      presetMetaAfter: updated && typeof updated.meta === 'object' ? updated.meta : null
    });
  } catch (e) {
    logger.warn('PresetTeaching: 写入教导日志失败', { err: String(e) });
  }

  logger.success('PresetTeaching: 预设已生成新的 JSON（内存态，尚未写回磁盘）');
  return updated;
}
