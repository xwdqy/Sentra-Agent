/**
 * Sentra Agent 统一日志模块
 * 使用 chalk 提供彩色输出，结构化日志格式
 */

import chalk from 'chalk';

type LoggerOptions = {
  moduleName?: string;
  enableTimestamp?: boolean;
};

type JsonLogEntry = {
  time: string;
  level: string;
  module: string;
  message: string;
  errorMessage?: string;
  errorName?: string;
  errorStack?: string;
  [key: string]: unknown;
};

function getEnv(name: string, defaultValue?: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return defaultValue;
  return v;
}

/**
 * 日志级别定义
 */
const LogLevel: Record<'DEBUG' | 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR', number> = {
  DEBUG: 0,
  INFO: 1,
  SUCCESS: 2,
  WARN: 3,
  ERROR: 4
};

/**
 * 格式化时间戳
 */
function getTimestamp() {
  const now = new Date();
  return now.toLocaleTimeString('zh-CN', { 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * Logger 类
 */
class Logger {
  moduleName: string;
  enableTimestamp: boolean;

  constructor(options: LoggerOptions = {}) {
    this.moduleName = options.moduleName || 'App';
    this.enableTimestamp = options.enableTimestamp !== false;
  }

  _getMinLevel(): number {
    const levelName = String(getEnv('LOG_LEVEL', '') || '').toUpperCase();
    const levelKey = levelName as keyof typeof LogLevel;
    return LogLevel[levelKey] ?? LogLevel.INFO;
  }

  _getFormat(): 'json' | 'pretty' {
    const formatName = String(getEnv('LOG_FORMAT', 'pretty') || 'pretty').toLowerCase();
    return formatName === 'json' ? 'json' : 'pretty';
  }

  /**
   * 格式化模块名标签
   */
  _formatModule(): string {
    return chalk.gray(`[${this.moduleName}]`);
  }

  /**
   * 格式化时间戳
   */
  _formatTimestamp(): string {
    return this.enableTimestamp ? chalk.gray(getTimestamp()) : '';
  }

  _stringifyValue(value: unknown): string {
    if (value === null || value === undefined) return String(value);
    if (value instanceof Error) return value.message || String(value);
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  _formatMetaPretty(args: unknown[]): string {
    if (!args || args.length === 0) return '';

    const plainObjects: Array<Record<string, unknown>> = [];
    const others: unknown[] = [];
    for (const a of args) {
      if (a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof Error)) {
        plainObjects.push(a as Record<string, unknown>);
      } else if (a !== undefined && a !== null) {
        others.push(a);
      }
    }

    const parts: string[] = [];

    if (plainObjects.length) {
      const merged = Object.assign({}, ...plainObjects);
      const entries = Object.entries(merged);
      if (entries.length) {
        parts.push(
          entries
            .map(([key, value]) => `${chalk.gray(key)}=${chalk.white(this._stringifyValue(value))}`)
            .join(' ')
        );
      }
    }

    for (const a of others) {
      if (a instanceof Error) {
        parts.push(chalk.red(a.message || String(a)));
      } else if (typeof a === 'string') {
        parts.push(a);
      } else {
        parts.push(this._stringifyValue(a));
      }
    }

    return parts.length ? parts.join(' ') : '';
  }

  _buildJsonEntry(levelName: string, message: unknown, args: unknown[] = [], errorObj?: Error): JsonLogEntry {
    const entry: JsonLogEntry = {
      time: new Date().toISOString(),
      level: levelName,
      module: this.moduleName,
      message: String(message),
    };

    if (Array.isArray(args)) {
      for (const a of args) {
        if (a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof Error)) {
          Object.assign(entry, a);
        }
      }
    }

    if (errorObj instanceof Error) {
      entry.errorMessage = errorObj.message;
      entry.errorName = errorObj.name;
      if (errorObj.stack) {
        entry.errorStack = errorObj.stack;
      }
    }

    return entry;
  }

  /**
   * 调试日志（青色，更清晰）
   */
  debug(message: string, ...args: unknown[]): void {
    const minLevel = this._getMinLevel();
    const format = this._getFormat();
    if (minLevel > LogLevel.DEBUG) return;
    if (format === 'json') {
      const entry = this._buildJsonEntry('DEBUG', message, args);
      console.log(JSON.stringify(entry));
      return;
    }
    const prefix = `${this._formatTimestamp()} ${chalk.cyan('[DEBUG]')} ${this._formatModule()}`;
    const meta = this._formatMetaPretty(args);
    const text = meta ? `${message} ${meta}` : message;
    console.log(prefix, chalk.white(text));
  }

  /**
   * 信息日志（蓝色）
   */
  info(message: string, ...args: unknown[]): void {
    const minLevel = this._getMinLevel();
    const format = this._getFormat();
    if (minLevel > LogLevel.INFO) return;
    if (format === 'json') {
      const entry = this._buildJsonEntry('INFO', message, args);
      console.log(JSON.stringify(entry));
      return;
    }
    const prefix = `${this._formatTimestamp()} ${chalk.blue('[INFO]')} ${this._formatModule()}`;
    const meta = this._formatMetaPretty(args);
    const text = meta ? `${message} ${meta}` : message;
    console.log(prefix, chalk.blue(text));
  }

  /**
   * 成功日志（绿色）
   */
  success(message: string, ...args: unknown[]): void {
    const minLevel = this._getMinLevel();
    const format = this._getFormat();
    if (minLevel > LogLevel.SUCCESS) return;
    if (format === 'json') {
      const entry = this._buildJsonEntry('SUCCESS', message, args);
      console.log(JSON.stringify(entry));
      return;
    }
    const prefix = `${this._formatTimestamp()} ${chalk.green('[OK]')} ${this._formatModule()}`;
    const meta = this._formatMetaPretty(args);
    const text = meta ? `${message} ${meta}` : message;
    console.log(prefix, chalk.green(text));
  }

  /**
   * 警告日志（黄色）
   */
  warn(message: string, ...args: unknown[]): void {
    const minLevel = this._getMinLevel();
    const format = this._getFormat();
    if (minLevel > LogLevel.WARN) return;
    if (format === 'json') {
      const entry = this._buildJsonEntry('WARN', message, args);
      console.warn(JSON.stringify(entry));
      return;
    }
    const prefix = `${this._formatTimestamp()} ${chalk.yellow('[WARN]')} ${this._formatModule()}`;
    const meta = this._formatMetaPretty(args);
    const text = meta ? `${message} ${meta}` : message;
    console.warn(prefix, chalk.yellow(text));
  }

  /**
   * 错误日志（红色）
   */
  error(message: string, error: unknown = null, ...args: unknown[]): void {
    const minLevel = this._getMinLevel();
    const format = this._getFormat();
    if (minLevel > LogLevel.ERROR) return;
    const errObj = error instanceof Error ? error : null;
    if (format === 'json') {
      const entry = this._buildJsonEntry('ERROR', message, [error, ...args], errObj ?? undefined);
      console.error(JSON.stringify(entry));
      return;
    }
    const prefix = `${this._formatTimestamp()} ${chalk.red('[ERROR]')} ${this._formatModule()}`;
    const meta = this._formatMetaPretty([error, ...args]);
    const text = meta ? `${message} ${meta}` : message;
    console.error(prefix, chalk.red(text));
    if (errObj && errObj.stack) {
      console.error(chalk.red(errObj.stack));
    }
  }

  /**
   * 配置信息日志（专用于启动配置输出）
   */
  config(title: string, configs: Record<string, unknown>): void {
    const minLevel = this._getMinLevel();
    if (minLevel > LogLevel.INFO) return;
    console.log(`${this._formatTimestamp()} ${chalk.cyan('[CONFIG]')} ${this._formatModule()} ${chalk.cyan.bold(title)}`);
    Object.entries(configs).forEach(([key, value]) => {
      const formattedKey = chalk.cyan(`  ${key}:`);
      const formattedValue = typeof value === 'number' 
        ? chalk.white(value) 
        : chalk.white(String(value));
      console.log(`${formattedKey} ${formattedValue}`);
    });
  }

  /**
   * 性能日志（专用于性能指标）
   */
  perf(operation: string, duration: number): void {
    const minLevel = this._getMinLevel();
    if (minLevel > LogLevel.DEBUG) return;
    const durationStr = duration < 1000 
      ? `${duration}ms` 
      : `${(duration / 1000).toFixed(2)}s`;
    const prefix = `${this._formatTimestamp()} ${chalk.magenta('[PERF]')} ${this._formatModule()}`;
    console.log(prefix, chalk.magenta(`${operation}:`), chalk.white(durationStr));
  }

  /**
   * 数据日志（专用于结构化数据输出）
   */
  data(label: string, data: unknown): void {
    const minLevel = this._getMinLevel();
    if (minLevel > LogLevel.DEBUG) return;
    const prefix = `${this._formatTimestamp()} ${chalk.gray('[DATA]')} ${this._formatModule()}`;
    console.log(prefix, chalk.white(label));
    console.dir(data, { depth: 3, colors: true });
  }

  /**
   * 分隔线
   */
  divider(char: string = '─', length: number = 60): void {
    const minLevel = this._getMinLevel();
    if (minLevel > LogLevel.INFO) return;
    console.log(chalk.gray(char.repeat(length)));
  }

  /**
   * 标题日志（用于模块启动标题）
   */
  title(text: string): void {
    const minLevel = this._getMinLevel();
    if (minLevel > LogLevel.INFO) return;
    const border = '='.repeat(text.length + 4);
    console.log(chalk.cyan.bold(border));
    console.log(chalk.cyan.bold(`  ${text}  `));
    console.log(chalk.cyan.bold(border));
  }

  /**
   * 表格日志（用于展示键值对）
   */
  table(data: Record<string, unknown> | Array<[string, unknown]>): void {
    const minLevel = this._getMinLevel();
    if (minLevel > LogLevel.INFO) return;
    const entries = Array.isArray(data) ? data : Object.entries(data);
    const maxKeyLength = Math.max(...entries.map(([k]) => String(k).length));
    
    entries.forEach(([key, value]) => {
      const paddedKey = String(key).padEnd(maxKeyLength);
      console.log(`  ${chalk.gray(paddedKey)} ${chalk.white(':')} ${chalk.white(value)}`);
    });
  }
}

/**
 * 创建 Logger 实例的工厂函数
 */
export function createLogger(moduleName: string, options: LoggerOptions = {}): Logger {
  return new Logger({ ...options, moduleName });
}

/**
 * 默认全局 Logger
 */
export const logger = new Logger({ moduleName: 'Sentra' });

export default logger;
