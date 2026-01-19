import { useDockFavoritesStore } from '../store/dockFavoritesStore';

export function useDockFavorites() {
  const dockFavorites = useDockFavoritesStore(s => s.dockFavorites);
  const setDockFavorites = useDockFavoritesStore(s => s.setDockFavorites);
  return { dockFavorites, setDockFavorites } as const;
}
