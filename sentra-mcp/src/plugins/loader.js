import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import logger from '../logger/index.js';
import dotenv from 'dotenv';
import { readSkillDocFromPluginDir } from '../utils/skillDoc.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function normalizeStringArray(value, { maxItems = 32, maxLength = 80 } = {}) {
  const src = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    const clipped = text.length > maxLength ? text.slice(0, maxLength) : text;
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeBoost(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function buildRerankSignalsFromConfig(cfg = {}, baseMeta = {}) {
  const cfgObj = (cfg && typeof cfg === 'object') ? cfg : {};
  const metaObj = (baseMeta && typeof baseMeta === 'object') ? baseMeta : {};
  const rr0 = (metaObj.rerank && typeof metaObj.rerank === 'object') ? metaObj.rerank : {};

  const triggerKeywords = normalizeStringArray(
    cfgObj.trigger_keywords
      ?? cfgObj.triggerKeywords
      ?? rr0.triggerKeywords
      ?? rr0.trigger_keywords,
    { maxItems: 64, maxLength: 80 }
  );
  const triggerPatterns = normalizeStringArray(
    cfgObj.trigger_patterns
      ?? cfgObj.triggerPatterns
      ?? rr0.triggerPatterns
      ?? rr0.trigger_patterns,
    { maxItems: 32, maxLength: 160 }
  );

  const keywordBoost = normalizeBoost(
    cfgObj.keyword_boost
      ?? cfgObj.keywordBoost
      ?? rr0.keywordBoost
      ?? rr0.keyword_boost
  );
  const regexBoost = normalizeBoost(
    cfgObj.regex_boost
      ?? cfgObj.regexBoost
      ?? rr0.regexBoost
      ?? rr0.regex_boost
  );

  return {
    ...metaObj,
    rerank: {
      ...rr0,
      triggerKeywords,
      triggerPatterns,
      keywordBoost,
      regexBoost
    }
  };
}

function normalizeTool(def) {
  if (!def?.name || typeof def.handler !== 'function') {
    throw new Error('Invalid plugin tool: name and handler required');
  }
  return {
    name: def.name,
    description: def.description || '',
    inputSchema: def.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
    scope: def.scope || 'global',
    tenant: def.tenant || 'default',
    cooldownMs: def.cooldownMs || 0,
    provider: def.provider || 'local',
    timeoutMs: def.timeoutMs || 0,
    pluginEnv: def.pluginEnv || {},
    meta: def.meta || {},
    skillDoc: def.skillDoc || null,
    _pluginDirName: def._pluginDirName,
    _pluginAbsDir: def._pluginAbsDir,
    _pluginEntryPath: def._pluginEntryPath,
    handler: def.handler,
  };
}

export async function loadPlugins(pluginsDir) {
  // Build candidate directories in priority order
  const candidates = [];
  if (pluginsDir) candidates.push(path.resolve(pluginsDir));
  if (process.env.PLUGINS_DIR) candidates.push(path.resolve(process.env.PLUGINS_DIR));
  try {
    // library root: <sentra-mcp>/plugins (robust when consumed as a dependency)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const libRoot = path.resolve(__dirname, '../..');
    candidates.push(path.join(libRoot, 'plugins'));
  } catch { }
  // de-duplicate candidates
  const seen = new Set();
  const uniq = [];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (!seen.has(abs)) { seen.add(abs); uniq.push(abs); }
  }
  // pick the first existing candidate
  let baseDir = uniq.find((d) => fs.existsSync(d));
  if (!baseDir) {
    try { logger.warn('未找到可用的插件目录', { label: 'PLUGIN', candidates: uniq }); } catch { }
    return [];
  }
  try { logger.info('扫描插件目录', { label: 'PLUGIN', baseDir, candidates: uniq }); } catch { }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const fileNames = entries.filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => e.name);

  const tools = [];
  const loadedNames = new Set();

  try { logger.info('扫描插件目录', { label: 'PLUGIN', baseDir, folders: dirNames.length, files: fileNames.length }); } catch { }

  // 1) Load folder-based plugins first
  for (const dir of dirNames) {
    const base = path.join(baseDir, dir);
    const cfgPath = path.join(base, 'config.json');
    const idxPath = path.join(base, 'index.js');
    const envPath = path.join(base, '.env');
    const envAltPath = path.join(base, 'config.env');
    const envExamplePath = path.join(base, '.env.example');
    try {
      let cfg = {};
      if (fs.existsSync(cfgPath)) {
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); } catch (e) { logger.error(`Invalid JSON in ${dir}/config.json`, { error: String(e) }); }
      }

      // Auto-bootstrap per-plugin .env from .env.example when missing, so plugins can work out-of-the-box
      try {
        if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
          fs.copyFileSync(envExamplePath, envPath);
          try {
            logger.info('插件缺少 .env，已从 .env.example 自动生成', {
              label: 'PLUGIN',
              dir,
              envPath
            });
          } catch { }
        }
      } catch (e) {
        try {
          logger.warn('自动生成插件 .env 失败，将继续尝试使用备选配置或默认值', {
            label: 'PLUGIN',
            dir,
            error: String(e)
          });
        } catch { }
      }

      // Per-plugin env overrides (parse BEFORE importing handler so we can decide to skip disabled plugins)
      let penv = {};
      try {
        if (fs.existsSync(envPath)) {
          penv = { ...penv, ...dotenv.parse(fs.readFileSync(envPath)) };
        } else if (fs.existsSync(envAltPath)) {
          penv = { ...penv, ...dotenv.parse(fs.readFileSync(envAltPath)) };
        }
      } catch (e) {
        logger.warn(`Failed to parse plugin .env for ${dir}`, { error: String(e) });
      }

      // Evaluate PLUGIN_ENABLED flag. Default: enabled=true when missing.
      let enabled = true;
      try {
        const raw = penv.PLUGIN_ENABLED ?? penv.PLUGIN_ENABLE ?? penv.ENABLED;
        if (raw !== undefined) {
          const s = String(raw).trim().toLowerCase();
          if (s === '0' || s === 'false' || s === 'off' || s === 'no') enabled = false;
          else if (s === '1' || s === 'true' || s === 'on' || s === 'yes') enabled = true;
          // any other value keeps default 'true'
        }
      } catch { }

      if (!enabled) {
        const name = cfg.name || dir;
        try { logger.info('跳过插件（.env 关闭）', { label: 'PLUGIN', name, dir, reason: 'PLUGIN_ENABLED=false' }); } catch { }
        continue; // do not import handler, do not expose in SDK
      }

      // Load handler only for enabled plugins
      let handler;
      if (fs.existsSync(idxPath)) {
        const mod = await import(pathToFileURL(idxPath).href);
        const payload = mod.default ?? mod;
        if (typeof payload === 'function') handler = payload;
        else if (typeof payload?.handler === 'function') handler = payload.handler;
      }
      if (!handler && typeof cfg?.handler === 'function') handler = cfg.handler; // not typical, but allow

      if (!handler) {
        logger.warn(`Plugin folder missing handler: ${dir}`);
        continue;
      }

      // Optional per-plugin timeout: .env overrides config.json
      let timeoutMs = 0;
      const fromCfg = Number(cfg.timeoutMs);
      const fromEnvA = Number(penv.PLUGIN_TIMEOUT_MS);
      const fromEnvB = Number(penv.TOOL_TIMEOUT_MS);
      // Priority: .env.PLUGIN_TIMEOUT_MS > .env.TOOL_TIMEOUT_MS > config.timeoutMs
      if (!Number.isNaN(fromEnvA) && fromEnvA > 0) timeoutMs = fromEnvA;
      else if (!Number.isNaN(fromEnvB) && fromEnvB > 0) timeoutMs = fromEnvB;
      else if (!Number.isNaN(fromCfg) && fromCfg > 0) timeoutMs = fromCfg;

      const def = {
        name: cfg.name || dir,
        description: cfg.description || '',
        inputSchema: cfg.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
        scope: cfg.scope || 'global',
        tenant: cfg.tenant || 'default',
        cooldownMs: cfg.cooldownMs || 0,
        provider: cfg.provider || 'local',
        timeoutMs,
        pluginEnv: penv,
        meta: buildRerankSignalsFromConfig(cfg, cfg.meta || {}),
        skillDoc: readSkillDocFromPluginDir(base) || null,
        _pluginDirName: dir,
        _pluginAbsDir: base,
        _pluginEntryPath: idxPath,
        handler,
      };
      const tool = normalizeTool(def);
      tool._validate = ajv.compile(tool.inputSchema);
      tools.push(tool);
      loadedNames.add(tool.name);
      const envKeys = Object.keys(penv || {}).length;
      logger.info(`Loaded plugin folder: ${dir}`, { label: 'PLUGIN', name: tool.name, path: base, timeoutMs, envKeys });
    } catch (e) {
      logger.error(`Failed to load plugin folder: ${dir}`, { label: 'PLUGIN', error: String(e) });
    }
  }

  // 2) Fallback: legacy single-file plugins (*.js)
  for (const file of fileNames) {
    try {
      const full = path.join(baseDir, file);
      const mod = await import(pathToFileURL(full).href);
      const payload = mod.default ?? mod;
      const defs = Array.isArray(payload) ? payload : [payload];
      let count = 0;
      for (const d of defs) {
        const probe = d?.name;
        if (probe && loadedNames.has(probe)) {
          logger.info(`Skip legacy file due to duplicate name`, { label: 'PLUGIN', file, name: probe });
          continue;
        }
        const tool = normalizeTool(d);
        if (!tool._pluginEntryPath) tool._pluginEntryPath = full;
        tool._validate = ajv.compile(tool.inputSchema);
        tools.push(tool);
        if (tool.name) loadedNames.add(tool.name);
        count += 1;
      }
      logger.info(`Loaded plugin file: ${file}`, { label: 'PLUGIN', count });
    } catch (e) {
      logger.error(`Failed to load plugin file: ${file}`, { label: 'PLUGIN', error: String(e) });
    }
  }

  try { logger.info('插件加载完成', { label: 'PLUGIN', total: tools.length }); } catch { }
  return tools;
}

export default loadPlugins;
