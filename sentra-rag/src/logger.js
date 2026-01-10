import chalk from 'chalk';
import { getEnv } from './config/env.js';

function now() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const currentLevelName = String(getEnv('LOG_LEVEL', { defaultValue: 'info' })).toLowerCase();
const currentLevel = LEVELS[currentLevelName] ?? LEVELS.info;

function shouldSkip(level) {
  return (LEVELS[level] ?? LEVELS.info) < currentLevel;
}

function fmt(level, msg) {
  const t = chalk.gray(now());
  const tag =
    level === 'debug'
      ? chalk.gray('DEBUG')
      : level === 'info'
        ? chalk.cyan('INFO')
        : level === 'warn'
          ? chalk.yellow('WARN')
          : chalk.red('ERROR');
  return `${t} ${tag} ${msg}`;
}

function write(level, msg, data) {
  if (shouldSkip(level)) return;
  const line = fmt(level, msg);
  if (data === undefined) {
    process.stderr.write(line + '\n');
    return;
  }
  const extra = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  process.stderr.write(line + '\n' + chalk.gray(extra) + '\n');
}

export const logger = {
  debug(msg, data) {
    write('debug', msg, data);
  },
  info(msg, data) {
    write('info', msg, data);
  },
  warn(msg, data) {
    write('warn', msg, data);
  },
  error(msg, data) {
    write('error', msg, data);
  },
  success(msg, data) {
    const line = `${chalk.gray(now())} ${chalk.green('OK')} ${msg}`;
    if (data === undefined) {
      process.stderr.write(line + '\n');
      return;
    }
    const extra = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    process.stderr.write(line + '\n' + chalk.gray(extra) + '\n');
  },
};
