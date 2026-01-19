import { useEffect, useState } from 'react';
import { DEFAULT_WALLPAPERS, BING_WALLPAPER } from '../constants/wallpaper';
import type { ToastMessage } from '../components/Toast';
import { storage } from '../utils/storage';

export function useWallpaper(addToast: (type: ToastMessage['type'], title: string, message?: string) => void) {
  const [wallpapers, setWallpapers] = useState<string[]>(() => {
    const custom = storage.getJson<any>('sentra_custom_wallpapers', { fallback: [] });
    if (Array.isArray(custom)) {
      const clean = custom.filter((x) => typeof x === 'string');
      if (clean.length > 0) return [...DEFAULT_WALLPAPERS, ...clean];
    }
    return DEFAULT_WALLPAPERS;
  });

  const [currentWallpaper, setCurrentWallpaper] = useState<string>(() => {
    return storage.getString('sentra_current_wallpaper', { fallback: DEFAULT_WALLPAPERS[0] });
  });

  const [brightness, setBrightness] = useState(() => {
    return storage.getNumber('sentra_brightness', { fallback: 100 });
  });

  const [wallpaperInterval, setWallpaperInterval] = useState<number>(0);

  const [wallpaperEditorOpen, setWallpaperEditorOpen] = useState(false);
  const [wallpaperEditorSrc, setWallpaperEditorSrc] = useState<string | null>(null);
  const [wallpaperEditorBlobUrl, setWallpaperEditorBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    storage.remove('sentra_wallpaper_fit');
  }, []);

  useEffect(() => {
    return () => {
      if (wallpaperEditorBlobUrl) {
        try { URL.revokeObjectURL(wallpaperEditorBlobUrl); } catch { /* ignore */ }
      }
    };
  }, [wallpaperEditorBlobUrl]);

  // rotation
  useEffect(() => {
    if (wallpaperInterval > 0) {
      const timer = setInterval(() => {
        const currentIndex = wallpapers.indexOf(currentWallpaper);
        const nextIndex = (currentIndex + 1) % wallpapers.length;
        setCurrentWallpaper(wallpapers[nextIndex]);
      }, wallpaperInterval * 1000);
      return () => clearInterval(timer);
    }
  }, [wallpaperInterval, wallpapers, currentWallpaper]);

  useEffect(() => {
    storage.setString('sentra_current_wallpaper', currentWallpaper);
  }, [currentWallpaper]);

  useEffect(() => {
    storage.setNumber('sentra_brightness', Number(brightness));
  }, [brightness]);

  const handleWallpaperSelect = (wp: string) => setCurrentWallpaper(wp);

  const handleUploadWallpaper = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        if (file.size > 10 * 1024 * 1024) {
          addToast('error', '图片过大', '请上传小于 10MB 的图片');
          return;
        }
        try {
          const nextUrl = URL.createObjectURL(file);

          // cleanup previous blob url if any
          if (wallpaperEditorBlobUrl) {
            try { URL.revokeObjectURL(wallpaperEditorBlobUrl); } catch { /* ignore */ }
          }

          setWallpaperEditorBlobUrl(nextUrl);
          setWallpaperEditorSrc(nextUrl);
          setWallpaperEditorOpen(true);
        } catch {
          addToast('error', '打开失败', '无法读取该图片文件');
        }
      }
    };
    input.click();
  };

  const cancelWallpaperEdit = () => {
    if (wallpaperEditorBlobUrl) {
      try { URL.revokeObjectURL(wallpaperEditorBlobUrl); } catch { /* ignore */ }
    }
    setWallpaperEditorOpen(false);
    setWallpaperEditorSrc(null);
    setWallpaperEditorBlobUrl(null);
  };

  const saveWallpaperFromEditor = (dataUrl: string) => {
    try {
      const newWallpapers = [...wallpapers, dataUrl];
      setWallpapers(newWallpapers);
      setCurrentWallpaper(dataUrl);

      const customOnly = newWallpapers.slice(DEFAULT_WALLPAPERS.length);
      storage.setJson('sentra_custom_wallpapers', customOnly);
      addToast('success', '壁纸已添加');
      setWallpaperEditorOpen(false);
      setWallpaperEditorSrc(null);
      if (wallpaperEditorBlobUrl) {
        try { URL.revokeObjectURL(wallpaperEditorBlobUrl); } catch { /* ignore */ }
      }
      setWallpaperEditorBlobUrl(null);
    } catch {
      addToast('error', '存储空间不足', '无法保存更多壁纸，请删除一些旧壁纸');
    }
  };

  const deleteCurrentWallpaper = () => {
    if (DEFAULT_WALLPAPERS.includes(currentWallpaper) || currentWallpaper === BING_WALLPAPER) {
      addToast('info', '无法删除', '系统默认壁纸无法删除');
      return false;
    }
    const newWallpapers = wallpapers.filter(w => w !== currentWallpaper);
    setWallpapers(newWallpapers);
    setCurrentWallpaper(newWallpapers[newWallpapers.length - 1] || DEFAULT_WALLPAPERS[0]);
    const customOnly = newWallpapers.slice(DEFAULT_WALLPAPERS.length);
    storage.setJson('sentra_custom_wallpapers', customOnly);
    addToast('success', '壁纸已删除');
    return true;
  };

  return {
    wallpapers,
    currentWallpaper,
    setCurrentWallpaper,
    brightness,
    setBrightness,
    wallpaperInterval,
    setWallpaperInterval,
    handleWallpaperSelect,
    handleUploadWallpaper,
    wallpaperEditorOpen,
    wallpaperEditorSrc,
    cancelWallpaperEdit,
    saveWallpaperFromEditor,
    deleteCurrentWallpaper,
  } as const;
}
