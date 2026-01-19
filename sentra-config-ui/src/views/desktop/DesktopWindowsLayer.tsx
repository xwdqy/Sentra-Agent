import { EnvWindowItem } from './EnvWindowItem';
import type { DeskWindow } from '../../types/ui';

type SetOpenWindows = (next: DeskWindow[] | ((prev: DeskWindow[]) => DeskWindow[])) => void;

type DesktopWindowsLayerProps = {
  openWindows: DeskWindow[];
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

export function DesktopWindowsLayer(props: DesktopWindowsLayerProps) {
  const {
    openWindows,
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
  } = props;

  return (
    <>
      {openWindows.map(w => (
        <EnvWindowItem
          key={w.id}
          w={w}
          desktopSafeArea={desktopSafeArea}
          theme={theme}
          saving={saving}
          performanceMode={performanceMode}
          activeWinId={activeWinId}
          bringToFront={bringToFront}
          setActiveWinId={setActiveWinId}
          setActiveUtilityId={setActiveUtilityId}
          setOpenWindows={setOpenWindows}
          handleClose={handleClose}
          handleSave={handleSave}
          handleVarChange={handleVarChange}
          handleAddVar={handleAddVar}
          handleDeleteVar={handleDeleteVar}
          handleRestore={handleRestore}
          handleWindowMaximize={handleWindowMaximize}
        />
      ))}
    </>
  );
}
