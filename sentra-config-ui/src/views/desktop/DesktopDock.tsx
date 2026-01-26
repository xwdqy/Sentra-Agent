import { useCallback, useMemo } from 'react';
import { Dock } from '../../components/Dock';
import { getDisplayName, getIconForType } from '../../utils/icons';
import type { FileItem } from '../../types/ui';
import { useUIStore } from '../../store/uiStore';
import { useWindowsStore } from '../../store/windowsStore';
import { useDockFavoritesStore } from '../../store/dockFavoritesStore';

type DesktopDockProps = {
  allItems: FileItem[];
  recordUsage: (key: string) => void;

  loadConfigs?: (silent?: boolean) => Promise<void> | void;

  dockPerformanceMode: boolean;
};

export function DesktopDock(props: DesktopDockProps) {
  const {
    allItems,
    recordUsage,
    loadConfigs,
    dockPerformanceMode,
  } = props;

  const dockFavorites = useDockFavoritesStore(s => s.dockFavorites);
  const setDockFavorites = useDockFavoritesStore(s => s.setDockFavorites);

  const openWindows = useWindowsStore(s => s.openWindows);
  const bringToFront = useWindowsStore(s => s.bringToFront);
  const openWindow = useWindowsStore(s => s.openWindow);
  const closeWindow = useWindowsStore(s => s.closeWindow);

  const {
    showDock,
    setLaunchpadOpen,

    devCenterOpen,
    setDevCenterOpen,
    setDevCenterMinimized,

    deepWikiOpen,
    setDeepWikiOpen,
    setDeepWikiMinimized,

    redisAdminOpen,
    setRedisAdminOpen,
    setRedisAdminMinimized,

    modelProvidersManagerOpen,
    setModelProvidersManagerOpen,
    setModelProvidersManagerMinimized,

    mcpServersManagerOpen,
    setMcpServersManagerOpen,
    setMcpServersManagerMinimized,

    emojiStickersManagerOpen,
    setEmojiStickersManagerOpen,
    setEmojiStickersManagerMinimized,

    presetsEditorOpen,
    setPresetsEditorOpen,
    setPresetsEditorMinimized,

    presetImporterOpen,
    setPresetImporterOpen,
    setPresetImporterMinimized,

    fileManagerOpen,
    setFileManagerOpen,
    setFileManagerMinimized,

    terminalManagerOpen,
    setTerminalManagerOpen,
    setTerminalManagerMinimized,

    requestUtilityFocus,
  } = useUIStore();

  const prefetchUtilityChunk = useCallback((id: string) => {
    // Best-effort: ignore failures (network, cache, etc.)
    try {
      switch (id) {
        case 'file-manager':
          void import('../../components/FileManager');
          break;
        case 'terminal-manager':
          void import('../../components/TerminalManager/TerminalManager');
          break;
        case 'presets-editor':
          void import('../../components/PresetsEditor');
          break;
        case 'preset-importer':
          void import('../../components/PresetImporter');
          break;
        case 'model-providers-manager':
          void import('../../components/ModelProvidersManager/ModelProvidersManager');
          break;
        case 'mcp-servers-manager':
          void import('../../components/McpServersManager/McpServersManager');
          break;
        case 'emoji-stickers-manager':
          void import('../../components/EmojiStickersManager/EmojiStickersManager');
          break;
        case 'redis-admin':
          void import('../../components/RedisAdminManager/RedisAdminManager');
          break;
        case 'deepwiki':
          void import('../../components/DeepWikiChat');
          break;
        case 'dev-center':
          void import('../../components/DevCenterV2');
          break;
        default:
          break;
      }
    } catch {
      // ignore
    }
  }, []);

  const uniqueDockItems = useMemo(() => {
    const dockItems: any[] = [
      {
        id: 'launchpad',
        name: '启动台',
        icon: getIconForType('desktop', 'module'),
        onClick: () => setLaunchpadOpen(true),
      },
      {
        id: 'file-manager-app',
        name: '文件管理',
        icon: getIconForType('file-manager', 'module'),
        isOpen: fileManagerOpen,
        onHover: () => prefetchUtilityChunk('file-manager'),
        onClick: () => {
          setFileManagerOpen(true);
          setFileManagerMinimized(false);
          requestUtilityFocus('file-manager');
        },
        onClose: () => {
          setFileManagerOpen(false);
          setFileManagerMinimized(false);
        },
      },
      {
        id: 'terminal-manager-app',
        name: '终端执行器',
        icon: getIconForType('terminal-manager', 'module'),
        isOpen: terminalManagerOpen,
        onHover: () => prefetchUtilityChunk('terminal-manager'),
        onClick: () => {
          setTerminalManagerOpen(true);
          setTerminalManagerMinimized(false);
          requestUtilityFocus('terminal-manager');
        },
        onClose: () => {
          setTerminalManagerOpen(false);
          setTerminalManagerMinimized(false);
        },
      },
      {
        id: 'presets-app',
        name: '预设撰写',
        icon: getIconForType('agent-presets', 'module'),
        isOpen: presetsEditorOpen,
        onHover: () => prefetchUtilityChunk('presets-editor'),
        onClick: () => {
          setPresetsEditorOpen(true);
          setPresetsEditorMinimized(false);
          requestUtilityFocus('presets-editor');
        },
        onClose: () => {
          setPresetsEditorOpen(false);
          setPresetsEditorMinimized(false);
        },
      },
      {
        id: 'preset-importer-app',
        name: '预设导入',
        icon: getIconForType('preset-importer', 'module'),
        isOpen: presetImporterOpen,
        onHover: () => prefetchUtilityChunk('preset-importer'),
        onClick: () => {
          setPresetImporterOpen(true);
          setPresetImporterMinimized(false);
          requestUtilityFocus('preset-importer');
        },
        onClose: () => {
          setPresetImporterOpen(false);
          setPresetImporterMinimized(false);
        },
      },
      {
        id: 'model-providers-manager-app',
        name: '模型供应商',
        icon: getIconForType('model-providers-manager', 'module'),
        isOpen: modelProvidersManagerOpen,
        onHover: () => prefetchUtilityChunk('model-providers-manager'),
        onClick: () => {
          setModelProvidersManagerOpen(true);
          setModelProvidersManagerMinimized(false);
          requestUtilityFocus('model-providers-manager');
        },
        onClose: () => {
          setModelProvidersManagerOpen(false);
          setModelProvidersManagerMinimized(false);
        },
      },
      {
        id: 'mcp-servers-manager-app',
        name: '外部 MCP 工具',
        icon: getIconForType('mcp-servers-manager', 'module'),
        isOpen: mcpServersManagerOpen,
        onHover: () => prefetchUtilityChunk('mcp-servers-manager'),
        onClick: () => {
          setMcpServersManagerOpen(true);
          setMcpServersManagerMinimized(false);
          requestUtilityFocus('mcp-servers-manager');
        },
        onClose: () => {
          setMcpServersManagerOpen(false);
          setMcpServersManagerMinimized(false);
        },
      },
      {
        id: 'emoji-stickers-manager-app',
        name: '表情包配置',
        icon: getIconForType('emoji-stickers-manager', 'module'),
        isOpen: emojiStickersManagerOpen,
        onHover: () => prefetchUtilityChunk('emoji-stickers-manager'),
        onClick: () => {
          setEmojiStickersManagerOpen(true);
          setEmojiStickersManagerMinimized(false);
          requestUtilityFocus('emoji-stickers-manager');
        },
        onClose: () => {
          setEmojiStickersManagerOpen(false);
          setEmojiStickersManagerMinimized(false);
        },
      },
      {
        id: 'redis-admin-app',
        name: 'Redis 管理',
        icon: getIconForType('redis-admin', 'module'),
        isOpen: redisAdminOpen,
        onHover: () => prefetchUtilityChunk('redis-admin'),
        onClick: () => {
          setRedisAdminOpen(true);
          setRedisAdminMinimized(false);
          requestUtilityFocus('redis-admin');
        },
        onClose: () => {
          setRedisAdminOpen(false);
          setRedisAdminMinimized(false);
        },
      },
      {
        id: 'deepwiki-app',
        name: 'DeepWiki',
        icon: getIconForType('deepwiki', 'module'),
        isOpen: deepWikiOpen,
        onHover: () => prefetchUtilityChunk('deepwiki'),
        onClick: () => {
          setDeepWikiOpen(true);
          setDeepWikiMinimized(false);
          requestUtilityFocus('deepwiki');
        },
        onClose: () => {
          setDeepWikiOpen(false);
          setDeepWikiMinimized(false);
        },
      },
      {
        id: 'dev-center-app',
        name: '开发中心',
        icon: getIconForType('dev-center', 'module'),
        isOpen: devCenterOpen,
        onHover: () => prefetchUtilityChunk('dev-center'),
        onClick: () => {
          setDevCenterOpen(true);
          setDevCenterMinimized(false);
          requestUtilityFocus('dev-center');
        },
        onClose: () => {
          setDevCenterOpen(false);
          setDevCenterMinimized(false);
        },
      },
    ];

    const favoriteDockItems = dockFavorites
      .map((favId) => {
        const item = allItems.find((i) => `${i.type}-${i.name}` === favId);
        if (!item) return null;
        if (item.name === 'utils/emoji-stickers') return null;
        const isOpen = openWindows.some((w) => w.file.name === item.name && w.file.type === item.type);
        return {
          id: favId,
          name: getDisplayName(item.name),
          icon: getIconForType(item.name, item.type),
          isOpen,
          onClick: () => {
            recordUsage(`${item.type}:${item.name}`);
            loadConfigs?.(true);
            openWindow(item);
          },
          onClose: isOpen
            ? () => {
                const win = openWindows.find((w) => w.file.name === item.name && w.file.type === item.type);
                if (win) closeWindow(win.id);
              }
            : undefined,
          onRemove: () => setDockFavorites((prev) => prev.filter((id) => id !== favId)),
        };
      })
      .filter(Boolean) as any[];

    const extraOpenWindows = openWindows
      .filter((w) => !dockFavorites.includes(`${w.file.type}-${w.file.name}`))
      .map((w) => ({
        id: w.id,
        name: getDisplayName(w.file.name),
        icon: getIconForType(w.file.name, w.file.type),
        isOpen: true,
        onClick: () => {
          bringToFront(w.id);
        },
        onClose: () => closeWindow(w.id),
        onRemove: undefined,
      }));

    const merged = [...dockItems, ...favoriteDockItems, ...extraOpenWindows];
    return merged.filter((item, index, self) => index === self.findIndex((t: any) => t.id === item.id));
  }, [
    allItems,
    bringToFront,
    prefetchUtilityChunk,
    deepWikiOpen,
    devCenterOpen,
    dockFavorites,
    fileManagerOpen,
    emojiStickersManagerOpen,
    closeWindow,
    loadConfigs,
    modelProvidersManagerOpen,
    mcpServersManagerOpen,
    openWindow,
    openWindows,
    presetImporterOpen,
    presetsEditorOpen,
    recordUsage,
    redisAdminOpen,
    setDeepWikiMinimized,
    setDeepWikiOpen,
    setDevCenterMinimized,
    setDevCenterOpen,
    setDockFavorites,
    setFileManagerMinimized,
    setFileManagerOpen,
    setLaunchpadOpen,
    setModelProvidersManagerMinimized,
    setModelProvidersManagerOpen,
    setMcpServersManagerMinimized,
    setMcpServersManagerOpen,
    setEmojiStickersManagerMinimized,
    setEmojiStickersManagerOpen,
    setPresetImporterMinimized,
    setPresetImporterOpen,
    setPresetsEditorMinimized,
    setPresetsEditorOpen,
    setRedisAdminMinimized,
    setRedisAdminOpen,
  ]);

  if (!showDock) return null;

  return (
    <Dock performanceMode={dockPerformanceMode} items={uniqueDockItems.slice(0, 16)} />
  );
}
