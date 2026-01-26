import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

import { createLogger } from './logger.js';

const logger = createLogger('EnvHotReload');

let watcherStarted = false;
let currentWatcher = null;
let currentWatchedPath = null;
let pendingReloadTimer = null;
const lastFileVarsByPath = new Map();
const reloadListeners = new Set();

function safeReadFileText(fullPath) {
  try {
    return fs.readFileSync(fullPath, 'utf8');
  } catch (e) {
    logger.warn('读取 .env 文件失败', { path: fullPath, err: String(e) });
    return null;
  }
}

function parseEnvFileToMap(fullPath) {
  const raw = safeReadFileText(fullPath);
  if (raw == null) return null;
  try {
    const obj = dotenv.parse(raw);
    const m = new Map();
    for (const [k, v] of Object.entries(obj || {})) {
      if (!k) continue;
      m.set(String(k), v == null ? '' : String(v));
    }
    return m;
  } catch (e) {
    logger.warn('解析 .env 文件失败', { path: fullPath, err: String(e) });
    return null;
  }
}

function diffEnvMaps(prevMap, nextMap) {
  const added = [];
  const updated = [];
  const removed = [];

  const prevKeys = new Set(prevMap ? Array.from(prevMap.keys()) : []);
  const nextKeys = new Set(nextMap ? Array.from(nextMap.keys()) : []);

  for (const k of nextKeys) {
    if (!prevKeys.has(k)) {
      added.push(k);
      continue;
    }
    const pv = prevMap.get(k);
    const nv = nextMap.get(k);
    if (pv !== nv) updated.push(k);
  }

  for (const k of prevKeys) {
    if (!nextKeys.has(k)) removed.push(k);
  }

  return { added, updated, removed };
}

function applyEnvMap(prevMap, nextMap) {
  const prev = prevMap || new Map();
  const next = nextMap || new Map();

  for (const [k, v] of next.entries()) {
    process.env[k] = v;
  }

  for (const [k, prevValue] of prev.entries()) {
    if (next.has(k)) continue;
    if (process.env[k] === prevValue) {
      delete process.env[k];
    }
  }
}

function scheduleReload(fullPath, reason) {
  if (pendingReloadTimer) {
    clearTimeout(pendingReloadTimer);
  }
  pendingReloadTimer = setTimeout(() => {
    pendingReloadTimer = null;
    try {
      loadEnv(fullPath);
    } catch (e) {
      logger.warn('热重载执行异常', { path: fullPath, err: String(e), reason });
    }
  }, 120);
}

function notifyReload(payload) {
  for (const fn of reloadListeners) {
    try {
      fn(payload);
    } catch (e) {
      logger.warn('EnvHotReload listener 异常（已忽略）', { err: String(e) });
    }
  }
}

export function loadEnv(envPath = '.env') {
  try {
    const fullPath = path.resolve(envPath);
    if (!fs.existsSync(fullPath)) {
      logger.debug(`.env 文件不存在，跳过加载: ${fullPath}`);
      return;
    }
    const nextVars = parseEnvFileToMap(fullPath);
    if (!nextVars) {
      return;
    }

    const prevVars = lastFileVarsByPath.get(fullPath) || new Map();
    const diff = diffEnvMaps(prevVars, nextVars);

    applyEnvMap(prevVars, nextVars);
    lastFileVarsByPath.set(fullPath, nextVars);

    logger.info('已从文件加载/刷新环境变量', {
      path: fullPath,
      added: diff.added.length,
      updated: diff.updated.length,
      removed: diff.removed.length
    });

    if (diff.added.length || diff.updated.length || diff.removed.length) {
      logger.debug('环境变量变更明细', {
        added: diff.added,
        updated: diff.updated,
        removed: diff.removed
      });
    }

    notifyReload({ path: fullPath, ...diff });
  } catch (e) {
    logger.warn('读取 .env 文件异常', { err: String(e) });
  }
}

export function initEnvWatcher(envPath = '.env') {
  if (watcherStarted) return;
  watcherStarted = true;

  try {
    const fullPath = path.resolve(envPath);
    if (!fs.existsSync(fullPath)) {
      logger.debug(`.env 文件不存在，暂不监听: ${fullPath}`);
      return;
    }

    currentWatchedPath = fullPath;

    const startWatch = () => {
      if (currentWatcher) {
        try { currentWatcher.close(); } catch {}
        currentWatcher = null;
      }

      currentWatcher = fs.watch(fullPath, { persistent: true }, (eventType) => {
        if (eventType !== 'change' && eventType !== 'rename') return;
        logger.info(`检测到 .env 变更，准备重新加载: ${fullPath}`);
        scheduleReload(fullPath, eventType);

        if (eventType === 'rename') {
          setTimeout(() => {
            try {
              if (!fs.existsSync(fullPath)) {
                logger.warn('检测到 .env rename 且文件暂不可用，将重试监听', { path: fullPath });
                return;
              }
              startWatch();
            } catch (e) {
              logger.warn('rename 后重绑 watcher 失败', { path: fullPath, err: String(e) });
            }
          }, 200);
        }
      });
    };

    startWatch();

    logger.info('已启动 .env 文件监听', { path: fullPath });
  } catch (e) {
    logger.warn('启动 .env 监听失败', { err: String(e) });
  }
}

export function onEnvReload(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  reloadListeners.add(listener);
  return () => {
    reloadListeners.delete(listener);
  };
}

export function getEnv(name, defaultValue) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return defaultValue;
  return v;
}

export function getEnvInt(name, defaultValue) {
  const v = getEnv(name, undefined);
  if (v === undefined) return defaultValue;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

export function getEnvTimeoutMs(name, defaultValue = 180000, maxMs = 900000) {
  const raw = getEnvInt(name, defaultValue);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return defaultValue;
  const cap = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 900000;
  return Math.min(n, cap);
}

export function getEnvBool(name, defaultValue) {
  const v = getEnv(name, undefined);
  if (v === undefined) return defaultValue;
  const lower = String(v).toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
  return defaultValue;
}
