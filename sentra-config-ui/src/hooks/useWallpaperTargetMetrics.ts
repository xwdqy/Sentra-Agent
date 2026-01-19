import { useMemo } from 'react';

type UseWallpaperTargetMetricsParams = {
  wallpaperEditorOpen: boolean;
};

export function useWallpaperTargetMetrics(params: UseWallpaperTargetMetricsParams) {
  const { wallpaperEditorOpen } = params;

  const targetAspect = useMemo(() => {
    try {
      const desktopMain = document.querySelector('.desktop-main') as HTMLElement | null;
      if (desktopMain) {
        const rect = desktopMain.getBoundingClientRect();
        const w = Math.max(1, rect.width || 1);
        const h = Math.max(1, rect.height || 1);
        return w / h;
      }

      const w = Math.max(1, window.innerWidth || 1);
      const h = Math.max(1, window.innerHeight || 1);
      return w / h;
    } catch {
      return 16 / 9;
    }
  }, [wallpaperEditorOpen]);

  const targetSize = useMemo(() => {
    try {
      const desktopMain = document.querySelector('.desktop-main') as HTMLElement | null;
      if (desktopMain) {
        const rect = desktopMain.getBoundingClientRect();
        return {
          w: Math.max(1, Math.round(rect.width || 1)),
          h: Math.max(1, Math.round(rect.height || 1)),
        };
      }
    } catch {
      // ignore
    }
    return null;
  }, [wallpaperEditorOpen]);

  return { targetAspect, targetSize } as const;
}
