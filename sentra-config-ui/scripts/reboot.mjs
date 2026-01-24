import { spawn, execSync } from 'child_process';

const args = process.argv.slice(2);

function getArgValue(name) {
    const idx = args.indexOf(name);
    if (idx >= 0) return args[idx + 1] || '';
    const withEq = args.find(a => a.startsWith(`${name}=`));
    if (!withEq) return '';
    const parts = withEq.split('=');
    return parts.slice(1).join('=');
}

const portsRaw = getArgValue('--ports');
const restartCmd = getArgValue('--cmd');
const healthUrl = getArgValue('--health');
const maxWaitMs = Number(getArgValue('--max-wait-ms') || '60000');
const pollIntervalMs = Number(getArgValue('--poll-ms') || '250');

if (!portsRaw || !restartCmd) {
    console.error('Usage: node reboot.mjs --ports <1234,5678> --cmd <"npm run dev"> [--health <url>]');
    process.exit(1);
}

const ports = String(portsRaw)
    .split(',')
    .map(p => parseInt(p.trim(), 10))
    .filter(p => Number.isFinite(p) && p > 0);

console.log('[Reboot] Starting reboot sequence...');
console.log(`[Reboot] Ports to clear: ${ports.join(', ')}`);
console.log(`[Reboot] Restart command: ${restartCmd}`);

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function getWindowsPidsForPort(port) {
    try {
        const output = execSync(`netstat -ano | findstr /R /C:":${port} "`).toString();
        const lines = output.split('\n').filter(l => l.trim().length > 0);
        const pids = new Set();
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const pid = Number(parts[parts.length - 1]);
            if (Number.isFinite(pid) && pid > 0) pids.add(pid);
        }
        return Array.from(pids);
    } catch {
        return [];
    }
}

function getWindowsProcessInfo(pid) {
    try {
        const raw = execSync(`wmic process where (ProcessId=${pid}) get ParentProcessId,Name,CommandLine /format:list`).toString();
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const rec = {};
        for (const line of lines) {
            const idx = line.indexOf('=');
            if (idx <= 0) continue;
            const k = line.slice(0, idx).trim();
            const v = line.slice(idx + 1).trim();
            rec[k] = v;
        }
        const parentPid = Number(rec.ParentProcessId || 0);
        return {
            pid,
            parentPid: Number.isFinite(parentPid) ? parentPid : 0,
            name: String(rec.Name || ''),
            commandLine: String(rec.CommandLine || ''),
        };
    } catch {
        try {
            const cmd = `powershell -NoProfile -Command "try { $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if (-not $p) { '{}' } else { $p | Select-Object ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress } } catch { '{}' }"`;
            const out = execSync(cmd).toString().trim();
            const obj = out ? JSON.parse(out) : {};
            const parentPid = Number(obj.ParentProcessId || 0);
            return {
                pid,
                parentPid: Number.isFinite(parentPid) ? parentPid : 0,
                name: String(obj.Name || ''),
                commandLine: String(obj.CommandLine || ''),
            };
        } catch {
            return { pid, parentPid: 0, name: '', commandLine: '' };
        }
    }
}

function isDevWatcherCommandLine(cmd) {
    const s = String(cmd || '').toLowerCase();
    return (
        s.includes('tsx') ||
        s.includes('watch') ||
        s.includes('vite') ||
        s.includes('concurrently') ||
        s.includes('server:dev') ||
        s.includes('client:dev') ||
        s.includes('npm run dev')
    );
}

function getUnixPidsForPort(port) {
    const pids = new Set();

    const tryAddPids = (text) => {
        String(text || '')
            .split(/\s+/)
            .map(s => s.trim())
            .filter(Boolean)
            .forEach((s) => {
                const n = Number(s.replace(/[^0-9]/g, ''));
                if (Number.isFinite(n) && n > 0) pids.add(n);
            });
    };

    try {
        const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).toString();
        tryAddPids(out);
        if (pids.size) return Array.from(pids);
    } catch {
    }

    try {
        const out = execSync(`fuser -n tcp ${port} 2>/dev/null`).toString();
        tryAddPids(out);
        if (pids.size) return Array.from(pids);
    } catch {
    }

    try {
        const out = execSync(`ss -ltnp 2>/dev/null | grep ":${port} " || true`).toString();
        const matches = out.match(/pid=([0-9]+)/g) || [];
        for (const m of matches) {
            const n = Number(m.replace(/[^0-9]/g, ''));
            if (Number.isFinite(n) && n > 0) pids.add(n);
        }
        if (pids.size) return Array.from(pids);
    } catch {
    }

    try {
        const out = execSync(`netstat -ltnp 2>/dev/null | grep ":${port} " || true`).toString();
        const pidMatches = out.match(/\s([0-9]+)\//g) || [];
        for (const m of pidMatches) {
            const n = Number(m.replace(/[^0-9]/g, ''));
            if (Number.isFinite(n) && n > 0) pids.add(n);
        }
        if (pids.size) return Array.from(pids);
    } catch {
    }

    return Array.from(pids);
}

// Helper to kill process by port
function killPort(port) {
    try {
        if (process.platform === 'win32') {
            const pids = getWindowsPidsForPort(port);
            for (const pid of pids) {
                try {
                    console.log(`[Reboot] Killing process ${pid} on port ${port}...`);
                    execSync(`taskkill /F /T /PID ${pid}`);
                } catch {
                    // Ignore if already dead
                }

                try {
                    const info = getWindowsProcessInfo(pid);
                    if (info.parentPid && info.parentPid > 0) {
                        const parent = getWindowsProcessInfo(info.parentPid);
                        if (isDevWatcherCommandLine(parent.commandLine)) {
                            console.log(`[Reboot] Killing dev watcher parent ${parent.pid} for port ${port}...`);
                            execSync(`taskkill /F /T /PID ${parent.pid}`);
                        }
                    }
                } catch {
                }
            }
        } else {
            const pids = getUnixPidsForPort(port);
            pids.forEach(pid => {
                try {
                    console.log(`[Reboot] Killing process ${pid} on port ${port}...`);
                    process.kill(Number(pid), 'SIGKILL');
                } catch (e) { }
            });
        }
    } catch (e) {
        // Findstr/lsof might throw if no matches, which is fine
    }
}

function portHasProcess(port) {
    try {
        if (process.platform === 'win32') {
            return getWindowsPidsForPort(port).length > 0;
        }

        return getUnixPidsForPort(port).length > 0;
    } catch {
        return false;
    }
}

async function waitForPortsFree(portsToWait) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const busy = portsToWait.filter(p => portHasProcess(p));
        if (busy.length === 0) return true;
        busy.forEach(p => killPort(p));
        await sleep(pollIntervalMs);
    }
    return false;
}

async function waitForHealth(url) {
    if (!url) return true;

    const fetchFn = globalThis.fetch;
    if (typeof fetchFn !== 'function') return true;

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 2000);
            const res = await fetchFn(url, { signal: controller.signal });
            clearTimeout(t);
            if (res && res.ok) return true;
        } catch {
        }
        await sleep(pollIntervalMs);
    }

    return false;
}

async function main() {
    // 1. Kill ports (best-effort)
    ports.forEach(port => killPort(port));

    // 2. Wait for ports to be free (no magic sleeps)
    const freed = await waitForPortsFree(ports);
    if (!freed) {
        console.error(`[Reboot] Timeout waiting for ports to be free: ${ports.join(', ')}`);
    }

    // 3. Start new process
    console.log('[Reboot] Spawning new process...');
    const child = spawn(restartCmd, {
        shell: true,
        detached: true,
        stdio: 'ignore'
    });
    child.unref();

    // 4. Optionally wait for health
    if (healthUrl) {
        const ok = await waitForHealth(healthUrl);
        if (!ok) {
            console.error(`[Reboot] Timeout waiting for health: ${healthUrl}`);
        } else {
            console.log('[Reboot] Health check OK.');
        }
    }

    process.exit(0);
}

main().catch((e) => {
    console.error('[Reboot] Fatal error:', e && e.message ? e.message : e);
    process.exit(1);
});
