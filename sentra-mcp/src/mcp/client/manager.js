import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import logger from '../../logger/index.js';

function getCanonicalServersJsonPath() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const sentraMcpRoot = path.resolve(__dirname, '..', '..', '..');
  return path.resolve(sentraMcpRoot, 'mcp', 'servers.json');
}

function ensureServersJsonExists(absPath) {
  if (!absPath) return;
  try {
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(absPath)) fs.writeFileSync(absPath, '[]\n', 'utf-8');
  } catch {
    // ignore
  }
}

const MAX_STDIO_BUFFER_BYTES = Math.max(1024, Number.parseInt(process.env.MCP_STDIO_BUFFER_MAX_BYTES || '1048576', 10) || 1048576);

function maskSensitiveText(text) {
  if (!text) return '';
  let sanitized = String(text);

  sanitized = sanitized.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/ig, '$1[REDACTED]');
  sanitized = sanitized.replace(/((?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/ig, '$1[REDACTED]');
  sanitized = sanitized.replace(/(sk-[a-z0-9_-]{12,})/ig, '[REDACTED]');

  return sanitized;
}

class StdioClientTransportWinHidden {
  constructor(server) {
    this._serverParams = server;
    this._abortController = new AbortController();
    this._buffer = '';
    this._process = undefined;
    this._didWarnBufferOverflow = false;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onclose = undefined;
  }

  async start() {
    if (this._process) {
      throw new Error('StdioClientTransportWinHidden already started');
    }
    return new Promise((resolve, reject) => {
      const env = this._serverParams.env || process.env;
      this._process = spawn(this._serverParams.command, this._serverParams.args || [], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        signal: this._abortController.signal,
      });

      this._process.on('error', (error) => {
        if (error?.name === 'AbortError') {
          try { this.onclose?.(); } catch {}
          return;
        }
        reject(error);
        try { this.onerror?.(error); } catch {}
      });

      this._process.on('spawn', () => {
        resolve();
      });

      this._process.on('close', () => {
        this._process = undefined;
        try { this.onclose?.(); } catch {}
      });

      this._process.stdin?.on('error', (error) => {
        try { this.onerror?.(error); } catch {}
      });

      this._process.stdout?.on('data', (chunk) => {
        try {
          this._buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          if (this._buffer.length > MAX_STDIO_BUFFER_BYTES) {
            const idx = this._buffer.lastIndexOf('\n');
            if (idx >= 0) {
              this._buffer = this._buffer.slice(Math.max(0, idx + 1));
            } else {
              this._buffer = this._buffer.slice(-MAX_STDIO_BUFFER_BYTES);
            }
            if (!this._didWarnBufferOverflow) {
              this._didWarnBufferOverflow = true;
              const err = new Error(`StdioClientTransportWinHidden read buffer exceeded ${MAX_STDIO_BUFFER_BYTES} bytes and was truncated`);
              try { this.onerror?.(err); } catch {}
              logger.warn('MCP stdio read buffer overflow protection triggered; truncated unread buffer', { label: 'MCP', maxBytes: MAX_STDIO_BUFFER_BYTES });
            }
          }
          this._processReadBuffer();
        } catch (error) {
          try { this.onerror?.(error); } catch {}
        }
      });

      this._process.stdout?.on('error', (error) => {
        try { this.onerror?.(error); } catch {}
      });

      this._process.stderr?.on('data', (chunk) => {
        try {
          const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          const line = String(s || '').trim();
          if (line) {
            logger.debug?.(maskSensitiveText(line), { label: 'MCP' });
          }
        } catch {}
      });

      this._process.stderr?.on('error', (error) => {
        try { this.onerror?.(error); } catch {}
      });
    });
  }

  _processReadBuffer() {
    while (true) {
      const idx = this._buffer.indexOf('\n');
      if (idx === -1) return;
      const line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this.onmessage?.(msg);
      } catch (error) {
        try { this.onerror?.(error); } catch {}
      }
    }
  }

  async close() {
    try { this._abortController.abort(); } catch {}
    this._process = undefined;
    this._buffer = '';
    this._didWarnBufferOverflow = false;
  }

  send(message) {
    return new Promise((resolve) => {
      if (!this._process?.stdin) {
        throw new Error('Not connected');
      }
      const json = JSON.stringify(message) + '\n';
      if (this._process.stdin.write(json)) {
        resolve();
      } else {
        this._process.stdin.once('drain', resolve);
      }
    });
  }
}

function resolveWindowsCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return cmd;
  if (process.platform !== 'win32') return cmd;

  // Windows 下 CreateProcess 不会按 PATHEXT 自动匹配 .cmd
  // 典型表现：spawn npx ENOENT
  const lowered = cmd.toLowerCase();
  const needsCmd = lowered === 'npx' || lowered === 'npm' || lowered === 'pnpm' || lowered === 'yarn';
  if (!needsCmd) return cmd;
  if (path.extname(cmd)) return cmd;
  return `${cmd}.cmd`;
}




function parseServerUrl(rawUrl, { id, type }) {
  const normalizeRawUrl = (() => {
    if (rawUrl instanceof URL) return rawUrl.toString();
    if (typeof rawUrl === 'string') return rawUrl;
    if (rawUrl && typeof rawUrl === 'object') {
      if (typeof rawUrl.url === 'string') return rawUrl.url;
      if (typeof rawUrl.href === 'string') return rawUrl.href;
      if (typeof rawUrl.toString === 'function') {
        const rendered = rawUrl.toString();
        if (rendered && rendered !== '[object Object]') return rendered;
      }
    }
    return rawUrl;
  })();

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizeRawUrl);
  } catch (e) {
    throw new Error(`MCP server ${id} has invalid ${type} url: ${JSON.stringify(rawUrl)}. ${String(e)}`);
  }

  if ((type === 'http' || type === 'sse') && parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`MCP server ${id} ${type} url must use http/https protocol: ${parsedUrl.toString()}`);
  }

  if (type === 'websocket' && parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
    throw new Error(`MCP server ${id} ${type} url must use ws/wss protocol: ${parsedUrl.toString()}`);
  }

  return parsedUrl;
}

function normalizeHeaders(rawHeaders, { id }) {
  if (rawHeaders == null) return undefined;
  if (typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
    throw new Error(`MCP server ${id} headers must be an object`);
  }

  const normalized = Object.create(null);
  for (const [k, v] of Object.entries(rawHeaders)) {
    const key = String(k || '').trim();
    if (!key) continue;
    const valueType = typeof v;
    if (v == null || (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean')) {
      throw new Error(`MCP server ${id} header ${key} has unsupported value type: ${valueType}`);
    }
    const value = String(v);
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`MCP server ${id} header ${key} contains invalid newline characters`);
    }
    normalized[key] = value;
  }

  return normalized;
}

function readServersConfig() {
  const canonical = getCanonicalServersJsonPath();
  const candidates = [canonical];

  ensureServersJsonExists(canonical);

  if (!fs.existsSync(canonical)) {
    try {
      logger.info('未配置外部 MCP servers.json（将跳过外部 MCP）', {
        label: 'MCP',
        candidates,
      });
    } catch {}
    return [];
  }

  try {
    const raw = fs.readFileSync(canonical, 'utf-8');
    const json = JSON.parse(raw);
    if (!Array.isArray(json)) return [];
    if (json.length) {
      try { logger.info('加载外部 MCP servers.json', { label: 'MCP', path: canonical, count: json.length }); } catch {}
    }
    return json;
  } catch (e) {
    logger.error('Failed to read mcp/servers.json', { path: canonical, error: String(e) });
    return [];
  }
}

export class MCPExternalManager {
  constructor() {
    this.clients = new Map(); // id -> { client, meta }
    this._connectAllPromise = null;
  }

  async connectAll() {
    if (this._connectAllPromise) return this._connectAllPromise;
    this._connectAllPromise = (async () => {
    const defs = readServersConfig();
    if (defs.length) {
      logger.info('外部 MCP 连接开始', { label: 'MCP', count: defs.length });
    }

    const results = await Promise.allSettled(defs.map(async (def) => {
      await this.connect(def);
      return def;
    }));

    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') return;
      const def = defs[idx];
      const msg = String(result.reason);
      if (process.platform === 'win32' && msg.includes('spawn npx ENOENT')) {
        logger.warn('External MCP connect failed: npx not found on Windows (try npx.cmd / check Node.js PATH)', {
          label: 'MCP',
          id: def?.id,
          error: msg,
        });
      } else {
        logger.warn('External MCP connect failed', { label: 'MCP', id: def?.id, error: msg });
      }
    });

    if (defs.length) {
      logger.info('外部 MCP 连接完成', { label: 'MCP', connected: this.clients.size });
    }
    })();
    try {
      await this._connectAllPromise;
    } finally {
      this._connectAllPromise = null;
    }
  }

  async connect(def) {
    const { id, command, args = [], url, headers } = def;
    const rawType = String(def?.type || '').trim();
    const type = rawType === 'streamable_http' ? 'http' : rawType;
    if (!id) throw new Error('External MCP server missing id');

    if (this.clients.has(id)) {
      return;
    }

    let transport;
    if (type === 'stdio') {
      if (!command) throw new Error(`MCP server ${id} stdio requires command`);
      const resolvedCommand = resolveWindowsCommand(command);
      transport = process.platform === 'win32'
        ? new StdioClientTransportWinHidden({ command: resolvedCommand, args })
        : new StdioClientTransport({ command: resolvedCommand, args });
    } else if (type === 'websocket') {
      if (!url) throw new Error(`MCP server ${id} websocket requires url`);
      const parsedUrl = parseServerUrl(url, { id, type });
      transport = new WebSocketClientTransport(parsedUrl);
    } else if (type === 'sse') {
      if (!url) throw new Error(`MCP server ${id} ${type} requires url`);
      const parsedUrl = parseServerUrl(url, { id, type });
      transport = new SSEClientTransport(parsedUrl);
    } else if (type === 'http') {
      if (!url) throw new Error(`MCP server ${id} ${type} requires url`);
      const parsedUrl = parseServerUrl(url, { id, type });
      const normalizedHeaders = normalizeHeaders(headers, { id });
      const options = normalizedHeaders ? { headers: normalizedHeaders } : undefined;
      transport = new StreamableHTTPClientTransport(parsedUrl, options);
    } else {
      throw new Error(`Unsupported MCP server type: ${type}`);
    }

    const client = new Client({ name: 'sentra-mcp-client', version: '0.1.0' });
    await client.connect(transport);
    this.clients.set(id, { client, meta: def });
    logger.info('Connected external MCP server', { label: 'MCP', id, type });
  }

  async listAllTools() {
    const result = [];
    for (const [id, { client }] of this.clients.entries()) {
      try {
        const r = await client.listTools();
        const tools = r.tools || [];
        for (const t of tools) {
          result.push({ ...t, __provider: `external:${id}` });
        }
      } catch (e) {
        logger.error('listTools failed for external server', { label: 'MCP', id, error: String(e) });
      }
    }
    if (this.clients.size) {
      logger.info('外部 MCP 工具列举完成', { label: 'MCP', servers: this.clients.size, tools: result.length });
    }
    return result;
  }

  async callTool(serverId, name, args) {
    const entry = this.clients.get(serverId);
    if (!entry) throw new Error(`External server not connected: ${serverId}`);
    const { client } = entry;
    return client.callTool({ name, arguments: args });
  }
}

export default MCPExternalManager;
