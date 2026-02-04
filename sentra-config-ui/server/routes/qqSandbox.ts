import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

function sendJson(conn: any, payload: any) {
  try {
    conn.socket.send(JSON.stringify(payload));
  } catch {
  }
}

function safeClose(sock: any, code?: number, reason?: string) {
  try {
    if (sock && typeof sock.close === 'function') {
      sock.close(code, reason);
    }
  } catch {
  }
}

function probeWs(url: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    let t: NodeJS.Timeout | null = null;
    let ws: any = null;

    const finish = (res: { ok: boolean; error?: string }) => {
      if (done) return;
      done = true;
      try { if (t) clearTimeout(t); } catch { }
      t = null;
      try { if (ws) safeClose(ws); } catch { }
      ws = null;
      resolve(res);
    };

    try {
      ws = new WebSocket(url, { handshakeTimeout: timeoutMs } as any);
    } catch (e: any) {
      finish({ ok: false, error: e?.message || String(e) });
      return;
    }

    t = setTimeout(() => {
      finish({ ok: false, error: 'timeout' });
    }, Math.max(200, timeoutMs + 50));

    try {
      ws.on?.('open', () => finish({ ok: true }));
      ws.on?.('error', (err: any) => finish({ ok: false, error: err?.message || String(err) }));
      ws.on?.('close', () => {
        if (!done) finish({ ok: false, error: 'closed' });
      });
    } catch {
    }
  });
}

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = String(content || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if (!k) continue;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function boolEnv(v: any, def: boolean) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return def;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false;
  return def;
}

function toInt(v: any, def: number) {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}

function safeString(v: any): string {
  return String(v ?? '').trim();
}

function normalizeFilename(name: string): string {
  const raw = safeString(name);
  if (!raw) return '';
  const base = raw.replace(/\\/g, '/').split('/').pop() || '';
  const cleaned = base
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length > 160) return cleaned.slice(0, 160);
  return cleaned;
}

function parseDataUrl(dataUrl: string): Buffer | null {
  const s = safeString(dataUrl);
  if (!s) return null;
  const m = s.match(/^data:([\w+\-./]+);base64,(.+)$/i);
  if (!m) return null;
  try {
    return Buffer.from(m[2], 'base64');
  } catch {
    return null;
  }
}

function ensureDir(dir: string) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
  }
}

function getSentraRootDir() {
  return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

type NapcatSandboxDefaults = {
  envPath?: string;
  streamPort: number;
  enableStream: boolean;
  connectMode: 'forward' | 'reverse';
  reversePort: number;
  reversePath: string;
  wsUrl: string;
};

let cachedDefaults: { ts: number; value: NapcatSandboxDefaults } | null = null;
const DEFAULTS_CACHE_TTL_MS = 3000;

function loadNapcatDefaults(): NapcatSandboxDefaults {
  const root = getSentraRootDir();
  const override = String(process.env.NAPCAT_ENV_PATH || '').trim();
  const candidates = [
    override,
    join(root, 'sentra-adapter', 'napcat', '.env'),
    join(root, 'sentra-adapter', 'napcat', '.env.example'),
  ].filter(Boolean);

  let envPath: string | undefined;
  let parsed: Record<string, string> = {};
  for (const p of candidates) {
    try {
      const full = resolve(p);
      if (!existsSync(full)) continue;
      const content = readFileSync(full, 'utf-8');
      parsed = parseDotEnv(content);
      envPath = full;
      break;
    } catch {
    }
  }

  const streamPort = toInt(parsed.STREAM_PORT, 6702);
  const enableStream = boolEnv(parsed.ENABLE_STREAM, false);
  const modeRaw = String(parsed.NAPCAT_MODE || parsed.MODE || 'forward').toLowerCase();
  const connectMode: 'forward' | 'reverse' = modeRaw === 'reverse' ? 'reverse' : 'forward';

  return {
    envPath,
    streamPort: Number.isFinite(streamPort) && streamPort > 0 ? Math.trunc(streamPort) : 6702,
    enableStream,
    connectMode,
    reversePort: toInt(parsed.REVERSE_PORT, 6701),
    reversePath: String(parsed.REVERSE_PATH || '/onebot'),
    wsUrl: String(parsed.NAPCAT_WS_URL || 'ws://127.0.0.1:6700'),
  };
}

function getNapcatDefaultsCached(): NapcatSandboxDefaults {
  const now = Date.now();
  if (cachedDefaults && now - cachedDefaults.ts < DEFAULTS_CACHE_TTL_MS) return cachedDefaults.value;
  const value = loadNapcatDefaults();
  cachedDefaults = { ts: now, value };
  return value;
}

export async function qqSandboxRoutes(fastify: FastifyInstance) {
  fastify.get('/api/qq/sandbox/config', async () => {
    const cfg = getNapcatDefaultsCached();
    return {
      streamPort: cfg.streamPort,
      enableStream: cfg.enableStream,
      connectMode: cfg.connectMode,
      reversePort: cfg.reversePort,
      reversePath: cfg.reversePath,
      wsUrl: cfg.wsUrl,
      envPath: cfg.envPath || '',
    };
  });

  fastify.get('/api/qq/sandbox/health', async (request) => {
    const q: any = (request as any)?.query || {};
    const defaults = getNapcatDefaultsCached();
    const defaultPort = defaults?.streamPort || 6702;

    if (!defaults.enableStream) {
      return {
        ok: false,
        port: defaultPort,
        upstreamUrl: '',
        time: Date.now(),
        error: 'stream_disabled: ENABLE_STREAM=false',
        enableStream: false,
        connectMode: defaults.connectMode,
        envPath: defaults.envPath || '',
      };
    }

    const portRaw = Number(q?.port);
    const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.trunc(portRaw) : defaultPort;
    const safePort = Number.isFinite(port) && port >= 1 && port <= 65535 ? port : defaultPort;

    const upstreamUrl = `ws://127.0.0.1:${safePort}`;
    const timeoutMs = 1600;
    const res = await probeWs(upstreamUrl, timeoutMs);
    return {
      ok: !!res.ok,
      port: safePort,
      upstreamUrl,
      time: Date.now(),
      error: res.ok ? '' : (res.error || 'unknown'),
      enableStream: defaults.enableStream,
      connectMode: defaults.connectMode,
      envPath: defaults.envPath || '',
    };
  });

  fastify.post('/api/qq/sandbox/upload', async (request, reply) => {
    try {
      const body: any = (request as any).body || {};
      const filename = normalizeFilename(body.filename);
      const kindRaw = safeString(body.kind).toLowerCase();
      const kind: 'image' | 'file' = kindRaw === 'image' ? 'image' : 'file';
      const dataUrl = safeString(body.dataUrl);
      if (!filename) {
        reply.code(400).send({ success: false, error: 'Invalid filename' });
        return;
      }
      const buf = parseDataUrl(dataUrl);
      if (!buf) {
        reply.code(400).send({ success: false, error: 'Invalid dataUrl (expected data:*/*;base64,...)' });
        return;
      }
      const root = getSentraRootDir();
      const base = join(root, 'sentra-adapter', 'napcat', 'cache');
      const dir = kind === 'image' ? join(base, 'images') : join(base, 'file');
      ensureDir(base);
      ensureDir(dir);
      const abs = join(dir, filename);
      writeFileSync(abs, buf);
      return { success: true, path: abs };
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.get(
    '/api/qq/sandbox/ws',
    ({ websocket: true } as any),
    (connection: any, req: any) => {
      const q: any = req?.query || {};
      const defaults = getNapcatDefaultsCached();
      const defaultPort = defaults?.streamPort || 6702;

      const portRaw = Number(q?.port);
      const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.trunc(portRaw) : defaultPort;

      const safePort = Number.isFinite(port) && port >= 1 && port <= 65535 ? port : defaultPort;
      const upstreamUrl = `ws://127.0.0.1:${safePort}`;
      let upstream: any = null;
      let closed = false;

      const clientSock: any = connection?.socket;

      const MAX_WS_BUFFERED = 4_000_000;
      const CONNECT_TIMEOUT_MS = 6_000;
      const HEARTBEAT_MS = 20_000;
      const HEARTBEAT_GRACE_MS = 12_000;

      let connectTimer: NodeJS.Timeout | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let upLastPong = Date.now();
      let clientLastPong = Date.now();

      const closeAll = () => {
        if (closed) return;
        closed = true;

        try { if (connectTimer) clearTimeout(connectTimer); } catch { }
        try { if (heartbeatTimer) clearInterval(heartbeatTimer); } catch { }
        connectTimer = null;
        heartbeatTimer = null;

        try { (upstream as any)?.removeAllListeners?.(); } catch { }
        try { (connection.socket as any)?.removeAllListeners?.(); } catch { }

        try { upstream?.close(); } catch { }
        upstream = null;

        safeClose(clientSock);
      };

      const sendProxyEvent = (event: string, extra?: any) => {
        sendJson(connection, {
          type: 'proxy',
          event,
          time: Date.now(),
          upstream: { url: upstreamUrl },
          ...extra,
        });
      };

      try {
        upstream = new WebSocket(upstreamUrl, {
          handshakeTimeout: CONNECT_TIMEOUT_MS,
        } as any);
      } catch (e: any) {
        sendJson(connection, { type: 'error', message: e?.message || String(e) });
        closeAll();
        return;
      }

      const up: any = upstream;

      // Ensure we don't hang forever on an unopened upstream.
      connectTimer = setTimeout(() => {
        if (closed) return;
        if (!up || up.readyState !== WebSocket.OPEN) {
          sendJson(connection, { type: 'error', message: `Upstream connect timeout: ${upstreamUrl}` });
          closeAll();
        }
      }, CONNECT_TIMEOUT_MS);

      up.on('open', () => {
        try { if (connectTimer) clearTimeout(connectTimer); } catch { }
        connectTimer = null;
        upLastPong = Date.now();
        clientLastPong = Date.now();
        sendJson(connection, { type: 'welcome', message: 'QQ Sandbox Proxy', time: Date.now() });
        sendProxyEvent('upstream_open');
      });

      up.on?.('pong', () => {
        upLastPong = Date.now();
      });

      up.on?.('message', (data: any) => {
        if (closed) return;
        try {
          const sock: any = connection?.socket;
          if (sock && typeof sock.bufferedAmount === 'number' && sock.bufferedAmount > MAX_WS_BUFFERED) {
            sendJson(connection, { type: 'error', message: 'Client WS backpressure: bufferedAmount too large' });
            closeAll();
            return;
          }

          const out = Buffer.isBuffer(data)
            ? data
            : (typeof data === 'string' ? data : String(data || ''));
          sock.send(out);
        } catch {
          closeAll();
        }
      });

      up.on?.('close', (code: number, reason: Buffer) => {
        if (closed) return;
        const msg = `upstream_closed:${code}${reason?.length ? `:${reason.toString()}` : ''}`;
        sendJson(connection, { type: 'disconnect', message: msg });
        sendProxyEvent('upstream_close', { code, reason: reason?.toString?.() || '' });
        closeAll();
      });

      up.on?.('error', (err: any) => {
        if (closed) return;
        sendJson(connection, { type: 'error', message: err?.message || String(err) });
        sendProxyEvent('upstream_error', { message: err?.message || String(err) });
        closeAll();
      });

      // Heartbeat: ping both sides, and kill dead connections.
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        const now = Date.now();

        try {
          if (up && up.readyState === WebSocket.OPEN && typeof up.ping === 'function') {
            up.ping();
          }
        } catch {
        }

        try {
          if (clientSock && typeof clientSock.ping === 'function' && clientSock.readyState === WebSocket.OPEN) {
            clientSock.ping();
          }
        } catch {
        }

        if (up && up.readyState === WebSocket.OPEN && now - upLastPong > HEARTBEAT_MS + HEARTBEAT_GRACE_MS) {
          sendJson(connection, { type: 'error', message: 'Upstream heartbeat timeout' });
          closeAll();
          return;
        }

        if (clientSock && clientSock.readyState === WebSocket.OPEN && now - clientLastPong > HEARTBEAT_MS + HEARTBEAT_GRACE_MS) {
          sendJson(connection, { type: 'error', message: 'Client heartbeat timeout' });
          closeAll();
        }
      }, HEARTBEAT_MS);

      connection.socket.on('pong', () => {
        clientLastPong = Date.now();
      });

      connection.socket.on('message', (raw: any) => {
        if (closed) return;
        try {
          if (!up || up.readyState !== WebSocket.OPEN) return;
          if (typeof up.bufferedAmount === 'number' && up.bufferedAmount > MAX_WS_BUFFERED) {
            sendJson(connection, { type: 'error', message: 'Upstream WS backpressure: bufferedAmount too large' });
            closeAll();
            return;
          }

          if (Buffer.isBuffer(raw)) up.send(raw);
          else up.send(String(raw || ''));
        } catch {
          closeAll();
        }
      });

      connection.socket.on('close', () => {
        sendProxyEvent('client_close');
        closeAll();
      });

      connection.socket.on('error', (err: any) => {
        if (closed) return;
        sendProxyEvent('client_error', { message: err?.message || String(err) });
        closeAll();
      });
    },
  );
}
