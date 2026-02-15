import WebSocket from 'ws';
import { EventEmitter } from 'events';

type WebSocketClientOptions = {
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  getReconnectIntervalMs?: () => number;
  getMaxReconnectAttempts?: () => number;
};

type ClientEvent =
  | 'open'
  | 'message'
  | 'error'
  | 'close'
  | 'reconnect_exhausted'
  | 'warn';

type ClientEventHandler = (payload?: unknown) => void;

type WebSocketClient = {
  on: (event: ClientEvent, handler: ClientEventHandler) => void;
  off: (event: ClientEvent, handler: ClientEventHandler) => void;
  send: (obj: unknown) => boolean;
  isConnected: () => boolean;
  getRetryCount: () => number;
  getWebSocket: () => WebSocket | null;
  close: () => void;
};

export function createWebSocketClient(url: string, options: WebSocketClientOptions = {}): WebSocketClient {
  function getReconnectIntervalMs() {
    try {
      const raw = typeof options.getReconnectIntervalMs === 'function'
        ? options.getReconnectIntervalMs()
        : options.reconnectIntervalMs;
      const v = Number(raw ?? 10000);
      return Number.isFinite(v) && v > 0 ? v : 10000;
    } catch {
      return 10000;
    }
  }

  function getMaxReconnectAttempts() {
    try {
      const raw = typeof options.getMaxReconnectAttempts === 'function'
        ? options.getMaxReconnectAttempts()
        : options.maxReconnectAttempts;
      const v = Number(raw ?? 60);
      return Number.isFinite(v) && v >= 0 ? v : 60;
    } catch {
      return 60;
    }
  }

  const emitter = new EventEmitter();
  let ws: WebSocket | null = null;
  let attempts = 0;
  let closedManually = false;

  function connect() {
    if (closedManually) return;
    try {
      ws = new WebSocket(url);

      ws.on('open', () => {
        attempts = 0;
        emitter.emit('open');
      });

      ws.on('message', (data) => {
        emitter.emit('message', data);
      });

      ws.on('error', (err) => {
        emitter.emit('error', err);
      });

      ws.on('close', () => {
        emitter.emit('close');
        if (closedManually) return;
        const maxReconnectAttempts = getMaxReconnectAttempts();
        if (attempts >= maxReconnectAttempts) {
          emitter.emit('reconnect_exhausted');
          return;
        }
        attempts += 1;
        const reconnectIntervalMs = getReconnectIntervalMs();
        setTimeout(connect, reconnectIntervalMs);
      });
    } catch (e) {
      emitter.emit('error', e);
      if (!closedManually) {
        const maxReconnectAttempts = getMaxReconnectAttempts();
        if (attempts < maxReconnectAttempts) {
          attempts += 1;
          const reconnectIntervalMs = getReconnectIntervalMs();
          setTimeout(connect, reconnectIntervalMs);
        } else {
          emitter.emit('reconnect_exhausted');
        }
      }
    }
  }

  connect();

  function on(event: ClientEvent, handler: ClientEventHandler) {
    emitter.on(event, handler);
  }

  function off(event: ClientEvent, handler: ClientEventHandler) {
    if (emitter.off) emitter.off(event, handler);
    else emitter.removeListener(event, handler);
  }

  function send(obj: unknown) {
    try {
      const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(text);
        return true;
      }
      emitter.emit('warn', new Error('WebSocket not connected'));
      return false;
    } catch (e) {
      emitter.emit('error', e);
      return false;
    }
  }

  function isConnected() {
    return !!(ws && ws.readyState === WebSocket.OPEN);
  }

  function getRetryCount() {
    return attempts;
  }

  function getWebSocket() {
    return ws;
  }

  function close() {
    closedManually = true;
    try { ws && ws.close(); } catch {}
  }

  return { on, off, send, isConnected, getRetryCount, getWebSocket, close };
}
