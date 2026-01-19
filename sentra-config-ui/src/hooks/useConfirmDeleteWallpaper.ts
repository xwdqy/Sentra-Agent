import { useCallback } from 'react';
import { useUIStore } from '../store/uiStore';

type UseConfirmDeleteWallpaperParams = {
  deleteCurrentWallpaper: () => void;
};

export function useConfirmDeleteWallpaper(params: UseConfirmDeleteWallpaperParams) {
  const { deleteCurrentWallpaper } = params;

  const setDialogOpen = useUIStore(s => s.setDialogOpen);
  const setDialogConfig = useUIStore(s => s.setDialogConfig);

  return useCallback(() => {
    setDialogConfig({
      title: '删除壁纸',
      message: '确定要删除当前壁纸吗？此操作无法撤销。',
      type: 'error',
      onConfirm: () => { deleteCurrentWallpaper(); setDialogOpen(false); }
    });
    setDialogOpen(true);
  }, [deleteCurrentWallpaper, setDialogConfig, setDialogOpen]);
}
