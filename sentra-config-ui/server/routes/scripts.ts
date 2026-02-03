import { FastifyInstance } from 'fastify';
import { scriptRunner } from '../scriptRunner';

export async function scriptRoutes(fastify: FastifyInstance) {
    // Execute bootstrap script
    fastify.post<{
        Body: { args?: string[] };
    }>('/api/scripts/bootstrap', async (request, reply) => {
        try {
            const { args = [] } = request.body || {};
            const processId = scriptRunner.executeScript('bootstrap', args);

            return { success: true, processId };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to execute bootstrap script',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    fastify.post<{
        Body: { args?: string[] };
    }>('/api/scripts/shell', async (request, reply) => {
        try {
            const { args = [] } = request.body || {};
            const processId = scriptRunner.executeShell(args);
            return { success: true, processId };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to execute shell',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Execute start script
    fastify.post<{
        Body: { args?: string[] };
    }>('/api/scripts/start', async (request, reply) => {
        try {
            const { args = [] } = request.body || {};
            const processId = scriptRunner.executeScript('start', args);

            return { success: true, processId };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to execute start script',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Execute napcat script (supports args: ['build'] or ['start'])
    fastify.post<{
        Body: { args?: string[] };
    }>('/api/scripts/napcat', async (request, reply) => {
        try {
            const { args = ['start'] } = request.body || {};
            const processId = scriptRunner.executeScript('napcat', args);

            return { success: true, processId };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to execute napcat script',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Execute update script (supports args: [] (normal) or ['force'] (force update))
    fastify.post<{
        Body: { args?: string[] };
    }>('/api/scripts/update', async (request, reply) => {
        try {
            const { args = [] } = request.body || {};
            const processId = scriptRunner.executeScript('update', args);

            return { success: true, processId };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to execute update script',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Execute sentiment analysis script
    fastify.post<{
        Body: { args?: string[] };
    }>('/api/scripts/sentiment', async (request, reply) => {
        try {
            const { args = [] } = request.body || {};
            const processId = scriptRunner.executeScript('sentiment', args);

            return { success: true, processId };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to execute sentiment script',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Get script status
    fastify.get<{
        Params: { id: string };
    }>('/api/scripts/status/:id', async (request, reply) => {
        const { id } = request.params;
        const process = scriptRunner.getProcess(id);

        if (!process) {
            return reply.code(404).send({ error: 'Process not found' });
        }

        return {
            id: process.id,
            exitCode: process.exitCode,
            startTime: process.startTime,
            endTime: process.endTime,
            baseCursor: (process as any).outputBaseCursor ?? 0,
            cursor: (process as any).totalCursor ?? (Array.isArray(process.output) ? process.output.length : 0),
            output: process.output,
        };
    });

    // Stream script output via Server-Sent Events
    fastify.get<{
        Params: { id: string };
        Querystring: { cursor?: string };
    }>('/api/scripts/stream/:id', async (request, reply) => {
        const { id } = request.params;
        const process = scriptRunner.getProcess(id);

        if (!process) {
            return reply.code(404).send({ error: 'Process not found' });
        }

        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        });

        if (typeof (reply.raw as any).flushHeaders === 'function') {
            try { (reply.raw as any).flushHeaders(); } catch { }
        }

        // Kick-start the SSE stream with an initial comment to open the pipe immediately
        reply.raw.write(`: stream-open\n\n`);

        let pending = '';
        let flushTimer: NodeJS.Timeout | null = null;
        let paused = false;

        const flushNow = () => {
            if (paused) return;
            if (!pending) return;
            const chunk = pending;
            pending = '';
            try {
                const ok = reply.raw.write(chunk);
                if (!ok) {
                    paused = true;
                    try {
                        reply.raw.once('drain', () => {
                            paused = false;
                            flushNow();
                        });
                    } catch { }
                }
            } catch { }
        };

        const scheduleFlush = () => {
            if (flushTimer) return;
            flushTimer = setTimeout(() => {
                flushTimer = null;
                flushNow();
            }, 20);
        };

        const queueFrame = (frame: string) => {
            if (!frame) return;
            pending += frame;
            if (pending.length >= 64_000) {
                flushNow();
                return;
            }
            scheduleFlush();
        };

        // Heartbeat to keep the connection alive and help certain renderers repaint timely
        const heartbeat = setInterval(() => {
            try {
                reply.raw.write(`event: ping\n` + `data: {}\n\n`);
            } catch { }
        }, 15000);

        const rawCursor = request.query?.cursor;
        const cursorAbs = Number.parseInt(String(rawCursor ?? '0'), 10);
        const clientCursor = Number.isFinite(cursorAbs) ? Math.max(0, cursorAbs) : 0;

        const baseCursor = Number((process as any).outputBaseCursor ?? 0);
        const totalCursor = Number((process as any).totalCursor ?? (Array.isArray(process.output) ? process.output.length : 0));
        const startCursor = Math.max(baseCursor, Math.min(totalCursor, clientCursor));
        const sliceIndex = Math.max(0, startCursor - baseCursor);

        queueFrame(`data: ${JSON.stringify({ type: 'init', baseCursor, cursor: totalCursor })}\n\n`);

        // Send existing output
        for (let i = sliceIndex; i < process.output.length; i += 1) {
            const line = process.output[i];
            const c = baseCursor + i + 1;
            queueFrame(`data: ${JSON.stringify({ type: 'output', stream: 'replay', data: line, cursor: c })}\n\n`);
        }
        flushNow();

        // Subscribe to new output
        const unsubscribeOutput = scriptRunner.subscribeToOutput(id, (data) => {
            // Do not spread to avoid overriding the top-level 'type'.
            // Normalize into { type: 'output', stream: 'stdout'|'stderr', data: string }
            const payload = { type: 'output', stream: data.type, data: data.data, cursor: (data as any).cursor };
            queueFrame(`data: ${JSON.stringify(payload)}\n\n`);
        });

        const unsubscribeExit = scriptRunner.subscribeToExit(id, (data) => {
            try {
                queueFrame(`data: ${JSON.stringify({ type: 'exit', ...data, cursor: totalCursor })}\n\n`);
                flushNow();
                if (typeof (reply.raw as any).flush === 'function') {
                    try { (reply.raw as any).flush(); } catch { }
                }
            } finally {
                clearInterval(heartbeat);
                if (flushTimer) {
                    try { clearTimeout(flushTimer); } catch { }
                    flushTimer = null;
                }
                setTimeout(() => {
                    try { reply.raw.end(); } catch { }
                }, 30);
            }
        });

        request.raw.on('close', () => {
            if (unsubscribeOutput) unsubscribeOutput();
            if (unsubscribeExit) unsubscribeExit();
            clearInterval(heartbeat);
            if (flushTimer) {
                try { clearTimeout(flushTimer); } catch { }
                flushTimer = null;
            }
        });
    });

    // Kill script process
    fastify.post<{
        Params: { id: string };
    }>('/api/scripts/kill/:id', async (request) => {
        const { id } = request.params;
        const result = scriptRunner.killProcess(id);

        if (!result.success) {
            return { success: false, message: result.message, pm2: result.pm2 };
        }

        return { success: true, message: result.message, pm2: result.pm2 };
    });
    // Send input to script process
    fastify.post<{
        Params: { id: string };
        Body: { data: string };
    }>('/api/scripts/input/:id', async (request, reply) => {
        const { id } = request.params;
        const { data } = request.body || {};

        const success = scriptRunner.writeInput(id, data);

        if (!success) {
            return reply.code(400).send({ error: 'Failed to write input (process not found or exited)' });
        }

        return { success: true };
    });
}
