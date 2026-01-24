
import { FastifyInstance } from 'fastify';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import https from 'https';

function fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                raw += String(chunk || '');
            });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(raw || '{}');
                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => {
            try { req.destroy(new Error('timeout')); } catch { }
        });
    });
}

export async function systemRoutes(fastify: FastifyInstance) {
    fastify.get('/api/system/network', async (_request, reply) => {
        const clientPort = process.env.CLIENT_PORT || '7244';
        const serverPort = process.env.SERVER_PORT || '7245';

        const nets = os.networkInterfaces();
        const local: Array<{ name: string; address: string; family: string; internal: boolean; mac?: string; cidr?: string | null }> = [];
        for (const name of Object.keys(nets || {})) {
            const list = (nets as any)?.[name] as any[] | undefined;
            if (!Array.isArray(list)) continue;
            for (const n of list) {
                if (!n || typeof n !== 'object') continue;
                local.push({
                    name: String(name),
                    address: String(n.address || ''),
                    family: String(n.family || ''),
                    internal: !!n.internal,
                    mac: n.mac ? String(n.mac) : undefined,
                    cidr: typeof n.cidr === 'string' ? n.cidr : null,
                });
            }
        }

        let publicInfo: any = null;
        let publicError = '';
        try {
            publicInfo = await fetchJson('https://ipapi.co/json/');
        } catch (e) {
            publicError = e instanceof Error ? e.message : String(e);
        }

        reply.send({
            hostname: os.hostname(),
            serverPort,
            clientPort,
            local,
            public: publicInfo,
            publicError: publicError || undefined,
            fetchedAt: Date.now(),
        });
    });

    fastify.post('/api/system/restart', async (_request, reply) => {
        const clientPort = process.env.CLIENT_PORT || '7244';
        const serverPort = process.env.SERVER_PORT || '7245';

        const isPm2 = !!process.env.pm_id || !!process.env.PM2_HOME;

        const restartCmdOverride = (process.env.RESTART_CMD || '').trim();

        let scripts: Record<string, string> = {};
        try {
            const pkgPath = path.resolve(process.cwd(), 'package.json');
            const raw = fs.readFileSync(pkgPath, 'utf8');
            const pkg = JSON.parse(raw);
            scripts = (pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object') ? pkg.scripts : {};
        } catch {
        }

        const lifecycleEvent = (process.env.npm_lifecycle_event || '').trim();

        let restartScript = '';
        if (restartCmdOverride) {
            restartScript = '';
        } else if ((lifecycleEvent === 'server:dev' || lifecycleEvent === 'client:dev') && Object.prototype.hasOwnProperty.call(scripts, 'dev')) {
            restartScript = 'dev';
        } else if (lifecycleEvent && Object.prototype.hasOwnProperty.call(scripts, lifecycleEvent)) {
            restartScript = lifecycleEvent;
        } else if (process.env.NODE_ENV === 'production' && Object.prototype.hasOwnProperty.call(scripts, 'dist:start')) {
            restartScript = 'dist:start';
        } else if (Object.prototype.hasOwnProperty.call(scripts, 'dev')) {
            restartScript = 'dev';
        } else if (Object.prototype.hasOwnProperty.call(scripts, 'service:start')) {
            restartScript = 'service:start';
        }

        const restartCmd = restartCmdOverride || (restartScript ? `npm run ${restartScript}` : 'npm run dev');

        const isDevLike = restartScript === 'dev' || restartScript === 'server:dev' || restartScript === 'client:dev' || restartCmd.includes(' vite');
        const ports = isDevLike ? `${clientPort},${serverPort}` : `${serverPort}`;

        const scriptPath = path.resolve(process.cwd(), 'scripts', 'reboot.mjs');

        fastify.log.warn(`[System] Initiating restart... Ports: ${ports}, Cmd: ${restartCmd}`);

        if (isPm2) {
            reply.send({ success: true, message: 'System restarting...' });

            await new Promise<void>((resolve) => {
                if ((reply.raw as any)?.writableFinished) return resolve();
                try {
                    reply.raw.once('finish', () => resolve());
                } catch {
                    resolve();
                }
            });

            process.exit(0);
        }

        // Spawn reboot script detached
        const healthUrl = `http://127.0.0.1:${serverPort}/api/health`;
        const child = spawn('node', [
            scriptPath,
            '--ports',
            ports,
            '--cmd',
            restartCmd,
            '--health',
            healthUrl,
        ], {
            detached: true,
            stdio: 'ignore',
            windowsHide: process.platform === 'win32',
        });

        child.unref();

        reply.send({ success: true, message: 'System restarting...' });

        await new Promise<void>((resolve) => {
            if ((reply.raw as any)?.writableFinished) return resolve();
            try {
                reply.raw.once('finish', () => resolve());
            } catch {
                resolve();
            }
        });

        process.exit(0);
    });
}
