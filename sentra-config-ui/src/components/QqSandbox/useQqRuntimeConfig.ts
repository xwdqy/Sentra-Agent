import { useEffect, useRef, useState } from 'react';
import { storage } from '../../utils/storage';

export type QqLimits = {
  maxActiveMessages: number;
  maxInactiveMessages: number;
  persistMaxConversations: number;
  persistMaxMessages: number;
  renderPageSize: number;
  renderPageStep: number;
};

function pickNestedNumber(obj: any, path: Array<string>, fallback: number): number {
  try {
    let cur = obj;
    for (const k of path) {
      if (!cur || typeof cur !== 'object') return fallback;
      cur = cur[k];
    }
    const n = Number(cur);
    if (Number.isFinite(n)) return n;
  } catch {
  }
  return fallback;
}

export function useQqRuntimeConfig() {
  const [uiRuntimeConfig, setUiRuntimeConfig] = useState<Record<string, any>>({});
  const [uiRuntimeConfigVer, setUiRuntimeConfigVer] = useState(0);

  const qqLimitsRef = useRef<QqLimits>({
    maxActiveMessages: 200,
    maxInactiveMessages: 20,
    persistMaxConversations: 30,
    persistMaxMessages: 50,
    renderPageSize: 120,
    renderPageStep: 120,
  });

  // Use SSE for real-time config updates - no more polling!
  useEffect(() => {
    let disposed = false;
    let es: EventSource | null = null;
    let reconnectTimer: number | null = null;

    const connectSse = () => {
      if (disposed) return;
      // Get auth token for SSE connection
      const token = storage.getString('sentra_auth_token', { backend: 'session', fallback: '' }) ||
        storage.getString('sentra_auth_token', { backend: 'local', fallback: '' });
      if (!token) {
        if (!reconnectTimer) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            if (disposed) return;
            connectSse();
          }, 800);
        }
        return;
      }
      const url = `/api/configs/stream?token=${encodeURIComponent(token || '')}`;
      es = new EventSource(url);

      es.onopen = () => {
        reconnectTimer = null; // Connected, clear reconnect timer
      };

      es.onmessage = (event) => {
        if (disposed) return;
        try {
          const data = JSON.parse(event.data);
          if (data?.config) {
            setUiRuntimeConfig(data.config);
            setUiRuntimeConfigVer(Number(data.version) || 0);
          }
        } catch {
          // Silent fail
        }
      };

      es.onerror = () => {
        if (disposed) return;
        // Only reconnect if not already reconnecting and not connected
        if (!reconnectTimer && es?.readyState !== EventSource.OPEN) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            if (disposed) return;
            es?.close();
            connectSse();
          }, 5000);
        }
      };
    };

    connectSse();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      es?.close();
    };
  }, []);

  useEffect(() => {
    try {
      const maxActiveMessages = Math.max(20, Math.min(5000, Math.trunc(pickNestedNumber(uiRuntimeConfig, ['qqSandbox', 'maxActiveMessages'], 200))));
      const maxInactiveMessages = Math.max(0, Math.min(2000, Math.trunc(pickNestedNumber(uiRuntimeConfig, ['qqSandbox', 'maxInactiveMessages'], 20))));
      const persistMaxConversations = Math.max(1, Math.min(500, Math.trunc(pickNestedNumber(uiRuntimeConfig, ['qqSandbox', 'persistMaxConversations'], 30))));
      const persistMaxMessages = Math.max(0, Math.min(2000, Math.trunc(pickNestedNumber(uiRuntimeConfig, ['qqSandbox', 'persistMaxMessages'], 50))));
      const renderPageSize = Math.max(20, Math.min(2000, Math.trunc(pickNestedNumber(uiRuntimeConfig, ['qqSandbox', 'renderPageSize'], 120))));
      const renderPageStep = Math.max(10, Math.min(2000, Math.trunc(pickNestedNumber(uiRuntimeConfig, ['qqSandbox', 'renderPageStep'], 120))));
      qqLimitsRef.current = {
        maxActiveMessages,
        maxInactiveMessages,
        persistMaxConversations,
        persistMaxMessages,
        renderPageSize,
        renderPageStep,
      };
    } catch {
    }
  }, [uiRuntimeConfig, uiRuntimeConfigVer]);

  return { uiRuntimeConfigVer, qqLimitsRef };
}
