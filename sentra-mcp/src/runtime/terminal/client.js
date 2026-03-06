import iconv from 'iconv-lite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { httpRequest } from '../../utils/http.js';

const TERMINAL_TYPES = new Set(['powershell', 'cmd', 'bash', 'zsh', 'sh']);
const TOKEN_CACHE_TTL_MS = 15_000;
let tokenCache = { value: '', at: 0 };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeHttpBase(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

export function normalizeTerminalType(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  if (!TERMINAL_TYPES.has(s)) return '';
  return s;
}

export function resolveTerminalType(value) {
  return normalizeTerminalType(value) || (process.platform === 'win32' ? 'powershell' : 'bash');
}

export function resolveTerminalHttpBase(value) {
  const preferred = normalizeHttpBase(
    value
    || process.env.SENTRA_CONFIG_UI_BASE_URL
    || process.env.CONFIG_UI_BASE_URL
  );
  if (preferred) return preferred;
  const portRaw = Number(process.env.SENTRA_CONFIG_UI_PORT || process.env.CONFIG_UI_PORT || process.env.SERVER_PORT || 7245);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 7245;
  return `http://127.0.0.1:${port}`;
}

function normalizePathSafe(input) {
  const p = String(input || '').trim();
  if (!p) return '';
  try {
    return path.resolve(p);
  } catch {
    return '';
  }
}

function parseSecurityTokenFromEnvFile(envPath) {
  const p = normalizePathSafe(envPath);
  if (!p) return '';
  try {
    if (!fs.existsSync(p)) return '';
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = dotenv.parse(raw);
    return String(parsed?.SECURITY_TOKEN || '').trim();
  } catch {
    return '';
  }
}

function getTerminalTokenCache() {
  const now = Date.now();
  if (!tokenCache.value) return '';
  if ((now - Number(tokenCache.at || 0)) > TOKEN_CACHE_TTL_MS) return '';
  return tokenCache.value;
}

function setTerminalTokenCache(value) {
  const t = String(value || '').trim();
  tokenCache = { value: t, at: Date.now() };
  return t;
}

function discoverSecurityTokenFromKnownEnvFiles() {
  const cwd = process.cwd();
  const configUiDir = normalizePathSafe(
    process.env.SENTRA_CONFIG_UI_DIR
    || process.env.CONFIG_UI_DIR
    || ''
  );
  const candidates = [
    path.resolve(cwd, 'sentra-config-ui', '.env'),
    path.resolve(cwd, '.env'),
    configUiDir ? path.resolve(configUiDir, '.env') : '',
    path.resolve(__dirname, '../../../../.env'),
    path.resolve(__dirname, '../../../../../.env'),
    path.resolve(__dirname, '../../../../../sentra-config-ui/.env'),
  ].filter(Boolean);

  const dedup = Array.from(new Set(candidates.map((p) => normalizePathSafe(p)).filter(Boolean)));
  for (const envPath of dedup) {
    const token = parseSecurityTokenFromEnvFile(envPath);
    if (token) return token;
  }
  return '';
}

export function resolveTerminalToken(value) {
  const explicit = String(value || '').trim();
  if (explicit) return explicit;

  const fromEnv = String(process.env.SECURITY_TOKEN || '').trim();
  if (fromEnv) return fromEnv;

  const cached = getTerminalTokenCache();
  if (cached) return cached;

  const discovered = discoverSecurityTokenFromKnownEnvFiles();
  if (discovered) {
    process.env.SECURITY_TOKEN = discovered;
    return setTerminalTokenCache(discovered);
  }
  return '';
}

function buildHeaders(token = '') {
  return {
    'x-auth-token': String(token || '').trim(),
    'Content-Type': 'application/json'
  };
}

export function buildTerminalWsUrl(httpBase, sessionId, token, cursor = 0) {
  const base = resolveTerminalHttpBase(httpBase);
  const sid = String(sessionId || '').trim();
  if (!base || !sid) throw new Error('buildTerminalWsUrl requires httpBase and sessionId');
  const u = new URL(`${base}/api/terminal-executor/ws/${encodeURIComponent(sid)}`);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (token) u.searchParams.set('token', String(token || '').trim());
  u.searchParams.set('cursor', String(Number(cursor || 0) || 0));
  return u.toString();
}

export async function createTerminalSession({ httpBase, token, shellType, cwd }) {
  const base = resolveTerminalHttpBase(httpBase);
  const url = `${base}/api/terminal-executor/create`;
  const res = await httpRequest({
    method: 'POST',
    url,
    headers: buildHeaders(token),
    data: {
      shellType: resolveTerminalType(shellType),
      cwd: String(cwd || '').trim() || undefined,
    },
    timeoutMs: 15000,
    validateStatus: () => true,
  });
  const data = res?.data || {};
  if (!(res.status >= 200 && res.status < 300) || !data?.success || !data?.sessionId) {
    const msg = String(data?.message || data?.error || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return String(data.sessionId);
}

export async function closeTerminalSession({ httpBase, token, sessionId }) {
  const base = resolveTerminalHttpBase(httpBase);
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  const url = `${base}/api/terminal-executor/close/${encodeURIComponent(sid)}`;
  await httpRequest({
    method: 'POST',
    url,
    headers: buildHeaders(token),
    data: {},
    timeoutMs: 15000,
    validateStatus: () => true,
  });
}

export function decodeTerminalChunk(raw, encoding = 'utf8') {
  const text = String(raw == null ? '' : raw);
  const enc = String(encoding || '').trim().toLowerCase();
  if (!enc || enc === 'utf8' || enc === 'utf-8') return text;
  const buf = Buffer.from(text);
  if (enc === 'gbk' || enc === 'gb2312' || enc === 'gb18030') {
    try { return iconv.decode(buf, 'gbk'); } catch { return text; }
  }
  if (enc === 'latin1' || enc === 'iso-8859-1') {
    try { return buf.toString('latin1'); } catch { return text; }
  }
  return text;
}

export function buildExecPayload(command, shellType, expectExit = true) {
  const cmd = String(command || '').trim();
  if (!cmd) return '';
  const sh = resolveTerminalType(shellType);
  if (!expectExit) {
    if (sh === 'powershell' || sh === 'cmd') return `${cmd}\r\n`;
    return `${cmd}\n`;
  }
  if (sh === 'powershell' || sh === 'cmd') return `${cmd}\r\nexit\r\n`;
  return `${cmd}\nexit\n`;
}

export function buildCtrlCPayload() {
  return '\u0003';
}
