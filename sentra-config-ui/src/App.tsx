import { Suspense, lazy } from 'react';
import { LoginScreen } from './components/LoginScreen';
import { useDevice } from './hooks/useDevice';
import 'react-contexify/dist/ReactContexify.css';
import 'antd/dist/reset.css';
import './styles/macOS.css';
import './styles/theme.css';
import './styles/ios.css';
// Lazy load views
const MobileView = lazy(() => import('./views/MobileView').then(module => ({ default: module.MobileView })));
const DesktopView = lazy(() => import('./views/DesktopView').then(module => ({ default: module.DesktopView })));
import type { FileItem } from './types/ui';
import { DEFAULT_WALLPAPERS, BING_WALLPAPER, SOLID_COLORS } from './constants/wallpaper';
import { useWallpaper } from './hooks/useWallpaper';
import { WallpaperEditorModal } from './components/WallpaperEditorModal';
import { useUsageCounts } from './hooks/useUsageCounts';
import { usePresetsEditor } from './hooks/usePresetsEditor';
import { useUIStore } from './store/uiStore';
import { useAppStore } from './store/appStore';
import { useAppLifecycle } from './hooks/useAppLifecycle';
import { useAppAppearance } from './hooks/useAppAppearance';
import { useDesktopShortcuts } from './hooks/useDesktopShortcuts';
import { useWallpaperTargetMetrics } from './hooks/useWallpaperTargetMetrics';
import { useConfirmDeleteWallpaper } from './hooks/useConfirmDeleteWallpaper';
function App() {
  const { isMobile, isTablet } = useDevice();
  const isPortable = isMobile || isTablet;
  const isAuthenticated = useAppStore(s => s.isAuthenticated);
  const configData = useAppStore(s => s.configData);
  const serverReady = useAppStore(s => s.serverReady);
  const authChecking = useUIStore(s => s.authChecking);
  const loading = useUIStore(s => s.loading);
  const theme = useUIStore(s => s.theme);

  // Toasts first (used by hooks below)
  const addToast = useUIStore(s => s.addToast);

  const { accentColor } = useUIStore();

  useAppAppearance({ theme, accentColor });

  const { loadConfigs, handleLogin, handleLogout } = useAppLifecycle();





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

  const handleDeleteWallpaper = useConfirmDeleteWallpaper({ deleteCurrentWallpaper });

  const { targetAspect: wallpaperTargetAspect, targetSize: wallpaperTargetSize } =
    useWallpaperTargetMetrics({ wallpaperEditorOpen });

  // Usage counts via hook
  const { usageCounts, recordUsage } = useUsageCounts();

  // Presets Editor State via hook
  const presetsState = usePresetsEditor(addToast, isAuthenticated);
  const { desktopIcons, desktopFolders, updateConfirmDialog } = useDesktopShortcuts({
    recordUsage,
    isPortable,
  });

  // rotation handled by useWallpaper

  // openWindows persistence handled by useDesktopWindows

  // dockFavorites persistence handled by useDockFavorites

  // wallpaper persistence handled by useWallpaper

  // handlers moved into useDesktopWindows



  // useWallpaper provides select/upload handlers

  const modules: FileItem[] = configData?.modules.map(m => ({ ...m, type: 'module' as const })) || [];
  const plugins: FileItem[] = configData?.plugins.map(p => ({ ...p, type: 'plugin' as const })) || [];
  const allItems: FileItem[] = [...modules, ...plugins];

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
        {updateConfirmDialog}
        <MobileView
          allItems={allItems}
          usageCounts={usageCounts}
          recordUsage={recordUsage}
          desktopIcons={desktopIcons}
          desktopFolders={desktopFolders}
          loadConfigs={loadConfigs}
          presetsState={presetsState}
        />
      </Suspense>
    );
  }

  // Desktop View
  return (
    <Suspense fallback={<div className="loading-screen">Loading...</div>}>
      {updateConfirmDialog}
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
        onLogout={handleLogout}
        desktopIcons={desktopIcons}
        desktopFolders={desktopFolders}
        allItems={allItems}
        recordUsage={recordUsage}
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
        presetsState={presetsState}
      />
    </Suspense>
  );
}

export default App;
