import { useEffect, useRef, useState } from 'react';

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

export function useQqRuntimeConfig(token: string) {
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

  useEffect(() => {
    let disposed = false;
    let t: any = null;

    const fetchRuntime = async () => {
      const headers: Record<string, string> = {};
      if (token) headers['x-auth-token'] = token;
      try {
        const r = await fetch('/api/configs/runtime', { headers });
        if (!r.ok) return;
        const data: any = await r.json().catch(() => null);
        if (!data || disposed) return;
        const ver = Number(data?.version || 0);
        const cfg = (data?.config && typeof data.config === 'object') ? data.config : {};
        if (Number.isFinite(ver) && ver > 0) {
          setUiRuntimeConfigVer((prev) => (prev === ver ? prev : ver));
        }
        setUiRuntimeConfig((prev) => {
          try {
            const prevJson = JSON.stringify(prev);
            const nextJson = JSON.stringify(cfg);
            if (prevJson === nextJson) return prev;
          } catch {
          }
          return cfg;
        });
      } catch {
      }
    };

    void fetchRuntime();
    t = window.setInterval(fetchRuntime, 2500);

    return () => {
      disposed = true;
      if (t) {
        try { window.clearInterval(t); } catch { }
      }
    };
  }, [token]);

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
