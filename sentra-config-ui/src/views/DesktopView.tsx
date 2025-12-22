import { useState, useCallback, Suspense, lazy, type Dispatch, type SetStateAction, type ReactNode } from 'react';
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
import { TopTaskbar } from '../components/TopTaskbar';
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
  openWindow: (file: FileItem) => void;
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
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [maximizedWindowIds, setMaximizedWindowIds] = useState<string[]>([]);
  const [activeUtilityId, setActiveUtilityId] = useState<string | null>(null);

  const handleWindowMaximize = (id: string, isMaximized: boolean) => {
    setMaximizedWindowIds(prev => {
      if (isMaximized) {
        if (prev.includes(id)) return prev;
        return [...prev, id];
      }
      return prev.filter(x => x !== id);
    });
  };

  const hasMaximizedWindow = maximizedWindowIds.length > 0;

  const renderTopTile = useCallback((key: string, label: string, icon: ReactNode, onClick: () => void) => {
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
        setActiveUtilityId('dev-center');
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
        setActiveUtilityId('deepwiki');
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
        setActiveUtilityId('presets-editor');
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
        setActiveUtilityId('file-manager');
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
        setActiveUtilityId('redis-editor');
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
        setActiveUtilityId('preset-importer');
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
      }
    },
    {
      name: 'presets-editor',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:presets');
        setPresetsEditorOpen(true);
        setPresetsEditorMinimized(false);
        setActiveUtilityId('presets-editor');
      }
    },
    {
      name: 'preset-importer',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:preset-importer');
        setPresetImporterOpen(true);
        setPresetImporterMinimized(false);
        setActiveUtilityId('preset-importer');
      }
    },
    {
      name: 'file-manager',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:filemanager');
        setFileManagerOpen(true);
        setFileManagerMinimized(false);
        setActiveUtilityId('file-manager');
      }
    },
    {
      name: 'redis-editor',
      type: 'module' as const,
      onClick: () => {
        recordUsage('app:redis');
        redisState.setRedisEditorOpen(true);
        redisState.setMinimized(false);
        setActiveUtilityId('redis-editor');
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
          setActiveUtilityId('deepwiki');
        }}
      />

      {/* 顶部任务栏：在有窗口全屏时隐藏，避免遮挡应用右上角按钮 */}
      {!hasMaximizedWindow && (
        <TopTaskbar
          openWindows={openWindows}
          terminalWindows={terminalWindows}
          activeWinId={activeWinId}
          activeTerminalId={activeTerminalId}
          onActivateWindow={(id) => {
            bringToFront(id);
            setActiveUtilityId(null);
          }}
          onActivateTerminal={(id) => {
            bringTerminalToFront(id);
            setActiveUtilityId(null);
          }}
          onCloseWindow={(id) => {
            handleWindowMaximize(id, false);
            handleClose(id);
          }}
          onCloseTerminal={(id) => {
            handleWindowMaximize(id, false);
            handleCloseTerminal(id);
          }}
          extraTabs={extraTabs}
        />
      )}

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
            zIndex={80}
            isActive={!activeWinId}
            isMinimized={devCenterMinimized}
            initialSize={{ width: 960, height: 620 }}
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
            onFocus={() => { setActiveUtilityId('dev-center'); }}
            onMove={() => { }}
          >
            <DevCenterV2
              allItems={allItems}
              onOpenItem={openWindow}
              addToast={addToast}
            />
          </MacWindow>
        )}

        {presetImporterOpen && (
          <MacWindow
            id="preset-importer"
            title="预设导入"
            icon={getIconForType('preset-importer', 'module')}
            zIndex={103}
            isActive={true}
            isMinimized={presetImporterMinimized}
            initialSize={{ width: 980, height: 620 }}
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
            onFocus={() => { setActiveUtilityId('preset-importer'); }}
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
            zIndex={90}
            isActive={!activeWinId}
            isMinimized={deepWikiMinimized}
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
            onFocus={() => { setActiveUtilityId('deepwiki'); }}
            onMove={() => { }}
          >
            <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载 DeepWiki 助手...</div>}>
              <DeepWikiChat theme={theme} />
            </Suspense>
          </MacWindow>
        )}

        {/* 环境变量编辑窗口 */}
        {openWindows.map(w => (
          <MacWindow
            key={w.id}
            id={w.id}
            title={`${getDisplayName(w.file.name)}`}
            icon={getIconForType(w.file.name, w.file.type)}
            zIndex={w.z}
            isActive={activeWinId === w.id}
            isMinimized={w.minimized}
            initialPos={w.pos}
            onClose={() => {
              handleWindowMaximize(w.id, false);
              handleClose(w.id);
            }}
            onMinimize={() => {
              setOpenWindows(ws => ws.map(x => x.id === w.id ? { ...x, minimized: true } : x));
              setActiveWinId(null);
              handleWindowMaximize(w.id, false);
            }}
            onMaximize={(isMax) => handleWindowMaximize(w.id, isMax)}
            onFocus={() => {
              bringToFront(w.id);
              setActiveUtilityId(null);
            }}
            onMove={(x, y) => {
              setOpenWindows(ws => ws.map(win => win.id === w.id ? { ...win, pos: { x, y } } : win));
            }}
          >
            <EnvEditor
              appName={getDisplayName(w.file.name)}
              vars={w.editedVars}
              onUpdate={(idx, field, val) => handleVarChange(w.id, idx, field, val)}
              onAdd={() => handleAddVar(w.id)}
              onDelete={(idx) => handleDeleteVar(w.id, idx)}
              onSave={() => handleSave(w.id)}
              onRestore={() => handleRestore(w.id)}
              saving={saving}
              isExample={!w.file.hasEnv && w.file.hasExample}
              theme={theme}
            />
          </MacWindow>
        ))}

        {/* 预设、文件管理、Redis 编辑器等独立工具窗口 */}
        {presetsEditorOpen && (
          <MacWindow
            id="presets-editor"
            title="预设撰写"
            icon={getIconForType('agent-presets', 'module')}
            zIndex={100}
            isActive={true}
            isMinimized={presetsEditorMinimized}
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
            onFocus={() => { setActiveUtilityId('presets-editor'); }}
            onMove={() => { }}
          >
            <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载中...</div>}>
              <PresetsEditor
                onClose={() => setPresetsEditorOpen(false)}
                theme={theme}
                addToast={addToast}
                state={presetsState}
                onOpenPresetImporter={() => {
                  setPresetImporterOpen(true);
                  setPresetImporterMinimized(false);
                  setActiveUtilityId('preset-importer');
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
            zIndex={101}
            isActive={true}
            isMinimized={fileManagerMinimized}
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
            onFocus={() => { setActiveUtilityId('file-manager'); }}
            onMove={() => { }}
          >
            <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载中...</div>}>
              <FileManager
                onClose={() => setFileManagerOpen(false)}
                theme={theme}
                addToast={addToast}
              />
            </Suspense>
          </MacWindow>
        )}

        {redisState.redisEditorOpen && (
          <MacWindow
            id="redis-editor"
            title="Redis 连接编辑器"
            icon={getIconForType('redis-editor', 'module')}
            zIndex={102}
            isActive={true}
            isMinimized={!!redisState.minimized}
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
            onFocus={() => { setActiveUtilityId('redis-editor'); }}
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
                renderTopTile(folder.id, folder.name, folder.icon, () => setOpenFolderId(folder.id))
              ))}

              {desktopIcons?.find(i => i.id === 'desktop-filemanager') && (() => {
                const icon = desktopIcons.find(i => i.id === 'desktop-filemanager')!;
                return renderTopTile(icon.id, icon.name, icon.icon, icon.onClick);
              })()}

              {desktopIcons?.find(i => i.id === 'desktop-preset-importer') && (() => {
                const icon = desktopIcons.find(i => i.id === 'desktop-preset-importer')!;
                return renderTopTile(icon.id, icon.name, icon.icon, icon.onClick);
              })()}

              {desktopIcons?.find(i => i.id === 'desktop-redis') && (() => {
                const icon = desktopIcons.find(i => i.id === 'desktop-redis')!;
                return renderTopTile(icon.id, icon.name, icon.icon, icon.onClick);
              })()}

              {desktopIcons?.find(i => i.id === 'desktop-dev-center') && (() => {
                const icon = desktopIcons.find(i => i.id === 'desktop-dev-center')!;
                return renderTopTile(icon.id, icon.name, icon.icon, icon.onClick);
              })()}

              {desktopIcons?.find(i => i.id === 'desktop-presets') && (() => {
                const icon = desktopIcons.find(i => i.id === 'desktop-presets')!;
                return renderTopTile(icon.id, icon.name, icon.icon, icon.onClick);
              })()}
            </div>

            {/* Folder Modal */}
            {openFolderId && (
              <AppFolderModal
                folder={desktopFolders.find(f => f.id === openFolderId)!}
                onAppClick={(_, onClick) => onClick()}
                onClose={() => setOpenFolderId(null)}
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
            zIndex={terminal.z}
            isActive={activeTerminalId === terminal.id}
            isMinimized={terminal.minimized}
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

        {showDock && <Dock items={uniqueDockItems.slice(0, 16)} />}

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
