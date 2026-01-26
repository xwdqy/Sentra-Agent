import { Component, Suspense, lazy, memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { IoBookOutline } from 'react-icons/io5';
import { MacWindow } from '../../components/MacWindow';
import { SentraLoading } from '../../components/SentraLoading';
import { getIconForType } from '../../utils/icons';
import type { FileItem } from '../../types/ui';
import type { PresetsEditorState } from '../../hooks/usePresetsEditor';
import { storage } from '../../utils/storage';

const PresetsEditor = lazy(() => import('../../components/PresetsEditor').then(module => ({ default: module.PresetsEditor })));
const FileManager = lazy(() => import('../../components/FileManager').then(module => ({ default: module.FileManager })));
const DeepWikiChat = lazy(() => import('../../components/DeepWikiChat').then(module => ({ default: module.DeepWikiChat })));
const PresetImporter = lazy(() => import('../../components/PresetImporter').then(module => ({ default: module.PresetImporter })));
const ModelProvidersManager = lazy(() => import('../../components/ModelProvidersManager/ModelProvidersManager').then(module => ({ default: module.default })));
const EmojiStickersManager = lazy(() => import('../../components/EmojiStickersManager/EmojiStickersManager').then(module => ({ default: module.default })));
const McpServersManager = lazy(() => import('../../components/McpServersManager/McpServersManager').then(module => ({ default: module.default })));
const DevCenterV2 = lazy(() => import('../../components/DevCenterV2').then(module => ({ default: module.DevCenterV2 })));
const RedisAdminManager = lazy(() => import('../../components/RedisAdminManager/RedisAdminManager').then(module => ({ default: module.RedisAdminManager })));
const TerminalManager = lazy(() => import('../../components/TerminalManager/TerminalManager').then(module => ({ default: module.default })));

const LazyWindowFallback = memo((props: { title: string }) => {
  return (
    <SentraLoading
      title={props.title}
      subtitle="首次打开可能较慢，请稍等..."
    />
  );
});

class WindowErrorBoundary extends Component<
  { resetKey: string; fallback: (err: any) => ReactNode; children: ReactNode },
  { err: any }
> {
  state: { err: any } = { err: null };

  static getDerivedStateFromError(err: any) {
    return { err };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.err) {
      // eslint-disable-next-line react/no-did-update-set-state
      this.setState({ err: null });
    }
  }

  render() {
    if (this.state.err) return this.props.fallback(this.state.err);
    return this.props.children as any;
  }
}

type DesktopUtilityWindowsLayerProps = {
  desktopSafeArea: { top: number; bottom: number; left: number; right: number };
  theme: 'light' | 'dark';
  performanceMode: boolean;
  activeUtilityId: string | null;
  setActiveUtilityId: (id: string | null) => void;
  utilityZMap: Record<string, number>;
  bringUtilityToFront: (id: string) => void;
  handleWindowMaximize: (id: string, isMaximized: boolean) => void;

  allItems: FileItem[];
  openWindow: (file: FileItem, opts?: { maximize?: boolean }) => void;
  addToast: (...args: any[]) => void;
  presetsState: PresetsEditorState;
  handleOpenDeepWiki: () => void;

  devCenterOpen: boolean;
  setDevCenterOpen: (v: boolean) => void;
  devCenterMinimized: boolean;
  setDevCenterMinimized: (v: boolean) => void;

  redisAdminOpen: boolean;
  setRedisAdminOpen: (v: boolean) => void;
  redisAdminMinimized: boolean;
  setRedisAdminMinimized: (v: boolean) => void;

  modelProvidersManagerOpen: boolean;
  setModelProvidersManagerOpen: (v: boolean) => void;
  modelProvidersManagerMinimized: boolean;
  setModelProvidersManagerMinimized: (v: boolean) => void;

  mcpServersManagerOpen: boolean;
  setMcpServersManagerOpen: (v: boolean) => void;
  mcpServersManagerMinimized: boolean;
  setMcpServersManagerMinimized: (v: boolean) => void;

  emojiStickersManagerOpen: boolean;
  setEmojiStickersManagerOpen: (v: boolean) => void;
  emojiStickersManagerMinimized: boolean;
  setEmojiStickersManagerMinimized: (v: boolean) => void;

  presetImporterOpen: boolean;
  setPresetImporterOpen: (v: boolean) => void;
  presetImporterMinimized: boolean;
  setPresetImporterMinimized: (v: boolean) => void;

  deepWikiOpen: boolean;
  setDeepWikiOpen: (v: boolean) => void;
  deepWikiMinimized: boolean;
  setDeepWikiMinimized: (v: boolean) => void;

  presetsEditorOpen: boolean;
  setPresetsEditorOpen: (v: boolean) => void;
  presetsEditorMinimized: boolean;
  setPresetsEditorMinimized: (v: boolean) => void;

  fileManagerOpen: boolean;
  setFileManagerOpen: (v: boolean) => void;
  fileManagerMinimized: boolean;
  setFileManagerMinimized: (v: boolean) => void;

  terminalManagerOpen: boolean;
  setTerminalManagerOpen: (v: boolean) => void;
  terminalManagerMinimized: boolean;
  setTerminalManagerMinimized: (v: boolean) => void;
};

export function DesktopUtilityWindowsLayer(props: DesktopUtilityWindowsLayerProps) {
  const {
    desktopSafeArea,
    theme,
    performanceMode,
    activeUtilityId,
    setActiveUtilityId,
    utilityZMap,
    bringUtilityToFront,
    handleWindowMaximize,
    allItems,
    openWindow,
    addToast,
    presetsState,
    handleOpenDeepWiki,
    devCenterOpen,
    setDevCenterOpen,
    devCenterMinimized,
    setDevCenterMinimized,
    redisAdminOpen,
    setRedisAdminOpen,
    redisAdminMinimized,
    setRedisAdminMinimized,
    modelProvidersManagerOpen,
    setModelProvidersManagerOpen,
    modelProvidersManagerMinimized,
    setModelProvidersManagerMinimized,
    mcpServersManagerOpen,
    setMcpServersManagerOpen,
    mcpServersManagerMinimized,
    setMcpServersManagerMinimized,
    emojiStickersManagerOpen,
    setEmojiStickersManagerOpen,
    emojiStickersManagerMinimized,
    setEmojiStickersManagerMinimized,
    presetImporterOpen,
    setPresetImporterOpen,
    presetImporterMinimized,
    setPresetImporterMinimized,
    deepWikiOpen,
    setDeepWikiOpen,
    deepWikiMinimized,
    setDeepWikiMinimized,
    presetsEditorOpen,
    setPresetsEditorOpen,
    presetsEditorMinimized,
    setPresetsEditorMinimized,
    fileManagerOpen,
    setFileManagerOpen,
    fileManagerMinimized,
    setFileManagerMinimized,
    terminalManagerOpen,
    setTerminalManagerOpen,
    terminalManagerMinimized,
    setTerminalManagerMinimized,
  } = props;

  const LAYOUT_KEY = 'sentra_utility_window_layouts_v1';

  type UtilityLayout = {
    pos?: { x: number; y: number };
    size?: { width: number; height: number };
    maximized?: boolean;
  };

  const [layouts, setLayouts] = useState<Record<string, UtilityLayout>>(() => {
    return storage.getJson<Record<string, UtilityLayout>>(LAYOUT_KEY, { fallback: {} });
  });

  useEffect(() => {
    storage.setJson(LAYOUT_KEY, layouts);
  }, [layouts]);

  const getLayout = useCallback((id: string) => layouts[id] || {}, [layouts]);

  const updateLayout = useCallback((id: string, patch: UtilityLayout) => {
    setLayouts(prev => ({
      ...prev,
      [id]: {
        ...(prev[id] || {}),
        ...patch,
      }
    }));
  }, []);

  const getInitialPos = useCallback((id: string) => {
    const l = getLayout(id);
    return l.pos;
  }, [getLayout]);

  const getInitialSize = useCallback((id: string, fallback: { width: number; height: number }) => {
    const l = getLayout(id);
    return l.size || fallback;
  }, [getLayout]);

  const getInitialMaximized = useCallback((id: string) => {
    const l = getLayout(id);
    return !!l.maximized;
  }, [getLayout]);

  const handleMove = useMemo(() => {
    return (id: string) => (x: number, y: number) => updateLayout(id, { pos: { x, y } });
  }, [updateLayout]);

  const handleResize = useMemo(() => {
    return (id: string) => (width: number, height: number) => updateLayout(id, { size: { width, height } });
  }, [updateLayout]);

  const handleMaximizePersist = useMemo(() => {
    return (id: string) => (isMax: boolean) => {
      handleWindowMaximize(id, isMax);
      updateLayout(id, { maximized: isMax });
    };
  }, [handleWindowMaximize, updateLayout]);

  return (
    <>
      {devCenterOpen && (
        <MacWindow
          id="dev-center"
          title="开发中心"
          icon={getIconForType('dev-center', 'module')}
          initialPos={getInitialPos('dev-center')}
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['dev-center'] ?? 2000}
          isActive={activeUtilityId === 'dev-center'}
          isMinimized={devCenterMinimized}
          performanceMode={performanceMode}
          initialSize={getInitialSize('dev-center', { width: 940, height: 620 })}
          initialMaximized={getInitialMaximized('dev-center')}
          onClose={() => {
            handleWindowMaximize('dev-center', false);
            updateLayout('dev-center', { maximized: false });
            setDevCenterOpen(false);
            setDevCenterMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('dev-center', false);
            setDevCenterMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={handleMaximizePersist('dev-center')}
          onFocus={() => { bringUtilityToFront('dev-center'); }}
          onMove={handleMove('dev-center')}
          onResize={handleResize('dev-center')}
        >
          <Suspense fallback={<SentraLoading title="加载 开发中心" subtitle="首次打开可能较慢，请稍等..." />}>
            <DevCenterV2
              allItems={allItems.filter(item => item.name !== 'utils/emoji-stickers')}
              tools={[
                {
                  id: 'redis-admin',
                  name: 'redis-admin',
                  subtitle: 'Redis 管理器（可视化）',
                  onOpen: () => {
                    setRedisAdminOpen(true);
                    setRedisAdminMinimized(false);
                    bringUtilityToFront('redis-admin');
                  },
                },
                {
                  id: 'model-providers-manager',
                  name: 'model-providers-manager',
                  subtitle: '模型供应商管理（配置 /v1/models）',
                  onOpen: () => {
                    setModelProvidersManagerOpen(true);
                    setModelProvidersManagerMinimized(false);
                    bringUtilityToFront('model-providers-manager');
                  },
                },
                {
                  id: 'mcp-servers-manager',
                  name: 'mcp-servers-manager',
                  subtitle: '外部 MCP 工具管理（mcp/servers.json）',
                  onOpen: () => {
                    setMcpServersManagerOpen(true);
                    setMcpServersManagerMinimized(false);
                    bringUtilityToFront('mcp-servers-manager');
                  },
                },
                {
                  id: 'emoji-stickers-manager',
                  name: 'emoji-stickers-manager',
                  subtitle: '表情包配置（上传/预览/一键写入 .env）',
                  onOpen: () => {
                    setEmojiStickersManagerOpen(true);
                    setEmojiStickersManagerMinimized(false);
                    bringUtilityToFront('emoji-stickers-manager');
                  },
                },
                {
                  id: 'terminal-manager',
                  name: 'terminal-manager',
                  subtitle: '终端执行器（新建会话 / 运行命令）',
                  onOpen: () => {
                    setTerminalManagerOpen(true);
                    setTerminalManagerMinimized(false);
                    bringUtilityToFront('terminal-manager');
                  },
                },
                {
                  id: 'presets-editor',
                  name: 'presets-editor',
                  subtitle: '预设撰写（内置工具）',
                  onOpen: () => {
                    setPresetsEditorOpen(true);
                    setPresetsEditorMinimized(false);
                    bringUtilityToFront('presets-editor');
                  },
                },
                {
                  id: 'preset-importer',
                  name: 'preset-importer',
                  subtitle: '预设导入（内置工具）',
                  onOpen: () => {
                    setPresetImporterOpen(true);
                    setPresetImporterMinimized(false);
                    bringUtilityToFront('preset-importer');
                  },
                },
                {
                  id: 'file-manager',
                  name: 'file-manager',
                  subtitle: '文件管理（内置工具）',
                  onOpen: () => {
                    setFileManagerOpen(true);
                    setFileManagerMinimized(false);
                    bringUtilityToFront('file-manager');
                  },
                },
                {
                  id: 'deepwiki',
                  name: 'DeepWiki',
                  subtitle: '开发文档与指南',
                  icon: <IoBookOutline style={{ color: '#2563eb' }} />,
                  onOpen: () => handleOpenDeepWiki(),
                },
              ]}
              onOpenItem={(file) => openWindow(file, { maximize: true })}
              onOpenDeepWiki={handleOpenDeepWiki}
            />
          </Suspense>
        </MacWindow>
      )}

      {redisAdminOpen && (
        <MacWindow
          id="redis-admin"
          title="Redis 管理器"
          icon={getIconForType('redis-admin', 'module')}
          initialPos={getInitialPos('redis-admin')}
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['redis-admin'] ?? 2006}
          isActive={activeUtilityId === 'redis-admin'}
          isMinimized={redisAdminMinimized}
          performanceMode={performanceMode}
          initialSize={getInitialSize('redis-admin', { width: 1360, height: 820 })}
          initialMaximized={getInitialMaximized('redis-admin')}
          onClose={() => {
            handleWindowMaximize('redis-admin', false);
            updateLayout('redis-admin', { maximized: false });
            setRedisAdminOpen(false);
            setRedisAdminMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('redis-admin', false);
            setRedisAdminMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={handleMaximizePersist('redis-admin')}
          onFocus={() => { bringUtilityToFront('redis-admin'); }}
          onMove={handleMove('redis-admin')}
          onResize={handleResize('redis-admin')}
        >
          <Suspense fallback={<LazyWindowFallback title="加载 Redis 管理器" />}>
            <RedisAdminManager
              addToast={addToast}
              performanceMode={performanceMode || redisAdminMinimized || activeUtilityId !== 'redis-admin'}
            />
          </Suspense>
        </MacWindow>
      )}

      {modelProvidersManagerOpen && (
        <MacWindow
          id="model-providers-manager"
          title="模型供应商"
          icon={getIconForType('model-providers-manager', 'module')}
          initialPos={getInitialPos('model-providers-manager')}
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['model-providers-manager'] ?? 2007}
          isActive={activeUtilityId === 'model-providers-manager'}
          isMinimized={modelProvidersManagerMinimized}
          performanceMode={performanceMode}
          initialSize={getInitialSize('model-providers-manager', { width: 1120, height: 720 })}
          initialMaximized={getInitialMaximized('model-providers-manager')}
          onClose={() => {
            handleWindowMaximize('model-providers-manager', false);
            updateLayout('model-providers-manager', { maximized: false });
            setModelProvidersManagerOpen(false);
            setModelProvidersManagerMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('model-providers-manager', false);
            setModelProvidersManagerMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={handleMaximizePersist('model-providers-manager')}
          onFocus={() => { bringUtilityToFront('model-providers-manager'); }}
          onMove={handleMove('model-providers-manager')}
          onResize={handleResize('model-providers-manager')}
        >
          <Suspense fallback={<LazyWindowFallback title="加载 模型供应商" />}>
            <ModelProvidersManager addToast={addToast as any} />
          </Suspense>
        </MacWindow>
      )}

      {mcpServersManagerOpen && (
        <MacWindow
          id="mcp-servers-manager"
          title="外部 MCP 工具"
          icon={getIconForType('mcp-servers-manager', 'module')}
          initialPos={getInitialPos('mcp-servers-manager')}
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['mcp-servers-manager'] ?? 2010}
          isActive={activeUtilityId === 'mcp-servers-manager'}
          isMinimized={mcpServersManagerMinimized}
          performanceMode={performanceMode}
          initialSize={getInitialSize('mcp-servers-manager', { width: 1040, height: 720 })}
          initialMaximized={getInitialMaximized('mcp-servers-manager')}
          onClose={() => {
            handleWindowMaximize('mcp-servers-manager', false);
            updateLayout('mcp-servers-manager', { maximized: false });
            setMcpServersManagerOpen(false);
            setMcpServersManagerMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('mcp-servers-manager', false);
            setMcpServersManagerMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={handleMaximizePersist('mcp-servers-manager')}
          onFocus={() => { bringUtilityToFront('mcp-servers-manager'); }}
          onMove={handleMove('mcp-servers-manager')}
          onResize={handleResize('mcp-servers-manager')}
        >
          <Suspense fallback={<LazyWindowFallback title="加载 外部 MCP 工具" />}>
            <McpServersManager addToast={addToast as any} />
          </Suspense>
        </MacWindow>
      )}

      {emojiStickersManagerOpen && (
        <MacWindow
          id="emoji-stickers-manager"
          title="表情包配置"
          icon={getIconForType('emoji-stickers-manager', 'module')}
          initialPos={getInitialPos('emoji-stickers-manager')}
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['emoji-stickers-manager'] ?? 2008}
          isActive={activeUtilityId === 'emoji-stickers-manager'}
          isMinimized={emojiStickersManagerMinimized}
          performanceMode={performanceMode}
          initialSize={getInitialSize('emoji-stickers-manager', { width: 1080, height: 720 })}
          initialMaximized={getInitialMaximized('emoji-stickers-manager')}
          onClose={() => {
            handleWindowMaximize('emoji-stickers-manager', false);
            updateLayout('emoji-stickers-manager', { maximized: false });
            setEmojiStickersManagerOpen(false);
            setEmojiStickersManagerMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('emoji-stickers-manager', false);
            setEmojiStickersManagerMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={handleMaximizePersist('emoji-stickers-manager')}
          onFocus={() => { bringUtilityToFront('emoji-stickers-manager'); }}
          onMove={handleMove('emoji-stickers-manager')}
          onResize={handleResize('emoji-stickers-manager')}
        >
          <Suspense fallback={<LazyWindowFallback title="加载 表情包配置" />}>
            <EmojiStickersManager addToast={addToast as any} />
          </Suspense>
        </MacWindow>
      )}

      {presetImporterOpen && (
        <MacWindow
          id="preset-importer"
          title="预设导入"
          icon={getIconForType('preset-importer', 'module')}
          initialPos={getInitialPos('preset-importer')}
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['preset-importer'] ?? 2003}
          isActive={activeUtilityId === 'preset-importer'}
          isMinimized={presetImporterMinimized}
          performanceMode={performanceMode}
          initialSize={getInitialSize('preset-importer', { width: 880, height: 600 })}
          initialMaximized={getInitialMaximized('preset-importer')}
          onClose={() => {
            handleWindowMaximize('preset-importer', false);
            updateLayout('preset-importer', { maximized: false });
            setPresetImporterOpen(false);
            setPresetImporterMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('preset-importer', false);
            setPresetImporterMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={handleMaximizePersist('preset-importer')}
          onFocus={() => { bringUtilityToFront('preset-importer'); }}
          onMove={handleMove('preset-importer')}
          onResize={handleResize('preset-importer')}
        >
          <Suspense fallback={<SentraLoading title="加载 预设导入" subtitle="首次打开可能较慢，请稍等..." />}>
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
          initialPos={getInitialPos('deepwiki')}
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['deepwiki'] ?? 2001}
          isActive={activeUtilityId === 'deepwiki'}
          isMinimized={deepWikiMinimized}
          performanceMode={performanceMode}
          initialSize={getInitialSize('deepwiki', { width: 960, height: 640 })}
          initialMaximized={getInitialMaximized('deepwiki')}
          onClose={() => {
            handleWindowMaximize('deepwiki', false);
            updateLayout('deepwiki', { maximized: false });
            setDeepWikiOpen(false);
            setDeepWikiMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('deepwiki', false);
            setDeepWikiMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={handleMaximizePersist('deepwiki')}
          onFocus={() => { bringUtilityToFront('deepwiki'); }}
          onMove={handleMove('deepwiki')}
          onResize={handleResize('deepwiki')}
        >
          <Suspense fallback={<SentraLoading title="加载 DeepWiki 助手" subtitle="首次打开可能较慢，请稍等..." />}>
            <DeepWikiChat theme={theme} />
          </Suspense>
        </MacWindow>
      )}

      {presetsEditorOpen && (
        <MacWindow
          id="presets-editor"
          title="预设撰写"
          icon={getIconForType('agent-presets', 'module')}
          initialPos={getInitialPos('presets-editor')}
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['presets-editor'] ?? 2002}
          isActive={activeUtilityId === 'presets-editor'}
          isMinimized={presetsEditorMinimized}
          performanceMode={performanceMode}
          initialSize={getInitialSize('presets-editor', { width: 900, height: 600 })}
          initialMaximized={getInitialMaximized('presets-editor')}
          onClose={() => {
            handleWindowMaximize('presets-editor', false);
            updateLayout('presets-editor', { maximized: false });
            setPresetsEditorOpen(false);
            setPresetsEditorMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('presets-editor', false);
            setPresetsEditorMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={handleMaximizePersist('presets-editor')}
          onFocus={() => { bringUtilityToFront('presets-editor'); }}
          onMove={handleMove('presets-editor')}
          onResize={handleResize('presets-editor')}
        >
          <Suspense fallback={<SentraLoading title="加载 预设撰写" subtitle="首次打开可能较慢，请稍等..." />}>
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
          initialPos={getInitialPos('file-manager')}
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['file-manager'] ?? 2004}
          isActive={activeUtilityId === 'file-manager'}
          isMinimized={fileManagerMinimized}
          performanceMode={performanceMode}
          initialSize={getInitialSize('file-manager', { width: 1000, height: 700 })}
          initialMaximized={getInitialMaximized('file-manager')}
          onClose={() => {
            handleWindowMaximize('file-manager', false);
            updateLayout('file-manager', { maximized: false });
            setFileManagerOpen(false);
            setFileManagerMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('file-manager', false);
            setFileManagerMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={handleMaximizePersist('file-manager')}
          onFocus={() => { bringUtilityToFront('file-manager'); }}
          onMove={handleMove('file-manager')}
          onResize={handleResize('file-manager')}
        >
          <Suspense fallback={<SentraLoading title="加载 文件管理" subtitle="首次打开可能较慢，请稍等..." />}>
            <WindowErrorBoundary
              resetKey={`file-manager:${performanceMode ? 'p' : 'n'}`}
              fallback={(err) => (
                <div style={{ padding: 16, color: '#ef4444', fontSize: 13, lineHeight: 1.5 }}>
                  <div style={{ fontWeight: 800, marginBottom: 8 }}>文件管理器渲染失败</div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{String((err as any)?.message || err)}</div>
                  <div style={{ marginTop: 10, color: '#888' }}>请打开开发者工具查看详细报错堆栈。</div>
                </div>
              )}
            >
              <FileManager
                onClose={() => setFileManagerOpen(false)}
                theme={theme}
                addToast={addToast}
                performanceMode={performanceMode}
              />
            </WindowErrorBoundary>
          </Suspense>
        </MacWindow>
      )}

      {terminalManagerOpen && (
        <MacWindow
          id="terminal-manager"
          title="终端执行器"
          icon={getIconForType('terminal-manager', 'module')}
          initialPos={getInitialPos('terminal-manager')}
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['terminal-manager'] ?? 2009}
          isActive={activeUtilityId === 'terminal-manager'}
          isMinimized={terminalManagerMinimized}
          performanceMode={performanceMode}
          initialSize={getInitialSize('terminal-manager', { width: 960, height: 680 })}
          initialMaximized={getInitialMaximized('terminal-manager')}
          onClose={() => {
            handleWindowMaximize('terminal-manager', false);
            updateLayout('terminal-manager', { maximized: false });
            setTerminalManagerOpen(false);
            setTerminalManagerMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('terminal-manager', false);
            setTerminalManagerMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={handleMaximizePersist('terminal-manager')}
          onFocus={() => { bringUtilityToFront('terminal-manager'); }}
          onMove={handleMove('terminal-manager')}
          onResize={handleResize('terminal-manager')}
        >
          <Suspense fallback={<LazyWindowFallback title="加载 终端执行器" />}>
            <TerminalManager addToast={addToast as any} />
          </Suspense>
        </MacWindow>
      )}
    </>
  );
}
