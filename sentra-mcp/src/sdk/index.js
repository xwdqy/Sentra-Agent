// SDK entry: simple function-call API for plan-then-execute with streaming
// Consumers can import SentraMcpSDK and use runOnce() or stream()

import MCPCore from '../mcpcore/index.js';
import { planThenExecute, planThenExecuteStream } from '../agent/planners.js';
import { cancelRun } from '../bus/runCancel.js';
import { RunEvents } from '../bus/runEvents.js';
import { startHotReloadWatchers } from '../config/hotReload.js';
import { HistoryStore } from '../history/store.js';
import { runTerminalTask as runTerminalTaskRuntime } from '../runtime/terminal/manager.js';
import { dispatchActionRequest } from '../agent/controllers/action_dispatch_controller.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { truncateTextByTokens } from '../utils/tokenizer.js';

function toXmlCData(text) {
  const s = String(text ?? '');
  return s.replace(/]]>/g, ']]]]><![CDATA[>');
}

const __defaultCore = new MCPCore();
const sdkXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false
});

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

const CIRCLED_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
function circledNum(n) {
  const idx = Number(n) - 1;
  if (idx >= 0 && idx < CIRCLED_NUMS.length) return CIRCLED_NUMS[idx];
  return `(${n})`;
}

function toMarkdownCatalog(items = []) {
  const includeSkillMarkdown = String(process.env.MCP_EXPORT_INCLUDE_SKILL_MARKDOWN || '').trim().toLowerCase();
  const includeFull = includeSkillMarkdown === '1' || includeSkillMarkdown === 'true' || includeSkillMarkdown === 'on' || includeSkillMarkdown === 'yes';
  const lines = ['# Sentra MCP 工具清单', '', `**可用工具总数**: ${items.length}`, '---', ''];
  for (const t of items) {
    lines.push(`### ${t.name} (${t.aiName})`);

    const skill = t.skillDoc && typeof t.skillDoc === 'object' ? t.skillDoc : null;
    const attrs = skill && skill.attributes && typeof skill.attributes === 'object' ? skill.attributes : {};
    const rawMd = typeof skill?.raw === 'string' ? skill.raw : '';
    void attrs;

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

    if (includeFull && rawMd) {
      lines.push('**技能文档(skill.md)**:');
      lines.push('');
      lines.push(rawMd);
    }

    lines.push('');
  }
  return lines.join('\n');
}

function toXmlCatalog(items = []) {
  const includeSkillMarkdown = String(process.env.MCP_EXPORT_INCLUDE_SKILL_MARKDOWN || '').trim().toLowerCase();
  const includeFull = includeSkillMarkdown === '1' || includeSkillMarkdown === 'true' || includeSkillMarkdown === 'on' || includeSkillMarkdown === 'yes';
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
    const skill = t.skillDoc && typeof t.skillDoc === 'object' ? t.skillDoc : null;
    const attrs = skill && skill.attributes && typeof skill.attributes === 'object' ? skill.attributes : {};
    const cooldown = t.cooldownMs != null ? String(t.cooldownMs) : '';
    const timeout = t.timeoutMs != null ? String(t.timeoutMs) : '';
    const schema = t.inputSchema || {};
    const { required, conditionalGroups } = formatRequiredHint(schema);
    const reqLine = required.length ? required.join(', ') : '(无)';
    const condLine = conditionalGroups.length
      ? `anyOf/oneOf: one of ${conditionalGroups.map((g) => `[${g.join(', ')}]`).join(' OR ')}`
      : '';
    const rawMd = typeof skill?.raw === 'string' ? skill.raw : '';
    void attrs;

    lines.push(`  <tool index="${escapeXmlEntities(index)}">`);
    if (aiName) lines.push(`    <ai_name>${escapeXmlEntities(aiName)}</ai_name>`);
    if (name) lines.push(`    <name>${escapeXmlEntities(name)}</name>`);
    if (provider) lines.push(`    <provider>${escapeXmlEntities(provider)}</provider>`);
    if (serverId) lines.push(`    <server_id>${escapeXmlEntities(serverId)}</server_id>`);
    if (desc) lines.push(`    <description>${escapeXmlEntities(desc)}</description>`);
    if (includeFull && rawMd) {
      lines.push('    <skill_markdown><![CDATA[');
      lines.push(`${toXmlCData(String(rawMd))}`);
      lines.push('    ]]></skill_markdown>');
    }
    if (reqLine && reqLine !== '(无)') lines.push(`    <required_params>${escapeXmlEntities(reqLine)}</required_params>`);
    if (condLine) lines.push(`    <conditional_required>${escapeXmlEntities(condLine)}</conditional_required>`);
    if (cooldown) lines.push(`    <cooldown_ms>${escapeXmlEntities(cooldown)}</cooldown_ms>`);
    if (timeout) lines.push(`    <timeout_ms>${escapeXmlEntities(timeout)}</timeout_ms>`);
    lines.push('  </tool>');
  });

  lines.push('</sentra-mcp-tools>');
  return lines.join('\n');
}

function toJsonCatalog(items = []) {
  const includeSkillMarkdown = String(process.env.MCP_EXPORT_INCLUDE_SKILL_MARKDOWN || '').trim().toLowerCase();
  const includeFull = includeSkillMarkdown === '1' || includeSkillMarkdown === 'true' || includeSkillMarkdown === 'on' || includeSkillMarkdown === 'yes';

  return (items || []).map((t) => {
    const skill = t && t.skillDoc && typeof t.skillDoc === 'object' ? t.skillDoc : null;
    const rawMd = typeof skill?.raw === 'string' ? skill.raw : '';
    const schema = t?.inputSchema || {};
    const { required, conditionalGroups } = formatRequiredHint(schema);

    return {
      aiName: t?.aiName || '',
      name: t?.name || '',
      description: t?.description || '',
      provider: t?.provider || '',
      serverId: t?.serverId || undefined,
      scope: t?.scope || 'global',
      tenant: t?.tenant || 'default',
      cooldownMs: Number(t?.cooldownMs || 0),
      timeoutMs: Number(t?.timeoutMs || 0),
      inputSchema: schema,
      requiredParams: required,
      conditionalRequired: conditionalGroups,
      skill: {
        markdown: includeFull ? (rawMd || undefined) : undefined,
        updatedAt: skill?.updatedAt || undefined,
        path: skill?.path || undefined,
      },
    };
  });
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
    this.mcpcore = options.mcpcore || __defaultCore;
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
   * @param {{ objective: string, conversation?: Array<{role:string,content:any}>, context?: object, overlays?: Record<string, any>, promptOverlays?: Record<string, any>, forceNeedTools?: boolean, externalReasons?: string[] }} params
   * overlays/promptOverlays: per-stage system overlays, e.g. { global: '...', plan: '...', emit_plan: '...', judge: '...', arggen: '...', final_judge: '...', final_summary: '...' }
   * @returns {Promise<import('../utils/result.js').Result>}
   */
  async runOnce({ objective, conversation, context = {}, overlays, promptOverlays, channelId, identityKey, forceNeedTools, externalReasons }) {
    await this.init();
    const ov = promptOverlays || overlays;
    const ctx0 = (context && typeof context === 'object') ? context : {};
    const ctx1 = (channelId != null || identityKey != null)
      ? { ...ctx0, ...(channelId != null ? { channelId } : {}), ...(identityKey != null ? { identityKey } : {}) }
      : ctx0;
    const normalizedReasons = this._normalizeExternalReasons(
      Array.isArray(externalReasons) && externalReasons.length > 0
        ? externalReasons
        : ctx1?.externalReasons
    );
    const ctx2 = normalizedReasons.length > 0 ? { ...ctx1, externalReasons: normalizedReasons } : ctx1;
    const ctx = ov ? { ...ctx2, promptOverlays: { ...(ctx2.promptOverlays || {}), ...ov } } : ctx2;
    return planThenExecute({ objective, context: ctx, mcpcore: this.mcpcore, conversation, forceNeedTools });
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
   * Unified action dispatch entrypoint.
   * Request format:
   * {
   *   runId, stepId, stepIndex, executionIndex, attemptNo,
   *   action: { aiName, executor: 'mcp'|'sandbox', actionRef },
   *   input: { args: {...} }
   * }
   * Returns MCP-style result plus normalized actionResult evidence payload.
   */
  async dispatchAction({ request = {}, context = {}, executionOptions = {} } = {}) {
    await this.init();
    return dispatchActionRequest({
      mcpcore: this.mcpcore,
      request,
      context,
      executionOptions
    });
  }

  /**
   * Terminal manager entrypoint.
   * Supports:
   * - JSON args execution: runTerminalTask({ args: { command, ... } })
   * - Natural language inference: runTerminalTask({ request: '...' })
   *
   * @param {string|object} input
   * @param {{
   *   executionOptions?: {
   *     onEvent?: (event:any)=>void,
   *     onStream?: (event:any)=>void,
   *     token?: string,
   *     httpBase?: string,
   *     baseUrl?: string,
   *     signal?: AbortSignal
   *   }
   * }} [options]
   * @returns {Promise<import('../utils/result.js').Result>}
   */
  async runTerminalTask(input = {}, options = {}) {
    return runTerminalTaskRuntime(input, options);
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
      content = JSON.stringify(toJsonCatalog(items), null, pretty);
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
   * @param {{ objective: string, conversation?: Array<{role:string,content:any}>, context?: object, overlays?: Record<string, any>, promptOverlays?: Record<string, any>, forceNeedTools?: boolean, externalReasons?: string[] }} params
   * @returns {AsyncIterable<any>}
   */
  stream({ objective, conversation, context = {}, overlays, promptOverlays, channelId, identityKey, forceNeedTools, externalReasons }) {
    const self = this;
    async function* gen() {
      await self.init();
      const ov = promptOverlays || overlays;
      const ctx0 = (context && typeof context === 'object') ? context : {};
      const ctx1 = (channelId != null || identityKey != null)
        ? { ...ctx0, ...(channelId != null ? { channelId } : {}), ...(identityKey != null ? { identityKey } : {}) }
        : ctx0;
      const normalizedReasons = self._normalizeExternalReasons(
        Array.isArray(externalReasons) && externalReasons.length > 0
          ? externalReasons
          : ctx1?.externalReasons
      );
      const ctx2 = normalizedReasons.length > 0 ? { ...ctx1, externalReasons: normalizedReasons } : ctx1;
      const ctx = ov ? { ...ctx2, promptOverlays: { ...(ctx2.promptOverlays || {}), ...ov } } : ctx2;
      for await (const ev of planThenExecuteStream({ objective, context: ctx, mcpcore: self.mcpcore, conversation, forceNeedTools })) {
        yield ev;
      }
    }
    return gen();
  }

  /**
   * Stream: execute tools from a single <sentra-tools> XML block directly (bypass planning).
   * It will still emit the same event types (start/judge/plan/args/tool_result/completed/summary)
   * so the upper layer can reuse the existing streaming UI/logics.
   *
   * @param {{ toolsXml: string, objective?: string, conversation?: Array<{role:string,content:any}>, context?: object, overlays?: Record<string, any>, promptOverlays?: Record<string, any>, channelId?: string, identityKey?: string, externalReasons?: string[] }} params
   * @returns {AsyncIterable<any>}
   */
  streamToolsXml({ toolsXml, objective, conversation, context = {}, overlays, promptOverlays, channelId, identityKey, externalReasons }) {
    const self = this;
    async function* gen() {
      await self.init();
      const ov = promptOverlays || overlays;
      const ctx0 = (context && typeof context === 'object') ? context : {};
      const ctx1 = (channelId != null || identityKey != null)
        ? { ...ctx0, ...(channelId != null ? { channelId } : {}), ...(identityKey != null ? { identityKey } : {}) }
        : ctx0;
      const normalizedReasons = self._normalizeExternalReasons(
        Array.isArray(externalReasons) && externalReasons.length > 0
          ? externalReasons
          : ctx1?.externalReasons
      );
      const ctx2 = normalizedReasons.length > 0 ? { ...ctx1, externalReasons: normalizedReasons } : ctx1;
      const ctx = ov ? { ...ctx2, promptOverlays: { ...(ctx2.promptOverlays || {}), ...ov } } : ctx2;
      const obj = (typeof objective === 'string' && objective.trim())
        ? objective
        : `DIRECT_TOOLS_XML_EXECUTION:\n${String(toolsXml || '').trim()}`;

      const { planThenExecuteStreamToolsXml } = await import('../agent/planners.js');
      for await (const ev of planThenExecuteStreamToolsXml({ objective: obj, toolsXml, context: ctx, mcpcore: self.mcpcore, conversation })) {
        yield ev;
      }
    }
    return gen();
  }

  /**
   * Stream with callback helper. Returns controller with stop() and a completion promise.
   * Note: stop() only stops event consumption; the underlying run will continue to finish.
   * @param {{ objective: string, conversation?: Array<{role:string,content:any}>, context?: object, overlays?: Record<string, any>, promptOverlays?: Record<string, any>, forceNeedTools?: boolean, externalReasons?: string[], onEvent: (ev:any)=>void }} params
   */
  async streamWithCallback({ objective, conversation, context = {}, overlays, promptOverlays, onEvent, channelId, identityKey, forceNeedTools, externalReasons }) {
    await this.init();
    let stopped = false;
    const done = (async () => {
      try {
        const ov = promptOverlays || overlays;
        const ctx0 = (context && typeof context === 'object') ? context : {};
        const ctx1 = (channelId != null || identityKey != null)
          ? { ...ctx0, ...(channelId != null ? { channelId } : {}), ...(identityKey != null ? { identityKey } : {}) }
          : ctx0;
        const normalizedReasons = this._normalizeExternalReasons(
          Array.isArray(externalReasons) && externalReasons.length > 0
            ? externalReasons
            : ctx1?.externalReasons
        );
        const ctx2 = normalizedReasons.length > 0 ? { ...ctx1, externalReasons: normalizedReasons } : ctx1;
        const ctx = ov ? { ...ctx2, promptOverlays: { ...(ctx2.promptOverlays || {}), ...ov } } : ctx2;
        for await (const ev of planThenExecuteStream({ objective, context: ctx, mcpcore: this.mcpcore, conversation, forceNeedTools })) {
          if (stopped) break;
          try { onEvent?.(ev); } catch { }
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

  _normalizeExternalReasons(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const item of list) {
      const text = String(item || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push(text.length > 240 ? text.slice(0, 240) : text);
      if (out.length >= 8) break;
    }
    return out;
  }

  _decodeXmlEntities(text) {
    return String(text || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, '\'');
  }

  _extractTextFromProtocolXml(raw) {
    const s = String(raw || '').trim();
    if (!s || !s.startsWith('<')) return '';
    const getText = (node) => {
      if (node == null) return '';
      if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
      if (Array.isArray(node)) return node.map((it) => getText(it)).join('');
      if (typeof node === 'object') {
        if (typeof node['#text'] === 'string') return node['#text'];
        let out = '';
        for (const [k, v] of Object.entries(node)) {
          if (k === '#text') continue;
          out += getText(v);
        }
        return out;
      }
      return '';
    };
    const collectByTag = (node, tagName, out) => {
      if (node == null) return;
      if (Array.isArray(node)) {
        for (const item of node) collectByTag(item, tagName, out);
        return;
      }
      if (typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === '#text') continue;
        if (String(k).toLowerCase() === tagName) {
          const t = this._decodeXmlEntities(getText(v).trim());
          if (t) out.push(t);
        }
        collectByTag(v, tagName, out);
      }
    };
    try {
      const parsed = sdkXmlParser.parse(`<root>${s}</root>`);
      const root = parsed && typeof parsed === 'object' ? parsed.root : null;
      const preview = [];
      collectByTag(root, 'preview_text', preview);
      if (preview.length > 0) return preview.join('\n').trim();
      const texts = [];
      collectByTag(root, 'text', texts);
      if (texts.length > 0) return texts.join('\n').trim();
    } catch { }
    return '';
  }

  _normalizeObjectiveText(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s.startsWith('<')) {
      const fromXml = this._extractTextFromProtocolXml(s);
      if (fromXml) return fromXml;
    }
    return s;
  }

  /**
   * Report assistant responses generated during one task/run.
   * The batch is persisted to run history so MCP can understand what was replied.
   */
  async reportAssistantResponsesBatch({ runId, responses = [], objective = '', reason = 'pipeline_flush', context = {} } = {}) {
    await this.init();
    const rid = String(runId || '').trim();
    if (!rid) return { success: false, code: 'MISSING_RUN_ID', count: 0 };

    const maxContentTokens = 3000;
    const clip = (v, max = 120) => {
      const s = String(v || '').replace(/\s+/g, ' ').trim();
      if (!s) return '';
      return truncateTextByTokens(s, { maxTokens: max, suffix: '...' }).text;
    };
    const clipContent = (v) => {
      const s = String(v || '');
      if (!s) return '';
      return truncateTextByTokens(s, { maxTokens: maxContentTokens, suffix: '\n...[truncated]' }).text;
    };
    const objectivePreviewText = this._normalizeObjectiveText(objective);

    const items = (Array.isArray(responses) ? responses : [])
      .map((it, idx) => {
        const item = (it && typeof it === 'object') ? it : {};
        const content = clipContent(item.content);
        if (!content) return null;
        const tsNum = Number(item.ts);
        const ts = Number.isFinite(tsNum) && tsNum > 0 ? Math.floor(tsNum) : Date.now();
        const phase = String(item.phase || 'unknown').trim() || 'unknown';
        const metaObj = (item.meta && typeof item.meta === 'object') ? item.meta : {};
        return {
          index: idx + 1,
          phase,
          content,
          contentLength: content.length,
          noReply: item.noReply === true,
          delivered: item.delivered === true,
          ts,
          meta: metaObj,
        };
      })
      .filter(Boolean);

    const ctx = (context && typeof context === 'object') ? context : {};
    const payload = {
      type: 'assistant_response_batch',
      reason: String(reason || 'pipeline_flush'),
      objectivePreview: clip(objectivePreviewText, 320),
      count: items.length,
      responses: items,
      context: {
        conversationId: ctx.conversationId != null ? String(ctx.conversationId) : '',
        channelId: ctx.channelId != null ? String(ctx.channelId) : '',
        identityKey: ctx.identityKey != null ? String(ctx.identityKey) : '',
        groupId: ctx.groupId != null ? String(ctx.groupId) : '',
        userId: ctx.userId != null ? String(ctx.userId) : '',
        feedbackRound: Number.isFinite(Number(ctx.feedbackRound)) ? Math.floor(Number(ctx.feedbackRound)) : undefined,
      },
    };

    try { await HistoryStore.append(rid, payload); } catch { }
    try {
      if (typeof RunEvents.emitIfOpen === 'function') {
        RunEvents.emitIfOpen(rid, { runId: rid, ts: Date.now(), ...payload });
      }
    } catch { }
    return { success: true, code: 'OK', runId: rid, count: items.length };
  }

  async reportFeedbackFlushDone({ runId, round = 0, reason = 'feedback_wait', flushedCount = 0, context = {} } = {}) {
    await this.init();
    const rid = String(runId || '').trim();
    if (!rid) return { success: false, code: 'MISSING_RUN_ID' };

    const ctx = (context && typeof context === 'object') ? context : {};
    const r = Number(round);
    const payload = {
      type: 'feedback_flush_done',
      reason: String(reason || 'feedback_wait'),
      round: Number.isFinite(r) ? Math.max(0, Math.floor(r)) : 0,
      flushedCount: Number.isFinite(Number(flushedCount)) ? Math.max(0, Math.floor(Number(flushedCount))) : 0,
      context: {
        conversationId: ctx.conversationId != null ? String(ctx.conversationId) : '',
        channelId: ctx.channelId != null ? String(ctx.channelId) : '',
        identityKey: ctx.identityKey != null ? String(ctx.identityKey) : '',
        groupId: ctx.groupId != null ? String(ctx.groupId) : '',
        userId: ctx.userId != null ? String(ctx.userId) : '',
      },
    };

    try { await HistoryStore.append(rid, payload); } catch { }
    try {
      if (typeof RunEvents.emitIfOpen === 'function') {
        RunEvents.emitIfOpen(rid, { runId: rid, ts: Date.now(), ...payload });
      }
    } catch { }
    return { success: true, code: 'OK', runId: rid };
  }

  async reportUserRuntimeSignal({
    runId,
    objective = '',
    objectiveXml = '',
    source = 'main_runtime_followup',
    reason = '',
    reasonCode = '',
    action = '',
    generation = 0,
    signalSeq = 0,
    sourceEventId = '',
    context = {}
  } = {}) {
    await this.init();
    const rid = String(runId || '').trim();
    if (!rid) return { success: false, code: 'MISSING_RUN_ID' };

    const ctx = (context && typeof context === 'object') ? context : {};
    const objectiveFromText = this._normalizeObjectiveText(objective);
    const objectiveFromXml = this._normalizeObjectiveText(objectiveXml);
    const intentObjective = String(objectiveFromText || objectiveFromXml || '').trim();
    if (!intentObjective) return { success: false, code: 'EMPTY_OBJECTIVE' };
    const objectiveXmlRaw = String(objectiveXml || '').trim();
    const normalizedAction = this._normalizeRuntimeSignalAction(action);
    const generationRaw = Number(generation ?? context?.generation ?? 0);
    const signalSeqRaw = Number(signalSeq ?? context?.signalSeq ?? 0);
    const generationValue = Number.isFinite(generationRaw) && generationRaw > 0
      ? Math.floor(generationRaw)
      : 0;
    const signalSeqValue = Number.isFinite(signalSeqRaw) && signalSeqRaw > 0
      ? Math.floor(signalSeqRaw)
      : 0;
    const reasonCodeText = String(reasonCode || '').trim();
    const sourceEventIdText = String(sourceEventId || '').trim();

    const payload = {
      type: 'user_runtime_signal',
      runId: rid,
      objective: intentObjective,
      ...(objectiveXmlRaw ? { objectiveXml: objectiveXmlRaw } : {}),
      source: String(source || 'main_runtime_followup'),
      reason: String(reason || ''),
      ...(reasonCodeText ? { reasonCode: reasonCodeText } : {}),
      ...(normalizedAction !== 'ignore' ? { action: normalizedAction } : {}),
      ...(generationValue > 0 ? { generation: generationValue } : {}),
      ...(signalSeqValue > 0 ? { signalSeq: signalSeqValue } : {}),
      ...(sourceEventIdText ? { sourceEventId: sourceEventIdText } : {}),
      context: {
        conversationId: ctx.conversationId != null ? String(ctx.conversationId) : '',
        channelId: ctx.channelId != null ? String(ctx.channelId) : '',
        identityKey: ctx.identityKey != null ? String(ctx.identityKey) : '',
        groupId: ctx.groupId != null ? String(ctx.groupId) : '',
        userId: ctx.userId != null ? String(ctx.userId) : '',
        generation: generationValue,
        signalSeq: signalSeqValue,
        conversationState: ctx.conversationState != null ? String(ctx.conversationState) : ''
      }
    };

    try { await HistoryStore.append(rid, payload); } catch { }
    try {
      if (typeof RunEvents.emitIfOpen === 'function') {
        RunEvents.emitIfOpen(rid, { runId: rid, ts: Date.now(), ...payload });
      }
    } catch { }
    return { success: true, code: 'OK', runId: rid };
  }

  _normalizeRuntimeSignalAction(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'cancel') return 'cancel';
    if (s === 'replan') return 'replan';
    if (s === 'supplement') return 'supplement';
    if (s === 'append') return 'append';
    return 'ignore';
  }

  /**
   * Mark one run as cancelled.
   * Actual stop happens when executor checks cancellation state.
   * @param {string} runId
   * @param {object} [meta]
   */
  cancelRun(runId, meta = null) {
    try {
      cancelRun(runId, meta);
    } catch { }
  }
}

export default SentraMcpSDK;
