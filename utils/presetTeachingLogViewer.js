import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('PresetTeachingLog');

const DEFAULT_LOG_FILE = process.env.AGENT_PRESET_TEACHING_LOG_FILE || './logs/preset-teaching.log';

function ensureDirForFile(filePath) {
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
export function appendTeachingLog(entry) {
  if (!entry || typeof entry !== 'object') return;
  const file = DEFAULT_LOG_FILE;

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
export function readTeachingLogs(options = {}) {
  const { userId, groupId, limit = 50 } = options;
  const file = DEFAULT_LOG_FILE;

  if (!fs.existsSync(file)) {
    return [];
  }

  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(l => l.trim());
    const out = [];

    for (let i = lines.length - 1; i >= 0; i--) {
      if (out.length >= limit) break;
      const line = lines[i];
      try {
        const obj = JSON.parse(line);
        if (userId && String(obj.userId) !== String(userId)) continue;
        if (groupId && String(obj.groupId) !== String(groupId)) continue;
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
