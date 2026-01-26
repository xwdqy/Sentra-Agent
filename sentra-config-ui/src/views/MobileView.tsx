import React, { Suspense } from 'react';
import { IOSHomeScreen } from '../components/IOSHomeScreen';
import { IOSEditor } from '../components/IOSEditor';
import { IOSPresetsEditor } from '../components/IOSPresetsEditor';
import { PresetImporter } from '../components/PresetImporter';
import { Launchpad } from '../components/Launchpad';
import { ToastContainer } from '../components/Toast';
import { IoChevronBack } from 'react-icons/io5';
import { SentraLoading } from '../components/SentraLoading';
import { getDisplayName, getIconForType } from '../utils/icons';
import { FileItem, DesktopIcon, AppFolder } from '../types/ui';
import { PresetsEditorState } from '../hooks/usePresetsEditor';
import { IOSFileManager } from '../components/IOSFileManager';
import { useUIStore } from '../store/uiStore';
import { useWindowsStore } from '../store/windowsStore';
import { useTerminals } from '../hooks/useTerminals';
import { useIOSEditor } from '../hooks/useIOSEditor';

const ModelProvidersManager = React.lazy(() => import('../components/ModelProvidersManager/ModelProvidersManager').then(module => ({ default: module.default })));
const McpServersManager = React.lazy(() => import('../components/McpServersManager/McpServersManager').then(module => ({ default: module.default })));
const RedisAdminManager = React.lazy(() => import('../components/RedisAdminManager/RedisAdminManager').then(module => ({ default: module.RedisAdminManager })));
const TerminalWindow = React.lazy(() => import('../components/TerminalWindow').then(module => ({ default: module.TerminalWindow })));
const TerminalExecutorWindow = React.lazy(() => import('../components/TerminalExecutorWindow').then(module => ({ default: module.TerminalExecutorWindow })));
const IOSTerminalManager = React.lazy(() => import('../components/IOSTerminalManager').then(module => ({ default: module.IOSTerminalManager })));
const IOSEmojiStickersManager = React.lazy(() => import('../components/IOSEmojiStickersManager').then(module => ({ default: module.IOSEmojiStickersManager })));

export type MobileViewProps = {
  allItems: FileItem[];
  usageCounts: Record<string, number>;
  recordUsage: (key: string) => void;
  desktopIcons: DesktopIcon[];
  desktopFolders: AppFolder[];
  loadConfigs: (silent?: boolean) => Promise<void> | void;
  presetsState: PresetsEditorState;
};

export function MobileView(props: MobileViewProps) {
  const [returnToLaunchpad, setReturnToLaunchpad] = React.useState(false);
  const [iosZMap, setIosZMap] = React.useState<Record<string, number>>({});
  const iosZNextRef = React.useRef(2200);
  const [iosAppSwitcherOpen, setIosAppSwitcherOpen] = React.useState(false);
  const iosGlobalSwipeRef = React.useRef<{ x: number; y: number; opened: boolean } | null>(null);
  const {
    allItems,
    usageCounts,
    recordUsage,
    desktopIcons,
    desktopFolders,
    loadConfigs,
    presetsState,
  } = props;

  const {
    toasts,
    removeToast,
    addToast,
    launchpadOpen,
    setLaunchpadOpen,
    saving,
    setSaving,
    theme,
    iosPresetsEditorOpen,
    setIosPresetsEditorOpen,
    iosPresetImporterOpen,
    setIosPresetImporterOpen,
    iosFileManagerOpen,
    setIosFileManagerOpen,
    iosModelProvidersManagerOpen,
    setIosModelProvidersManagerOpen,
    iosMcpServersManagerOpen,
    setIosMcpServersManagerOpen,
    iosEmojiStickersManagerOpen,
    setIosEmojiStickersManagerOpen,
    iosTerminalManagerOpen,
    setIosTerminalManagerOpen,
    iosRedisAdminOpen,
    setIosRedisAdminOpen,
  } = useUIStore();
  const allocateZ = useWindowsStore(s => s.allocateZ);
  const {
    terminalWindows,
    bringTerminalToFront,
    handleCloseTerminal,
    handleMinimizeTerminal,
  } = useTerminals({ addToast, allocateZ });

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

  const allocateIOSZ = React.useCallback(() => {
    try {
      if (allocateZ) return allocateZ();
    } catch {
      // ignore
    }
    iosZNextRef.current += 1;
    return iosZNextRef.current;
  }, [allocateZ]);

  const bringIOSAppToFront = React.useCallback((id: string) => {
    if (!id) return;
    const z = allocateIOSZ();
    setIosZMap(prev => ({ ...prev, [id]: z }));
  }, [allocateIOSZ]);

  const openIOSAppSwitcher = React.useCallback(() => {
    setIosAppSwitcherOpen(true);
  }, []);

  const handleGlobalSwipeStart = React.useCallback((x: number, y: number) => {
    iosGlobalSwipeRef.current = { x, y, opened: false };
  }, []);

  const handleGlobalSwipeMove = React.useCallback((x: number, y: number) => {
    const st = iosGlobalSwipeRef.current;
    if (!st) return;
    if (st.opened) return;
    const dx = x - st.x;
    const dy = y - st.y;
    const bottomZone = st.y >= (window.innerHeight - 120);
    if (bottomZone && dy < -32 && Math.abs(dy) > Math.abs(dx)) {
      st.opened = true;
      openIOSAppSwitcher();
    }
  }, [openIOSAppSwitcher]);

  const handleGlobalSwipeEnd = React.useCallback(() => {
    iosGlobalSwipeRef.current = null;
  }, []);

  const wrapDesktopIconForIOS = React.useCallback((icon: DesktopIcon): DesktopIcon => {
    if (!icon) return icon;
    if (icon.id === 'desktop-terminal-manager') {
      return {
        ...icon,
        onClick: () => {
          setReturnToLaunchpad(false);
          setIosTerminalManagerOpen(true);
          bringIOSAppToFront('ios-terminal-manager');
        },
      };
    }
    if (icon.id === 'desktop-emoji-stickers-manager') {
      return {
        ...icon,
        onClick: () => {
          setReturnToLaunchpad(false);
          setIosEmojiStickersManagerOpen(true);
          bringIOSAppToFront('ios-emoji-stickers-manager');
        },
      };
    }
    if (icon.id === 'desktop-mcp-servers-manager') {
      return {
        ...icon,
        onClick: () => {
          setReturnToLaunchpad(false);
          setIosMcpServersManagerOpen(true);
          bringIOSAppToFront('ios-mcp-servers-manager');
        },
      };
    }
    return icon;
  }, [bringIOSAppToFront, setIosEmojiStickersManagerOpen, setIosMcpServersManagerOpen, setIosTerminalManagerOpen]);

  const iosHomeIcons = React.useMemo(() => {
    return (desktopIcons || [])
      .filter(icon => icon.id !== 'desktop-dev-center')
      .map(wrapDesktopIconForIOS);
  }, [desktopIcons, wrapDesktopIconForIOS]);

  const iosHomeFolders = React.useMemo(() => {
    return (desktopFolders || []).map(folder => ({
      ...folder,
      apps: (folder.apps || []).map(wrapDesktopIconForIOS),
    }));
  }, [desktopFolders, wrapDesktopIconForIOS]);

  React.useEffect(() => {
    if (iosPresetsEditorOpen && iosZMap['ios-presets-editor'] == null) bringIOSAppToFront('ios-presets-editor');
  }, [bringIOSAppToFront, iosPresetsEditorOpen, iosZMap]);

  React.useEffect(() => {
    if (iosPresetImporterOpen && iosZMap['ios-preset-importer'] == null) bringIOSAppToFront('ios-preset-importer');
  }, [bringIOSAppToFront, iosPresetImporterOpen, iosZMap]);

  React.useEffect(() => {
    if (iosFileManagerOpen && iosZMap['ios-file-manager'] == null) bringIOSAppToFront('ios-file-manager');
  }, [bringIOSAppToFront, iosFileManagerOpen, iosZMap]);

  React.useEffect(() => {
    if (iosModelProvidersManagerOpen && iosZMap['ios-model-providers-manager'] == null) bringIOSAppToFront('ios-model-providers-manager');
  }, [bringIOSAppToFront, iosModelProvidersManagerOpen, iosZMap]);

  React.useEffect(() => {
    if (iosMcpServersManagerOpen && iosZMap['ios-mcp-servers-manager'] == null) bringIOSAppToFront('ios-mcp-servers-manager');
  }, [bringIOSAppToFront, iosMcpServersManagerOpen, iosZMap]);

  React.useEffect(() => {
    if (iosEmojiStickersManagerOpen && iosZMap['ios-emoji-stickers-manager'] == null) bringIOSAppToFront('ios-emoji-stickers-manager');
  }, [bringIOSAppToFront, iosEmojiStickersManagerOpen, iosZMap]);

  React.useEffect(() => {
    if (iosTerminalManagerOpen && iosZMap['ios-terminal-manager'] == null) bringIOSAppToFront('ios-terminal-manager');
  }, [bringIOSAppToFront, iosTerminalManagerOpen, iosZMap]);

  React.useEffect(() => {
    if (iosRedisAdminOpen && iosZMap['ios-redis-admin'] == null) bringIOSAppToFront('ios-redis-admin');
  }, [bringIOSAppToFront, iosRedisAdminOpen, iosZMap]);

  React.useEffect(() => {
    if (activeIOSEditorId && iosZMap[activeIOSEditorId] == null) bringIOSAppToFront(activeIOSEditorId);
  }, [activeIOSEditorId, bringIOSAppToFront, iosZMap]);

  const topByUsage = [...allItems]
    .map(item => ({ item, count: usageCounts[`${item.type}:${item.name}`] || 0 }))
    .sort((a, b) => b.count - a.count);
  const fallback = [...allItems].sort((a, b) => getDisplayName(a.name).localeCompare(getDisplayName(b.name), 'zh-Hans-CN'));
  const pick = (arr: { item: FileItem, count?: number }[], n: number) => arr.slice(0, n).map(x => x.item);

  const selected = (topByUsage[0]?.count ? pick(topByUsage, 12) : fallback.slice(0, 12));

  const iosDockExtra: { id: string; name: string; icon: React.ReactNode; onClick: () => void }[] = [];
  const seen = new Set<string>();
  const push = (it: { id: string; name: string; icon: React.ReactNode; onClick: () => void }) => {
    if (!it?.id) return;
    if (seen.has(it.id)) return;
    seen.add(it.id);
    iosDockExtra.push(it);
  };

  // Pin core utility apps first (so they appear in Dock whenever possible)
  push({
    id: 'module-terminal-manager',
    name: '终端执行器',
    icon: getIconForType('terminal-manager', 'module'),
    onClick: () => {
      setReturnToLaunchpad(false);
      setIosTerminalManagerOpen(true);
      bringIOSAppToFront('ios-terminal-manager');
    }
  });

  push({
    id: 'module-emoji-stickers-manager',
    name: '表情包配置',
    icon: getIconForType('emoji-stickers-manager', 'module'),
    onClick: () => {
      setReturnToLaunchpad(false);
      setIosEmojiStickersManagerOpen(true);
      bringIOSAppToFront('ios-emoji-stickers-manager');
    }
  });

  // Main candidates: most-used apps (not hardcoded count; IOSHomeScreen will cap by width)
  for (const it of selected) {
    push({
      id: `${it.type}-${it.name}`,
      name: getDisplayName(it.name),
      icon: getIconForType(it.name, it.type),
      onClick: () => {
        recordUsage(`${it.type}:${it.name}`);
        setReturnToLaunchpad(false); // Reset when opening from Dock
        const id = openIOSWindow(it);
        bringIOSAppToFront(id);
      }
    });
  }

  // Built-in candidates (optional; will only show if there's room)
  push({
    id: 'module-presets-editor',
    name: '预设撰写',
    icon: getIconForType('agent-presets', 'module'),
    onClick: () => {
      setIosPresetsEditorOpen(true);
      bringIOSAppToFront('ios-presets-editor');
    }
  });

  push({
    id: 'module-preset-importer',
    name: '预设导入',
    icon: getIconForType('agent-presets', 'module'),
    onClick: () => {
      setIosPresetImporterOpen(true);
      bringIOSAppToFront('ios-preset-importer');
    }
  });

  push({
    id: 'module-file-manager',
    name: '文件管理',
    icon: getIconForType('file-manager', 'module'),
    onClick: () => {
      setIosFileManagerOpen(true);
      bringIOSAppToFront('ios-file-manager');
    }
  });

  return (
    <div
      style={{ position: 'fixed', inset: 0 }}
      onTouchStartCapture={(e) => {
        const t = e.touches?.[0];
        if (!t) return;
        const el = e.target as HTMLElement | null;
        if (el && (el.closest('.xterm') || el.closest('.terminalContainer') || el.closest('.terminalWrapper'))) return;
        handleGlobalSwipeStart(t.clientX, t.clientY);
      }}
      onTouchMoveCapture={(e) => {
        const t = e.touches?.[0];
        if (!t) return;
        handleGlobalSwipeMove(t.clientX, t.clientY);
      }}
      onTouchEndCapture={handleGlobalSwipeEnd}
      onTouchCancelCapture={handleGlobalSwipeEnd}
      onPointerDownCapture={(e) => {
        const el = e.target as HTMLElement | null;
        if (el && (el.closest('.xterm') || el.closest('.terminalContainer') || el.closest('.terminalWrapper'))) return;
        handleGlobalSwipeStart(e.clientX, e.clientY);
      }}
      onPointerMoveCapture={(e) => {
        if ((e.buttons ?? 0) === 0) return;
        handleGlobalSwipeMove(e.clientX, e.clientY);
      }}
      onPointerUpCapture={handleGlobalSwipeEnd}
      onPointerCancelCapture={handleGlobalSwipeEnd}
    >
      <IOSHomeScreen
        icons={iosHomeIcons}
        folders={iosHomeFolders}
        onLaunch={(icon) => {
          setReturnToLaunchpad(false); // Reset when opening from Home
          icon.onClick();
        }}
        wallpaper="/wallpapers/ios-default.png"
        onLaunchpadOpen={() => setLaunchpadOpen(true)}
        dockExtra={iosDockExtra}
        onAppSwitcherOpen={openIOSAppSwitcher}
      />

      {iosAppSwitcherOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 999999,
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            display: 'flex',
            flexDirection: 'column',
          }}
          onClick={() => setIosAppSwitcherOpen(false)}
        >
          <div
            style={{
              padding: '14px 12px 10px',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700 }}>后台应用</div>
            <div
              style={{
                padding: '6px 10px',
                borderRadius: 10,
                background: 'rgba(255,255,255,0.14)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onClick={() => setIosAppSwitcherOpen(false)}
            >
              完成
            </div>
          </div>

          <div
            style={{
              flex: 1,
              overflowX: 'auto',
              overflowY: 'hidden',
              padding: '10px 12px 18px',
              display: 'flex',
              gap: 14,
              scrollSnapType: 'x mandatory',
              WebkitOverflowScrolling: 'touch',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const rows: {
                id: string;
                name: string;
                icon: React.ReactNode;
                subtitle?: string;
                onOpen: () => void;
                onClose: () => void;
              }[] = [];

              if (iosTerminalManagerOpen) {
                rows.push({
                  id: 'ios-terminal-manager',
                  name: '终端执行器',
                  icon: getIconForType('terminal-manager', 'module'),
                  onOpen: () => {
                    setIosTerminalManagerOpen(true);
                    bringIOSAppToFront('ios-terminal-manager');
                    setIosAppSwitcherOpen(false);
                  },
                  onClose: () => setIosTerminalManagerOpen(false),
                });
              }
              if (iosEmojiStickersManagerOpen) {
                rows.push({
                  id: 'ios-emoji-stickers-manager',
                  name: '表情包配置',
                  icon: getIconForType('emoji-stickers-manager', 'module'),
                  onOpen: () => {
                    setIosEmojiStickersManagerOpen(true);
                    bringIOSAppToFront('ios-emoji-stickers-manager');
                    setIosAppSwitcherOpen(false);
                  },
                  onClose: () => setIosEmojiStickersManagerOpen(false),
                });
              }
              if (iosPresetsEditorOpen) {
                rows.push({
                  id: 'ios-presets-editor',
                  name: '预设撰写',
                  icon: getIconForType('agent-presets', 'module'),
                  onOpen: () => {
                    setIosPresetsEditorOpen(true);
                    bringIOSAppToFront('ios-presets-editor');
                    setIosAppSwitcherOpen(false);
                  },
                  onClose: () => setIosPresetsEditorOpen(false),
                });
              }
              if (iosPresetImporterOpen) {
                rows.push({
                  id: 'ios-preset-importer',
                  name: '预设导入',
                  icon: getIconForType('agent-presets', 'module'),
                  onOpen: () => {
                    setIosPresetImporterOpen(true);
                    bringIOSAppToFront('ios-preset-importer');
                    setIosAppSwitcherOpen(false);
                  },
                  onClose: () => setIosPresetImporterOpen(false),
                });
              }
              if (iosFileManagerOpen) {
                rows.push({
                  id: 'ios-file-manager',
                  name: '文件管理',
                  icon: getIconForType('file-manager', 'module'),
                  onOpen: () => {
                    setIosFileManagerOpen(true);
                    bringIOSAppToFront('ios-file-manager');
                    setIosAppSwitcherOpen(false);
                  },
                  onClose: () => setIosFileManagerOpen(false),
                });
              }
              if (iosModelProvidersManagerOpen) {
                rows.push({
                  id: 'ios-model-providers-manager',
                  name: '模型供应商',
                  icon: getIconForType('model-providers-manager', 'module'),
                  onOpen: () => {
                    setIosModelProvidersManagerOpen(true);
                    bringIOSAppToFront('ios-model-providers-manager');
                    setIosAppSwitcherOpen(false);
                  },
                  onClose: () => setIosModelProvidersManagerOpen(false),
                });
              }
              if (iosMcpServersManagerOpen) {
                rows.push({
                  id: 'ios-mcp-servers-manager',
                  name: '外部 MCP 工具',
                  icon: getIconForType('mcp-servers-manager', 'module'),
                  onOpen: () => {
                    setIosMcpServersManagerOpen(true);
                    bringIOSAppToFront('ios-mcp-servers-manager');
                    setIosAppSwitcherOpen(false);
                  },
                  onClose: () => setIosMcpServersManagerOpen(false),
                });
              }
              if (iosRedisAdminOpen) {
                rows.push({
                  id: 'ios-redis-admin',
                  name: 'Redis 管理器',
                  icon: getIconForType('redis-admin', 'module'),
                  onOpen: () => {
                    setIosRedisAdminOpen(true);
                    bringIOSAppToFront('ios-redis-admin');
                    setIosAppSwitcherOpen(false);
                  },
                  onClose: () => setIosRedisAdminOpen(false),
                });
              }

              for (const win of iosEditorWindows || []) {
                rows.push({
                  id: win.id,
                  name: getDisplayName(win.file.name),
                  icon: getIconForType(win.file.name, win.file.type),
                  subtitle: win.minimized ? '已最小化' : (win.id === activeIOSEditorId ? '前台' : '后台'),
                  onOpen: () => {
                    const id = openIOSWindow(win.file);
                    bringIOSAppToFront(id);
                    setIosAppSwitcherOpen(false);
                  },
                  onClose: () => handleIOSCloseEditor(win.id),
                });
              }

              for (const t of terminalWindows || []) {
                rows.push({
                  id: t.id,
                  name: t.title || '终端',
                  icon: getIconForType('terminal-manager', 'module'),
                  subtitle: t.minimized ? '已最小化' : '运行中',
                  onOpen: () => {
                    bringTerminalToFront(t.id);
                    setIosAppSwitcherOpen(false);
                  },
                  onClose: () => void handleCloseTerminal(t.id),
                });
              }

              if (rows.length === 0) {
                return (
                  <div style={{ color: 'rgba(255,255,255,0.7)', padding: '12px 4px' }}>
                    当前没有后台应用。
                  </div>
                );
              }

              const cardW = Math.min(Math.floor(window.innerWidth * 0.78), 360);
              const cardH = Math.min(Math.floor(window.innerHeight * 0.72), 620);

              return rows.map((r) => (
                <div
                  key={r.id}
                  style={{
                    width: cardW,
                    height: cardH,
                    borderRadius: 26,
                    overflow: 'hidden',
                    position: 'relative',
                    flexShrink: 0,
                    scrollSnapAlign: 'center',
                    border: '1px solid rgba(255,255,255,0.18)',
                    boxShadow: '0 18px 50px rgba(0,0,0,0.45)',
                    background: 'rgba(255,255,255,0.08)',
                    cursor: 'pointer',
                  }}
                  onClick={r.onOpen}
                >
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      backgroundImage: 'url(/wallpapers/ios-default.png)',
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      filter: 'blur(0px)',
                      opacity: 0.45,
                      transform: 'scale(1.05)',
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.45) 70%, rgba(0,0,0,0.65) 100%)',
                    }}
                  />

                  <div
                    style={{
                      position: 'absolute',
                      top: 12,
                      left: 12,
                      right: 12,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <div style={{ width: 42, height: 42, borderRadius: 14, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.12)' }}>
                        {r.icon}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: '#fff', fontWeight: 800, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                        {r.subtitle ? (
                          <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 12, marginTop: 2 }}>{r.subtitle}</div>
                        ) : null}
                      </div>
                    </div>

                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 17,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(255,255,255,0.16)',
                        border: '1px solid rgba(255,255,255,0.18)',
                        color: '#fff',
                        userSelect: 'none',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        r.onClose();
                      }}
                      aria-label="关闭应用"
                    >
                      ×
                    </div>
                  </div>

                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: 0,
                      padding: '14px 14px',
                      color: 'rgba(255,255,255,0.78)',
                      fontSize: 12,
                      display: 'flex',
                      justifyContent: 'center',
                    }}
                  >
                    轻触进入 · 点 × 关闭
                  </div>
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      {iosMcpServersManagerOpen && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: iosZMap['ios-mcp-servers-manager'] ?? 2000 }}
          onPointerDownCapture={() => bringIOSAppToFront('ios-mcp-servers-manager')}
        >
          <div className="ios-app-window" style={{ display: 'flex' }}>
            <div className="ios-app-header">
              <div className="ios-back-btn" onClick={() => {
                setIosMcpServersManagerOpen(false);
                if (returnToLaunchpad) setLaunchpadOpen(true);
              }}>
                <IoChevronBack /> {returnToLaunchpad ? '应用' : '主页'}
              </div>
              <div>外部 MCP 工具</div>
              <div style={{ color: '#ff3b30', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setIosMcpServersManagerOpen(false)}>
                关闭
              </div>
            </div>
            <div className="ios-app-content">
              <Suspense fallback={<SentraLoading title="加载 外部 MCP 工具" subtitle="首次打开可能较慢，请稍等..." />}>
                <McpServersManager addToast={addToast as any} />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      {terminalWindows.map(term => (
        <div
          key={term.id}
          className="ios-app-window"
          style={{ display: term.minimized ? 'none' : 'flex', zIndex: (term.z ?? 2000) + 3000 }}
          onPointerDownCapture={() => {
            bringTerminalToFront(term.id);
          }}
        >
          <div className="ios-app-header">
            <div className="ios-back-btn" onClick={() => {
              handleMinimizeTerminal(term.id);
              if (iosTerminalManagerOpen) {
                bringIOSAppToFront('ios-terminal-manager');
              }
              if (returnToLaunchpad) {
                setLaunchpadOpen(true);
              }
            }}>
              <IoChevronBack /> {iosTerminalManagerOpen ? '终端' : (returnToLaunchpad ? '应用' : '主页')}
            </div>
            <div>{term.title}</div>
            <div style={{ color: '#ff3b30', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => handleCloseTerminal(term.id)}>
              关闭
            </div>
          </div>
          <Suspense fallback={<SentraLoading title="加载终端" subtitle="首次打开可能较慢，请稍等..." />}>
            {String(term.appKey || '').startsWith('execpty:') ? (
              <TerminalExecutorWindow sessionId={term.processId} onSessionNotFound={() => handleCloseTerminal(term.id)} />
            ) : (
              <TerminalWindow processId={term.processId} onProcessNotFound={() => handleCloseTerminal(term.id)} />
            )}
          </Suspense>
        </div>
      ))}

      <Launchpad
        isOpen={launchpadOpen}
        onClose={() => setLaunchpadOpen(false)}
        items={[
          {
            name: 'presets-editor',
            type: 'module' as const,
            onClick: () => {
              recordUsage('app:presets');
              setReturnToLaunchpad(true);
              setIosPresetsEditorOpen(true);
              bringIOSAppToFront('ios-presets-editor');
              setLaunchpadOpen(false);
            }
          },
          {
            name: 'preset-importer',
            type: 'module' as const,
            onClick: () => {
              recordUsage('app:preset-importer');
              setReturnToLaunchpad(true);
              setIosPresetImporterOpen(true);
              bringIOSAppToFront('ios-preset-importer');
              setLaunchpadOpen(false);
            }
          },
          {
            name: 'file-manager',
            type: 'module' as const,
            onClick: () => {
              recordUsage('app:filemanager');
              setReturnToLaunchpad(true);
              setIosFileManagerOpen(true);
              bringIOSAppToFront('ios-file-manager');
              setLaunchpadOpen(false);
            }
          },
          {
            name: 'model-providers-manager',
            type: 'module' as const,
            onClick: () => {
              recordUsage('app:model-providers-manager');
              setReturnToLaunchpad(true);
              setIosModelProvidersManagerOpen(true);
              bringIOSAppToFront('ios-model-providers-manager');
              setLaunchpadOpen(false);
            }
          },
          {
            name: 'mcp-servers-manager',
            type: 'module' as const,
            onClick: () => {
              recordUsage('app:mcp-servers-manager');
              setReturnToLaunchpad(true);
              setIosMcpServersManagerOpen(true);
              bringIOSAppToFront('ios-mcp-servers-manager');
              setLaunchpadOpen(false);
            }
          },
          {
            name: 'terminal-manager',
            type: 'module' as const,
            onClick: () => {
              recordUsage('app:terminal-manager');
              setReturnToLaunchpad(true);
              setIosTerminalManagerOpen(true);
              bringIOSAppToFront('ios-terminal-manager');
              setLaunchpadOpen(false);
            }
          },
          {
            name: 'emoji-stickers-manager',
            type: 'module' as const,
            onClick: () => {
              recordUsage('app:emoji-stickers-manager');
              setReturnToLaunchpad(true);
              setIosEmojiStickersManagerOpen(true);
              bringIOSAppToFront('ios-emoji-stickers-manager');
              setLaunchpadOpen(false);
            }
          },
          {
            name: 'redis-admin',
            type: 'module' as const,
            onClick: () => {
              recordUsage('app:redis-admin');
              setReturnToLaunchpad(true);
              setIosRedisAdminOpen(true);
              bringIOSAppToFront('ios-redis-admin');
              setLaunchpadOpen(false);
            }
          },
          ...allItems.filter(item => item.name !== 'utils/emoji-stickers').map(item => ({
            name: item.name,
            type: item.type,
            onClick: () => {
              recordUsage(`${item.type}:${item.name}`);
              setReturnToLaunchpad(true); // Set flag when opening from Launchpad
              const id = openIOSWindow(item);
              bringIOSAppToFront(id);
              setLaunchpadOpen(false);
            }
          }))
        ]}
      />

      {iosEditorWindows
        .filter(win => !win.minimized)
        .map(win => (
          <div
            key={win.id}
            style={{ display: win.id === activeIOSEditorId ? 'flex' : 'none', position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: iosZMap[win.id] ?? 2000 }}
            onPointerDownCapture={() => bringIOSAppToFront(win.id)}
          >
            <IOSEditor
              appName={getDisplayName(win.file.name)}
              vars={win.editedVars}
              onUpdate={(idx, field, val) => handleIOSVarChange(win.id, idx, field, val)}
              onAdd={() => handleIOSAddVar(win.id)}
              onDelete={(idx) => handleIOSDeleteVar(win.id, idx)}
              onSave={() => handleIOSSave(win.id)}
              onMinimize={() => {
                handleIOSMinimizeEditor(win.id);
                if (returnToLaunchpad) {
                  setLaunchpadOpen(true);
                }
              }}
              onClose={() => handleIOSCloseEditor(win.id)}
              saving={saving}
              isExample={!win.file.hasEnv && win.file.hasExample}
              backLabel={returnToLaunchpad ? '应用' : '主页'}
            />
          </div>
        ))}

      {iosPresetsEditorOpen && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: iosZMap['ios-presets-editor'] ?? 2000 }}
          onPointerDownCapture={() => bringIOSAppToFront('ios-presets-editor')}
        >
          <IOSPresetsEditor
            onClose={() => setIosPresetsEditorOpen(false)}
            addToast={addToast}
            state={presetsState}
          />
        </div>
      )}

      {iosTerminalManagerOpen && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: iosZMap['ios-terminal-manager'] ?? 2000 }}
          onPointerDownCapture={() => bringIOSAppToFront('ios-terminal-manager')}
        >
          <div className="ios-app-window" style={{ display: 'flex' }}>
            <Suspense fallback={<SentraLoading title="加载 终端执行器" subtitle="首次打开可能较慢，请稍等..." />}>
              <IOSTerminalManager
                addToast={addToast as any}
                backLabel={returnToLaunchpad ? '应用' : '主页'}
                onClose={() => {
                  setIosTerminalManagerOpen(false);
                  if (returnToLaunchpad) setLaunchpadOpen(true);
                }}
              />
            </Suspense>
          </div>
        </div>
      )}

      {iosEmojiStickersManagerOpen && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: iosZMap['ios-emoji-stickers-manager'] ?? 2000 }}
          onPointerDownCapture={() => bringIOSAppToFront('ios-emoji-stickers-manager')}
        >
          <div className="ios-app-window" style={{ display: 'flex' }}>
            <Suspense fallback={<SentraLoading title="加载 表情包配置" subtitle="首次打开可能较慢，请稍等..." />}>
              <IOSEmojiStickersManager
                addToast={addToast as any}
                backLabel={returnToLaunchpad ? '应用' : '主页'}
                onClose={() => {
                  setIosEmojiStickersManagerOpen(false);
                  if (returnToLaunchpad) setLaunchpadOpen(true);
                }}
              />
            </Suspense>
          </div>
        </div>
      )}

      {iosPresetImporterOpen && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: iosZMap['ios-preset-importer'] ?? 2000 }}
          onPointerDownCapture={() => bringIOSAppToFront('ios-preset-importer')}
        >
          <PresetImporter
            onClose={() => setIosPresetImporterOpen(false)}
            addToast={addToast as any}
            state={presetsState}
            theme={theme}
          />
        </div>
      )}

      {iosFileManagerOpen && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: iosZMap['ios-file-manager'] ?? 2000 }}
          onPointerDownCapture={() => bringIOSAppToFront('ios-file-manager')}
        >
          <div className="ios-app-window" style={{ display: 'flex' }}>
            <div className="ios-app-header">
              <div className="ios-back-btn" onClick={() => setIosFileManagerOpen(false)}>
                <IoChevronBack /> 主页
              </div>
              <div>文件管理</div>
              <div style={{ color: '#ff3b30', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setIosFileManagerOpen(false)}>
                关闭
              </div>
            </div>
            <div className="ios-app-content">
              <IOSFileManager
                onClose={() => setIosFileManagerOpen(false)}
                addToast={addToast}
                theme={theme}
              />
            </div>
          </div>
        </div>
      )}

      {iosModelProvidersManagerOpen && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: iosZMap['ios-model-providers-manager'] ?? 2000 }}
          onPointerDownCapture={() => bringIOSAppToFront('ios-model-providers-manager')}
        >
          <div className="ios-app-window" style={{ display: 'flex' }}>
            <div className="ios-app-header">
              <div className="ios-back-btn" onClick={() => {
                setIosModelProvidersManagerOpen(false);
                if (returnToLaunchpad) setLaunchpadOpen(true);
              }}>
                <IoChevronBack /> {returnToLaunchpad ? '应用' : '主页'}
              </div>
              <div>模型供应商</div>
              <div style={{ color: '#ff3b30', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setIosModelProvidersManagerOpen(false)}>
                关闭
              </div>
            </div>
            <div className="ios-app-content">
              <Suspense fallback={<SentraLoading title="加载 模型供应商" subtitle="首次打开可能较慢，请稍等..." />}>
                <ModelProvidersManager addToast={addToast as any} />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      {iosRedisAdminOpen && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: iosZMap['ios-redis-admin'] ?? 2000 }}
          onPointerDownCapture={() => bringIOSAppToFront('ios-redis-admin')}
        >
          <div className="ios-app-window" style={{ display: 'flex' }}>
            <div className="ios-app-header">
              <div className="ios-back-btn" onClick={() => {
                setIosRedisAdminOpen(false);
                if (returnToLaunchpad) setLaunchpadOpen(true);
              }}>
                <IoChevronBack /> {returnToLaunchpad ? '应用' : '主页'}
              </div>
              <div>Redis 管理器</div>
              <div style={{ color: '#ff3b30', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setIosRedisAdminOpen(false)}>
                关闭
              </div>
            </div>
            <div className="ios-app-content">
              <Suspense fallback={<SentraLoading title="加载 Redis 管理器" subtitle="首次打开可能较慢，请稍等..." />}>
                <RedisAdminManager addToast={addToast as any} />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}
