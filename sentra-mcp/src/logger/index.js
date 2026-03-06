import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import chalk from 'chalk';
import { config } from '../config/index.js';
import { truncateTextByTokens } from '../utils/tokenizer.js';

const logDir = path.resolve(process.cwd(), config.logging.dir);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function colorForLevel(level) {
  const lvl = String(level).toLowerCase();
  switch (lvl) {
    case 'error': return chalk.white.bold.bgRed(' ERROR ');
    case 'warn': return chalk.black.bold.bgYellow(' WARN ');
    case 'info': return chalk.black.bold.bgCyan(' INFO ');
    case 'debug': return chalk.white.bold.bgMagenta(' DEBUG ');
    case 'verbose': return chalk.white.bold.bgBlue(' VERBOSE ');
    default: return chalk.white.bold.bgGray(` ${lvl.toUpperCase()} `);
  }
}

function safeStringify(obj, space = 0) {
  try { return JSON.stringify(obj, null, space); } catch { return String(obj); }
}

function valueToLogText(value, space = 0) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeStringify(value, space);
}

function formatTimestamp(tsRaw) {
  const d = new Date(tsRaw);
  if (!config.logging?.timestampLocal) return chalk.gray(d.toISOString());
  const pad = (n, s = 2) => String(n).padStart(s, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return chalk.gray(local);
}

function formatMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const { label, ...rest } = meta;
  const space = 0;
  const lines = [];
  const normalized = { ...rest };

  if (Array.isArray(normalized.responses)) {
    const responses = normalized.responses;
    lines.push(`responses_count: ${responses.length}`);
    for (let i = 0; i < responses.length; i++) {
      const row = responses[i] && typeof responses[i] === 'object' ? responses[i] : {};
      const prefix = `responses[${i}]`;
      const index = Number.isFinite(Number(row.index)) ? Number(row.index) : (i + 1);
      lines.push(`${prefix}.index: ${index}`);
      lines.push(`${prefix}.phase: ${String(row.phase || '')}`);
      lines.push(`${prefix}.content: ${valueToLogText(row.content, space)}`);
      if (row.meta !== undefined) lines.push(`${prefix}.meta: ${valueToLogText(row.meta, space)}`);
      if (row.ts !== undefined) lines.push(`${prefix}.ts: ${valueToLogText(row.ts, space)}`);
      if (row.delivered !== undefined) lines.push(`${prefix}.delivered: ${valueToLogText(row.delivered, space)}`);
      if (row.noReply !== undefined) lines.push(`${prefix}.noReply: ${valueToLogText(row.noReply, space)}`);
    }
    delete normalized.responses;
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${valueToLogText(value, space)}`);
  }
  const raw = lines.join('\n');
  const colored = config.logging?.colorMeta ? chalk.cyan(raw) : raw;
  return config.logging?.dimMeta ? chalk.dim(colored) : colored;
}

function renderPrettyBlock({ label, message, rest }) {
  const keys = Object.keys(rest || {});
  if (!keys.length) return '';
  const maxTokens = 256;
  const lines = [];
  for (const k of keys) {
    const v = rest[k];
    let s;
    if (v === null || v === undefined) s = String(v);
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else s = typeof v === 'string' ? v : safeStringify(v, 2);
    if (typeof s === 'string' && s) {
      const clipped = truncateTextByTokens(s, { maxTokens, suffix: ' ..(+truncated)' });
      s = clipped.text;
    }
    const ks = chalk.cyan(k);
    const vs = config.logging?.colorMeta ? chalk.white(s) : s;
    lines.push(`| ${ks}: ${vs}`);
  }
  const top = chalk.gray('+--------------------------------------------');
  const bottom = chalk.gray('+--------------------------------------------');
  return `${top}\n${lines.join('\n')}\n${bottom}`;
}

const consoleFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  const ts = formatTimestamp(timestamp);
  const lvl = colorForLevel(level);
  const rawLabel = meta.label ? String(meta.label) : '';
  const label = rawLabel ? chalk.white.bold.inverse(` ${rawLabel} `) : '';
  let msg;
  try { msg = typeof message === 'string' ? message : JSON.stringify(message); } catch { msg = String(message); }
  const { label: _omit, ...rest } = meta || {};
  if (rawLabel && Array.isArray(config.logging?.prettyLabels) && config.logging.prettyLabels.includes(rawLabel)) {
    const panel = renderPrettyBlock({ label: rawLabel, message: msg, rest });
    return `${ts} ${lvl}${label} ${msg}${panel ? '\n' + panel : ''}`;
  }
  const metaStr = formatMeta(meta);
  return `${ts} ${lvl}${label} ${msg}${metaStr ? '\n' + metaStr : ''}`;
});

export const logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true })
  ),
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({ filename: path.join(logDir, 'app.log'), format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()) })
  ]
});

export default logger;
