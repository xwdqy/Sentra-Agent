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

let persistTimer: number | null = null;
let persisted = false;

function schedulePersist() {
  if (persistTimer != null) {
    window.clearTimeout(persistTimer);
  }
  persistTimer = window.setTimeout(() => {
    const st = useWindowsStore.getState();
    storage.setJson('sentra_open_windows', st.openWindows);
    storage.setNumber('sentra_z_next', Number(st.openWindows.reduce((m, w) => Math.max(m, Number(w.z || 0)), 0) + 1));
  }, 1000);
}

function flushPersist() {
  if (persistTimer != null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  const st = useWindowsStore.getState();
  storage.setJson('sentra_open_windows', st.openWindows);
  const maxZ = st.openWindows.reduce((m, w) => Math.max(m, Number(w.z || 0)), 0);
  storage.setNumber('sentra_z_next', Math.max(storage.getNumber('sentra_z_next', { fallback: 0 }), maxZ + 1));
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

export const useWindowsStore = create<WindowsStore>((set, get) => {
  ensurePersistenceHooks();

  const openWindows = normalizePersistedWindows(storage.getJson<any>('sentra_open_windows', { fallback: [] }));
  const savedZ = storage.getNumber('sentra_z_next', { fallback: 0 });
  const maxZ = openWindows.reduce((m, w) => Math.max(m, Number(w.z || 1000)), 1000) + 1;
  let zNext = Math.max(savedZ, maxZ);

  const allocateZ = () => {
    zNext += 1;
    storage.setNumber('sentra_z_next', zNext);
    return zNext;
  };

  const bringToFront = (id: string) => {
    zNext += 1;
    storage.setNumber('sentra_z_next', zNext);
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
    zNext += 1;
    storage.setNumber('sentra_z_next', zNext);

    const win: DeskWindow = {
      id,
      file,
      z: zNext,
      minimized: false,
      editedVars: file.variables ? [...file.variables] : [],
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

        return {
          ...w,
          file: { ...(found as any), type: w.file.type },
          editedVars: found.variables ? [...found.variables] : [],
        };
      });
      return { ...prev, openWindows: next };
    });
    schedulePersist();
  };

  return {
    openWindows,
    activeWinId: null,
    setOpenWindows,
    setActiveWinId,
    allocateZ,
    bringToFront,
    openWindow,
    closeWindow,
    syncWindowsFromConfigData,
  };
});
