import { memo, useCallback } from 'react';
import { MacWindow } from '../../components/MacWindow';
import { EnvEditor } from '../../components/EnvEditor';
import { getDisplayName, getIconForType } from '../../utils/icons';
import type { DeskWindow } from '../../types/ui';

type SetOpenWindows = (next: DeskWindow[] | ((prev: DeskWindow[]) => DeskWindow[])) => void;

export type EnvWindowItemProps = {
  w: DeskWindow;
  desktopSafeArea: { top: number; bottom: number; left: number; right: number };
  theme: 'light' | 'dark';
  saving: boolean;
  performanceMode: boolean;
  activeWinId: string | null;
  bringToFront: (id: string) => void;
  setActiveWinId: (id: string | null) => void;
  setActiveUtilityId: (id: string | null) => void;
  setOpenWindows: SetOpenWindows;
  handleClose: (id: string) => void;
  handleSave: (id: string) => void | Promise<void>;
  handleVarChange: (id: string, index: number, field: 'key' | 'value' | 'comment', val: string) => void;
  handleAddVar: (id: string) => void;
  handleDeleteVar: (id: string, index: number) => void;
  handleRestore: (id: string) => void;
  handleWindowMaximize: (id: string, isMaximized: boolean) => void;
};

export const EnvWindowItem = memo(({
  w,
  desktopSafeArea,
  theme,
  saving,
  performanceMode,
  activeWinId,
  bringToFront,
  setActiveWinId,
  setActiveUtilityId,
  setOpenWindows,
  handleClose,
  handleSave,
  handleVarChange,
  handleAddVar,
  handleDeleteVar,
  handleRestore,
  handleWindowMaximize,
}: EnvWindowItemProps) => {
  const handleCloseWin = useCallback(() => {
    handleWindowMaximize(w.id, false);
    handleClose(w.id);
  }, [handleClose, handleWindowMaximize, w.id]);

  const handleMinimizeWin = useCallback(() => {
    setOpenWindows(ws => ws.map(x => x.id === w.id ? { ...x, minimized: true } : x));
    setActiveWinId(null);
    handleWindowMaximize(w.id, false);
  }, [handleWindowMaximize, setActiveWinId, setOpenWindows, w.id]);

  const handleFocusWin = useCallback(() => {
    bringToFront(w.id);
    setActiveUtilityId(null);
  }, [bringToFront, setActiveUtilityId, w.id]);

  const handleMoveWin = useCallback((x: number, y: number) => {
    setOpenWindows(ws => ws.map(win => win.id === w.id ? { ...win, pos: { x, y } } : win));
  }, [setOpenWindows, w.id]);

  const handleResizeWin = useCallback((width: number, height: number) => {
    setOpenWindows(ws => ws.map(win => win.id === w.id ? { ...win, size: { width, height } } : win));
  }, [setOpenWindows, w.id]);

  const handleUpdateVar = useCallback((idx: number, field: 'key' | 'value' | 'comment', val: string) => {
    handleVarChange(w.id, idx, field, val);
  }, [handleVarChange, w.id]);

  const handleAddVarWin = useCallback(() => {
    handleAddVar(w.id);
  }, [handleAddVar, w.id]);

  const handleDeleteVarWin = useCallback((idx: number) => {
    handleDeleteVar(w.id, idx);
  }, [handleDeleteVar, w.id]);

  const handleSaveWin = useCallback(() => {
    handleSave(w.id);
  }, [handleSave, w.id]);

  const handleRestoreWin = useCallback(() => {
    handleRestore(w.id);
  }, [handleRestore, w.id]);

  const handleMaximizeWin = useCallback((isMax: boolean) => {
    handleWindowMaximize(w.id, isMax);
    setOpenWindows(ws => ws.map(win => win.id === w.id ? { ...win, maximized: isMax } : win));
  }, [handleWindowMaximize, setOpenWindows, w.id]);

  return (
    <MacWindow
      id={w.id}
      title={`${getDisplayName(w.file.name)}`}
      icon={getIconForType(w.file.name, w.file.type)}
      safeArea={desktopSafeArea}
      zIndex={w.z}
      isActive={activeWinId === w.id}
      isMinimized={w.minimized}
      performanceMode={performanceMode}
      initialPos={w.pos}
      initialSize={w.size}
      initialMaximized={!!w.maximized}
      onClose={handleCloseWin}
      onMinimize={handleMinimizeWin}
      onMaximize={handleMaximizeWin}
      onFocus={handleFocusWin}
      onMove={handleMoveWin}
      onResize={handleResizeWin}
    >
      <EnvEditor
        appName={getDisplayName(w.file.name)}
        vars={w.editedVars}
        onUpdate={handleUpdateVar}
        onAdd={handleAddVarWin}
        onDelete={handleDeleteVarWin}
        onSave={handleSaveWin}
        onRestore={handleRestoreWin}
        saving={saving}
        isExample={!w.file.hasEnv && w.file.hasExample}
        theme={theme}
      />
    </MacWindow>
  );
});
