import { useState, useEffect, useCallback, useMemo, Suspense, lazy } from 'react';
import { ConfigData } from './types/config';
import { fetchConfigs, verifyToken, waitForBackend } from './services/api';
import { LoginScreen } from './components/LoginScreen';
import { getIconForType, getDisplayName } from './utils/icons';
import { buildDesktopIcons, buildDesktopFolders } from './utils/buildDesktopIcons';
import type { ToastMessage } from './components/Toast';
import { useDevice } from './hooks/useDevice';
import 'react-contexify/dist/ReactContexify.css';
import './styles/macOS.css';
import './styles/ios.css';
// Lazy load views
const MobileView = lazy(() => import('./views/MobileView').then(module => ({ default: module.MobileView })));
const DesktopView = lazy(() => import('./views/DesktopView').then(module => ({ default: module.DesktopView })));
import { FileItem, DesktopIcon, AppFolder } from './types/ui';
import { DEFAULT_WALLPAPERS, BING_WALLPAPER, SOLID_COLORS } from './constants/wallpaper';
import { useIOSEditor } from './hooks/useIOSEditor';
import { useTerminals } from './hooks/useTerminals';
import { useWallpaper } from './hooks/useWallpaper';
import { WallpaperEditorModal } from './components/WallpaperEditorModal';
import { useUsageCounts } from './hooks/useUsageCounts';
import { useDockFavorites } from './hooks/useDockFavorites';
import { useDesktopWindows } from './hooks/useDesktopWindows';
import { loader } from '@monaco-editor/react';
import { usePresetsEditor } from './hooks/usePresetsEditor';
import * as monaco from 'monaco-editor';

// Configure Monaco to use local instance (bundled) instead of CDN
loader.config({ monaco: monaco as any });





function App() {
  const { isMobile, isTablet } = useDevice();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [configData, setConfigData] = useState<ConfigData | null>(null);
  const [saving, setSaving] = useState(false);

  const normalizeHexColor = (v: string) => {
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toUpperCase();
    const m = s.match(/^#([0-9a-fA-F]{3})$/);
    if (m) {
      const [r, g, b] = m[1].split('');
      return (`#${r}${r}${g}${g}${b}${b}`).toUpperCase();
    }
    return '';
  };

  const hexToRgb = (hex: string) => {
    const v = normalizeHexColor(hex);
    if (!v) return null;
    const n = parseInt(v.slice(1), 16);
    if (!Number.isFinite(n)) return null;
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
    };
  };

  const getContrastColor = (rgb: { r: number; g: number; b: number }) => {
    const l = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return l > 0.65 ? '#000000' : '#FFFFFF';
  };

  const readBool = (key: string, fallback = false) => {
    try {
      const v = localStorage.getItem(key);
      if (v == null) return fallback;
      return v === 'true';
    } catch {
      return fallback;
    }
  };

  // Toasts first (used by hooks below)
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const addToast = useCallback((type: ToastMessage['type'], title: string, message?: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, type, title, message }]);
  }, []);
  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Desktop windows state via hook
  const {
    openWindows,
    setOpenWindows,
    activeWinId,
    setActiveWinId,
    bringToFront,
    allocateZ,
    openWindow,
    handleClose,
    handleSave,
    handleVarChange,
    handleAddVar,
    handleDeleteVar,
    handleRestore,
  } = useDesktopWindows({ setSaving, addToast, loadConfigs, onLogout: handleLogout });

  const [launchpadOpen, setLaunchpadOpen] = useState(false);

  // Theme state
  const theme: 'light' = 'light';

  const [accentColor, setAccentColor] = useState<string>(() => {
    const saved = normalizeHexColor(localStorage.getItem('sentra_accent_color') || '');
    return saved || '#007AFF';
  });

  // Desktop Dock visibility
  const [showDock, setShowDock] = useState<boolean>(() => {
    const saved = localStorage.getItem('sentra_show_dock');
    return saved ? saved === 'true' : true;
  });
  const toggleDock = () => {
    setShowDock(prev => {
      const next = !prev;
      localStorage.setItem('sentra_show_dock', String(next));
      return next;
    });
  };

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogConfig, setDialogConfig] = useState({
    title: '',
    message: '',
    onConfirm: () => { },
    type: 'info' as 'info' | 'warning' | 'error'
  });





  // Wallpaper / brightness / rotation via hook
  const {
    wallpapers,
    currentWallpaper,

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
  } = useWallpaper(addToast);

  const wallpaperTargetAspect = useMemo(() => {
    try {
      const desktopMain = document.querySelector('.desktop-main') as HTMLElement | null;
      if (desktopMain) {
        const rect = desktopMain.getBoundingClientRect();
        const w = Math.max(1, rect.width || 1);
        const h = Math.max(1, rect.height || 1);
        return w / h;
      }

      const w = Math.max(1, window.innerWidth || 1);
      const h = Math.max(1, window.innerHeight || 1);
      return w / h;
    } catch {
      return 16 / 9;
    }
  }, [wallpaperEditorOpen]);

  const wallpaperTargetSize = useMemo(() => {
    try {
      const desktopMain = document.querySelector('.desktop-main') as HTMLElement | null;
      if (desktopMain) {
        const rect = desktopMain.getBoundingClientRect();
        return {
          w: Math.max(1, Math.round(rect.width || 1)),
          h: Math.max(1, Math.round(rect.height || 1)),
        };
      }
    } catch {
      // ignore
    }
    return null;
  }, [wallpaperEditorOpen]);

  // Usage counts via hook
  const { usageCounts, recordUsage } = useUsageCounts();

  // Dock favorites via hook
  const { dockFavorites, setDockFavorites } = useDockFavorites();

  useEffect(() => {
    try {
      localStorage.setItem('sentra_theme', 'light');
      document.documentElement.setAttribute('data-theme', theme);
      document.body.setAttribute('data-theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    const next = normalizeHexColor(accentColor) || '#007AFF';
    const rgb = hexToRgb(next);
    if (!rgb) return;
    const contrast = getContrastColor(rgb);

    try {
      localStorage.setItem('sentra_accent_color', next);
    } catch {
      // ignore
    }

    try {
      const rgbStr = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
      document.documentElement.style.setProperty('--sentra-accent', next);
      document.documentElement.style.setProperty('--sentra-accent-rgb', rgbStr);
      document.documentElement.style.setProperty('--sentra-accent-contrast', contrast);
      document.body.style.setProperty('--sentra-accent', next);
      document.body.style.setProperty('--sentra-accent-rgb', rgbStr);
      document.body.style.setProperty('--sentra-accent-contrast', contrast);
    } catch {
      // ignore
    }
  }, [accentColor]);

  // Terminal windows state via hook
  const {
    terminalWindows,
    setTerminalWindows,
    activeTerminalId,
    bringTerminalToFront,
    handleRunBootstrap,
    handleRunStart,
    handleRunNapcatBuild,
    handleRunNapcatStart,
    handleRunUpdate,
    handleRunForceUpdate,
    handleRunSentiment,
    handleCloseTerminal,
    handleMinimizeTerminal,
  } = useTerminals({ addToast, allocateZ });

  // iOS editor windows state via hook
  const {
    iosEditorWindows,
    activeIOSEditorId,
    openIOSWindow,
    minimize: handleIOSMinimizeEditor,
    close: handleIOSCloseEditor,
    changeVar: handleIOSVarChange,
    addVar: handleIOSAddVar,
    deleteVar: handleIOSDeleteVar,
    save: handleIOSSave,

  } = useIOSEditor({ setSaving, addToast, loadConfigs });

  // Presets Editor State via hook
  const presetsState = usePresetsEditor(addToast, isAuthenticated);
  // 开发中心默认不打开，由 Dock / 启动台显式唤起
  const [devCenterOpen, setDevCenterOpen] = useState(() => readBool('sentra_dev_center_open', false));
  const [devCenterMinimized, setDevCenterMinimized] = useState(() => readBool('sentra_dev_center_minimized', false));
  const [deepWikiOpen, setDeepWikiOpen] = useState(() => readBool('sentra_deepwiki_open', false));
  const [deepWikiMinimized, setDeepWikiMinimized] = useState(() => readBool('sentra_deepwiki_minimized', false));
  const [redisAdminOpen, setRedisAdminOpen] = useState(() => readBool('sentra_redis_admin_open', false));
  const [redisAdminMinimized, setRedisAdminMinimized] = useState(() => readBool('sentra_redis_admin_minimized', false));
  const [modelProvidersManagerOpen, setModelProvidersManagerOpen] = useState(() => readBool('sentra_model_providers_manager_open', false));
  const [modelProvidersManagerMinimized, setModelProvidersManagerMinimized] = useState(() => readBool('sentra_model_providers_manager_minimized', false));
  const [presetsEditorOpen, setPresetsEditorOpen] = useState(() => readBool('sentra_presets_editor_open', false));
  const [presetsEditorMinimized, setPresetsEditorMinimized] = useState(() => readBool('sentra_presets_editor_minimized', false));
  const [iosPresetsEditorOpen, setIosPresetsEditorOpen] = useState(false);
  const [presetImporterOpen, setPresetImporterOpen] = useState(() => readBool('sentra_preset_importer_open', false));
  const [presetImporterMinimized, setPresetImporterMinimized] = useState(() => readBool('sentra_preset_importer_minimized', false));
  const [iosPresetImporterOpen, setIosPresetImporterOpen] = useState(false);
  const [fileManagerOpen, setFileManagerOpen] = useState(() => readBool('sentra_file_manager_open', false));
  const [fileManagerMinimized, setFileManagerMinimized] = useState(() => readBool('sentra_file_manager_minimized', false));
  const [iosFileManagerOpen, setIosFileManagerOpen] = useState(false);
  const [iosModelProvidersManagerOpen, setIosModelProvidersManagerOpen] = useState(false);
  const [iosRedisAdminOpen, setIosRedisAdminOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('sentra_dev_center_open', String(devCenterOpen));
      localStorage.setItem('sentra_dev_center_minimized', String(devCenterMinimized));
      localStorage.setItem('sentra_deepwiki_open', String(deepWikiOpen));
      localStorage.setItem('sentra_deepwiki_minimized', String(deepWikiMinimized));
      localStorage.setItem('sentra_redis_admin_open', String(redisAdminOpen));
      localStorage.setItem('sentra_redis_admin_minimized', String(redisAdminMinimized));
      localStorage.setItem('sentra_model_providers_manager_open', String(modelProvidersManagerOpen));
      localStorage.setItem('sentra_model_providers_manager_minimized', String(modelProvidersManagerMinimized));
      localStorage.setItem('sentra_presets_editor_open', String(presetsEditorOpen));
      localStorage.setItem('sentra_presets_editor_minimized', String(presetsEditorMinimized));
      localStorage.setItem('sentra_preset_importer_open', String(presetImporterOpen));
      localStorage.setItem('sentra_preset_importer_minimized', String(presetImporterMinimized));
      localStorage.setItem('sentra_file_manager_open', String(fileManagerOpen));
      localStorage.setItem('sentra_file_manager_minimized', String(fileManagerMinimized));
    } catch {
      // ignore
    }
  }, [
    devCenterOpen,
    devCenterMinimized,
    deepWikiOpen,
    deepWikiMinimized,
    redisAdminOpen,
    redisAdminMinimized,
    modelProvidersManagerOpen,
    modelProvidersManagerMinimized,
    presetsEditorOpen,
    presetsEditorMinimized,
    presetImporterOpen,
    presetImporterMinimized,
    fileManagerOpen,
    fileManagerMinimized,
  ]);

  const handleOpenPresets = () => {
    if (isMobile || isTablet) {
      setIosPresetsEditorOpen(true);
    } else {
      setPresetsEditorOpen(true);
      setPresetsEditorMinimized(false);
    }
  };

  const handleOpenFileManager = () => {
    if (isMobile || isTablet) {
      setIosFileManagerOpen(true);
    } else {
      setFileManagerOpen(true);
      setFileManagerMinimized(false);
    }
  };

  const handleOpenPresetImporter = () => {
    if (isMobile || isTablet) {
      setIosPresetImporterOpen(true);
    } else {
      setPresetImporterOpen(true);
      setPresetImporterMinimized(false);
    }
  };

  const handleOpenRedisAdmin = () => {
    if (isMobile || isTablet) {
      setIosRedisAdminOpen(true);
      return;
    }
    setRedisAdminOpen(true);
    setRedisAdminMinimized(false);
  };

  const handleOpenModelProvidersManager = () => {
    if (isMobile || isTablet) {
      setIosModelProvidersManagerOpen(true);
      return;
    }
    setModelProvidersManagerOpen(true);
    setModelProvidersManagerMinimized(false);
  };

  // terminal run handlers now provided by useTerminals

  // close/minimize handled by useTerminals

  // iOS Editor handlers provided by useIOSEditor



  // Desktop icons (for mobile/iOS)
  const desktopIcons: DesktopIcon[] = buildDesktopIcons(
    recordUsage,
    handleRunBootstrap,
    handleRunStart,
    handleRunNapcatBuild,
    handleRunNapcatStart,
    handleRunUpdate,
    handleRunForceUpdate,
    handleRunSentiment,
    handleOpenPresets,
    handleOpenFileManager,
    () => {
      setDevCenterOpen(true);
      setDevCenterMinimized(false);
    },
    handleOpenPresetImporter,
    handleOpenModelProvidersManager,
    handleOpenRedisAdmin,
  );

  // Desktop folders (for desktop view)
  const desktopFolders: AppFolder[] = buildDesktopFolders(
    recordUsage,
    handleRunBootstrap,
    handleRunStart,
    handleRunNapcatBuild,
    handleRunNapcatStart,
    handleRunUpdate,
    handleRunForceUpdate,
    handleRunSentiment,
  );

  // rotation handled by useWallpaper

  const [serverReady, setServerReady] = useState(false);

  useEffect(() => {
    initApp();
  }, []);

  const initApp = async () => {
    // 1. Wait for backend to be ready
    const bootTime = await waitForBackend();
    setServerReady(!!bootTime);

    if (!bootTime) {
      addToast('error', '连接失败', '无法连接到后端服务器');
      setLoading(false);
      return;
    }

    // 2. Check if server restarted (Boot Time changed)
    const lastBootTime = sessionStorage.getItem('sentra_server_boot_time');
    if (lastBootTime && lastBootTime !== String(bootTime)) {
      console.log('Server restarted, invalidating session');
      sessionStorage.removeItem('sentra_auth_token');
      sessionStorage.removeItem('sentra_server_boot_time');
      setIsAuthenticated(false);
    }

    // Update stored boot time
    sessionStorage.setItem('sentra_server_boot_time', String(bootTime));

    // 3. Check auth
    await checkAuth();
  };

  const checkAuth = async () => {
    const token = sessionStorage.getItem('sentra_auth_token');
    if (token) {
      const isValid = await verifyToken(token);
      if (isValid) {
        setIsAuthenticated(true);
        loadConfigs();
      } else {
        sessionStorage.removeItem('sentra_auth_token');
      }
    }
    setAuthChecking(false);
    setLoading(false);
  };

  const handleLogin = async (token: string) => {
    const isValid = await verifyToken(token);
    if (isValid) {
      sessionStorage.setItem('sentra_auth_token', token);
      setIsAuthenticated(true);
      loadConfigs();
      return true;
    }
    return false;
  };

  function handleLogout() {
    sessionStorage.removeItem('sentra_auth_token');
    setIsAuthenticated(false);
    setOpenWindows([]);
    setConfigData(null);
  }

  // openWindows persistence handled by useDesktopWindows

  // dockFavorites persistence handled by useDockFavorites

  // wallpaper persistence handled by useWallpaper

  async function loadConfigs(silent = false) {
    try {
      if (!silent) setLoading(true);
      const data = await fetchConfigs();
      setConfigData(data);

      setOpenWindows(prev => prev.map(w => {
        const isModule = w.file.type === 'module';
        const found = isModule
          ? data.modules.find(m => m.name === w.file.name)
          : data.plugins.find(p => p.name === w.file.name);

        if (found) {
          // Update file content AND editedVars to ensure editor sees new content
          // If the user was editing, we might overwrite their unsaved changes here if we are not careful.
          // But loadConfigs is usually called after save or on load.
          // If we want to preserve unsaved changes, we should check if dirty.
          // However, the requirement is "refresh config shows old", implying we want to see the NEW value.
          // So we sync editedVars with the new file variables.
          return {
            ...w,
            file: { ...found, type: w.file.type },
            editedVars: found.variables ? [...found.variables] : []
          };
        }
        return w;
      }));

    } catch (error) {
      console.error('加载配置失败', error);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  // handlers moved into useDesktopWindows



  // useWallpaper provides select/upload handlers

  const handleDeleteWallpaper = () => {
    setDialogConfig({
      title: '删除壁纸',
      message: '确定要删除当前壁纸吗？此操作无法撤销。',
      type: 'error',
      onConfirm: () => { deleteCurrentWallpaper(); setDialogOpen(false); }
    });
    setDialogOpen(true);
  };

  const modules: FileItem[] = configData?.modules.map(m => ({ ...m, type: 'module' as const })) || [];
  const plugins: FileItem[] = configData?.plugins.map(p => ({ ...p, type: 'plugin' as const })) || [];
  const allItems: FileItem[] = [...modules, ...plugins];

  const dockItems = [
    {
      id: 'launchpad',
      name: '启动台',
      icon: getIconForType('desktop', 'module'),
      onClick: () => setLaunchpadOpen(true)
    },
    {
      id: 'file-manager-app',
      name: '文件管理',
      icon: getIconForType('file-manager', 'module'),
      isOpen: fileManagerOpen,
      onClick: handleOpenFileManager,
      onClose: () => {
        setFileManagerOpen(false);
        setFileManagerMinimized(false);
      }
    },
    {
      id: 'presets-app',
      name: '预设撰写',
      icon: getIconForType('agent-presets', 'module'),
      isOpen: presetsEditorOpen,
      onClick: handleOpenPresets,
      onClose: () => {
        setPresetsEditorOpen(false);
        setPresetsEditorMinimized(false);
      }
    },
    {
      id: 'preset-importer-app',
      name: '预设导入',
      icon: getIconForType('preset-importer', 'module'),
      isOpen: presetImporterOpen,
      onClick: handleOpenPresetImporter,
      onClose: () => {
        setPresetImporterOpen(false);
        setPresetImporterMinimized(false);
      }
    },
    {
      id: 'model-providers-manager-app',
      name: '模型供应商',
      icon: getIconForType('model-providers-manager', 'module'),
      isOpen: modelProvidersManagerOpen,
      onClick: handleOpenModelProvidersManager,
      onClose: () => {
        setModelProvidersManagerOpen(false);
        setModelProvidersManagerMinimized(false);
      }
    },
    {
      id: 'dev-center-app',
      name: '开发中心',
      icon: getIconForType('dev-center', 'module'),
      isOpen: devCenterOpen,
      onClick: () => {
        setDevCenterOpen(true);
        setDevCenterMinimized(false);
      },
      onClose: () => {
        setDevCenterOpen(false);
        setDevCenterMinimized(false);
      }
    },
    ...dockFavorites.map(favId => {
      const item = allItems.find(i => `${i.type}-${i.name}` === favId);
      if (!item) return null;
      const isOpen = openWindows.some(w => w.file.name === item.name && w.file.type === item.type);
      return {
        id: favId,
        name: getDisplayName(item.name),
        icon: getIconForType(item.name, item.type),
        isOpen,
        onClick: () => openWindow(item),
        onClose: isOpen ? () => {
          const win = openWindows.find(w => w.file.name === item.name && w.file.type === item.type);
          if (win) handleClose(win.id);
        } : undefined,
        onRemove: () => setDockFavorites(prev => prev.filter(id => id !== favId))
      };
    }).filter(Boolean) as any[],
    ...openWindows
      .filter(w => !dockFavorites.includes(`${w.file.type}-${w.file.name}`))
      .map(w => ({
        id: w.id,
        name: getDisplayName(w.file.name),
        icon: getIconForType(w.file.name, w.file.type),
        isOpen: true,
        onClick: () => {
          if (w.minimized) {
            setOpenWindows(ws => ws.map(x => x.id === w.id ? { ...x, minimized: false } : x));
          }
          bringToFront(w.id);
        },
        onClose: () => handleClose(w.id),
        onRemove: undefined
      }))
  ];

  const uniqueDockItems = dockItems.filter((item, index, self) =>
    index === self.findIndex((t) => t.id === item.id)
  );

  const isSolidColor = currentWallpaper.startsWith('#');

  if (authChecking) {
    return null; // Or a simple loading spinner
  }

  if (!isAuthenticated) {
    return (
      <>
        <div
          style={{
            backgroundImage: isSolidColor ? 'none' : `url(${currentWallpaper})`,
            backgroundColor: isSolidColor ? currentWallpaper : '#000',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            height: '100vh',
            width: '100vw',
            position: 'absolute',
            zIndex: 0
          }}
        />
        <LoginScreen onLogin={handleLogin} wallpaper={currentWallpaper} />
      </>
    );
  }

  if (loading) {
    return (
      <div style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f5f5f7',
        color: '#666'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 16 }}>Sentra Agent</div>
          <div>{serverReady ? '正在启动系统...' : '正在连接服务器...'}</div>
        </div>
      </div>
    );
  }

  // iOS / Mobile / Tablet View
  if (isMobile || isTablet) {
    return (
      <Suspense fallback={<div className="loading-screen">Loading...</div>}>
        <MobileView
          allItems={allItems}
          usageCounts={usageCounts}
          recordUsage={recordUsage}
          desktopIcons={desktopIcons}
          desktopFolders={desktopFolders}
          theme={theme}
          launchpadOpen={launchpadOpen}
          setLaunchpadOpen={setLaunchpadOpen}
          handleIOSOpenWindow={openIOSWindow}
          iosEditorWindows={iosEditorWindows}
          activeIOSEditorId={activeIOSEditorId}
          saving={saving}
          handleIOSVarChange={handleIOSVarChange}
          handleIOSAddVar={handleIOSAddVar}
          handleIOSDeleteVar={handleIOSDeleteVar}
          handleIOSSave={handleIOSSave}
          handleIOSMinimizeEditor={handleIOSMinimizeEditor}
          handleIOSCloseEditor={handleIOSCloseEditor}
          toasts={toasts}
          removeToast={removeToast}
          terminalWindows={terminalWindows}
          handleMinimizeTerminal={handleMinimizeTerminal}
          handleCloseTerminal={handleCloseTerminal}
          iosPresetsEditorOpen={iosPresetsEditorOpen}
          setIosPresetsEditorOpen={setIosPresetsEditorOpen}
          iosPresetImporterOpen={iosPresetImporterOpen}
          setIosPresetImporterOpen={setIosPresetImporterOpen}
          iosFileManagerOpen={iosFileManagerOpen}
          setIosFileManagerOpen={setIosFileManagerOpen}
          iosModelProvidersManagerOpen={iosModelProvidersManagerOpen}
          setIosModelProvidersManagerOpen={setIosModelProvidersManagerOpen}
          iosRedisAdminOpen={iosRedisAdminOpen}
          setIosRedisAdminOpen={setIosRedisAdminOpen}
          addToast={addToast}
          presetsState={presetsState}
        />
      </Suspense>
    );
  }

  // Desktop View
  return (
    <Suspense fallback={<div className="loading-screen">Loading...</div>}>
      <WallpaperEditorModal
        isOpen={wallpaperEditorOpen}
        src={wallpaperEditorSrc}
        targetAspect={wallpaperTargetAspect}
        targetSize={wallpaperTargetSize}
        onCancel={cancelWallpaperEdit}
        onSave={saveWallpaperFromEditor}
      />
      <DesktopView
        isSolidColor={isSolidColor}
        currentWallpaper={currentWallpaper}
        brightness={brightness}
        setBrightness={setBrightness}
        theme={theme}
        accentColor={accentColor}
        setAccentColor={setAccentColor}
        showDock={showDock}
        toggleDock={toggleDock}
        openWindows={openWindows}
        setOpenWindows={setOpenWindows}
        activeWinId={activeWinId}
        setActiveWinId={setActiveWinId}
        bringToFront={bringToFront}
        allocateZ={allocateZ}
        handleClose={handleClose}
        handleSave={handleSave}
        handleVarChange={handleVarChange}
        handleAddVar={handleAddVar}
        handleDeleteVar={handleDeleteVar}
        handleRestore={handleRestore}
        saving={saving}
        desktopIcons={desktopIcons}
        desktopFolders={desktopFolders}
        terminalWindows={terminalWindows}
        setTerminalWindows={setTerminalWindows}
        activeTerminalId={activeTerminalId}
        bringTerminalToFront={bringTerminalToFront}
        handleCloseTerminal={handleCloseTerminal}
        handleMinimizeTerminal={handleMinimizeTerminal}
        launchpadOpen={launchpadOpen}
        setLaunchpadOpen={setLaunchpadOpen}
        allItems={allItems}
        recordUsage={recordUsage}
        openWindow={openWindow}
        dockFavorites={dockFavorites}
        setDockFavorites={setDockFavorites}
        uniqueDockItems={uniqueDockItems}
        toasts={toasts}
        removeToast={removeToast}
        dialogOpen={dialogOpen}
        dialogConfig={dialogConfig}
        setDialogOpen={setDialogOpen}
        wallpapers={wallpapers}
        defaultWallpapers={DEFAULT_WALLPAPERS}
        BING_WALLPAPER={BING_WALLPAPER}
        SOLID_COLORS={SOLID_COLORS}
        handleWallpaperSelect={handleWallpaperSelect}
        handleUploadWallpaper={handleUploadWallpaper}
        handleDeleteWallpaper={handleDeleteWallpaper}
        wallpaperInterval={wallpaperInterval}
        setWallpaperInterval={setWallpaperInterval}
        loadConfigs={loadConfigs}
        presetsEditorOpen={presetsEditorOpen}
        setPresetsEditorOpen={setPresetsEditorOpen}
        presetsEditorMinimized={presetsEditorMinimized}
        setPresetsEditorMinimized={setPresetsEditorMinimized}
        presetImporterOpen={presetImporterOpen}
        setPresetImporterOpen={setPresetImporterOpen}
        presetImporterMinimized={presetImporterMinimized}
        setPresetImporterMinimized={setPresetImporterMinimized}
        fileManagerOpen={fileManagerOpen}
        setFileManagerOpen={setFileManagerOpen}
        fileManagerMinimized={fileManagerMinimized}
        setFileManagerMinimized={setFileManagerMinimized}
        addToast={addToast}
        presetsState={presetsState}
        devCenterOpen={devCenterOpen}
        setDevCenterOpen={setDevCenterOpen}
        devCenterMinimized={devCenterMinimized}
        setDevCenterMinimized={setDevCenterMinimized}
        deepWikiOpen={deepWikiOpen}
        setDeepWikiOpen={setDeepWikiOpen}
        deepWikiMinimized={deepWikiMinimized}
        setDeepWikiMinimized={setDeepWikiMinimized}
        redisAdminOpen={redisAdminOpen}
        setRedisAdminOpen={setRedisAdminOpen}
        redisAdminMinimized={redisAdminMinimized}
        setRedisAdminMinimized={setRedisAdminMinimized}
        modelProvidersManagerOpen={modelProvidersManagerOpen}
        setModelProvidersManagerOpen={setModelProvidersManagerOpen}
        modelProvidersManagerMinimized={modelProvidersManagerMinimized}
        setModelProvidersManagerMinimized={setModelProvidersManagerMinimized}
      />
    </Suspense>
  );
}

export default App;
