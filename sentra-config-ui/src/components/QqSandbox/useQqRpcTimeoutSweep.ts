import { useEffect, type MutableRefObject } from 'react';

export function useQqRpcTimeoutSweep<T extends { ts: number; reject: (e: any) => void }>(opts: {
  pendingRpcRef: MutableRefObject<Map<string, T>>;
}) {
  const { pendingRpcRef } = opts;

  useEffect(() => {
    const sweep = window.setInterval(() => {
      const now = Date.now();
      for (const [id, p] of pendingRpcRef.current.entries()) {
        if (now - p.ts > 45_000) {
          pendingRpcRef.current.delete(id);
          try {
            p.reject(new Error('rpc_timeout'));
          } catch {
            // ignore
          }
        }
      }
    }, 5000);

    return () => {
      try {
        window.clearInterval(sweep);
      } catch {
      }
    };
  }, [pendingRpcRef]);
}
