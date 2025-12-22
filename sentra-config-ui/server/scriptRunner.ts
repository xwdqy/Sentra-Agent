import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import fs from 'fs';
import dotenv from 'dotenv';

interface ScriptProcess {
    id: string;
    name: 'bootstrap' | 'start' | 'napcat' | 'update' | 'sentiment';
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

    private findRunningByName(name: ScriptProcess['name']): ScriptProcess | undefined {
        for (const p of this.processes.values()) {
            if (p.name === name && p.exitCode === null) return p;
        }
        return undefined;
    }

    executeScript(scriptName: 'bootstrap' | 'start' | 'napcat' | 'update' | 'sentiment', args: string[] = []): string {
        // Enforce single instance per script
        const running = this.findRunningByName(scriptName);
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
                });
            } else {
                // Fallback: plain Python
                proc = spawn('python', [scriptPath, ...args], {
                    cwd,
                    env: baseEnv,
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
