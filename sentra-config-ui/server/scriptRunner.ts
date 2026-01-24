import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import fs from 'fs';
import dotenv from 'dotenv';

interface ScriptProcess {
    id: string;
    name: 'bootstrap' | 'start' | 'napcat' | 'update' | 'sentiment' | 'shell';
    dedupeKey: string;
    process: ReturnType<typeof spawn>;
    output: string[];
    exitCode: number | null;
    startTime: Date;
    endTime: Date | null;
    emitter: EventEmitter;
    isPm2Mode?: boolean;
}

function commandExists(cmd: string): boolean {
    try {
        if (os.platform() === 'win32') {
            execSync(`where ${cmd}`, { stdio: 'ignore' });
        } else {
            execSync(`command -v ${cmd}`, { stdio: 'ignore' });
        }
        return true;
    } catch {
        return false;
    }
}

function resolveSentimentRunner(runtimeEnv: Record<string, string>): 'uv' | 'python' {
    const prefer = (runtimeEnv.SENTRA_EMO_RUNNER || process.env.SENTRA_EMO_RUNNER || 'auto').toString().toLowerCase();
    const hasUv = commandExists('uv');

    if (prefer === 'uv') return hasUv ? 'uv' : 'python';
    if (prefer === 'python') return 'python';

    // auto: prefer uv when available, otherwise fall back to python
    return hasUv ? 'uv' : 'python';
}

export class ScriptRunner {
    private processes: Map<string, ScriptProcess> = new Map();

    private computeDedupeKey(name: ScriptProcess['name'], args: string[]): string {
        // Some scripts accept sub-commands; they must not share the same running instance.
        // Otherwise UI actions like "napcat build" and "napcat start" will reuse the same processId
        // and appear as the wrong app with identical logs.
        const first = (Array.isArray(args) && args.length ? String(args[0]) : '').toLowerCase();

        if (name === 'napcat') {
            // napcat.mjs supports: start | build
            return `napcat:${first || 'start'}`;
        }

        if (name === 'update') {
            // update.mjs supports optional: force
            const isForce = args.some((a) => String(a).toLowerCase() === 'force');
            return `update:${isForce ? 'force' : 'normal'}`;
        }

        // Default: single instance per script name
        return name;
    }

    private findRunningByDedupeKey(dedupeKey: string): ScriptProcess | undefined {
        for (const p of this.processes.values()) {
            if (p.dedupeKey === dedupeKey && p.exitCode === null) return p;
        }
        return undefined;
    }

    executeScript(scriptName: 'bootstrap' | 'start' | 'napcat' | 'update' | 'sentiment', args: string[] = []): string {
        // Enforce single instance per dedupeKey (script + relevant args)
        const dedupeKey = this.computeDedupeKey(scriptName, args);
        const running = this.findRunningByDedupeKey(dedupeKey);
        if (running) {
            return running.id; // Return existing running id
        }

        const id = `${scriptName}-${Date.now()}`;
        const emitter = new EventEmitter();

        // Load latest .env from UI project to reflect runtime changes without server restart
        let runtimeEnv: Record<string, string> = {};
        try {
            const envPath = path.join(process.cwd(), '.env');
            if (fs.existsSync(envPath)) {
                const parsed = dotenv.parse(fs.readFileSync(envPath));
                runtimeEnv = parsed as unknown as Record<string, string>;
            }
        } catch { }

        let proc;
        const windowsHide = os.platform() === 'win32';
        if (scriptName === 'sentiment') {
            // Special handling for Sentra Emo (Python FastAPI service)
            const scriptPath = 'run.py';
            // Assuming sentra-config-ui is in the root, so sentra-emo is a sibling
            const cwd = path.join(process.cwd(), '..', 'sentra-emo');

            const runner = resolveSentimentRunner(runtimeEnv);
            const baseEnv = {
                ...process.env,
                ...runtimeEnv,
                FORCE_COLOR: '3',
                CLICOLOR_FORCE: '1',
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
                PYTHONUNBUFFERED: '1',
            };

            if (runner === 'uv') {
                // Prefer uv when available: uv run python run.py [...args]
                proc = spawn('uv', ['run', 'python', scriptPath, ...args], {
                    cwd,
                    env: baseEnv,
                    windowsHide,
                });
            } else {
                // Fallback: plain Python
                proc = spawn('python', [scriptPath, ...args], {
                    cwd,
                    env: baseEnv,
                    windowsHide,
                });
            }
        } else {
            // Standard node scripts
            const scriptPath = path.join(process.cwd(), 'scripts', `${scriptName}.mjs`);
            proc = spawn('node', [scriptPath, ...args], {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    ...runtimeEnv,
                    FORCE_COLOR: '3',
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                },
                windowsHide,
            });
        }

        const isPm2Mode = scriptName === 'start' && (() => {
            const modeEq = args.find((a) => a.startsWith('--mode='));
            if (modeEq) {
                const value = modeEq.split('=')[1];
                return value === 'pm2';
            }
            const modeIndex = args.indexOf('--mode');
            if (modeIndex !== -1 && args[modeIndex + 1]) {
                return args[modeIndex + 1] === 'pm2';
            }
            return false;
        })();

        const scriptProcess: ScriptProcess = {
            id,
            name: scriptName,
            dedupeKey,
            process: proc,
            output: [],
            exitCode: null,
            startTime: new Date(),
            endTime: null,
            emitter,
            isPm2Mode,
        };

        this.processes.set(id, scriptProcess);

        proc.stdout?.on('data', (data) => {
            const text = data.toString();
            scriptProcess.output.push(text);
            emitter.emit('output', { type: 'stdout', data: text });
        });

        proc.stderr?.on('data', (data) => {
            const text = data.toString();
            scriptProcess.output.push(text);
            emitter.emit('output', { type: 'stderr', data: text });
        });

        proc.on('close', (code) => {
            scriptProcess.exitCode = code;
            scriptProcess.endTime = new Date();
            emitter.emit('exit', { code });

            // Clean up after 5 minutes
            setTimeout(() => {
                this.processes.delete(id);
            }, 5 * 60 * 1000);
        });

        // Handle spawn errors (e.g. bad cwd, command not found)
        proc.on('error', (err) => {
            const errorMsg = `Failed to start process: ${err.message}`;
            scriptProcess.output.push(errorMsg);
            emitter.emit('output', { type: 'stderr', data: errorMsg });
            scriptProcess.exitCode = 1;
            scriptProcess.endTime = new Date();
            emitter.emit('exit', { code: 1 });
            console.error(`[ScriptRunner] Error spawning ${scriptName}:`, err);
        });

        return id;
    }

    executeShell(args: string[] = []): string {
        const shellType = (Array.isArray(args) && args.length ? String(args[0] || '') : '').trim().toLowerCase();

        const id = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const emitter = new EventEmitter();

        const windowsHide = os.platform() === 'win32';

        let runtimeEnv: Record<string, string> = {};
        try {
            const envPath = path.join(process.cwd(), '.env');
            if (fs.existsSync(envPath)) {
                const parsed = dotenv.parse(fs.readFileSync(envPath));
                runtimeEnv = parsed as unknown as Record<string, string>;
            }
        } catch { }

        const baseEnv = {
            ...process.env,
            ...runtimeEnv,
            FORCE_COLOR: '3',
            CLICOLOR_FORCE: '1',
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
        };

        const isWin = os.platform() === 'win32';
        let cmd = '';
        let cmdArgs: string[] = [];

        const findGitBash = () => {
            try {
                const candidates = [
                    path.join(process.env['ProgramFiles'] || '', 'Git', 'bin', 'bash.exe'),
                    path.join(process.env['ProgramFiles'] || '', 'Git', 'usr', 'bin', 'bash.exe'),
                    path.join(process.env['ProgramFiles(x86)'] || '', 'Git', 'bin', 'bash.exe'),
                    path.join(process.env['ProgramFiles(x86)'] || '', 'Git', 'usr', 'bin', 'bash.exe'),
                    path.join(process.env['LocalAppData'] || '', 'Programs', 'Git', 'bin', 'bash.exe'),
                    path.join(process.env['LocalAppData'] || '', 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
                ].filter(Boolean);
                for (const p of candidates) {
                    if (p && fs.existsSync(p)) return p;
                }
            } catch { }
            return '';
        };

        if (isWin) {
            if (shellType === 'cmd') {
                cmd = 'cmd.exe';
                cmdArgs = ['/Q', '/K', 'chcp 65001>nul & PROMPT $P$G'];
            } else if (shellType === 'bash') {
                if (commandExists('bash')) {
                    cmd = 'bash';
                    cmdArgs = ['-i'];
                } else {
                    const gitBash = findGitBash();
                    if (gitBash) {
                        cmd = gitBash;
                        cmdArgs = ['-i'];
                    } else if (commandExists('wsl')) {
                        cmd = 'wsl.exe';
                        cmdArgs = ['-e', 'bash', '-li'];
                    } else {
                        cmd = 'powershell.exe';
                        cmdArgs = ['-NoLogo', '-NoExit'];
                    }
                }
            } else {
                cmd = 'powershell.exe';
                cmdArgs = ['-NoLogo', '-NoExit'];
            }
        } else {
            if (shellType === 'zsh') {
                cmd = 'zsh';
                cmdArgs = ['-i'];
            } else if (shellType === 'sh') {
                cmd = 'sh';
                cmdArgs = ['-i'];
            } else {
                cmd = 'bash';
                cmdArgs = ['-i'];
            }
        }

        const usedBashFallbackToPwsh = isWin && shellType === 'bash' && cmd.toLowerCase().includes('powershell.exe');

        const proc = spawn(cmd, cmdArgs, {
            cwd: process.cwd(),
            env: baseEnv,
            windowsHide,
        });

        const scriptProcess: ScriptProcess = {
            id,
            name: 'shell',
            dedupeKey: id,
            process: proc,
            output: [],
            exitCode: null,
            startTime: new Date(),
            endTime: null,
            emitter,
            isPm2Mode: false,
        };

        this.processes.set(id, scriptProcess);

        if (usedBashFallbackToPwsh) {
            const msg = 'Bash not found. Install Git for Windows (Git Bash) or enable WSL to use bash.';
            scriptProcess.output.push(msg);
            emitter.emit('output', { type: 'stderr', data: msg + '\r\n' });
        }

        proc.stdout?.on('data', (data) => {
            const text = data.toString();
            scriptProcess.output.push(text);
            emitter.emit('output', { type: 'stdout', data: text });
        });

        proc.stderr?.on('data', (data) => {
            const text = data.toString();
            scriptProcess.output.push(text);
            emitter.emit('output', { type: 'stderr', data: text });
        });

        proc.on('close', (code) => {
            scriptProcess.exitCode = code;
            scriptProcess.endTime = new Date();
            emitter.emit('exit', { code });

            setTimeout(() => {
                this.processes.delete(id);
            }, 5 * 60 * 1000);
        });

        proc.on('error', (err) => {
            const errorMsg = `Failed to start process: ${err.message}`;
            scriptProcess.output.push(errorMsg);
            emitter.emit('output', { type: 'stderr', data: errorMsg });
            scriptProcess.exitCode = 1;
            scriptProcess.endTime = new Date();
            emitter.emit('exit', { code: 1 });
            console.error(`[ScriptRunner] Error spawning shell (${shellType || 'default'}):`, err);
        });

        return id;
    }

    getProcess(id: string): ScriptProcess | undefined {
        return this.processes.get(id);
    }

    killProcess(id: string): boolean {
        const record = this.processes.get(id);
        if (!record || record.exitCode !== null) return false;

        const pid = record.process.pid;
        if (!pid) return false;

        try {
            // Special handling for PM2-managed start script
            if (record.name === 'start') {
                // Kill the wrapper process first
                if (os.platform() === 'win32') {
                    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
                } else {
                    try { process.kill(pid, 'SIGTERM'); } catch { }
                }

                // If pm2 is installed, also delete any lingering PM2 process
                if (record.isPm2Mode && commandExists('pm2')) {
                    try {
                        execSync('pm2 delete sentra-agent', { stdio: 'ignore' });
                        console.log('[ScriptRunner] Deleted PM2 process: sentra-agent');
                    } catch (pm2Error) {
                        console.error('[ScriptRunner] Failed to delete PM2 process:', pm2Error);
                        // Continue anyway since wrapper is killed
                    }
                }
            } else {
                // Normal process termination for other scripts
                if (os.platform() === 'win32') {
                    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
                } else {
                    try { process.kill(pid, 'SIGTERM'); } catch { }
                    setTimeout(() => {
                        try { process.kill(pid, 'SIGKILL'); } catch { }
                    }, 500);
                }
            }
            return true;
        } catch {
            return false;
        }
    }

    subscribeToOutput(id: string, callback: (data: { type: string; data: string }) => void): (() => void) | null {
        const proc = this.processes.get(id);
        if (!proc) return null;

        proc.emitter.on('output', callback);
        return () => proc.emitter.off('output', callback);
    }

    subscribeToExit(id: string, callback: (data: { code: number | null }) => void): (() => void) | null {
        const proc = this.processes.get(id);
        if (!proc) return null;

        proc.emitter.on('exit', callback);
        return () => proc.emitter.off('exit', callback);
    }

    writeInput(id: string, data: string): boolean {
        const proc = this.processes.get(id);
        if (!proc || proc.exitCode !== null) return false;

        if (proc.process.stdin && !proc.process.stdin.destroyed) {
            proc.process.stdin.write(data);
            return true;
        }
        return false;
    }
}

export const scriptRunner = new ScriptRunner();
