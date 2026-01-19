import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import styles from './PresetsEditor.module.css';
import { Alert, Button, Empty, Input, Modal, Space } from 'antd';
import {
    CloudDownloadOutlined,
    DeleteOutlined,
    DownOutlined,
    FileTextOutlined,
    FolderOpenOutlined,
    FolderOutlined,
    PlusOutlined,
    ReloadOutlined,
    RightOutlined,
    SaveOutlined,
    SearchOutlined,
} from '@ant-design/icons';
import { PresetsEditorState } from '../hooks/usePresetsEditor';
import type { ToastMessage } from './Toast';
import { storage } from '../utils/storage';

const MonacoEditor = lazy(async () => {
    await import('../utils/monacoSetup');
    const mod = await import('@monaco-editor/react');
    return { default: mod.default };
});

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

const readUseMonaco = () => {
    return storage.getBool('sentra_presets_use_monaco', { fallback: false });
};

export const PresetsEditor: React.FC<PresetsEditorProps> = ({ theme, state, performanceMode = false, onOpenPresetImporter, addToast }) => {
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
        toggleFolder
    } = state;

    const [showNewFileModal, setShowNewFileModal] = useState(false);
    const [newFileName, setNewFileName] = useState('');
    const [showDeleteModal, setShowDeleteModal] = useState(false);

    const [useMonaco, setUseMonaco] = useState(() => readUseMonaco());

    useEffect(() => {
        storage.setBool('sentra_presets_use_monaco', useMonaco);
    }, [useMonaco]);

    const editorContainerRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null);
    const [editorSize, setEditorSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

    useEffect(() => {
        const el = editorContainerRef.current;
        if (!el) return;

        let rafId: number | null = null;

        const measure = () => {
            try {
                const rect = el.getBoundingClientRect();
                const w = Math.max(0, Math.round(rect.width));
                const h = Math.max(0, Math.round(rect.height));
                setEditorSize({ w, h });
                const editor = editorRef.current;
                if (!editor) return;
                try {
                    editor.layout();
                } catch {
                    // ignore
                }
            } catch {
                // ignore
            }
        };

        const ro = new ResizeObserver(() => {
            measure();
        });

        ro.observe(el);

        const onWindowResize = () => measure();
        window.addEventListener('resize', onWindowResize);

        // run once immediately (ResizeObserver can be delayed)
        measure();

        // In some layouts the container may report 0x0 until the next frame.
        let tries = 0;
        const tick = () => {
            tries += 1;
            measure();
            const rect = el.getBoundingClientRect();
            if ((rect.width <= 0 || rect.height <= 0) && tries < 10) {
                rafId = window.requestAnimationFrame(tick);
            }
        };
        rafId = window.requestAnimationFrame(tick);

        return () => {
            try {
                ro.disconnect();
            } catch {
                // ignore
            }

            window.removeEventListener('resize', onWindowResize);
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
        };
    }, [selectedFile?.path, useMonaco]);

    // Filter folders and files based on search term
    const filteredFolders = searchTerm
        ? folders.map(folder => ({
            ...folder,
            files: folder.files.filter(f =>
                f.name.toLowerCase().includes(searchTerm.toLowerCase())
            )
        })).filter(folder => folder.files.length > 0)
        : folders;

    const getLanguage = (filename: string) => {
        const ext = filename.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'json': return 'json';
            case 'js': return 'javascript';
            case 'ts': return 'typescript';
            case 'md': return 'markdown';
            case 'yml':
            case 'yaml': return 'yaml';
            case 'css': return 'css';
            case 'html': return 'html';
            default: return 'plaintext';
        }
    };

    const handleCreateFile = async () => {
        if (!newFileName.trim()) return;
        await createFile(newFileName);
        setShowNewFileModal(false);
        setNewFileName('');
    };

    const handleDeleteFile = async () => {
        if (!selectedFile) return;
        await deleteFile(selectedFile);
        setShowDeleteModal(false);
    };

    return (
        <div className={`${styles.container} ${styles.desktopRoot}`} data-theme={theme}>
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
                            onClick={() => setShowNewFileModal(true)}
                            style={{ marginLeft: 8 }}
                        />
                    </div>
                </div>
                <div className={styles.fileList}>
                    {loading ? (
                        <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>加载中...</div>
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
                            <div className={styles.filePath}>{selectedFile.path}</div>
                            <div className={styles.actions}>
                                <Space size={8}>
                                    {import.meta.env.DEV ? (
                                        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                                            len={fileContent.length} size={editorSize.w}×{editorSize.h}
                                        </span>
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
                                        onClick={() => {
                                            setUseMonaco((v) => {
                                                const next = !v;
                                                if (performanceMode && next) addToast('info', '性能模式已开启', '已启用高级编辑器（Monaco），可能增加内存占用并引发卡顿');
                                                return next;
                                            });
                                        }}
                                        title={useMonaco ? '已启用高级编辑器（占用更高）' : '轻量编辑器（更省内存）'}
                                    >
                                        {useMonaco ? '高级' : '轻量'}
                                    </Button>
                                    <Button
                                        size="small"
                                        icon={<ReloadOutlined />}
                                        onClick={() => selectFile(selectedFile)}
                                    />
                                    <Button
                                        size="small"
                                        danger
                                        icon={<DeleteOutlined />}
                                        onClick={() => setShowDeleteModal(true)}
                                    />
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
                        {loadingFile ? (
                            <div className={styles.emptyState}>读取文件中...</div>
                        ) : (
                            <div className={styles.editorSplit}>
                                <div className={styles.editorMain} ref={editorContainerRef}>
                                    <div style={{ flex: 1, minHeight: 0 }}>
                                        <EditorErrorBoundary>
                                            {(() => {
                                                const fallback = (
                                                    <textarea
                                                        value={fileContent}
                                                        onChange={(e) => setFileContent(e.target.value)}
                                                        spellCheck={false}
                                                        style={{
                                                            width: '100%',
                                                            height: '100%',
                                                            resize: 'none',
                                                            border: 'none',
                                                            outline: 'none',
                                                            background: theme === 'dark' ? '#0b0f14' : '#ffffff',
                                                            color: theme === 'dark' ? 'rgba(255,255,255,0.92)' : '#111827',
                                                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                                                            fontSize: 13,
                                                            lineHeight: 1.45,
                                                            padding: 12,
                                                            boxSizing: 'border-box',
                                                        }}
                                                    />
                                                );

                                                if (!useMonaco) return fallback;

                                                return (
                                                    <Suspense fallback={fallback}>
                                                        <MonacoEditor
                                                            key={selectedFile.path}
                                                            height="100%"
                                                            language={getLanguage(selectedFile.name)}
                                                            value={fileContent}
                                                            onChange={(value) => setFileContent(value || '')}
                                                            theme={theme === 'dark' ? 'vs-dark' : 'light'}
                                                            onMount={(editor) => {
                                                                editorRef.current = editor;
                                                                window.setTimeout(() => {
                                                                    try {
                                                                        editor.layout();
                                                                    } catch {
                                                                        // ignore
                                                                    }
                                                                }, 0);
                                                            }}
                                                            options={{
                                                                minimap: { enabled: !performanceMode },
                                                                fontSize: 13,
                                                                fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
                                                                scrollBeyondLastLine: false,
                                                                automaticLayout: true,
                                                            }}
                                                        />
                                                    </Suspense>
                                                );
                                            })()}
                                        </EditorErrorBoundary>
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
                    placeholder="文件名 (例如: new_preset.json)"
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void handleCreateFile()}
                />
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
