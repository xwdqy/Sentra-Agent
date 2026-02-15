/**
 * TaskCompletionAnalyzer
 *
 * Responsibilities:
 * - Analyze task completion after MCP/tool execution.
 * - Judge whether the task is truly complete and whether promises remain.
 * - Output sentra-tools XML + JSON + Markdown reports.
 *
 * Version: 1.0.0
 * Created: 2026-02-10
 */

import { createLogger } from '../utils/logger.js';
import { getEnv, getEnvInt, getEnvTimeoutMs } from '../utils/envHotReloader.js';
import { escapeXml } from '../utils/xmlUtils.js';
import { buildSentraResultBlock, buildSentraToolsBlockFromInvocations } from '../utils/protocolUtils.js';
import { randomUUID } from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import SentraPromptsSDK from 'sentra-prompts';
import type { ChatMessage } from '../src/types.js';

const logger = createLogger('TaskCompletionAnalyzer');

type ToolInvocation = {
    aiName?: string;
    args?: Record<string, unknown>;
};

type ToolResult = {
    success?: boolean;
    code?: string;
    error?: string;
    message?: string;
    [key: string]: unknown;
};

type ToolResultEvent = {
    aiName?: string;
    result?: ToolResult;
    [key: string]: unknown;
};

type PromiseItem = {
    content: string;
    fulfilled: boolean;
    evidence: string;
};

type AnalysisResult = {
    status: string;
    summary: string;
    isComplete: boolean;
    confidence: number;
    reason: string;
    promises: PromiseItem[];
    objective?: string;
    finalResponsePreview?: string;
    recoveryCount?: number;
};

type AnalysisMessagesOptions = {
    userObjective?: string | undefined;
    toolInvocations?: ToolInvocation[] | undefined;
    toolResultEvents?: ToolResultEvent[] | undefined;
    finalResponse?: string | undefined;
};

type AnalysisTriggerOptions = {
    agent?: { chat: (messages: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown> };
    groupId?: string | number | null;
    conversationId?: string | null;
    userId?: string | number | null;
    userObjective?: string;
    toolInvocations?: ToolInvocation[];
    toolResultEvents?: ToolResultEvent[];
    finalResponse?: string;
    hasToolCalled?: boolean;
    taskIdOverride?: string;
    originTaskFile?: string;
    taskRecoveryAttempt?: number;
    skipSaveOutput?: boolean;
    forceSaveOutput?: boolean;
};

type NormalizedToolCall = {
    aiName: string;
    args: Record<string, unknown> | null;
    result: ToolResult | null;
    plannedStepIndex: number | null;
    stepIndex: number | null;
    executionIndex: number | null;
    stepId: string;
    source: 'result' | 'invocation';
};

type RuntimeConfig = {
    model: string;
    baseUrl: string | undefined;
    apiKey: string | undefined;
    timeout: number;
    maxRetries: number;
    maxObjectiveChars: number;
    maxFinalResponseChars: number;
    maxArgsChars: number;
    maxResultChars: number;
};

// 内存缓存：任务状态（按 conversationId 索引，不限制数量）
const recentTaskStates = new Map<string | null | undefined, AnalysisResult & { taskId?: string; timestamp?: string; cachedAt: number }>();

// Fixed output directory
const OUTPUT_DIR = './taskData';

const PROMPTS_CONFIG_PATH = path.resolve('./sentra-prompts/sentra.config.json');
let cachedAnalyzerSystemPrompt: string | null = null;

async function getAnalyzerSystemPrompt() {
    try {
        if (cachedAnalyzerSystemPrompt) return cachedAnalyzerSystemPrompt;

        const template = [
            '{{sentra_short_root_tools_only}}',
            '',
            '{{sentra_protocol_tools_only}}',
            '',
            '{{sentra_task_completion_analyzer_prompt_system}}',
            '',
            '{{qq_system_prompt}}'
        ].join('\n');

        const system = await SentraPromptsSDK(template, PROMPTS_CONFIG_PATH);
        const text = system && String(system).trim() ? String(system).trim() : '';
        if (text) {
            cachedAnalyzerSystemPrompt = text;
            return text;
        }
    } catch (e) {
        logger.debug('TaskCompletionAnalyzer: load analyzer prompt failed, fallback', { err: String(e) });
    }
    return '';
}

/**
 * Get runtime config.
 */
function getRuntimeConfig(): RuntimeConfig {
    const mainModel = getEnv('MAIN_AI_MODEL', 'gpt-3.5-turbo') || 'gpt-3.5-turbo';
    const maxRetriesRaw = getEnvInt('MAX_RETRIES', 0);
    const maxObjectiveCharsRaw = getEnvInt('TASK_COMPLETION_ANALYZER_MAX_OBJECTIVE_CHARS', 2400);
    const maxFinalResponseCharsRaw = getEnvInt('TASK_COMPLETION_ANALYZER_MAX_FINAL_RESPONSE_CHARS', 2000);
    const maxArgsCharsRaw = getEnvInt('TASK_COMPLETION_ANALYZER_MAX_ARGS_CHARS', 600);
    const maxResultCharsRaw = getEnvInt('TASK_COMPLETION_ANALYZER_MAX_RESULT_CHARS', 1400);
    const maxRetries = Number.isFinite(maxRetriesRaw) ? Number(maxRetriesRaw) : 0;
    const clampInt = (v: number, min: number, max: number, fallback: number) => {
        if (!Number.isFinite(v)) return fallback;
        return Math.max(min, Math.min(max, Math.trunc(v)));
    };
    return {
        model: (getEnv('CONTEXT_MEMORY_MODEL', mainModel) || mainModel),
        baseUrl: getEnv('CONTEXT_MEMORY_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1')),
        apiKey: getEnv('CONTEXT_MEMORY_API_KEY', getEnv('API_KEY')),
        timeout: getEnvTimeoutMs('CONTEXT_MEMORY_TIMEOUT_MS', 60000, 300000),
        maxRetries: clampInt(maxRetries, 0, 10, 0),
        maxObjectiveChars: clampInt(Number(maxObjectiveCharsRaw ?? 2400), 200, 20000, 2400),
        maxFinalResponseChars: clampInt(Number(maxFinalResponseCharsRaw ?? 2000), 200, 20000, 2000),
        maxArgsChars: clampInt(Number(maxArgsCharsRaw ?? 600), 120, 8000, 600),
        maxResultChars: clampInt(Number(maxResultCharsRaw ?? 1400), 200, 12000, 1400)
    };
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function formatLocalCompactTs(date: Date | string | number): string {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function formatLocalDisplayTs(date: Date | string | number): string {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function toFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stableJson(value: unknown): string {
    const seen = new WeakSet<object>();
    const normalize = (input: unknown): unknown => {
        if (input == null) return input;
        if (Array.isArray(input)) return input.map(normalize);
        if (typeof input === 'object') {
            const obj = input as Record<string, unknown>;
            if (seen.has(obj)) return '[Circular]';
            seen.add(obj);
            const out: Record<string, unknown> = {};
            const keys = Object.keys(obj).sort();
            for (const key of keys) {
                out[key] = normalize(obj[key]);
            }
            return out;
        }
        return input;
    };
    try {
        return JSON.stringify(normalize(value));
    } catch {
        return '';
    }
}

function normalizeToolArgs(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function normalizeToolCalls(
    toolInvocations?: ToolInvocation[],
    toolResultEvents?: ToolResultEvent[]
): NormalizedToolCall[] {
    const normalized: NormalizedToolCall[] = [];
    const seen = new Set<string>();
    const resultFingerprintCount = new Map<string, number>();

    const pushIfAbsent = (key: string, item: NormalizedToolCall) => {
        if (!key) return;
        if (seen.has(key)) return;
        seen.add(key);
        normalized.push(item);
    };

    for (let i = 0; i < (toolResultEvents || []).length; i += 1) {
        const ev = (toolResultEvents || [])[i];
        if (!ev || typeof ev !== 'object') continue;
        const aiName = typeof ev.aiName === 'string' && ev.aiName.trim() ? ev.aiName.trim() : 'unknown';
        const args = normalizeToolArgs((ev as Record<string, unknown>).args);
        const resultObj = ev.result && typeof ev.result === 'object'
            ? (ev.result as ToolResult)
            : null;
        const plannedStepIndex = toFiniteNumber((ev as Record<string, unknown>).plannedStepIndex);
        const stepIndex = toFiniteNumber((ev as Record<string, unknown>).stepIndex);
        const executionIndex = toFiniteNumber((ev as Record<string, unknown>).executionIndex);
        const stepId = typeof (ev as Record<string, unknown>).stepId === 'string'
            ? String((ev as Record<string, unknown>).stepId || '').trim()
            : '';

        const hasOrderKey = !!stepId || plannedStepIndex != null || stepIndex != null || executionIndex != null;
        const key = hasOrderKey
            ? `result|${aiName}|sid:${stepId}|p:${plannedStepIndex ?? ''}|s:${stepIndex ?? ''}|e:${executionIndex ?? ''}|a:${stableJson(args || {})}`
            : `result|${aiName}|a:${stableJson(args || {})}|seq:${i}`;
        const fingerprint = `${aiName}|a:${stableJson(args || {})}`;
        resultFingerprintCount.set(fingerprint, (resultFingerprintCount.get(fingerprint) || 0) + 1);

        pushIfAbsent(key, {
            aiName,
            args,
            result: resultObj,
            plannedStepIndex,
            stepIndex,
            executionIndex,
            stepId,
            source: 'result'
        });
    }

    for (let i = 0; i < (toolInvocations || []).length; i += 1) {
        const inv = (toolInvocations || [])[i];
        if (!inv || typeof inv !== 'object') continue;
        const aiName = typeof inv.aiName === 'string' && inv.aiName.trim() ? inv.aiName.trim() : 'unknown';
        const args = normalizeToolArgs(inv.args);
        const fingerprint = `${aiName}|a:${stableJson(args || {})}`;
        const remaining = resultFingerprintCount.get(fingerprint) || 0;
        if (remaining > 0) {
            resultFingerprintCount.set(fingerprint, remaining - 1);
            continue;
        }
        const key = `invocation|${aiName}|a:${stableJson(args || {})}|seq:${i}`;
        pushIfAbsent(key, {
            aiName,
            args,
            result: null,
            plannedStepIndex: null,
            stepIndex: null,
            executionIndex: null,
            stepId: '',
            source: 'invocation'
        });
    }

    return normalized;
}

function clipText(value: unknown, maxChars: number): string {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (!text) return '';
    if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}...[truncated ${text.length - maxChars} chars]`;
}

function compactJsonPreview(value: unknown, maxChars: number): string {
    if (value == null) return '';
    const raw = stableJson(value);
    return clipText(raw, maxChars);
}

function compactProtocolValue(value: unknown, opts: { maxStrChars: number; maxArrayItems: number; maxObjectKeys: number; depth: number }): unknown {
    const { maxStrChars, maxArrayItems, maxObjectKeys, depth } = opts;
    if (value == null) return value;
    if (depth <= 0) return '[DepthLimit]';
    if (typeof value === 'string') {
        return clipText(value, maxStrChars);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (Array.isArray(value)) {
        const out = value.slice(0, maxArrayItems).map((item) =>
            compactProtocolValue(item, { ...opts, depth: depth - 1 })
        );
        if (value.length > maxArrayItems) {
            out.push(`[truncated ${value.length - maxArrayItems} items]`);
        }
        return out;
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj);
        const out: Record<string, unknown> = {};
        for (const key of keys.slice(0, maxObjectKeys)) {
            out[key] = compactProtocolValue(obj[key], { ...opts, depth: depth - 1 });
        }
        if (keys.length > maxObjectKeys) {
            out.__truncated_keys__ = keys.length - maxObjectKeys;
        }
        return out;
    }
    return String(value);
}

function buildAnalyzerRootDirectiveXml(payload: {
    userObjective: string;
    toolCount: number;
    hasFinalResponse: boolean;
}): string {
    const objective = escapeXml(payload.userObjective || '(empty)');
    return [
        '<sentra-root-directive>',
        '  <id>task_completion_analysis_v2</id>',
        '  <type>analysis</type>',
        '  <scope>single_turn</scope>',
        '  <phase>TaskCompletionAnalyzer</phase>',
        '  <objective>你要基于真实执行轨迹（assistant 的 sentra-tools 与 user 的 sentra-result）判断任务完成状态。</objective>',
        '  <analysis_input>',
        `    <tool_count>${payload.toolCount}</tool_count>`,
        `    <has_final_response>${payload.hasFinalResponse}</has_final_response>`,
        `    <user_objective>${objective}</user_objective>`,
        '  </analysis_input>',
        '  <constraints>',
        '    <item>只输出一个顶层 XML：&lt;sentra-tools type="task_completion_analysis"&gt;...&lt;/sentra-tools&gt;。</item>',
        '    <item>status 只能是 completed|partial|pending。</item>',
        '    <item>summary 与 reason 必须非空，并引用执行证据（工具结果或最终回复）。</item>',
        '    <item>confidence 取值范围 0..1。</item>',
        '    <item>不得输出任何解释性前后缀。</item>',
        '  </constraints>',
        '</sentra-root-directive>'
    ].join('\n');
}

function normalizeFinalResponseForAnalyzer(value: unknown, maxChars: number): string {
    const raw = String(value || '').trim();
    if (!raw) return '<sentra-response></sentra-response>';
    if (raw.includes('<sentra-response>')) {
        return clipText(raw, maxChars);
    }
    const safe = escapeXml(clipText(raw, maxChars));
    return `<sentra-response><text1>${safe}</text1></sentra-response>`;
}

function shouldRetryAnalyzerError(err: unknown): boolean {
    const text = String(err || '').toLowerCase();
    if (!text) return false;
    const retryHints = [
        'timeout',
        'timed out',
        'network',
        'socket',
        'econnreset',
        'econnrefused',
        'enotfound',
        'eai_again',
        'fetch failed',
        '503',
        '502',
        '504',
        'rate limit',
        'temporarily unavailable'
    ];
    return retryHints.some((hint) => text.includes(hint));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Generate task ID.
 */
function generateTaskId(groupId: string | number | null | undefined, userId: string | number | null | undefined): string {
    return randomUUID();
}

/**
 * Build analysis prompt.
 */
async function buildAnalysisMessages(options: AnalysisMessagesOptions, cfg?: RuntimeConfig): Promise<ChatMessage[]> {
    const {
        userObjective,
        toolInvocations,
        toolResultEvents,
        finalResponse
    } = options;

    const objectiveLimit = cfg?.maxObjectiveChars ?? 2400;
    const finalResponseLimit = cfg?.maxFinalResponseChars ?? 2000;
    const argsLimit = cfg?.maxArgsChars ?? 600;
    const resultLimit = cfg?.maxResultChars ?? 1400;

    const normalizedCalls = normalizeToolCalls(toolInvocations, toolResultEvents);
    const systemPreset = await getAnalyzerSystemPrompt();

    const systemDirective = [
        String(systemPreset || '').trim(),
        '',
        'STAGE ROLE: Task Completion Analysis (internal)',
        'Analyze completion from protocolized execution context built by sentra messages.',
        'CRITICAL OUTPUT RULES:',
        '- Output exactly ONE XML block: <sentra-tools type="task_completion_analysis">...</sentra-tools>.',
        '- Must be valid XML. No extra text.',
        '- status MUST be one of: completed | partial | pending.',
        '- summary and reason MUST NOT be empty.',
        '- confidence MUST be a number in [0,1].',
        '- If no promises, output <promises></promises>.',
        '',
        'COMPLETION JUDGEMENT PRINCIPLES:',
        '- Treat assistant messages as executed tool intents, and user messages as corresponding step results.',
        '- Decide from concrete result evidence first.',
        '- If required delivery side-effects are unproven, do not mark completed.',
        '- pending: waiting on time/external condition; partial: some done but key deliverables missing.',
        '- reason must cite concrete evidence from the result stream and final response.'
    ].filter(Boolean).join('\n');

    const objectiveText = clipText(userObjective || '(no explicit objective)', objectiveLimit);
    const finalResponseXml = normalizeFinalResponseForAnalyzer(finalResponse, finalResponseLimit);
    const rootDirectiveXml = buildAnalyzerRootDirectiveXml({
        userObjective: objectiveText,
        toolCount: normalizedCalls.length,
        hasFinalResponse: !!String(finalResponse || '').trim()
    });

    const messages: ChatMessage[] = [{ role: 'system', content: systemDirective }];

    messages.push({
        role: 'user',
        content: [
            '<sentra-user-question>',
            objectiveText,
            '</sentra-user-question>',
            '',
            rootDirectiveXml
        ].join('\n')
    });

    normalizedCalls.forEach((item, i) => {
        const compactArgs = compactProtocolValue(item.args || {}, {
            maxStrChars: Math.max(120, Math.floor(argsLimit / 2)),
            maxArrayItems: 6,
            maxObjectKeys: 16,
            depth: 4
        }) as Record<string, unknown>;

        const toolsXml = (buildSentraToolsBlockFromInvocations as (items: unknown[]) => string)([
            {
                aiName: item.aiName,
                args: compactArgs
            }
        ]);

        const stepLabel = item.stepId || `step_${item.plannedStepIndex ?? item.stepIndex ?? i}`;
        const planLine = `<root>当前执行步骤 ${i + 1} (${stepLabel})：我执行了工具 ${item.aiName}</root>`;

        messages.push({
            role: 'assistant',
            content: `${planLine}\n${toolsXml}`
        });

        const compactResult = compactProtocolValue(item.result || {}, {
            maxStrChars: Math.max(200, Math.floor(resultLimit / 2)),
            maxArrayItems: 8,
            maxObjectKeys: 18,
            depth: 4
        }) as Record<string, unknown>;

        const resultEvent = {
            type: 'tool_result',
            aiName: item.aiName,
            stepId: stepLabel,
            plannedStepIndex: item.plannedStepIndex ?? i,
            executionIndex: item.executionIndex ?? i,
            resultStatus: 'final',
            reason: 'execution_trace_for_completion_analysis',
            args: compactArgs,
            result: item.result
                ? compactResult
                : { success: null, code: 'NO_RESULT', message: 'Invocation exists but no result event.' }
        };

        const resultXml = buildSentraResultBlock(resultEvent as unknown as Record<string, unknown>);
        messages.push({
            role: 'user',
            content: `${resultXml}\n\n<root>这是步骤 ${i + 1} 的执行结果输入，请把它作为任务完成判断证据。</root>`
        });
    });

    messages.push({
        role: 'assistant',
        content: finalResponseXml
    });

    messages.push({
        role: 'user',
        content: [
            rootDirectiveXml,
            '',
            '<analysis-task>',
            '基于以上协议化执行上下文输出任务完成分析结果。',
            '只输出 <sentra-tools type="task_completion_analysis">...</sentra-tools>。',
            '</analysis-task>'
        ].join('\n')
    });

    return messages;
}

function parseAnalysisResult(xmlString: string): AnalysisResult {
    const result: AnalysisResult = {
        status: 'unknown',
        summary: '',
        isComplete: false,
        confidence: 0,
        reason: '',
        promises: []
    };

    try {
        const raw = String(xmlString || '').trim();
        if (!raw) return result;

        const toolsBlockMatch = raw.match(/<sentra-tools[\s\S]*?<\/sentra-tools>/i);
        const xml = toolsBlockMatch ? toolsBlockMatch[0] : raw;

        const statusMatch = xml.match(/<status>([\s\S]*?)<\/status>/i);
        if (statusMatch && typeof statusMatch[1] === 'string') result.status = statusMatch[1].trim();

        const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/i);
        if (summaryMatch && typeof summaryMatch[1] === 'string') result.summary = summaryMatch[1].trim();

        const isCompleteMatch = xml.match(/<is_complete>([\s\S]*?)<\/is_complete>/i);
        if (isCompleteMatch && typeof isCompleteMatch[1] === 'string') {
            result.isComplete = isCompleteMatch[1].trim().toLowerCase() === 'true';
        }

        const confidenceMatch = xml.match(/<confidence>([\s\S]*?)<\/confidence>/i);
        if (confidenceMatch && typeof confidenceMatch[1] === 'string') {
            result.confidence = parseFloat(confidenceMatch[1].trim()) || 0;
        }

        const reasonMatch = xml.match(/<reason>([\s\S]*?)<\/reason>/i);
        if (reasonMatch && typeof reasonMatch[1] === 'string') result.reason = reasonMatch[1].trim();

        const promisesMatch = xml.match(/<promises>([\s\S]*?)<\/promises>/i);
        if (promisesMatch && typeof promisesMatch[1] === 'string') {
            const itemMatches = promisesMatch[1].matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g);
            for (const match of itemMatches) {
                const itemXml = match[1];
                if (typeof itemXml !== 'string') continue;
                const contentMatch = itemXml.match(/<content>([\s\S]*?)<\/content>/i);
                const fulfilledMatch = itemXml.match(/<fulfilled>([\s\S]*?)<\/fulfilled>/i);
                const evidenceMatch = itemXml.match(/<evidence>([\s\S]*?)<\/evidence>/i);
                const content = contentMatch && typeof contentMatch[1] === 'string' ? contentMatch[1].trim() : '';
                const fulfilled = fulfilledMatch && typeof fulfilledMatch[1] === 'string'
                    ? fulfilledMatch[1].trim().toLowerCase() === 'true'
                    : false;
                const evidence = evidenceMatch && typeof evidenceMatch[1] === 'string' ? evidenceMatch[1].trim() : '';
                result.promises.push({
                    content,
                    fulfilled,
                    evidence
                });
            }
        }
    } catch (e) {
        logger.debug('parseAnalysisResult: 解析失败', { err: String(e) });
    }

    return result;
}
function buildOutputXml(
    taskId: string,
    timestamp: string,
    result: AnalysisResult,
    toolCalls?: NormalizedToolCall[]
): string {
    const toolCallsXml = (toolCalls || []).map((t: NormalizedToolCall, i: number) => {
        const name = escapeXml(t?.aiName || 'unknown');
        const successValue = t?.result?.success;
        const success = typeof successValue === 'boolean'
            ? (successValue ? 'true' : 'false')
            : 'unknown';
        const summary = escapeXml(t?.result?.code || '');
        return `    <item index="${i + 1}">
      <name>${name}</name>
      <success>${success}</success>
      <summary>${summary}</summary>
    </item>`;
    }).join('\n');

    const promisesXml = (result.promises || []).map((p: PromiseItem, i: number) => {
        return `    <item index="${i + 1}">
      <content>${escapeXml(p.content)}</content>
      <fulfilled>${p.fulfilled}</fulfilled>
      <evidence>${escapeXml(p.evidence)}</evidence>
    </item>`;
    }).join('\n');

    return `<sentra-tools type="task_completion_analysis">
  <task_id>${escapeXml(taskId)}</task_id>
  <timestamp>${escapeXml(timestamp)}</timestamp>
  <status>${escapeXml(result.status)}</status>
  <summary>${escapeXml(result.summary)}</summary>
  <completion>
    <is_complete>${result.isComplete}</is_complete>
    <confidence>${result.confidence}</confidence>
    <reason>${escapeXml(result.reason)}</reason>
  </completion>
  <promises>
${promisesXml || '    <!-- no unfulfilled promises -->'}
  </promises>
  <tool_calls>
${toolCallsXml || '    <!-- no tool calls -->'}
  </tool_calls>
</sentra-tools>`;
}

/**
 * 鐢熸垚 JSON 杈撳嚭
 */
function buildOutputJson(
    taskId: string,
    timestamp: string,
    groupId: string | number | null | undefined,
    userId: string | number | null | undefined,
    conversationId: string | null | undefined,
    result: AnalysisResult,
    toolCalls?: NormalizedToolCall[]
) {
    const objectiveText = typeof result?.objective === 'string'
        ? result.objective
        : '';
    return {
        taskId,
        timestamp,
        groupId,
        userId,
        conversationId: conversationId || null,
        chatType: typeof groupId === 'string' && String(groupId).startsWith('G:') ? 'group' : 'private',
        recoveryCount: Number.isFinite(result?.recoveryCount) ? Number(result.recoveryCount) : 0,
        userObjective: objectiveText,
        status: result.status,
        isComplete: result.isComplete,
        confidence: result.confidence,
        summary: result.summary,
        reason: result.reason,
        promises: result.promises,
        finalResponsePreview: typeof result?.finalResponsePreview === 'string'
            ? result.finalResponsePreview
            : '',
        toolCalls: (toolCalls || []).map((t: NormalizedToolCall, i: number) => {
            const safeArgs = t && typeof t.args === 'object' && t.args
                ? t.args
                : null;
            const safeResult = t && typeof t.result === 'object' && t.result
                ? t.result
                : null;
            const successValue = safeResult?.success;
            return {
                index: i + 1,
                name: t?.aiName || 'unknown',
                args: safeArgs,
                success: typeof successValue === 'boolean' ? successValue : null,
                code: safeResult?.code || '',
                error: safeResult?.error || safeResult?.message || '',
                result: safeResult,
                stepId: t?.stepId || '',
                plannedStepIndex: t?.plannedStepIndex ?? null,
                stepIndex: t?.stepIndex ?? null,
                executionIndex: t?.executionIndex ?? null,
                source: t?.source || 'result'
            };
        })
    };
}

/**
 * 鐢熸垚 MD 杈撳嚭
 */
function buildOutputMd(
    taskId: string,
    timestamp: string,
    result: AnalysisResult,
    toolCalls?: NormalizedToolCall[]
): string {
    const statusEmoji = result.isComplete ? 'OK' : (result.status === 'partial' ? 'WARN' : 'PENDING');
    const statusText = result.isComplete ? 'Completed' : (result.status === 'partial' ? 'Partial' : 'Pending');

    const objectiveSection = result.objective
        ? `## User Objective\n\n${result.objective}\n\n`
        : '';

    const finalResponseSection = result.finalResponsePreview
        ? `## Final Response Preview\n\n${result.finalResponsePreview}\n\n`
        : '';

    let promisesTable = '';
    if (result.promises && result.promises.length > 0) {
        promisesTable = `## Promises\n| content | fulfilled | evidence |\n|---|---|---|\n${result.promises.map((p) => `| ${p.content} | ${p.fulfilled ? 'true' : 'false'} | ${p.evidence} |`).join('\n')}\n`;
    }

    let toolsTable = '';
    if (toolCalls && toolCalls.length > 0) {
        toolsTable = `## Tool Calls\n\n| tool | status | code | args | error |\n|---|---|---|---|---|\n${toolCalls.map((t) => {
            const successValue = t?.result?.success;
            const success = typeof successValue === 'boolean'
                ? (successValue ? 'true' : 'false')
                : 'unknown';
            const code = t?.result?.code || '-';
            const err = t?.result?.error || t?.result?.message || '';
            let argsPreview = '';
            try {
                argsPreview = t?.args ? JSON.stringify(t.args) : '';
            } catch {
                argsPreview = '';
            }
            const errPreview = String(err || '');
            return `| ${t?.aiName || 'unknown'} | ${success} | ${code} | ${argsPreview || '-'} | ${errPreview || '-'} |`;
        }).join('\n')}\n`;
    }

    return `# Task Completion Report\n\n**taskId**: ${taskId}  \n**timestamp**: ${timestamp}  \n**status**: ${statusEmoji} ${statusText}  \n**confidence**: ${(result.confidence * 100).toFixed(0)}%\n\n${objectiveSection}${finalResponseSection}## Summary\n\n${result.summary || '(empty)'}\n\n**Reason**: ${result.reason || '(empty)'}\n\n${promisesTable}${toolsTable}`;
}
async function saveOutputFiles(
    outputDir: string,
    groupId: string | number | null | undefined,
    taskId: string,
    xml: string,
    json: Record<string, unknown>,
    md: string
) {
    try {
        const groupDir = path.join(outputDir, String(groupId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_'));
        await fs.mkdir(groupDir, { recursive: true });

        const jsonPath = path.join(groupDir, `${taskId}.json`);
        const mdPath = path.join(groupDir, `${taskId}.md`);

        await fs.writeFile(jsonPath, JSON.stringify(json, null, 2), 'utf-8');
        await fs.writeFile(mdPath, md, 'utf-8');

        logger.info('TaskCompletionAnalyzer: 报告已保存', { jsonPath, mdPath });
        return { jsonPath, mdPath };
    } catch (e) {
        logger.warn('TaskCompletionAnalyzer: 保存文件失败', { err: String(e) });
        return null;
    }
}

/**
 * Delete previous output artifacts for recovery reruns.
 */
async function deleteOutputFiles(
    outputDir: string,
    groupId: string | number | null | undefined,
    taskId: string,
    originTaskFile: string | null | undefined
) {
    const groupDir = path.join(outputDir, String(groupId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_'));
    const jsonPath = originTaskFile || path.join(groupDir, `${taskId}.json`);
    const mdPath = originTaskFile
        ? originTaskFile.replace(/\.json$/i, '.md')
        : path.join(groupDir, `${taskId}.md`);
    try {
        await fs.unlink(jsonPath);
    } catch { }
    try {
        await fs.unlink(mdPath);
    } catch { }
}

async function loadRecoveryCountFromFile(originTaskFile: string | null | undefined): Promise<number> {
    if (!originTaskFile) return 0;
    try {
        const raw = await fs.readFile(originTaskFile, 'utf-8');
        const data = JSON.parse(raw);
        const c = data && Number.isFinite(data.recoveryCount) ? Number(data.recoveryCount) : 0;
        return c >= 0 ? c : 0;
    } catch {
        return 0;
    }
}

function cacheTaskState(conversationId: string | null | undefined, state: AnalysisResult & { taskId: string; timestamp: string }) {
    recentTaskStates.set(conversationId, {
        ...state,
        cachedAt: Date.now()
    });
}

/**
 * Read cached task state.
 */
export function getCachedTaskState(conversationId: string | null | undefined): (AnalysisResult & { taskId?: string; timestamp?: string }) | null {
    return recentTaskStates.get(conversationId) || null;
}

/**
 * Entry point: trigger task-completion analysis.
 */
export async function triggerTaskCompletionAnalysis(options: AnalysisTriggerOptions = {}) {
    const {
        agent,
        groupId,
        conversationId,
        userId,
        userObjective,
        toolInvocations,
        toolResultEvents,
        finalResponse,
        hasToolCalled,
        taskIdOverride,
        originTaskFile,
        taskRecoveryAttempt,
        skipSaveOutput,
        forceSaveOutput
    } = options;

    const cfg = getRuntimeConfig();

    const taskId = taskIdOverride || generateTaskId(groupId, userId);
    const timestamp = formatLocalDisplayTs(new Date());
    const normalizedToolCalls = normalizeToolCalls(toolInvocations, toolResultEvents);
    const toolCount = normalizedToolCalls.length;
    const toolInvocationCount = (toolInvocations || []).length;
    const toolResultCount = (toolResultEvents || []).length;

    const prevRecoveryCount = originTaskFile ? await loadRecoveryCountFromFile(originTaskFile) : 0;
    const nextRecoveryCount = originTaskFile ? prevRecoveryCount + 1 : 0;

    logger.info('TaskCompletionAnalyzer: 开始分析', {
        taskId,
        conversationId,
        groupId,
        userId,
        toolCount,
        toolInvocationCount,
        toolResultCount,
        hasToolCalled: Boolean(hasToolCalled),
        skipSaveOutput: Boolean(skipSaveOutput),
        forceSaveOutput: Boolean(forceSaveOutput),
        taskRecoveryAttempt: Number.isFinite(taskRecoveryAttempt) ? Number(taskRecoveryAttempt) : 0,
        maxRetries: cfg.maxRetries,
        model: cfg.model
    });

    try {
        // Recovery mode: remove prior task report file first to avoid duplicate pending records.
        if (originTaskFile) {
            await deleteOutputFiles(OUTPUT_DIR, groupId, taskId, originTaskFile);
        }

        // Call model for task completion analysis.
        let analysisXml = '';
        let analysisBypassAsCompleted = false;
        if (agent && typeof agent.chat === 'function') {
            const messages = await buildAnalysisMessages({
                userObjective,
                toolInvocations,
                toolResultEvents,
                finalResponse
            }, cfg);

            let lastErr: unknown = null;
            for (let attempt = 0; attempt <= cfg.maxRetries; attempt += 1) {
                const analysisStart = Date.now();
                try {
                    const result = await agent.chat([
                        ...messages
                    ], {
                        model: cfg.model,
                        maxTokens: 1024,
                        timeout: cfg.timeout,
                        stream: true,
                        expectedOutput: 'sentra_tools'
                    });
                    if (typeof result === 'string') {
                        analysisXml = result;
                    } else if (result && typeof result === 'object') {
                        const maybe = result as { response?: string; content?: string };
                        analysisXml = maybe.response || maybe.content || '';
                    }
                    logger.info('TaskCompletionAnalyzer: 模型分析返回', {
                        taskId,
                        attempt: attempt + 1,
                        costMs: Date.now() - analysisStart,
                        outputLen: typeof analysisXml === 'string' ? analysisXml.length : 0
                    });
                    lastErr = null;
                    break;
                } catch (e) {
                    lastErr = e;
                    const canRetry = attempt < cfg.maxRetries && shouldRetryAnalyzerError(e);
                    logger.warn('TaskCompletionAnalyzer: 分析请求失败', {
                        taskId,
                        attempt: attempt + 1,
                        maxRetries: cfg.maxRetries,
                        canRetry,
                        err: String(e)
                    });
                    if (!canRetry) break;
                    await sleep(Math.min(1500, 300 * (attempt + 1)));
                }
            }

            if (!analysisXml && lastErr) {
                analysisBypassAsCompleted = true;
                logger.warn('TaskCompletionAnalyzer: 分析最终失败，按配置直接通过且不落盘', {
                    taskId,
                    maxRetries: cfg.maxRetries,
                    err: String(lastErr)
                });
            }
        }

        // Parse and normalize analysis result.
        const parsedResult = analysisBypassAsCompleted
            ? {
                status: 'completed',
                summary: '',
                isComplete: true,
                confidence: 1,
                reason: 'task_completion_analysis_api_failed_bypass',
                promises: []
            }
            : parseAnalysisResult(analysisXml);
        const normalizedStatus = String(parsedResult?.status || '').trim();
        const normalizedStatusLower = normalizedStatus.toLowerCase();
        const derivedIsComplete = parsedResult?.isComplete === true
            || normalizedStatusLower === 'completed'
            || normalizedStatusLower === 'complete'
            || normalizedStatusLower === 'done';
        const result: AnalysisResult = {
            ...parsedResult,
            status: normalizedStatus || 'unknown',
            isComplete: derivedIsComplete
        };

        // Build output payloads.
        const outputXml = buildOutputXml(taskId, timestamp, result, normalizedToolCalls);
        const enrichedResult = {
            ...result,
            objective: typeof userObjective === 'string' ? userObjective : '',
            finalResponsePreview: typeof finalResponse === 'string'
                ? String(finalResponse).trim()
                : '',
            recoveryCount: nextRecoveryCount
        };
        const outputJson = buildOutputJson(taskId, timestamp, groupId, userId, conversationId, enrichedResult, normalizedToolCalls);
        const outputMd = buildOutputMd(taskId, timestamp, enrichedResult, normalizedToolCalls);

        // Save decision.
        const isComplete = result.isComplete === true;
        const attemptCount = Number.isFinite(taskRecoveryAttempt) ? Number(taskRecoveryAttempt) : 0;
        const shouldDropOnFailure = attemptCount >= 2 || (originTaskFile && nextRecoveryCount >= 2);
        const hasPromises = Array.isArray(result?.promises) && result.promises.length > 0;
        const hasToolEvidence = Boolean(hasToolCalled) || normalizedToolCalls.length > 0;
        const shouldRecord = hasToolEvidence || hasPromises;
        const shouldForceSave = !!forceSaveOutput && !isComplete && !analysisBypassAsCompleted;

        logger.info('TaskCompletionAnalyzer: 记录判定', {
            taskId,
            status: result?.status,
            isComplete,
            hasToolCalled: hasToolEvidence,
            toolCount,
            hasPromises,
            shouldRecord,
            shouldForceSave,
            skipSaveOutput: Boolean(skipSaveOutput),
            originTaskFile: Boolean(originTaskFile),
            shouldDropOnFailure
        });

        // Save files by policy: default saves unresolved tasks only, forceSaveOutput can override.
        if (!analysisBypassAsCompleted && !skipSaveOutput && !shouldDropOnFailure && (shouldForceSave || (!isComplete && shouldRecord))) {
            await saveOutputFiles(OUTPUT_DIR, groupId, taskId, outputXml, outputJson, outputMd);
        } else {
            logger.info('TaskCompletionAnalyzer: 保存跳过', {
                taskId,
                reason: analysisBypassAsCompleted
                    ? 'analysis_api_failed_bypass_completed'
                    : skipSaveOutput
                    ? 'skipSaveOutput=true'
                    : (shouldForceSave
                        ? 'shouldForceSave=false'
                        : (shouldDropOnFailure
                            ? 'shouldDropOnFailure=true'
                            : (isComplete ? 'task_is_complete' : (shouldRecord ? 'shouldRecord=true_but_no_save' : 'shouldRecord=false'))))
            });
        }

        // Cache state
        if (!analysisBypassAsCompleted && (shouldRecord || shouldForceSave)) {
            cacheTaskState(conversationId, {
                taskId,
                timestamp,
                ...result
            });
        }

        logger.info('TaskCompletionAnalyzer: 分析完成', {
            taskId,
            status: result.status,
            isComplete,
            confidence: result.confidence
        });

        return {
            taskId,
            timestamp,
            xml: outputXml,
            json: outputJson,
            md: outputMd,
            result
        };
    } catch (e) {
        logger.warn('TaskCompletionAnalyzer: 分析失败', { taskId, err: String(e) });
        return null;
    }
}

export default {
    triggerTaskCompletionAnalysis,
    getCachedTaskState
};

