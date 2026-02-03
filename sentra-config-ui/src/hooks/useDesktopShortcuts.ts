import React, { useCallback, useMemo, useState } from 'react';
import type { AppFolder, DesktopIcon } from '../types/ui';
import { buildDesktopFolders, buildDesktopIcons } from '../utils/buildDesktopIcons';
import { useTerminals } from './useTerminals';
import { useUIStore } from '../store/uiStore';
import { useWindowsStore } from '../store/windowsStore';
import { MacAlert } from '../components/MacAlert';

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
    setIosMcpServersManagerOpen,
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

  const handleOpenMcpServersManager = () => {
    if (isPortable) {
      setIosMcpServersManagerOpen(true);
      return;
    }
    requestUtilityFocus('mcp-servers-manager');
  };

  const handleOpenEmojiStickersManager = () => {
    if (isPortable) {
      setIosEmojiStickersManagerOpen(true);
      return;
    }
    requestUtilityFocus('emoji-stickers-manager');
  };

  const handleOpenTerminalManager = () => {
    requestUtilityFocus('terminal-manager');
  };

  const {
    handleRunBootstrap,
    handleRunStart,
    handleRunNapcatBuild,
    handleRunNapcatStartSilent,
    handleRunUpdate,
    handleRunForceUpdate,
    handleRunSentiment,
  } = useTerminals({ addToast, allocateZ });

  const handleOpenQqSandbox = useCallback(() => {
    requestUtilityFocus('qq-sandbox');
  }, [requestUtilityFocus]);

  const handleRunNapcatStartForSandbox = useCallback(() => {
    void handleRunNapcatStartSilent();
    handleOpenQqSandbox();
  }, [handleOpenQqSandbox, handleRunNapcatStartSilent]);

  const [pendingUpdate, setPendingUpdate] = useState<'update' | 'force' | null>(null);

  const requestUpdateConfirm = useCallback(() => {
    setPendingUpdate('update');
  }, []);

  const requestForceUpdateConfirm = useCallback(() => {
    setPendingUpdate('force');
  }, []);

  const handleConfirmUpdate = useCallback(() => {
    if (pendingUpdate === 'force') {
      handleRunForceUpdate();
      return;
    }
    if (pendingUpdate === 'update') {
      handleRunUpdate();
    }
  }, [handleRunForceUpdate, handleRunUpdate, pendingUpdate]);

  const updateConfirmDialog = React.createElement(MacAlert, {
    isOpen: pendingUpdate != null,
    title: pendingUpdate === 'force' ? '强制更新' : '更新',
    message:
      pendingUpdate === 'force'
        ? '强制更新会丢弃本地改动并执行更激进的同步策略，可能导致依赖重装或冲突修复。确定继续吗？'
        : '将拉取最新代码并更新项目依赖。确定要开始更新吗？',
    onClose: () => setPendingUpdate(null),
    onConfirm: handleConfirmUpdate,
    confirmText: pendingUpdate === 'force' ? '强制更新' : '更新',
    cancelText: '取消',
    isDanger: pendingUpdate === 'force',
  });

  const desktopIcons: DesktopIcon[] = useMemo(() => {
    return buildDesktopIcons(
      recordUsage,
      handleRunBootstrap,
      handleRunStart,
      handleRunNapcatBuild,
      handleRunNapcatStartForSandbox,
      requestUpdateConfirm,
      requestForceUpdateConfirm,
      handleRunSentiment,
      handleOpenPresets,
      handleOpenFileManager,
      handleOpenDevCenter,
      handleOpenPresetImporter,
      handleOpenModelProvidersManager,
      handleOpenEmojiStickersManager,
      handleOpenMcpServersManager,
      handleOpenRedisAdmin,
      handleOpenTerminalManager,
    );
  }, [
    handleOpenDevCenter,
    handleOpenFileManager,
    handleOpenMcpServersManager,
    handleOpenModelProvidersManager,
    handleOpenEmojiStickersManager,
    handleOpenPresetImporter,
    handleOpenPresets,
    handleOpenRedisAdmin,
    handleOpenTerminalManager,
    handleRunBootstrap,
    handleRunForceUpdate,
    handleRunNapcatBuild,
    handleRunNapcatStartForSandbox,
    handleRunSentiment,
    handleRunStart,
    requestUpdateConfirm,
    requestForceUpdateConfirm,
    recordUsage,
  ]);

  const desktopFolders: AppFolder[] = useMemo(() => {
    return buildDesktopFolders(
      recordUsage,
      handleRunBootstrap,
      handleRunStart,
      handleRunNapcatBuild,
      handleRunNapcatStartForSandbox,
      requestUpdateConfirm,
      requestForceUpdateConfirm,
      handleRunSentiment,
    );
  }, [
    handleRunBootstrap,
    handleRunNapcatBuild,
    handleRunNapcatStartForSandbox,
    handleRunSentiment,
    handleRunStart,
    requestForceUpdateConfirm,
    requestUpdateConfirm,
    recordUsage,
  ]);

  return { desktopIcons, desktopFolders, updateConfirmDialog } as const;
}
