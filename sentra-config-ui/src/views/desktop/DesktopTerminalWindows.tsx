import { Suspense, lazy } from 'react';
import { IoCubeOutline, IoTerminalOutline } from 'react-icons/io5';
import { MacWindow } from '../../components/MacWindow';
import { SentraLoading } from '../../components/SentraLoading';
import type { TerminalWin } from '../../types/ui';

const TerminalWindow = lazy(() => import('../../components/TerminalWindow').then(module => ({ default: module.TerminalWindow })));

type DesktopTerminalWindowsProps = {
  terminalWindows: TerminalWin[];
  activeTerminalId: string | null;
  bringTerminalToFront: (id: string) => void;
  handleCloseTerminal: (id: string) => void;
  handleMinimizeTerminal: (id: string) => void;
  setTerminalWindows: (next: TerminalWin[] | ((prev: TerminalWin[]) => TerminalWin[])) => void;
  handleWindowMaximize: (id: string, isMaximized: boolean) => void;
  desktopSafeArea: { top: number; bottom: number; left: number; right: number };
  performanceMode: boolean;
};

export function DesktopTerminalWindows(props: DesktopTerminalWindowsProps) {
  const {
    terminalWindows,
    activeTerminalId,
    bringTerminalToFront,
    handleCloseTerminal,
    handleMinimizeTerminal,
    setTerminalWindows,
    handleWindowMaximize,
    desktopSafeArea,
    performanceMode,
  } = props;

  return (
    <>
      {terminalWindows.map(terminal => (
        <MacWindow
          key={terminal.id}
          id={terminal.id}
          title={terminal.title}
          icon={
            <span style={{ fontSize: '16px', display: 'flex', alignItems: 'center' }}>
              {terminal.title.includes('Bootstrap') ? <IoCubeOutline /> : <IoTerminalOutline />}
            </span>
          }
          initialPos={terminal.pos}
          initialSize={terminal.size}
          initialMaximized={!!terminal.maximized}
          safeArea={desktopSafeArea}
          zIndex={terminal.z}
          isActive={activeTerminalId === terminal.id}
          isMinimized={terminal.minimized}
          performanceMode={performanceMode}
          onClose={() => {
            handleWindowMaximize(terminal.id, false);
            handleCloseTerminal(terminal.id);
          }}
          onMinimize={() => {
            handleWindowMaximize(terminal.id, false);
            handleMinimizeTerminal(terminal.id);
          }}
          onMaximize={(isMax) => {
            handleWindowMaximize(terminal.id, isMax);
            setTerminalWindows(prev => prev.map(w => w.id === terminal.id ? { ...w, maximized: isMax } : w));
          }}
          onFocus={() => bringTerminalToFront(terminal.id)}
          onMove={(x, y) => {
            setTerminalWindows(prev => prev.map(w => w.id === terminal.id ? { ...w, pos: { x, y } } : w));
          }}
          onResize={(width, height) => {
            setTerminalWindows(prev => prev.map(w => w.id === terminal.id ? { ...w, size: { width, height } } : w));
          }}
        >
          <Suspense fallback={<SentraLoading title="加载终端" subtitle="首次打开可能较慢，请稍等..." />}>
            <TerminalWindow
              processId={terminal.processId}
              theme={terminal.theme}
              headerText={terminal.headerText}
              onProcessNotFound={() => handleCloseTerminal(terminal.id)}
            />
          </Suspense>
        </MacWindow>
      ))}
    </>
  );
}
