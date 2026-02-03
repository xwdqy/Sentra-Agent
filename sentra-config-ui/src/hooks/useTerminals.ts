import { useMemo } from 'react';
import { getAuthHeaders } from '../services/api';
import type { TerminalWin } from '../types/ui';
import type { ToastMessage } from '../components/Toast';
import { useTerminalStore } from '../store/terminalStore';

export type UseTerminalsParams = {
  addToast: (type: ToastMessage['type'], title: string, message?: string) => void;
  allocateZ?: () => number; // optional z-index allocator to align with desktop windows
};

export function useTerminals({ addToast, allocateZ }: UseTerminalsParams) {
  const terminalWindows = useTerminalStore(s => s.terminalWindows);
  const setTerminalWindows = useTerminalStore(s => s.setTerminalWindows);
  const activeTerminalId = useTerminalStore(s => s.activeTerminalId);
  const setActiveTerminalId = useTerminalStore(s => s.setActiveTerminalId);

  const bringTerminalToFront = useMemo(() => {
    return (id: string) => {
      const z = allocateZ ? allocateZ() : undefined;
      setTerminalWindows(prev => prev.map(t => t.id === id ? { ...t, z: z ?? (t.z + 1), minimized: false } : t));
      setActiveTerminalId(id);
    };
  }, [allocateZ, setActiveTerminalId, setTerminalWindows]);

  const spawnTerminal = (title: string, appKey: string, processId: string, options?: { theme?: any, headerText?: string }) => {
    const id = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const z = allocateZ ? allocateZ() : 1001;
    const terminal: TerminalWin = {
      id,
      title,
      processId,
      appKey,
      pos: { x: window.innerWidth / 2 - 350, y: window.innerHeight / 2 - 250 },
      size: { width: 900, height: 600 },
      z,
      minimized: false,
      maximized: false,
      theme: options?.theme,
      headerText: options?.headerText,
    };
    setTerminalWindows(prev => [...prev, terminal]);
    setActiveTerminalId(id);
    return id;
  };

  const runScript = async (path: string, title: string, appKey: string, args: string[], options?: { theme?: any, headerText?: string }) => {
    const existing = useTerminalStore.getState().terminalWindows.find(t => t.appKey === appKey);
    if (existing) {
      try {
        const res = await fetch(`/api/scripts/status/${existing.processId}`, { headers: getAuthHeaders() });
        if (res.status === 404) {
          setTerminalWindows(prev => prev.filter(t => t.id !== existing.id));
        } else if (res.ok) {
          const st: any = await res.json();
          if (st && (st.exitCode != null || st.endTime != null)) {
            setTerminalWindows(prev => prev.filter(t => t.id !== existing.id));
          } else {
            if (existing.minimized) {
              setTerminalWindows(prev => prev.map(t => t.id === existing.id ? { ...t, minimized: false } : t));
            }
            bringTerminalToFront(existing.id);
            return;
          }
        }
      } catch {
        // ignore
      }
    }
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ args }),
      });
      const data = await response.json();
      if (data.success && data.processId) {
        spawnTerminal(title, appKey, data.processId, options);
      }
    } catch (error) {
      addToast('error', `Failed to run ${title}`, error instanceof Error ? error.message : undefined);
    }
  };

  const runScriptSilent = async (path: string, title: string, args: string[]) => {
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ args }),
      });
      const data: any = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        const msg = String(data?.message || data?.error || `HTTP ${response.status}`);
        addToast('error', `Failed to run ${title}`, msg);
      }
    } catch (error) {
      addToast('error', `Failed to run ${title}`, error instanceof Error ? error.message : undefined);
    }
  };

  const handleRunBootstrap = async () => runScript('/api/scripts/bootstrap', 'Bootstrap Script', 'bootstrap', ['--force']);
  const handleRunStart = async () => runScript('/api/scripts/start', 'Start Script', 'start', []);
  const handleRunNapcatBuild = async () => runScript('/api/scripts/napcat', 'Napcat Build', 'napcat-build', ['build']);
  const handleRunNapcatStart = async () => runScript('/api/scripts/napcat', 'Napcat Start', 'napcat-start', ['start']);
  const handleRunNapcatStartSilent = async () => runScriptSilent('/api/scripts/napcat', 'Napcat Start', ['start']);
  const handleRunUpdate = async () => runScript('/api/scripts/update', 'Update Project', 'update', []);
  const handleRunForceUpdate = async () => runScript('/api/scripts/update', 'Force Update Project', 'force-update', ['force']);
  const handleRunSentiment = async () => runScript('/api/scripts/sentiment', '情感分析服务', 'sentiment', [], {
    headerText: 'Sentra Emotion Analysis Engine v1.0',
    theme: {
      background: '#1a0b1c',
      foreground: '#ffb7b2',
      cursor: '#ff9a9e',
      selectionBackground: 'rgba(255, 154, 158, 0.3)',
      black: '#1a0b1c',
      red: '#ff6b6b',
      green: '#f093fb',
      yellow: '#fecfef',
      blue: '#a18cd1',
      magenta: '#ff9a9e',
      cyan: '#a18cd1',
      white: '#fad0c4',
      brightBlack: '#4a2b4f',
      brightRed: '#ff8787',
      brightGreen: '#f5576c',
      brightYellow: '#fecfef',
      brightBlue: '#bc93d1',
      brightMagenta: '#ffc3a0',
      brightCyan: '#bc93d1',
      brightWhite: '#ffffff',
    }
  });

  const handleRunShell = async (shellType: 'powershell' | 'cmd' | 'bash', title?: string) => {
    const appKey = `execpty:${shellType}:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const safeTitle = String(title || '').trim() || (shellType === 'cmd' ? 'CMD' : shellType === 'bash' ? 'Bash' : 'PowerShell');
    try {
      const response = await fetch('/api/terminal-executor/create', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ shellType }),
      });

      const data: any = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success || !data?.sessionId) {
        const msg = String(data?.message || data?.error || `HTTP ${response.status}`);
        addToast('error', '启动终端失败', msg);
        return;
      }

      spawnTerminal(safeTitle, appKey, String(data.sessionId));
    } catch (error) {
      addToast('error', '启动终端失败', error instanceof Error ? error.message : undefined);
    }
  };

  const handleCloseTerminal = async (id: string) => {
    const st = useTerminalStore.getState();
    const terminal = st.terminalWindows.find(t => t.id === id);
    if (terminal) {
      try {
        const pid = String(terminal.processId || '');
        if (String(terminal.appKey || '').startsWith('execpty:')) {
          await fetch(`/api/terminal-executor/close/${encodeURIComponent(pid)}`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({})
          });
        } else {
          await fetch(`/api/scripts/kill/${encodeURIComponent(pid)}`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({})
          });
        }
      } catch (e) {
        console.error('Failed to kill process on close', e);
      }
    }
    setTerminalWindows(prev => prev.filter(t => t.id !== id));
    if (st.activeTerminalId === id) setActiveTerminalId(null);
  };

  const handleMinimizeTerminal = (id: string) => {
    setTerminalWindows(prev => prev.map(t => t.id === id ? { ...t, minimized: true } : t));
    setActiveTerminalId(null);
  };

  return {
    terminalWindows,
    setTerminalWindows,
    activeTerminalId,
    bringTerminalToFront,
    handleRunBootstrap,
    handleRunStart,
    handleRunNapcatBuild,
    handleRunNapcatStart,
    handleRunNapcatStartSilent,
    handleRunUpdate,
    handleRunForceUpdate,
    handleRunSentiment,
    handleRunShell,
    handleCloseTerminal,
    handleMinimizeTerminal,
  } as const;
}
