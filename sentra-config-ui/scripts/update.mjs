#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import ora from 'ora';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root directory is one level up from sentra-config-ui
const ROOT_DIR = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const isForce = args.includes('force') || args.includes('--force');

console.log(chalk.blue.bold('\n🔄 Sentra Agent Update Script\n'));
console.log(chalk.gray(`Root Directory: ${ROOT_DIR}`));
console.log(chalk.gray(`Update Mode: ${isForce ? 'FORCE' : 'NORMAL'}\n`));

function exists(p) {
    try {
        fs.accessSync(p);
        return true;
    } catch {
        return false;
    }
}

function getFileHash(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return crypto.createHash('md5').update(content).digest('hex');
    } catch {
        return null;
    }
}

function isNodeProject(dir) {
    return exists(path.join(dir, 'package.json'));
}

function isPythonProject(dir) {
    return exists(path.join(dir, 'requirements.txt'));
}

function listSentraSubdirs(root) {
    const out = [];
    try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory() && e.name.startsWith('sentra-')) {
                out.push(path.join(root, e.name));
            }
        }
    } catch {
        // Ignore errors
    }
    return out;
}



/**
 * Recursively find nested projects in a given directory
 */
function listNestedProjects(dir) {
    const results = [];
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return results;
    }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const name = e.name;
        if (name === 'node_modules' || name === '.venv' || name === '__pycache__' || name.startsWith('.')) continue;

        const sub = path.join(dir, name);
        if (isNodeProject(sub) || isPythonProject(sub)) {
            results.push(sub);
        }
    }
    return results;
}

function collectAllProjects() {
    const projects = new Set();
    const uiDir = path.resolve(ROOT_DIR, 'sentra-config-ui');

    const tryAdd = (d) => {
        if (isNodeProject(d) || isPythonProject(d)) projects.add(d);
    };

    tryAdd(ROOT_DIR);
    tryAdd(uiDir);

    // Add all sentra-* directories
    for (const dir of listSentraSubdirs(ROOT_DIR)) {
        tryAdd(dir);
        // Also include one-level nested projects
        for (const nested of listNestedProjects(dir)) {
            projects.add(nested);
        }
    }

    return Array.from(projects);
}



// --- Python Venv Management ---

function getVenvPath(projectDir) {
    return path.join(projectDir, '.venv');
}

function getVenvPython(projectDir) {
    const venv = getVenvPath(projectDir);
    // Windows: .venv/Scripts/python.exe
    // POSIX: .venv/bin/python
    if (process.platform === 'win32') {
        return path.join(venv, 'Scripts', 'python.exe');
    } else {
        return path.join(venv, 'bin', 'python');
    }
}

function getVenvPip(projectDir) {
    const venv = getVenvPath(projectDir);
    if (process.platform === 'win32') {
        return path.join(venv, 'Scripts', 'pip.exe');
    } else {
        return path.join(venv, 'bin', 'pip');
    }
}

async function ensureVenv(projectDir, spinner) {
    const venvPath = getVenvPath(projectDir);
    const pythonExe = getVenvPython(projectDir);

    if (!exists(pythonExe)) {
        if (spinner) spinner.text = 'Creating virtual environment...';
        else console.log(chalk.gray('    Creating virtual environment (.venv)...'));

        await execCommand('python', ['-m', 'venv', '.venv'], projectDir);
    }
    return venvPath;
}

function collectPnpmLockFiles(projects) {
    const lockFiles = [];
    for (const dir of projects) {
        const lockPath = path.join(dir, 'pnpm-lock.yaml');
        if (exists(lockPath)) {
            lockFiles.push(lockPath);
        }
    }
    return lockFiles;
}

function toGitPath(absolutePath) {
    const rel = path.relative(ROOT_DIR, absolutePath) || '.';
    return rel.split(path.sep).join('/');
}

async function isGitTracked(gitPath) {
    try {
        // 如果文件未被 Git 跟踪，ls-files --error-unmatch 会抛错
        await execCommandOutput('git', ['ls-files', '--error-unmatch', gitPath], ROOT_DIR);
        return true;
    } catch {
        return false;
    }
}

async function ensureSkipWorktreeForLockFiles(lockFiles) {
    if (!lockFiles.length) return;

    console.log(chalk.cyan('\n🔧 Configuring Git to ignore local changes to pnpm-lock.yaml...\n'));

    for (const file of lockFiles) {
        const gitPath = toGitPath(file);
        try {
            const tracked = await isGitTracked(gitPath);
            if (!tracked) {
                console.log(chalk.gray(`  - ${gitPath}: not tracked by git, skip skip-worktree`));
                continue;
            }
            await execCommand('git', ['update-index', '--skip-worktree', gitPath], ROOT_DIR);
            console.log(chalk.gray(`  - ${gitPath}: marked as skip-worktree`));
        } catch (e) {
            console.log(chalk.yellow(`  - ${gitPath}: skip-worktree failed (${e.message})`));
        }
    }
}

function resolveMirrorProfileDefaults() {
    const profile = String(process.env.MIRROR_PROFILE || '').toLowerCase();
    const isChina = profile === 'china' || profile === 'cn' || profile === 'tsinghua' || profile === 'npmmirror' || profile === 'taobao';
    return {
        npmRegistryDefault: isChina ? 'https://registry.npmmirror.com/' : '',
    };
}

function resolveNpmRegistry() {
    const { npmRegistryDefault } = resolveMirrorProfileDefaults();
    return (
        process.env.NPM_REGISTRY ||
        process.env.NPM_CONFIG_REGISTRY ||
        process.env.npm_config_registry ||
        npmRegistryDefault ||
        ''
    );
}

function commandExists(cmd, checkArgs = ['--version']) {
    try {
        const r = spawn(cmd, checkArgs, { stdio: 'ignore', shell: true });
        r.on('close', () => { });
        return true;
    } catch {
        return false;
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

async function execCommand(command, args, cwd, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            cwd,
            stdio: 'inherit',
            shell: true,
            env: {
                ...process.env,
                ...extraEnv,
                FORCE_COLOR: '3',
            }
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });

        proc.on('error', reject);
    });
}

// Load .env file
const envPath = path.join(ROOT_DIR, 'sentra-config-ui', '.env');
let env = {};
try {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            const value = match[2].trim().replace(/^["']|["']$/g, ''); // Remove quotes
            env[key] = value;
        }
    });
} catch (e) {
    // Ignore if .env missing
}

function getUpdateSourceUrl() {
    const source = (env.UPDATE_SOURCE || 'github').toLowerCase();
    const customUrl = env.UPDATE_CUSTOM_URL;

    if (source === 'gitee') {
        return 'https://gitee.com/yuanpluss/Sentra-Agent.git';
    } else if (source === 'custom' && customUrl) {
        return customUrl;
    }
    // Default to GitHub
    return 'https://github.com/JustForSO/Sentra-Agent.git';
}

async function switchRemote(url) {
    try {
        // Check current remote
        const currentRemote = (await execCommandOutput('git', ['remote', 'get-url', 'origin'], ROOT_DIR)).trim();

        if (currentRemote !== url) {
            console.log(chalk.yellow(`\n🔄 Switching remote from ${currentRemote} to ${url}...`));
            await execCommand('git', ['remote', 'set-url', 'origin', url], ROOT_DIR);
            console.log(chalk.green('✅ Remote updated successfully'));
        }
    } catch (e) {
        // If remote doesn't exist, add it
        try {
            await execCommand('git', ['remote', 'add', 'origin', url], ROOT_DIR);
            console.log(chalk.green('✅ Remote added successfully'));
        } catch (err) {
            console.warn(chalk.red('⚠️ Failed to update remote URL:'), err.message);
        }
    }
}

async function execCommandOutput(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { cwd, shell: true });
        let output = '';
        proc.stdout.on('data', (data) => output += data.toString());
        proc.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`Command failed: ${command}`)));
        proc.on('error', reject);
    });
}

async function update() {
    const spinner = ora();

    try {
        // Step 0: Configure Remote
        const targetUrl = getUpdateSourceUrl();
        console.log(chalk.cyan(`\n🌐 Update Source: ${env.UPDATE_SOURCE || 'github'} (${targetUrl})`));
        await switchRemote(targetUrl);

        // Step 1: Detect projects and record pre-update hashes
        console.log(chalk.cyan('\n📦 Detecting projects...\n'));
        const projects = collectAllProjects();
        const beforeHashes = new Map();

        for (const dir of projects) {
            const label = path.relative(ROOT_DIR, dir) || '.';
            const isNode = isNodeProject(dir);
            const isPy = isPythonProject(dir);

            let typeStr = '';
            if (isNode) typeStr += 'Node';
            if (isPy) typeStr += (typeStr ? '/Python' : 'Python');

            console.log(chalk.gray(`  Found [${typeStr}]: ${label}`));

            if (isNode) beforeHashes.set(dir + ':pkg', getFileHash(path.join(dir, 'package.json')));
            if (isPy) beforeHashes.set(dir + ':req', getFileHash(path.join(dir, 'requirements.txt')));
        }
        console.log();

        const lockFiles = collectPnpmLockFiles(projects);

        // Step 2: Git operations
        if (isForce) {
            console.log(chalk.yellow.bold('⚠️  Force Update Mode - This will discard local changes!\n'));
            spinner.start('Fetching latest changes...');
            await execCommand('git', ['fetch', '--all'], ROOT_DIR);
            spinner.succeed('Fetched latest changes');

            spinner.start('Resetting to origin/main...');
            await execCommand('git', ['reset', '--hard', 'origin/main'], ROOT_DIR);
            spinner.succeed('Reset to origin/main');

            spinner.start('Cleaning untracked files...');
            await execCommand('git', ['clean', '-fd'], ROOT_DIR);
            spinner.succeed('Cleaned untracked files');
        } else {
            if (lockFiles.length > 0) {
                await ensureSkipWorktreeForLockFiles(lockFiles);
            }
            spinner.start('Checking for updates...');
            await execCommand('git', ['fetch'], ROOT_DIR);
            spinner.succeed('Checked for updates');

            spinner.start('Pulling latest changes...');
            try {
                await execCommand('git', ['pull'], ROOT_DIR);
                spinner.succeed('Pulled latest changes');
            } catch (e) {
                spinner.fail('Pull failed (conflict?)');
                console.log(chalk.yellow('\n💡 Tip: Try "Force Update" if you have local conflicts.'));
                throw e;
            }
        }

        // Step 3: Check which projects need installation
        console.log(chalk.cyan('\n🔍 Checking for dependency changes...\n'));
        const installQueue = [];

        for (const dir of projects) {
            const label = path.relative(ROOT_DIR, dir) || '.';
            const isNode = isNodeProject(dir);
            const isPy = isPythonProject(dir);

            // --- Node Check ---
            if (isNode) {
                const nmPath = path.join(dir, 'node_modules');
                const pkgPath = path.join(dir, 'package.json');
                const beforeHash = beforeHashes.get(dir + ':pkg');
                const afterHash = getFileHash(pkgPath);

                if (!exists(nmPath)) {
                    console.log(chalk.yellow(`  [Node] ${label}: node_modules missing → install needed`));
                    installQueue.push({ dir, label, type: 'node', reason: 'missing node_modules' });
                } else if (beforeHash !== afterHash) {
                    console.log(chalk.yellow(`  [Node] ${label}: package.json changed → install needed`));
                    installQueue.push({ dir, label, type: 'node', reason: 'package.json changed' });
                } else if (isForce) {
                    console.log(chalk.yellow(`  [Node] ${label}: Force update → reinstalling`));
                    installQueue.push({ dir, label, type: 'node', reason: 'force update' });
                } else {
                    console.log(chalk.gray(`  [Node] ${label}: no changes → skip`));
                }
            }

            // --- Python Check ---
            if (isPy) {
                const venvPath = getVenvPath(dir);
                const reqPath = path.join(dir, 'requirements.txt');
                const beforeHash = beforeHashes.get(dir + ':req');
                const afterHash = getFileHash(reqPath);
                const venvPython = getVenvPython(dir);

                if (!exists(venvPath) || !exists(venvPython)) {
                    console.log(chalk.yellow(`  [Python] ${label}: venv missing/broken → install needed`));
                    installQueue.push({ dir, label, type: 'python', reason: 'missing .venv' });
                } else if (beforeHash !== afterHash) {
                    console.log(chalk.yellow(`  [Python] ${label}: requirements.txt changed → install needed`));
                    installQueue.push({ dir, label, type: 'python', reason: 'requirements.txt changed' });
                } else if (isForce) {
                    console.log(chalk.yellow(`  [Python] ${label}: Force update → reinstalling`));
                    installQueue.push({ dir, label, type: 'python', reason: 'force update' });
                } else {
                    console.log(chalk.gray(`  [Python] ${label}: no changes → skip`));
                }
            }
        }

        // Step 4: Execute Installations
        if (installQueue.length > 0) {
            console.log(chalk.cyan(`\n📥 Installing dependencies for ${installQueue.length} targets...\n`));
            const npmRegistry = resolveNpmRegistry();
            const pm = choosePM(env.PACKAGE_MANAGER || 'auto');

            for (const item of installQueue) {
                const { dir, label, type, reason } = item;

                if (type === 'node') {
                    spinner.start(`[Node] Installing ${label} (${reason})...`);
                    try {
                        const extraEnv = {};
                        if (npmRegistry) {
                            extraEnv.npm_config_registry = npmRegistry;
                            extraEnv.NPM_CONFIG_REGISTRY = npmRegistry;
                        }
                        await execCommand(pm, ['install'], dir, extraEnv);
                        spinner.succeed(`[Node] Installed ${label}`);
                    } catch (error) {
                        spinner.fail(`[Node] Failed to install ${label}`);
                        throw error;
                    }
                } else if (type === 'python') {
                    spinner.start(`[Python] Preparing ${label} (${reason})...`);
                    try {
                        await ensureVenv(dir, spinner);
                        const pip = getVenvPip(dir);
                        if (!exists(pip)) throw new Error(`Pip not found at ${pip}`);

                        spinner.text = `[Python] Pip installing ${label}...`;
                        await execCommand(pip, ['install', '-r', 'requirements.txt'], dir);
                        spinner.succeed(`[Python] Installed ${label}`);
                    } catch (error) {
                        spinner.fail(`[Python] Failed to install ${label}`);
                        throw error;
                    }
                }
            }
        } else {
            console.log(chalk.green('\n✨ No dependency changes detected, skipping installation\n'));
        }

        console.log(chalk.green.bold('\n✅ Update completed successfully!\n'));
        process.exit(0);
    } catch (error) {
        spinner.fail('Update failed');
        console.error(chalk.red('\n❌ Error:'), error.message);
        process.exit(1);
    }
}

update();
