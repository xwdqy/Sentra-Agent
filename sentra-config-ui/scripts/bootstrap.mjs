import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
  console.log(chalk.bold.magenta('🚀 Sentra Agent Bootstrap'));
  const opts = parseArgs();
  const pm = choosePM(opts.pm);
  const { pipIndexDefault } = resolveMirrorProfileDefaults();
  const resolvedPipIndex = (opts.pipIndex || pipIndexDefault || '').trim();
  const npmRegistry = resolveNpmRegistry();

  if (opts.only === 'all' || opts.only === 'node') {
    await ensureNodeProjects(pm, opts.force, opts.dryRun, npmRegistry);
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
