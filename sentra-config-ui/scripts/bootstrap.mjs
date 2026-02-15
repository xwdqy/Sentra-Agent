import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(uiDir, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    pm: process.env.PACKAGE_MANAGER || 'auto',
    py: 'auto',
    force: false,
    dryRun: false,
    only: 'all',
    pipIndex: process.env.PIP_INDEX_URL || ''
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') out.force = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--pm=')) out.pm = a.split('=')[1];
    else if (a === '--pm' && args[i + 1]) { out.pm = args[++i]; }
    else if (a.startsWith('--py=')) out.py = a.split('=')[1];
    else if (a === '--py' && args[i + 1]) { out.py = args[++i]; }
    else if (a.startsWith('--only=')) out.only = a.split('=')[1];
    else if (a === '--only' && args[i + 1]) { out.only = args[++i]; }
    else if (a.startsWith('--pip-index=')) out.pipIndex = a.split('=')[1];
    else if (a === '--pip-index' && args[i + 1]) { out.pipIndex = args[++i]; }
    else if (a === '--help' || a === '-h') {
      console.log(chalk.cyan('Usage: node scripts/bootstrap.mjs [--pm pnpm|npm|cnpm|yarn] [--py uv|venv] [--only all|node|python] [--force] [--dry-run] [--pip-index <url>]'));
      process.exit(0);
    }
  }
  return out;
}

function commandExists(cmd, checkArgs = ['--version']) {
  try {
    const r = spawnSync(cmd, checkArgs, { stdio: 'ignore', shell: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

function commandOutput(cmd, args = []) {
  try {
    const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    if (r.status === 0) return String(r.stdout || '').trim();
  } catch {
  }
  return '';
}

function resolveCommandLocation(cmd) {
  const isWin = process.platform === 'win32';
  const out = commandOutput(isWin ? 'where' : 'which', [cmd]);
  return out;
}

function run(cmd, args, cwd, extraEnv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: 'inherit', shell: true, env: { ...process.env, ...(extraEnv || {}) } });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function quotePath(p) {
  // Always quote paths to handle spaces and Chinese characters
  // Use JSON.stringify to handle internal quotes properly
  return JSON.stringify(p);
}

function listSentraSubdirs(root) {
  const out = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('sentra-')) {
      out.push(path.join(root, e.name));
    }
  }
  return out;
}

function listNestedNodeProjects(dir) {
  // Find immediate child directories that contain package.json
  const results = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return results; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const sub = path.join(dir, name);
    if (isNodeProject(sub)) results.push(sub);
  }
  return results;
}

function isNodeProject(dir) {
  return exists(path.join(dir, 'package.json'));
}

function isNodeInstalled(dir) {
  return exists(path.join(dir, 'node_modules'));
}

/**
 * 获取 lock 文件路径和修改时间（支持多种包管理器）
 */
function getLockFileInfo(dir) {
  const lockFiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];
  for (const lockFile of lockFiles) {
    const lockPath = path.join(dir, lockFile);
    if (exists(lockPath)) {
      try {
        const stat = fs.statSync(lockPath);
        return { file: lockFile, path: lockPath, mtime: stat.mtimeMs };
      } catch {
        continue;
      }
    }
  }
  return null;
}

/**
 * 检查 lock 文件是否比 node_modules 更新
 * 如果 lock 文件更新，说明依赖有变化需要重新安装
 */
function isLockNewerThanNodeModules(dir) {
  const nmPath = path.join(dir, 'node_modules');
  if (!exists(nmPath)) return false;

  const lockInfo = getLockFileInfo(dir);
  if (!lockInfo) return false;

  try {
    const nmStat = fs.statSync(nmPath);
    // lock 文件比 node_modules 目录新 -> 需要重新安装
    return lockInfo.mtime > nmStat.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * 检查 package.json 是否比 node_modules 更新
 */
function isPkgNewerThanNodeModules(dir) {
  const nmPath = path.join(dir, 'node_modules');
  const pkgPath = path.join(dir, 'package.json');
  if (!exists(nmPath) || !exists(pkgPath)) return false;

  try {
    const nmStat = fs.statSync(nmPath);
    const pkgStat = fs.statSync(pkgPath);
    return pkgStat.mtimeMs > nmStat.mtimeMs;
  } catch {
    return false;
  }
}

function choosePM(preferred) {
  if (preferred && preferred !== 'auto') {
    if (!commandExists(preferred)) throw new Error(`Package manager ${preferred} not found in PATH`);
    return preferred;
  }
  // Auto detection priority: pnpm > npm > cnpm > yarn
  if (commandExists('pnpm')) return 'pnpm';
  if (commandExists('npm')) return 'npm';
  if (commandExists('cnpm')) return 'cnpm';
  if (commandExists('yarn')) return 'yarn';
  throw new Error('No package manager found. Please install one or set PACKAGE_MANAGER in .env');
}

function buildGlobalPm2InstallArgs(pm) {
  const v = String(pm || '').toLowerCase();
  if (v === 'yarn') return ['global', 'add', 'pm2@latest'];
  if (v === 'bun') return ['add', '-g', 'pm2@latest'];
  return ['install', '-g', 'pm2@latest'];
}

function resolveLocalPm2Bin() {
  const isWin = process.platform === 'win32';
  const local = path.join(uiDir, 'node_modules', '.bin', isWin ? 'pm2.cmd' : 'pm2');
  if (exists(local) && commandExists(local, ['--version'])) return local;
  const rootLocal = path.join(repoRoot, 'node_modules', '.bin', isWin ? 'pm2.cmd' : 'pm2');
  if (exists(rootLocal) && commandExists(rootLocal, ['--version'])) return rootLocal;
  return '';
}

async function ensureGlobalPm2(pm, dryRun, registry) {
  const spinner = ora(`Ensuring global pm2@latest (using ${pm})...`).start();
  if (dryRun) {
    const preferred = String(pm || '').toLowerCase() === 'pnpm' ? '' : pm;
    const installer = preferred || (commandExists('npm') ? 'npm' : pm);
    spinner.info(chalk.yellow(`[DRY] ${installer} ${buildGlobalPm2InstallArgs(installer).join(' ')}`));
    return;
  }

  const beforeVersion = commandOutput('pm2', ['--version']);
  const beforeLocation = resolveCommandLocation('pm2');

  let hasAnyPm2 = false;
  try {
    if (commandExists('pm2', ['--version'])) {
      hasAnyPm2 = true;
    } else {
      const localPm2 = resolveLocalPm2Bin();
      if (localPm2) hasAnyPm2 = true;
    }
  } catch {
  }

  try {
    const extraEnv = {};
    if (registry) {
      extraEnv.npm_config_registry = registry;
      extraEnv.NPM_CONFIG_REGISTRY = registry;
    }
    const preferred = String(pm || '').toLowerCase() === 'pnpm' ? '' : pm;
    const installer = preferred || (commandExists('npm') ? 'npm' : '');
    if (!installer) {
      if (hasAnyPm2) {
        spinner.succeed(chalk.green('pm2 is available (skipped upgrade: no supported global installer found)'));
        return;
      }
      throw new Error('No supported global installer found for pm2@latest');
    }

    spinner.text = hasAnyPm2
      ? `Upgrading global pm2@latest (using ${installer})...`
      : `Installing global pm2@latest (using ${installer})...`;

    const installArgs = buildGlobalPm2InstallArgs(installer);
    if (hasAnyPm2 && String(installer).toLowerCase() === 'npm') {
      installArgs.push('--force');
    }
    await run(installer, installArgs, repoRoot, extraEnv);
    const afterVersion = commandOutput('pm2', ['--version']);
    const afterLocation = resolveCommandLocation('pm2');

    if (afterVersion) {
      spinner.succeed(chalk.green(`Global pm2 is ready (pm2 ${afterVersion})`));
    } else {
      spinner.succeed(chalk.green('Global pm2 is ready'));
    }

    if (beforeVersion && afterVersion && beforeVersion === afterVersion) {
      console.log(chalk.yellow(`pm2 version did not change (still ${afterVersion}). This may be normal if already latest, or PATH points to a different pm2.`));
    }
    const loc = String(afterLocation || beforeLocation || '').trim();
    if (loc) {
      console.log(chalk.gray(`pm2 location:\n${loc}`));
    }
  } catch (e) {
    spinner.fail(chalk.yellow('Failed to install/upgrade global pm2 (continuing)'));
    try {
      if (pm !== 'npm' && commandExists('npm')) {
        const extraEnv = {};
        if (registry) {
          extraEnv.npm_config_registry = registry;
          extraEnv.NPM_CONFIG_REGISTRY = registry;
        }
        await run('npm', ['install', '-g', 'pm2@latest'], repoRoot, extraEnv);
        console.log(chalk.green('Global pm2 installed via npm fallback'));

        const afterVersion = commandOutput('pm2', ['--version']);
        const afterLocation = resolveCommandLocation('pm2');
        if (afterVersion) {
          console.log(chalk.green(`pm2 version: ${afterVersion}`));
        }
        if (afterLocation) {
          console.log(chalk.gray(`pm2 location:\n${afterLocation}`));
        }
      }
    } catch {
      console.log(chalk.gray('You can try manually: npm install -g pm2@latest'));
      if (String(pm || '').toLowerCase() === 'pnpm') {
        console.log(chalk.gray('If you insist on pnpm global installs, run: pnpm setup (or set PNPM_HOME and add it to PATH), then retry.'));
      }
    }
  }
}

function resolveMirrorProfileDefaults() {
  const profile = String(process.env.MIRROR_PROFILE || '').toLowerCase();
  const isChina = profile === 'china' || profile === 'cn' || profile === 'tsinghua' || profile === 'npmmirror' || profile === 'taobao';
  return {
    npmRegistryDefault: isChina ? 'https://registry.npmmirror.com/' : '',
    pipIndexDefault: isChina ? 'https://pypi.tuna.tsinghua.edu.cn/simple' : '',
  };
}

function resolveNpmRegistry() {
  const { npmRegistryDefault } = resolveMirrorProfileDefaults();
  // Prefer explicit env, fallback to profile default, otherwise undefined to let PM default
  return (
    process.env.NPM_REGISTRY ||
    process.env.NPM_CONFIG_REGISTRY ||
    process.env.npm_config_registry ||
    npmRegistryDefault ||
    ''
  );
}

function parseTrustedHostsFromEnv() {
  const raw = process.env.PIP_TRUSTED_HOSTS || process.env.PIP_TRUSTED_HOST || '';
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function hasTorchRequirement(emoDir) {
  const reqPath = path.join(emoDir, 'requirements.txt');
  try {
    const content = fs.readFileSync(reqPath, 'utf8');
    return /(^|\n)\s*torch\s*[><=]/.test(content);
  } catch {
    return false;
  }
}

async function installNode(dir, pm, dryRun, registry) {
  const label = path.relative(repoRoot, dir) || '.';
  const spinner = ora(`Installing dependencies for ${chalk.bold(label)}...`).start();

  if (dryRun) {
    spinner.info(chalk.yellow(`[DRY] ${pm} install (include dev) @ ${label}${registry ? ` [registry=${registry}]` : ''}`));
    return;
  }

  try {
    const args = ['install'];
    if (pm === 'pnpm') args.push('--prod=false');
    else args.push('--production=false');
    const extraEnv = { npm_config_production: 'false' };
    if (registry) {
      extraEnv.npm_config_registry = registry;
      extraEnv.NPM_CONFIG_REGISTRY = registry; // some tools read upper-case
    }
    await run(pm, args, dir, extraEnv);
    spinner.succeed(chalk.green(`Installed dependencies for ${label}`));
  } catch (e) {
    spinner.fail(chalk.red(`Failed to install dependencies for ${label}`));
    throw e;
  }
}

async function ensureNodeProjects(pm, force, dryRun, registry) {
  console.log(boxen(chalk.bold.blue('Node.js Dependencies'), { padding: 1, borderStyle: 'round' }));

  const projects = new Set();
  projects.add(repoRoot);
  projects.add(uiDir);
  for (const dir of listSentraSubdirs(repoRoot)) {
    if (isNodeProject(dir)) projects.add(dir);
    // Also include one-level nested Node projects (e.g., sentra-adapter/napcat)
    for (const nested of listNestedNodeProjects(dir)) {
      projects.add(nested);
    }
  }
  const results = [];
  for (const dir of projects) {
    if (!isNodeProject(dir)) continue;
    const installed = isNodeInstalled(dir);
    const lockNewer = isLockNewerThanNodeModules(dir);
    const pkgNewer = isPkgNewerThanNodeModules(dir);
    results.push({ dir, installed, lockNewer, pkgNewer });
  }
  for (const r of results) {
    const label = path.relative(repoRoot, r.dir) || '.';
    let reason = null;

    if (!r.installed) {
      reason = 'node_modules missing';
    } else if (force) {
      reason = 'force install';
    } else if (r.lockNewer) {
      const lockInfo = getLockFileInfo(r.dir);
      reason = `${lockInfo?.file || 'lock file'} changed`;
    } else if (r.pkgNewer) {
      reason = 'package.json changed';
    }

    if (reason) {
      console.log(chalk.yellow(`[Node] ${label}: ${reason} → installing...`));
      await installNode(r.dir, pm, dryRun, registry);
    } else {
      console.log(chalk.gray(`[Node] Skipped (up to date) @ ${label}`));
    }
  }
}

async function ensurePuppeteerBrowserForMcp(pm, dryRun) {
  const mcpDir = path.join(repoRoot, 'sentra-mcp');
  const label = path.relative(repoRoot, mcpDir) || 'sentra-mcp';
  if (!exists(mcpDir) || !isNodeProject(mcpDir)) return;

  const pkgPath = path.join(mcpDir, 'package.json');
  let hasPuppeteer = false;
  try {
    const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw);
    hasPuppeteer = !!(pkg?.dependencies?.puppeteer || pkg?.devDependencies?.puppeteer);
  } catch {
    // If we cannot read/parse package.json, just skip
    return;
  }
  if (!hasPuppeteer) return;

  const spinner = ora(`Ensuring Puppeteer Chrome browser is installed for ${chalk.bold(label)}...`).start();
  if (dryRun) {
    spinner.info(chalk.yellow(`[DRY] puppeteer browsers install chrome @ ${label}`));
    return;
  }

  const cmd = pm === 'pnpm' ? 'pnpm' : 'npx';
  const args = pm === 'pnpm'
    ? ['exec', 'puppeteer', 'browsers', 'install', 'chrome']
    : ['puppeteer', 'browsers', 'install', 'chrome'];

  try {
    await run(cmd, args, mcpDir);
    spinner.succeed(chalk.green(`Puppeteer Chrome browser ready @ ${label}`));
  } catch (e) {
    spinner.fail(chalk.red(`Failed to install Puppeteer Chrome browser for ${label}`));
    console.warn(chalk.yellow(`You may need to run "${cmd} ${args.join(' ')}" manually in ${mcpDir}`));
  }
}

const ROOT_TS_SCAN_DIRS = ['components', 'utils', 'src', 'types'];
const ROOT_TS_SOURCE_EXT_RE = /\.(ts|tsx|mts|cts)$/i;
const ROOT_TS_META_FILE = path.join('.cache', 'root-ts-precompile-meta.json');
const ROOT_TS_STATIC_FILES = ['Main.ts', 'tsconfig.json', 'package.json'];
const ROOT_TS_LOCK_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

function getRootTsMetaPath(rootDir) {
  return path.join(rootDir, ROOT_TS_META_FILE);
}

function normalizeRelPath(p) {
  return String(p || '').replace(/\\/g, '/');
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
  if (!exists(mainTs) || !exists(tsconfigPath) || !isNodeProject(rootDir)) {
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

async function ensureRootTsPrecompiled(pm, dryRun, registry, opts = {}) {
  const { force = false } = opts;
  const state = getRootTsCompileState(repoRoot, { force });
  if (!state.enabled) return;
  if (!state.needed) {
    console.log(chalk.gray(`[Core] TypeScript precompile skipped (${state.reason})`));
    return;
  }

  const spinner = ora(`[Core] Precompiling root TypeScript (${state.reason})...`).start();
  if (dryRun) {
    spinner.info(chalk.yellow(`[DRY] ${pm} run build @ . (${state.reason})`));
    return;
  }
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
      tool: 'bootstrap.mjs'
    });
    spinner.succeed(chalk.green('Root TypeScript precompile completed'));
  } catch (e) {
    spinner.fail(chalk.red('Root TypeScript precompile failed'));
    throw e;
  }
}

function venvPythonPath(venvDir) {
  return process.platform === 'win32' ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
}

function detectPython() {
  const cands = [
    { cmd: 'python3', args: [] },
    { cmd: 'python', args: [] },
    { cmd: 'py', args: ['-3'] },
    { cmd: 'py', args: [] }
  ];
  for (const c of cands) {
    try {
      const r = spawnSync(c.cmd, [...c.args, '-V'], { stdio: 'ignore', shell: true });
      if (r.status === 0) return c;
    } catch { }
  }
  return null;
}

function hasUv() {
  return commandExists('uv');
}

async function installRequirementsWithFallback(vpy, emoDir, pipIndex, dryRun) {
  const attempts = [];
  const basePipArgs = ['-m', 'pip', 'install', '-r', quotePath('requirements.txt'), '--retries', '3', '--timeout', '60'];
  const extraIndexEnv = (process.env.PIP_EXTRA_INDEX_URL || '').trim();
  let extraIndex = extraIndexEnv;
  const trustedHosts = parseTrustedHostsFromEnv();
  const trustedArgs = trustedHosts.flatMap(h => ['--trusted-host', h]);
  const uvAvailable = hasUv();
  const pipOnlyCustomIndexEnv = String(process.env.PIP_ONLY_CUSTOM_INDEX || '').toLowerCase();
  const pipOnlyCustomIndex = pipOnlyCustomIndexEnv === '1' || pipOnlyCustomIndexEnv === 'true';

  if (!extraIndex && hasTorchRequirement(emoDir)) {
    const pytorchIndex = (process.env.PYTORCH_INDEX_URL || '').trim() || 'https://download.pytorch.org/whl/cpu';
    extraIndex = pytorchIndex;
  }

  if (uvAvailable) {
    attempts.push({
      cmd: 'uv',
      args: ['pip', 'install', '-r', quotePath('requirements.txt'), '--python', quotePath(vpy), '--index-url', (pipIndex || 'https://pypi.org/simple')].concat(extraIndex ? ['--extra-index-url', extraIndex] : []),
      label: 'uv pip (--python venv)'
    });
  }

  if (pipIndex) {
    attempts.push({
      cmd: quotePath(vpy),
      args: [...basePipArgs, '-i', pipIndex, ...(extraIndex ? ['--extra-index-url', extraIndex] : ['--extra-index-url', 'https://pypi.org/simple']), ...trustedArgs],
      label: `pip (-i ${pipIndex}${extraIndex ? ` + extra-index ${extraIndex}` : ' + extra-index pypi.org'})`
    });
  }

  if (!pipOnlyCustomIndex) {
    attempts.push({
      cmd: quotePath(vpy),
      args: [...basePipArgs, '-i', 'https://pypi.org/simple', ...(extraIndex ? ['--extra-index-url', extraIndex] : []), ...trustedArgs],
      label: `pip (official pypi.org${extraIndex ? ` + extra-index ${extraIndex}` : ''})`
    });
  }

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const spinner = ora(`Attempt ${i + 1}/${attempts.length}: ${a.label}`).start();

    if (dryRun) {
      spinner.info(chalk.yellow(`[DRY] Attempt ${i + 1}/${attempts.length}: ${a.label}`));
      continue;
    }

    try {
      await run(a.cmd, a.args, emoDir);
      spinner.succeed(chalk.green(`Success: ${a.label}`));
      return; // success
    } catch (err) {
      spinner.fail(chalk.red(`Failed: ${a.label}`));
      if (i === attempts.length - 1) throw err;
    }
  }
}

async function ensureEmoPython(pyChoice, pipIndex, force, dryRun) {
  console.log('\n' + boxen(chalk.bold.yellow('Python Environment'), { padding: 1, borderStyle: 'round' }));

  const emoDir = path.join(repoRoot, 'sentra-emo');
  const req = path.join(emoDir, 'requirements.txt');
  if (!exists(emoDir) || !exists(req)) {
    console.log(chalk.gray('[Python] sentra-emo not found or requirements.txt missing, skipped'));
    return;
  }
  const venvDir = path.join(emoDir, '.venv');
  const needCreate = force || !exists(venvDir);

  if (needCreate) {
    const spinner = ora('Creating virtual environment...').start();
    if (dryRun) {
      spinner.info(chalk.yellow(`[DRY] Create Python venv @ ${path.relative(repoRoot, emoDir)}`));
    } else {
      try {
        if ((pyChoice === 'uv' || pyChoice === 'auto') && commandExists('uv')) {
          await run('uv', ['venv', '.venv'], emoDir);
        } else {
          const py = detectPython();
          if (!py) throw new Error('No Python found. Please install Python 3 or install uv.');
          await run(py.cmd, [...py.args, '-m', 'venv', '.venv'], emoDir);
        }
        spinner.succeed(chalk.green('Virtual environment created'));
      } catch (e) {
        spinner.fail(chalk.red('Failed to create virtual environment'));
        throw e;
      }
    }
  }

  const vpy = venvPythonPath(venvDir);
  if (!exists(vpy)) {
    throw new Error('Virtualenv python not found. Creation may have failed.');
  }

  if (dryRun) {
    console.log(chalk.yellow(`[DRY] Upgrade pip & install requirements`));
    return;
  }

  try {
    const trustedHosts = parseTrustedHostsFromEnv();
    const trustedArgs = trustedHosts.flatMap(h => ['--trusted-host', h]);
    await run(quotePath(vpy), ['-m', 'pip', 'install', '--upgrade', 'pip', '-i', 'https://pypi.org/simple', ...trustedArgs], emoDir);
  } catch { }

  console.log(chalk.blue('Installing requirements for sentra-emo...'));
  await installRequirementsWithFallback(vpy, emoDir, pipIndex, false);
}

async function main() {
  console.log(chalk.bold.magenta(' Sentra Agent Bootstrap'));
  const opts = parseArgs();
  const pm = choosePM(opts.pm);
  const { pipIndexDefault } = resolveMirrorProfileDefaults();
  const resolvedPipIndex = (opts.pipIndex || pipIndexDefault || '').trim();
  const npmRegistry = resolveNpmRegistry();

  await ensureGlobalPm2(pm, opts.dryRun, npmRegistry);

  if (opts.only === 'all' || opts.only === 'node') {
    await ensureNodeProjects(pm, opts.force, opts.dryRun, npmRegistry);
    await ensurePuppeteerBrowserForMcp(pm, opts.dryRun);
    await ensureRootTsPrecompiled(pm, opts.dryRun, npmRegistry, { force: opts.force });
  }
  if (opts.only === 'all' || opts.only === 'python') {
    await ensureEmoPython(opts.py, resolvedPipIndex, opts.force, opts.dryRun);
  }
  console.log('\n' + chalk.green.bold('✨ Setup completed successfully!'));
}

main().catch((e) => {
  console.error(chalk.red.bold('Error: ') + (e.message || e));
  process.exit(1);
});
