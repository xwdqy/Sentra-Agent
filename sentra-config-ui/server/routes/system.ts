
import { FastifyInstance } from 'fastify';
import { spawn } from 'child_process';
import path from 'path';

export async function systemRoutes(fastify: FastifyInstance) {
    fastify.post('/api/system/restart', async (request, reply) => {
        const clientPort = process.env.CLIENT_PORT || '7244';
        const serverPort = process.env.SERVER_PORT || '7245';

        // Determine how we were started to know how to restart
        // 'npm run dev' -> 'npm run dev'
        // 'npm run service:start' -> 'npm run service:start'
        // Default fallback to 'npm run dev' if unknown
        let restartCmd = 'npm run dev';

        // npm sets npm_lifecycle_event to the script name (e.g., 'dev', 'server:dev', 'start')
        const lifecycleEvent = process.env.npm_lifecycle_event;

        if (lifecycleEvent === 'service:start' || process.env.NODE_ENV === 'production') {
            restartCmd = 'npm run service:start';
        }

        const scriptPath = path.resolve(process.cwd(), 'scripts', 'reboot.mjs');
        const ports = `${clientPort},${serverPort}`;

        fastify.log.warn(`[System] Initiating restart... Ports: ${ports}, Cmd: ${restartCmd}`);

        // Spawn reboot script detached
        const child = spawn('node', [scriptPath, `--ports=${ports}`, `--cmd="${restartCmd}"`], {
            detached: true,
            stdio: 'ignore'
        });

        child.unref();

        reply.send({ success: true, message: 'System restarting...' });

        // Give time for the response to generally flush
        setTimeout(() => {
            process.exit(0);
        }, 500);
    });
}
