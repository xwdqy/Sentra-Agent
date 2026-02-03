import { FastifyInstance } from 'fastify';
import { join, resolve, basename, relative } from 'path';
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { TextDecoder } from 'util';
import { XMLParser } from 'fast-xml-parser';

// Helper to get root directory
function getRootDir(): string {
    return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

// Helper to get presets directory
function getPresetsDir(): string {
    return join(getRootDir(), 'agent-presets');
}

function extractFirstTagBlock(text: string, tagName: string): string {
    if (!text || !tagName) return '';
    const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, 'i');
    const m = String(text).match(re);
    return m ? m[0] : '';
}

const sentraPresetXmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    allowBooleanAttributes: true,
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (_name: string, jpath: string) => {
        return (
            jpath === 'sentra-agent-preset.rules.rule'
            || jpath === 'sentra-agent-preset.rules.rule.conditions.condition'
        );
    },
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

function parseBoolLoose(v: any): boolean | undefined {
    if (v == null) return undefined;
    const s = String(v).trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    return undefined;
}

function normalizeConditionNode(node: any): { type: string; value: string } | null {
    if (node == null) return null;
    if (typeof node === 'string') {
        const text = node.trim();
        if (!text) return null;
        return { type: 'text', value: text };
    }
    if (typeof node === 'object') {
        const type = typeof node.type === 'string' ? node.type.trim() : '';
        const value = typeof node.value === 'string' ? node.value.trim() : String(node.value ?? '').trim();
        if (type || value) return { type: type || 'text', value };
        return { type: 'text', value: JSON.stringify(node) };
    }
    return { type: 'text', value: String(node).trim() };
}

function parseSentraAgentPresetXml(xml: string): any {
    if (!xml) return null;
    let parsed: any;
    try {
        parsed = sentraPresetXmlParser.parse(xml);
    } catch {
        return null;
    }

    const root = parsed && typeof parsed === 'object' ? (parsed['sentra-agent-preset'] || parsed) : null;
    if (!root || typeof root !== 'object') return null;

    const meta = root.meta && typeof root.meta === 'object' ? root.meta : {};
    const parameters = root.parameters && typeof root.parameters === 'object' ? root.parameters : {};

    const ruleNodes = asArray<any>(root?.rules?.rule);
    const rules = ruleNodes.map((r) => {
        const enabled = parseBoolLoose(r?.enabled);
        const condNodes = asArray<any>(r?.conditions?.condition);
        const conditions = condNodes.map(normalizeConditionNode).filter(Boolean);
        const behavior = r?.behavior && typeof r.behavior === 'object' ? r.behavior : {};

        const rule: any = {
            id: typeof r?.id === 'string' ? r.id : (r?.id != null ? String(r.id) : undefined),
            enabled,
            event: typeof r?.event === 'string' ? r.event : (r?.event != null ? String(r.event) : undefined),
        };
        if (conditions.length > 0) rule.conditions = conditions;
        if (behavior && Object.keys(behavior).length > 0) rule.behavior = behavior;
        return rule;
    }).filter((r) => r && (r.id || r.event || r.behavior || r.conditions));

    const result: any = {};
    if (meta && Object.keys(meta).length > 0) result.meta = meta;
    result.parameters = parameters;
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
            const localPromptPath = join(process.cwd(), 'server', 'prompts', 'preset_converter.json');
            const promptPath = existsSync(localPromptPath)
                ? localPromptPath
                : join(rootDir, 'prompts', 'preset_converter.json');
            if (!existsSync(promptPath)) {
                return reply.code(500).send({ error: 'Missing preset_converter prompt', message: `Not found: ${promptPath}` });
            }

            const promptJson = JSON.parse(readFileSync(promptPath, 'utf-8')) as any;
            const fileMessages = Array.isArray(promptJson?.messages) ? promptJson.messages : null;
            const systemPrompt = typeof promptJson?.system === 'string' ? promptJson.system : '';
            const baseMessages = fileMessages
                ? fileMessages
                    .filter((m: any) => m && typeof m.role === 'string' && typeof m.content === 'string')
                    .map((m: any) => ({ role: m.role, content: m.content }))
                : null;

            if (baseMessages && baseMessages.length === 0) {
                return reply.code(500).send({ error: 'Invalid preset_converter prompt', message: 'Empty messages template' });
            }
            if (!baseMessages && !systemPrompt) {
                return reply.code(500).send({ error: 'Invalid preset_converter prompt', message: 'Missing system prompt' });
            }

            const apiBaseUrl = typeof body.apiBaseUrl === 'string' ? body.apiBaseUrl.trim() : '';
            const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';

            if (!apiBaseUrl || !apiKey) {
                return reply.code(400).send({
                    error: 'Missing apiBaseUrl/apiKey',
                    message: 'Please fill apiBaseUrl and apiKey in UI (no .env fallback)',
                });
            }

            const model = (typeof body.model === 'string' && body.model.trim())
                ? body.model.trim()
                : 'gpt-4o-mini';

            const temperature = typeof body.temperature === 'number'
                ? body.temperature
                : 0;

            const maxTokensFromBody = typeof body.maxTokens === 'number' ? body.maxTokens : undefined;
            const maxTokens = (Number.isFinite(maxTokensFromBody) && (maxTokensFromBody as number) > 0)
                ? (maxTokensFromBody as number)
                : undefined;

            const userContent = rawText;

            const messages = baseMessages
                ? baseMessages.concat([{ role: 'user', content: userContent }])
                : [
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
