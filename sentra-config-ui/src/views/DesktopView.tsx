import { useState, useCallback, useEffect, useMemo, Suspense, lazy, memo, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { MenuBar } from '../components/MenuBar';
import { MacWindow } from '../components/MacWindow';
import { EnvEditor } from '../components/EnvEditor';
// Lazy load heavy components
const PresetsEditor = lazy(() => import('../components/PresetsEditor').then(module => ({ default: module.PresetsEditor })));
const FileManager = lazy(() => import('../components/FileManager').then(module => ({ default: module.FileManager })));
const RedisEditor = lazy(() => import('../components/RedisEditor/RedisEditor').then(module => ({ default: module.RedisEditor })));
const DeepWikiChat = lazy(() => import('../components/DeepWikiChat').then(module => ({ default: module.DeepWikiChat })));
const PresetImporter = lazy(() => import('../components/PresetImporter').then(module => ({ default: module.PresetImporter })));

import { Dock } from '../components/Dock';
import { Launchpad } from '../components/Launchpad';
import { TerminalWindow } from '../components/TerminalWindow';
import { SideTaskbar } from '../components/SideTaskbar';
import { ToastContainer, ToastMessage } from '../components/Toast';
import { Dialog } from '../components/Dialog';
import { Menu, Item, Submenu, useContextMenu } from 'react-contexify';
import { getDisplayName, getIconForType } from '../utils/icons';
import { IoCubeOutline, IoTerminalOutline, IoBookOutline } from 'react-icons/io5';
import type { DeskWindow, DesktopIcon, FileItem, TerminalWin, AppFolder } from '../types/ui';
import { AppFolderModal } from '../components/AppFolderModal';
import { DevCenterV2 } from '../components/DevCenterV2';

export type DesktopViewProps = {
  isSolidColor: boolean;
  currentWallpaper: string;
  wallpaperFit: 'cover' | 'contain';
  brightness: number;
  setBrightness: (val: number) => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  showDock: boolean;
  toggleDock: () => void;

  // windows
  openWindows: DeskWindow[];
  setOpenWindows: Dispatch<SetStateAction<DeskWindow[]>>;
  activeWinId: string | null;
  setActiveWinId: (id: string | null) => void;
  bringToFront: (id: string) => void;
  allocateZ: () => number;
  handleClose: (id: string) => void;
  handleSave: (id: string) => void | Promise<void>;
  handleVarChange: (id: string, index: number, field: 'key' | 'value' | 'comment', val: string) => void;
  handleAddVar: (id: string) => void;
  handleDeleteVar: (id: string, index: number) => void;
  handleRestore: (id: string) => void;
  saving: boolean;

  // icons and folders
  desktopIcons?: DesktopIcon[];
  desktopFolders?: AppFolder[];

  // terminals
  terminalWindows: TerminalWin[];
  setTerminalWindows: Dispatch<SetStateAction<TerminalWin[]>>;
  activeTerminalId: string | null;
  bringTerminalToFront: (id: string) => void;
  handleCloseTerminal: (id: string) => void;
  handleMinimizeTerminal: (id: string) => void;

  // launchpad & dock
  launchpadOpen: boolean;
  setLaunchpadOpen: (open: boolean) => void;
  allItems: FileItem[];
  recordUsage: (key: string) => void;
  openWindow: (file: FileItem, opts?: { maximize?: boolean }) => void;
  dockFavorites: string[];
  setDockFavorites: Dispatch<SetStateAction<string[]>>;
  uniqueDockItems: any[];

  // toast
  toasts: ToastMessage[];
  removeToast: (id: string) => void;

  // dialog
  dialogOpen: boolean;
  dialogConfig: {
    title: string;
    message: string;
    onConfirm: () => void;
    type: 'info' | 'warning' | 'error';
  };
  setDialogOpen: (open: boolean) => void;

  // wallpaper & menu
  wallpapers: string[];
  defaultWallpapers: string[];
  BING_WALLPAPER: string;
  SOLID_COLORS: { name: string; value: string }[];
  handleWallpaperSelect: (wp: string) => void;
  handleUploadWallpaper: () => void;
  handleDeleteWallpaper: () => void;
  setWallpaperFit: (v: 'cover' | 'contain') => void;
  wallpaperInterval: number;
  setWallpaperInterval: Dispatch<SetStateAction<number>>;
  loadConfigs: () => void | Promise<void>;
  presetsEditorOpen: boolean;
  setPresetsEditorOpen: (open: boolean) => void;
  presetsEditorMinimized: boolean;
  setPresetsEditorMinimized: (min: boolean) => void;

  presetImporterOpen: boolean;
  setPresetImporterOpen: (open: boolean) => void;
  presetImporterMinimized: boolean;
  setPresetImporterMinimized: (min: boolean) => void;
  fileManagerOpen: boolean;
  setFileManagerOpen: (open: boolean) => void;
  fileManagerMinimized: boolean;
  setFileManagerMinimized: (min: boolean) => void;
  addToast: (type: 'success' | 'error' | 'info', title: string, message?: string) => void;
  presetsState: any; // Type will be refined in component
  redisState: any;
  devCenterOpen: boolean;
  setDevCenterOpen: (open: boolean) => void;
  devCenterMinimized: boolean;
  setDevCenterMinimized: (min: boolean) => void;
  deepWikiOpen: boolean;
  setDeepWikiOpen: (open: boolean) => void;
  deepWikiMinimized: boolean;
  setDeepWikiMinimized: (min: boolean) => void;
};

type EnvWindowItemProps = {
  w: DeskWindow;
  desktopSafeArea: { top: number; bottom: number; left: number; right: number };
  theme: 'light' | 'dark';
  saving: boolean;
  performanceMode: boolean;
  activeWinId: string | null;
  bringToFront: (id: string) => void;
  setActiveWinId: (id: string | null) => void;
  setActiveUtilityId: (id: string | null) => void;
  setOpenWindows: Dispatch<SetStateAction<DeskWindow[]>>;
  handleClose: (id: string) => void;
  handleSave: (id: string) => void | Promise<void>;
  handleVarChange: (id: string, index: number, field: 'key' | 'value' | 'comment', val: string) => void;
  handleAddVar: (id: string) => void;
  handleDeleteVar: (id: string, index: number) => void;
  handleRestore: (id: string) => void;
  handleWindowMaximize: (id: string, isMaximized: boolean) => void;
};

const EnvWindowItem = memo(({
  w,
  desktopSafeArea,
  theme,
  saving,
  performanceMode,
  activeWinId,
  bringToFront,
  setActiveWinId,
  setActiveUtilityId,
  setOpenWindows,
  handleClose,
  handleSave,
  handleVarChange,
  handleAddVar,
  handleDeleteVar,
  handleRestore,
  handleWindowMaximize,
}: EnvWindowItemProps) => {
  const handleCloseWin = useCallback(() => {
    handleWindowMaximize(w.id, false);
    handleClose(w.id);
  }, [handleClose, handleWindowMaximize, w.id]);

  const handleMinimizeWin = useCallback(() => {
    setOpenWindows(ws => ws.map(x => x.id === w.id ? { ...x, minimized: true } : x));
    setActiveWinId(null);
    handleWindowMaximize(w.id, false);
  }, [handleWindowMaximize, setActiveWinId, setOpenWindows, w.id]);

  const handleFocusWin = useCallback(() => {
    bringToFront(w.id);
    setActiveUtilityId(null);
  }, [bringToFront, setActiveUtilityId, w.id]);

  const handleMoveWin = useCallback((x: number, y: number) => {
    setOpenWindows(ws => ws.map(win => win.id === w.id ? { ...win, pos: { x, y } } : win));
  }, [setOpenWindows, w.id]);

  const handleUpdateVar = useCallback((idx: number, field: 'key' | 'value' | 'comment', val: string) => {
    handleVarChange(w.id, idx, field, val);
  }, [handleVarChange, w.id]);

  const handleAddVarWin = useCallback(() => {
    handleAddVar(w.id);
  }, [handleAddVar, w.id]);

  const handleDeleteVarWin = useCallback((idx: number) => {
    handleDeleteVar(w.id, idx);
  }, [handleDeleteVar, w.id]);

  const handleSaveWin = useCallback(() => {
    handleSave(w.id);
  }, [handleSave, w.id]);

  const handleRestoreWin = useCallback(() => {
    handleRestore(w.id);
  }, [handleRestore, w.id]);

  const handleMaximizeWin = useCallback((isMax: boolean) => {
    handleWindowMaximize(w.id, isMax);
    setOpenWindows(ws => ws.map(win => win.id === w.id ? { ...win, maximized: isMax } : win));
  }, [handleWindowMaximize, setOpenWindows, w.id]);

  return (
    <MacWindow
      id={w.id}
      title={`${getDisplayName(w.file.name)}`}
      icon={getIconForType(w.file.name, w.file.type)}
      safeArea={desktopSafeArea}
      zIndex={w.z}
      isActive={activeWinId === w.id}
      isMinimized={w.minimized}
      performanceMode={performanceMode}
      initialPos={w.pos}
      initialMaximized={!!w.maximized}
      onClose={handleCloseWin}
      onMinimize={handleMinimizeWin}
      onMaximize={handleMaximizeWin}
      onFocus={handleFocusWin}
      onMove={handleMoveWin}
    >
      <EnvEditor
        appName={getDisplayName(w.file.name)}
        vars={w.editedVars}
        onUpdate={handleUpdateVar}
        onAdd={handleAddVarWin}
        onDelete={handleDeleteVarWin}
        onSave={handleSaveWin}
        onRestore={handleRestoreWin}
        saving={saving}
        isExample={!w.file.hasEnv && w.file.hasExample}
        theme={theme}
      />
    </MacWindow>
  );
});

export const DesktopView: React.FC<DesktopViewProps> = (props) => {
  const {
    isSolidColor,
    currentWallpaper,
    wallpaperFit,
    brightness,
    setBrightness,
    theme,
    toggleTheme,
    showDock,
    toggleDock,
    openWindows,
    setOpenWindows,
    activeWinId,
    setActiveWinId,
    bringToFront,
    allocateZ,
    handleClose,
    handleSave,
    handleVarChange,
    handleAddVar,
    handleDeleteVar,
    handleRestore,
    saving,
    desktopIcons,
    desktopFolders,
    terminalWindows,
    setTerminalWindows,
    activeTerminalId,
    bringTerminalToFront,
    handleCloseTerminal,
    handleMinimizeTerminal,
    launchpadOpen,
    setLaunchpadOpen,
    allItems,
    recordUsage,
    openWindow,
    dockFavorites,
    setDockFavorites,
    uniqueDockItems,
    toasts,
    removeToast,
    dialogOpen,
    dialogConfig,
    setDialogOpen,
    wallpapers,
    defaultWallpapers,
    BING_WALLPAPER,
    SOLID_COLORS,
    handleWallpaperSelect,
    handleUploadWallpaper,
    handleDeleteWallpaper,
    setWallpaperFit,
    wallpaperInterval,
    setWallpaperInterval,
    loadConfigs,
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
    presetsState,
    addToast,
    redisState,
    devCenterOpen,
    setDevCenterOpen,
    devCenterMinimized,
    setDevCenterMinimized,
    deepWikiOpen,
    setDeepWikiOpen,
    deepWikiMinimized,
    setDeepWikiMinimized,
  } = props;

  // Folder & window state
  const [openFolder, setOpenFolder] = useState<{
    id: string;
    anchorRect?: { left: number; top: number; width: number; height: number };
  } | null>(null);
  const [activeUtilityId, setActiveUtilityId] = useState<string | null>(null);
  const [maximizedWindowIds, setMaximizedWindowIds] = useState<string[]>([]);
  const [utilityZMap, setUtilityZMap] = useState<Record<string, number>>({});

  const [sideTabsCollapsed, setSideTabsCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem('sentra_side_tabs_collapsed');
      if (saved != null) return saved === 'true';
    } catch {
      // ignore
    }
    return true;
  });
  const MENU_BAR_HEIGHT = 30;
  const SIDE_TABS_COLLAPSED_WIDTH = 44;
  const SIDE_TABS_EXPANDED_WIDTH = 220;
  const BOTTOM_SAFE = 0;

  const handleSideTabsCollapsedChange = useCallback((collapsed: boolean) => {
    setSideTabsCollapsed(collapsed);
    try {
      localStorage.setItem('sentra_side_tabs_collapsed', String(collapsed));
    } catch {
      // ignore
    }
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
    (presetsEditorOpen ? 1 : 0) +
    (presetImporterOpen ? 1 : 0) +
    (fileManagerOpen ? 1 : 0) +
    (redisState.redisEditorOpen ? 1 : 0);

  const dockPerformanceMode = (openWindows.length + terminalWindows.length + openUtilityCount) > 3;

  const performanceMode =
    maximizedWindowIds.length > 0 ||
    (openWindows.length + terminalWindows.length + openUtilityCount) >= 4;

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
    handleClose(id);
  }, [handleClose]);

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
    if (redisState.redisEditorOpen && utilityZMap['redis-editor'] == null) {
      bringUtilityToFront('redis-editor');
    }
  }, [redisState.redisEditorOpen, utilityZMap, bringUtilityToFront]);

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

  if (redisState.redisEditorOpen) {
    extraTabs.push({
      id: 'redis-editor',
      title: 'Redis 编辑器',
      icon: getIconForType('redis-editor', 'module'),
      isActive: activeUtilityId === 'redis-editor',
      onActivate: () => {
        redisState.setRedisEditorOpen(true);
        redisState.setMinimized(false);
        bringUtilityToFront('redis-editor');
      },
      onClose: () => {
        redisState.setRedisEditorOpen(false);
        redisState.setMinimized(false);
        if (activeUtilityId === 'redis-editor') {
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

  const { show } = useContextMenu({ id: 'desktop-menu' });
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
      name: 'redis-editor',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:redis');
        redisState.setRedisEditorOpen(true);
        redisState.setMinimized(false);
        bringUtilityToFront('redis-editor');
      }
    },
    ...allItems.map(item => ({
      name: item.name,
      type: item.type,
      onClick: () => {
        recordUsage(`${item.type}:${item.name}`);
        openWindow(item);
        const key = `${item.type}-${item.name}`;
        if (!dockFavorites.includes(key)) {
          setDockFavorites(prev => [...prev, key]);
        }
      }
    }))
  ];

  // Desktop 根布局：顶层使用 .desktop-container，内部使用 .desktop-main 承载壁纸和所有窗口
  return (
    <div className="desktop-container">
      {/* 顶部系统菜单栏 */}
      <MenuBar
        brightness={brightness}
        setBrightness={setBrightness}
        theme={theme}
        onToggleTheme={toggleTheme}
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
          backgroundSize: wallpaperFit,
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
        {/* Dev Center 主窗口：概览 Apps / Plugins 列表，可通过 Dock / 启动台 打开 */}
        {devCenterOpen && (
          <MacWindow
            id="dev-center"
            title="开发中心"
            icon={getIconForType('dev-center', 'module')}
            safeArea={desktopSafeArea}
            zIndex={utilityZMap['dev-center'] ?? 2000}
            isActive={activeUtilityId === 'dev-center'}
            isMinimized={devCenterMinimized}
            performanceMode={performanceMode}
            initialSize={{ width: 940, height: 620 }}
            onClose={() => {
              handleWindowMaximize('dev-center', false);
              setDevCenterOpen(false);
              setDevCenterMinimized(false);
            }}
            onMinimize={() => {
              handleWindowMaximize('dev-center', false);
              setDevCenterMinimized(true);
              setActiveUtilityId(null);
            }}
            onMaximize={(isMax) => handleWindowMaximize('dev-center', isMax)}
            onFocus={() => { bringUtilityToFront('dev-center'); }}
            onMove={() => { }}
          >
            <DevCenterV2
              allItems={allItems}
              onOpenItem={(file) => openWindow(file, { maximize: true })}
              onOpenDeepWiki={handleOpenDeepWiki}
            />
          </MacWindow>
        )}

        {presetImporterOpen && (
          <MacWindow
            id="preset-importer"
            title="预设导入"
            icon={getIconForType('preset-importer', 'module')}
            safeArea={desktopSafeArea}
            zIndex={utilityZMap['preset-importer'] ?? 2003}
            isActive={activeUtilityId === 'preset-importer'}
            isMinimized={presetImporterMinimized}
            performanceMode={performanceMode}
            initialSize={{ width: 880, height: 600 }}
            onClose={() => {
              handleWindowMaximize('preset-importer', false);
              setPresetImporterOpen(false);
              setPresetImporterMinimized(false);
            }}
            onMinimize={() => {
              handleWindowMaximize('preset-importer', false);
              setPresetImporterMinimized(true);
              setActiveUtilityId(null);
            }}
            onMaximize={(isMax) => handleWindowMaximize('preset-importer', isMax)}
            onFocus={() => { bringUtilityToFront('preset-importer'); }}
            onMove={() => { }}
          >
            <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载中...</div>}>
              <PresetImporter
                onClose={() => setPresetImporterOpen(false)}
                theme={theme}
                addToast={addToast as any}
                state={presetsState}
              />
            </Suspense>
          </MacWindow>
        )}

        {deepWikiOpen && (
          <MacWindow
            id="deepwiki"
            title="DeepWiki · Sentra Agent"
            icon={<IoBookOutline style={{ color: '#2563eb' }} />}
            safeArea={desktopSafeArea}
            zIndex={utilityZMap['deepwiki'] ?? 2001}
            isActive={activeUtilityId === 'deepwiki'}
            isMinimized={deepWikiMinimized}
            performanceMode={performanceMode}
            initialSize={{ width: 960, height: 640 }}
            onClose={() => {
              handleWindowMaximize('deepwiki', false);
              setDeepWikiOpen(false);
              setDeepWikiMinimized(false);
            }}
            onMinimize={() => {
              handleWindowMaximize('deepwiki', false);
              setDeepWikiMinimized(true);
              setActiveUtilityId(null);
            }}
            onMaximize={(isMax) => handleWindowMaximize('deepwiki', isMax)}
            onFocus={() => { bringUtilityToFront('deepwiki'); }}
            onMove={() => { }}
          >
            <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载 DeepWiki 助手...</div>}>
              <DeepWikiChat theme={theme} />
            </Suspense>
          </MacWindow>
        )}

        {/* 环境变量编辑窗口 */}
        {openWindows.map(w => (
          <EnvWindowItem
            key={w.id}
            w={w}
            desktopSafeArea={desktopSafeArea}
            theme={theme}
            saving={saving}
            performanceMode={performanceMode}
            activeWinId={activeWinId}
            bringToFront={bringToFront}
            setActiveWinId={setActiveWinId}
            setActiveUtilityId={setActiveUtilityId}
            setOpenWindows={setOpenWindows}
            handleClose={handleClose}
            handleSave={handleSave}
            handleVarChange={handleVarChange}
            handleAddVar={handleAddVar}
            handleDeleteVar={handleDeleteVar}
            handleRestore={handleRestore}
            handleWindowMaximize={handleWindowMaximize}
          />
        ))}

        {/* 预设、文件管理、Redis 编辑器等独立工具窗口 */}
        {presetsEditorOpen && (
          <MacWindow
            id="presets-editor"
            title="预设撰写"
            icon={getIconForType('agent-presets', 'module')}
            safeArea={desktopSafeArea}
            zIndex={utilityZMap['presets-editor'] ?? 2002}
            isActive={activeUtilityId === 'presets-editor'}
            isMinimized={presetsEditorMinimized}
            performanceMode={performanceMode}
            initialSize={{ width: 900, height: 600 }}
            onClose={() => {
              handleWindowMaximize('presets-editor', false);
              setPresetsEditorOpen(false);
              setPresetsEditorMinimized(false);
            }}
            onMinimize={() => {
              handleWindowMaximize('presets-editor', false);
              setPresetsEditorMinimized(true);
              setActiveUtilityId(null);
            }}
            onMaximize={(isMax) => handleWindowMaximize('presets-editor', isMax)}
            onFocus={() => { bringUtilityToFront('presets-editor'); }}
            onMove={() => { }}
          >
            <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载中...</div>}>
              <PresetsEditor
                onClose={() => setPresetsEditorOpen(false)}
                theme={theme}
                addToast={addToast}
                state={presetsState}
                performanceMode={performanceMode}
                onOpenPresetImporter={() => {
                  setPresetImporterOpen(true);
                  setPresetImporterMinimized(false);
                  bringUtilityToFront('preset-importer');
                }}
              />
            </Suspense>
          </MacWindow>
        )}

        {fileManagerOpen && (
          <MacWindow
            id="file-manager"
            title="文件管理"
            icon={getIconForType('file-manager', 'module')}
            safeArea={desktopSafeArea}
            zIndex={utilityZMap['file-manager'] ?? 2004}
            isActive={activeUtilityId === 'file-manager'}
            isMinimized={fileManagerMinimized}
            performanceMode={performanceMode}
            initialSize={{ width: 1000, height: 700 }}
            onClose={() => {
              handleWindowMaximize('file-manager', false);
              setFileManagerOpen(false);
              setFileManagerMinimized(false);
            }}
            onMinimize={() => {
              handleWindowMaximize('file-manager', false);
              setFileManagerMinimized(true);
              setActiveUtilityId(null);
            }}
            onMaximize={(isMax) => handleWindowMaximize('file-manager', isMax)}
            onFocus={() => { bringUtilityToFront('file-manager'); }}
            onMove={() => { }}
          >
            <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载中...</div>}>
              <FileManager
                onClose={() => setFileManagerOpen(false)}
                theme={theme}
                addToast={addToast}
                performanceMode={performanceMode}
              />
            </Suspense>
          </MacWindow>
        )}

        {redisState.redisEditorOpen && (
          <MacWindow
            id="redis-editor"
            title="Redis 连接编辑器"
            icon={getIconForType('redis-editor', 'module')}
            safeArea={desktopSafeArea}
            zIndex={utilityZMap['redis-editor'] ?? 2005}
            isActive={activeUtilityId === 'redis-editor'}
            isMinimized={!!redisState.minimized}
            performanceMode={performanceMode}
            initialSize={{ width: 1000, height: 650 }}
            onClose={() => {
              handleWindowMaximize('redis-editor', false);
              redisState.setRedisEditorOpen(false);
              redisState.setMinimized(false);
            }}
            onMinimize={() => {
              handleWindowMaximize('redis-editor', false);
              redisState.setMinimized(true);
              setActiveUtilityId(null);
            }}
            onMaximize={(isMax) => handleWindowMaximize('redis-editor', isMax)}
            onFocus={() => { bringUtilityToFront('redis-editor'); }}
            onMove={() => { }}
          >
            <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载中...</div>}>
              <RedisEditor theme={theme} state={redisState} />
            </Suspense>
          </MacWindow>
        )}

        {/* 桌面图标 / 文件夹 */}
        {desktopFolders ? (
          <>
            {/* 顶部应用区域：文件夹 + 关键应用图标，统一宽度与间距 */}
            <div
              style={{
                position: 'absolute',
                left: 30,
                top: 80,
                display: 'flex',
                gap: 32,
              }}
            >
              {desktopFolders.map(folder => (
                renderTopTile(folder.id, folder.name, folder.icon, (e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setOpenFolder({
                    id: folder.id,
                    anchorRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                  });
                })
              ))}

              {desktopIcons?.find(i => i.id === 'desktop-filemanager') && (() => {
                const icon = desktopIcons.find(i => i.id === 'desktop-filemanager')!;
                return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
                  e.stopPropagation();
                  icon.onClick();
                });
              })()}

              {desktopIcons?.find(i => i.id === 'desktop-preset-importer') && (() => {
                const icon = desktopIcons.find(i => i.id === 'desktop-preset-importer')!;
                return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
                  e.stopPropagation();
                  icon.onClick();
                });
              })()}

              {desktopIcons?.find(i => i.id === 'desktop-redis') && (() => {
                const icon = desktopIcons.find(i => i.id === 'desktop-redis')!;
                return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
                  e.stopPropagation();
                  icon.onClick();
                });
              })()}

              {desktopIcons?.find(i => i.id === 'desktop-dev-center') && (() => {
                const icon = desktopIcons.find(i => i.id === 'desktop-dev-center')!;
                return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
                  e.stopPropagation();
                  icon.onClick();
                });
              })()}

              {desktopIcons?.find(i => i.id === 'desktop-presets') && (() => {
                const icon = desktopIcons.find(i => i.id === 'desktop-presets')!;
                return renderTopTile(icon.id, icon.name, icon.icon, (e) => {
                  e.stopPropagation();
                  icon.onClick();
                });
              })()}
            </div>

            {/* Folder Modal */}
            {openFolder && (
              <AppFolderModal
                folder={desktopFolders.find(f => f.id === openFolder.id)!}
                anchorRect={openFolder.anchorRect}
                theme={theme}
                onAppClick={(_, onClick) => onClick()}
                onClose={() => setOpenFolder(null)}
              />
            )}
          </>
        ) : desktopIcons && (
          /* 没有文件夹时，直接渲染图标 */
          desktopIcons.map(icon => (
            <div
              key={icon.id}
              style={{
                position: 'absolute',
                left: icon.position.x,
                top: icon.position.y,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                cursor: 'pointer',
                padding: '8px',
                borderRadius: '8px',
                transition: 'background 0.2s',
                width: 80,
              }}
              onClick={icon.onClick}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ marginBottom: 4 }}>{icon.icon}</div>
              <div style={{
                fontSize: 12,
                color: 'white',
                textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                fontWeight: 500,
                textAlign: 'center',
                lineHeight: 1.2,
              }}>
                {icon.name}
              </div>
            </div>
          ))
        )}

        {/* 终端窗口 */}
        {terminalWindows.map(terminal => (
          <MacWindow
            key={terminal.id}
            id={terminal.id}
            title={terminal.title}
            icon={<span style={{ fontSize: '16px', display: 'flex', alignItems: 'center' }}>{terminal.title.includes('Bootstrap') ? <IoCubeOutline /> : <IoTerminalOutline />}</span>}
            initialPos={terminal.pos}
            safeArea={desktopSafeArea}
            zIndex={terminal.z}
            isActive={activeTerminalId === terminal.id}
            isMinimized={terminal.minimized}
            performanceMode={performanceMode}
            onClose={() => {
              handleWindowMaximize(terminal.id, false);
              handleCloseTerminal(terminal.id);
            }}
            onMinimize={() => {
              handleWindowMaximize(terminal.id, false);
              handleMinimizeTerminal(terminal.id);
            }}
            onMaximize={(isMax) => handleWindowMaximize(terminal.id, isMax)}
            onFocus={() => bringTerminalToFront(terminal.id)}
            onMove={(x, y) => { setTerminalWindows(prev => prev.map(w => w.id === terminal.id ? { ...w, pos: { x, y } } : w)); }}
          >
            <TerminalWindow
              processId={terminal.processId}
              theme={terminal.theme}
              headerText={terminal.headerText}
            />
          </MacWindow>
        ))}

        {/* Launchpad 与 Dock、通知、对话框 等 */}
        <Launchpad
          isOpen={launchpadOpen}
          onClose={() => setLaunchpadOpen(false)}
          items={launchpadItems}
        />

        <div style={{ display: showDock ? 'block' : 'none' }}>
          <Dock performanceMode={dockPerformanceMode} items={uniqueDockItems.slice(0, 16)} />
        </div>

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

        <Menu id="desktop-menu" theme="light" animation="scale">
          <Submenu label="切换壁纸">
            {wallpapers.map((wp, i) => (
              <Item key={i} onClick={() => handleWallpaperSelect(wp)}>
                壁纸 {i + 1}
              </Item>
            ))}
            <Item onClick={() => handleWallpaperSelect(BING_WALLPAPER)}>Bing 每日壁纸</Item>
            <Submenu label="纯色背景">
              {SOLID_COLORS.map(c => (
                <Item key={c.name} onClick={() => handleWallpaperSelect(c.value)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 12, height: 12, background: c.value, border: '1px solid #ddd' }} />
                    {c.name}
                  </div>
                </Item>
              ))}
            </Submenu>
          </Submenu>
          <Item onClick={handleUploadWallpaper}>上传壁纸...</Item>
          <Item
            onClick={() => handleDeleteWallpaper()}
            disabled={defaultWallpapers.includes(currentWallpaper) || currentWallpaper === BING_WALLPAPER || SOLID_COLORS.some(c => c.value === currentWallpaper)}
          >
            删除当前壁纸
          </Item>
          <Item onClick={() => setWallpaperFit(wallpaperFit === 'cover' ? 'contain' : 'cover')}>
            壁纸填充: {wallpaperFit === 'cover' ? '覆盖 (Cover)' : '包含 (Contain)'}
          </Item>
          <Item onClick={() => setWallpaperInterval(i => (i === 0 ? 60 : 0))}>
            {wallpaperInterval > 0 ? '停止壁纸轮播' : '开启壁纸轮播 (1min)'}
          </Item>
          <Item onClick={() => loadConfigs()}>刷新</Item>
        </Menu>
      </div>
    </div>
  );
}
