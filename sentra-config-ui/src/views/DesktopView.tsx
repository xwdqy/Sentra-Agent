import { useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { MenuBar } from '../components/MenuBar';
import { DesktopDock } from './desktop/DesktopDock';
import { DesktopContextMenu } from './desktop/DesktopContextMenu';
import { DesktopIconsLayer } from './desktop/DesktopIconsLayer';
import { DesktopTerminalWindows } from './desktop/DesktopTerminalWindows';
import { DesktopWindowsLayer } from './desktop/DesktopWindowsLayer';
import { DesktopUtilityWindowsLayer } from './desktop/DesktopUtilityWindowsLayer';

import { Launchpad } from '../components/Launchpad';
import { SideTaskbar } from '../components/SideTaskbar';
import { ToastContainer } from '../components/Toast';
import { Dialog } from '../components/Dialog';
import { useContextMenu } from 'react-contexify';
import { getIconForType } from '../utils/icons';
import { IoBookOutline } from 'react-icons/io5';
import type { DesktopIcon, FileItem, AppFolder } from '../types/ui';
import type { PresetsEditorState } from '../hooks/usePresetsEditor';
import { AppFolderModal } from '../components/AppFolderModal';
import { storage } from '../utils/storage';
import { useUIStore } from '../store/uiStore';
import { useWindowsStore } from '../store/windowsStore';
import { useDesktopWindows } from '../hooks/useDesktopWindows';
import { useOpenWindowWithRefresh } from '../hooks/useOpenWindowWithRefresh';
import { useTerminals } from '../hooks/useTerminals';
import { useDockFavorites } from '../hooks/useDockFavorites';

export type DesktopViewProps = {
  isSolidColor: boolean;
  currentWallpaper: string;
  brightness: number;
  setBrightness: (val: number) => void;
  onLogout?: () => void;

  // icons and folders
  desktopIcons?: DesktopIcon[];
  desktopFolders?: AppFolder[];

  allItems: FileItem[];
  recordUsage: (key: string) => void;

  // wallpaper & menu
  wallpapers: string[];
  defaultWallpapers: string[];
  BING_WALLPAPER: string;
  SOLID_COLORS: { name: string; value: string }[];
  handleWallpaperSelect: (wp: string) => void;
  handleUploadWallpaper: () => void;
  handleDeleteWallpaper: () => void;
  wallpaperInterval: number;
  setWallpaperInterval: (val: ((prev: number) => number) | number) => void;
  loadConfigs: (silent?: boolean) => Promise<void> | void;
  presetsState: PresetsEditorState;
};

export const DesktopView = (props: DesktopViewProps) => {
  const {
    isSolidColor,
    currentWallpaper,
    brightness,
    setBrightness,
    onLogout,
    desktopIcons,
    desktopFolders,
    allItems,
    recordUsage,
    wallpapers,
    defaultWallpapers,
    BING_WALLPAPER,
    SOLID_COLORS,
    handleWallpaperSelect,
    handleUploadWallpaper,
    handleDeleteWallpaper,
    wallpaperInterval,
    setWallpaperInterval,
    loadConfigs,
    presetsState,
  } = props;

  const { dockFavorites, setDockFavorites } = useDockFavorites();

  const openWindows = useWindowsStore(s => s.openWindows);
  const setOpenWindows = useWindowsStore(s => s.setOpenWindows);
  const activeWinId = useWindowsStore(s => s.activeWinId);
  const setActiveWinId = useWindowsStore(s => s.setActiveWinId);
  const bringToFront = useWindowsStore(s => s.bringToFront);
  const allocateZ = useWindowsStore(s => s.allocateZ);
  const closeWindow = useWindowsStore(s => s.closeWindow);

  const openWindowWithRefresh = useOpenWindowWithRefresh(loadConfigs);

  const saving = useUIStore(s => s.saving);
  const setSaving = useUIStore(s => s.setSaving);
  const theme = useUIStore(s => s.theme);
  const performanceModeOverride = useUIStore(s => s.performanceModeOverride);

  const {
    toasts,
    removeToast,
    addToast,
    dialogOpen,
    dialogConfig,
    setDialogOpen,
    accentColor,
    setAccentColor,
    showDock,
    toggleDock,
    launchpadOpen,
    setLaunchpadOpen,
    devCenterOpen,
    setDevCenterOpen,
    devCenterMinimized,
    setDevCenterMinimized,
    deepWikiOpen,
    setDeepWikiOpen,
    deepWikiMinimized,
    setDeepWikiMinimized,
    redisAdminOpen,
    setRedisAdminOpen,
    redisAdminMinimized,
    setRedisAdminMinimized,
    modelProvidersManagerOpen,
    setModelProvidersManagerOpen,
    modelProvidersManagerMinimized,
    setModelProvidersManagerMinimized,
    emojiStickersManagerOpen,
    setEmojiStickersManagerOpen,
    emojiStickersManagerMinimized,
    setEmojiStickersManagerMinimized,
    presetsEditorOpen,
    setPresetsEditorOpen,
    presetsEditorMinimized,
    setPresetsEditorMinimized,
    presetImporterOpen,
    setPresetImporterOpen,
    presetImporterMinimized,
    setPresetImporterMinimized,
    fileManagerOpen,
    setFileManagerOpen,
    fileManagerMinimized,
    setFileManagerMinimized,

    terminalManagerOpen,
    setTerminalManagerOpen,
    terminalManagerMinimized,
    setTerminalManagerMinimized,

    utilityFocusRequestId,
    utilityFocusRequestNonce,
    clearUtilityFocusRequest,
  } = useUIStore();

  const {
    terminalWindows,
    setTerminalWindows,
    activeTerminalId,
    bringTerminalToFront,
    handleCloseTerminal,
    handleMinimizeTerminal,
  } = useTerminals({ addToast, allocateZ });

  const {
    handleSave,
    handleVarChange,
    handleAddVar,
    handleDeleteVar,
    handleRestore,
  } = useDesktopWindows({ setSaving, addToast, loadConfigs, onLogout });

  // Folder & window state
  const [openFolder, setOpenFolder] = useState<{
    id: string;
    anchorRect?: { left: number; top: number; width: number; height: number };
  } | null>(null);
  const [activeUtilityId, setActiveUtilityId] = useState<string | null>(null);
  const [maximizedWindowIds, setMaximizedWindowIds] = useState<string[]>([]);
  const [utilityZMap, setUtilityZMap] = useState<Record<string, number>>({});

  const [sideTabsCollapsed, setSideTabsCollapsed] = useState(() => {
    return storage.getBool('sentra_side_tabs_collapsed', { fallback: true });
  });
  const MENU_BAR_HEIGHT = 30;
  const SIDE_TABS_COLLAPSED_WIDTH = 44;
  const SIDE_TABS_EXPANDED_WIDTH = 220;
  const BOTTOM_SAFE = 0;

  const handleSideTabsCollapsedChange = useCallback((collapsed: boolean) => {
    setSideTabsCollapsed(collapsed);
    storage.setBool('sentra_side_tabs_collapsed', collapsed);
  }, []);

  const desktopSafeArea = useMemo(() => ({
    top: MENU_BAR_HEIGHT,
    bottom: BOTTOM_SAFE,
    left: sideTabsCollapsed ? 0 : SIDE_TABS_EXPANDED_WIDTH,
    right: 0,
  }), [BOTTOM_SAFE, MENU_BAR_HEIGHT, SIDE_TABS_EXPANDED_WIDTH, sideTabsCollapsed]);

  const handleWindowMaximize = (id: string, isMaximized: boolean) => {
    setMaximizedWindowIds(prev => {
      if (isMaximized) {
        if (prev.includes(id)) return prev;
        return [...prev, id];
      }
      return prev.filter(x => x !== id);
    });
  };

  const openUtilityCount =
    (devCenterOpen ? 1 : 0) +
    (deepWikiOpen ? 1 : 0) +
    (redisAdminOpen ? 1 : 0) +
    (modelProvidersManagerOpen ? 1 : 0) +
    (emojiStickersManagerOpen ? 1 : 0) +
    (presetsEditorOpen ? 1 : 0) +
    (presetImporterOpen ? 1 : 0) +
    (fileManagerOpen ? 1 : 0) +
    (terminalManagerOpen ? 1 : 0);

  const lowEndDevice = useMemo(() => {
    try {
      const nav = navigator as any;
      const mem = typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null;
      const cores = typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null;
      // Conservative: treat <=4GB or <=4 cores as low-end.
      return (mem != null && mem <= 4) || (cores != null && cores <= 4);
    } catch {
      return false;
    }
  }, []);

  const autoDockPerformanceMode = lowEndDevice || (openWindows.length + terminalWindows.length + openUtilityCount) > 3;

  const autoPerformanceMode =
    lowEndDevice ||
    maximizedWindowIds.length > 0 ||
    (openWindows.length + terminalWindows.length + openUtilityCount) >= 3;

  const performanceMode =
    performanceModeOverride === 'on'
      ? true
      : performanceModeOverride === 'off'
        ? false
        : autoPerformanceMode;

  const dockPerformanceMode =
    performanceModeOverride === 'on'
      ? true
      : performanceModeOverride === 'off'
        ? false
        : autoDockPerformanceMode;

  useEffect(() => {
    if (performanceMode) return;
    try {
      const nav = navigator as any;
      const mem = typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null;
      const cores = typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null;
      // Low-end devices: avoid prefetching heavy apps to reduce memory pressure.
      if ((mem != null && mem <= 4) || (cores != null && cores <= 4)) return;
    } catch {
      // ignore
    }
    const w = window as any;
    const schedule = (cb: () => void) => {
      if (typeof w.requestIdleCallback === 'function') return w.requestIdleCallback(cb, { timeout: 2000 });
      return window.setTimeout(cb, 1200);
    };
    const cancel = (id: any) => {
      if (typeof w.cancelIdleCallback === 'function') return w.cancelIdleCallback(id);
      return window.clearTimeout(id);
    };

    const id = schedule(() => {
      void import('../components/RedisAdminManager/RedisAdminManager');
      void import('../components/ModelProvidersManager/ModelProvidersManager');
      void import('../components/EmojiStickersManager/EmojiStickersManager');
      void import('../components/TerminalWindow');
      void import('../components/TerminalExecutorWindow');
    });

    return () => cancel(id);
  }, [performanceMode]);

  useEffect(() => {
    try {
      document.documentElement.setAttribute('data-performance', performanceMode ? '1' : '0');
      document.body.setAttribute('data-performance', performanceMode ? '1' : '0');
    } catch {
      // ignore
    }
  }, [performanceMode]);

  const handleActivateWindowFromSide = useCallback((id: string) => {
    bringToFront(id);
    setActiveUtilityId(null);
  }, [bringToFront]);

  const handleActivateTerminalFromSide = useCallback((id: string) => {
    bringTerminalToFront(id);
    setActiveUtilityId(null);
  }, [bringTerminalToFront]);

  const handleCloseWindowFromSide = useCallback((id: string) => {
    handleWindowMaximize(id, false);
    closeWindow(id);
  }, [closeWindow]);

  const handleCloseTerminalFromSide = useCallback((id: string) => {
    handleWindowMaximize(id, false);
    handleCloseTerminal(id);
  }, [handleCloseTerminal]);

  const bringUtilityToFront = useCallback((id: string) => {
    const next = allocateZ();
    setUtilityZMap(prev => ({ ...prev, [id]: next }));
    setActiveUtilityId(id);
    setActiveWinId(null);
  }, [allocateZ, setActiveWinId]);

  useEffect(() => {
    const id = utilityFocusRequestId;
    if (!id) return;

    if (id === 'dev-center') {
      setDevCenterOpen(true);
      setDevCenterMinimized(false);
    } else if (id === 'deepwiki') {
      setDeepWikiOpen(true);
      setDeepWikiMinimized(false);
    } else if (id === 'redis-admin') {
      setRedisAdminOpen(true);
      setRedisAdminMinimized(false);
    } else if (id === 'model-providers-manager') {
      setModelProvidersManagerOpen(true);
      setModelProvidersManagerMinimized(false);
    } else if (id === 'emoji-stickers-manager') {
      setEmojiStickersManagerOpen(true);
      setEmojiStickersManagerMinimized(false);
    } else if (id === 'presets-editor') {
      setPresetsEditorOpen(true);
      setPresetsEditorMinimized(false);
    } else if (id === 'preset-importer') {
      setPresetImporterOpen(true);
      setPresetImporterMinimized(false);
    } else if (id === 'file-manager') {
      setFileManagerOpen(true);
      setFileManagerMinimized(false);
    } else if (id === 'terminal-manager') {
      setTerminalManagerOpen(true);
      setTerminalManagerMinimized(false);
    }

    bringUtilityToFront(id);
    clearUtilityFocusRequest();
  }, [
    utilityFocusRequestNonce,
    utilityFocusRequestId,
    bringUtilityToFront,
    clearUtilityFocusRequest,
    setDevCenterOpen,
    setDevCenterMinimized,
    setDeepWikiOpen,
    setDeepWikiMinimized,
    setRedisAdminOpen,
    setRedisAdminMinimized,
    setModelProvidersManagerOpen,
    setModelProvidersManagerMinimized,
    setEmojiStickersManagerOpen,
    setEmojiStickersManagerMinimized,
    setPresetsEditorOpen,
    setPresetsEditorMinimized,
    setPresetImporterOpen,
    setPresetImporterMinimized,
    setFileManagerOpen,
    setFileManagerMinimized,
    setTerminalManagerOpen,
    setTerminalManagerMinimized,
  ]);

  const handleOpenDeepWiki = useCallback(() => {
    setDeepWikiOpen(true);
    setDeepWikiMinimized(false);
    bringUtilityToFront('deepwiki');
  }, [bringUtilityToFront, setDeepWikiMinimized, setDeepWikiOpen]);

  // Ensure utility windows always get a global zIndex on open (unified with desktop windows)
  useEffect(() => {
    if (devCenterOpen && utilityZMap['dev-center'] == null) {
      bringUtilityToFront('dev-center');
    }
  }, [devCenterOpen, utilityZMap, bringUtilityToFront]);

  useEffect(() => {
    if (deepWikiOpen && utilityZMap['deepwiki'] == null) {
      bringUtilityToFront('deepwiki');
    }
  }, [deepWikiOpen, utilityZMap, bringUtilityToFront]);

  useEffect(() => {
    if (redisAdminOpen && utilityZMap['redis-admin'] == null) {
      bringUtilityToFront('redis-admin');
    }
  }, [redisAdminOpen, utilityZMap, bringUtilityToFront]);

  useEffect(() => {
    if (modelProvidersManagerOpen && utilityZMap['model-providers-manager'] == null) {
      bringUtilityToFront('model-providers-manager');
    }
  }, [modelProvidersManagerOpen, utilityZMap, bringUtilityToFront]);

  useEffect(() => {
    if (emojiStickersManagerOpen && utilityZMap['emoji-stickers-manager'] == null) {
      bringUtilityToFront('emoji-stickers-manager');
    }
  }, [emojiStickersManagerOpen, utilityZMap, bringUtilityToFront]);

  useEffect(() => {
    if (presetsEditorOpen && utilityZMap['presets-editor'] == null) {
      bringUtilityToFront('presets-editor');
    }
  }, [presetsEditorOpen, utilityZMap, bringUtilityToFront]);

  useEffect(() => {
    if (presetImporterOpen && utilityZMap['preset-importer'] == null) {
      bringUtilityToFront('preset-importer');
    }
  }, [presetImporterOpen, utilityZMap, bringUtilityToFront]);

  useEffect(() => {
    if (fileManagerOpen && utilityZMap['file-manager'] == null) {
      bringUtilityToFront('file-manager');
    }
  }, [fileManagerOpen, utilityZMap, bringUtilityToFront]);

  useEffect(() => {
    if (terminalManagerOpen && utilityZMap['terminal-manager'] == null) {
      bringUtilityToFront('terminal-manager');
    }
  }, [terminalManagerOpen, utilityZMap, bringUtilityToFront]);

  const renderTopTile = useCallback((key: string, label: string, icon: ReactNode, onClick: (e: React.MouseEvent) => void) => {
    return (
      <div
        key={key}
        onClick={onClick}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          cursor: 'pointer',
          padding: '8px',
          borderRadius: '12px',
          transition: 'all 0.2s',
          width: 90,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
          e.currentTarget.style.transform = 'translateY(-2px)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.transform = 'translateY(0)';
        }}
      >
        <div style={{ width: 60, height: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
          <div style={{ width: 60, height: 60 }}>{icon}</div>
        </div>
        <div style={{
          fontSize: 12,
          color: 'white',
          textShadow: '0 1px 3px rgba(0,0,0,0.8)',
          fontWeight: 500,
          textAlign: 'center',
          lineHeight: 1.2,
        }}>
          {label}
        </div>
      </div>
    );
  }, []);

  const extraTabs: {
    id: string;
    title: string;
    icon: ReactNode;
    isActive: boolean;
    onActivate: () => void;
    onClose: () => void;
  }[] = [];

  if (devCenterOpen) {
    extraTabs.push({
      id: 'dev-center',
      title: '开发中心',
      icon: getIconForType('dev-center', 'module'),
      isActive: activeUtilityId === 'dev-center',
      onActivate: () => {
        setDevCenterOpen(true);
        setDevCenterMinimized(false);
        bringUtilityToFront('dev-center');
      },
      onClose: () => {
        setDevCenterOpen(false);
        setDevCenterMinimized(false);
        if (activeUtilityId === 'dev-center') {
          setActiveUtilityId(null);
        }
      },
    });
  }

  if (terminalManagerOpen) {
    extraTabs.push({
      id: 'terminal-manager',
      title: '终端执行器',
      icon: getIconForType('terminal-manager', 'module'),
      isActive: activeUtilityId === 'terminal-manager',
      onActivate: () => {
        setTerminalManagerOpen(true);
        setTerminalManagerMinimized(false);
        bringUtilityToFront('terminal-manager');
      },
      onClose: () => {
        setTerminalManagerOpen(false);
        setTerminalManagerMinimized(false);
        if (activeUtilityId === 'terminal-manager') {
          setActiveUtilityId(null);
        }
      },
    });
  }

  if (deepWikiOpen) {
    extraTabs.push({
      id: 'deepwiki',
      title: 'DeepWiki',
      icon: <IoBookOutline style={{ color: '#2563eb' }} />, 
      isActive: activeUtilityId === 'deepwiki',
      onActivate: () => {
        setDeepWikiOpen(true);
        setDeepWikiMinimized(false);
        bringUtilityToFront('deepwiki');
      },
      onClose: () => {
        setDeepWikiOpen(false);
        setDeepWikiMinimized(false);
        if (activeUtilityId === 'deepwiki') {
          setActiveUtilityId(null);
        }
      },
    });
  }

  if (redisAdminOpen) {
    extraTabs.push({
      id: 'redis-admin',
      title: 'Redis 管理器',
      icon: getIconForType('redis-admin', 'module'),
      isActive: activeUtilityId === 'redis-admin',
      onActivate: () => {
        setRedisAdminOpen(true);
        setRedisAdminMinimized(false);
        bringUtilityToFront('redis-admin');
      },
      onClose: () => {
        setRedisAdminOpen(false);
        setRedisAdminMinimized(false);
        if (activeUtilityId === 'redis-admin') {
          setActiveUtilityId(null);
        }
      },
    });
  }

  if (modelProvidersManagerOpen) {
    extraTabs.push({
      id: 'model-providers-manager',
      title: '模型供应商',
      icon: getIconForType('model-providers-manager', 'module'),
      isActive: activeUtilityId === 'model-providers-manager',
      onActivate: () => {
        setModelProvidersManagerOpen(true);
        setModelProvidersManagerMinimized(false);
        bringUtilityToFront('model-providers-manager');
      },
      onClose: () => {
        setModelProvidersManagerOpen(false);
        setModelProvidersManagerMinimized(false);
        if (activeUtilityId === 'model-providers-manager') {
          setActiveUtilityId(null);
        }
      },
    });
  }

  if (emojiStickersManagerOpen) {
    extraTabs.push({
      id: 'emoji-stickers-manager',
      title: '表情包配置',
      icon: getIconForType('emoji-stickers-manager', 'module'),
      isActive: activeUtilityId === 'emoji-stickers-manager',
      onActivate: () => {
        setEmojiStickersManagerOpen(true);
        setEmojiStickersManagerMinimized(false);
        bringUtilityToFront('emoji-stickers-manager');
      },
      onClose: () => {
        setEmojiStickersManagerOpen(false);
        setEmojiStickersManagerMinimized(false);
        if (activeUtilityId === 'emoji-stickers-manager') {
          setActiveUtilityId(null);
        }
      },
    });
  }

  if (presetsEditorOpen) {
    extraTabs.push({
      id: 'presets-editor',
      title: '预设撰写',
      icon: getIconForType('agent-presets', 'module'),
      isActive: activeUtilityId === 'presets-editor',
      onActivate: () => {
        setPresetsEditorOpen(true);
        setPresetsEditorMinimized(false);
        bringUtilityToFront('presets-editor');
      },
      onClose: () => {
        setPresetsEditorOpen(false);
        setPresetsEditorMinimized(false);
        if (activeUtilityId === 'presets-editor') {
          setActiveUtilityId(null);
        }
      },
    });
  }

  if (fileManagerOpen) {
    extraTabs.push({
      id: 'file-manager',
      title: '文件管理',
      icon: getIconForType('file-manager', 'module'),
      isActive: activeUtilityId === 'file-manager',
      onActivate: () => {
        setFileManagerOpen(true);
        setFileManagerMinimized(false);
        bringUtilityToFront('file-manager');
      },
      onClose: () => {
        setFileManagerOpen(false);
        setFileManagerMinimized(false);
        if (activeUtilityId === 'file-manager') {
          setActiveUtilityId(null);
        }
      },
    });
  }

  if (presetImporterOpen) {
    extraTabs.push({
      id: 'preset-importer',
      title: '预设导入',
      icon: getIconForType('preset-importer', 'module'),
      isActive: activeUtilityId === 'preset-importer',
      onActivate: () => {
        setPresetImporterOpen(true);
        setPresetImporterMinimized(false);
        bringUtilityToFront('preset-importer');
      },
      onClose: () => {
        setPresetImporterOpen(false);
        setPresetImporterMinimized(false);
        if (activeUtilityId === 'preset-importer') {
          setActiveUtilityId(null);
        }
      },
    });
  }

  const MENU_ID = 'desktop-menu';
  const { show } = useContextMenu({ id: MENU_ID });
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    show({ event: e });
  };

  // Launchpad 应用列表：包含 Dev Center + 所有模块/插件
  const launchpadItems = [
    {
      name: 'dev-center',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:dev-center');
        setDevCenterOpen(true);
        setDevCenterMinimized(false);
        bringUtilityToFront('dev-center');
      }
    },
    {
      name: 'presets-editor',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:presets');
        setPresetsEditorOpen(true);
        setPresetsEditorMinimized(false);
        bringUtilityToFront('presets-editor');
      }
    },
    {
      name: 'preset-importer',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:preset-importer');
        setPresetImporterOpen(true);
        setPresetImporterMinimized(false);
        bringUtilityToFront('preset-importer');
      }
    },
    {
      name: 'file-manager',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:filemanager');
        setFileManagerOpen(true);
        setFileManagerMinimized(false);
        bringUtilityToFront('file-manager');
      }
    },
    {
      name: 'redis-admin',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:redis-admin');
        setRedisAdminOpen(true);
        setRedisAdminMinimized(false);
        bringUtilityToFront('redis-admin');
      }
    },
    {
      name: 'model-providers-manager',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:model-providers-manager');
        setModelProvidersManagerOpen(true);
        setModelProvidersManagerMinimized(false);
        bringUtilityToFront('model-providers-manager');
      }
    },
    {
      name: 'emoji-stickers-manager',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:emoji-stickers-manager');
        setEmojiStickersManagerOpen(true);
        setEmojiStickersManagerMinimized(false);
        bringUtilityToFront('emoji-stickers-manager');
      }
    },
    {
      name: 'terminal-manager',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:terminal-manager');
        setTerminalManagerOpen(true);
        setTerminalManagerMinimized(false);
        bringUtilityToFront('terminal-manager');
      }
    },
    ...allItems.filter(item => item.name !== 'utils/emoji-stickers').map(item => ({
      name: item.name,
      type: item.type,
      onClick: () => {
        recordUsage(`${item.type}:${item.name}`);
        openWindowWithRefresh(item);
        const key = `${item.type}-${item.name}`;
        if (!dockFavorites.includes(key)) {
          setDockFavorites(prev => [...prev, key]);
        }
      },
    }))
  ];

  // Desktop 根布局：顶层使用 .desktop-container，内部使用 .desktop-main 承载壁纸和所有窗口
  return (
    <div className="desktop-container">
      {/* 顶部系统菜单栏 */}
      <MenuBar
        brightness={brightness}
        setBrightness={setBrightness}
        accentColor={accentColor}
        setAccentColor={setAccentColor}
        showDock={showDock}
        onToggleDock={toggleDock}
        performanceMode={performanceMode}
        menus={[
          {
            label: '文件',
            items: [
              { label: '刷新配置', onClick: () => loadConfigs() },
              { label: '关闭所有窗口', onClick: () => setOpenWindows([]) }
            ]
          },
          {
            label: '视图',
            items: [
              { label: showDock ? '隐藏常用应用 Dock' : '显示常用应用 Dock', onClick: () => toggleDock() },
              { label: '最小化所有', onClick: () => setOpenWindows(ws => ws.map(w => ({ ...w, minimized: true }))) },
              { label: '恢复所有', onClick: () => setOpenWindows(ws => ws.map(w => ({ ...w, minimized: false }))) },
              {
                label: '切换壁纸', onClick: () => {
                  const currentIndex = wallpapers.indexOf(currentWallpaper);
                  const nextIndex = (currentIndex + 1) % wallpapers.length;
                  props.handleWallpaperSelect(wallpapers[nextIndex]);
                }
              }
            ]
          },
          {
            label: '帮助',
            items: [
              { label: '关于 Sentra Agent', onClick: () => window.open('https://github.com/JustForSO/Sentra-Agent', '_blank') }
            ]
          }
        ]}
        onAppleClick={() => { }}
        onOpenDeepWiki={() => {
          setDeepWikiOpen(true);
          setDeepWikiMinimized(false);
          bringUtilityToFront('deepwiki');
        }}
      />

      <SideTaskbar
        openWindows={openWindows}
        terminalWindows={terminalWindows}
        activeWinId={activeWinId}
        activeTerminalId={activeTerminalId}
        onActivateWindow={handleActivateWindowFromSide}
        onActivateTerminal={handleActivateTerminalFromSide}
        onCloseWindow={handleCloseWindowFromSide}
        onCloseTerminal={handleCloseTerminalFromSide}
        extraTabs={extraTabs}
        collapsed={sideTabsCollapsed}
        onCollapsedChange={handleSideTabsCollapsedChange}
        topOffset={MENU_BAR_HEIGHT}
        expandedWidth={SIDE_TABS_EXPANDED_WIDTH}
        collapsedWidth={SIDE_TABS_COLLAPSED_WIDTH}
        performanceMode={performanceMode}
      />

      {/* 桌面主区域：壁纸 + Dev Center 主窗口 + 所有 MacWindow / Dock / Launchpad 等 */}
      <div
        className="desktop-main"
        style={{
          backgroundImage: isSolidColor ? 'none' : `url(${currentWallpaper})`,
          backgroundColor: isSolidColor ? currentWallpaper : '#000',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          height: '100%',
          width: '100%',
          overflow: 'hidden',
          position: 'relative',
        }}
        onContextMenu={handleContextMenu}
      >
        {/* 背景亮度遮罩，替代 CSS filter: brightness(...)，降低 GPU 压力 */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundColor: `rgba(0, 0, 0, ${Math.min(0.7, Math.max(0, (100 - brightness) / 130))})`,
            zIndex: 0,
          }}
        />
        <DesktopUtilityWindowsLayer
          desktopSafeArea={desktopSafeArea}
          theme={theme}
          performanceMode={performanceMode}
          activeUtilityId={activeUtilityId}
          setActiveUtilityId={setActiveUtilityId}
          utilityZMap={utilityZMap}
          bringUtilityToFront={bringUtilityToFront}
          handleWindowMaximize={handleWindowMaximize}
          allItems={allItems}
          openWindow={openWindowWithRefresh}
          addToast={addToast as any}
          presetsState={presetsState}
          handleOpenDeepWiki={handleOpenDeepWiki}
          devCenterOpen={devCenterOpen}
          setDevCenterOpen={setDevCenterOpen}
          devCenterMinimized={devCenterMinimized}
          setDevCenterMinimized={setDevCenterMinimized}
          redisAdminOpen={redisAdminOpen}
          setRedisAdminOpen={setRedisAdminOpen}
          redisAdminMinimized={redisAdminMinimized}
          setRedisAdminMinimized={setRedisAdminMinimized}
          modelProvidersManagerOpen={modelProvidersManagerOpen}
          setModelProvidersManagerOpen={setModelProvidersManagerOpen}
          modelProvidersManagerMinimized={modelProvidersManagerMinimized}
          setModelProvidersManagerMinimized={setModelProvidersManagerMinimized}
          emojiStickersManagerOpen={emojiStickersManagerOpen}
          setEmojiStickersManagerOpen={setEmojiStickersManagerOpen}
          emojiStickersManagerMinimized={emojiStickersManagerMinimized}
          setEmojiStickersManagerMinimized={setEmojiStickersManagerMinimized}
          presetImporterOpen={presetImporterOpen}
          setPresetImporterOpen={setPresetImporterOpen}
          presetImporterMinimized={presetImporterMinimized}
          setPresetImporterMinimized={setPresetImporterMinimized}
          deepWikiOpen={deepWikiOpen}
          setDeepWikiOpen={setDeepWikiOpen}
          deepWikiMinimized={deepWikiMinimized}
          setDeepWikiMinimized={setDeepWikiMinimized}
          presetsEditorOpen={presetsEditorOpen}
          setPresetsEditorOpen={setPresetsEditorOpen}
          presetsEditorMinimized={presetsEditorMinimized}
          setPresetsEditorMinimized={setPresetsEditorMinimized}
          fileManagerOpen={fileManagerOpen}
          setFileManagerOpen={setFileManagerOpen}
          fileManagerMinimized={fileManagerMinimized}
          setFileManagerMinimized={setFileManagerMinimized}
          terminalManagerOpen={terminalManagerOpen}
          setTerminalManagerOpen={setTerminalManagerOpen}
          terminalManagerMinimized={terminalManagerMinimized}
          setTerminalManagerMinimized={setTerminalManagerMinimized}
        />

        {/* 环境变量编辑窗口 */}
        <DesktopWindowsLayer
          openWindows={openWindows}
          desktopSafeArea={desktopSafeArea}
          theme={theme}
          saving={saving}
          performanceMode={performanceMode}
          activeWinId={activeWinId}
          bringToFront={bringToFront}
          setActiveWinId={setActiveWinId}
          setActiveUtilityId={setActiveUtilityId}
          setOpenWindows={setOpenWindows}
          handleClose={closeWindow}
          handleSave={handleSave}
          handleVarChange={handleVarChange}
          handleAddVar={handleAddVar}
          handleDeleteVar={handleDeleteVar}
          handleRestore={handleRestore}
          handleWindowMaximize={handleWindowMaximize}
        />

        {/* 桌面图标 / 文件夹 */}
        <DesktopIconsLayer
          desktopIcons={desktopIcons}
          desktopFolders={desktopFolders}
          renderTopTile={renderTopTile}
          onOpenFolder={(id, anchorRect) => setOpenFolder({ id, anchorRect })}
        />

        {/* Folder Modal */}
        {openFolder && desktopFolders && (
          <AppFolderModal
            folders={desktopFolders}
            initialFolderId={openFolder.id}
            anchorRect={openFolder.anchorRect}
            theme={theme}
            onAppClick={(_, onClick) => onClick()}
            onClose={() => setOpenFolder(null)}
          />
        )}

        {/* 终端窗口 */}
        <DesktopTerminalWindows
          terminalWindows={terminalWindows}
          activeTerminalId={activeTerminalId}
          bringTerminalToFront={bringTerminalToFront}
          handleCloseTerminal={handleCloseTerminal}
          handleMinimizeTerminal={handleMinimizeTerminal}
          setTerminalWindows={setTerminalWindows}
          handleWindowMaximize={handleWindowMaximize}
          desktopSafeArea={desktopSafeArea}
          performanceMode={performanceMode}
        />

        {/* Launchpad 与 Dock、通知、对话框 等 */}
        <Launchpad
          isOpen={launchpadOpen}
          onClose={() => setLaunchpadOpen(false)}
          items={launchpadItems}
        />

        <DesktopDock
          allItems={allItems}
          recordUsage={recordUsage}
          loadConfigs={loadConfigs}
          dockPerformanceMode={dockPerformanceMode}
        />

        <ToastContainer toasts={toasts} removeToast={removeToast} />

        <Dialog
          isOpen={dialogOpen}
          title={dialogConfig.title}
          message={dialogConfig.message}
          onConfirm={dialogConfig.onConfirm}
          onCancel={() => setDialogOpen(false)}
          type={dialogConfig.type}
          confirmText="删除"
        />

        <DesktopContextMenu
          menuId={MENU_ID}
          wallpapers={wallpapers}
          defaultWallpapers={defaultWallpapers}
          currentWallpaper={currentWallpaper}
          BING_WALLPAPER={BING_WALLPAPER}
          SOLID_COLORS={SOLID_COLORS}
          handleWallpaperSelect={handleWallpaperSelect}
          handleUploadWallpaper={handleUploadWallpaper}
          handleDeleteWallpaper={handleDeleteWallpaper}
          wallpaperInterval={wallpaperInterval}
          setWallpaperInterval={setWallpaperInterval}
          loadConfigs={loadConfigs}
        />
      </div>
    </div>
  );
}
