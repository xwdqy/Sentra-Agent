import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getRuntimeSignal } from './runtime_context.js';
import { mergeAbortSignals, makeAbortError } from './signal.js';

let projectEnvCache = null;
function getProjectEnv() {
  if (projectEnvCache) return projectEnvCache;
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, '../..');
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      projectEnvCache = dotenv.parse(fs.readFileSync(envPath));
    } else {
      projectEnvCache = {};
    }
  } catch {
    projectEnvCache = {};
  }
  return projectEnvCache;
}

function getProjectEnvNumber(key) {
  const raw = getProjectEnv()?.[key];
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

const DEFAULT_WS_TIMEOUT_MS = (() => {
  const fromEnv = getProjectEnvNumber('WS_RPC_TIMEOUT_MS');
  return Math.max(1000, Number.isFinite(fromEnv) ? fromEnv : 15000);
})();

async function getWebSocketImpl() {
  if (typeof globalThis !== 'undefined' && typeof globalThis.WebSocket === 'function') {
    return globalThis.WebSocket;
  }
  try {
    const mod = await import('ws');
    return mod.WebSocket || mod.default || mod;
  } catch {}
  try {
    const mod = await import('undici');
    return mod.WebSocket;
  } catch {}
  return null;
}

function parseJsonSafe(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function buildDefaultMatcher(payload) {
  return (data) => {
    if (!data || data.type === 'welcome') return false;
    const rid = payload.requestId;
    if (typeof data.requestId === 'string' && rid && data.requestId === rid) return true;
    if (typeof data.echo === 'string' && rid && data.echo === rid) return true;
    const p = payload.path;
    if (data.path && p && data.path === p) return true;
    if (data.cmd && p && data.cmd === p) return true;
    if (data.action && p && data.action === p) return true;
    if (data.route && p && data.route === p) return true;
    return false;
  };
}

export default async function wsCall({ url, path, args = [], requestId, timeoutMs = DEFAULT_WS_TIMEOUT_MS, match, signal } = {}) {
  const WS = await getWebSocketImpl();
  if (!WS) throw new Error('WebSocket client unavailable, install ws or use Node 18+ with undici');

  const payload = { type: 'sdk', path, args, requestId, echo: requestId };
  const matcher = match || buildDefaultMatcher(payload);
  const mergedSignal = mergeAbortSignals([signal, getRuntimeSignal()]);

  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    let ws;

    const done = (err, res) => {
      if (settled) return;
      settled = true;
      try { if (timer) clearTimeout(timer); } catch {}
      try { if (mergedSignal && onAbort) mergedSignal.removeEventListener('abort', onAbort); } catch {}
      try { ws && ws.close?.(); } catch {}
      if (err) return reject(err);
      resolve(res);
    };

    const onAbort = () => {
      done(makeAbortError('WebSocket request aborted', 'RUN_ABORTED', {
        path: String(path || ''),
        requestId: String(requestId || ''),
      }));
    };

    if (mergedSignal?.aborted) {
      onAbort();
      return;
    }

    try {
      ws = new WS(url);
    } catch (e) {
      reject(e);
      return;
    }

    const onOpen = () => {
      try { ws.send(JSON.stringify(payload)); } catch (e) { done(e); }
    };

    const onMessage = (msg) => {
      try {
        const raw = typeof msg === 'string'
          ? msg
          : (msg?.data ? msg.data : (Buffer.isBuffer(msg) ? msg.toString('utf-8') : String(msg)));
        const data = parseJsonSafe(raw);
        if (!data) return;
        if (!matcher(data)) return;
        done(null, data);
      } catch {}
    };

    const onError = (e) => done(new Error(String(e?.message || e)));
    const onClose = () => {
      if (!settled) done(new Error('WebSocket closed before response'));
    };

    if (ws.on) {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
    } else if (ws.addEventListener) {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
    }

    if (mergedSignal) {
      mergedSignal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(
      () => done(new Error('WebSocket timeout')),
      Math.max(1000, Number(timeoutMs) || DEFAULT_WS_TIMEOUT_MS)
    );
  });
}
