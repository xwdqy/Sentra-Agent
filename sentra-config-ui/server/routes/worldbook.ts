import { FastifyInstance } from 'fastify';
import { join, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { TextDecoder } from 'util';
import { XMLParser } from 'fast-xml-parser';

function getRootDir(): string {
  return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

function extractFirstTagBlock(text: string, tagName: string): string {
  if (!text || !tagName) return '';
  const re = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, 'i');
  const m = String(text).match(re);
  return m ? m[0] : '';
}

const sentraWorldbookXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: true,
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (_name: string, jpath: string) => {
    return (
      jpath === 'sentra-worldbook.entries.entry'
      || jpath === 'sentra-worldbook.entries.entry.keywords.keyword'
      || jpath === 'sentra-worldbook.entries.entry.tags.tag'
      || jpath === 'sentra-worldbook.meta.tags.tag'
    );
  },
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function getTextLoose(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && typeof v['#text'] === 'string') return v['#text'];
  return String(v ?? '');
}

function parseBoolLoose(v: any): boolean | undefined {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}

function parseNumberLoose(v: any): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function splitLooseList(text: string): string[] {
  const s = String(text || '').trim();
  if (!s) return [];
  return s
    .split(/[,，;；\n\r\t]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseStringListNode(parent: any, containerKey: string, itemKey: string): string[] {
  const container = parent?.[containerKey];
  if (container == null) return [];
  const fromItems = asArray<any>(container?.[itemKey])
    .map((x) => getTextLoose(x).trim())
    .filter(Boolean);
  if (fromItems.length > 0) return fromItems;
  const inline = getTextLoose(container).trim();
  if (inline) return splitLooseList(inline);
  return [];
}

function parseSentraWorldbookXml(xml: string): any {
  if (!xml) return null;
  let parsed: any;
  try {
    parsed = sentraWorldbookXmlParser.parse(xml);
  } catch {
    return null;
  }

  const root = parsed && typeof parsed === 'object' ? (parsed['sentra-worldbook'] || parsed) : null;
  if (!root || typeof root !== 'object') return null;

  const metaNode = root.meta && typeof root.meta === 'object' ? root.meta : {};
  const meta: any = {
    title: getTextLoose(metaNode.title).trim() || undefined,
    version: getTextLoose(metaNode.version).trim() || undefined,
    description: getTextLoose(metaNode.description).trim() || undefined,
    language: getTextLoose(metaNode.language).trim() || undefined,
  };

  const metaTags = parseStringListNode(metaNode, 'tags', 'tag');
  if (metaTags.length > 0) meta.tags = metaTags;

  const entryNodes = asArray<any>(root?.entries?.entry);
  const entries = entryNodes.map((e) => {
    const id = getTextLoose(e?.id).trim();
    const name = getTextLoose(e?.name).trim();

    const keywords = parseStringListNode(e, 'keywords', 'keyword');
    const tags = parseStringListNode(e, 'tags', 'tag');

    const content = getTextLoose(e?.content);
    const priority = parseNumberLoose(getTextLoose(e?.priority).trim());
    const enabled = parseBoolLoose(getTextLoose(e?.enabled).trim());

    const out: any = {};
    if (id) out.id = id;
    if (name) out.name = name;
    if (keywords.length > 0) out.keywords = keywords;
    if (typeof content === 'string' && content.trim()) out.content = content;
    if (priority != null) out.priority = priority;
    if (enabled != null) out.enabled = enabled;
    if (tags.length > 0) out.tags = tags;
    return out;
  }).filter((x) => x && typeof x === 'object' && Object.keys(x).length > 0);

  const result: any = {};
  if (meta && Object.values(meta).some((x) => x != null && String(x).trim())) result.meta = meta;
  result.entries = entries;
  return result;
}

function normalizeWorldbookJson(obj: any) {
  const base = obj && typeof obj === 'object' ? { ...obj } : {};
  if (!base.meta || typeof base.meta !== 'object') base.meta = {};
  if (!Array.isArray(base.entries)) {
    if (base.entries && typeof base.entries === 'object') base.entries = [base.entries];
    else base.entries = [];
  }
  return base;
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
    if (full) {
      const chunkSize = 80;
      for (let i = 0; i < full.length; i += chunkSize) {
        const chunk = full.slice(i, i + chunkSize);
        if (chunk) params.onDelta(chunk);
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
      while (true) {
        const n1 = buffer.indexOf('\n\n');
        const n2 = buffer.indexOf('\r\n\r\n');
        if (n1 < 0 && n2 < 0) break;
        const useIdx = n1 < 0 ? n2 : (n2 < 0 ? n1 : Math.min(n1, n2));
        const sepLen = useIdx === n2 ? 4 : 2;
        const frame = buffer.slice(0, useIdx);
        buffer = buffer.slice(useIdx + sepLen);
        handleFrame(frame);
      }
    }
  } else if (body && (Symbol.asyncIterator in body)) {
    for await (const chunk of body) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true } as any);
      while (true) {
        const n1 = buffer.indexOf('\n\n');
        const n2 = buffer.indexOf('\r\n\r\n');
        if (n1 < 0 && n2 < 0) break;
        const useIdx = n1 < 0 ? n2 : (n2 < 0 ? n1 : Math.min(n1, n2));
        const sepLen = useIdx === n2 ? 4 : 2;
        const frame = buffer.slice(0, useIdx);
        buffer = buffer.slice(useIdx + sepLen);
        handleFrame(frame);
      }
    }
  }

  return fullText;
}

export async function worldbookRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: {
      text: string;
      apiBaseUrl?: string;
      apiKey?: string;
      model?: string;
      temperature?: number;
      stream?: boolean;
      maxTokens?: number;
    };
  }>('/api/worldbook/generate', async (request, reply) => {
    try {
      const body = request.body || ({} as any);
      const rawText = typeof body.text === 'string' ? body.text.trim() : '';
      if (!rawText) {
        return reply.code(400).send({ error: 'Missing text' });
      }

      const rootDir = getRootDir();
      const localPromptPath = join(process.cwd(), 'server', 'prompts', 'worldbook_generator.json');
      const promptPath = existsSync(localPromptPath)
        ? localPromptPath
        : join(rootDir, 'prompts', 'worldbook_generator.json');

      if (!existsSync(promptPath)) {
        return reply.code(500).send({ error: 'Missing worldbook_generator prompt', message: `Not found: ${promptPath}` });
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
        return reply.code(500).send({ error: 'Invalid worldbook_generator prompt', message: 'Empty messages template' });
      }
      if (!baseMessages && !systemPrompt) {
        return reply.code(500).send({ error: 'Invalid worldbook_generator prompt', message: 'Missing system prompt' });
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

      const temperature = typeof body.temperature === 'number' ? body.temperature : 0.4;

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

        const wbXml = extractFirstTagBlock(assistantText, 'sentra-worldbook');
        if (!wbXml) {
          writeSse(reply, { type: 'error', message: 'Missing <sentra-worldbook> block in LLM output', raw: assistantText }, 'error');
          clearInterval(heartbeat);
          reply.raw.end();
          return;
        }

        let extracted: any;
        try {
          extracted = parseSentraWorldbookXml(wbXml);
        } catch (e: any) {
          writeSse(reply, { type: 'error', message: e?.message || String(e), worldbookXml: wbXml }, 'error');
          clearInterval(heartbeat);
          reply.raw.end();
          return;
        }

        if (!extracted || typeof extracted !== 'object') {
          writeSse(reply, { type: 'error', message: 'Failed to parse <sentra-worldbook> block', worldbookXml: wbXml }, 'error');
          clearInterval(heartbeat);
          reply.raw.end();
          return;
        }

        const worldbookJson = normalizeWorldbookJson(extracted);
        writeSse(reply, { type: 'done', worldbookXml: wbXml, worldbookJson }, 'done');
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

      const wbXml = extractFirstTagBlock(assistantText, 'sentra-worldbook');
      if (!wbXml) {
        return reply.code(502).send({
          error: 'Invalid upstream response',
          message: 'Missing <sentra-worldbook> block in LLM output',
          raw: assistantText,
        });
      }

      const extracted = parseSentraWorldbookXml(wbXml);
      if (!extracted || typeof extracted !== 'object') {
        return reply.code(502).send({
          error: 'Invalid upstream response',
          message: 'Failed to parse <sentra-worldbook> block',
          worldbookXml: wbXml,
        });
      }

      const worldbookJson = normalizeWorldbookJson(extracted);
      return { worldbookXml: wbXml, worldbookJson };
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to generate worldbook',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
