import fs from 'fs';

type LoggerLike = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

type RefreshWatcherOptions = {
  name: string;
  dir: string;
  logger: LoggerLike;
  debounceMs?: number;
  getTargets: () => string[];
  onRefresh: () => Promise<void>;
  onRefreshFailedMessage?: string;
};

function normalizeWatchPath(input: unknown): string {
  return String(input || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function getPathBaseName(input: string): string {
  const normalized = normalizeWatchPath(input);
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return '';
  return parts[parts.length - 1] || '';
}

function matchesTargets(filename: string, targets: string[]): boolean {
  const changed = normalizeWatchPath(filename);
  if (!changed) return true;
  const changedBase = getPathBaseName(changed);
  const normalizedTargets = Array.from(
    new Set((targets || []).map((x) => normalizeWatchPath(x)).filter(Boolean))
  );

  for (const target of normalizedTargets) {
    if (changed === target) return true;
    if (changedBase && changedBase === getPathBaseName(target)) return true;
    if (target.includes('/') && !changed.includes('/') && target.startsWith(`${changed}/`)) return true;
    if (!target.includes('/') && changed.endsWith(`/${target}`)) return true;
  }
  return false;
}

export function startRefreshWatcher(options: RefreshWatcherOptions): fs.FSWatcher | null {
  const debounceMs = Math.max(80, Number(options.debounceMs || 350));
  const refreshFailedMessage = options.onRefreshFailedMessage || `${options.name}: 刷新失败`;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerun = false;
  let pendingEventCount = 0;
  const pendingFiles = new Set<string>();
  let lastSignalKey = '';
  let lastSignalTs = 0;

  const executeRefresh = async () => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    const files = Array.from(pendingFiles);
    const eventCount = pendingEventCount;
    pendingFiles.clear();
    pendingEventCount = 0;
    try {
      options.logger.info(`${options.name}: 检测到目录变更（合并后执行刷新）`, {
        eventCount,
        files: files.slice(0, 8).join(', ')
      });
      await options.onRefresh();
    } catch (e) {
      options.logger.warn(refreshFailedMessage, { err: String(e) });
    } finally {
      running = false;
      if (rerun || pendingEventCount > 0) {
        rerun = false;
        setTimeout(() => {
          executeRefresh().catch((err) => {
            options.logger.warn(refreshFailedMessage, { err: String(err) });
          });
        }, 0);
      }
    }
  };

  const scheduleRefresh = (eventTypeRaw: unknown, filenameRaw: unknown) => {
    const eventType = String(eventTypeRaw || '').trim().toLowerCase() || 'change';
    const filename = normalizeWatchPath(filenameRaw);
    const signalKey = `${eventType}|${filename}`;
    const now = Date.now();

    // fs.watch 会在单次写入里重复触发同信号，这里做轻量抑制。
    if (signalKey === lastSignalKey && now - lastSignalTs <= 180) return;
    lastSignalKey = signalKey;
    lastSignalTs = now;

    const targets = options.getTargets();
    if (!matchesTargets(filename, targets)) return;

    pendingEventCount += 1;
    pendingFiles.add(filename || '(unknown)');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      executeRefresh().catch((err) => {
        options.logger.warn(refreshFailedMessage, { err: String(err) });
      });
    }, debounceMs);
  };

  try {
    if (!fs.existsSync(options.dir)) {
      options.logger.warn(`${options.name}: 目录不存在，跳过监听`, { path: options.dir });
      return null;
    }

    const watcher = fs.watch(options.dir, { persistent: false }, (eventType, filename) => {
      scheduleRefresh(eventType, filename || '');
    });
    watcher.on('error', (err) => {
      options.logger.warn(`${options.name}: 监听错误`, { err: String(err) });
    });
    options.logger.info(`${options.name}: 已启动目录监听`, { path: options.dir, debounceMs });
    return watcher;
  } catch (e) {
    options.logger.warn(`${options.name}: 启动监听失败`, { err: String(e) });
    return null;
  }
}

