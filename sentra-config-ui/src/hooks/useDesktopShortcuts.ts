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
  const requestUtilityFocus = useUIStore(s => s.requestUtilityFocus);
  const allocateZ = useWindowsStore(s => s.allocateZ);

  const {
    setDevCenterOpen,
    setDevCenterMinimized,
    setIosPresetsEditorOpen,
    setIosPresetImporterOpen,
    setIosFileManagerOpen,
    setIosModelProvidersManagerOpen,
    setIosEmojiStickersManagerOpen,
    setIosRedisAdminOpen,
  } = useUIStore();

  const handleOpenDevCenter = () => {
    if (isPortable) {
      setDevCenterOpen(true);
      setDevCenterMinimized(false);
      return;
    }
    requestUtilityFocus('dev-center');
  };

  const handleOpenPresets = () => {
    if (isPortable) {
      setIosPresetsEditorOpen(true);
    } else {
      requestUtilityFocus('presets-editor');
    }
  };

  const handleOpenFileManager = () => {
    if (isPortable) {
      setIosFileManagerOpen(true);
    } else {
      requestUtilityFocus('file-manager');
    }
  };

  const handleOpenPresetImporter = () => {
    if (isPortable) {
      setIosPresetImporterOpen(true);
    } else {
      requestUtilityFocus('preset-importer');
    }
  };

  const handleOpenRedisAdmin = () => {
    if (isPortable) {
      setIosRedisAdminOpen(true);
      return;
    }
    requestUtilityFocus('redis-admin');
  };

  const handleOpenModelProvidersManager = () => {
    if (isPortable) {
      setIosModelProvidersManagerOpen(true);
      return;
    }
    requestUtilityFocus('model-providers-manager');
  };

  const handleOpenEmojiStickersManager = () => {
    if (isPortable) {
      setIosEmojiStickersManagerOpen(true);
      return;
    }
    requestUtilityFocus('emoji-stickers-manager');
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
      handleOpenEmojiStickersManager,
      handleOpenRedisAdmin,
    );
  }, [
    handleOpenDevCenter,
    handleOpenFileManager,
    handleOpenModelProvidersManager,
    handleOpenEmojiStickersManager,
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
