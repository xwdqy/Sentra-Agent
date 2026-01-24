import { create } from 'zustand';
import type { TerminalWin } from '../types/ui';
import { storage } from '../utils/storage';

type SetTerminalWindows = (next: TerminalWin[] | ((prev: TerminalWin[]) => TerminalWin[])) => void;

type TerminalStore = {
  terminalWindows: TerminalWin[];
  activeTerminalId: string | null;
  setTerminalWindows: SetTerminalWindows;
  setActiveTerminalId: (id: string | null) => void;
};

let cleaned = false;
function ensureLegacyCleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    storage.remove('sentra_terminal_windows');
    storage.remove('sentra_active_terminal_id');
  } catch {
    // ignore
  }
}

const TERMINAL_WINDOWS_KEY = 'sentra_terminal_windows_v2';
const ACTIVE_TERMINAL_ID_KEY = 'sentra_active_terminal_id_v2';

let persistTimer: number | null = null;
let persisted = false;

function schedulePersist() {
  if (persistTimer != null) return;
  // Batch multiple state changes within the same frame (drag/move/resize) without a fixed delay.
  persistTimer = window.requestAnimationFrame(() => {
    persistTimer = null;
    flushPersist();
  });
}

function flushPersist() {
  if (persistTimer != null) {
    window.cancelAnimationFrame(persistTimer);
    persistTimer = null;
  }
  const st = useTerminalStore.getState();
  storage.setJson(TERMINAL_WINDOWS_KEY, st.terminalWindows, 'session');
  storage.setString(ACTIVE_TERMINAL_ID_KEY, st.activeTerminalId || '', 'session');
  storage.setJson(TERMINAL_WINDOWS_KEY, st.terminalWindows, 'local');
  storage.setString(ACTIVE_TERMINAL_ID_KEY, st.activeTerminalId || '', 'local');
}

function ensurePersistenceHooks() {
  if (persisted) return;
  persisted = true;
  const onVis = () => {
    if (document.visibilityState === 'hidden') flushPersist();
  };
  window.addEventListener('pagehide', flushPersist);
  window.addEventListener('beforeunload', flushPersist);
  window.addEventListener('unload', flushPersist);
  document.addEventListener('visibilitychange', onVis);
}

function centerPos() {
  return {
    x: Math.max(0, window.innerWidth / 2 - 350),
    y: Math.max(40, window.innerHeight / 2 - 250),
  };
}

function normalizePersistedTerminals(raw: any): TerminalWin[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const c = centerPos();
  return raw
    .filter((t: any) => t && typeof t.processId === 'string' && typeof t.appKey === 'string')
    .map((t: any) => {
      const p = t?.pos || { x: 0, y: 0 };
      const invalid =
        p.x == null || p.y == null ||
        p.x < 0 || p.y < 30 ||
        p.x > window.innerWidth - 120 || p.y > window.innerHeight - 120;
      const pos = invalid ? c : { x: Number(p.x), y: Number(p.y) };
      const z = Number.isFinite(Number(t.z)) ? Number(t.z) : 1001;
      const minimized = !!t.minimized;
      const maximized = !!t.maximized;
      const size = t?.size && Number.isFinite(Number(t.size.width)) && Number.isFinite(Number(t.size.height))
        ? { width: Number(t.size.width), height: Number(t.size.height) }
        : undefined;
      return {
        ...t,
        pos,
        z,
        minimized,
        maximized,
        size,
      } as TerminalWin;
    });
}

export const useTerminalStore = create<TerminalStore>((set) => {
  ensureLegacyCleanup();
  ensurePersistenceHooks();

  const persistedWindowsSession = storage.getJson<any>(TERMINAL_WINDOWS_KEY, { backend: 'session', fallback: [] });
  const persistedWindowsLocal = storage.getJson<any>(TERMINAL_WINDOWS_KEY, { backend: 'local', fallback: [] });
  const terminalWindows = normalizePersistedTerminals(
    Array.isArray(persistedWindowsSession) && persistedWindowsSession.length ? persistedWindowsSession : persistedWindowsLocal
  );

  const savedActiveSession = storage.getString(ACTIVE_TERMINAL_ID_KEY, { backend: 'session', fallback: '' });
  const savedActiveLocal = storage.getString(ACTIVE_TERMINAL_ID_KEY, { backend: 'local', fallback: '' });
  const savedActive = savedActiveSession || savedActiveLocal;
  const activeTerminalId = savedActive ? savedActive : null;

  const setTerminalWindows: SetTerminalWindows = (next) => {
    set(prev => ({
      ...prev,
      terminalWindows: typeof next === 'function' ? (next as any)(prev.terminalWindows) : next,
    }));
    schedulePersist();
  };

  return {
    terminalWindows,
    activeTerminalId,
    setTerminalWindows,
    setActiveTerminalId: (id: string | null) => {
      set({ activeTerminalId: id });
      schedulePersist();
    },
  };
});
