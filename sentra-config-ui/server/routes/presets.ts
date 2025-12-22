import { FastifyInstance } from 'fastify';
import { join, resolve, basename, relative } from 'path';
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import dotenv from 'dotenv';
import { TextDecoder } from 'util';

// Helper to get root directory
function getRootDir(): string {
    return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

// Helper to get presets directory
function getPresetsDir(): string {
    return join(getRootDir(), 'agent-presets');
}

let cachedRootEnv: Record<string, string> | null = null;
function getRootEnvValue(key: string): string {
    try {
        if (!cachedRootEnv) {
            const envPath = join(getRootDir(), '.env');
            if (existsSync(envPath)) {
                cachedRootEnv = dotenv.parse(readFileSync(envPath));
            } else {
                cachedRootEnv = {};
            }
        }
        return (cachedRootEnv && typeof cachedRootEnv[key] === 'string') ? String(cachedRootEnv[key] || '') : '';
    } catch {
        return '';
    }
}

function extractFirstTagBlock(text: string, tagName: string): string {
    if (!text || !tagName) return '';
    const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, 'i');
    const m = String(text).match(re);
    return m ? m[0] : '';
}

function extractTagText(xml: string, tagName: string): string {
    if (!xml || !tagName) return '';
    const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'i');
    const m = String(xml).match(re);
    return m ? (m[1] || '').trim() : '';
}

function parseSimpleChildrenBlock(inner: string): Record<string, any> {
    const result: Record<string, any> = {};
    if (!inner) return result;
    const re = /<([A-Za-z0-9_:-]+)\b[^>]*>([\s\S]*?)<\/\1\s*>/g;
    let m: RegExpExecArray | null;
    const src = String(inner);
    while ((m = re.exec(src)) !== null) {
        const tag = m[1];
        const text = (m[2] || '').trim();
        if (!tag) continue;
        if (Object.prototype.hasOwnProperty.call(result, tag)) {
            const prev = result[tag];
            if (Array.isArray(prev)) {
                prev.push(text);
            } else {
                result[tag] = [prev, text];
            }
        } else {
            result[tag] = text;
        }
    }
    return result;
}

function parseSentraAgentPresetXml(xml: string): any {
    if (!xml) return null;
    const metaXml = extractFirstTagBlock(xml, 'meta');
    const meta: Record<string, any> = {};
    const metaKeys = ['node_name', 'category', 'description', 'version', 'author'];
    for (const key of metaKeys) {
        const v = extractTagText(metaXml, key);
        if (v) meta[key] = v;
    }

    const parametersInner = extractTagText(xml, 'parameters');
    const parameters = parseSimpleChildrenBlock(parametersInner);

    const rulesInner = extractTagText(xml, 'rules');
    const rules: any[] = [];
    if (rulesInner) {
        const reRule = /<rule\b[^>]*>([\s\S]*?)<\/rule\s*>/gi;
        let m: RegExpExecArray | null;
        const src = String(rulesInner);
        while ((m = reRule.exec(src)) !== null) {
            const block = m[0];
            const id = extractTagText(block, 'id');
            const enabledRaw = extractTagText(block, 'enabled');
            let enabled: boolean | undefined;
            if (enabledRaw) {
                const t = enabledRaw.trim().toLowerCase();
                if (t === 'true' || t === '1') enabled = true;
                else if (t === 'false' || t === '0') enabled = false;
            }
            const event = extractTagText(block, 'event');

            const conditionsInner = extractTagText(block, 'conditions');
            const conditions: any[] = [];
            if (conditionsInner) {
                const reCond = /<condition\b[^>]*>([\s\S]*?)<\/condition\s*>/gi;
                let mc: RegExpExecArray | null;
                const srcCond = String(conditionsInner);
                while ((mc = reCond.exec(srcCond)) !== null) {
                    const text = (mc[1] || '').trim();
                    if (!text) continue;
                    conditions.push({ type: 'text', value: text });
                }
            }

            const behaviorInner = extractTagText(block, 'behavior');
            const behavior = behaviorInner ? parseSimpleChildrenBlock(behaviorInner) : {};

            const rule: any = { id: id || undefined, enabled, event: event || undefined };
            if (conditions.length > 0) rule.conditions = conditions;
            if (behavior && Object.keys(behavior).length > 0) rule.behavior = behavior;
            rules.push(rule);
        }
    }

    const result: any = {};
    if (Object.keys(meta).length > 0) result.meta = meta;
    result.parameters = parameters && typeof parameters === 'object' ? parameters : {};
    if (rules.length > 0) result.rules = rules;
    return result;
}

function normalizePresetJson(obj: any, fileBaseName: string) {
    const safeName = fileBaseName || 'AgentPreset';
    const base = obj && typeof obj === 'object' ? { ...obj } : {};

    if (!base.meta || typeof base.meta !== 'object') base.meta = {};
    const meta = base.meta as any;

    if (!meta.node_name && typeof base.node_name === 'string') meta.node_name = base.node_name;
    if (!meta.category && typeof base.category === 'string') meta.category = base.category;
    if (!meta.description && typeof base.description === 'string') meta.description = base.description;
    if (!meta.version && typeof base.version === 'string') meta.version = base.version;
    if (!meta.author && typeof base.author === 'string') meta.author = base.author;

    if (!meta.node_name) meta.node_name = safeName;
    if (!meta.category) meta.category = 'agent_preset';
    if (!meta.description) meta.description = 'Agent preset converted from text';

    if (!base.parameters || typeof base.parameters !== 'object' || Array.isArray(base.parameters)) {
        base.parameters = {};
    }

    if (!Array.isArray(base.rules)) {
        if (base.rules && typeof base.rules === 'object') base.rules = [base.rules];
        else base.rules = [];
    }

    return base;
}

function splitFileName(name: string) {
    const safe = String(name || '').replace(/[/\\]/g, '_');
    const dot = safe.lastIndexOf('.');
    if (dot <= 0 || dot === safe.length - 1) {
        return { base: safe, ext: '' };
    }
    return { base: safe.slice(0, dot), ext: safe.slice(dot) };
}

async function callChatCompletions(params: {
    apiBaseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens?: number;
    messages: any[];
}) {
    const normalizedBase = params.apiBaseUrl.replace(/\/+$/, '');
    const baseWithV1 = /\/v1$/i.test(normalizedBase) ? normalizedBase : `${normalizedBase}/v1`;
    const url = `${baseWithV1}/chat/completions`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
            model: params.model,
            temperature: params.temperature,
            max_tokens: typeof params.maxTokens === 'number' ? params.maxTokens : undefined,
            stream: false,
            messages: params.messages,
        }),
    } as any);

    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Upstream error ${res.status}: ${text}`);
    }
    const json = JSON.parse(text);
    const content = json?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : String(content ?? '');
}

function writeSse(reply: any, payload: any, event?: string) {
    if (event) {
        reply.raw.write(`event: ${event}\n`);
    }
    reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    // Prevent buffering (works when the underlying server supports flush)
    if (typeof reply.raw.flush === 'function') {
        try { reply.raw.flush(); } catch { }
    }
    if (typeof reply.raw.flushHeaders === 'function') {
        try { reply.raw.flushHeaders(); } catch { }
    }
}

async function callChatCompletionsStream(params: {
    apiBaseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens?: number;
    messages: any[];
    onDelta: (delta: string) => void;
}) {
    const normalizedBase = params.apiBaseUrl.replace(/\/+$/, '');
    const baseWithV1 = /\/v1$/i.test(normalizedBase) ? normalizedBase : `${normalizedBase}/v1`;
    const url = `${baseWithV1}/chat/completions`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
            model: params.model,
            temperature: params.temperature,
            max_tokens: typeof params.maxTokens === 'number' ? params.maxTokens : undefined,
            stream: true,
            messages: params.messages,
        }),
    } as any);

    const contentType = String((res.headers as any)?.get?.('content-type') || '');
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upstream error ${res.status}: ${text}`);
    }

    if (!/text\/event-stream/i.test(contentType) || !(res as any).body) {
        const text = await res.text();
        const json = JSON.parse(text);
        const content = json?.choices?.[0]?.message?.content;
        const full = typeof content === 'string' ? content : String(content ?? '');
        // Some OpenAI-compatible providers respond with a single JSON payload even when stream=true.
        // To preserve the "streaming" UX, pseudo-stream the content in small chunks.
        if (full) {
            const chunkSize = 80;
            for (let i = 0; i < full.length; i += chunkSize) {
                const chunk = full.slice(i, i + chunkSize);
                if (chunk) params.onDelta(chunk);
                // Yield to event loop to let SSE flush and UI update.
                await new Promise((r) => setTimeout(r, 0));
            }
        }
        return full;
    }

    const decoder = new TextDecoder();
    const body: any = (res as any).body;
    const reader = typeof body.getReader === 'function' ? body.getReader() : null;
    let buffer = '';
    let fullText = '';

    const handleFrame = (frame: string) => {
        const lines = frame.split(/\r?\n/);
        const dataLines = lines.filter((l) => l.startsWith('data:'));
        if (dataLines.length === 0) return;
        const dataStr = dataLines.map((l) => l.slice(5).trim()).join('\n');
        if (!dataStr) return;
        if (dataStr === '[DONE]') return;
        let json: any;
        try {
            json = JSON.parse(dataStr);
        } catch {
            return;
        }
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
            fullText += delta;
            params.onDelta(delta);
        }
    };

    if (reader) {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true } as any);
            let idx;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                handleFrame(frame);
            }
        }
    } else if (body && (Symbol.asyncIterator in body)) {
        for await (const chunk of body) {
            buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true } as any);
            let idx;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                handleFrame(frame);
            }
        }
    }

    return fullText;
}

export async function presetRoutes(fastify: FastifyInstance) {
    // Get list of all preset files
    fastify.get('/api/presets', async (_request, reply) => {
        try {
            const presetsDir = getPresetsDir();

            if (!existsSync(presetsDir)) {
                return []; // Return empty list if directory doesn't exist
            }

            // Recursive scan function
            const scanDir = (dir: string, baseDir: string): any[] => {
                const items = readdirSync(dir);
                let results: any[] = [];

                for (const item of items) {
                    const fullPath = join(dir, item);
                    const stat = statSync(fullPath);
                    const relativePath = relative(baseDir, fullPath).replace(/\\/g, '/');

                    if (stat.isDirectory()) {
                        results = results.concat(scanDir(fullPath, baseDir));
                    } else {
                        results.push({
                            path: relativePath,
                            name: basename(fullPath),
                            size: stat.size,
                            modified: stat.mtime.toISOString()
                        });
                    }
                }
                return results;
            };

            const files = scanDir(presetsDir, presetsDir);
            // Sort by name
            files.sort((a, b) => a.name.localeCompare(b.name));

            return files;
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to scan presets',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Get content of a specific preset file
    fastify.get<{
        Querystring: { path: string };
    }>('/api/presets/file', async (request, reply) => {
        try {
            const { path } = request.query;

            if (!path) {
                return reply.code(400).send({ error: 'Missing file path' });
            }

            // Security check: prevent directory traversal
            if (path.includes('..')) {
                return reply.code(400).send({ error: 'Invalid file path' });
            }

            const presetsDir = getPresetsDir();
            const fullPath = join(presetsDir, path);

            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'File not found' });
            }

            const content = readFileSync(fullPath, 'utf-8');
            return { content };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to read file',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Save content to a specific preset file
    fastify.post<{
        Body: { path: string; content: string };
    }>('/api/presets/file', async (request, reply) => {
        try {
            const { path, content } = request.body;

            if (!path) {
                return reply.code(400).send({ error: 'Missing file path' });
            }

            // Security check: prevent directory traversal
            if (path.includes('..')) {
                return reply.code(400).send({ error: 'Invalid file path' });
            }

            const presetsDir = getPresetsDir();
            const fullPath = join(presetsDir, path);

            // Ensure directory exists if it's a new file in a subdirectory
            // (Though for now we might only support editing existing files or root files)

            if (!existsSync(fullPath)) {
                // Ensure parent directory exists
                const parentDir = fullPath.substring(0, fullPath.lastIndexOf(path.includes('/') ? '/' : '\\'));
                if (parentDir && !existsSync(parentDir)) {
                    // We need to import mkdirSync
                    // But wait, let's just use a helper or simple logic
                    // Actually, let's import mkdirSync at the top
                }
            }

            // Better approach: always ensure parent dir exists
            const { dirname } = await import('path');
            const { mkdirSync } = await import('fs');
            const parentDir = dirname(fullPath);
            if (!existsSync(parentDir)) {
                mkdirSync(parentDir, { recursive: true });
            }

            writeFileSync(fullPath, content, 'utf-8');

            return { success: true, message: `File saved: ${path}` };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to save file',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Delete a specific preset file
    fastify.delete<{
        Querystring: { path: string };
    }>('/api/presets/file', async (request, reply) => {
        try {
            const { path } = request.query;

            if (!path) {
                return reply.code(400).send({ error: 'Missing file path' });
            }

            // Security check: prevent directory traversal
            if (path.includes('..')) {
                return reply.code(400).send({ error: 'Invalid file path' });
            }

            const presetsDir = getPresetsDir();
            const fullPath = join(presetsDir, path);

            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'File not found' });
            }

            // Additional security: ensure it's a file, not a directory
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                return reply.code(400).send({ error: 'Cannot delete directories' });
            }

            // Delete the file
            const { unlinkSync } = await import('fs');
            unlinkSync(fullPath);

            return { success: true, message: `File deleted: ${path}` };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to delete file',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Convert txt/md preset text -> structured preset JSON (via preset_converter prompt)
    fastify.post<{
        Body: {
            text: string;
            fileName?: string;
            apiBaseUrl?: string;
            apiKey?: string;
            model?: string;
            temperature?: number;
            stream?: boolean;
            maxTokens?: number;
        };
    }>('/api/presets/convert', async (request, reply) => {
        try {
            const body = request.body || ({} as any);
            const rawText = typeof body.text === 'string' ? body.text.trim() : '';
            if (!rawText) {
                return reply.code(400).send({ error: 'Missing text' });
            }

            const fileName = typeof body.fileName === 'string' ? body.fileName : 'preset.txt';
            const { base } = splitFileName(fileName);

            const rootDir = getRootDir();
            const promptPath = join(rootDir, 'prompts', 'preset_converter.json');
            if (!existsSync(promptPath)) {
                return reply.code(500).send({ error: 'Missing preset_converter prompt', message: `Not found: ${promptPath}` });
            }

            const promptJson = JSON.parse(readFileSync(promptPath, 'utf-8')) as any;
            const systemPrompt = typeof promptJson?.system === 'string' ? promptJson.system : '';
            if (!systemPrompt) {
                return reply.code(500).send({ error: 'Invalid preset_converter prompt', message: 'Missing system prompt' });
            }

            const apiBaseUrl = (typeof body.apiBaseUrl === 'string' ? body.apiBaseUrl : '')
                || getRootEnvValue('API_BASE_URL')
                || process.env.API_BASE_URL
                || '';
            const apiKey = (typeof body.apiKey === 'string' ? body.apiKey : '')
                || getRootEnvValue('API_KEY')
                || process.env.API_KEY
                || '';

            if (!apiBaseUrl || !apiKey) {
                return reply.code(500).send({
                    error: 'Preset convert backend not configured',
                    message: 'Missing apiBaseUrl/apiKey (either request override or root .env API_BASE_URL/API_KEY)',
                });
            }

            const model = (typeof body.model === 'string' && body.model.trim())
                ? body.model.trim()
                : (getRootEnvValue('AGENT_PRESET_CONVERTER_MODEL')
                    || getRootEnvValue('MAIN_AI_MODEL')
                    || getRootEnvValue('MODEL_NAME')
                    || process.env.MAIN_AI_MODEL
                    || process.env.MODEL_NAME
                    || 'gpt-4o-mini');

            const temperature = typeof body.temperature === 'number'
                ? body.temperature
                : 0;

            const maxTokensFromBody = typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
            const maxTokensFromEnv = Number(getRootEnvValue('AGENT_PRESET_CONVERTER_MAX_TOKENS') || process.env.AGENT_PRESET_CONVERTER_MAX_TOKENS || '');
            const maxTokens = (Number.isFinite(maxTokensFromBody) && (maxTokensFromBody as number) > 0)
                ? (maxTokensFromBody as number)
                : (Number.isFinite(maxTokensFromEnv) && maxTokensFromEnv > 0 ? maxTokensFromEnv : undefined);

            const userContent = [
                '下面是 Agent 的完整中文预设文本（可能是 Markdown 或自然语言，描述外貌、人设、身份、兴趣、性格、说话风格、行为规则等）：',
                '---',
                rawText,
                '---',
                '',
                '请你只输出一个结构完整、可机读的 <sentra-agent-preset> XML 块，不要输出任何额外解释或 JSON。'
            ].join('\n');

            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ];

            const wantsStream = !!body.stream;
            if (wantsStream) {
                reply.raw.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                });

                if (typeof (reply.raw as any).flushHeaders === 'function') {
                    try { (reply.raw as any).flushHeaders(); } catch { }
                }

                reply.raw.write(`: stream-open\n\n`);
                const heartbeat = setInterval(() => {
                    try {
                        reply.raw.write(`event: ping\n` + `data: {}\n\n`);
                    } catch { }
                }, 15000);

                let assistantText = '';
                try {
                    assistantText = await callChatCompletionsStream({
                        apiBaseUrl,
                        apiKey,
                        model,
                        temperature,
                        maxTokens,
                        messages,
                        onDelta: (delta) => {
                            writeSse(reply, { type: 'token', delta });
                        },
                    });
                } catch (e: any) {
                    writeSse(reply, { type: 'error', message: e?.message || String(e) }, 'error');
                    clearInterval(heartbeat);
                    reply.raw.end();
                    return;
                }

                const presetXml = extractFirstTagBlock(assistantText, 'sentra-agent-preset');
                if (!presetXml) {
                    writeSse(reply, { type: 'error', message: 'Missing <sentra-agent-preset> block in LLM output', raw: assistantText }, 'error');
                    clearInterval(heartbeat);
                    reply.raw.end();
                    return;
                }

                let extracted: any;
                try {
                    extracted = parseSentraAgentPresetXml(presetXml);
                } catch (e: any) {
                    writeSse(reply, { type: 'error', message: e?.message || String(e), presetXml }, 'error');
                    clearInterval(heartbeat);
                    reply.raw.end();
                    return;
                }

                const presetJson = normalizePresetJson(extracted, base || 'AgentPreset');
                writeSse(reply, { type: 'done', presetXml, presetJson }, 'done');
                clearInterval(heartbeat);
                reply.raw.end();
                return;
            }

            const assistantText = await callChatCompletions({
                apiBaseUrl,
                apiKey,
                model,
                temperature,
                maxTokens,
                messages,
            });

            const presetXml = extractFirstTagBlock(assistantText, 'sentra-agent-preset');
            if (!presetXml) {
                return reply.code(502).send({
                    error: 'Invalid upstream response',
                    message: 'Missing <sentra-agent-preset> block in LLM output',
                    raw: assistantText,
                });
            }

            const extracted = parseSentraAgentPresetXml(presetXml);
            if (!extracted || typeof extracted !== 'object') {
                return reply.code(502).send({
                    error: 'Invalid upstream response',
                    message: 'Failed to parse <sentra-agent-preset> block',
                    presetXml,
                });
            }

            const presetJson = normalizePresetJson(extracted, base || 'AgentPreset');
            return {
                presetXml,
                presetJson,
            };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to convert preset',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
