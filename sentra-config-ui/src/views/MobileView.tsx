import React from 'react';
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
import { IOSRedisEditor } from '../components/RedisEditor/IOSRedisEditor';

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
  addToast: (type: ToastType, title: string, message?: string) => void;
  presetsState: PresetsEditorState;
  redisState: any;
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
    addToast,
    presetsState,
    redisState,
  } = props;

  const topByUsage = [...allItems]
    .map(item => ({ item, count: usageCounts[`${item.type}:${item.name}`] || 0 }))
    .sort((a, b) => b.count - a.count);
  const fallback = [...allItems].sort((a, b) => getDisplayName(a.name).localeCompare(getDisplayName(b.name), 'zh-Hans-CN'));
  const pick = (arr: { item: FileItem, count?: number }[], n: number) => arr.slice(0, n).map(x => x.item);

  // Select top 2 items for dock (reduced from 3 to fit max 5 dock items total)
  const selected = (topByUsage[0]?.count ? pick(topByUsage, 2) : fallback.slice(0, 2));

  // Create dock items from selected (maximum 2 dynamic items)
  // Total dock: Launchpad (1) + 2 dynamic + Presets (1) + File Manager (1) = 5 items
  const iosDockExtra = selected.slice(0, 2).map(it => ({
    id: `${it.type}-${it.name}`,
    name: getDisplayName(it.name),
    icon: getIconForType(it.name, it.type),
    onClick: () => {
      recordUsage(`${it.type}:${it.name}`);
      setReturnToLaunchpad(false); // Reset when opening from Dock
      handleIOSOpenWindow(it);
    }
  }));

  // Add fixed items (Presets + File Manager = 2 items)
  // Total: Launchpad (always present) + 2 dynamic + 2 fixed = 5 items (maximum)
  iosDockExtra.push({
    id: 'ios-presets',
    name: '预设撰写',
    icon: getIconForType('agent-presets', 'module'),
    onClick: () => setIosPresetsEditorOpen(true)
  });

  iosDockExtra.push({
    id: 'ios-preset-importer',
    name: '预设导入',
    icon: getIconForType('agent-presets', 'module'),
    onClick: () => setIosPresetImporterOpen(true)
  });

  iosDockExtra.push({
    id: 'ios-filemanager',
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
            name: 'redis-editor',
            type: 'module' as const,
            onClick: () => {
              recordUsage('app:redis');
              setReturnToLaunchpad(true);
              redisState.setRedisEditorOpen(true);
              redisState.setMinimized(false);
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
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <IOSFileManager
                onClose={() => setIosFileManagerOpen(false)}
                addToast={addToast}
                theme={theme}
              />
            </div>
          </div>
        </div>
      )}

      {redisState.redisEditorOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 2000 }}>
          <div className="ios-app-window" style={{ display: 'flex' }}>
            <div className="ios-app-header">
              <div className="ios-back-btn" onClick={() => redisState.setRedisEditorOpen(false)}>
                <IoChevronBack /> 主页
              </div>
              <div>Redis 编辑器</div>
              <div style={{ color: '#ff3b30', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => redisState.setRedisEditorOpen(false)}>
                关闭
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <IOSRedisEditor state={redisState} />
            </div>
          </div>
        </div>
      )}

      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </>
  );
}
