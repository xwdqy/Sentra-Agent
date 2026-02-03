import { useEffect } from 'react';

export function useQqUiHeartbeat(opts: {
  authHeaders: Record<string, string>;
  scope?: string;
  intervalMs?: number;
}) {
  const { authHeaders, scope = 'qq_sandbox', intervalMs = 15_000 } = opts;

  useEffect(() => {
    const beat = () => {
      try {
        void fetch('/api/system/ui/heartbeat', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ scope, ts: Date.now() }),
        }).catch(() => { });
      } catch {
      }
    };

    beat();
    const t = window.setInterval(beat, intervalMs);
    return () => {
      try { window.clearInterval(t); } catch { }
    };
  }, [authHeaders, intervalMs, scope]);
}
