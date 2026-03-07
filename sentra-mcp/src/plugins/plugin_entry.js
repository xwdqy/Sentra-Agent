import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

function normalizeHandler(handler) {
  if (typeof handler === 'function') return handler;
  throw new Error('plugin handler must be a function');
}

function isMainModule(importMetaUrl) {
  const current = String(importMetaUrl || '').trim();
  const entry = String(process.argv?.[1] || '').trim();
  if (!current || !entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === current;
  } catch {
    return false;
  }
}

async function readStdinText() {
  let text = '';
  await new Promise((resolve, reject) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += String(chunk || ''); });
    process.stdin.on('end', resolve);
    process.stdin.on('error', reject);
  });
  return String(text || '');
}

function parseJsonSafe(text) {
  try { return JSON.parse(String(text || '')); } catch { return null; }
}

function normalizeCliInput(parsed) {
  const src = (parsed && typeof parsed === 'object') ? parsed : {};
  const args = (src.args && typeof src.args === 'object') ? src.args : src;
  const options = (src.options && typeof src.options === 'object') ? src.options : {};
  return { args, options };
}

function loadPluginEnvForModule(importMetaUrl) {
  const out = {};
  try {
    const modulePath = fileURLToPath(String(importMetaUrl || ''));
    const moduleDir = path.dirname(modulePath);
    const envPaths = [
      path.join(moduleDir, '.env'),
      path.join(moduleDir, 'config.env'),
    ];
    for (const p of envPaths) {
      if (!fs.existsSync(p)) continue;
      try {
        const parsed = dotenv.parse(fs.readFileSync(p, 'utf8'));
        Object.assign(out, parsed || {});
      } catch { }
    }
  } catch { }
  return out;
}

function mergeCliOptionsWithPluginEnv(options = {}, pluginEnv = {}) {
  const opt = (options && typeof options === 'object') ? options : {};
  const penv = (pluginEnv && typeof pluginEnv === 'object') ? pluginEnv : {};
  const mergedPluginEnv = {
    ...penv,
    ...((opt.pluginEnv && typeof opt.pluginEnv === 'object') ? opt.pluginEnv : {}),
  };
  for (const [k, v] of Object.entries(mergedPluginEnv)) {
    if (process.env[k] !== undefined) continue;
    try { process.env[k] = String(v); } catch { }
  }
  return { ...opt, pluginEnv: mergedPluginEnv };
}

async function runWithStdoutRedirectedToStderr(fn) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => process.stderr.write(...args);
  try {
    return await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
}

export function createPluginHandler(handler) {
  const fn = normalizeHandler(handler);
  return async function pluginHandler(args = {}, options = {}) {
    return fn(args || {}, options || {});
  };
}

export function runPluginCliIfMain(handler, importMetaUrl) {
  if (!isMainModule(importMetaUrl)) return;
  const fn = createPluginHandler(handler);

  const run = async () => {
    const argvPayload = String(process.argv?.[2] || '').trim();
    const stdinPayload = argvPayload ? '' : (await readStdinText()).trim();
    const raw = argvPayload || stdinPayload || '{}';
    const parsed = parseJsonSafe(raw);
    if (!parsed || typeof parsed !== 'object') {
      process.stdout.write(JSON.stringify({
        success: false,
        code: 'INVALID_INPUT_JSON',
        data: null,
        error: { message: 'Expected JSON payload from argv[2] or stdin.' }
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    const { args, options } = normalizeCliInput(parsed);
    const pluginEnv = loadPluginEnvForModule(importMetaUrl);
    const mergedOptions = mergeCliOptionsWithPluginEnv(options, pluginEnv);
    const out = await runWithStdoutRedirectedToStderr(() => fn(args, mergedOptions));
    process.stdout.write(JSON.stringify(out, null, 2));
  };

  run().catch((error) => {
    process.stdout.write(JSON.stringify({
      success: false,
      code: 'CLI_EXEC_ERROR',
      data: null,
      error: {
        message: String(error?.message || error),
        stack: String(error?.stack || '')
      }
    }, null, 2));
    process.exitCode = 1;
  });
}

function resolveHandlerFromModule(mod) {
  if (typeof mod?.default === 'function') return mod.default;
  if (typeof mod?.handler === 'function') return mod.handler;
  if (typeof mod?.inprocessHandler === 'function') return mod.inprocessHandler;
  if (typeof mod?.workerHandler === 'function') return mod.workerHandler;
  if (typeof mod?.subprocessHandler === 'function') return mod.subprocessHandler;
  return null;
}

export function runCurrentModuleCliIfMain(importMetaUrl) {
  if (!isMainModule(importMetaUrl)) return;
  const run = async () => {
    const argvPayload = String(process.argv?.[2] || '').trim();
    const stdinPayload = argvPayload ? '' : (await readStdinText()).trim();
    const raw = argvPayload || stdinPayload || '{}';
    const parsed = parseJsonSafe(raw);
    if (!parsed || typeof parsed !== 'object') {
      process.stdout.write(JSON.stringify({
        success: false,
        code: 'INVALID_INPUT_JSON',
        data: null,
        error: { message: 'Expected JSON payload from argv[2] or stdin.' }
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    const { args, options } = normalizeCliInput(parsed);
    const mod = await import(String(importMetaUrl));
    const handler = resolveHandlerFromModule(mod);
    if (typeof handler !== 'function') {
      process.stdout.write(JSON.stringify({
        success: false,
        code: 'MISSING_HANDLER',
        data: null,
        error: { message: 'No executable handler export found in current module.' }
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    const pluginEnv = loadPluginEnvForModule(importMetaUrl);
    const mergedOptions = mergeCliOptionsWithPluginEnv(options, pluginEnv);
    const out = await runWithStdoutRedirectedToStderr(() => createPluginHandler(handler)(args, mergedOptions));
    process.stdout.write(JSON.stringify(out, null, 2));
  };

  run().catch((error) => {
    process.stdout.write(JSON.stringify({
      success: false,
      code: 'CLI_EXEC_ERROR',
      data: null,
      error: {
        message: String(error?.message || error),
        stack: String(error?.stack || '')
      }
    }, null, 2));
    process.exitCode = 1;
  });
}

export default {
  createPluginHandler,
  runPluginCliIfMain,
  runCurrentModuleCliIfMain
};
