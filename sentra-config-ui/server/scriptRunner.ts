import { spawn, spawnSync } from 'child_process';
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
    outputBaseCursor: number;
    totalCursor: number;
    exitCode: number | null;
    startTime: Date;
    endTime: Date | null;
    emitter: EventEmitter;
    isPm2Mode?: boolean;
}

const MAX_OUTPUT_CHUNKS = 2000;

function appendOutput(p: ScriptProcess, text: string) {
    const chunk = String(text ?? '');
    if (!chunk) return;
    p.totalCursor += 1;
    p.output.push(chunk);
    if (p.output.length > MAX_OUTPUT_CHUNKS) {
        const drop = p.output.length - MAX_OUTPUT_CHUNKS;
        p.output.splice(0, drop);
        p.outputBaseCursor += drop;
    }
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

function resolvePm2Bin(): string {
    const isWin = os.platform() === 'win32';
    if (commandExists('pm2')) return 'pm2';
    const local = path.join(process.cwd(), 'node_modules', '.bin', isWin ? 'pm2.cmd' : 'pm2');
    if (fs.existsSync(local)) return local;
    return 'pm2';
}

function resolveShell(): string | undefined {
    return os.platform() === 'win32' ? 'cmd.exe' : undefined;
}

function pm2Available(): boolean {
    try {
        const pm2Bin = resolvePm2Bin();
        if (pm2Bin === 'pm2') return commandExists('pm2');
        return fs.existsSync(pm2Bin);
    } catch {
        return false;
    }
}

type Pm2DeleteResult = {
    ok: boolean;
    alreadyGone?: boolean;
    message?: string;
};

function runPm2(args: string[]): { status: number | null; stdout: string; stderr: string; error?: string } {
    const pm2Bin = resolvePm2Bin();
    const isWin = os.platform() === 'win32';
    const needsShell = isWin && (pm2Bin === 'pm2' || pm2Bin.toLowerCase().endsWith('.cmd') || pm2Bin.toLowerCase().endsWith('.bat'));
    try {
        const r = spawnSync(pm2Bin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: needsShell ? (resolveShell() || true) : false,
        });
        return {
            status: r.status,
            stdout: String(r.stdout || ''),
            stderr: String(r.stderr || ''),
            error: r.error ? String(r.error?.message || r.error) : undefined,
        };
    } catch (e: any) {
        return {
            status: null,
            stdout: '',
            stderr: '',
            error: String(e?.message || e),
        };
    }
}

function pm2HasApp(name: string): boolean {
    try {
        const r = runPm2(['jlist']);
        if (r.status !== 0) return false;
        const list = JSON.parse(String(r.stdout || ''));
        if (!Array.isArray(list)) return false;
        return list.some((p: any) => p && p.name === name);
    } catch {
        return false;
    }
}

function deletePm2ProcessByName(appName: 'sentra-agent' | 'sentra-napcat' | 'sentra-emo'): Pm2DeleteResult {
    if (!pm2Available()) {
        return { ok: false, message: 'pm2 not available' };
    }

    const r = runPm2(['delete', appName]);
    const combined = `${r.stdout}\n${r.stderr}\n${r.error || ''}`.toLowerCase();
    const notFound = combined.includes('not found') || combined.includes('process or namespace not found');
    if (r.status === 0 || notFound) {
        // Verify: avoid false positives on Windows/cross-env situations.
        const stillThere = pm2HasApp(appName);
        if (stillThere) {
            const msg = `pm2 delete reported success but process still exists: ${appName}`;
            console.error('[ScriptRunner] Failed to delete PM2 process:', msg);
            return { ok: false, message: msg };
        }
        console.log(`[ScriptRunner] Deleted PM2 process: ${appName}${notFound ? ' (already gone)' : ''}`);
        return { ok: true, alreadyGone: notFound };
    }

    const msg = `pm2 delete ${appName} failed (status=${r.status ?? 'null'})\n${r.stdout}${r.stderr}${r.error ? `\n${r.error}` : ''}`.trim();
    console.error('[ScriptRunner] Failed to delete PM2 process:', msg);
    return { ok: false, message: msg };
}

function deletePm2ByProcessId(processId: string): Pm2DeleteResult {
    const id = String(processId || '');
    // Only allow deletion of our own known PM2 app names.
    if (id.startsWith('start-')) return deletePm2ProcessByName('sentra-agent');
    if (id.startsWith('napcat-')) return deletePm2ProcessByName('sentra-napcat');
    if (id.startsWith('sentiment-')) return deletePm2ProcessByName('sentra-emo');
    return { ok: false, message: 'unknown process id prefix' };
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
        // Standard node scripts (sentiment is also wrapped as a node script to manage PM2 lifecycle)
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
            outputBaseCursor: 0,
            totalCursor: 0,
            exitCode: null,
            startTime: new Date(),
            endTime: null,
            emitter,
            isPm2Mode,
        };

        this.processes.set(id, scriptProcess);

        proc.stdout?.on('data', (data) => {
            const text = data.toString();
            appendOutput(scriptProcess, text);
            emitter.emit('output', { type: 'stdout', data: text, cursor: scriptProcess.totalCursor });
        });

        proc.stderr?.on('data', (data) => {
            const text = data.toString();
            appendOutput(scriptProcess, text);
            emitter.emit('output', { type: 'stderr', data: text, cursor: scriptProcess.totalCursor });
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
            appendOutput(scriptProcess, errorMsg);
            emitter.emit('output', { type: 'stderr', data: errorMsg, cursor: scriptProcess.totalCursor });
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
            outputBaseCursor: 0,
            totalCursor: 0,
            exitCode: null,
            startTime: new Date(),
            endTime: null,
            emitter,
            isPm2Mode: false,
        };

        this.processes.set(id, scriptProcess);

        if (usedBashFallbackToPwsh) {
            const msg = 'Bash not found. Install Git for Windows (Git Bash) or enable WSL to use bash.';
            appendOutput(scriptProcess, msg);
            emitter.emit('output', { type: 'stderr', data: msg + '\r\n', cursor: scriptProcess.totalCursor });
        }

        proc.stdout?.on('data', (data) => {
            const text = data.toString();
            appendOutput(scriptProcess, text);
            emitter.emit('output', { type: 'stdout', data: text, cursor: scriptProcess.totalCursor });
        });

        proc.stderr?.on('data', (data) => {
            const text = data.toString();
            appendOutput(scriptProcess, text);
            emitter.emit('output', { type: 'stderr', data: text, cursor: scriptProcess.totalCursor });
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
            appendOutput(scriptProcess, errorMsg);
            emitter.emit('output', { type: 'stderr', data: errorMsg, cursor: scriptProcess.totalCursor });
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

    killProcess(id: string): { success: boolean; message: string; pm2?: Pm2DeleteResult } {
        const record = this.processes.get(id);
        if (!record || record.exitCode !== null) {
            // The wrapper record may be missing (UI refresh / server restart / GC) while PM2 is still running.
            // Fall back to a safe, scoped PM2 delete based on processId prefix.
            const pm2 = deletePm2ByProcessId(id);
            return {
                success: pm2.ok,
                pm2,
                message: pm2.ok ? 'PM2 process deleted' : (pm2.message || 'Failed to delete PM2 process'),
            };
        }

        const pid = record.process.pid;
        if (!pid) {
            const pm2 = deletePm2ByProcessId(id);
            return {
                success: pm2.ok,
                pm2,
                message: pm2.ok ? 'PM2 process deleted' : (pm2.message || 'Failed to delete PM2 process'),
            };
        }

        try {
            // Special handling for PM2-managed start script
            if (record.name === 'start') {
                // Kill the wrapper process first
                if (os.platform() === 'win32') {
                    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
                } else {
                    try { process.kill(pid, 'SIGTERM'); } catch { }
                }

                // Always attempt to delete the scoped PM2 process. If it doesn't exist, it's a no-op.
                const pm2 = deletePm2ProcessByName('sentra-agent');
                return { success: pm2.ok, pm2, message: pm2.ok ? 'Process terminated (PM2 deleted)' : (pm2.message || 'Wrapper terminated but PM2 delete failed') };
            } else if (record.name === 'napcat') {
                if (os.platform() === 'win32') {
                    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
                } else {
                    try { process.kill(pid, 'SIGTERM'); } catch { }
                    setTimeout(() => {
                        try { process.kill(pid, 'SIGKILL'); } catch { }
                    }, 500);
                }

                const pm2 = deletePm2ProcessByName('sentra-napcat');
                return { success: pm2.ok, pm2, message: pm2.ok ? 'Process terminated (PM2 deleted)' : (pm2.message || 'Wrapper terminated but PM2 delete failed') };
            } else if (record.name === 'sentiment') {
                if (os.platform() === 'win32') {
                    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
                } else {
                    try { process.kill(pid, 'SIGTERM'); } catch { }
                    setTimeout(() => {
                        try { process.kill(pid, 'SIGKILL'); } catch { }
                    }, 500);
                }

                const pm2 = deletePm2ProcessByName('sentra-emo');
                return { success: pm2.ok, pm2, message: pm2.ok ? 'Process terminated (PM2 deleted)' : (pm2.message || 'Wrapper terminated but PM2 delete failed') };
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
                return { success: true, message: 'Process terminated' };
            }
        } catch {
            return { success: false, message: 'Failed to terminate process' };
        }
    }

    cleanupAll(opts?: { includePm2?: boolean }): { ok: boolean; killed: string[]; pm2: Array<{ name: string; ok: boolean; message?: string }> } {
        const includePm2 = opts?.includePm2 !== false;
        const killed: string[] = [];
        const pm2Res: Array<{ name: string; ok: boolean; message?: string }> = [];

        try {
            const ids = Array.from(this.processes.keys());
            for (const id of ids) {
                const rec = this.processes.get(id);
                if (!rec || rec.exitCode !== null) continue;
                const r = this.killProcess(id);
                if (r.success) killed.push(id);
            }
        } catch {
        }

        if (includePm2) {
            try {
                const a = deletePm2ProcessByName('sentra-napcat');
                pm2Res.push({ name: 'sentra-napcat', ok: a.ok, message: a.message });
            } catch {
            }
            try {
                const a = deletePm2ProcessByName('sentra-agent');
                pm2Res.push({ name: 'sentra-agent', ok: a.ok, message: a.message });
            } catch {
            }
            try {
                const a = deletePm2ProcessByName('sentra-emo');
                pm2Res.push({ name: 'sentra-emo', ok: a.ok, message: a.message });
            } catch {
            }
        }

        return { ok: true, killed, pm2: pm2Res };
    }

    subscribeToOutput(id: string, callback: (data: { type: string; data: string; cursor?: number }) => void): (() => void) | null {
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
