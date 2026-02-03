import { useEffect, type MutableRefObject } from 'react';

export function useQqWsPageLifecycle(opts: {
  unloadingRef: MutableRefObject<boolean>;
  wantConnectedRef: MutableRefObject<boolean>;
  wsRef: MutableRefObject<WebSocket | null>;
  attemptConnectRef: MutableRefObject<null | ((why: string) => void)>;
}) {
  const { unloadingRef, wantConnectedRef, wsRef, attemptConnectRef } = opts;

  useEffect(() => {
    const onUnloadLike = () => {
      unloadingRef.current = true;
      try {
        wsRef.current?.close(1000, 'page_unload');
      } catch {
      }
    };

    const onVis = () => {
      // IMPORTANT: do NOT close WS just because the tab becomes hidden.
      // Actions like screenshots, OS overlays, alt-tab may briefly set visibilityState=hidden.
      if (document.visibilityState === 'visible') {
        unloadingRef.current = false;
        if (wantConnectedRef.current && wsRef.current == null) {
          try {
            attemptConnectRef.current?.('恢复前台');
          } catch {
          }
        }
      }
    };

    window.addEventListener('beforeunload', onUnloadLike);
    window.addEventListener('pagehide', onUnloadLike);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('beforeunload', onUnloadLike);
      window.removeEventListener('pagehide', onUnloadLike);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [attemptConnectRef, unloadingRef, wantConnectedRef, wsRef]);
}
