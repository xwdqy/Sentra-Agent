import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { FormattedMessage, StreamEnvelope } from './QqSandbox.types';
import { useQqRpcTimeoutSweep } from './useQqRpcTimeoutSweep';
import { useQqWsPageLifecycle } from './useQqWsPageLifecycle';

export type QqWsStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

type PendingRpcEntry = {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  ts: number;
};

type AntdMessageLike = {
  success: (content: any) => void;
  error: (content: any) => void;
};

export function useQqWsConnection(opts: {
  token: string;
  streamPort: number;
  defaultStreamPort: number;
  fetchSandboxConfig: () => Promise<any>;
  antdMessage: AntdMessageLike;
  setStatus: Dispatch<SetStateAction<QqWsStatus>>;
  setStatusText: Dispatch<SetStateAction<string>>;
  setProxyDiag: Dispatch<SetStateAction<string>>;
  onFormattedMessageRef: MutableRefObject<null | ((m: FormattedMessage) => void)>;
  onManualDisconnectCleanup?: () => void;
}) {
  const {
    token,
    streamPort,
    defaultStreamPort,
    fetchSandboxConfig,
    antdMessage,
    setStatus,
    setStatusText,
    setProxyDiag,
    onFormattedMessageRef,
    onManualDisconnectCleanup,
  } = opts;

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRpcRef = useRef(new Map<string, PendingRpcEntry>());

  const [connectBusy, setConnectBusy] = useState(false);

  const connectToastedRef = useRef(false);
  const wantConnectedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectRef = useRef<null | (() => WebSocket | null)>(null);
  const attemptConnectRef = useRef<null | ((why: string) => void)>(null);
  const autoConnectStartedRef = useRef(false);
  const connectPortOverrideRef = useRef(0);
  const unloadingRef = useRef(false);

  useQqWsPageLifecycle({
    unloadingRef,
    wantConnectedRef,
    wsRef,
    attemptConnectRef,
  });

  useQqRpcTimeoutSweep({ pendingRpcRef });

  const scheduleReconnect = useCallback((why: string) => {
    if (!wantConnectedRef.current) return;
    if (unloadingRef.current) return;
    try {
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    } catch {
    }
    reconnectTimerRef.current = null;

    reconnectAttemptRef.current += 1;
    const attempt = reconnectAttemptRef.current;
    const base = 650;
    const max = 12_000;
    const jitter = Math.floor(Math.random() * 220);
    const wait = Math.min(max, Math.floor(base * Math.pow(1.8, Math.max(0, attempt - 1))) + jitter);
    setStatus('connecting');
    setStatusText(`重连中(${attempt}) · ${why} · ${Math.ceil(wait / 1000)}秒`);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      try {
        attemptConnectRef.current?.('重连');
      } catch {
      }
    }, wait);
  }, [setStatus, setStatusText]);

  const connect = useCallback(() => {
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;

    setStatus('connecting');
    setStatusText('连接中...');

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const u = new URL(`${scheme}//${window.location.host}/api/qq/sandbox/ws`);
    u.searchParams.set('token', token || '');
    const portOverride = Number(connectPortOverrideRef.current || 0);
    const p = (Number.isFinite(portOverride) && portOverride > 0)
      ? Math.trunc(portOverride)
      : (Number.isFinite(streamPort) && streamPort > 0 ? streamPort : (defaultStreamPort || 6702));
    u.searchParams.set('port', String(p));

    const ws = new WebSocket(u.toString());
    try {
      (ws as any).binaryType = 'arraybuffer';
    } catch {
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connecting');
      setStatusText('连接中...');
    };

    ws.onclose = (ev: any) => {
      try {
        if (wsRef.current === ws) wsRef.current = null;
      } catch {
      }
      setStatus('disconnected');
      const code = ev?.code;
      const reason = String(ev?.reason || '').trim();
      const suffix = (code != null || reason) ? ` (${code != null ? String(code) : ''}${reason ? ` ${reason}` : ''})` : '';
      setStatusText(`已断开${suffix}`.trim());
      try {
        if (connectToastedRef.current && !unloadingRef.current) {
          antdMessage.error('连接断开');
        }
      } catch {
      }
      try {
        setConnectBusy(false);
        connectToastedRef.current = false;
      } catch {
      }

      scheduleReconnect(`close${code != null ? `:${code}` : ''}`);
    };

    ws.onerror = () => {
      try {
        if (wsRef.current === ws) wsRef.current = null;
      } catch {
      }
      setStatus('error');
      setStatusText('连接错误');
      try {
        if (connectToastedRef.current && !unloadingRef.current) {
          antdMessage.error('连接失败');
        }
      } catch {
      }
      try {
        setConnectBusy(false);
        connectToastedRef.current = false;
      } catch {
      }

      scheduleReconnect('ws_error');
    };

    const handleIncomingText = (rawText: string) => {
      let msg: StreamEnvelope | null = null;
      try {
        msg = JSON.parse(String(rawText || ''));
      } catch {
        msg = null;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'welcome') {
        setStatus('connected');
        setStatusText('已连接');
        try {
          if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
        } catch {
        }
        reconnectTimerRef.current = null;
        reconnectAttemptRef.current = 0;
        connectPortOverrideRef.current = 0;
        try {
          if (connectToastedRef.current) antdMessage.success('连接成功');
        } catch {
        }
        try {
          setConnectBusy(false);
          connectToastedRef.current = false;
        } catch {
        }
        return;
      }

      if (msg.type === 'proxy') {
        const evName = String((msg as any)?.event || '').trim();
        const code = (msg as any)?.code;
        const reason = String((msg as any)?.reason || '').trim();
        const suffix = (code != null || reason) ? ` (${code != null ? String(code) : ''}${reason ? ` ${reason}` : ''})` : '';
        if (evName) {
          const cn = evName === 'upstream_open'
            ? '上游已连接'
            : evName === 'upstream_close'
              ? '上游已断开'
              : evName === 'upstream_error'
                ? '上游错误'
                : evName === 'client_close'
                  ? '客户端关闭'
                  : evName === 'client_error'
                    ? '客户端错误'
                    : evName;
          setProxyDiag(`${cn}${suffix}`.trim());
        }

        if (evName === 'upstream_open') {
          setStatus('connected');
          setStatusText('已连接');
          try {
            if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
          } catch {
          }
          reconnectTimerRef.current = null;
          reconnectAttemptRef.current = 0;
          try {
            if (connectToastedRef.current) antdMessage.success('连接成功');
          } catch {
          }
          try {
            setConnectBusy(false);
            connectToastedRef.current = false;
          } catch {
          }
        } else if (evName === 'upstream_close' || evName === 'upstream_error') {
          setStatus('error');
          setStatusText(`${evName === 'upstream_close' ? '上游断开' : '上游错误'}${suffix}`.trim());
          try {
            if (connectToastedRef.current) antdMessage.error(`连接失败: ${evName}`);
          } catch {
          }
          try {
            setConnectBusy(false);
            connectToastedRef.current = false;
          } catch {
          }

          scheduleReconnect(evName);
        }
        return;
      }

      if (msg.type === 'disconnect') {
        setStatus('disconnected');
        const raw = String((msg as any).message || '').trim();
        const text = (() => {
          if (!raw) return '已断开';
          if (raw.startsWith('upstream_closed:')) {
            const rest = raw.replace(/^upstream_closed:/, '');
            const parts = rest.split(':');
            const c = parts.length ? parts[0] : '';
            const r = parts.slice(1).join(':');
            const suffix2 = `${c ? ` (${c}${r ? ` ${r}` : ''})` : ''}`.trim();
            return `上游已断开${suffix2}`.trim();
          }
          if (raw.startsWith('upstream_connect_timeout')) return '上游连接超时';
          if (raw.startsWith('upstream_')) return `上游断开：${raw}`;
          return raw;
        })();
        setStatusText(text);
        connectPortOverrideRef.current = 0;
        try {
          if (connectToastedRef.current) antdMessage.error('连接断开');
        } catch {
        }
        try {
          setConnectBusy(false);
          connectToastedRef.current = false;
        } catch {
        }

        scheduleReconnect('disconnect');
        return;
      }

      if (msg.type === 'error') {
        setStatus('error');
        setStatusText(String((msg as any).message || '连接错误'));
        connectPortOverrideRef.current = 0;
        try {
          if (connectToastedRef.current) antdMessage.error(String((msg as any).message || '连接失败'));
        } catch {
        }
        try {
          setConnectBusy(false);
          connectToastedRef.current = false;
        } catch {
        }
        return;
      }

      if (msg.type === 'result') {
        const requestId = String((msg as any).requestId || '');
        const pend = pendingRpcRef.current.get(requestId);
        if (pend) {
          pendingRpcRef.current.delete(requestId);
          if ((msg as any).ok) pend.resolve((msg as any).data);
          else pend.reject(new Error(String((msg as any).error || 'rpc_failed')));
        }
        return;
      }

      if (msg.type === 'message' && (msg as any).data) {
        try {
          onFormattedMessageRef.current?.((msg as any).data as FormattedMessage);
        } catch {
        }
        return;
      }

      return;
    };

    ws.onmessage = (ev) => {
      const d: any = (ev as any)?.data;
      if (typeof d === 'string') {
        handleIncomingText(d);
        return;
      }
      if (d instanceof ArrayBuffer) {
        try {
          const text = new TextDecoder('utf-8').decode(new Uint8Array(d));
          handleIncomingText(text);
        } catch {
        }
        return;
      }
      if (typeof Blob !== 'undefined' && d instanceof Blob) {
        d.text().then((t: string) => handleIncomingText(t)).catch(() => { });
        return;
      }
      try {
        handleIncomingText(String(d || ''));
      } catch {
      }
    };

    return ws;
  }, [antdMessage, defaultStreamPort, onFormattedMessageRef, scheduleReconnect, setProxyDiag, setStatus, setStatusText, streamPort, token]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const attemptConnect = useCallback(async (why: string, attemptOpts?: { toast?: boolean; allowSchedule?: boolean }) => {
    if (unloadingRef.current) return;
    const toast = !!attemptOpts?.toast;
    const allowSchedule = attemptOpts?.allowSchedule !== false;

    const headers: Record<string, string> = {};
    if (token) headers['x-auth-token'] = token;

    setStatus('connecting');
    setStatusText(why ? `${why} · 预检中...` : '预检中...');

    let cfg: any = null;
    try {
      cfg = await fetchSandboxConfig();
    } catch {
      cfg = null;
    }

    const p = Number.isFinite(streamPort) && streamPort > 0
      ? Math.trunc(streamPort)
      : (Number(cfg?.streamPort || 0) > 0 ? Math.trunc(Number(cfg?.streamPort || 0)) : (defaultStreamPort || 6702));

    try {
      const u = new URL(`${window.location.origin}/api/qq/sandbox/health`);
      u.searchParams.set('port', String(p));
      const r = await fetch(u.toString(), { headers });
      const h: any = r.ok ? await r.json() : null;
      if (!h?.ok) throw new Error(String(h?.error || 'health_failed'));
    } catch {
      setStatus('error');
      setStatusText('连接失败（预检未通过）');
      try {
        if (toast && !unloadingRef.current) antdMessage.error('连接失败');
      } catch {
      }
      if (allowSchedule) scheduleReconnect('预检失败');
      return;
    }

    connectPortOverrideRef.current = p;
    connectRef.current?.();
  }, [antdMessage, defaultStreamPort, fetchSandboxConfig, scheduleReconnect, setStatus, setStatusText, streamPort, token]);

  useEffect(() => {
    attemptConnectRef.current = (why: string) => {
      void attemptConnect(why, { toast: false, allowSchedule: true });
    };
  }, [attemptConnect]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await fetchSandboxConfig();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchSandboxConfig]);

  useEffect(() => {
    return () => {
      try {
        if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      } catch {
      }
      reconnectTimerRef.current = null;
      reconnectAttemptRef.current = 0;
      try {
        wsRef.current?.close();
      } catch {
      }
    };
  }, []);

  const disconnect = useCallback(() => {
    wantConnectedRef.current = false;
    try {
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    } catch {
    }
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    connectPortOverrideRef.current = 0;
    try {
      wsRef.current?.close();
    } catch {
    }
    wsRef.current = null;
    setStatus('disconnected');
    setStatusText('已断开');

    try {
      onManualDisconnectCleanup?.();
    } catch {
    }

    try {
      if (connectBusy) setConnectBusy(false);
    } catch {
    }
  }, [connectBusy, onManualDisconnectCleanup, setStatus, setStatusText]);

  const connectAndWait = useCallback(async () => {
    if (connectBusy) return;
    wantConnectedRef.current = true;
    connectToastedRef.current = true;
    setConnectBusy(true);
    void attemptConnect('连接', { toast: true, allowSchedule: true });
  }, [attemptConnect, connectBusy]);

  useEffect(() => {
    if (autoConnectStartedRef.current) return;
    autoConnectStartedRef.current = true;
    wantConnectedRef.current = true;
    connectToastedRef.current = false;
    void attemptConnect('自动连接', { toast: false, allowSchedule: true });
  }, [attemptConnect]);

  const rpc = useCallback((payload: any): Promise<any> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('ws_not_connected'));
    }
    const requestId = `rq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const msg = { ...payload, requestId };
    return new Promise((resolve, reject) => {
      pendingRpcRef.current.set(requestId, { resolve, reject, ts: Date.now() });
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        pendingRpcRef.current.delete(requestId);
        reject(e);
      }
    });
  }, []);

  return {
    wsRef,
    connectBusy,
    connectAndWait,
    disconnect,
    rpc,
    wantConnectedRef,
    unloadingRef,
  };
}
