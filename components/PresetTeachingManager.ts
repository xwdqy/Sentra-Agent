import { createLogger } from '../utils/logger.js';
import { appendTeachingLog } from '../utils/presetTeachingLogViewer.js';
import { getEnv, getEnvBool, getEnvTimeoutMs } from '../utils/envHotReloader.js';
import { escapeXml, escapeXmlAttr, unescapeXml } from '../utils/xmlUtils.js';
import { getRecentPresetTeachingExamples, pushPresetTeachingExample } from '../utils/presetTeachingCache.js';
import path from 'node:path';
import SentraPromptsSDK from 'sentra-prompts';
type RenderTemplateFn = (name: string, params?: Record<string, unknown>) => string;
const promptsModule = await import(new URL('../../prompts/loader.js', import.meta.url).toString());
const renderTemplate = (promptsModule as { renderTemplate?: RenderTemplateFn }).renderTemplate as RenderTemplateFn;
if (!renderTemplate) {
  throw new Error('renderTemplate not found in prompts/loader.js');
}
import type { ChatMessage } from '../src/types.js';

type WhitelistMode = 'off' | 'all' | 'list';
type WhitelistConfig = { mode: WhitelistMode; set: Set<string> };

type PresetRule = {
  id?: string;
  enabled?: boolean;
  behavior?: { instruction?: string };
  [key: string]: unknown;
};

type PresetJson = {
  meta?: Record<string, string | number | boolean>;
  parameters?: unknown;
  rules?: PresetRule[];
  [key: string]: unknown;
};

type TeachingNode = {
  id: string;
  kind: string;
  path: string;
  title?: string;
  preview?: string;
  valueType?: string;
};

type NodeIndex = Record<string, TeachingNode> & { __nodes?: TeachingNode[] };

type PresetOperation = { op?: string; path?: string; value?: unknown; reason?: string };
type EditPlanParseResult = { operations: PresetOperation[] | null; error: string | null };

type AgentLike = {
  chat: (
    messages: ChatMessage[],
    options: {
      model?: string;
      temperature?: number;
      apiBaseUrl?: string;
      apiKey?: string;
      timeout?: number;
    }
  ) => Promise<unknown>;
};

type EditPlanRunParams = {
  agent: AgentLike;
  model?: string;
  messages: ChatMessage[];
  nodeIndex: NodeIndex;
  groupId?: string;
  userId?: string;
  apiBaseUrl?: string;
  apiKey?: string;
};

type TeachingExample = { inputXml?: string; planXml?: string };

type PresetTeachingOptions = {
  agent?: AgentLike;
  userId?: string;
  groupId?: string;
  chatType?: string;
  presetJson?: PresetJson;
  conversationText?: string;
  presetSourceFileName?: string;
};

const logger = createLogger('PresetTeaching');

const PROMPTS_CONFIG_PATH = path.resolve('./sentra-prompts/sentra.config.json');
let cachedPresetTeachingSystemPrompt: string | null = null;

async function getPresetTeachingSystemPrompt(vars: Record<string, unknown> = {}): Promise<string> {
  try {
    if (cachedPresetTeachingSystemPrompt) {
      return renderTemplate(cachedPresetTeachingSystemPrompt, vars);
    }
    const system = await SentraPromptsSDK(
      "{{sentra_preset_teaching_prompt_system}}",
      PROMPTS_CONFIG_PATH
    );
    if (system) {
      cachedPresetTeachingSystemPrompt = system;
      return renderTemplate(system, vars);
    }
  } catch (e) {
    logger.warn('PresetTeaching: 加载 preset_teaching prompt 失败，将使用简化回退文案', {
      err: String(e)
    });
  }
  return 'You are an internal Sentra XML sub-agent responsible for MAINTAINING the BOT\'s agent preset JSON.';
}

function parseWhitelist(raw: string | null | undefined): WhitelistConfig {
  const text = (raw || '').trim();
  if (!text) return { mode: 'off', set: new Set() };
  if (text === '*') return { mode: 'all', set: new Set() };
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  return { mode: 'list', set: new Set(parts) };
}

function isUserInWhitelist(userId: string | number | null | undefined, config: WhitelistConfig): boolean {
  if (!userId) return false;
  const id = String(userId);
  if (!config || config.mode === 'off') return false;
  if (config.mode === 'all') return true;
  return config.set.has(id);
}

function clonePreset(presetJson: PresetJson): PresetJson | null {
  try {
    return JSON.parse(JSON.stringify(presetJson));
  } catch {
    return null;
  }
}

function parsePath(path: string): Array<string | number> {
  const result: Array<string | number> = [];
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

function getParentAndKey(
  target: Record<string, unknown> | unknown[],
  pathArr: Array<string | number>
): { parent: Record<string, unknown> | unknown[]; lastKey: string | number } | null {
  if (!target || typeof target !== 'object') return null;
  if (!Array.isArray(pathArr) || pathArr.length === 0) return null;
  let parent: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const key = pathArr[i];
    if (key === undefined) return null;
    if (typeof key === 'number') {
      if (!Array.isArray(parent) || key < 0 || key >= parent.length) return null;
      parent = parent[key] as Record<string, unknown> | unknown[];
    } else {
      if (Array.isArray(parent)) return null;
      const parentObj = parent as Record<string, unknown>;
      if (parentObj[key] === undefined || parentObj[key] === null || typeof parentObj[key] !== 'object') {
        parentObj[key] = {};
      }
      parent = parentObj[key] as Record<string, unknown> | unknown[];
    }
  }
  const lastKey = pathArr[pathArr.length - 1];
  if (lastKey === undefined) return null;
  return { parent, lastKey };
}

function applyOperation(base: Record<string, unknown> | unknown[], op: PresetOperation): boolean {
  if (!op || typeof op !== 'object') return false;
  const type = String(op.op || '').toLowerCase();
  const pathStr = typeof op.path === 'string' ? op.path : '';
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
    if (!Array.isArray(parent) && typeof lastKey === 'string') {
      const parentObj = parent as Record<string, unknown>;
      parentObj[lastKey] = value;
      return true;
    }
    return false;
  }

  if (type === 'update') {
    if (Array.isArray(parent)) {
      if (typeof lastKey !== 'number' || lastKey < 0 || lastKey >= parent.length) return false;
      parent[lastKey] = value;
      return true;
    }
    if (!Array.isArray(parent) && typeof lastKey === 'string') {
      const parentObj = parent as Record<string, unknown>;
      if (!(lastKey in parentObj)) return false;
      parentObj[lastKey] = value;
      return true;
    }
    return false;
  }

  if (type === 'delete') {
    if (Array.isArray(parent)) {
      if (typeof lastKey !== 'number' || lastKey < 0 || lastKey >= parent.length) return false;
      parent.splice(lastKey, 1);
      return true;
    }
    if (!Array.isArray(parent) && typeof lastKey === 'string') {
      const parentObj = parent as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(parentObj, lastKey)) {
        delete parentObj[lastKey];
        return true;
      }
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
    if (!Array.isArray(parent) && typeof lastKey === 'string') {
      const parentObj = parent as Record<string, unknown>;
      if (!(lastKey in parentObj)) {
        if (typeof value === 'boolean') {
          parentObj[lastKey] = value;
          return true;
        }
        return false;
      }
      if (typeof parentObj[lastKey] === 'boolean') {
        parentObj[lastKey] = !parentObj[lastKey];
        return true;
      }
      if (typeof value === 'boolean') {
        parentObj[lastKey] = value;
        return true;
      }
      return false;
    }
    return false;
  }

  return false;
}

function applyOperations(presetJson: PresetJson, operations: PresetOperation[] = []): PresetJson | null {
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

function pathPartsToString(parts: Array<string | number>): string {
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
function truncatePreview(value: unknown, maxLen?: number): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!maxLen || maxLen <= 0 || text.length <= maxLen) return text;
  return text.substring(0, maxLen);
}

function buildTeachingNodesFromPreset(presetJson: PresetJson): { nodes: TeachingNode[]; indexById: NodeIndex } {
  const nodes: TeachingNode[] = [];
  const indexById: NodeIndex = Object.create(null) as NodeIndex;

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
  function walkParamNode(node: unknown, parts: Array<string | number>, depth = 0) {
    if (!node) return;
    if (depth > 5) return;
    const t = typeof node;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      const path = pathPartsToString(parts);
      if (!path) return;
      const idSuffix = path.startsWith('parameters.')
        ? path.substring('parameters.'.length)
        : path;
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
      const obj = node as Record<string, unknown>;
      for (const key of Object.keys(obj || {})) {
        walkParamNode(obj[key], [...parts, key], depth + 1);
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

function buildEditablePathsSummaryFromNodes(nodes: TeachingNode[]): string {
  if (!Array.isArray(nodes) || !nodes.length) return '';
  const seen = new Set();
  const paths: string[] = [];
  for (const n of nodes) {
    const p = n && n.path;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
    if (paths.length >= 200) break;
  }
  return paths.map((p) => `- ${p}`).join('\n');
}

function buildTeachingInputXml({ nodes, conversationText }: { nodes: TeachingNode[]; conversationText: string }): string {
  const lines: string[] = [];
  const list = Array.isArray(nodes) ? nodes.filter((_, idx) => idx < 64) : [];

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

function extractFirstTagBlock(text: string, tagName: string): string | null {
  if (!text) return null;
  // 允许关闭标签前存在空格，例如 </tagName >
  const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, 'i');
  const m = text.match(re);
  return m ? m[0] : null;
}

function extractTagText(xml: string, tagName: string): string {
  if (!xml) return '';
  // 同样允许关闭标签前存在空格
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\/${tagName}\\s*>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  const raw = m[1];
  const text = unescapeXml(raw);
  return text.trim();
}

function castValueForNode(raw: string, node: TeachingNode): string | number | boolean {
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

function findNodeForTarget(nodeIndex: NodeIndex, rawId: string | number): TeachingNode | null {
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
  const variants = new Set<string>();
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

function parseEditPlanXml(text: string, nodeIndex: NodeIndex): EditPlanParseResult {
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

  const operations: PresetOperation[] = [];
  const unknownTargets: string[] = [];
  const nodesList: TeachingNode[] = nodeIndex && Array.isArray(nodeIndex.__nodes) ? nodeIndex.__nodes : [];

  for (const block of opBlocks) {
    // 新版 schema：edit_type / target_index / target_id / new_value / change_reason
    const typeRaw = extractTagText(block, 'edit_type');
    const indexRaw = extractTagText(block, 'target_index');
    const nodeIdRaw = extractTagText(block, 'target_id');
    if (!typeRaw || (!indexRaw && !nodeIdRaw)) continue;

    const editType = typeRaw.trim().toLowerCase();
    if (!['add', 'update', 'delete', 'toggle'].includes(editType)) continue;

    let node: TeachingNode | null = null;

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

  if (!operations || operations.length === 0) {
    // 额外输出一些调试信息，帮助定位 index/id 匹配问题
    try {
      const perOperation: Array<{
        editTypeRaw: string;
        indexRaw: string;
        nodeIdRaw: string;
        resolvedPath: string | null;
        resolvedId: string | null;
        blockPreview: string;
      }> = [];
      try {
        const maxDebugOps = 8;
        const limitedBlocks = Array.isArray(opBlocks)
          ? opBlocks.filter((_, idx) => idx < maxDebugOps)
          : [];
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
            blockPreview: blockStr.length > 200 ? blockStr.substring(0, 200) : blockStr
          });
        }
      } catch { }

      const debugSnapshot = {
        decision,
        opBlockCount: opBlocks.length,
        nodeCount: nodesList.length,
        unknownTargets,
        samplePaths: Array.isArray(nodesList)
          ? nodesList.filter((_, idx) => idx < 80).map((n, idx) => ({ index: idx + 1, id: n.id, path: n.path }))
          : [],
        // 仅截取前若干个 edit_operation 块作参考，避免日志过长
        opBlocksPreview: opBlocks.filter((_, idx) => idx < 4),
        perOperation
      };
      logger.warn('PresetTeaching: parseEditPlanXml: no operations resolved', debugSnapshot);
    } catch { }

    const detail = unknownTargets.length
      ? `no valid <edit_operation> entries with known target node (index/id); unknown=${JSON.stringify(unknownTargets)}`
      : 'no valid <edit_operation> entries with known target node (index/id)';
    return { operations: null, error: detail };
  }

  return { operations, error: null };
}

async function runEditPlanWithRetry({
  agent,
  model,
  messages,
  nodeIndex,
  groupId,
  userId,
  apiBaseUrl,
  apiKey
}: EditPlanRunParams): Promise<{ operations: PresetOperation[] | null; error: string | null; raw: string }> {
  const maxAttempts = 2;
  let lastError = '';
  let lastRaw = '';

  const timeout = getEnvTimeoutMs(
    'AGENT_PRESET_TEACHING_TIMEOUT_MS',
    getEnvTimeoutMs('TIMEOUT', 180000, 900000),
    900000
  );
  let operations: PresetOperation[] | null = null;
  let workingMessages = messages;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let reply;
    try {
      const chatOptions: {
        model?: string;
        temperature?: number;
        apiBaseUrl?: string;
        apiKey?: string;
        timeout?: number;
      } = { temperature: 0, timeout };
      if (model) chatOptions.model = model;
      if (apiBaseUrl) chatOptions.apiBaseUrl = apiBaseUrl;
      if (apiKey) chatOptions.apiKey = apiKey;

      reply = await agent.chat(workingMessages, chatOptions);
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

    workingMessages = [
      ...workingMessages,
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
    const rawSnippet = typeof lastRaw === 'string' && lastRaw.length > 800
      ? lastRaw.substring(0, 800)
      : (lastRaw || '');
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
export async function maybeTeachPreset(options: PresetTeachingOptions = {}): Promise<PresetJson | null> {
  const {
    agent,
    userId,
    groupId,
    chatType,
    presetJson,
    conversationText,
    presetSourceFileName
  } = options;

  const enabled = getEnvBool('AGENT_PRESET_TEACHING_ENABLED', false);
  if (!enabled) return null;

  if (!agent || typeof agent.chat !== 'function') return null;
  if (!presetJson || typeof presetJson !== 'object' || Array.isArray(presetJson)) return null;

  const wlConfig = parseWhitelist(getEnv('AGENT_PRESET_TEACHING_WHITELIST', ''));
  if (!isUserInWhitelist(userId, wlConfig)) {
    return null;
  }

  const model = getEnv('AGENT_PRESET_TEACHING_MODEL', getEnv('MAIN_AI_MODEL'));
  const teachingBaseUrl = getEnv('AGENT_PRESET_TEACHING_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1'));
  const teachingApiKey = getEnv('AGENT_PRESET_TEACHING_API_KEY', getEnv('API_KEY'));
  const historyText = typeof conversationText === 'string' ? conversationText : '';

  const { nodes, indexById } = buildTeachingNodesFromPreset(presetJson);
  if (!Array.isArray(nodes) || nodes.length === 0) {
    logger.info('PresetTeaching: 当前预设中未检测到可编辑节点，跳过教导');
    return null;
  }

  const inputXml = buildTeachingInputXml({ nodes, conversationText: historyText });
  const editablePathsSummary = buildEditablePathsSummaryFromNodes(nodes);

  const systemPrompt = await getPresetTeachingSystemPrompt({
    editablePathsSummary: editablePathsSummary || '(no editable paths summary)'
  });

  const fewShotExamples = await getRecentPresetTeachingExamples(
    undefined,
    presetSourceFileName
  );

  const messages: ChatMessage[] = [];
  messages.push({ role: 'system', content: systemPrompt });

  if (Array.isArray(fewShotExamples) && fewShotExamples.length > 0) {
    for (const ex of fewShotExamples) {
      if (!ex) continue;

      const exInputText =
        typeof ex.inputXml === 'string' && ex.inputXml.trim() ? ex.inputXml.trim() : '';
      const exPlanText =
        typeof ex.planXml === 'string' && ex.planXml.trim() ? ex.planXml.trim() : '';

      // 只复用包含标准根标签的教学样本，避免污染 few-shot 上下文
      if (!exInputText || !exInputText.includes('<sentra-agent-preset-edit-input')) {
        continue;
      }
      if (!exPlanText || !exPlanText.includes('<sentra-agent-preset-edit-plan')) {
        continue;
      }

      messages.push({ role: 'user', content: exInputText });
      messages.push({ role: 'assistant', content: exPlanText });
    }
  }

  messages.push({ role: 'user', content: inputXml });

  logger.info('PresetTeaching: 开始教导检查(XML 工作流)', {
    groupId,
    userId,
    model,
    nodeCount: nodes.length
  });

  const runParams: EditPlanRunParams = {
    agent,
    messages,
    nodeIndex: indexById
  };
  if (model) runParams.model = model;
  if (typeof groupId === 'string') runParams.groupId = groupId;
  if (typeof userId === 'string') runParams.userId = userId;
  if (teachingBaseUrl) runParams.apiBaseUrl = teachingBaseUrl;
  if (teachingApiKey) runParams.apiKey = teachingApiKey;

  const { operations, error, raw } = await runEditPlanWithRetry(runParams);

  if (error) {
    logger.warn('PresetTeaching: XML 编辑计划解析失败，跳过教导', {
      groupId,
      userId,
      error
    });
    return null;
  }

  if (!operations || operations.length === 0) {
    logger.info('PresetTeaching: 本轮未检测到需要修改预设的指令');
    return null;
  }

  const appliedOperations = operations as PresetOperation[];
  const updated = applyOperations(presetJson, appliedOperations);
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
      operations: appliedOperations,
      presetMetaBefore: presetJson && typeof presetJson.meta === 'object' ? presetJson.meta : null,
      presetMetaAfter: updated && typeof updated.meta === 'object' ? updated.meta : null
    });
  } catch (e) {
    logger.warn('PresetTeaching: 写入教导日志失败', { err: String(e) });
  }

  try {
    const planXmlBlock =
      typeof raw === 'string'
        ? extractFirstTagBlock(raw, 'sentra-agent-preset-edit-plan')
        : null;

    if (!planXmlBlock || !planXmlBlock.includes('<sentra-agent-preset-edit-plan')) {
      logger.debug(
        'PresetTeaching: skip caching teaching example, invalid or missing <sentra-agent-preset-edit-plan> block'
      );
    } else if (planXmlBlock.includes('```')) {
      // 防御性处理：若模型错误包裹为 markdown 代码块，则不进入示例缓存
      logger.debug(
        'PresetTeaching: skip caching teaching example, edit-plan XML contains code fences'
      );
    } else if (inputXml) {
      await pushPresetTeachingExample(
        {
          time: new Date().toISOString(),
          userId,
          groupId,
          chatType,
          model,
          presetSourceFileName: presetSourceFileName || '',
          inputXml,
          planXml: planXmlBlock
        },
        presetSourceFileName
      );
    }
  } catch (e) {
    logger.debug('PresetTeaching: push teaching example to Redis failed', { err: String(e) });
  }

  logger.success('PresetTeaching: 预设已生成新的 JSON（内存态，尚未写回磁盘）');
  return updated;
}
