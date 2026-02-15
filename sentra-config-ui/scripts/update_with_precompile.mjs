#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import ora from 'ora';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(uiDir, '..');

const args = process.argv.slice(2);
const isForce = args.includes('force') || args.includes('--force');

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function commandExists(cmd, checkArgs = ['--version']) {
  try {
    const r = spawnSync(cmd, checkArgs, { stdio: 'ignore', shell: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function choosePM(preferred) {
  const p = String(preferred || '').trim();
  if (p && p !== 'auto') {
    if (!commandExists(p)) throw new Error(`Package manager ${p} not found in PATH`);
    return p;
  }
  if (commandExists('pnpm')) return 'pnpm';
  if (commandExists('npm')) return 'npm';
  if (commandExists('cnpm')) return 'cnpm';
  if (commandExists('yarn')) return 'yarn';
  if (commandExists('bun')) return 'bun';
  throw new Error('No package manager found. Please install one or set PACKAGE_MANAGER in .env');
}

function resolveNpmRegistry() {
  return (
    process.env.NPM_REGISTRY ||
    process.env.NPM_CONFIG_REGISTRY ||
    process.env.npm_config_registry ||
    ''
  );
}

function run(cmd, argv, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, {
      cwd,
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv }
    });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${argv.join(' ')} exited with code ${code}`));
    });
    p.on('error', reject);
  });
}

const ROOT_TS_SCAN_DIRS = ['components', 'utils', 'src', 'types'];
const ROOT_TS_SOURCE_EXT_RE = /\.(ts|tsx|mts|cts)$/i;
const ROOT_TS_META_FILE = path.join('.cache', 'root-ts-precompile-meta.json');
const ROOT_TS_STATIC_FILES = ['Main.ts', 'tsconfig.json', 'package.json'];
const ROOT_TS_LOCK_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

function normalizeRelPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function getRootTsMetaPath(rootDir) {
  return path.join(rootDir, ROOT_TS_META_FILE);
}

function listTsSourceFilesRecursive(dir, out) {
  if (!exists(dir)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      listTsSourceFilesRecursive(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!ROOT_TS_SOURCE_EXT_RE.test(entry.name) && !entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
}

function collectRootTsSourceFiles(rootDir) {
  const files = [];
  for (const rel of ROOT_TS_STATIC_FILES) {
    const full = path.join(rootDir, rel);
    if (exists(full)) files.push(full);
  }
  for (const rel of ROOT_TS_LOCK_FILES) {
    const full = path.join(rootDir, rel);
    if (exists(full)) {
      files.push(full);
      break;
    }
  }
  for (const rel of ROOT_TS_SCAN_DIRS) {
    listTsSourceFilesRecursive(path.join(rootDir, rel), files);
  }
  const deduped = Array.from(new Set(files.map((f) => path.resolve(f))));
  deduped.sort((a, b) => normalizeRelPath(path.relative(rootDir, a)).localeCompare(normalizeRelPath(path.relative(rootDir, b))));
  return deduped;
}

function getFileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function buildRootTsSourceFingerprint(rootDir, sourceFiles) {
  const hasher = crypto.createHash('sha256');
  for (const filePath of sourceFiles) {
    const rel = normalizeRelPath(path.relative(rootDir, filePath));
    hasher.update(rel);
    hasher.update('\u0000');
    try {
      hasher.update(fs.readFileSync(filePath));
    } catch {
      hasher.update('[read_error]');
    }
    hasher.update('\u0001');
  }
  return hasher.digest('hex');
}

function loadRootTsPrecompileMeta(rootDir) {
  const metaPath = getRootTsMetaPath(rootDir);
  try {
    if (!exists(metaPath)) return null;
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

function saveRootTsPrecompileMeta(rootDir, payload) {
  const metaPath = getRootTsMetaPath(rootDir);
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Ignore cache persistence errors.
  }
}

function getRootTsCompileState(rootDir, opts = {}) {
  const { force = false } = opts;
  const mainTs = path.join(rootDir, 'Main.ts');
  const tsconfigPath = path.join(rootDir, 'tsconfig.json');
  const distMain = path.join(rootDir, 'dist', 'Main.js');
  if (!exists(mainTs) || !exists(tsconfigPath) || !exists(path.join(rootDir, 'package.json'))) {
    return { enabled: false, needed: false, reason: 'root-ts-not-applicable' };
  }

  const sourceFiles = collectRootTsSourceFiles(rootDir);
  const newestSourceMtime = sourceFiles.reduce((max, f) => {
    const t = getFileMtimeMs(f);
    return t > max ? t : max;
  }, 0);
  const distExists = exists(distMain);
  const distMtime = getFileMtimeMs(distMain);
  const shouldFingerprint = force || !distExists || newestSourceMtime > distMtime;

  if (!shouldFingerprint) {
    return {
      enabled: true,
      needed: false,
      reason: 'dist/Main.js up-to-date by mtime',
      sourceFiles
    };
  }

  const sourceFingerprint = buildRootTsSourceFingerprint(rootDir, sourceFiles);
  if (!force && distExists) {
    const meta = loadRootTsPrecompileMeta(rootDir);
    if (meta && typeof meta.sourceFingerprint === 'string' && meta.sourceFingerprint === sourceFingerprint) {
      return {
        enabled: true,
        needed: false,
        reason: 'source fingerprint unchanged (mtime drift)',
        sourceFiles,
        sourceFingerprint
      };
    }
  }

  let reason = 'source fingerprint changed';
  if (force) reason = 'force';
  else if (!distExists) reason = 'dist/Main.js missing';
  else if (newestSourceMtime > distMtime) reason = 'ts sources newer than dist/Main.js';

  return {
    enabled: true,
    needed: true,
    reason,
    sourceFiles,
    sourceFingerprint
  };
}

async function ensureRootTsPrecompiled(pm, registry, opts = {}) {
  const state = getRootTsCompileState(repoRoot, opts);
  if (!state.enabled) return;
  if (!state.needed) {
    console.log(chalk.gray(`[Core] TypeScript precompile skipped (${state.reason})`));
    return;
  }

  const spinner = ora(`[Core] Precompiling root TypeScript (${state.reason})...`).start();
  try {
    const env = {};
    if (registry) {
      env.npm_config_registry = registry;
      env.NPM_CONFIG_REGISTRY = registry;
    }
    await run(pm, ['run', 'build'], repoRoot, env);
    saveRootTsPrecompileMeta(repoRoot, {
      version: 1,
      sourceFingerprint: String(state.sourceFingerprint || ''),
      fileCount: Array.isArray(state.sourceFiles) ? state.sourceFiles.length : 0,
      reason: state.reason,
      builtAt: new Date().toISOString(),
      tool: 'update_with_precompile.mjs'
    });
    spinner.succeed('[Core] Root TypeScript precompile completed');
  } catch (e) {
    spinner.fail('[Core] Root TypeScript precompile failed');
    throw e;
  }
}

async function main() {
  const updateScript = path.join(uiDir, 'scripts', 'update.mjs');
  await run('node', [updateScript, ...args], uiDir);

  const pm = choosePM(process.env.PACKAGE_MANAGER || 'auto');
  const npmRegistry = resolveNpmRegistry();
  await ensureRootTsPrecompiled(pm, npmRegistry, { force: isForce });
}

main().catch((e) => {
  console.error(chalk.red.bold('Error: ') + (e?.message || String(e)));
  process.exit(1);
});

