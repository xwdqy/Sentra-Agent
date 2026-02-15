import logger from '../logger/index.js';
import { loadPlugins } from '../plugins/loader.js';
import MCPExternalManager from '../mcp/client/manager.js';
import { Metrics } from '../metrics/index.js';
import { executeToolWithTimeout } from '../utils/executeTool.js';
import { ok, fail } from '../utils/result.js';
import { getRedis, isRedisReady } from '../redis/client.js';
import { config } from '../config/index.js';
import { Governance } from '../governance/policy.js';
import { embedTexts } from '../openai/client.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

function makeAINameLocal(name) {
  return `local__${name}`;
}
function makeAINameExternal(serverId, name) {
  try {
    const strategy = String(config?.llm?.toolStrategy || 'auto').toLowerCase();
    if (strategy === 'fc') {
      return `ext__${String(serverId ?? '')}__${String(name ?? '')}`;
    }
  } catch { }

  const sanitize = (s) => String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const sid = sanitize(serverId);
  const raw = String(name ?? '');
  const n0 = sanitize(raw);
  const prefix = `ext__${sid}__`;
  let base = `${prefix}${n0}`;

  const changed = n0 !== raw;
  const tooLong = base.length > 64;
  if (!changed && !tooLong) return base;

  const h = crypto.createHash('sha1').update(`${serverId}::${raw}`).digest('hex').slice(0, 10);
  const suffix = `_${h}`;
  const maxNameLen = Math.max(1, 64 - prefix.length - suffix.length);
  const clipped = n0.slice(0, maxNameLen);
  base = `${prefix}${clipped}${suffix}`;
  return base;
}

// Local fallback for cooldown when Redis is unavailable
const __localCooldown = new Map(); // aiName -> epochMs
function __setLocalCooldown(aiName, ms) {
  if (!ms) return;
  const until = Date.now() + Math.max(1, ms);
  __localCooldown.set(aiName, until);
}
function __getLocalRemainMs(aiName) {
  const until = __localCooldown.get(aiName) || 0;
  const remain = until - Date.now();
  return remain > 0 ? remain : 0;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }

function __truncateText(s, maxChars) {
  const max = Number(maxChars);
  const m = Number.isFinite(max) && max > 0 ? Math.floor(max) : 4000;
  const str = String(s ?? '');
  if (str.length <= m) return str;
  return str.slice(0, m) + `... (len=${str.length})`;
}

function __extractMcpTextFromContent(content, maxChars) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const it of content) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'text' && it.text != null) {
      parts.push(String(it.text));
    }
  }
  return __truncateText(parts.join('\n'), maxChars);
}

function cosineSim(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]; const y = b[i];
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class MCPCore {
  constructor() {
    this.localTools = [];
    this.externalMgr = new MCPExternalManager();
    this.externalTools = []; // { name, description, inputSchema, __provider: external:<id> }
    this.toolIndex = new Map(); // aiName -> descriptor
    this._initialized = false;
    this._initPromise = null;
  }

  static _looksLikeToolResult(v) {
    return !!(v && typeof v === 'object' && typeof v.success === 'boolean');
  }

  static _unwrapNestedToolResult(out) {
    if (!out || out.success !== true) return out;
    const d = out.data;
    if (!d || typeof d !== 'object') return out;
    if (typeof d.success !== 'boolean') return out;
    if (d.success === true) return out;

    // Legacy pattern: plugin returned ok({ success:false, ... }) and MCPCore wrapped it as success:true.
    // Treat it as a real failure at the top-level.
    const code = d.code || out.code || 'ERR';
    const provider = out.provider;
    const data = 'data' in d ? d.data : null;
    const error = 'error' in d ? d.error : (d.message || d.reason || 'Tool failed');

    const rest = { ...d };
    delete rest.success;
    delete rest.code;
    delete rest.data;
    delete rest.error;

    return { success: false, code, data, error, provider, ...rest };
  }

  async init() {
    if (this._initialized) return;
    if (this._initPromise) {
      await this._initPromise;
      return;
    }
    this._initPromise = (async () => {
      // Load local plugins
      this.localTools = await loadPlugins();
      // Connect external servers and fetch their tools
      await this.externalMgr.connectAll();
      this.externalTools = await this.externalMgr.listAllTools();
      this.rebuildIndex();
      this._initialized = true;
    })();
    try {
      await this._initPromise;
    } finally {
      // keep promise only while in-flight, allow retry if init failed
      if (!this._initialized) this._initPromise = null;
    }
  }

  async reloadLocalPlugins(pluginsDir) {
    try {
      const tools = await loadPlugins(pluginsDir);
      this.localTools = tools || [];
      this.rebuildIndex();
      logger.info?.('本地插件已热重载', { label: 'MCP', total: this.localTools.length });
    } catch (e) {
      logger.error?.('本地插件热重载失败', { label: 'MCP', error: String(e) });
    }
  }

  async reloadPluginEnvs(pluginDirNames = []) {
    const dirs = Array.isArray(pluginDirNames) ? pluginDirNames.map(String).filter(Boolean) : [];
    if (!dirs.length) return;

    // Ensure initial load so localTools has plugin metadata
    await this.init();

    let needFullReload = false;
    const toRemove = new Set();

    const resolvePluginDirCandidates = (dirName) => {
      const out = [];
      try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const libRoot = path.resolve(__dirname, '..', '..');
        out.push(path.join(libRoot, 'plugins', dirName));
      } catch { }
      try {
        if (process.env.PLUGINS_DIR) out.push(path.join(path.resolve(process.env.PLUGINS_DIR), dirName));
      } catch { }
      try {
        out.push(path.join(path.resolve(process.cwd(), 'plugins'), dirName));
      } catch { }
      const seen = new Set();
      return out.map((p) => path.resolve(p)).filter((p) => {
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      });
    };

    const isSensitiveKey = (k) => /key|token|secret|password/i.test(String(k || ''));
    const safePreview = (k, v) => {
      if (isSensitiveKey(k)) return '[REDACTED]';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return String(s ?? '').slice(0, 160);
    };

    for (const dirName of dirs) {
      const matching = this.localTools.filter((t) => t && t._pluginDirName === dirName);

      const absDir = matching.length
        ? String(matching[0]?._pluginAbsDir || '')
        : '';

      const absDirCandidates = absDir ? [path.resolve(absDir)] : resolvePluginDirCandidates(dirName);

      const pickEnvFiles = (base) => {
        const envPath = path.join(base, '.env');
        const envAltPath = path.join(base, 'config.env');
        if (fs.existsSync(envPath)) return { envPath, envAltPath: null };
        if (fs.existsSync(envAltPath)) return { envPath: null, envAltPath };
        return { envPath: null, envAltPath: null };
      };

      let penv = {};
      try {
        for (const base of absDirCandidates) {
          const { envPath, envAltPath } = pickEnvFiles(base);
          if (envPath) {
            penv = { ...penv, ...dotenv.parse(fs.readFileSync(envPath)) };
            break;
          }
          if (envAltPath) {
            penv = { ...penv, ...dotenv.parse(fs.readFileSync(envAltPath)) };
            break;
          }
        }
      } catch (e) {
        logger.warn?.('Failed to parse plugin env during hot reload', { label: 'MCP', dir: dirName, error: String(e) });
        continue;
      }

      let enabled = true;
      try {
        const raw = penv.PLUGIN_ENABLED ?? penv.PLUGIN_ENABLE ?? penv.ENABLED;
        if (raw !== undefined) {
          const s = String(raw).trim().toLowerCase();
          if (s === '0' || s === 'false' || s === 'off' || s === 'no') enabled = false;
          else if (s === '1' || s === 'true' || s === 'on' || s === 'yes') enabled = true;
        }
      } catch { }

      if (!matching.length) {
        if (enabled) needFullReload = true;
        continue;
      }

      if (!enabled) {
        for (const t of matching) toRemove.add(t);
        continue;
      }

      // Update env + timeout on matching tools
      for (const t of matching) {
        const prevEnv = (() => {
          try { return t.pluginEnv && typeof t.pluginEnv === 'object' ? t.pluginEnv : {}; } catch { return {}; }
        })();

        const prevTimeoutMs = Number(t.timeoutMs) || 0;
        let timeoutMs = prevTimeoutMs;
        const fromEnvA = Number(penv.PLUGIN_TIMEOUT_MS);
        const fromEnvB = Number(penv.TOOL_TIMEOUT_MS);
        if (!Number.isNaN(fromEnvA) && fromEnvA > 0) timeoutMs = fromEnvA;
        else if (!Number.isNaN(fromEnvB) && fromEnvB > 0) timeoutMs = fromEnvB;

        try { t.pluginEnv = penv; } catch { }
        try { t.timeoutMs = timeoutMs; } catch { }

        try {
          const prevKeys = new Set(Object.keys(prevEnv || {}));
          const nextKeys = new Set(Object.keys(penv || {}));
          const allKeys = new Set([...prevKeys, ...nextKeys]);

          const changedKeys = [];
          const diffPreview = {};
          for (const k of allKeys) {
            const a = prevEnv?.[k];
            const b = penv?.[k];
            if (String(a ?? '') !== String(b ?? '')) {
              changedKeys.push(k);
              if (Object.keys(diffPreview).length < 12) {
                diffPreview[k] = [safePreview(k, a), safePreview(k, b)];
              }
            }
          }

          const timeoutChanged = prevTimeoutMs !== timeoutMs;
          if (changedKeys.length || timeoutChanged) {
            logger.info?.('插件 env 更新明细', {
              label: 'MCP',
              plugin: dirName,
              tool: t.name,
              changedKeysCount: changedKeys.length,
              changedKeysSample: changedKeys.slice(0, 20),
              diffPreview,
              timeoutMs,
              prevTimeoutMs,
            });
          }
        } catch { }
      }
    }

    if (toRemove.size) {
      this.localTools = this.localTools.filter((t) => !toRemove.has(t));
    }

    if (needFullReload) {
      await this.reloadLocalPlugins();
      return;
    }

    this.rebuildIndex();
    logger.info?.('插件 env 已热更新', { label: 'MCP', plugins: dirs.length });
  }

  rebuildIndex() {
    this.toolIndex.clear();
    // Local
    for (const t of this.localTools) {
      const aiName = makeAINameLocal(t.name);
      this.toolIndex.set(aiName, { ...t, aiName, providerType: 'local' });
    }
    // External
    for (const t of this.externalTools) {
      const p = (t.__provider || '').split(':');
      const serverId = p[1] || 'unknown';
      const aiName = makeAINameExternal(serverId, t.name);
      // Map MCP tool shape to our shape
      const inputSchema = t.inputSchema || t.input_schema || { type: 'object', properties: {} };
      this.toolIndex.set(aiName, {
        aiName,
        name: t.name,
        description: t.description || '',
        inputSchema,
        providerType: 'external',
        serverId,
      });
    }
  }

  getAvailableTools() {
    const out = [];
    for (const item of this.toolIndex.values()) {
      out.push({
        aiName: item.aiName,
        name: item.name,
        provider: item.providerType === 'local' ? 'local' : `external:${item.serverId}`,
        description: item.description || '',
        inputSchema: item.inputSchema || { type: 'object', properties: {} },
        scope: item.scope || 'global',
        tenant: item.tenant || 'default',
        cooldownMs: Number(item.cooldownMs || config.planner.cooldownDefaultMs || 0),
        meta: item.meta || {},
        skillDoc: item.skillDoc || null,
      });
    }
    return out;
  }

  buildOpenAITools() {
    return this.getAvailableTools().map((t) => ({
      type: 'function',
      function: {
        name: t.aiName,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  // Richer detail for SDK export/listing
  getAvailableToolsDetailed() {
    const out = [];
    for (const item of this.toolIndex.values()) {
      const base = {
        aiName: item.aiName,
        name: item.name,
        description: item.description || '',
        inputSchema: item.inputSchema || { type: 'object', properties: {} },
        scope: item.scope || 'global',
        tenant: item.tenant || 'default',
        cooldownMs: Number(item.cooldownMs || 0),
        timeoutMs: Number(item.timeoutMs || 0),
        providerType: item.providerType,
        meta: item.meta || {},
        skillDoc: item.skillDoc || null,
      };
      if (item.providerType === 'local') {
        out.push({ ...base, provider: 'local' });
      } else if (item.providerType === 'external') {
        out.push({ ...base, provider: `external:${item.serverId}`, serverId: item.serverId });
      } else {
        out.push({ ...base, provider: 'unknown' });
      }
    }
    return out;
  }

  async enforceCooldown(aiName, cooldownMs) {
    if (!cooldownMs) return;
    try {
      if (!isRedisReady()) {
        // Redis 未就绪：使用本地回退冷却
        const remain = __getLocalRemainMs(aiName);
        if (remain > 0) {
          const err = Object.assign(new Error(`Cooldown active for ${aiName}, retry in ${Math.ceil(remain / 1000)}s`), { code: 'COOLDOWN_ACTIVE', ttl: Math.ceil(remain / 1000), remainMs: remain, fallback: 'local' });
          throw err;
        }
        __setLocalCooldown(aiName, cooldownMs);
        logger.warn?.('Redis not ready — using local fallback cooldown', { aiName, cooldownMs });
        return;
      }
      const r = getRedis();
      const key = `${config.redis.metricsPrefix}:cooldown:${aiName}`;
      // 原子：SET NX PX，成功表示获取到“冷却锁”，失败表示已有锁（处于冷却期）
      const setRes = await r.set(key, '1', 'PX', Math.max(1, Math.floor(cooldownMs)), 'NX');
      if (setRes !== 'OK') {
        // 已在冷却中，查询剩余毫秒
        const pttl = await r.pttl(key);
        const remainMs = Number.isFinite(pttl) && pttl > 0 ? pttl : 0;
        const remainSec = Math.ceil(remainMs / 1000);
        const err = Object.assign(new Error(`Cooldown active for ${aiName}, retry in ${remainSec}s`), { code: 'COOLDOWN_ACTIVE', ttl: remainSec, remainMs });
        throw err;
      }
    } catch (e) {
      // 若为正常的冷却命中，向上传递，让上层按业务处理；
      // 仅在 Redis 访问异常时跳过冷却但告警。
      if (e && e.code === 'COOLDOWN_ACTIVE') {
        throw e;
      }
      // Fallback to local in-process cooldown to avoid thrashing when Redis is down
      const remain = __getLocalRemainMs(aiName);
      if (remain > 0) {
        const err = Object.assign(new Error(`Cooldown active for ${aiName}, retry in ${Math.ceil(remain / 1000)}s`), { code: 'COOLDOWN_ACTIVE', ttl: Math.ceil(remain / 1000), remainMs: remain, fallback: 'local' });
        throw err;
      }
      __setLocalCooldown(aiName, cooldownMs);
      logger.warn?.('Cooldown enforcement skipped (Redis issue) — using local fallback', { aiName, cooldownMs, error: String(e) });
    }
  }

  // --- Tool result cache helpers ---
  static _stableStringify(value) {
    const seen = new WeakSet();
    const stringify = (v) => {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (seen.has(v)) return '"[Circular]"';
      seen.add(v);
      if (Array.isArray(v)) return '[' + v.map((it) => stringify(it)).join(',') + ']';
      const keys = Object.keys(v).sort();
      const parts = [];
      for (const k of keys) parts.push(JSON.stringify(k) + ':' + stringify(v[k]));
      return '{' + parts.join(',') + '}';
    };
    return stringify(value);
  }

  static _hashArgs(aiName, args) {
    const base = `${aiName}::` + MCPCore._stableStringify(args || {});
    return crypto.createHash('sha1').update(base).digest('hex');
  }

  static _shouldUseCache(aiName) {
    const cfg = config.planner?.toolCache || {};
    if (!cfg.enable) return false;
    const deny = Array.isArray(cfg.denylist) && cfg.denylist.length ? new Set(cfg.denylist) : null;
    if (deny && deny.has(aiName)) return false;
    const allow = Array.isArray(cfg.allowlist) ? cfg.allowlist : [];
    // empty allowlist => allow all
    if (!allow.length) return true;
    return allow.includes(aiName);
  }

  // Only cache and reuse truly successful results
  static _isCacheableResult(out) {
    if (!out || out.success !== true) return false;
    const data = out.data;
    if (data && typeof data === 'object' && 'success' in data && data.success === false) {
      // 工具自身在 data.success 中声明失败时，不参与缓存/复用
      return false;
    }
    return true;
  }

  static _cacheKey(aiName, hash) {
    const pfx = String(config.redis?.metricsPrefix || 'sentra:mcp:metrics');
    return `${pfx}:cache:tool:${aiName}:${hash}`;
  }

  async callByAIName(aiName, args, options = {}) {
    const t = this.toolIndex.get(aiName);
    if (!t) return fail(new Error(`Tool not found: ${aiName}`), 'NOT_FOUND');

    const start = Date.now();
    try { await Metrics.incrCall(t.name, t.providerType); } catch (e) { logger.warn?.('metrics.incrCall failed', { e: String(e) }); }

    // Cache: attempt to serve from Redis based on aiName+args hash (only after governance check passes)
    const cacheEnabled = MCPCore._shouldUseCache(aiName) && isRedisReady();
    const ttlSec = Math.max(1, Number(config.planner?.toolCache?.ttlSeconds || 600));
    let cacheKey = null;

    const memCfg = config.memory || {};
    const vecCfg = memCfg.resultCache || {};
    const vecBaseEnabled = !!(memCfg.enable && vecCfg.enable && isRedisReady());
    const vecDeny = Array.isArray(vecCfg.denylist) && vecCfg.denylist.length ? new Set(vecCfg.denylist) : null;
    const vecAllow = Array.isArray(vecCfg.allowlist) ? vecCfg.allowlist : [];
    const vecAllowed = vecBaseEnabled && (!vecDeny || !vecDeny.has(aiName)) && (!vecAllow.length || vecAllow.includes(aiName));
    const vecReuseThreshold = Number(vecCfg.reuseThreshold ?? memCfg.reuseThreshold ?? 0.97);
    const vecTtlSec = Math.max(1, Number(vecCfg.ttlSeconds || 86400));
    const vecPoolN = Math.max(10, Number(memCfg.candidatePool || 200));
    const vecPrefix = String(memCfg.prefix || 'sentra:mcp:mem');
    let argsVec = null;
    let vecCacheTried = false;

    const maxCooldownRetries = Math.max(0, Number(config.planner?.cooldownFunctionRetry ?? 0));
    let attempt = 0;
    while (true) {
      try {
        // Governance check
        const auth = Governance.isAllowed(t, options);
        if (!auth.allowed) {
          try { await Metrics.incrFailure(t.name, t.providerType, 'FORBIDDEN'); } catch { }
          try { await Metrics.addLatency(t.name, Date.now() - start, t.providerType); } catch { }
          return fail(new Error(auth.reason || 'Forbidden'), 'FORBIDDEN');
        }

        // Check cache after governance passes
        if (cacheEnabled) {
          try {
            const h = MCPCore._hashArgs(aiName, args);
            cacheKey = MCPCore._cacheKey(aiName, h);
            const r = getRedis();
            const cached = await r.get(cacheKey);
            if (cached) {
              let obj; try { obj = JSON.parse(cached); } catch { obj = null; }
              if (MCPCore._isCacheableResult(obj)) {
                logger.info('命中工具结果缓存', { label: 'MCP', aiName, provider: t.providerType, cacheKey });
                return obj; // shape already ok()
              }
            }
          } catch (e) {
            logger.warn?.('读取工具缓存失败（忽略）', { label: 'MCP', aiName, error: String(e) });
          }
        }

        if (vecAllowed && !vecCacheTried) {
          vecCacheTried = true;
          try {
            if (!argsVec) {
              const text = MCPCore._stableStringify({ aiName, args: args || {} });
              const [vec] = await embedTexts({ texts: [text] });
              argsVec = Array.isArray(vec) ? vec : [];
            }
            if (Array.isArray(argsVec) && argsVec.length) {
              const r = getRedis();
              const idxKey = `${vecPrefix}:argcache:index:${aiName}`;
              const keys = await r.zrevrange(idxKey, 0, vecPoolN - 1);
              if (keys && keys.length) {
                const pipeline = r.pipeline();
                for (const k of keys) pipeline.hgetall(k);
                const rows = await pipeline.exec();
                let bestScore = 0;
                let bestResult = null;
                let bestArgsPreview = null;
                const nowTs = Date.now();
                const maxAgeMs = vecTtlSec * 1000;
                for (const row of rows) {
                  const err = row && row[0];
                  const d = row && row[1];
                  if (err || !d) continue;
                  const ts = Number(d.ts || 0);
                  if (maxAgeMs > 0 && ts > 0 && nowTs - ts > maxAgeMs) continue;
                  let emb;
                  try { emb = JSON.parse(d.embedding || '[]'); } catch { emb = []; }
                  if (!Array.isArray(emb) || !emb.length) continue;
                  const s = cosineSim(argsVec, emb);
                  if (!Number.isFinite(s)) continue;
                  if (s >= vecReuseThreshold && s >= bestScore) {
                    let parsed;
                    try { parsed = JSON.parse(d.result || 'null'); } catch { parsed = null; }
                    if (MCPCore._isCacheableResult(parsed)) {
                      bestScore = s;
                      bestResult = parsed;
                      if (typeof d.args === 'string') {
                        const raw = d.args;
                        bestArgsPreview = raw.length > 240
                          ? `${raw.slice(0, 240)}... (len=${raw.length})`
                          : raw;
                      } else {
                        bestArgsPreview = null;
                      }
                    }
                  }
                }
                if (bestResult) {
                  logger.info('命中向量工具结果缓存', {
                    label: 'MCP',
                    aiName,
                    provider: t.providerType,
                    score: Number(bestScore.toFixed?.(3) || bestScore),
                    argsPreview: bestArgsPreview,
                  });
                  return bestResult;
                }
              }
            }
          } catch (e) {
            logger.warn?.('读取向量工具结果缓存失败（忽略）', { label: 'MCP', aiName, error: String(e) });
          }
        }

        if (t.providerType === 'local') {
          if (t._validate && !t._validate(args || {})) {
            const e = new Error('Validation failed');
            e.details = t._validate.errors;
            throw e;
          }
          await this.enforceCooldown(aiName, t.cooldownMs);
          const selectedTimeout = Number(t.timeoutMs) > 0 ? Number(t.timeoutMs) : config.planner.toolTimeoutMs;
          const opt = { ...options, pluginEnv: t.pluginEnv || {}, timeoutMs: selectedTimeout };
          const res = await executeToolWithTimeout(() => t.handler(args || {}, opt), selectedTimeout);
          const outRaw = MCPCore._looksLikeToolResult(res)
            ? { ...res, provider: 'local' }
            : ok(res?.data ?? res, 'OK', { provider: 'local' });
          const out = MCPCore._unwrapNestedToolResult(outRaw);
          const okFlag = out?.success === true;
          if (okFlag) {
            try { await Metrics.incrSuccess(t.name, 'local'); } catch { }
          } else {
            try { await Metrics.incrFailure(t.name, 'local', out?.code || 'ERR'); } catch { }
          }
          try { await Metrics.addLatency(t.name, Date.now() - start, 'local'); } catch { }
          // Write cache on success（过滤掉 data.success === false 的伪成功）
          if (cacheEnabled && cacheKey && MCPCore._isCacheableResult(out)) {
            try {
              const r = getRedis();
              await r.setex(cacheKey, ttlSec, JSON.stringify(out));
              logger.debug?.('写入工具结果缓存', { label: 'MCP', aiName, cacheKey, ttlSec });
            } catch (e) {
              logger.warn?.('写入工具缓存失败（忽略）', { label: 'MCP', aiName, error: String(e) });
            }
          }
          if (vecAllowed && MCPCore._isCacheableResult(out)) {
            try {
              if (!argsVec) {
                const text = MCPCore._stableStringify({ aiName, args: args || {} });
                const [vec] = await embedTexts({ texts: [text] });
                argsVec = Array.isArray(vec) ? vec : [];
              }
              if (Array.isArray(argsVec) && argsVec.length) {
                const r = getRedis();
                const ts = Date.now();
                const docKey = `${vecPrefix}:argcache:doc:${aiName}:${ts}:${Math.random().toString(36).slice(2, 10)}`;
                const idxKey = `${vecPrefix}:argcache:index:${aiName}`;
                const payload = {
                  ts: String(ts),
                  args: MCPCore._stableStringify({ aiName, args: args || {} }),
                  embedding: JSON.stringify(argsVec),
                  result: JSON.stringify(out),
                };
                const currentSize = await r.zcard(idxKey);
                const multi = r.multi();
                multi.hset(docKey, payload);
                multi.zadd(idxKey, ts, docKey);
                multi.expire(docKey, vecTtlSec * 2);
                if (currentSize + 1 > vecPoolN) {
                  const removeCount = (currentSize + 1) - vecPoolN;
                  if (removeCount > 0) multi.zremrangebyrank(idxKey, 0, removeCount - 1);
                }
                await multi.exec();
              }
            } catch (e) {
              logger.warn?.('写入向量工具结果缓存失败（忽略）', { label: 'MCP', aiName, error: String(e) });
            }
          }
          return out;
        }
        if (t.providerType === 'external') {
          await this.enforceCooldown(aiName, t.cooldownMs);
          // 外部工具：移除 schedule 字段（不传递给下游服务器）
          const { schedule, ...forwardArgs } = args || {};
          const res = await executeToolWithTimeout(() => this.externalMgr.callTool(t.serverId, t.name, forwardArgs), config.planner.toolTimeoutMs);

          // MCP 标准 callTool 通常返回 { content: [{type:'text',text:'...'}], structuredContent?: any }
          // 若直接把 content 数组塞进 data，会导致日志与上下文极其冗长。
          const maxChars = Number(process.env.EXTERNAL_MCP_RESULT_MAX_CHARS || 4000);
          let payload = res;
          if (payload && typeof payload === 'object' && Array.isArray(payload.content)) {
            const text = __extractMcpTextFromContent(payload.content, maxChars);
            const contentCount = payload.content.length;
            payload = {
              text,
              contentCount,
              hasStructured: !!payload.structuredContent,
            };
          } else if (payload && typeof payload === 'object' && 'result' in payload) {
            // 兼容少数实现把真正结果放在 result 字段
            payload = payload.result;
          }

          const outRaw = MCPCore._looksLikeToolResult(payload)
            ? { ...payload, provider: `external:${t.serverId}` }
            : ok(payload, 'OK', { provider: `external:${t.serverId}` });
          const out = MCPCore._unwrapNestedToolResult(outRaw);
          const okFlag = out?.success === true;
          if (okFlag) {
            try { await Metrics.incrSuccess(t.name, `external:${t.serverId}`); } catch { }
          } else {
            try { await Metrics.incrFailure(t.name, `external:${t.serverId}`, out?.code || 'ERR'); } catch { }
          }
          try { await Metrics.addLatency(t.name, Date.now() - start, `external:${t.serverId}`); } catch { }
          if (cacheEnabled && cacheKey && MCPCore._isCacheableResult(out)) {
            try {
              const r = getRedis();
              await r.setex(cacheKey, ttlSec, JSON.stringify(out));
              logger.debug?.('写入工具结果缓存', { label: 'MCP', aiName, cacheKey, ttlSec });
            } catch (e) {
              logger.warn?.('写入工具缓存失败（忽略）', { label: 'MCP', aiName, error: String(e) });
            }
          }
          if (vecAllowed && out?.success === true) {
            try {
              if (!argsVec) {
                const text = MCPCore._stableStringify({ aiName, args: args || {} });
                const [vec] = await embedTexts({ texts: [text] });
                argsVec = Array.isArray(vec) ? vec : [];
              }
              if (Array.isArray(argsVec) && argsVec.length) {
                const r = getRedis();
                const ts = Date.now();
                const docKey = `${vecPrefix}:argcache:doc:${aiName}:${ts}:${Math.random().toString(36).slice(2, 10)}`;
                const idxKey = `${vecPrefix}:argcache:index:${aiName}`;
                const payload = {
                  ts: String(ts),
                  args: MCPCore._stableStringify({ aiName, args: args || {} }),
                  embedding: JSON.stringify(argsVec),
                  result: JSON.stringify(out),
                };
                const currentSize = await r.zcard(idxKey);
                const multi = r.multi();
                multi.hset(docKey, payload);
                multi.zadd(idxKey, ts, docKey);
                multi.expire(docKey, vecTtlSec * 2);
                if (currentSize + 1 > vecPoolN) {
                  const removeCount = (currentSize + 1) - vecPoolN;
                  if (removeCount > 0) multi.zremrangebyrank(idxKey, 0, removeCount - 1);
                }
                await multi.exec();
              }
            } catch (e) {
              logger.warn?.('写入向量工具结果缓存失败（忽略）', { label: 'MCP', aiName, error: String(e) });
            }
          }
          return out;
        }
        throw new Error(`Unknown providerType for ${aiName}`);
      } catch (e) {
        if (e && e.code === 'COOLDOWN_ACTIVE' && attempt < maxCooldownRetries) {
          attempt += 1;
          const remainMs = Number(e.remainMs || (e.ttl ? e.ttl * 1000 : (t.cooldownMs || 1000)));
          const jitter = Math.floor(100 + Math.random() * 200);
          const waitMs = Math.max(200, remainMs + jitter);
          logger.info('因冷却命中，等待后重试', { label: 'RETRY', aiName, waitMs, remainMs, attempt });
          await sleep(waitMs);
          continue; // retry once
        }
        const code = e.code || (String(e?.message || '').toLowerCase().includes('timeout') ? 'TIMEOUT' : 'ERR');
        try { await Metrics.incrFailure(t.name, t.providerType, code); } catch { }
        try { await Metrics.addLatency(t.name, Date.now() - start, t.providerType); } catch { }
        const extra = { provider: t.providerType };
        if (code === 'COOLDOWN_ACTIVE') {
          extra.remainMs = Number(e.remainMs || (e.ttl ? e.ttl * 1000 : (t.cooldownMs || 0)));
          extra.ttl = Number(e.ttl || (extra.remainMs ? Math.ceil(extra.remainMs / 1000) : 0));
        }
        return fail(e, code, extra);
      }
    }
  }

  // Simple heuristic ranking of tools for a given objective string
  rankTools(objective, limit = 5) {
    const q = (objective || '').toLowerCase();
    const arr = this.getAvailableTools().map((t) => {
      const nameScore = t.name.toLowerCase().includes(q) ? 3 : 0;
      const descScore = (t.description || '').toLowerCase().split(/\W+/).reduce((acc, w) => acc + (q.includes(w) ? 1 : 0), 0);
      return { t, score: nameScore + descScore };
    });
    return arr.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.t);
  }
}

export default MCPCore;
