import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

let initialized = false;
let watcher = null;
let lastReloadAt = 0;
let warnedMissingEnv = false;

function boolFromEnv(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}

function resolveEnvPath(envPath) {
  // 默认只加载 sentra-rag 包自身目录下的 .env，避免依赖主工程 cwd 的 .env。
  // 如需自定义路径，可显式传入 envPath。
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
  // override=true: 当 .env 文件变更时，允许覆盖 process.env 已存在的键
  dotenv.config({ path: absPath, override: true });
}

/**
 * 初始化 dotenv，并可选监听 .env 变更实现“热更新”。
 *
 * 注意：热更新主要用于“长运行进程”（例如 HTTP 服务/守护进程）。
 * 对于一次性 CLI（跑完就退出）意义不大。
 */
export function initDotenv({ envPath, watch, debounceMs = 200 } = {}) {
  const absPath = resolveEnvPath(envPath);

  if (!initialized) {
    loadEnvFile(absPath);
    initialized = true;
  }

  const watchFromEnv =
    process.env.RAG_ENV_WATCH ?? process.env.rag_ENV_WATCH ?? process.env.ENV_WATCH ?? process.env.env_watch;
  const shouldWatch = watch ?? (watchFromEnv == null ? true : boolFromEnv(watchFromEnv));

  if (!shouldWatch) return;
  if (watcher) return;

  if (!fs.existsSync(absPath)) return;

  let timer = null;

  try {
    watcher = fs.watch(absPath, { persistent: false }, () => {
      const now = Date.now();
      // 去抖：避免编辑器保存触发多次事件
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // 简单节流，避免极端情况下频繁 reload
        if (now - lastReloadAt < debounceMs) return;
        lastReloadAt = now;
        loadEnvFile(absPath);
        // 避免引入 logger 循环依赖，这里用 stderr 轻量提示
        process.stderr.write(`[env] reloaded from ${absPath}\n`);
      }, debounceMs);
    });
  } catch {
    // 某些运行环境/文件系统可能不支持 watch，安全降级为“只加载一次”
    watcher = null;
  }
}
