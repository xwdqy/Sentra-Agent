import { useCallback } from 'react';
import type { FileItem } from '../types/ui';
import { useWindowsStore } from '../store/windowsStore';

type LoadConfigs = (silent?: boolean) => Promise<void> | void;

export function useOpenWindowWithRefresh(loadConfigs: LoadConfigs) {
  const openWindow = useWindowsStore(s => s.openWindow);

  return useCallback((file: FileItem, opts?: { maximize?: boolean }) => {
    loadConfigs(true);
    openWindow(file, opts);
  }, [loadConfigs, openWindow]);
}
