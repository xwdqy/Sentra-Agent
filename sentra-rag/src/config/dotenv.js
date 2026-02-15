import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { setEnvSource } from './env.js';

let initialized = false;
let watcher = null;
let lastReloadAt = 0;
let warnedMissingEnv = false;
let lastEnvMap = null;

function boolFromEnv(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}

function resolveEnvPath(envPath) {
  const p = envPath;
  if (p) {
    return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const ragRoot = path.resolve(__dirname, '..', '..');
  return path.join(ragRoot, '.env');
}

function loadEnvFile(absPath) {
  if (!fs.existsSync(absPath)) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      process.stderr.write(`[rag][env] missing .env file: ${absPath}\n`);
    }
    return;
  }
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    const parsed = dotenv.parse(raw);
    lastEnvMap = parsed && typeof parsed === 'object' ? parsed : {};
    setEnvSource(lastEnvMap);
  } catch {
    lastEnvMap = {};
    setEnvSource(lastEnvMap);
  }
}

export function initDotenv({ envPath, watch, debounceMs = 200 } = {}) {
  const absPath = resolveEnvPath(envPath);

  if (!initialized) {
    loadEnvFile(absPath);
    initialized = true;
  }

  const watchFromEnv = lastEnvMap && (
    lastEnvMap.RAG_ENV_WATCH ??
    lastEnvMap.rag_ENV_WATCH ??
    lastEnvMap.ENV_WATCH ??
    lastEnvMap.env_watch
  );
  const shouldWatch = watch ?? (watchFromEnv == null ? true : boolFromEnv(watchFromEnv));

  if (!shouldWatch) return;
  if (watcher) return;
  if (!fs.existsSync(absPath)) return;

  let timer = null;

  try {
    watcher = fs.watch(absPath, { persistent: false }, () => {
      const now = Date.now();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (now - lastReloadAt < debounceMs) return;
        lastReloadAt = now;
        loadEnvFile(absPath);
        process.stderr.write(`[env] reloaded from ${absPath}\n`);
      }, debounceMs);
    });
  } catch {
    watcher = null;
  }
}
