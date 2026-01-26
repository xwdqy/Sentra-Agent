// SDK entry: simple function-call API for plan-then-execute with streaming
// Consumers can import SentraMcpSDK and use runOnce() or stream()

import MCPCore from '../mcpcore/index.js';
import { planThenExecute, planThenExecuteStream } from '../agent/planners.js';
import { cancelRun } from '../bus/runCancel.js';
import { startHotReloadWatchers } from '../config/hotReload.js';
import fs from 'node:fs/promises';
import path from 'node:path';

function escapeXmlEntities(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

function formatRequiredHint(schema = {}) {
  try {
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    const groups = extractRequiredGroups(schema);
    const baseKey = JSON.stringify(required.slice().sort());
    const conditionalGroups = groups
      .map((g) => ({ g, key: JSON.stringify(g.slice().sort()) }))
      .filter((x) => x.g.length && x.key !== baseKey)
      .map((x) => x.g);
    return { required, conditionalGroups };
  } catch {
    return { required: [], conditionalGroups: [] };
  }
}

const CIRCLED_NUMS = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];
function circledNum(n) {
  const idx = Number(n) - 1;
  if (idx >= 0 && idx < CIRCLED_NUMS.length) return CIRCLED_NUMS[idx];
  return `(${n})`;
}

function toMarkdownCatalog(items = []) {
  const lines = ['# Sentra MCP 工具清单', '', `**可用工具总数**: ${items.length}`, '---', ''];
  for (const t of items) {
    lines.push(`### ${t.name} (${t.aiName})`);
    
    if (t.meta?.realWorldAction) {
      lines.push(`**映射真实能力**: ${t.meta.realWorldAction}`);
    }
    
    lines.push(`**描述**: ${t.description || '(无描述)'}`);
    lines.push(`**提供者**: ${t.provider}${t.serverId ? ` | serverId: ${t.serverId}` : ''}`);
    
    const schema = t.inputSchema || {};
    const { required, conditionalGroups } = formatRequiredHint(schema);
    if (!required.length && !conditionalGroups.length) {
      lines.push('**必填参数**: (无)');
    } else {
      lines.push('**必填参数**:');
      let idx = 1;
      for (const r of required) {
        lines.push(`${idx}. ${r}`);
        idx++;
      }
      if (conditionalGroups.length) {
        const options = conditionalGroups
          .map((g, i) => `${circledNum(i + 1)}[${g.join(', ')}]`)
          .join(' ');
        lines.push(`${idx}. 任选其一：${options}`);
      }
    }
    
    lines.push(`**超时(ms)**: ${t.timeoutMs}ms`);
    
    // 元信息
    if (t.meta && Object.keys(t.meta).length) {
      if (t.meta.responseStyle) {
        lines.push(`**回复格式**: ${t.meta.responseStyle}`);
      }
      if (t.meta.responseExample) {
        lines.push('**示例回复**:');
        const ex = String(t.meta.responseExample).split('\n').map((l) => `  ${l}`);
        lines.push(...ex);
      }
    }
    
    lines.push('');
  }
  return lines.join('\n');
}

function toXmlCatalog(items = []) {
  const lines = [];
  lines.push('<sentra-mcp-tools>');
  lines.push(
    `  <summary>${escapeXmlEntities(`共有 ${items.length} 个 MCP 工具可用。以下清单仅供参考，请严格遵守每个工具描述的能力边界和使用场景。`)}</summary>`
  );

  items.forEach((t, idx) => {
    if (!t) return;
    const index = idx + 1;
    const aiName = t.aiName || '';
    const name = t.name || '';
    const provider = t.provider || '';
    const serverId = t.serverId || '';
    const desc = t.description || '';
    const real = (t.meta && t.meta.realWorldAction) || '';
    const cooldown = t.cooldownMs != null ? String(t.cooldownMs) : '';
    const timeout = t.timeoutMs != null ? String(t.timeoutMs) : '';
    const schema = t.inputSchema || {};
    const { required, conditionalGroups } = formatRequiredHint(schema);
    const reqLine = required.length ? required.join(', ') : '(无)';
    const condLine = conditionalGroups.length
      ? `anyOf/oneOf: one of ${conditionalGroups.map((g) => `[${g.join(', ')}]`).join(' OR ')}`
      : '';
    const responseStyle = (t.meta && t.meta.responseStyle) || '';
    const responseExample =
      t.meta && t.meta.responseExample != null ? String(t.meta.responseExample) : '';

    lines.push(`  <tool index="${escapeXmlEntities(index)}">`);
    if (aiName) lines.push(`    <ai_name>${escapeXmlEntities(aiName)}</ai_name>`);
    if (name) lines.push(`    <name>${escapeXmlEntities(name)}</name>`);
    if (provider) lines.push(`    <provider>${escapeXmlEntities(provider)}</provider>`);
    if (serverId) lines.push(`    <server_id>${escapeXmlEntities(serverId)}</server_id>`);
    if (desc) lines.push(`    <description>${escapeXmlEntities(desc)}</description>`);
    if (real) lines.push(`    <real_world_action>${escapeXmlEntities(real)}</real_world_action>`);
    if (reqLine && reqLine !== '(无)') lines.push(`    <required_params>${escapeXmlEntities(reqLine)}</required_params>`);
    if (condLine) lines.push(`    <conditional_required>${escapeXmlEntities(condLine)}</conditional_required>`);
    if (cooldown) lines.push(`    <cooldown_ms>${escapeXmlEntities(cooldown)}</cooldown_ms>`);
    if (timeout) lines.push(`    <timeout_ms>${escapeXmlEntities(timeout)}</timeout_ms>`);
    if (responseStyle || responseExample) {
      lines.push('    <meta>');
      if (responseStyle) lines.push(`      <response_style>${escapeXmlEntities(responseStyle)}</response_style>`);
      if (responseExample) lines.push(`      <response_example>${escapeXmlEntities(responseExample)}</response_example>`);
      lines.push('    </meta>');
    }
    lines.push('  </tool>');
  });

  lines.push('</sentra-mcp-tools>');
  return lines.join('\n');
}
/**
 * Sentra SDK wrapper
 *
 * Usage:
 *   const sdk = new SentraMcpSDK();
 *   await sdk.init();
 *   const res = await sdk.runOnce({ objective, conversation, context });
 *   for await (const ev of sdk.stream({ objective, conversation, context })) { ... }
 */
export class SentraMcpSDK {
  /**
   * @param {{ mcpcore?: MCPCore }} [options]
   */
  constructor(options = {}) {
    this.mcpcore = options.mcpcore || new MCPCore();
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    await this.mcpcore.init();
    // 启动 .env / 插件 .env 热更新监控（只会在进程内启动一次）
    startHotReloadWatchers(this.mcpcore);
    this._initialized = true;
  }

  /**
   * Run plan-then-execute once and return the final result.
   * @param {{ objective: string, conversation?: Array<{role:string,content:any}>, context?: object, overlays?: Record<string, any>, promptOverlays?: Record<string, any> }} params
   * overlays/promptOverlays: per-stage system overlays, e.g. { global: '...', plan: '...', emit_plan: '...', judge: '...', arggen: '...', final_judge: '...', final_summary: '...' }
   * @returns {Promise<import('../utils/result.js').Result>}
   */
  async runOnce({ objective, conversation, context = {}, overlays, promptOverlays, channelId, identityKey }) {
    await this.init();
    const ov = promptOverlays || overlays;
    const ctx0 = (context && typeof context === 'object') ? context : {};
    const ctx1 = (channelId != null || identityKey != null)
      ? { ...ctx0, ...(channelId != null ? { channelId } : {}), ...(identityKey != null ? { identityKey } : {}) }
      : ctx0;
    const ctx = ov ? { ...ctx1, promptOverlays: { ...(ctx1.promptOverlays || {}), ...ov } } : ctx1;
    return planThenExecute({ objective, context: ctx, mcpcore: this.mcpcore, conversation });
  }

  /**
   * List available tools.
   * @param {{ detailed?: boolean }} [opts]
   * @returns {Promise<Array<object>>}
   */
  async listTools(opts = {}) {
    await this.init();
    const detailed = opts.detailed !== false;
    return detailed ? this.mcpcore.getAvailableToolsDetailed() : this.mcpcore.getAvailableTools();
  }

  /**
   * Call a single MCP tool directly by aiName, bypassing planning.
   * @param {{ aiName: string, args?: object, context?: object }} params
   * @returns {Promise<any>}
   */
  async callTool({ aiName, args = {}, context = {} }) {
    await this.init();
    if (!aiName) {
      throw new Error('callTool requires aiName');
    }
    const ctx = context && typeof context === 'object' ? context : {};
    return this.mcpcore.callByAIName(aiName, args || {}, ctx);
  }

  /**
   * Export available tools to JSON / Markdown / XML.
   * If outputPath is provided, writes to disk; otherwise returns content.
   * @param {{ format?: 'json'|'md'|'markdown'|'xml', outputPath?: string, pretty?: number }} [opts]
   */
  async exportTools(opts = {}) {
    await this.init();
    const format = (opts.format || 'json').toLowerCase();
    const pretty = Number.isFinite(opts.pretty) ? Number(opts.pretty) : 2;
    const items = this.mcpcore.getAvailableToolsDetailed();
    let content;
    if (format === 'json') {
      content = JSON.stringify(items, null, pretty);
    } else if (format === 'md' || format === 'markdown') {
      content = toMarkdownCatalog(items);
    } else if (format === 'xml') {
      content = toXmlCatalog(items);
    } else {
      throw new Error(`Unsupported format: ${opts.format}`);
    }
    if (opts.outputPath) {
      const abs = path.resolve(String(opts.outputPath));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
      return { outputPath: abs, count: items.length };
    }
    return { content, count: items.length };
  }

  /**
   * Stream events for a run as an async iterator.
   * @param {{ objective: string, conversation?: Array<{role:string,content:any}>, context?: object, overlays?: Record<string, any>, promptOverlays?: Record<string, any> }} params
   * @returns {AsyncIterable<any>}
   */
  stream({ objective, conversation, context = {}, overlays, promptOverlays, channelId, identityKey }) {
    const self = this;
    async function* gen() {
      await self.init();
      const ov = promptOverlays || overlays;
      const ctx0 = (context && typeof context === 'object') ? context : {};
      const ctx1 = (channelId != null || identityKey != null)
        ? { ...ctx0, ...(channelId != null ? { channelId } : {}), ...(identityKey != null ? { identityKey } : {}) }
        : ctx0;
      const ctx = ov ? { ...ctx1, promptOverlays: { ...(ctx1.promptOverlays || {}), ...ov } } : ctx1;
      for await (const ev of planThenExecuteStream({ objective, context: ctx, mcpcore: self.mcpcore, conversation })) {
        yield ev;
      }
    }
    return gen();
  }

  /**
   * Stream with callback helper. Returns controller with stop() and a completion promise.
   * Note: stop() only stops event consumption; the underlying run will continue to finish.
   * @param {{ objective: string, conversation?: Array<{role:string,content:any}>, context?: object, overlays?: Record<string, any>, promptOverlays?: Record<string, any>, onEvent: (ev:any)=>void }} params
   */
  async streamWithCallback({ objective, conversation, context = {}, overlays, promptOverlays, onEvent, channelId, identityKey }) {
    await this.init();
    let stopped = false;
    const done = (async () => {
      try {
        const ov = promptOverlays || overlays;
        const ctx0 = (context && typeof context === 'object') ? context : {};
        const ctx1 = (channelId != null || identityKey != null)
          ? { ...ctx0, ...(channelId != null ? { channelId } : {}), ...(identityKey != null ? { identityKey } : {}) }
          : ctx0;
        const ctx = ov ? { ...ctx1, promptOverlays: { ...(ctx1.promptOverlays || {}), ...ov } } : ctx1;
        for await (const ev of planThenExecuteStream({ objective, context: ctx, mcpcore: this.mcpcore, conversation })) {
          if (stopped) break;
          try { onEvent?.(ev); } catch {}
        }
      } catch (e) {
        // surface errors via rejection so callers can await .done
        throw e;
      }
    })();
    return {
      stop() { stopped = true; },
      done,
    };
  }

  /**
   * 标记指定 runId 的运行为取消状态。
   * 实际效果由执行器在内部轮询 isRunCancelled(runId) 后尽快停止调度新步骤。
   * @param {string} runId
   */
  cancelRun(runId) {
    try {
      cancelRun(runId);
    } catch {}
  }
}

export default SentraMcpSDK;