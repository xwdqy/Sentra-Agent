import { useCallback, useMemo, useState } from 'react';
import { Menu, Item, Submenu } from 'react-contexify';
import { Tooltip } from 'antd';
import { storage } from '../../utils/storage';

type DesktopContextMenuProps = {
  menuId: string;

  wallpapers: string[];
  defaultWallpapers: string[];
  currentWallpaper: string;
  BING_WALLPAPER: string;
  SOLID_COLORS: { name: string; value: string }[];

  handleWallpaperSelect: (wp: string) => void;
  handleUploadWallpaper: () => void;
  handleDeleteWallpaper: () => void;

  wallpaperInterval: number;
  setWallpaperInterval: (val: ((prev: number) => number) | number) => void;

  loadConfigs: (silent?: boolean) => Promise<void> | void;
};

export function DesktopContextMenu(props: DesktopContextMenuProps) {
  const {
    menuId,
    wallpapers,
    defaultWallpapers,
    currentWallpaper,
    BING_WALLPAPER,
    SOLID_COLORS,
    handleWallpaperSelect,
    handleUploadWallpaper,
    handleDeleteWallpaper,
    wallpaperInterval,
    setWallpaperInterval,
    loadConfigs,
  } = props;

  const shortHash = useCallback((s: string) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(16).toUpperCase().slice(0, 6);
  }, []);

  const getWallpaperDisplayName = useCallback((wp: string) => {
    if (!wp) return '';
    if (wp.startsWith('/wallpapers/')) {
      const base = decodeURIComponent(wp.split('/').pop() || wp);
      const noExt = base.replace(/\.(png|jpe?g|webp|gif|bmp)$/i, '');
      const pretty = noExt.replace(/[-_]+/g, ' ').trim();
      return pretty || base;
    }
    if (wp.startsWith('data:image/')) {
      return `自定义 ${shortHash(wp)}`;
    }
    try {
      const u = new URL(wp);
      const base = decodeURIComponent(u.pathname.split('/').pop() || u.hostname);
      const noExt = base.replace(/\.(png|jpe?g|webp|gif|bmp)$/i, '');
      const pretty = noExt.replace(/[-_]+/g, ' ').trim();
      return pretty || base || wp;
    } catch {
      return wp;
    }
  }, [shortHash]);

  const menuEllipsisStyle = useMemo(() => {
    return {
      maxWidth: 180,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      display: 'block',
    } as const;
  }, []);

  const [recentSolidColors, setRecentSolidColors] = useState<string[]>(() => {
    const arr = storage.getJson<unknown>('sentra_recent_solid_colors', { fallback: [] });
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  });

  const upsertRecentSolidColor = useCallback((hex: string) => {
    const v = String(hex || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
    setRecentSolidColors(prev => {
      const next = [v, ...prev.filter(x => x !== v)].slice(0, 8);
      storage.setJson('sentra_recent_solid_colors', next);
      return next;
    });
  }, []);

  const selectSolidColor = useCallback((hex: string) => {
    upsertRecentSolidColor(hex);
    handleWallpaperSelect(hex);
  }, [handleWallpaperSelect, upsertRecentSolidColor]);

  const openColorPicker = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = (() => {
      const base = String(currentWallpaper || '').trim();
      if (/^#[0-9a-fA-F]{6}$/.test(base)) return base;
      return '#1a1a2e';
    })();
    input.onchange = (e) => {
      const val = String((e.target as HTMLInputElement).value || '').trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(val)) return;
      selectSolidColor(val);
    };
    input.click();
  }, [currentWallpaper, selectSolidColor]);

  return (
    <Menu id={menuId} theme="light" animation="scale">
      <Submenu label="切换壁纸">
        {wallpapers.map((wp, i) => {
          const name = getWallpaperDisplayName(wp);
          const isCurrent = wp === currentWallpaper;
          const key = wp.startsWith('data:image/') ? `data:${i}:${shortHash(wp)}` : `${wp}:${i}`;
          return (
            <Item key={key} onClick={() => handleWallpaperSelect(wp)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 14, display: 'inline-block', textAlign: 'center' }} aria-hidden="true">
                  {isCurrent ? '✓' : ''}
                </span>
                <Tooltip title={name}>
                  <span style={menuEllipsisStyle}>{name}</span>
                </Tooltip>
              </div>
            </Item>
          );
        })}
        <Item onClick={() => handleWallpaperSelect(BING_WALLPAPER)}>Bing 每日壁纸</Item>
        <Submenu label="纯色背景">
          {recentSolidColors.length ? (
            <>
              {recentSolidColors.map((hex) => (
                <Item key={`recent:${hex}`} onClick={() => selectSolidColor(hex)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 12, height: 12, background: hex, border: '1px solid #ddd' }} />
                    <Tooltip title={hex}>
                      <span style={menuEllipsisStyle}>{hex}</span>
                    </Tooltip>
                  </div>
                </Item>
              ))}
            </>
          ) : null}
          {SOLID_COLORS.map(c => (
            <Item key={c.name} onClick={() => selectSolidColor(c.value)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 12, height: 12, background: c.value, border: '1px solid #ddd' }} />
                <Tooltip title={c.name}>
                  <span style={menuEllipsisStyle}>{c.name}</span>
                </Tooltip>
              </div>
            </Item>
          ))}

          <Item onClick={openColorPicker}>
            自定义颜色...
          </Item>
        </Submenu>
      </Submenu>
      <Item onClick={handleUploadWallpaper}>上传壁纸...</Item>
      <Item
        onClick={() => handleDeleteWallpaper()}
        disabled={defaultWallpapers.includes(currentWallpaper) || currentWallpaper === BING_WALLPAPER || String(currentWallpaper || '').startsWith('#')}
      >
        删除当前壁纸
      </Item>
      <Item onClick={() => setWallpaperInterval(i => (i === 0 ? 60 : 0))}>
        {wallpaperInterval > 0 ? '停止壁纸轮播' : '开启壁纸轮播 (1min)'}
      </Item>
      <Item onClick={() => loadConfigs()}>刷新</Item>
    </Menu>
  );
}
