import { Component, Suspense, lazy, memo, type ReactNode } from 'react';
import { Spin } from 'antd';
import { IoBookOutline } from 'react-icons/io5';
import { MacWindow } from '../../components/MacWindow';
import { getIconForType } from '../../utils/icons';
import type { FileItem } from '../../types/ui';
import type { PresetsEditorState } from '../../hooks/usePresetsEditor';

const PresetsEditor = lazy(() => import('../../components/PresetsEditor').then(module => ({ default: module.PresetsEditor })));
const FileManager = lazy(() => import('../../components/FileManager').then(module => ({ default: module.FileManager })));
const DeepWikiChat = lazy(() => import('../../components/DeepWikiChat').then(module => ({ default: module.DeepWikiChat })));
const PresetImporter = lazy(() => import('../../components/PresetImporter').then(module => ({ default: module.PresetImporter })));
const ModelProvidersManager = lazy(() => import('../../components/ModelProvidersManager/ModelProvidersManager').then(module => ({ default: module.default })));
const DevCenterV2 = lazy(() => import('../../components/DevCenterV2').then(module => ({ default: module.DevCenterV2 })));
const RedisAdminManager = lazy(() => import('../../components/RedisAdminManager/RedisAdminManager').then(module => ({ default: module.RedisAdminManager })));

const LazyWindowFallback = memo((props: { title: string }) => {
  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        color: 'rgba(0,0,0,0.55)',
        fontSize: 13,
      }}
    >
      <Spin size="large" />
      <div style={{ fontWeight: 700 }}>{props.title}</div>
      <div style={{ opacity: 0.75 }}>首次打开可能较慢，请稍等...</div>
    </div>
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
  } = props;

  return (
    <>
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
          <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>加载中...</div>}>
            <DevCenterV2
              allItems={allItems}
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
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['redis-admin'] ?? 2006}
          isActive={activeUtilityId === 'redis-admin'}
          isMinimized={redisAdminMinimized}
          performanceMode={performanceMode}
          initialSize={{ width: 1360, height: 820 }}
          initialMaximized={false}
          onClose={() => {
            handleWindowMaximize('redis-admin', false);
            setRedisAdminOpen(false);
            setRedisAdminMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('redis-admin', false);
            setRedisAdminMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={(isMax) => handleWindowMaximize('redis-admin', isMax)}
          onFocus={() => { bringUtilityToFront('redis-admin'); }}
          onMove={() => { }}
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
          safeArea={desktopSafeArea}
          zIndex={utilityZMap['model-providers-manager'] ?? 2007}
          isActive={activeUtilityId === 'model-providers-manager'}
          isMinimized={modelProvidersManagerMinimized}
          performanceMode={performanceMode}
          initialSize={{ width: 1120, height: 720 }}
          onClose={() => {
            handleWindowMaximize('model-providers-manager', false);
            setModelProvidersManagerOpen(false);
            setModelProvidersManagerMinimized(false);
          }}
          onMinimize={() => {
            handleWindowMaximize('model-providers-manager', false);
            setModelProvidersManagerMinimized(true);
            setActiveUtilityId(null);
          }}
          onMaximize={(isMax) => handleWindowMaximize('model-providers-manager', isMax)}
          onFocus={() => { bringUtilityToFront('model-providers-manager'); }}
          onMove={() => { }}
        >
          <Suspense fallback={<LazyWindowFallback title="加载 模型供应商" />}>
            <ModelProvidersManager addToast={addToast as any} />
          </Suspense>
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
    </>
  );
}
