import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import styles from './PresetsEditor.module.css';
import { Alert, Button, Dropdown, Empty, Input, InputNumber, Modal, Space, Steps, Switch, Tag, Upload } from 'antd';
import {
    CloudDownloadOutlined,
    DeleteOutlined,
    DownOutlined,
    FileTextOutlined,
    FolderOpenOutlined,
    FolderOutlined,
    InboxOutlined,
    PlusOutlined,
    ReloadOutlined,
    RightOutlined,
    SaveOutlined,
    SearchOutlined,
    StarOutlined,
    ThunderboltOutlined,
} from '@ant-design/icons';
import { PresetsEditorState } from '../hooks/usePresetsEditor';
import type { ToastMessage } from './Toast';
import { SentraInlineLoading } from './SentraInlineLoading';
import { generateWorldbookStream, saveModuleConfig, savePresetFile } from '../services/api';
import { useAppStore } from '../store/appStore';
import { storage } from '../utils/storage';

class EditorErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { error: Error | null }
> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    render() {
        if (this.state.error) {
            return (
                <div style={{ padding: 12 }}>
                    <Alert
                        type="error"
                        message="编辑器渲染失败"
                        description={this.state.error.message || String(this.state.error)}
                        showIcon
                    />
                </div>
            );
        }
        return this.props.children;
    }
}

interface PresetsEditorProps {
    onClose: () => void;
    theme: 'light' | 'dark';
    addToast: (type: ToastMessage['type'], title: string, message?: string) => void;
    state: PresetsEditorState;
    performanceMode?: boolean;
    onOpenPresetImporter?: () => void;
}

function isWorldbookCandidate(pathOrName: string) {
    const s = String(pathOrName || '').replace(/\\/g, '/').toLowerCase();
    if (!s.endsWith('.json')) return false;
    return s.startsWith('world/') || s.includes('/world/');
}

function normalizeWorldbookPath(input: string) {
    const s = String(input || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!s) return '';
    if (s.includes('/')) return s;
    return `world/${s}`;
}

function getRootModuleEnv(configData: any): { moduleName: string; variables: any[] } | null {
    const modules = Array.isArray(configData?.modules) ? configData.modules : [];
    const root = modules.find((m: any) => m && (m.name === '.' || m.path === '.' || String(m.name || '').trim() === '.'));
    if (!root) return null;
    const variables = Array.isArray(root.variables) ? root.variables : [];
    return { moduleName: root.name || '.', variables };
}

function upsertEnvVar(variables: any[], key: string, value: string) {
    const k = String(key || '').trim();
    const next = Array.isArray(variables) ? [...variables] : [];
    const idx = next.findIndex((v) => v && String(v.key || '').trim() === k);
    if (idx >= 0) {
        next[idx] = { ...next[idx], key: k, value: String(value ?? '') };
        return next;
    }
    next.push({ key: k, value: String(value ?? '') });
    return next;
}

export const PresetsEditor: React.FC<PresetsEditorProps> = ({ theme, state, addToast, performanceMode = false, onOpenPresetImporter }) => {
    const {
        folders,
        selectedFile,
        fileContent,
        searchTerm,
        loading,
        saving,
        loadingFile,
        expandedFolders,
        setSearchTerm,
        selectFile,
        saveFile,
        setFileContent,
        createFile,
        deleteFile,
        refreshFiles,
        toggleFolder
    } = state;

    const [showNewFileModal, setShowNewFileModal] = useState(false);
    const [newFileName, setNewFileName] = useState('');
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    const [scope, setScope] = useState<'all' | 'worldbook'>('all');

    const configData = useAppStore((s) => s.configData);
    const rootEnv = getRootModuleEnv(configData);
    const inferredCurrentWorldbook = (() => {
        const v = rootEnv?.variables?.find((row: any) => row && String(row.key || '').trim() === 'WORLDBOOK_FILE');
        const s = String(v?.value || '').trim();
        return s || 'world/worldbook.json';
    })();
    const [currentWorldbookOverride, setCurrentWorldbookOverride] = useState<string>('');
    const currentWorldbook = currentWorldbookOverride || inferredCurrentWorldbook;

    const [worldbookImportOpen, setWorldbookImportOpen] = useState(false);
    const [worldbookImportMode, setWorldbookImportMode] = useState<'upload' | 'text'>('upload');
    const [worldbookImportFileName, setWorldbookImportFileName] = useState('worldbook.json');
    const [worldbookImportRaw, setWorldbookImportRaw] = useState('');
    const [worldbookImportSaving, setWorldbookImportSaving] = useState(false);
    const [worldbookImportSetActive, setWorldbookImportSetActive] = useState(true);
    const [worldbookImportStep, setWorldbookImportStep] = useState(0);

    const [worldbookGenOpen, setWorldbookGenOpen] = useState(false);
    const [worldbookGenStep, setWorldbookGenStep] = useState(0);
    const [worldbookGenText, setWorldbookGenText] = useState('');
    const [worldbookGenFileName, setWorldbookGenFileName] = useState('worldbook_generated.json');
    const [worldbookGenSetActive, setWorldbookGenSetActive] = useState(true);
    const [worldbookGenIsStreaming, setWorldbookGenIsStreaming] = useState(false);
    const [worldbookGenStreamText, setWorldbookGenStreamText] = useState('');
    const [worldbookGenResultJson, setWorldbookGenResultJson] = useState<any>(null);
    const [worldbookGenResultXml, setWorldbookGenResultXml] = useState('');
    const [worldbookGenError, setWorldbookGenError] = useState('');
    const [worldbookGenSaving, setWorldbookGenSaving] = useState(false);
    const worldbookGenAbortRef = useRef<AbortController | null>(null);

    const orderedFilePaths = useMemo(() => {
        const out: string[] = [];
        for (const folder of folders) {
            for (const f of (folder?.files || [])) {
                if (!f?.path) continue;
                out.push(String(f.path));
            }
        }
        return out;
    }, [folders]);

    const lastSelectedFilePathRef = useRef<string>('');
    const lastSelectedFileIndexRef = useRef<number>(-1);
    const [pageFlipDir, setPageFlipDir] = useState<1 | -1>(1);

    useEffect(() => {
        const nextPath = String(selectedFile?.path || '');
        if (!nextPath) return;

        const prevPath = lastSelectedFilePathRef.current;
        if (!prevPath) {
            lastSelectedFilePathRef.current = nextPath;
            lastSelectedFileIndexRef.current = orderedFilePaths.indexOf(nextPath);
            return;
        }

        if (prevPath === nextPath) return;
        const nextIdx = orderedFilePaths.indexOf(nextPath);
        const prevIdx = lastSelectedFileIndexRef.current;

        if (nextIdx >= 0 && prevIdx >= 0) {
            setPageFlipDir(nextIdx >= prevIdx ? 1 : -1);
        } else {
            setPageFlipDir(String(nextPath).localeCompare(String(prevPath)) >= 0 ? 1 : -1);
        }

        lastSelectedFilePathRef.current = nextPath;
        lastSelectedFileIndexRef.current = nextIdx;
    }, [orderedFilePaths, selectedFile?.path]);

    const [worldbookGenApiBaseUrl, setWorldbookGenApiBaseUrl] = useState(() => storage.getString('worldbook_gen.apiBaseUrl', { fallback: '' }));
    const [worldbookGenApiKey, setWorldbookGenApiKey] = useState(() => storage.getString('worldbook_gen.apiKey', { fallback: '' }));
    const [worldbookGenModel, setWorldbookGenModel] = useState(() => storage.getString('worldbook_gen.model', { fallback: '' }));
    const [worldbookGenTemperature, setWorldbookGenTemperature] = useState<number>(() => {
        const v = Number(storage.getString('worldbook_gen.temperature', { fallback: '0.4' }));
        return Number.isFinite(v) ? v : 0.4;
    });
    const [worldbookGenMaxTokens, setWorldbookGenMaxTokens] = useState<number>(() => {
        const v = Number(storage.getString('worldbook_gen.maxTokens', { fallback: '-1' }));
        return Number.isFinite(v) ? v : -1;
    });

    useEffect(() => {
        storage.setString('worldbook_gen.apiBaseUrl', String(worldbookGenApiBaseUrl || ''));
    }, [worldbookGenApiBaseUrl]);

    useEffect(() => {
        storage.setString('worldbook_gen.apiKey', String(worldbookGenApiKey || ''));
    }, [worldbookGenApiKey]);

    useEffect(() => {
        storage.setString('worldbook_gen.model', String(worldbookGenModel || ''));
    }, [worldbookGenModel]);

    useEffect(() => {
        storage.setString('worldbook_gen.temperature', String(worldbookGenTemperature ?? 0.4));
    }, [worldbookGenTemperature]);

    useEffect(() => {
        storage.setString('worldbook_gen.maxTokens', String(worldbookGenMaxTokens ?? -1));
    }, [worldbookGenMaxTokens]);

    const worldbookParse = useMemo(() => {
        const raw = String(worldbookImportRaw || '').trim();
        if (!raw) return { formatted: '', error: '' };
        try {
            const obj = JSON.parse(raw);
            return { formatted: JSON.stringify(obj, null, 2), error: '' };
        } catch (e: any) {
            return { formatted: raw, error: e?.message || 'JSON 解析失败' };
        }
    }, [worldbookImportRaw]);
    const parsedWorldbook = worldbookParse.formatted;
    const worldbookImportError = worldbookParse.error;

    useEffect(() => {
        if (!worldbookImportOpen) return;
        setWorldbookImportStep(0);
    }, [worldbookImportOpen]);

    useEffect(() => {
        if (!worldbookGenOpen) return;
        setWorldbookGenStep(0);
    }, [worldbookGenOpen]);

    const handleOpenWorldbookGen = () => {
        setWorldbookGenOpen(true);
        setWorldbookGenStep(0);
        setWorldbookGenText('');
        setWorldbookGenFileName('worldbook_generated.json');
        setWorldbookGenSetActive(true);
        setWorldbookGenIsStreaming(false);
        setWorldbookGenStreamText('');
        setWorldbookGenResultJson(null);
        setWorldbookGenResultXml('');
        setWorldbookGenError('');
        if (worldbookGenAbortRef.current) {
            try { worldbookGenAbortRef.current.abort(); } catch { }
            worldbookGenAbortRef.current = null;
        }
    };

    const handleStopWorldbookGen = () => {
        const c = worldbookGenAbortRef.current;
        if (!c) return;
        try { c.abort(); } catch { }
        worldbookGenAbortRef.current = null;
        setWorldbookGenIsStreaming(false);
    };

    const handleRunWorldbookGen = async () => {
        const text = String(worldbookGenText || '').trim();
        if (!text) {
            addToast('error', '生成失败', '请先填写世界书生成需求');
            return;
        }

        const apiBaseUrl = String(worldbookGenApiBaseUrl || '').trim();
        const apiKey = String(worldbookGenApiKey || '').trim();
        if (!apiBaseUrl) {
            addToast('error', '生成失败', '请填写 API Base URL');
            return;
        }
        if (!apiKey) {
            addToast('error', '生成失败', '请填写 API Key');
            return;
        }

        if (worldbookGenAbortRef.current) {
            try { worldbookGenAbortRef.current.abort(); } catch { }
            worldbookGenAbortRef.current = null;
        }

        const controller = new AbortController();
        worldbookGenAbortRef.current = controller;

        setWorldbookGenIsStreaming(true);
        setWorldbookGenStreamText('');
        setWorldbookGenResultJson(null);
        setWorldbookGenResultXml('');
        setWorldbookGenError('');
        setWorldbookGenStep(1);

        try {
            const maxTokensValue = Number.isFinite(Number(worldbookGenMaxTokens)) && Number(worldbookGenMaxTokens) > 0
                ? Number(worldbookGenMaxTokens)
                : undefined;

            const res = await generateWorldbookStream({
                text,
                apiBaseUrl,
                apiKey,
                model: worldbookGenModel.trim() || undefined,
                temperature: Number.isFinite(Number(worldbookGenTemperature)) ? Number(worldbookGenTemperature) : 0.4,
                maxTokens: maxTokensValue,
                signal: controller.signal,
                onToken: (delta) => {
                    setWorldbookGenStreamText((prev) => prev + delta);
                },
            });

            worldbookGenAbortRef.current = null;
            setWorldbookGenIsStreaming(false);
            setWorldbookGenResultJson(res.worldbookJson || null);
            setWorldbookGenResultXml(res.worldbookXml || '');
            setWorldbookGenStep(2);
            addToast('success', '生成成功', '已生成世界书 JSON，可保存到 world/ 目录');
        } catch (e: any) {
            if (String(e?.name || '') === 'AbortError') {
                setWorldbookGenError('已中止生成');
                addToast('error', '已停止', '已中止世界书生成');
            } else {
                setWorldbookGenError(e?.message || String(e));
                addToast('error', '生成失败', e?.message || String(e));
            }
        } finally {
            setWorldbookGenIsStreaming(false);
        }
    };

    const handleSaveWorldbookGen = async () => {
        const name = String(worldbookGenFileName || '').trim();
        if (!name) {
            addToast('error', '保存失败', '请填写文件名');
            return;
        }
        if (!name.toLowerCase().endsWith('.json')) {
            addToast('error', '保存失败', '世界书必须是 .json 文件');
            return;
        }
        if (!worldbookGenResultJson) {
            addToast('error', '保存失败', '尚未生成世界书');
            return;
        }

        const targetPath = normalizeWorldbookPath(name);
        let content = '';
        try {
            content = JSON.stringify(worldbookGenResultJson, null, 2);
        } catch {
            addToast('error', '保存失败', '生成的世界书无法序列化为 JSON');
            return;
        }

        try {
            setWorldbookGenSaving(true);
            await savePresetFile(targetPath, content);
            if (worldbookGenSetActive && rootEnv) {
                const nextVars = upsertEnvVar(rootEnv.variables, 'WORLDBOOK_FILE', targetPath);
                await saveModuleConfig(rootEnv.moduleName, nextVars);
                setCurrentWorldbookOverride(targetPath);
            }
            await refreshFiles();
            await selectFile({
                name: targetPath.split('/').pop() || targetPath,
                path: targetPath,
                size: content.length,
                modified: new Date().toISOString(),
            } as any);
            addToast('success', '保存成功', `已保存到 agent-presets/${targetPath}`);
            setWorldbookGenOpen(false);
        } catch (e: any) {
            addToast('error', '保存失败', e?.message || String(e));
        } finally {
            setWorldbookGenSaving(false);
        }
    };

    // Filter folders and files based on search term
    const filteredFolders = (() => {
        const term = String(searchTerm || '').toLowerCase();
        const apply = (f: any) => {
            if (term && !String(f?.name || '').toLowerCase().includes(term)) return false;
            if (scope === 'worldbook') {
                const p = String(f?.path || '').replace(/\\/g, '/');
                if (!p.toLowerCase().endsWith('.json')) return false;
                return p.toLowerCase().startsWith('world/');
            }
            return true;
        };
        const mapped = folders.map(folder => ({
            ...folder,
            files: folder.files.filter(apply)
        })).filter(folder => folder.files.length > 0);
        return mapped;
    })();

    const handleCreateFile = async () => {
        if (!newFileName.trim()) return;
        const target = scope === 'worldbook' ? normalizeWorldbookPath(newFileName) : newFileName;
        await createFile(target);
        if (scope === 'worldbook') {
            const template = JSON.stringify({
                meta: {
                    title: '新世界书',
                    version: '1.0.0',
                    description: '',
                },
                entries: [],
            }, null, 2);
            setFileContent(template);
        }
        setShowNewFileModal(false);
        setNewFileName('');
    };

    const handleDeleteFile = async () => {
        if (!selectedFile) return;
        await deleteFile(selectedFile);
        setShowDeleteModal(false);
    };

    const selectedIsWorldbook = !!selectedFile && (isWorldbookCandidate(selectedFile.path) || isWorldbookCandidate(selectedFile.name));
    const selectedIsCurrentWorldbook = selectedIsWorldbook && !!selectedFile && (
        String(selectedFile.path || '').trim() === String(currentWorldbook || '').trim() ||
        String(selectedFile.name || '').trim() === String(currentWorldbook || '').trim()
    );

    const handleSetAsCurrentWorldbook = async () => {
        if (!selectedFile) return;
        if (!rootEnv) {
            addToast('error', '设置失败', '未找到根目录 .env 模块');
            return;
        }
        try {
            const wbPath = normalizeWorldbookPath(selectedFile.path);
            const nextVars = upsertEnvVar(rootEnv.variables, 'WORLDBOOK_FILE', wbPath);
            await saveModuleConfig(rootEnv.moduleName, nextVars);
            setCurrentWorldbookOverride(wbPath);
            addToast('success', '已设为当前世界书', wbPath);
        } catch (e: any) {
            addToast('error', '设置失败', e?.message || String(e));
        }
    };

    const handleOpenWorldbookImport = () => {
        setWorldbookImportOpen(true);
        setWorldbookImportMode('upload');
        setWorldbookImportStep(0);
        setWorldbookImportFileName('worldbook.json');
        setWorldbookImportRaw('');
        setWorldbookImportSetActive(true);
    };

    const handleSaveWorldbookImport = async () => {
        const name = String(worldbookImportFileName || '').trim();
        const targetPath = normalizeWorldbookPath(name);
        if (!name) {
            addToast('error', '保存失败', '请填写文件名');
            return;
        }
        if (!name.toLowerCase().endsWith('.json')) {
            addToast('error', '保存失败', '世界书必须是 .json 文件');
            return;
        }
        if (worldbookImportError) {
            addToast('error', '保存失败', 'JSON 无法解析');
            return;
        }
        const content = String(parsedWorldbook || '').trim();
        if (!content) {
            addToast('error', '保存失败', '内容为空');
            return;
        }
        try {
            setWorldbookImportSaving(true);
            await savePresetFile(targetPath, content);
            if (worldbookImportSetActive && rootEnv) {
                const nextVars = upsertEnvVar(rootEnv.variables, 'WORLDBOOK_FILE', targetPath);
                await saveModuleConfig(rootEnv.moduleName, nextVars);
                setCurrentWorldbookOverride(targetPath);
            }
            await refreshFiles();
            await selectFile({
                name: targetPath.split('/').pop() || targetPath,
                path: targetPath,
                size: content.length,
                modified: new Date().toISOString(),
            } as any);
            addToast('success', '导入成功', `已保存到 agent-presets/${targetPath}`);
            setWorldbookImportOpen(false);
        } catch (e: any) {
            addToast('error', '导入失败', e?.message || String(e));
        } finally {
            setWorldbookImportSaving(false);
        }
    };

    const worldbookActionMenu = useMemo(() => {
        return {
            items: [
                {
                    key: 'set-current',
                    label: '设为当前世界书',
                    icon: <StarOutlined />,
                    disabled: !selectedIsWorldbook || !rootEnv,
                    onClick: () => void handleSetAsCurrentWorldbook(),
                },
                {
                    key: 'import',
                    label: '导入世界书',
                    icon: <InboxOutlined />,
                    onClick: () => handleOpenWorldbookImport(),
                },
                {
                    key: 'generate',
                    label: '生成世界书',
                    icon: <ThunderboltOutlined />,
                    onClick: () => handleOpenWorldbookGen(),
                },
            ],
        } as any;
    }, [handleOpenWorldbookGen, handleOpenWorldbookImport, handleSetAsCurrentWorldbook, rootEnv, selectedIsWorldbook]);

    return (
        <div className={`${styles.container} ${styles.desktopRoot} ${styles.notebookRoot}`} data-theme={theme}>
            <div className={styles.sidebar}>
                <div className={styles.sidebarHeader}>
                    <div className={styles.searchWrapper}>
                        <Input
                            size="small"
                            placeholder="搜索文件..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            allowClear
                            prefix={<SearchOutlined />}
                        />
                        <Button
                            size="small"
                            icon={<PlusOutlined />}
                            onClick={() => {
                                setNewFileName(scope === 'worldbook' ? 'world/worldbook_new.json' : '');
                                setShowNewFileModal(true);
                            }}
                            style={{ marginLeft: 8 }}
                        />
                    </div>
                    <div className={styles.scopeSwitch}>
                        <div className={styles.pillTabs} role="tablist" aria-label="文件范围">
                            <button
                                type="button"
                                className={`${styles.pillTab} ${scope === 'all' ? styles.pillTabActive : ''}`}
                                aria-selected={scope === 'all'}
                                onClick={() => setScope('all')}
                            >
                                全部
                            </button>
                            <button
                                type="button"
                                className={`${styles.pillTab} ${scope === 'worldbook' ? styles.pillTabActive : ''}`}
                                aria-selected={scope === 'worldbook'}
                                onClick={() => setScope('worldbook')}
                            >
                                世界书
                            </button>
                        </div>
                    </div>
                </div>
                <div className={styles.fileList}>
                    {loading ? (
                        <SentraInlineLoading text="加载中..." />
                    ) : (
                        filteredFolders.map(folder => (
                            <div key={folder.name} className={styles.folderGroup}>
                                <div
                                    className={styles.folderHeader}
                                    onClick={() => toggleFolder(folder.name)}
                                >
                                    {expandedFolders.has(folder.name) ? (
                                        <>
                                            <DownOutlined className={styles.folderChevron} />
                                            <FolderOpenOutlined className={styles.folderIcon} />
                                        </>
                                    ) : (
                                        <>
                                            <RightOutlined className={styles.folderChevron} />
                                            <FolderOutlined className={styles.folderIcon} />
                                        </>
                                    )}
                                    <span className={styles.folderName}>{folder.name}</span>
                                    <span className={styles.fileCount}>({folder.files.length})</span>
                                </div>
                                {expandedFolders.has(folder.name) && (
                                    <div className={styles.folderFiles}>
                                        {folder.files.map(file => (
                                            <div
                                                key={file.path}
                                                className={`${styles.fileItem} ${selectedFile?.path === file.path ? styles.active : ''}`}
                                                onClick={() => selectFile(file)}
                                            >
                                                <FileTextOutlined className={styles.fileIcon} />
                                                <div className={styles.fileName}>{file.name}</div>
                                                {scope === 'worldbook' && (String(file.path || '').trim() === String(currentWorldbook || '').trim() || String(file.name || '').trim() === String(currentWorldbook || '').trim()) ? (
                                                    <Tag color="green" style={{ marginLeft: 8 }}>当前</Tag>
                                                ) : null}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>


            <div className={styles.editorArea}>
                {selectedFile ? (
                    <>
                        <div className={styles.editorToolbar}>
                            <div style={{ flex: 1, minWidth: 0 }} />
                            <div className={styles.actions}>
                                <div className={styles.actionGroups}>
                                    <Space size={6} className={styles.actionGroup}>
                                        {scope === 'worldbook' ? (
                                            <>
                                                {selectedIsCurrentWorldbook ? <Tag color="green">当前世界书</Tag> : selectedIsWorldbook ? <Tag>世界书</Tag> : null}
                                                <Dropdown trigger={['click']} menu={worldbookActionMenu} placement="bottomRight">
                                                    <Button size="small" icon={<FileTextOutlined />}>
                                                        世界书 <DownOutlined />
                                                    </Button>
                                                </Dropdown>
                                            </>
                                        ) : null}

                                        <Button
                                            size="small"
                                            icon={<CloudDownloadOutlined />}
                                            onClick={() => onOpenPresetImporter && onOpenPresetImporter()}
                                        >
                                            导入
                                        </Button>

                                        <Button
                                            size="small"
                                            icon={<ReloadOutlined />}
                                            onClick={() => void (async () => {
                                                try {
                                                    await refreshFiles();
                                                } catch {
                                                    // ignore
                                                }
                                                await selectFile(selectedFile);
                                            })()}
                                        >
                                            刷新
                                        </Button>
                                    </Space>

                                    <Space size={6} className={styles.actionGroup}>
                                        <Button
                                            size="small"
                                            danger
                                            icon={<DeleteOutlined />}
                                            onClick={() => setShowDeleteModal(true)}
                                        >
                                            删除
                                        </Button>
                                        <Button
                                            size="small"
                                            type="primary"
                                            icon={<SaveOutlined />}
                                            onClick={saveFile}
                                            loading={saving}
                                        >
                                            保存
                                        </Button>
                                    </Space>
                                </div>
                            </div>
                        </div>
                        {loadingFile ? (
                            <div className={styles.emptyState}>读取文件中...</div>
                        ) : (
                            <div className={styles.editorSplit}>
                                <div className={styles.editorMain}>
                                    <div className={styles.pageStage}>
                                        <AnimatePresence mode="wait">
                                            <motion.div
                                                key={selectedFile.path}
                                                className={styles.pageSurface}
                                                initial={performanceMode ? false : {
                                                    opacity: 0,
                                                    x: pageFlipDir * 56,
                                                    rotateY: pageFlipDir * -14,
                                                    transformPerspective: 1200,
                                                } as any}
                                                animate={{
                                                    opacity: 1,
                                                    x: 0,
                                                    rotateY: 0,
                                                    transformPerspective: 1200,
                                                } as any}
                                                exit={performanceMode ? undefined : {
                                                    opacity: 0,
                                                    x: pageFlipDir * -56,
                                                    rotateY: pageFlipDir * 14,
                                                    transformPerspective: 1200,
                                                } as any}
                                                transition={{ duration: performanceMode ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
                                            >
                                                <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                                                    <EditorErrorBoundary>
                                                        <Input.TextArea
                                                            className={styles.textEditor}
                                                            value={fileContent}
                                                            onChange={(e) => setFileContent(e.target.value)}
                                                            spellCheck={false}
                                                            disabled={saving}
                                                        />
                                                    </EditorErrorBoundary>
                                                </div>
                                            </motion.div>
                                        </AnimatePresence>
                                    </div>
                                </div>
                            </div>
                        )}
                    </>
                ) : (
                    <div className={styles.emptyState}>
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个文件开始编辑" />
                    </div>
                )}
            </div>

            <Modal
                open={showNewFileModal}
                title="新建文件"
                onCancel={() => setShowNewFileModal(false)}
                onOk={handleCreateFile}
                okText="创建"
                cancelText="取消"
                okButtonProps={{ disabled: !newFileName.trim() }}
                confirmLoading={saving}
                destroyOnHidden
            >
                <Input
                    autoFocus
                    placeholder={scope === 'worldbook' ? '文件名 (例如: world/worldbook_new.json 或 worldbook_new.json)' : '文件名 (例如: new_preset.json)'}
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void handleCreateFile()}
                />
            </Modal>

            <Modal
                open={worldbookGenOpen}
                title="生成世界书"
                onCancel={() => {
                    if (worldbookGenIsStreaming) {
                        handleStopWorldbookGen();
                    }
                    setWorldbookGenOpen(false);
                }}
                footer={null}
                width={980}
                destroyOnHidden
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                            当前世界书：<span>{currentWorldbook}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ fontSize: 12, opacity: 0.75 }}>保存后设为当前</div>
                            <Switch checked={worldbookGenSetActive} onChange={setWorldbookGenSetActive} disabled={worldbookGenSaving || worldbookGenIsStreaming} />
                        </div>
                    </div>

                    <Steps
                        size="small"
                        current={worldbookGenStep}
                        items={[
                            { title: '需求' },
                            { title: '生成' },
                            { title: '保存' },
                        ]}
                    />

                    {worldbookGenStep === 0 ? (
                        <>
                            <Input.TextArea
                                value={worldbookGenText}
                                onChange={(e) => setWorldbookGenText(e.target.value)}
                                placeholder={
                                    '示例：\n'
                                    + '世界观：\n'
                                    + '- 时代/地点/科技或魔法规则\n'
                                    + '- 阵营/组织/人物\n'
                                    + '- 专有名词/禁忌/口径\n'
                                    + '输出要求：条目数量、语言风格等\n'
                                }
                                autoSize={{ minRows: 10, maxRows: 18 }}
                                disabled={worldbookGenIsStreaming || worldbookGenSaving}
                            />

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>模型（可选）</div>
                                    <Input value={worldbookGenModel} onChange={(e) => setWorldbookGenModel(e.target.value)} disabled={worldbookGenIsStreaming || worldbookGenSaving} placeholder="留空默认 gpt-4o-mini" />
                                </div>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>温度</div>
                                    <InputNumber style={{ width: '100%' }} value={worldbookGenTemperature} onChange={(v) => setWorldbookGenTemperature(Number(v ?? 0.4))} step={0.1} disabled={worldbookGenIsStreaming || worldbookGenSaving} />
                                </div>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>max_tokens（-1 表示不传）</div>
                                    <InputNumber style={{ width: '100%' }} value={worldbookGenMaxTokens} onChange={(v) => setWorldbookGenMaxTokens(Number(v ?? -1))} step={256} disabled={worldbookGenIsStreaming || worldbookGenSaving} />
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>API Base URL（必填）</div>
                                    <Input value={worldbookGenApiBaseUrl} onChange={(e) => setWorldbookGenApiBaseUrl(e.target.value)} disabled={worldbookGenIsStreaming || worldbookGenSaving} placeholder="https://xxx 或 https://xxx/v1" />
                                </div>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>API Key（必填）</div>
                                    <Input.Password value={worldbookGenApiKey} onChange={(e) => setWorldbookGenApiKey(e.target.value)} disabled={worldbookGenIsStreaming || worldbookGenSaving} placeholder="sk-..." />
                                </div>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Button onClick={() => setWorldbookGenOpen(false)} disabled={worldbookGenIsStreaming || worldbookGenSaving}>取消</Button>
                                <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => void handleRunWorldbookGen()} disabled={!String(worldbookGenText || '').trim() || worldbookGenSaving} loading={worldbookGenIsStreaming}>
                                    开始生成
                                </Button>
                            </div>
                        </>
                    ) : null}

                    {worldbookGenStep === 1 ? (
                        <>
                            {worldbookGenError ? (
                                <Alert type="error" message="生成失败" description={worldbookGenError} showIcon />
                            ) : (
                                <Alert type="info" message={worldbookGenIsStreaming ? '正在生成...' : '等待生成结果...'} showIcon />
                            )}

                            <div style={{
                                borderRadius: 12,
                                border: theme === 'dark' ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.10)',
                                background: theme === 'dark' ? 'rgba(255,255,255,0.04)' : '#ffffff',
                                padding: 12,
                                fontSize: 12,
                                whiteSpace: 'pre-wrap',
                                minHeight: 260,
                                maxHeight: 360,
                                overflow: 'auto',
                            }}>
                                {worldbookGenStreamText || '流式输出会显示在这里...'}
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Button onClick={() => setWorldbookGenStep(0)} disabled={worldbookGenIsStreaming || worldbookGenSaving}>上一步</Button>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <Button onClick={handleStopWorldbookGen} disabled={!worldbookGenIsStreaming}>停止</Button>
                                    <Button
                                        type="primary"
                                        onClick={() => setWorldbookGenStep(2)}
                                        disabled={worldbookGenIsStreaming || !worldbookGenResultJson}
                                    >
                                        下一步
                                    </Button>
                                </div>
                            </div>
                        </>
                    ) : null}

                    {worldbookGenStep === 2 ? (
                        <>
                            {worldbookGenResultJson ? (
                                <Alert type="success" message="世界书 JSON 已生成" showIcon />
                            ) : (
                                <Alert type="warning" message="尚未生成世界书" showIcon />
                            )}

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 12, alignItems: 'start' }}>
                                <div style={{
                                    borderRadius: 12,
                                    border: theme === 'dark' ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.10)',
                                    background: theme === 'dark' ? 'rgba(255,255,255,0.04)' : '#ffffff',
                                    padding: 12,
                                    fontSize: 12,
                                    whiteSpace: 'pre-wrap',
                                    minHeight: 220,
                                    maxHeight: 360,
                                    overflow: 'auto',
                                }}>
                                    {worldbookGenResultJson ? JSON.stringify(worldbookGenResultJson, null, 2) : (worldbookGenResultXml || worldbookGenStreamText || '')}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                    <div style={{ fontSize: 12, opacity: 0.75 }}>文件名（保存到 agent-presets/world/）</div>
                                    <Input value={worldbookGenFileName} onChange={(e) => setWorldbookGenFileName(e.target.value)} disabled={worldbookGenSaving} />
                                    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                                        <Button onClick={() => setWorldbookGenStep(1)} disabled={worldbookGenSaving}>上一步</Button>
                                        <Button
                                            type="primary"
                                            icon={<SaveOutlined />}
                                            loading={worldbookGenSaving}
                                            disabled={!worldbookGenResultJson || !String(worldbookGenFileName || '').trim()}
                                            onClick={() => void handleSaveWorldbookGen()}
                                        >
                                            保存并打开
                                        </Button>
                                    </div>
                                    <Button onClick={() => setWorldbookGenOpen(false)} disabled={worldbookGenSaving}>
                                        关闭
                                    </Button>
                                </div>
                            </div>
                        </>
                    ) : null}
                </div>
            </Modal>

            <Modal
                open={worldbookImportOpen}
                title="导入世界书"
                onCancel={() => setWorldbookImportOpen(false)}
                footer={null}
                width={920}
                destroyOnHidden
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                            当前世界书：<span>{currentWorldbook}</span>
                        </div>
                    </div>

                    <Steps
                        size="small"
                        current={worldbookImportStep}
                        items={[
                            { title: '来源' },
                            { title: '校验' },
                            { title: '保存' },
                        ]}
                    />

                    {worldbookImportStep === 0 ? (
                        <div className={styles.modalTabsRow}>
                            <div className={styles.pillTabs} role="tablist" aria-label="导入方式">
                                <button
                                    type="button"
                                    className={`${styles.pillTab} ${worldbookImportMode === 'upload' ? styles.pillTabActive : ''}`}
                                    aria-selected={worldbookImportMode === 'upload'}
                                    onClick={() => setWorldbookImportMode('upload')}
                                >
                                    上传
                                </button>
                                <button
                                    type="button"
                                    className={`${styles.pillTab} ${worldbookImportMode === 'text' ? styles.pillTabActive : ''}`}
                                    aria-selected={worldbookImportMode === 'text'}
                                    onClick={() => setWorldbookImportMode('text')}
                                >
                                    文本
                                </button>
                            </div>
                        </div>
                    ) : null}

                    {worldbookImportStep === 0 && worldbookImportMode === 'upload' ? (
                        <Upload.Dragger
                            multiple={false}
                            showUploadList={false}
                            accept=".json"
                            disabled={worldbookImportSaving}
                            beforeUpload={async (f) => {
                                try {
                                    const text = await (f as any).text();
                                    setWorldbookImportRaw(text);
                                    setWorldbookImportFileName(String((f as any).name || 'worldbook.json'));
                                } catch (e: any) {
                                    addToast('error', '读取失败', e?.message || String(e));
                                }
                                return false;
                            }}
                            style={{ borderRadius: 14 }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <InboxOutlined />
                                <div style={{ textAlign: 'left' }}>
                                    <div style={{ fontWeight: 600 }}>拖拽世界书 JSON 到这里</div>
                                    <div style={{ fontSize: 12, opacity: 0.75 }}>或点击选择文件（仅 .json）</div>
                                </div>
                            </div>
                        </Upload.Dragger>
                    ) : null}

                    {worldbookImportStep === 0 && worldbookImportMode === 'text' ? (
                        <Input.TextArea
                            value={worldbookImportRaw}
                            onChange={(e) => setWorldbookImportRaw(e.target.value)}
                            placeholder="粘贴 worldbook JSON..."
                            autoSize={{ minRows: 8, maxRows: 18 }}
                            disabled={worldbookImportSaving}
                        />
                    ) : null}

                    {worldbookImportStep === 1 ? (
                        <>
                            {worldbookImportError ? (
                                <Alert type="error" message="JSON 无法解析" description={worldbookImportError} showIcon />
                            ) : (
                                <Alert type="success" message="JSON 校验通过" showIcon />
                            )}
                            <div style={{
                                borderRadius: 12,
                                border: theme === 'dark' ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.10)',
                                background: theme === 'dark' ? 'rgba(255,255,255,0.04)' : '#ffffff',
                                padding: 12,
                                fontSize: 12,
                                whiteSpace: 'pre-wrap',
                                minHeight: 220,
                                maxHeight: 360,
                                overflow: 'auto',
                            }}>
                                {parsedWorldbook || '预览区：选择文件或粘贴 JSON 后会显示格式化内容'}
                            </div>
                        </>
                    ) : null}

                    {worldbookImportStep === 2 ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 12, alignItems: 'start' }}>
                        <div style={{
                            borderRadius: 12,
                            border: theme === 'dark' ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.10)',
                            background: theme === 'dark' ? 'rgba(255,255,255,0.04)' : '#ffffff',
                            padding: 12,
                            fontSize: 12,
                            whiteSpace: 'pre-wrap',
                            minHeight: 220,
                            maxHeight: 360,
                            overflow: 'auto',
                        }}>
                            {parsedWorldbook || '预览区：选择文件或粘贴 JSON 后会显示格式化内容'}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                            <div style={{ fontSize: 12, opacity: 0.75 }}>文件名（保存到 agent-presets/）</div>
                            <Input value={worldbookImportFileName} onChange={(e) => setWorldbookImportFileName(e.target.value)} disabled={worldbookImportSaving} />
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                                <Button onClick={() => setWorldbookImportOpen(false)} disabled={worldbookImportSaving}>
                                    取消
                                </Button>
                                <Button
                                    type="primary"
                                    icon={<SaveOutlined />}
                                    loading={worldbookImportSaving}
                                    disabled={!String(worldbookImportFileName || '').trim() || !!worldbookImportError || !String(parsedWorldbook || '').trim()}
                                    onClick={() => void handleSaveWorldbookImport()}
                                >
                                    保存并打开
                                </Button>
                            </div>
                        </div>
                    </div>
                    ) : null}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                        <Button
                            disabled={worldbookImportSaving || worldbookImportStep === 0}
                            onClick={() => setWorldbookImportStep((s) => Math.max(0, s - 1))}
                        >
                            上一步
                        </Button>
                        <Button
                            type="primary"
                            disabled={worldbookImportSaving || worldbookImportStep >= 2 || !String(worldbookImportRaw || '').trim() || !!worldbookImportError}
                            onClick={() => setWorldbookImportStep((s) => Math.min(2, s + 1))}
                        >
                            下一步
                        </Button>
                    </div>
                </div>
            </Modal>

            <Modal
                open={showDeleteModal && !!selectedFile}
                title="确认删除"
                onCancel={() => setShowDeleteModal(false)}
                onOk={handleDeleteFile}
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true, disabled: !selectedFile }}
                confirmLoading={saving}
                destroyOnHidden
            >
                <div style={{ padding: '6px 0', color: 'var(--text-secondary)' }}>
                    确定要删除文件 <strong>{selectedFile?.name}</strong> 吗？此操作无法撤销。
                </div>
            </Modal>
        </div>
    );
};
