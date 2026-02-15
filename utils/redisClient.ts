import { Redis } from 'ioredis';
import type { Redis as RedisClient, RedisOptions } from 'ioredis';
import { createLogger } from './logger.js';
import { getEnv, getEnvInt } from './envHotReloader.js';

const logger = createLogger('RedisClient');

let redisInstance: RedisClient | null = null;

type RedisConfig = {
  host: string;
  port: number;
  db: number;
  password?: string;
};

function getRedisConfig(): RedisConfig | null {
  const host = String(getEnv('REDIS_HOST', '127.0.0.1') || '127.0.0.1');
  const portRaw = getEnvInt('REDIS_PORT', 6379);
  const dbRaw = getEnvInt('REDIS_DB', 0);
  const port = Number.isFinite(portRaw) ? Number(portRaw) : 6379;
  const db = Number.isFinite(dbRaw) ? Number(dbRaw) : 0;
  const password = getEnv('REDIS_PASSWORD', undefined) || undefined;
  const enabled = getEnv('REDIS_ENABLED', undefined);

  // 显式关闭：REDIS_ENABLED=false
  if (enabled === 'false') {
    return null;
  }

  const cfg: RedisConfig = { host, port, db };
  if (password) {
    cfg.password = password;
  }
  return cfg;
}

export function getRedis(): RedisClient | null {
  const cfg = getRedisConfig();
  if (!cfg) {
    return null;
  }

  if (!redisInstance) {
    const options: RedisOptions = {
      host: cfg.host,
      port: cfg.port,
      db: cfg.db,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    };
    if (cfg.password) {
      options.password = cfg.password;
    }
    redisInstance = new Redis(options);

    redisInstance.on('error', (err: unknown) => {
      logger.error('Redis error', { label: 'REDIS', err: String(err) });
    });

    redisInstance.on('connect', () => {
      logger.info('Redis connected', {
        label: 'REDIS',
        host: cfg.host,
        port: cfg.port,
        db: cfg.db,
      });
    });

    logger.info('Redis connecting', {
      label: 'REDIS',
      host: cfg.host,
      port: cfg.port,
      db: cfg.db,
    });

    redisInstance.connect().catch((e: unknown) => {
      logger.error('Redis connect failed', { label: 'REDIS', e: String(e) });
    });
  }

  return redisInstance;
}

export function isRedisReady(): boolean {
  try {
    const r = getRedis();
    return !!r && r.status === 'ready';
  } catch {
    return false;
  }
}

export function getRedisSafe(): RedisClient | null {
  try {
    const r = getRedis();
    if (!r || !isRedisReady()) return null;
    return r;
  } catch {
    return null;
  }
}
