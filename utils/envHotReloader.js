import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createLogger } from './logger.js';

const logger = createLogger('EnvHotReload');

let watcherStarted = false;

export function loadEnv(envPath = '.env') {
  try {
    const fullPath = path.resolve(envPath);
    if (!fs.existsSync(fullPath)) {
      logger.debug(`EnvHotReload: .env 文件不存在，跳过加载: ${fullPath}`);
      return;
    }
    const result = dotenv.config({ path: fullPath, override: true });
    if (result.error) {
      logger.warn('EnvHotReload: 加载环境变量失败', { err: String(result.error) });
      return;
    }
    logger.info('EnvHotReload: 已从文件加载/刷新环境变量', { path: fullPath });
  } catch (e) {
    logger.warn('EnvHotReload: 读取 .env 文件异常', { err: String(e) });
  }
}

export function initEnvWatcher(envPath = '.env') {
  if (watcherStarted) return;
  watcherStarted = true;

  try {
    const fullPath = path.resolve(envPath);
    if (!fs.existsSync(fullPath)) {
      logger.debug(`EnvHotReload: .env 文件不存在，暂不监听: ${fullPath}`);
      return;
    }

    fs.watch(fullPath, { persistent: false }, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        logger.info(`EnvHotReload: 检测到 .env 变更，重新加载: ${fullPath}`);
        loadEnv(fullPath);
      }
    });

    logger.info('EnvHotReload: 已启动 .env 文件监听', { path: fullPath });
  } catch (e) {
    logger.warn('EnvHotReload: 启动 .env 监听失败', { err: String(e) });
  }
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

export function getEnvBool(name, defaultValue) {
  const v = getEnv(name, undefined);
  if (v === undefined) return defaultValue;
  const lower = String(v).toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
  return defaultValue;
}
