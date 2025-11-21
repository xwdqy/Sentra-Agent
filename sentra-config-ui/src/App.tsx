import React, { useState, useEffect } from 'react';
import { ConfigData, ModuleConfig, PluginConfig, EnvVariable } from './types/config';
import { fetchConfigs, saveModuleConfig, savePluginConfig, verifyToken, getAuthHeaders } from './services/api';
import { MacWindow } from './components/MacWindow';
import { Dock } from './components/Dock';
import { MenuBar } from './components/MenuBar';
import { EnvEditor } from './components/EnvEditor';
import { Launchpad } from './components/Launchpad';
import { TerminalWindow } from './components/TerminalWindow';
import { LoginScreen } from './components/LoginScreen';
import { IOSHomeScreen } from './components/IOSHomeScreen';
import { IOSEditor } from './components/IOSEditor';
import { getIconForType, getDisplayName } from './utils/icons';
import { IoCubeOutline, IoTerminalOutline, IoRocket, IoBuild, IoChatbubbleEllipses, IoChevronBack } from 'react-icons/io5';
import { FaTools } from 'react-icons/fa';
import { ToastContainer, ToastMessage } from './components/Toast';
import { Dialog } from './components/Dialog';
import { Menu, Item, Submenu, useContextMenu } from 'react-contexify';
import { useDevice } from './hooks/useDevice';
import 'react-contexify/dist/ReactContexify.css';
import './styles/macOS.css';
import './styles/ios.css';

type FileItem = (ModuleConfig | PluginConfig) & { type: 'module' | 'plugin' };
type DeskWindow = {
  id: string;
  file: FileItem;
  pos?: { x: number; y: number };
  z: number;
  minimized: boolean;
  editedVars: EnvVariable[];
  maximized?: boolean;
};

type TerminalWin = {
  id: string;
  title: string;
  processId: string;
  appKey: string;
  pos: { x: number; y: number };
  z: number;
  minimized: boolean;
};

export type DesktopIcon = {
  id: string;
  name: string;
  icon: React.ReactNode;
  position: { x: number; y: number };
  onClick: () => void;
};

const DEFAULT_WALLPAPERS = [
  '/wallpapers/desert.jpg',
  '/wallpapers/yosemite.jpg',
  '/wallpapers/lake.jpg',
  '/wallpapers/coast.jpg',
];

const BING_WALLPAPER = 'https://bing.biturl.top/?resolution=1920&format=image&index=0&mkt=zh-CN';

const SOLID_COLORS = [
  { name: '纯黑', value: '#000000' },
  { name: '纯白', value: '#ffffff' },
  { name: '深灰', value: '#333333' },
  { name: '午夜蓝', value: '#1a1a2e' },
];

function App() {
  const { isMobile, isTablet } = useDevice();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [configData, setConfigData] = useState<ConfigData | null>(null);
  const [saving, setSaving] = useState(false);

  // Initialize from localStorage
  const [openWindows, setOpenWindows] = useState<DeskWindow[]>(() => {
    try {
      const saved = localStorage.getItem('sentra_open_windows');
      if (saved) {
        const parsedWindows = JSON.parse(saved);
        if (Array.isArray(parsedWindows) && parsedWindows.length > 0) {
          const width = 600;
          const height = 400;
          const centerPos = {
            x: Math.max(0, (window.innerWidth - width) / 2),
            y: Math.max(40, (window.innerHeight - height) / 2)
          };
          return parsedWindows.map((w: any) => {
            const p = w.pos || { x: 0, y: 0 };
            const invalid =
              p.x == null || p.y == null ||
              p.x < 20 || p.y < 30 ||
              p.x > window.innerWidth - 100 || p.y > window.innerHeight - 100;
            return invalid ? { ...w, pos: centerPos } : w;
          });
        }
      }
    } catch (e) {
      console.error('Failed to load saved windows', e);
    }
    return [];
  });

  const [activeWinId, setActiveWinId] = useState<string | null>(null);

  const [zNext, setZNext] = useState(() => {
    if (openWindows.length > 0) {
      return Math.max(...openWindows.map(w => w.z || 1000), 1000) + 1;
    }
    return 1000;
  });

  const [launchpadOpen, setLaunchpadOpen] = useState(false);

  // Wallpapers state
  const [wallpapers, setWallpapers] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('sentra_custom_wallpapers');
      if (saved) {
        const custom = JSON.parse(saved);
        return [...DEFAULT_WALLPAPERS, ...custom];
      }
    } catch { }
    return DEFAULT_WALLPAPERS;
  });

  const [currentWallpaper, setCurrentWallpaper] = useState<string>(() => {
    return localStorage.getItem('sentra_current_wallpaper') || DEFAULT_WALLPAPERS[0];
  });

  const [dockFavorites, setDockFavorites] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('sentra_dock_favorites');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [brightness, setBrightness] = useState(() => {
    const saved = localStorage.getItem('sentra_brightness');
    return saved ? Number(saved) : 100;
  });

  const [wallpaperFit, setWallpaperFit] = useState<'cover' | 'contain'>(() => {
    const saved = localStorage.getItem('sentra_wallpaper_fit');
    return (saved as 'cover' | 'contain') || 'cover';
  });

  const [wallpaperInterval, setWallpaperInterval] = useState<number>(0); // 0 = off
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const [usageCounts, setUsageCounts] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem('sentra_usage_counts');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const recordUsage = (key: string) => {
    setUsageCounts(prev => {
      const next = { ...prev, [key]: (prev[key] || 0) + 1 };
      try { localStorage.setItem('sentra_usage_counts', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // Theme state
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('sentra_theme') as 'light' | 'dark') || 'dark';
  });

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogConfig, setDialogConfig] = useState({
    title: '',
    message: '',
    onConfirm: () => { },
    type: 'info' as 'info' | 'warning' | 'error'
  });

  const { show } = useContextMenu({ id: 'desktop-menu' });

  const addToast = (type: ToastMessage['type'], title: string, message?: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, type, title, message }]);
  };

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const toggleTheme = () => {
    setTheme(prev => {
      const newTheme = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('sentra_theme', newTheme);
      return newTheme;
    });
  };

  // Terminal windows state
  const [terminalWindows, setTerminalWindows] = useState<TerminalWin[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);

  // iOS editor windows state
  type IOSEditorWin = {
    id: string;
    file: FileItem;
    editedVars: EnvVariable[];
    minimized: boolean;
  };
  const [iosEditorWindows, setIosEditorWindows] = useState<IOSEditorWin[]>([]);
  const [activeIOSEditorId, setActiveIOSEditorId] = useState<string | null>(null);

  const handleRunBootstrap = async () => {
    const existing = terminalWindows.find(t => t.appKey === 'bootstrap');
    if (existing) {
      if (existing.minimized) {
        setTerminalWindows(prev => prev.map(t => t.id === existing.id ? { ...t, minimized: false } : t));
      }
      bringTerminalToFront(existing.id);
      return;
    }
    try {
      const response = await fetch('/api/scripts/bootstrap', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ args: ['--force'] }),
      });
      const data = await response.json();

      if (data.success && data.processId) {
        const id = `terminal-${Date.now()}`;
        const terminal: TerminalWin = {
          id,
          title: 'Bootstrap Script',
          processId: data.processId,
          appKey: 'bootstrap',
          pos: { x: window.innerWidth / 2 - 350, y: window.innerHeight / 2 - 250 },
          z: zNext + 1,
          minimized: false,
        };
        setTerminalWindows(prev => [...prev, terminal]);
        setZNext(z => z + 1);
        setActiveTerminalId(id);
      }
    } catch (error) {
      addToast('error', 'Failed to run bootstrap script', error instanceof Error ? error.message : undefined);
    }
  };

  const handleRunStart = async () => {
    const existing = terminalWindows.find(t => t.appKey === 'start');
    if (existing) {
      if (existing.minimized) {
        setTerminalWindows(prev => prev.map(t => t.id === existing.id ? { ...t, minimized: false } : t));
      }
      bringTerminalToFront(existing.id);
      return;
    }
    try {
      const response = await fetch('/api/scripts/start', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ args: [] }),
      });
      const data = await response.json();

      if (data.success && data.processId) {
        const id = `terminal-${Date.now()}`;
        const terminal: TerminalWin = {
          id,
          title: 'Start Script',
          processId: data.processId,
          appKey: 'start',
          pos: { x: window.innerWidth / 2 - 350, y: window.innerHeight / 2 - 250 },
          z: zNext + 1,
          minimized: false,
        };
        setTerminalWindows(prev => [...prev, terminal]);
        setZNext(z => z + 1);
        setActiveTerminalId(id);
      }
    } catch (error) {
      addToast('error', 'Failed to run start script', error instanceof Error ? error.message : undefined);
    }
  };

  const handleRunNapcatBuild = async () => {
    const existing = terminalWindows.find(t => t.appKey === 'napcat-build');
    if (existing) {
      if (existing.minimized) {
        setTerminalWindows(prev => prev.map(t => t.id === existing.id ? { ...t, minimized: false } : t));
      }
      bringTerminalToFront(existing.id);
      return;
    }
    try {
      const response = await fetch('/api/scripts/napcat', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ args: ['build'] }),
      });
      const data = await response.json();

      if (data.success && data.processId) {
        const id = `terminal-${Date.now()}`;
        const terminal: TerminalWin = {
          id,
          title: 'Napcat Build',
          processId: data.processId,
          appKey: 'napcat-build',
          pos: { x: window.innerWidth / 2 - 350, y: window.innerHeight / 2 - 250 },
          z: zNext + 1,
          minimized: false,
        };
        setTerminalWindows(prev => [...prev, terminal]);
        setZNext(z => z + 1);
        setActiveTerminalId(id);
      }
    } catch (error) {
      addToast('error', 'Failed to run Napcat build', error instanceof Error ? error.message : undefined);
    }
  };

  const handleRunNapcatStart = async () => {
    const existing = terminalWindows.find(t => t.appKey === 'napcat-start');
    if (existing) {
      if (existing.minimized) {
        setTerminalWindows(prev => prev.map(t => t.id === existing.id ? { ...t, minimized: false } : t));
      }
      bringTerminalToFront(existing.id);
      return;
    }
    try {
      const response = await fetch('/api/scripts/napcat', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ args: ['start'] }),
      });
      const data = await response.json();

      if (data.success && data.processId) {
        const id = `terminal-${Date.now()}`;
        const terminal: TerminalWin = {
          id,
          title: 'Napcat Start',
          processId: data.processId,
          appKey: 'napcat-start',
          pos: { x: window.innerWidth / 2 - 350, y: window.innerHeight / 2 - 250 },
          z: zNext + 1,
          minimized: false,
        };
        setTerminalWindows(prev => [...prev, terminal]);
        setZNext(z => z + 1);
        setActiveTerminalId(id);
      }
    } catch (error) {
      addToast('error', 'Failed to start Napcat', error instanceof Error ? error.message : undefined);
    }
  };

  const handleCloseTerminal = async (id: string) => {
    const terminal = terminalWindows.find(t => t.id === id);
    if (terminal) {
      try {
        await fetch(`/api/scripts/kill/${terminal.processId}`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({})
        });
      } catch (e) {
        console.error('Failed to kill process on close', e);
      }
    }
    setTerminalWindows(prev => prev.filter(t => t.id !== id));
    if (activeTerminalId === id) setActiveTerminalId(null);
  };

  const handleMinimizeTerminal = (id: string) => {
    setTerminalWindows(prev => prev.map(t => t.id === id ? { ...t, minimized: true } : t));
    setActiveTerminalId(null);
  };

  // iOS Editor handlers
  const handleIOSOpenWindow = (file: FileItem) => {
    const existing = iosEditorWindows.find(w => w.file.name === file.name && w.file.type === file.type);
    if (existing) {
      // If app is minimized, restore it
      if (existing.minimized) {
        setIosEditorWindows(prev => prev.map(w => w.id === existing.id ? { ...w, minimized: false } : w));
      }
      setActiveIOSEditorId(existing.id);
      return;
    }

    const id = `ios-editor-${Date.now()}`;
    const win: IOSEditorWin = {
      id,
      file,
      editedVars: file.variables ? [...file.variables] : [],
      minimized: false,
    };
    setIosEditorWindows(prev => [...prev, win]);
    setActiveIOSEditorId(id);
  };

  const handleIOSMinimizeEditor = (id: string) => {
    setIosEditorWindows(prev => prev.map(w => w.id === id ? { ...w, minimized: true } : w));
    setActiveIOSEditorId(null);
  };

  const handleIOSCloseEditor = (id: string) => {
    setIosEditorWindows(prev => prev.filter(w => w.id !== id));
    if (activeIOSEditorId === id) setActiveIOSEditorId(null);
  };

  const handleIOSVarChange = (id: string, index: number, field: 'key' | 'value' | 'comment', val: string) => {
    setIosEditorWindows(prev => prev.map(w => {
      if (w.id !== id) return w;
      const newVars = [...w.editedVars];
      newVars[index] = { ...newVars[index], [field]: val };
      return { ...w, editedVars: newVars };
    }));
  };

  const handleIOSAddVar = (id: string) => {
    setIosEditorWindows(prev => prev.map(w => w.id === id ? { ...w, editedVars: [...w.editedVars, { key: '', value: '', comment: '', isNew: true }] } : w));
  };

  const handleIOSDeleteVar = (id: string, index: number) => {
    const win = iosEditorWindows.find(w => w.id === id);
    if (!win) return;

    const targetVar = win.editedVars[index];
    if (!targetVar.isNew) {
      addToast('error', '无法删除', '系统预设变量无法删除');
      return;
    }

    setIosEditorWindows(prev => prev.map(w => w.id === id ? { ...w, editedVars: w.editedVars.filter((_, i) => i !== index) } : w));
  };

  const handleIOSSave = async (id: string) => {
    const win = iosEditorWindows.find(w => w.id === id);
    if (!win) return;

    try {
      setSaving(true);
      const validVars = win.editedVars.filter(v => v.key.trim());
      if (win.file.type === 'module') {
        await saveModuleConfig(win.file.name, validVars);
      } else {
        await savePluginConfig(win.file.name, validVars);
      }
      addToast('success', '保存成功', `已更新 ${getDisplayName(win.file.name)} 配置`);
      await loadConfigs(true);
    } catch (error) {
      addToast('error', '保存失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  const bringTerminalToFront = (id: string) => {
    setTerminalWindows(prev => prev.map(t => t.id === id ? { ...t, z: zNext + 1 } : t));
    setZNext(z => z + 1);
    setActiveTerminalId(id);
  };

  // Desktop icons
  const withUsage = <F extends (...args: any[]) => any>(key: string, fn: F) => () => { recordUsage(key); return fn(); };

  const desktopIcons: DesktopIcon[] = [
    {
      id: 'bootstrap',
      name: '安装板块依赖',
      icon: <div style={{
        width: 54,
        height: 54,
        background: 'linear-gradient(135deg, #34C759, #30B753)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 12px rgba(52, 199, 89, 0.3)'
      }}>
        <FaTools size={24} color="white" />
      </div>,
      position: { x: 20, y: 80 },
      onClick: withUsage('desktop:bootstrap', handleRunBootstrap),
    },
    {
      id: 'start',
      name: '启动Sentra',
      icon: <div style={{
        width: 54,
        height: 54,
        background: 'linear-gradient(135deg, #007AFF, #0062CC)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 12px rgba(0, 122, 255, 0.3)'
      }}>
        <IoRocket size={28} color="white" />
      </div>,
      position: { x: 20, y: 180 },
      onClick: withUsage('desktop:start', handleRunStart),
    },
    {
      id: 'napcat-build',
      name: 'NC构建SDK',
      icon: <div style={{
        width: 54,
        height: 54,
        background: 'linear-gradient(135deg, #9B59B6, #8E44AD)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 12px rgba(155, 89, 182, 0.3)'
      }}>
        <IoBuild size={26} color="white" />
      </div>,
      position: { x: 20, y: 280 },
      onClick: withUsage('desktop:napcat-build', handleRunNapcatBuild),
    },
    {
      id: 'napcat-start',
      name: '启动QQ适配器',
      icon: <div style={{
        width: 54,
        height: 54,
        background: 'linear-gradient(135deg, #16A085, #138D75)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 12px rgba(22, 160, 133, 0.3)'
      }}>
        <IoChatbubbleEllipses size={28} color="white" />
      </div>,
      position: { x: 20, y: 380 },
      onClick: withUsage('desktop:napcat-start', handleRunNapcatStart),
    },
  ];

  // Wallpaper rotation
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
    checkAuth();
  }, []);

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

  // Debounced persistence
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem('sentra_open_windows', JSON.stringify(openWindows));
      } catch (e) {
        console.error('Failed to save windows state', e);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [openWindows]);

  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem('sentra_dock_favorites', JSON.stringify(dockFavorites));
    }, 500);
    return () => clearTimeout(timer);
  }, [dockFavorites]);

  useEffect(() => {
    localStorage.setItem('sentra_current_wallpaper', currentWallpaper);
  }, [currentWallpaper]);

  useEffect(() => {
    localStorage.setItem('sentra_brightness', String(brightness));
  }, [brightness]);

  useEffect(() => {
    localStorage.setItem('sentra_wallpaper_fit', wallpaperFit);
  }, [wallpaperFit]);

  const loadConfigs = async (silent = false) => {
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
          return {
            ...w,
            file: { ...found, type: w.file.type }
          };
        }
        return w;
      }));

    } catch (error) {
      console.error('加载配置失败', error);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const openWindow = (file: FileItem) => {
    const existing = openWindows.find(w => w.file.name === file.name && w.file.type === file.type);
    if (existing) {
      if (existing.minimized) {
        setOpenWindows(ws => ws.map(w => w.id === existing.id ? { ...w, minimized: false } : w));
      }
      bringToFront(existing.id);
      return;
    }

    const id = `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const width = 600;
    const height = 400;
    const x = Math.max(0, (window.innerWidth - width) / 2);
    const y = Math.max(40, (window.innerHeight - height) / 2);

    const win: DeskWindow = {
      id,
      file,
      z: zNext + 1,
      minimized: false,
      editedVars: file.variables ? [...file.variables] : [],
      pos: { x, y }
    };
    setOpenWindows(ws => [...ws, win]);
    setZNext(z => z + 1);
    setActiveWinId(id);
  };

  const bringToFront = (id: string) => {
    setOpenWindows(ws => {
      const nextZ = zNext + 1;
      return ws.map(w => (w.id === id ? { ...w, z: nextZ } : w));
    });
    setZNext(z => z + 1);
    setActiveWinId(id);
  };

  const handleClose = (id: string) => {
    setOpenWindows(ws => ws.filter(w => w.id !== id));
    if (activeWinId === id) setActiveWinId(null);
  };

  const handleSave = async (id: string) => {
    const win = openWindows.find(w => w.id === id);
    if (!win) return;

    try {
      setSaving(true);
      const validVars = win.editedVars.filter(v => v.key.trim());
      if (win.file.type === 'module') {
        await saveModuleConfig(win.file.name, validVars);
      } else {
        await savePluginConfig(win.file.name, validVars);
      }
      addToast('success', '保存成功', `已更新 ${getDisplayName(win.file.name)} 配置`);
      await loadConfigs(true);
    } catch (error) {
      addToast('error', '保存失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setSaving(false);
    }
  };

  const handleVarChange = (id: string, index: number, field: 'key' | 'value' | 'comment', val: string) => {
    setOpenWindows(ws => ws.map(w => {
      if (w.id !== id) return w;
      const newVars = [...w.editedVars];
      newVars[index] = { ...newVars[index], [field]: val };
      return { ...w, editedVars: newVars };
    }));
  };

  const handleAddVar = (id: string) => {
    setOpenWindows(ws => ws.map(w => w.id === id ? { ...w, editedVars: [...w.editedVars, { key: '', value: '', comment: '', isNew: true }] } : w));
  };

  const handleDeleteVar = (id: string, index: number) => {
    const win = openWindows.find(w => w.id === id);
    if (!win) return;

    const targetVar = win.editedVars[index];
    if (!targetVar.isNew) {
      addToast('error', '无法删除', '系统预设变量无法删除');
      return;
    }

    setOpenWindows(ws => ws.map(w => w.id === id ? { ...w, editedVars: w.editedVars.filter((_, i) => i !== index) } : w));
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    show({ event: e });
  };

  const handleWallpaperSelect = (wp: string) => {
    setCurrentWallpaper(wp);
  };

  const handleUploadWallpaper = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        if (file.size > 5 * 1024 * 1024) {
          addToast('error', '图片过大', '请上传小于 5MB 的图片');
          return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
          const result = ev.target?.result as string;
          if (result) {
            const newWallpapers = [...wallpapers, result];
            setWallpapers(newWallpapers);
            setCurrentWallpaper(result);

            const customOnly = newWallpapers.slice(DEFAULT_WALLPAPERS.length);
            try {
              localStorage.setItem('sentra_custom_wallpapers', JSON.stringify(customOnly));
              addToast('success', '壁纸已添加');
            } catch (e) {
              addToast('error', '存储空间不足', '无法保存更多壁纸，请删除一些旧壁纸');
            }
          }
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  };

  const handleDeleteWallpaper = () => {
    if (DEFAULT_WALLPAPERS.includes(currentWallpaper) || currentWallpaper === BING_WALLPAPER || SOLID_COLORS.some(c => c.value === currentWallpaper)) {
      addToast('info', '无法删除', '系统默认壁纸无法删除');
      return;
    }

    setDialogConfig({
      title: '删除壁纸',
      message: '确定要删除当前壁纸吗？此操作无法撤销。',
      type: 'error',
      onConfirm: () => {
        const newWallpapers = wallpapers.filter(w => w !== currentWallpaper);
        setWallpapers(newWallpapers);
        setCurrentWallpaper(newWallpapers[newWallpapers.length - 1] || DEFAULT_WALLPAPERS[0]);

        const customOnly = newWallpapers.slice(DEFAULT_WALLPAPERS.length);
        localStorage.setItem('sentra_custom_wallpapers', JSON.stringify(customOnly));
        addToast('success', '壁纸已删除');
        setDialogOpen(false);
      }
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
            backgroundSize: wallpaperFit,
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
          <div>正在启动系统...</div>
        </div>
      </div>
    );
  }

  // iOS / Mobile / Tablet View
  if (isMobile || isTablet) {
    const topByUsage = [...allItems]
      .map(item => ({ item, count: usageCounts[`${item.type}:${item.name}`] || 0 }))
      .sort((a, b) => b.count - a.count);
    const fallback = [...allItems].sort((a, b) => getDisplayName(a.name).localeCompare(getDisplayName(b.name), 'zh-Hans-CN'));
    const pick = (arr: { item: FileItem, count?: number }[], n: number) => arr.slice(0, n).map(x => x.item);
    const selected = (topByUsage[0]?.count ? pick(topByUsage, 3) : fallback.slice(0, 3));
    const iosDockExtra = selected.map(it => ({
      id: `${it.type}-${it.name}`,
      icon: getIconForType(it.name, it.type),
      onClick: () => { recordUsage(`${it.type}:${it.name}`); handleIOSOpenWindow(it); }
    }));
    return (
      <>
        <IOSHomeScreen
          icons={desktopIcons}
          onLaunch={(icon) => icon.onClick()}
          wallpaper="/wallpapers/ios-default.png"
          onLaunchpadOpen={() => setLaunchpadOpen(true)}
          dockExtra={iosDockExtra}
        />

        {/* Render full screen windows on top */}
        {terminalWindows.map(term => (
          <div key={term.id} className="ios-app-window" style={{ display: term.minimized ? 'none' : 'flex' }}>
            <div className="ios-app-header">
              <div className="ios-back-btn" onClick={() => handleMinimizeTerminal(term.id)}>
                <IoChevronBack /> Home
              </div>
              <div>{term.title}</div>
              <div style={{ color: '#ff3b30', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => handleCloseTerminal(term.id)}>
                Close
              </div>
            </div>
            <TerminalWindow processId={term.processId} />
          </div>
        ))}

        {/* Launchpad for iOS */}
        <Launchpad
          isOpen={launchpadOpen}
          onClose={() => setLaunchpadOpen(false)}
          items={allItems.map(item => ({
            name: item.name,
            type: item.type,
            onClick: () => {
              recordUsage(`${item.type}:${item.name}`);
              handleIOSOpenWindow(item);
              setLaunchpadOpen(false);
            }
          }))}
        />

        {/* iOS Editor Windows */}
        {iosEditorWindows
          .filter(win => !win.minimized)
          .map(win => (
            <div key={win.id} style={{ display: win.id === activeIOSEditorId ? 'flex' : 'none' }}>
              <IOSEditor
                appName={getDisplayName(win.file.name)}
                vars={win.editedVars}
                onUpdate={(idx, field, val) => handleIOSVarChange(win.id, idx, field, val)}
                onAdd={() => handleIOSAddVar(win.id)}
                onDelete={(idx) => handleIOSDeleteVar(win.id, idx)}
                onSave={() => handleIOSSave(win.id)}
                onMinimize={() => handleIOSMinimizeEditor(win.id)}
                onClose={() => handleIOSCloseEditor(win.id)}
                saving={saving}
                isExample={!win.file.hasEnv && win.file.hasExample}
              />
            </div>
          ))}

        <ToastContainer toasts={toasts} removeToast={removeToast} />
      </>
    );
  }

  // Desktop View
  return (
    <div
      className="desktop-container"
      style={{
        backgroundImage: isSolidColor ? 'none' : `url(${currentWallpaper})`,
        backgroundColor: isSolidColor ? currentWallpaper : '#000',
        backgroundSize: wallpaperFit,
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        position: 'relative',
        filter: `brightness(${brightness}%)`
      }}
      onContextMenu={handleContextMenu}
    >
      <MenuBar
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
              { label: '最小化所有', onClick: () => setOpenWindows(ws => ws.map(w => ({ ...w, minimized: true }))) },
              { label: '恢复所有', onClick: () => setOpenWindows(ws => ws.map(w => ({ ...w, minimized: false }))) },
              {
                label: '切换壁纸', onClick: () => {
                  const currentIndex = wallpapers.indexOf(currentWallpaper);
                  const nextIndex = (currentIndex + 1) % wallpapers.length;
                  setCurrentWallpaper(wallpapers[nextIndex]);
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
        brightness={brightness}
        setBrightness={setBrightness}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

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
          onClose={() => handleClose(w.id)}
          onMinimize={() => {
            setOpenWindows(ws => ws.map(x => x.id === w.id ? { ...x, minimized: true } : x));
            setActiveWinId(null);
          }}
          onMaximize={() => { }}
          onFocus={() => bringToFront(w.id)}
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
            saving={saving}
            isExample={!w.file.hasEnv && w.file.hasExample}
            theme={theme}
          />
        </MacWindow>
      ))}

      {/* Desktop Icons */}
      {desktopIcons.map(icon => (
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
            width: 80, // Fixed width for alignment
          }}
          onClick={icon.onClick}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
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
      ))}

      {/* Terminal Windows */}
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
          onClose={() => handleCloseTerminal(terminal.id)}
          onMinimize={() => {
            setTerminalWindows(prev => prev.map(w => w.id === terminal.id ? { ...w, minimized: true } : w));
          }}
          onMaximize={() => { }}
          onFocus={() => bringTerminalToFront(terminal.id)}
          onMove={(x, y) => {
            setTerminalWindows(prev => prev.map(w => w.id === terminal.id ? { ...w, pos: { x, y } } : w));
          }}
        >
          <TerminalWindow
            processId={terminal.processId}
          />
        </MacWindow>
      ))}

      <Launchpad
        isOpen={launchpadOpen}
        onClose={() => setLaunchpadOpen(false)}
        items={allItems.map(item => ({
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
        }))}
      />

      <Dock items={uniqueDockItems} />

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
        <Item onClick={handleDeleteWallpaper} disabled={DEFAULT_WALLPAPERS.includes(currentWallpaper) || currentWallpaper === BING_WALLPAPER || SOLID_COLORS.some(c => c.value === currentWallpaper)}>
          删除当前壁纸
        </Item>
        <Item onClick={() => setWallpaperFit(f => f === 'cover' ? 'contain' : 'cover')}>
          壁纸填充: {wallpaperFit === 'cover' ? '覆盖 (Cover)' : '包含 (Contain)'}
        </Item>
        <Item onClick={() => setWallpaperInterval(i => i === 0 ? 60 : 0)}>
          {wallpaperInterval > 0 ? '停止壁纸轮播' : '开启壁纸轮播 (1min)'}
        </Item>
        <Item onClick={() => loadConfigs()}>刷新</Item>
      </Menu>
    </div>
  );
}

export default App;
