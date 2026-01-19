import { useMemo } from 'react';
import type { AppFolder, DesktopIcon } from '../types/ui';
import { buildDesktopFolders, buildDesktopIcons } from '../utils/buildDesktopIcons';
import { useTerminals } from './useTerminals';
import { useUIStore } from '../store/uiStore';
import { useWindowsStore } from '../store/windowsStore';

type UseDesktopShortcutsParams = {
  recordUsage: (key: string) => void;
  isPortable: boolean;
};

export function useDesktopShortcuts(params: UseDesktopShortcutsParams) {
  const { recordUsage, isPortable } = params;

  const addToast = useUIStore(s => s.addToast);
  const allocateZ = useWindowsStore(s => s.allocateZ);

  const {
    setDevCenterOpen,
    setDevCenterMinimized,
    setRedisAdminOpen,
    setRedisAdminMinimized,
    setModelProvidersManagerOpen,
    setModelProvidersManagerMinimized,
    setPresetsEditorOpen,
    setPresetsEditorMinimized,
    setPresetImporterOpen,
    setPresetImporterMinimized,
    setFileManagerOpen,
    setFileManagerMinimized,
    setIosPresetsEditorOpen,
    setIosPresetImporterOpen,
    setIosFileManagerOpen,
    setIosModelProvidersManagerOpen,
    setIosRedisAdminOpen,
  } = useUIStore();

  const handleOpenDevCenter = () => {
    setDevCenterOpen(true);
    setDevCenterMinimized(false);
  };

  const handleOpenPresets = () => {
    if (isPortable) {
      setIosPresetsEditorOpen(true);
    } else {
      setPresetsEditorOpen(true);
      setPresetsEditorMinimized(false);
    }
  };

  const handleOpenFileManager = () => {
    if (isPortable) {
      setIosFileManagerOpen(true);
    } else {
      setFileManagerOpen(true);
      setFileManagerMinimized(false);
    }
  };

  const handleOpenPresetImporter = () => {
    if (isPortable) {
      setIosPresetImporterOpen(true);
    } else {
      setPresetImporterOpen(true);
      setPresetImporterMinimized(false);
    }
  };

  const handleOpenRedisAdmin = () => {
    if (isPortable) {
      setIosRedisAdminOpen(true);
      return;
    }
    setRedisAdminOpen(true);
    setRedisAdminMinimized(false);
  };

  const handleOpenModelProvidersManager = () => {
    if (isPortable) {
      setIosModelProvidersManagerOpen(true);
      return;
    }
    setModelProvidersManagerOpen(true);
    setModelProvidersManagerMinimized(false);
  };

  const {
    handleRunBootstrap,
    handleRunStart,
    handleRunNapcatBuild,
    handleRunNapcatStart,
    handleRunUpdate,
    handleRunForceUpdate,
    handleRunSentiment,
  } = useTerminals({ addToast, allocateZ });

  const desktopIcons: DesktopIcon[] = useMemo(() => {
    return buildDesktopIcons(
      recordUsage,
      handleRunBootstrap,
      handleRunStart,
      handleRunNapcatBuild,
      handleRunNapcatStart,
      handleRunUpdate,
      handleRunForceUpdate,
      handleRunSentiment,
      handleOpenPresets,
      handleOpenFileManager,
      handleOpenDevCenter,
      handleOpenPresetImporter,
      handleOpenModelProvidersManager,
      handleOpenRedisAdmin,
    );
  }, [
    handleOpenDevCenter,
    handleOpenFileManager,
    handleOpenModelProvidersManager,
    handleOpenPresetImporter,
    handleOpenPresets,
    handleOpenRedisAdmin,
    handleRunBootstrap,
    handleRunForceUpdate,
    handleRunNapcatBuild,
    handleRunNapcatStart,
    handleRunSentiment,
    handleRunStart,
    handleRunUpdate,
    recordUsage,
  ]);

  const desktopFolders: AppFolder[] = useMemo(() => {
    return buildDesktopFolders(
      recordUsage,
      handleRunBootstrap,
      handleRunStart,
      handleRunNapcatBuild,
      handleRunNapcatStart,
      handleRunUpdate,
      handleRunForceUpdate,
      handleRunSentiment,
    );
  }, [
    handleRunBootstrap,
    handleRunForceUpdate,
    handleRunNapcatBuild,
    handleRunNapcatStart,
    handleRunSentiment,
    handleRunStart,
    handleRunUpdate,
    recordUsage,
  ]);

  return { desktopIcons, desktopFolders } as const;
}
