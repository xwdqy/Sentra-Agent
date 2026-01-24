import { create } from 'zustand';
import type { DeskWindow, FileItem } from '../types/ui';
import type { ConfigData } from '../types/config';
import { storage } from '../utils/storage';

type OpenWindowOpts = { maximize?: boolean };

type SetOpenWindows = (next: DeskWindow[] | ((prev: DeskWindow[]) => DeskWindow[])) => void;

type WindowsStore = {
  openWindows: DeskWindow[];
  activeWinId: string | null;

  setOpenWindows: SetOpenWindows;
  setActiveWinId: (id: string | null) => void;

  allocateZ: () => number;
  bringToFront: (id: string) => void;
  openWindow: (file: FileItem, opts?: OpenWindowOpts) => void;
  closeWindow: (id: string) => void;

  syncWindowsFromConfigData: (data: ConfigData) => void;
};

const WINDOW_Z_START = 1000;
const WINDOW_Z_MAX = 999_999_900;

const OPEN_WINDOWS_KEY = 'sentra_open_windows';
const Z_NEXT_KEY = 'sentra_z_next';
const ACTIVE_WIN_KEY = 'sentra_active_win_id';

let persistTimer: number | null = null;
let persisted = false;

function schedulePersist() {
  if (persistTimer != null) {
    window.clearTimeout(persistTimer);
  }
  persistTimer = window.setTimeout(() => {
    const st = useWindowsStore.getState();
    storage.setJson(OPEN_WINDOWS_KEY, st.openWindows);
    storage.setString(ACTIVE_WIN_KEY, st.activeWinId || '');
    const maxZ = st.openWindows.reduce((m, w) => Math.max(m, Number(w.z || 0)), 0);
    const saved = storage.getNumber(Z_NEXT_KEY, { fallback: 0 });
    const next = Math.max(saved, maxZ + 1);
    storage.setNumber(Z_NEXT_KEY, Math.min(next, WINDOW_Z_MAX));
  }, 1000);
}

function flushPersist() {
  if (persistTimer != null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  const st = useWindowsStore.getState();
  storage.setJson(OPEN_WINDOWS_KEY, st.openWindows);
  storage.setString(ACTIVE_WIN_KEY, st.activeWinId || '');
  const maxZ = st.openWindows.reduce((m, w) => Math.max(m, Number(w.z || 0)), 0);
  const saved = storage.getNumber(Z_NEXT_KEY, { fallback: 0 });
  const next = Math.max(saved, maxZ + 1);
  storage.setNumber(Z_NEXT_KEY, Math.min(next, WINDOW_Z_MAX));
}

function ensurePersistenceHooks() {
  if (persisted) return;
  persisted = true;
  const onVis = () => {
    if (document.visibilityState === 'hidden') flushPersist();
  };
  window.addEventListener('pagehide', flushPersist);
  document.addEventListener('visibilitychange', onVis);
}

function centerPos() {
  const width = 600;
  const height = 400;
  return {
    x: Math.max(0, (window.innerWidth - width) / 2),
    y: Math.max(40, (window.innerHeight - height) / 2),
  };
}

function normalizePersistedWindows(raw: any): DeskWindow[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const c = centerPos();
  return raw.map((w: any) => {
    const p = w?.pos || { x: 0, y: 0 };
    const invalid =
      p.x == null || p.y == null ||
      p.x < 20 || p.y < 30 ||
      p.x > window.innerWidth - 100 || p.y > window.innerHeight - 100;
    return invalid ? { ...w, pos: c } : w;
  });
}

function normalizeWindowZ(windows: DeskWindow[]) {
  const ordered = [...windows].sort((a, b) => Number(a.z || WINDOW_Z_START) - Number(b.z || WINDOW_Z_START));
  let z = WINDOW_Z_START;
  const mapped = ordered.map(w => {
    z += 1;
    return { ...w, z };
  });
  return { windows: mapped, zNext: z };
}

function filterVarsByExample(file: FileItem, vars: FileItem['variables']) {
  if (!file.hasEnv || !file.hasExample) return vars;
  const example = file.exampleVariables || [];
  if (!Array.isArray(example) || example.length === 0) return vars;
  const exampleKeys = new Set(example.map(v => String(v.key || '')));
  return (vars || []).filter(v => exampleKeys.has(String(v.key || '')));
}

export const useWindowsStore = create<WindowsStore>((set, get) => {
  ensurePersistenceHooks();

  let openWindows = normalizePersistedWindows(storage.getJson<any>(OPEN_WINDOWS_KEY, { fallback: [] }));
  const persistedMaxZ = openWindows.reduce((m, w) => Math.max(m, Number(w.z || WINDOW_Z_START)), WINDOW_Z_START);
  if (persistedMaxZ >= WINDOW_Z_MAX) {
    const normalized = normalizeWindowZ(openWindows);
    openWindows = normalized.windows;
    storage.setJson(OPEN_WINDOWS_KEY, openWindows);
    storage.setNumber(Z_NEXT_KEY, normalized.zNext);
  }

  const savedZ = storage.getNumber(Z_NEXT_KEY, { fallback: 0 });
  const maxZ = openWindows.reduce((m, w) => Math.max(m, Number(w.z || WINDOW_Z_START)), WINDOW_Z_START) + 1;
  let zNext = Math.min(Math.max(savedZ, maxZ), WINDOW_Z_MAX);

  const savedActive = storage.getString(ACTIVE_WIN_KEY, { fallback: '' });
  const initialActiveWinId = savedActive && openWindows.some(w => w.id === savedActive && !w.minimized)
    ? savedActive
    : null;

  const ensureZCapacity = () => {
    if (zNext < WINDOW_Z_MAX) return;
    const normalized = normalizeWindowZ(get().openWindows);
    zNext = normalized.zNext;
    set(prev => ({ ...prev, openWindows: normalized.windows }));
    storage.setJson(OPEN_WINDOWS_KEY, normalized.windows);
    storage.setNumber(Z_NEXT_KEY, zNext);
  };

  const allocateZ = () => {
    ensureZCapacity();
    zNext += 1;
    if (zNext >= WINDOW_Z_MAX) ensureZCapacity();
    storage.setNumber(Z_NEXT_KEY, zNext);
    return zNext;
  };

  const bringToFront = (id: string) => {
    ensureZCapacity();
    zNext += 1;
    if (zNext >= WINDOW_Z_MAX) ensureZCapacity();
    storage.setNumber(Z_NEXT_KEY, zNext);
    set(prev => ({
      ...prev,
      openWindows: prev.openWindows.map(w => (w.id === id ? { ...w, z: zNext, minimized: false } : w)),
      activeWinId: id,
    }));
    schedulePersist();
  };

  const setOpenWindows: SetOpenWindows = (next) => {
    set(prev => ({
      ...prev,
      openWindows: typeof next === 'function' ? (next as any)(prev.openWindows) : next,
    }));
    schedulePersist();
  };

  const setActiveWinId = (id: string | null) => {
    set(prev => ({ ...prev, activeWinId: id }));
    schedulePersist();
  };

  const openWindow = (file: FileItem, opts?: OpenWindowOpts) => {
    const st = get();
    const existing = st.openWindows.find(w => w.file.name === file.name && w.file.type === file.type);
    if (existing) {
      if (existing.minimized || opts?.maximize) {
        setOpenWindows(ws => ws.map(w => w.id === existing.id ? { ...w, minimized: false, maximized: opts?.maximize ? true : w.maximized } : w));
      }
      bringToFront(existing.id);
      return;
    }

    const id = `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const c = centerPos();
    ensureZCapacity();
    zNext += 1;
    if (zNext >= WINDOW_Z_MAX) ensureZCapacity();
    storage.setNumber(Z_NEXT_KEY, zNext);

    const win: DeskWindow = {
      id,
      file,
      z: zNext,
      minimized: false,
      editedVars: filterVarsByExample(file, file.variables ? [...file.variables] : []),
      pos: c,
      maximized: !!opts?.maximize,
    };

    set(prev => ({
      ...prev,
      openWindows: [...prev.openWindows, win],
      activeWinId: id,
    }));
    schedulePersist();
  };

  const closeWindow = (id: string) => {
    set(prev => {
      const next = prev.openWindows.filter(w => w.id !== id);
      return {
        ...prev,
        openWindows: next,
        activeWinId: prev.activeWinId === id ? null : prev.activeWinId,
      };
    });
    schedulePersist();
  };

  const syncWindowsFromConfigData = (data: ConfigData) => {
    set(prev => {
      const next = prev.openWindows.map(w => {
        const isModule = w.file.type === 'module';
        const found = isModule
          ? data.modules.find(m => m.name === w.file.name)
          : data.plugins.find(p => p.name === w.file.name);

        if (!found) return w;

        const nextFile = { ...(found as any), type: w.file.type } as FileItem;
        return {
          ...w,
          file: nextFile,
          editedVars: filterVarsByExample(nextFile, found.variables ? [...found.variables] : []),
        };
      });
      return { ...prev, openWindows: next };
    });
    schedulePersist();
  };

  return {
    openWindows,
    activeWinId: initialActiveWinId,
    setOpenWindows,
    setActiveWinId,
    allocateZ,
    bringToFront,
    openWindow,
    closeWindow,
    syncWindowsFromConfigData,
  };
});
