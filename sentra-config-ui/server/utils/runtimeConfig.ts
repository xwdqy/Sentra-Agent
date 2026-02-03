import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { resolve } from 'path';
import { EventEmitter } from 'events';
import dotenv from 'dotenv';

export type QqSandboxLimits = {
  maxActiveMessages: number;
  maxInactiveMessages: number;
  persistMaxConversations: number;
  persistMaxMessages: number;
  renderPageSize: number;
  renderPageStep: number;
};

export type RuntimeConfig = {
  filesRawAllowAny: boolean;
  filesRawAllowDirs: string[];

  // NOTE: These env vars may not exist in .env.example, but are still supported.
  fileTreeCacheTtlMs: number;
  fileSearchCacheTtlMs: number;

  // If set in .env, should override the runtime token.
  securityTokenFromEnv: string;

  qqSandbox: QqSandboxLimits;
};

const emitter = new EventEmitter();

let configVersion = 1;
let currentConfig: RuntimeConfig = computeConfig();

let watching = false;
let watchedPath = '';
let debounceTimer: NodeJS.Timeout | null = null;
let lastLoadedKeys = new Set<string>();

function toBool(v: any, def: boolean): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return def;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'n' || s === 'off') return false;
  return def;
}

function toInt(v: any, def: number, min?: number, max?: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  let out = Math.trunc(n);
  if (typeof min === 'number') out = Math.max(min, out);
  if (typeof max === 'number') out = Math.min(max, out);
  return out;
}

function toStringArray(v: any): string[] {
  const s = String(v ?? '').trim();
  if (!s) return [];
  return s
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function computeConfig(): RuntimeConfig {
  const qqSandbox: QqSandboxLimits = {
    maxActiveMessages: toInt(process.env.QQ_SANDBOX_MAX_ACTIVE_MESSAGES, 200, 20, 5000),
    maxInactiveMessages: toInt(process.env.QQ_SANDBOX_MAX_INACTIVE_MESSAGES, 20, 0, 2000),
    persistMaxConversations: toInt(process.env.QQ_SANDBOX_PERSIST_MAX_CONVERSATIONS, 30, 1, 500),
    persistMaxMessages: toInt(process.env.QQ_SANDBOX_PERSIST_MAX_MESSAGES, 50, 0, 2000),
    renderPageSize: toInt(process.env.QQ_SANDBOX_RENDER_PAGE_SIZE, 120, 20, 2000),
    renderPageStep: toInt(process.env.QQ_SANDBOX_RENDER_PAGE_STEP, 120, 10, 2000),
  };

  return {
    filesRawAllowAny: toBool(process.env.FILES_RAW_ALLOW_ANY, false),
    filesRawAllowDirs: toStringArray(process.env.FILES_RAW_ALLOW_DIRS),
    fileTreeCacheTtlMs: toInt(process.env.FILE_TREE_CACHE_TTL_MS, 6_000, 0, 60_000),
    fileSearchCacheTtlMs: toInt(process.env.FILE_SEARCH_CACHE_TTL_MS, 4_000, 0, 60_000),
    securityTokenFromEnv: String(process.env.SECURITY_TOKEN || '').trim(),
    qqSandbox,
  };
}

function applyEnvSnapshot(parsed: Record<string, string>) {
  // Remove keys that were previously loaded from this .env but no longer exist.
  for (const k of lastLoadedKeys) {
    if (!Object.prototype.hasOwnProperty.call(parsed, k)) {
      try {
        delete (process.env as any)[k];
      } catch {
        // ignore
      }
    }
  }

  for (const [k, v] of Object.entries(parsed)) {
    process.env[k] = v;
  }

  lastLoadedKeys = new Set(Object.keys(parsed));
}

export function getRuntimeConfig(): RuntimeConfig {
  return currentConfig;
}

export function getRuntimeConfigVersion(): number {
  return configVersion;
}

export function onRuntimeConfigChange(handler: (cfg: RuntimeConfig) => void): () => void {
  emitter.on('change', handler);
  return () => emitter.off('change', handler);
}

export function reloadRuntimeConfigFromEnvFile(envPath?: string): { ok: boolean; error?: string } {
  const p = resolve(envPath || resolve(process.cwd(), '.env'));
  if (!existsSync(p)) {
    // Still recompute from current process.env (might be externally updated).
    currentConfig = computeConfig();
    configVersion += 1;
    emitter.emit('change', currentConfig);
    return { ok: true };
  }

  try {
    const parsed = dotenv.parse(readFileSync(p));
    applyEnvSnapshot(parsed);
    currentConfig = computeConfig();
    configVersion += 1;
    emitter.emit('change', currentConfig);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function startRuntimeConfigHotReload(envPath?: string) {
  const p = resolve(envPath || resolve(process.cwd(), '.env'));
  watchedPath = p;

  // Prime once (best-effort).
  reloadRuntimeConfigFromEnvFile(p);

  if (watching) return;
  watching = true;

  // watchFile uses polling and is more reliable on Windows/network drives.
  watchFile(
    p,
    { interval: 900 },
    () => {
      if (debounceTimer) {
        try {
          clearTimeout(debounceTimer);
        } catch {
          // ignore
        }
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        reloadRuntimeConfigFromEnvFile(p);
      }, 250);
    },
  );
}

export function stopRuntimeConfigHotReload() {
  if (!watching) return;
  watching = false;
  if (debounceTimer) {
    try {
      clearTimeout(debounceTimer);
    } catch {
      // ignore
    }
    debounceTimer = null;
  }
  if (watchedPath) {
    try {
      unwatchFile(watchedPath);
    } catch {
      // ignore
    }
  }
  watchedPath = '';
}
