import { Suspense, lazy, useEffect } from 'react';
import { IoCubeOutline, IoTerminalOutline } from 'react-icons/io5';
import { MacWindow } from '../../components/MacWindow';
import { SentraLoading } from '../../components/SentraLoading';
import type { TerminalWin } from '../../types/ui';

const loadTerminalWindow = () => import('../../components/TerminalWindow');
const loadTerminalExecutorWindow = () => import('../../components/TerminalExecutorWindow');
const TerminalWindow = lazy(() => loadTerminalWindow().then(module => ({ default: module.TerminalWindow })));
const TerminalExecutorWindow = lazy(() => loadTerminalExecutorWindow().then(module => ({ default: module.TerminalExecutorWindow })));

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

  useEffect(() => {
    if (!terminalWindows.length) return;
    // Warm up the chunks so refresh doesn't show a long Suspense fallback.
    void loadTerminalWindow().catch(() => undefined);
    void loadTerminalExecutorWindow().catch(() => undefined);
  }, [terminalWindows.length]);

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
          keepMountedWhenMinimized
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
            {String(terminal.appKey || '').startsWith('execpty:') ? (
              <TerminalExecutorWindow
                sessionId={terminal.processId}
                theme={terminal.theme}
                headerText={terminal.headerText}
              />
            ) : (
              <TerminalWindow
                processId={terminal.processId}
                theme={terminal.theme}
                headerText={terminal.headerText}
              />
            )}
          </Suspense>
        </MacWindow>
      ))}
    </>
  );
}
