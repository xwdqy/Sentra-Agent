import { create } from 'zustand';
import { storage } from '../utils/storage';

type DockFavoritesStore = {
  dockFavorites: string[];
  setDockFavorites: (next: string[] | ((prev: string[]) => string[])) => void;
  addDockFavorite: (id: string) => void;
  removeDockFavorite: (id: string) => void;
};

const loadInitialDockFavorites = (): string[] => {
  const saved = storage.getJson<any>('sentra_dock_favorites', { fallback: [] });
  return Array.isArray(saved) ? saved.filter((x) => typeof x === 'string') : [];
};

export const useDockFavoritesStore = create<DockFavoritesStore>((set, get) => {
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  const persist = (next: string[]) => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      storage.setJson('sentra_dock_favorites', next);
    }, 500);
  };

  return {
    dockFavorites: loadInitialDockFavorites(),
    setDockFavorites: (next) => {
      set((state) => {
        const value = typeof next === 'function' ? (next as (prev: string[]) => string[])(state.dockFavorites) : next;
        persist(value);
        return { dockFavorites: value };
      });
    },
    addDockFavorite: (id) => {
      const cur = get().dockFavorites;
      if (cur.includes(id)) return;
      const next = [...cur, id];
      persist(next);
      set({ dockFavorites: next });
    },
    removeDockFavorite: (id) => {
      const next = get().dockFavorites.filter((x) => x !== id);
      persist(next);
      set({ dockFavorites: next });
    },
  };
});
