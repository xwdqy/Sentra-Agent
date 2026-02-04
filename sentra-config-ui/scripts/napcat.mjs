import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import boxen from 'boxen';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root is one level above sentra-config-ui
const repoRoot = path.resolve(__dirname, '..', '..');
const napcatDir = path.join(repoRoot, 'sentra-adapter', 'napcat');
const distEntry = path.join(napcatDir, 'dist', 'src', 'main.js');
const ecosystem = path.join(repoRoot, 'ecosystem.config.cjs');
const pm2AppName = 'sentra-napcat';

const napcatEnvFile = path.join(napcatDir, '.env');
const napcatEnvExampleFile = path.join(napcatDir, '.env.example');

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

function readDotenvFile(filePath) {
  try {
    if (!exists(filePath)) return {};
    const txt = fs.readFileSync(filePath, 'utf8');
    const out = {};
    for (const rawLine of txt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function ensureNapcatEnvReady() {
  try {
    if (!exists(napcatEnvFile)) {
      if (exists(napcatEnvExampleFile)) {
        fs.copyFileSync(napcatEnvExampleFile, napcatEnvFile);
        console.log(chalk.gray('[Napcat] .env missing → copied from .env.example'));
      }
      return;
    }

    if (!exists(napcatEnvExampleFile)) return;

    const cur = readDotenvFile(napcatEnvFile);
    const ex = readDotenvFile(napcatEnvExampleFile);

    const ensureKeys = [
      'NAPCAT_WS_URL',
      'NAPCAT_MODE',
      'REVERSE_PORT',
      'REVERSE_PATH',
      'ENABLE_STREAM',
      'STREAM_PORT',
    ];

    const missing = ensureKeys.filter((k) => cur[k] == null || String(cur[k]).trim() === '');
    if (!missing.length) return;

    const appendLines = [];
    for (const k of missing) {
      const v = ex[k];
      if (v == null || String(v).trim() === '') continue;
      appendLines.push(`${k}=${v}`);
    }
    if (!appendLines.length) return;

    fs.appendFileSync(napcatEnvFile, `\n\n# Added by sentra-config-ui/scripts/napcat.mjs\n${appendLines.join('\n')}\n`, 'utf8');
    console.log(chalk.gray(`[Napcat] .env missing keys → appended defaults: ${missing.join(', ')}`));
  } catch {
  }
}

function resolveNapcatPorts(envObj) {
  const rootDotenv = readDotenvFile(path.join(repoRoot, '.env'));
  const napcatDotenv = readDotenvFile(path.join(napcatDir, '.env'));
  const get = (k) => (envObj && envObj[k]) || process.env[k] || napcatDotenv[k] || rootDotenv[k];

  const reversePort = (() => {
    const n = Number(get('REVERSE_PORT'));
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 6701;
  })();

  const enableStream = (() => {
    const v = String(get('ENABLE_STREAM') ?? '').trim().toLowerCase();
    if (!v) return false;
    return ['1', 'true', 'yes', 'y', 'on'].includes(v);
  })();

  const streamPort = (() => {
    const n = Number(get('STREAM_PORT'));
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 6702;
  })();

  return { reversePort, enableStream, streamPort };
}

function findWindowsListeningPidsByPort(port) {
  try {
    const r = spawnSync('netstat', ['-ano'], { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
    if (r.status !== 0) return [];
    const out = String(r.stdout || '');
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      if (!/\bLISTENING\b/i.test(s)) continue;
      if (!new RegExp(`[:.]${port}\\b`).test(s)) continue;
      const parts = s.split(/\s+/);
      const pidStr = parts[parts.length - 1];
      const pid = Number(pidStr);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    return Array.from(pids);
  } catch {
    return [];
  }
}

function windowsGetProcessImageName(pid) {
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
    if (r.status !== 0) return '';
    const out = String(r.stdout || '');
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const data = lines.find((l) => /^\S+\.exe\s+\d+\s+/i.test(l));
    if (!data) return '';
    return data.split(/\s+/)[0] || '';
  } catch {
    return '';
  }
}

function windowsKillPid(pid) {
  try {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

async function ensurePortFreeBeforeStart(port) {
  if (process.platform !== 'win32') return;
  const pids = findWindowsListeningPidsByPort(port);
  if (!pids.length) return;

  for (const pid of pids) {
    const img = windowsGetProcessImageName(pid).toLowerCase();
    // Safety guard: only auto-kill likely node processes (napcat is node).
    const allowed = img.includes('node');
    if (!allowed) {
      throw new Error(`Port ${port} is already in use by PID ${pid} (${img || 'unknown'}). Please close that process or change REVERSE_PORT/STREAM_PORT, then retry.`);
    }
    windowsKillPid(pid);
  }

  for (let i = 0; i < 8; i++) {
    const remain = findWindowsListeningPidsByPort(port);
    if (!remain.length) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  const remain = findWindowsListeningPidsByPort(port);
  if (remain.length) {
    throw new Error(`Port ${port} is still in use after cleanup attempt (PIDs: ${remain.join(', ')}). Please close the occupying process manually.`);
  }
}

function choosePM(preferred) {
  if (preferred && preferred !== 'auto') {
    if (!commandExists(preferred)) {
      throw new Error(`Package manager ${preferred} not found in PATH`);
    }
    return preferred;
  }
  // Auto detection priority: pnpm > npm > cnpm > yarn
  if (commandExists('pnpm')) return 'pnpm';
  if (commandExists('npm')) return 'npm';
  if (commandExists('cnpm')) return 'cnpm';
  if (commandExists('yarn')) return 'yarn';
  throw new Error('No package manager found. Please install one or set PACKAGE_MANAGER in .env');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))));
  });
}

function quotePath(p) {
  // Always quote paths to handle spaces and Chinese characters
  return JSON.stringify(p);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { cmd: 'start', env: 'production', logs: true };
  if (args[0] && ['start', 'build', 'pm2-start', 'pm2-logs', 'pm2-stop', 'pm2-delete', 'pm2-restart', 'pm2-status'].includes(args[0])) out.cmd = args[0];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--env=')) out.env = a.split('=')[1];
    else if (a === '--env' && args[i + 1]) out.env = args[++i];
    else if (a === '--no-logs') out.logs = false;
  }
  return out;
}

function resolvePm2Bin() {
  const isWin = process.platform === 'win32';
  if (commandExists('pm2', ['--version'])) return 'pm2';
  const local = path.join(__dirname, '..', 'node_modules', '.bin', isWin ? 'pm2.cmd' : 'pm2');
  if (fs.existsSync(local) && commandExists(local, ['--version'])) return local;
  return 'pm2';
}

function getPm2Process(pm2Bin, name) {
  try {
    const r = spawnSync(pm2Bin, ['jlist'], { stdio: ['ignore', 'pipe', 'ignore'], shell: true });
    if (r.status !== 0) return null;
    const out = String(r.stdout || '');
    const list = JSON.parse(out);
    if (!Array.isArray(list)) return null;
    return list.find((p) => p && p.name === name) || null;
  } catch {
    return null;
  }
}

function ensureLogsDir() {
  const logsDir = path.join(repoRoot, 'logs');
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch { }
}

function needsNapcatInstall() {
  const nmDir = path.join(napcatDir, 'node_modules');
  if (!exists(nmDir)) return true;

  // Key dev/runtime deps required for build/start
  const tscPath = path.join(nmDir, 'typescript', 'bin', 'tsc');
  const uuidPkg = path.join(nmDir, 'uuid', 'package.json');
  if (!exists(tscPath)) return true;
  if (!exists(uuidPkg)) return true;

  return false;
}

function needsNapcatBuild() {
  return !exists(distEntry);
}

async function ensureNapcatDeps(pm) {
  console.log(boxen(chalk.bold.blue(`Napcat: Node.js dependencies (using ${pm})`), { padding: 1, borderStyle: 'round' }));

  if (!needsNapcatInstall()) {
    console.log(chalk.gray('[Napcat] node_modules looks OK, skipping install'));
    return;
  }

  const args = ['install'];
  if (pm === 'pnpm') args.push('--prod=false');
  else if (pm === 'npm' || pm === 'cnpm') args.push('--production=false');

  const env = { ...process.env };
  if (pm === 'pnpm' || pm === 'npm' || pm === 'cnpm') {
    env.npm_config_production = 'false';
  }

  await run(pm, args, { cwd: napcatDir, env });
}

async function main() {
  const { cmd, env, logs } = parseArgs();
  const pm = choosePM(process.env.PACKAGE_MANAGER || 'auto');

  // Ensure dependencies for sentra-adapter/napcat before build/start
  await ensureNapcatDeps(pm);

  ensureNapcatEnvReady();

  if (cmd === 'build') {
    console.log(boxen(chalk.bold.cyan(`Napcat: build (using ${pm})`), { padding: 1, borderStyle: 'round' }));
    await run(pm, ['run', 'build'], { cwd: napcatDir });
    return;
  }

  const pm2Bin = resolvePm2Bin();
  if (!commandExists(pm2Bin, ['--version']) && pm2Bin === 'pm2') {
    throw new Error('pm2 not found in PATH and local node_modules/.bin/pm2 is missing');
  }

  if (cmd === 'pm2-status') {
    console.log(boxen(chalk.bold.blue('Napcat: pm2 status'), { padding: 1, borderStyle: 'round' }));
    await run(pm2Bin, ['status'], { cwd: repoRoot });
    return;
  }

  if (cmd === 'pm2-logs') {
    console.log(boxen(chalk.bold.blue(`Napcat: pm2 logs (${pm2AppName})`), { padding: 1, borderStyle: 'round' }));
    await run(pm2Bin, ['logs', pm2AppName], { cwd: repoRoot });
    return;
  }

  if (cmd === 'pm2-stop') {
    console.log(boxen(chalk.bold.blue(`Napcat: pm2 stop (${pm2AppName})`), { padding: 1, borderStyle: 'round' }));
    await run(pm2Bin, ['stop', pm2AppName], { cwd: repoRoot });
    return;
  }

  if (cmd === 'pm2-restart') {
    console.log(boxen(chalk.bold.blue(`Napcat: pm2 restart (${pm2AppName})`), { padding: 1, borderStyle: 'round' }));
    if (!exists(ecosystem)) throw new Error(`ecosystem file not found: ${ecosystem}`);
    const proc = getPm2Process(pm2Bin, pm2AppName);
    if (proc) {
      await run(pm2Bin, ['delete', pm2AppName], { cwd: repoRoot });
    }
    const args = ['start', quotePath(ecosystem), '--only', pm2AppName];
    if (env) args.push('--env', env);
    await run(pm2Bin, args, { cwd: repoRoot });
    if (logs) await run(pm2Bin, ['logs', pm2AppName], { cwd: repoRoot });
    return;
  }

  if (cmd === 'pm2-delete') {
    console.log(boxen(chalk.bold.blue(`Napcat: pm2 delete (${pm2AppName})`), { padding: 1, borderStyle: 'round' }));
    await run(pm2Bin, ['delete', pm2AppName], { cwd: repoRoot });
    return;
  }

  if (cmd === 'pm2-start') {
    ensureLogsDir();
    if (needsNapcatBuild()) {
      console.log(boxen(chalk.bold.cyan(`Napcat: build (dist missing) → pm2 start (using ${pm})`), { padding: 1, borderStyle: 'round' }));
      await run(pm, ['run', 'build'], { cwd: napcatDir });
    } else {
      console.log(boxen(chalk.bold.cyan(`Napcat: pm2 start (dist exists, skip build)`), { padding: 1, borderStyle: 'round' }));
    }
    if (!exists(ecosystem)) throw new Error(`ecosystem file not found: ${ecosystem}`);
    const proc = getPm2Process(pm2Bin, pm2AppName);
    if (proc) {
      await run(pm2Bin, ['delete', pm2AppName], { cwd: repoRoot });
    }

    const ports = resolveNapcatPorts(process.env);
    await ensurePortFreeBeforeStart(ports.reversePort);
    if (ports.enableStream) {
      await ensurePortFreeBeforeStart(ports.streamPort);
    }
    const args = ['start', quotePath(ecosystem), '--only', pm2AppName];
    if (env) args.push('--env', env);
    await run(pm2Bin, args, { cwd: repoRoot });
    if (logs) await run(pm2Bin, ['logs', pm2AppName], { cwd: repoRoot });
    return;
  }

  if (cmd === 'start') {
    if (needsNapcatBuild()) {
      console.log(boxen(chalk.bold.cyan(`Napcat: build (dist missing) → pm2 start (using ${pm})`), { padding: 1, borderStyle: 'round' }));
      await run(pm, ['run', 'build'], { cwd: napcatDir });
    } else {
      console.log(boxen(chalk.bold.cyan(`Napcat: pm2 start (dist exists, skip build)`), { padding: 1, borderStyle: 'round' }));
    }
    if (!exists(ecosystem)) throw new Error(`ecosystem file not found: ${ecosystem}`);
    const proc = getPm2Process(pm2Bin, pm2AppName);
    if (proc) {
      await run(pm2Bin, ['delete', pm2AppName], { cwd: repoRoot });
    }

    const ports = resolveNapcatPorts(process.env);
    await ensurePortFreeBeforeStart(ports.reversePort);
    if (ports.enableStream) {
      await ensurePortFreeBeforeStart(ports.streamPort);
    }
    const args = ['start', quotePath(ecosystem), '--only', pm2AppName];
    if (env) args.push('--env', env);
    await run(pm2Bin, args, { cwd: repoRoot });
    if (logs) await run(pm2Bin, ['logs', pm2AppName], { cwd: repoRoot });
    return;
  }
}

main().catch((e) => {
  console.error(chalk.red.bold('Error: ') + (e.message || e));
  process.exit(1);
});
