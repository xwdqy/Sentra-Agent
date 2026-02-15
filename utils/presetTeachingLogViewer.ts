import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { getEnv } from './envHotReloader.js';

const logger = createLogger('PresetTeachingLog');

type TeachingLogEntry = {
  userId?: string | number | undefined;
  groupId?: string | number | undefined;
  time?: string | undefined;
  [key: string]: unknown;
};

type TeachingLogReadOptions = {
  userId?: string | number;
  groupId?: string | number;
  limit?: number;
};

function getLogFilePath(): string {
  const raw = getEnv('AGENT_PRESET_TEACHING_LOG_FILE', './logs/preset-teaching.log');
  if (typeof raw === 'string' && raw.trim()) return raw;
  return './logs/preset-teaching.log';
}

function ensureDirForFile(filePath: string) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {
    logger.warn('PresetTeachingLog: 创建日志目录失败', { err: String(e) });
  }
}

/**
 * 追加一条教导日志到本地 JSONL 文件
 * 每行是一条独立的 JSON 对象，方便后续 grep / 分析
 */
export function appendTeachingLog(entry: TeachingLogEntry): void {
  if (!entry || typeof entry !== 'object') return;
  const file = getLogFilePath();

  try {
    ensureDirForFile(file);
    const payload = { ...entry };
    if (!payload.time) {
      payload.time = new Date().toISOString();
    }
    const line = JSON.stringify(payload);
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (e) {
    logger.warn('PresetTeachingLog: 写入日志失败', { err: String(e) });
  }
}

/**
 * 读取最近的教导日志，支持按 userId / groupId 过滤
 * 返回结果按时间倒序（最新在前）
 */
export function readTeachingLogs(options: TeachingLogReadOptions = {}): TeachingLogEntry[] {
  const { userId, groupId } = options;
  const limit = Number.isFinite(options.limit) && Number(options.limit) > 0 ? Number(options.limit) : 50;
  const file = getLogFilePath();

  if (!fs.existsSync(file)) {
    return [];
  }

  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    const out: TeachingLogEntry[] = [];

    for (let i = lines.length - 1; i >= 0; i--) {
      if (out.length >= limit) break;
      const line = lines[i];
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as TeachingLogEntry;
        if (userId != null && String(obj.userId ?? '') !== String(userId)) continue;
        if (groupId != null && String(obj.groupId ?? '') !== String(groupId)) continue;
        out.push(obj);
      } catch {
        continue;
      }
    }

    return out;
  } catch (e) {
    logger.warn('PresetTeachingLog: 读取日志失败', { err: String(e) });
    return [];
  }
}
