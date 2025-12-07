import { spawn, execSync, spawnSync } from 'child_process';
import os from 'os';

const args = process.argv.slice(2);
const portsArg = args.find(a => a.startsWith('--ports='));
const cmdArg = args.find(a => a.startsWith('--cmd='));

if (!portsArg || !cmdArg) {
    console.error('Usage: node reboot.mjs --ports=1234,5678 --cmd="npm run dev"');
    process.exit(1);
}

const ports = portsArg.split('=')[1].split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p));
const restartCmd = cmdArg.split('=')[1];

console.log('[Reboot] Starting reboot sequence...');
console.log(`[Reboot] Ports to clear: ${ports.join(', ')}`);
console.log(`[Reboot] Restart command: ${restartCmd}`);

// Helper to kill process by port
function killPort(port) {
    try {
        if (process.platform === 'win32') {
            const output = execSync(`netstat -ano | findstr :${port}`).toString();
            const lines = output.split('\n').filter(l => l.trim().length > 0);

            lines.forEach(line => {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0') {
                    try {
                        console.log(`[Reboot] Killing process ${pid} on port ${port}...`);
                        execSync(`taskkill /F /PID ${pid}`);
                    } catch (e) {
                        // Ignore if already dead
                    }
                }
            });
        } else {
            const output = execSync(`lsof -i :${port} -t`).toString();
            const pids = output.split('\n').filter(p => p.trim());
            pids.forEach(pid => {
                try {
                    console.log(`[Reboot] Killing process ${pid} on port ${port}...`);
                    process.kill(parseInt(pid), 'SIGKILL');
                } catch (e) { }
            });
        }
    } catch (e) {
        // Findstr/lsof might throw if no matches, which is fine
    }
}

// 1. Wait a moment for the parent process (the server calling this) to exit purely
setTimeout(() => {
    // 2. Kill Ports
    ports.forEach(port => killPort(port));

    // 3. Wait for ports to be free
    setTimeout(() => {
        // 4. Start new process
        console.log('[Reboot] Spawning new process...');
        const child = spawn(restartCmd, {
            shell: true,
            detached: true,
            stdio: 'ignore' // or 'inherit' if you want logs in a new independent window
        });

        child.unref();
        process.exit(0);

    }, 2000);

}, 1000);
