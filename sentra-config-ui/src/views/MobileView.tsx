import React, { Suspense } from 'react';
import { IOSHomeScreen } from '../components/IOSHomeScreen';
import { IOSEditor } from '../components/IOSEditor';
import { IOSPresetsEditor } from '../components/IOSPresetsEditor';
import { PresetImporter } from '../components/PresetImporter';
import { Launchpad } from '../components/Launchpad';
import { TerminalWindow } from '../components/TerminalWindow';
import { ToastContainer, ToastMessage, ToastType } from '../components/Toast';
import { IoChevronBack } from 'react-icons/io5';
import { getDisplayName, getIconForType } from '../utils/icons';
import { FileItem, IOSEditorWin, DesktopIcon, TerminalWin, AppFolder } from '../types/ui';
import { PresetsEditorState } from '../hooks/usePresetsEditor';
import { IOSFileManager } from '../components/IOSFileManager';

const ModelProvidersManager = React.lazy(() => import('../components/ModelProvidersManager/ModelProvidersManager').then(module => ({ default: module.default })));
const RedisAdminManager = React.lazy(() => import('../components/RedisAdminManager/RedisAdminManager').then(module => ({ default: module.RedisAdminManager })));

export type MobileViewProps = {
  allItems: FileItem[];
  usageCounts: Record<string, number>;
  recordUsage: (key: string) => void;
  desktopIcons: DesktopIcon[];
  desktopFolders: AppFolder[];
  theme: 'light' | 'dark';
  launchpadOpen: boolean;
  setLaunchpadOpen: (open: boolean) => void;
  handleIOSOpenWindow: (file: FileItem) => void;
  iosEditorWindows: IOSEditorWin[];
  activeIOSEditorId: string | null;
  saving: boolean;
  handleIOSVarChange: (id: string, index: number, field: 'key' | 'value' | 'comment', val: string) => void;
  handleIOSAddVar: (id: string) => void;
  handleIOSDeleteVar: (id: string, index: number) => void;
  handleIOSSave: (id: string) => void | Promise<void>;
  handleIOSMinimizeEditor: (id: string) => void;
  handleIOSCloseEditor: (id: string) => void;
  toasts: ToastMessage[];
  removeToast: (id: string) => void;
  terminalWindows: TerminalWin[];
  handleMinimizeTerminal: (id: string) => void;
  handleCloseTerminal: (id: string) => void;
  iosPresetsEditorOpen: boolean;
  setIosPresetsEditorOpen: (open: boolean) => void;
  iosPresetImporterOpen: boolean;
  setIosPresetImporterOpen: (open: boolean) => void;
  iosFileManagerOpen: boolean;
  setIosFileManagerOpen: (open: boolean) => void;
  iosModelProvidersManagerOpen: boolean;
  setIosModelProvidersManagerOpen: (open: boolean) => void;
  iosRedisAdminOpen: boolean;
  setIosRedisAdminOpen: (open: boolean) => void;
  addToast: (type: ToastType, title: string, message?: string) => void;
  presetsState: PresetsEditorState;
};

export function MobileView(props: MobileViewProps) {
  const [returnToLaunchpad, setReturnToLaunchpad] = React.useState(false);
  const {
    allItems,
    usageCounts,
    recordUsage,
    desktopIcons,
    desktopFolders,
    theme,
    launchpadOpen,
    setLaunchpadOpen,
    handleIOSOpenWindow,
    iosEditorWindows,
    activeIOSEditorId,
    saving,
    handleIOSVarChange,
    handleIOSAddVar,
    handleIOSDeleteVar,
    handleIOSSave,
    handleIOSMinimizeEditor,
    handleIOSCloseEditor,
    toasts,
    removeToast,
    terminalWindows,
    handleMinimizeTerminal,
    handleCloseTerminal,
    iosPresetsEditorOpen,
    setIosPresetsEditorOpen,
    iosPresetImporterOpen,
    setIosPresetImporterOpen,
    iosFileManagerOpen,
    setIosFileManagerOpen,
    iosModelProvidersManagerOpen,
    setIosModelProvidersManagerOpen,
    iosRedisAdminOpen,
    setIosRedisAdminOpen,
    addToast,
    presetsState,
  } = props;

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

  // Main candidates: most-used apps (not hardcoded count; IOSHomeScreen will cap by width)
  for (const it of selected) {
    push({
      id: `${it.type}-${it.name}`,
      name: getDisplayName(it.name),
      icon: getIconForType(it.name, it.type),
      onClick: () => {
        recordUsage(`${it.type}:${it.name}`);
        setReturnToLaunchpad(false); // Reset when opening from Dock
        handleIOSOpenWindow(it);
      }
    });
  }

  // Built-in candidates (optional; will only show if there's room)
  push({
    id: 'module-presets-editor',
    name: '预设撰写',
    icon: getIconForType('agent-presets', 'module'),
    onClick: () => setIosPresetsEditorOpen(true)
  });

  push({
    id: 'module-preset-importer',
    name: '预设导入',
    icon: getIconForType('agent-presets', 'module'),
    onClick: () => setIosPresetImporterOpen(true)
  });

  push({
    id: 'module-file-manager',
    name: '文件管理',
    icon: getIconForType('file-manager', 'module'),
    onClick: () => setIosFileManagerOpen(true)
  });


  return (
    <>
      <IOSHomeScreen
        icons={desktopIcons.filter(icon => icon.id !== 'desktop-dev-center')}
        folders={desktopFolders}
        onLaunch={(icon) => {
          setReturnToLaunchpad(false); // Reset when opening from Home
          icon.onClick();
        }}
        wallpaper="/wallpapers/ios-default.png"
        onLaunchpadOpen={() => setLaunchpadOpen(true)}
        dockExtra={iosDockExtra}
      />

      {terminalWindows.map(term => (
        <div key={term.id} className="ios-app-window" style={{ display: term.minimized ? 'none' : 'flex' }}>
          <div className="ios-app-header">
            <div className="ios-back-btn" onClick={() => {
              handleMinimizeTerminal(term.id);
              if (returnToLaunchpad) {
                setLaunchpadOpen(true);
              }
            }}>
              <IoChevronBack /> {returnToLaunchpad ? '应用' : '主页'}
            </div>
            <div>{term.title}</div>
            <div style={{ color: '#ff3b30', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => handleCloseTerminal(term.id)}>
              关闭
            </div>
          </div>
          <TerminalWindow processId={term.processId} />
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
              setLaunchpadOpen(false);
            }
          },
          ...allItems.map(item => ({
            name: item.name,
            type: item.type,
            onClick: () => {
              recordUsage(`${item.type}:${item.name}`);
              setReturnToLaunchpad(true); // Set flag when opening from Launchpad
              handleIOSOpenWindow(item);
              setLaunchpadOpen(false);
            }
          }))
        ]}
      />

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
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 2000 }}>
          <IOSPresetsEditor
            onClose={() => setIosPresetsEditorOpen(false)}
            addToast={addToast}
            state={presetsState}
          />
        </div>
      )}

      {iosPresetImporterOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 2000 }}>
          <PresetImporter
            onClose={() => setIosPresetImporterOpen(false)}
            addToast={addToast as any}
            state={presetsState}
            theme={theme}
          />
        </div>
      )}

      {iosFileManagerOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 2000 }}>
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
            <div className="ios-app-content" style={{ overflow: 'hidden' }}>
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
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 2000 }}>
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
            <div className="ios-app-content" style={{ overflow: 'hidden' }}>
              <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载中...</div>}>
                <ModelProvidersManager addToast={addToast as any} />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      {iosRedisAdminOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 2000 }}>
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
            <div className="ios-app-content" style={{ overflow: 'hidden' }}>
              <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载中...</div>}>
                <RedisAdminManager addToast={addToast as any} />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </>
  );
}
