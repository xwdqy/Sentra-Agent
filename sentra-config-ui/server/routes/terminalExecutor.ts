import type { FastifyInstance } from 'fastify';
import { terminalExecutorManager, type ShellType } from '../terminalExecutorManager';

function parseCursor(v: any) {
  const n = Number.parseInt(String(v ?? '0'), 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function sendJson(conn: any, payload: any) {
  try {
    conn.socket.send(JSON.stringify(payload));
  } catch {
    // ignore
  }
}

export async function terminalExecutorRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: { shellType?: ShellType; cols?: number; rows?: number };
  }>('/api/terminal-executor/create', async (request, reply) => {
    const shellType = (String(request.body?.shellType || 'powershell').trim().toLowerCase() || 'powershell') as ShellType;
    const cols = Number(request.body?.cols);
    const rows = Number(request.body?.rows);

    try {
      const s = terminalExecutorManager.createSession({
        shellType,
        cols: Number.isFinite(cols) ? cols : undefined,
        rows: Number.isFinite(rows) ? rows : undefined,
      });
      return { success: true, sessionId: s.id };
    } catch (error) {
      reply.code(500).send({
        success: false,
        error: 'Failed to create terminal executor session',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  fastify.get<{
    Params: { id: string };
  }>('/api/terminal-executor/status/:id', async (request, reply) => {
    const id = String(request.params?.id || '');
    const s = terminalExecutorManager.getSession(id);
    if (!s) return reply.code(404).send({ error: 'Session not found' });
    return {
      id: s.id,
      exited: s.exited,
      exitCode: s.exitCode,
      signal: s.exitSignal,
      cursor: s.totalCursor,
      createdAt: s.createdAt,
      lastClientAt: s.lastClientAt,
      clients: s.clients,
    };
  });

  fastify.post<{
    Params: { id: string };
  }>('/api/terminal-executor/close/:id', async (request, reply) => {
    const id = String(request.params?.id || '');
    const ok = terminalExecutorManager.closeSession(id);
    if (!ok) return reply.code(404).send({ success: false, error: 'Session not found' });
    return { success: true };
  });

  fastify.get(
    '/api/terminal-executor/ws/:id',
    ({ websocket: true } as any),
    (connection: any, req: any) => {
      const id = String((req?.params as any)?.id || '');
      const s = terminalExecutorManager.getSession(id);
      if (!s) {
        sendJson(connection, { type: 'error', message: 'Session not found' });
        try { (connection.socket as any)?.close?.(); } catch { }
        return;
      }

      terminalExecutorManager.onClientConnected(id);

      const cursor = parseCursor((req?.query as any)?.cursor);
      const start = Math.max(s.bufferBaseCursor, Math.min(s.totalCursor, cursor));
      const sliceIndex = Math.max(0, start - s.bufferBaseCursor);
      const initial = s.buffer.slice(sliceIndex);

      sendJson(connection, {
        type: 'init',
        data: initial,
        baseCursor: s.bufferBaseCursor,
        cursor: s.totalCursor,
        exited: s.exited,
        exitCode: s.exitCode,
        signal: s.exitSignal,
      });

      let pending = '';
      let flushTimer: NodeJS.Timeout | null = null;
      const MAX_WS_BUFFERED = 4_000_000;

      const flushNow = () => {
        if (!pending) return;
        const sock: any = connection?.socket;
        if (sock && typeof sock.bufferedAmount === 'number' && sock.bufferedAmount > MAX_WS_BUFFERED) {
          pending = '';
          try { sock.close?.(); } catch { }
          return;
        }
        const data = pending;
        pending = '';
        sendJson(connection, { type: 'data', data, cursor: s.totalCursor });
      };

      const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flushNow();
        }, 20);
      };

      const onData = (d: string) => {
        if (!d) return;
        pending += d;
        if (pending.length >= 32_000) {
          flushNow();
          return;
        }
        scheduleFlush();
      };
      const onExit = (ev: any) => {
        if (flushTimer) {
          try { clearTimeout(flushTimer); } catch { }
          flushTimer = null;
        }
        try { flushNow(); } catch { }
        sendJson(connection, { type: 'exit', cursor: s.totalCursor, exitCode: ev?.exitCode ?? s.exitCode, signal: ev?.signal ?? s.exitSignal });
      };

      s.emitter.on('data', onData);
      s.emitter.on('exit', onExit);

      connection.socket.on('message', (raw: any) => {
        let msg: any;
        try {
          msg = JSON.parse(String(raw || ''));
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'input') {
          const data = String(msg.data ?? '');
          if (!data) return;
          try {
            s.pty.write(data);
          } catch { }
          return;
        }

        if (msg.type === 'resize') {
          const cols = Number(msg.cols);
          const rows = Number(msg.rows);
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
          try {
            s.pty.resize(Math.max(20, Math.min(400, cols)), Math.max(5, Math.min(200, rows)));
          } catch { }
          return;
        }

        if (msg.type === 'ping') {
          sendJson(connection, { type: 'pong', cursor: s.totalCursor });
        }
      });

      connection.socket.on('close', () => {
        if (flushTimer) {
          try { clearTimeout(flushTimer); } catch { }
          flushTimer = null;
        }
        try {
          s.emitter.off('data', onData);
          s.emitter.off('exit', onExit);
        } catch { }
        terminalExecutorManager.onClientDisconnected(id);
      });
    }
  );
}
