import type { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

function getRootDir(): string {
  return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

function getSentraMcpDir(): string {
  return join(getRootDir(), 'sentra-mcp');
}

function serversDirAbs() {
  return join(getSentraMcpDir(), 'mcp');
}

function serversJsonAbs() {
  return join(getSentraMcpDir(), 'mcp', 'servers.json');
}

function safeString(v: any) {
  return v == null ? '' : String(v);
}

type McpServerType = 'stdio' | 'websocket' | 'http' | 'streamable_http';

export type McpServerDef = {
  id: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
};

type ReadResult = {
  items: McpServerDef[];
  parseError?: string;
};

function normalizeServerDef(input: any): McpServerDef | null {
  if (!input || typeof input !== 'object') return null;
  const id = safeString(input.id).trim();
  const rawType = safeString(input.type).trim().toLowerCase() as McpServerType;
  const type: McpServerType = rawType === 'streamable_http' ? 'http' : rawType;

  if (!id) return null;
  if (!['stdio', 'websocket', 'http'].includes(type)) return null;

  const out: McpServerDef = { id, type };

  if (type === 'stdio') {
    const command = safeString(input.command).trim();
    const args = Array.isArray(input.args) ? input.args.map((x: any) => safeString(x)).filter(Boolean) : [];
    if (!command) return null;
    out.command = command;
    if (args.length) out.args = args;
  } else {
    const url = safeString(input.url).trim();
    if (!url) return null;
    out.url = url;

    if (input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(input.headers)) {
        const kk = safeString(k).trim();
        const vv = safeString(v).trim();
        if (!kk) continue;
        headers[kk] = vv;
      }
      if (Object.keys(headers).length) out.headers = headers;
    }
  }

  return out;
}

function readServersJsonAt(abs: string): ReadResult {
  if (!abs) return { items: [] };
  if (!existsSync(abs)) return { items: [] };
  try {
    const raw = readFileSync(abs, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { items: [], parseError: 'JSON 必须是数组' };
    const items = parsed.map(normalizeServerDef).filter(Boolean) as McpServerDef[];
    return { items };
  } catch (e: any) {
    return { items: [], parseError: e?.message || String(e) };
  }
}

function writeServersJsonAt(abs: string, items: McpServerDef[]) {
  mkdirSync(dirname(abs), { recursive: true });
  const normalized = (Array.isArray(items) ? items : [])
    .map(normalizeServerDef)
    .filter(Boolean) as McpServerDef[];

  // Deduplicate by id (keep last)
  const map = new Map<string, McpServerDef>();
  for (const it of normalized) map.set(it.id, it);
  const uniq = Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));

  writeFileSync(abs, JSON.stringify(uniq, null, 2) + '\n', 'utf-8');
  return { count: uniq.length };
}

function writeServersJson(items: McpServerDef[]) {
  const abs = serversJsonAbs();
  return writeServersJsonAt(abs, items);
}

export async function mcpServersRoutes(fastify: FastifyInstance) {
  fastify.get('/api/mcp-servers/status', async () => {
    const dir = serversDirAbs();
    const abs = serversJsonAbs();
    const dirExists = existsSync(dir);
    const jsonExists = existsSync(abs);
    const read = jsonExists ? readServersJsonAt(abs) : { items: [] };
    return {
      baseDirAbs: dir,
      serversJsonAbs: abs,
      baseDirRel: 'sentra-mcp/mcp',
      serversJsonRel: 'sentra-mcp/mcp/servers.json',
      baseDirExists: dirExists,
      serversJsonExists: jsonExists,
      parseError: read.parseError || null,
      count: read.items.length,
    };
  });

  fastify.post('/api/mcp-servers/ensure', async () => {
    const dir = serversDirAbs();
    mkdirSync(dir, { recursive: true });
    const abs = serversJsonAbs();
    if (!existsSync(abs)) {
      writeFileSync(abs, JSON.stringify([], null, 2) + '\n', 'utf-8');
    }
    return { success: true };
  });

  fastify.get('/api/mcp-servers/items', async () => {
    const abs = serversJsonAbs();
    const read = readServersJsonAt(abs);
    return {
      serversJsonAbs: abs,
      serversJsonRel: 'sentra-mcp/mcp/servers.json',
      parseError: read.parseError || null,
      items: read.items,
    };
  });

  fastify.post('/api/mcp-servers/items', async (request, reply) => {
    try {
      const body: any = request.body || {};
      const items = Array.isArray(body.items) ? body.items : [];
      const result = writeServersJson(items);
      return { success: true, ...result };
    } catch (e: any) {
      reply.code(400).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.post('/api/mcp-servers/test', async (request, reply) => {
    try {
      const def: any = (request.body as any) || {};
      const id = safeString(def.id).trim();
      const rawType = safeString(def.type).trim().toLowerCase() as McpServerType;
      const type: McpServerType = rawType === 'streamable_http' ? 'http' : rawType;
      if (!id) throw new Error('id 不能为空');
      if (!['stdio', 'websocket', 'http'].includes(type)) throw new Error('type 不合法');

      if (type === 'http') {
        const url = safeString(def.url).trim();
        if (!url) throw new Error('url 不能为空');

        const headers: Record<string, string> = {};
        if (def.headers && typeof def.headers === 'object' && !Array.isArray(def.headers)) {
          for (const [k, v] of Object.entries(def.headers)) {
            const kk = safeString(k).trim();
            if (!kk) continue;
            headers[kk] = safeString(v);
          }
        }

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 6000);
        try {
          const res = await fetch(url, { method: 'GET', headers, signal: controller.signal } as any);
          return {
            success: true,
            id,
            type,
            url,
            status: res.status,
            ok: res.ok,
          };
        } finally {
          clearTimeout(t);
        }
      }

      if (type === 'websocket') {
        return { success: false, id, type, error: 'websocket 测试暂未实现（仅支持 http/streamable_http）' };
      }

      return { success: false, id, type, error: 'stdio 测试暂未实现（建议先确认 command 可执行）' };
    } catch (e: any) {
      reply.code(400).send({ success: false, error: e?.message || String(e) });
    }
  });
}
