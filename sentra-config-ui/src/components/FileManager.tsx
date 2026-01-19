import React, { Suspense, lazy, useState, useEffect, useCallback } from 'react';
import styles from './FileManager.module.css';
import {
    IoRefresh, IoFolderOpen, IoDocumentText,
    IoImage, IoCodeSlash, IoChevronForward, IoChevronDown,
    IoFolder, IoSettings, IoLogoMarkdown, IoClose
} from 'react-icons/io5';
import {
    SiPython, SiJavascript, SiTypescript, SiHtml5, SiCss3,
    SiJson, SiGo, SiReact, SiGnubash, SiVite
} from 'react-icons/si';
import { VscNewFile, VscNewFolder, VscTrash, VscEdit, VscCopy, VscPreview, VscCode } from 'react-icons/vsc';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
    fetchFileTree, fetchFileContent, saveFileContent,
    createFile, renameFile, deleteFile,
    FileNode
} from '../services/fileApi';
import { ToastMessage } from './Toast';
import { storage } from '../utils/storage';

const MonacoEditor = lazy(async () => {
    await import('../utils/monacoSetup');
    const mod = await import('@monaco-editor/react');
    return { default: mod.default };
});

const readUseMonaco = () => {
    return storage.getBool('sentra_file_manager_use_monaco', { fallback: false });
};

interface FileManagerProps {
    onClose: () => void;
    addToast: (type: ToastMessage['type'], title: string, message?: string) => void;
    theme: 'light' | 'dark';
    performanceMode?: boolean;
}

// Icon Helper
const getFileIcon = (name: string) => {
    const lowerName = name.toLowerCase();
    if (lowerName === '.env' || lowerName.startsWith('.env.')) return <IoSettings style={{ color: '#ecd53f' }} />;
    if (lowerName === 'package.json') return <SiJson style={{ color: '#CB3837' }} />;
    if (lowerName === 'vite.config.ts' || lowerName === 'vite.config.js') return <SiVite style={{ color: '#646CFF' }} />;

    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'py': return <SiPython style={{ color: '#3776AB' }} />;
        case 'js': return <SiJavascript style={{ color: '#F7DF1E' }} />;
        case 'jsx': return <SiReact style={{ color: '#61DAFB' }} />;
        case 'ts': return <SiTypescript style={{ color: '#3178C6' }} />;
        case 'tsx': return <SiReact style={{ color: '#61DAFB' }} />;
        case 'html': return <SiHtml5 style={{ color: '#E34F26' }} />;
        case 'css': return <SiCss3 style={{ color: '#1572B6' }} />;
        case 'json': return <SiJson style={{ color: '#F1E05A' }} />;
        case 'md': return <IoLogoMarkdown style={{ color: '#42a5f5' }} />;
        case 'go': return <SiGo style={{ color: '#00ADD8' }} />;
        case 'sh': return <SiGnubash style={{ color: '#4EAA25' }} />;
        case 'png':
        case 'jpg':
        case 'jpeg':
        case 'gif':
        case 'svg':
        case 'webp':
            return <IoImage style={{ color: '#B07219' }} />;
        default:
            return <IoDocumentText style={{ color: '#ccc' }} />;
    }
};

// Tree Item Component - Memoized for performance
const FileTreeItem: React.FC<{
    node: FileNode;
    level: number;
    selectedPath: string | null;
    onSelect: (node: FileNode) => void;
    onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
}> = React.memo(({ node, level, selectedPath, onSelect, onContextMenu }) => {
    const [expanded, setExpanded] = useState(false);

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (node.type === 'directory') {
            setExpanded(!expanded);
        } else {
            onSelect(node);
        }
    };

    const handleRightClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(node);
        onContextMenu(e, node);
    };

    return (
        <div>
            <div
                className={`${styles.treeItem} ${selectedPath === node.path ? styles.active : ''}`}
                style={{ paddingLeft: `${level * 14 + 10}px` }}
                onClick={handleClick}
                onContextMenu={handleRightClick}
            >
                <span className={styles.itemIndent}>
                    {node.type === 'directory' && (
                        <span className={styles.arrowIcon}>
                            {expanded ? <IoChevronDown size={12} /> : <IoChevronForward size={12} />}
                        </span>
                    )}
                </span>
                <span className={styles.itemIcon}>
                    {node.type === 'directory' ? (
                        expanded ? <IoFolderOpen className={styles.folderIcon} /> : <IoFolder className={styles.folderIcon} />
                    ) : (
                        getFileIcon(node.name)
                    )}
                </span>
                <span className={styles.itemName}>{node.name}</span>
            </div>
            {expanded && node.children && (
                <div>
                    {node.children.map(child => (
                        <FileTreeItem
                            key={child.path}
                            node={child}
                            level={level + 1}
                            selectedPath={selectedPath}
                            onSelect={onSelect}
                            onContextMenu={onContextMenu}
                        />
                    ))}
                </div>
            )}
        </div>
    );
});

interface OpenFile {
    node: FileNode;
    content: string;
    originalContent: string;
    isBinary: boolean;
    isDirty: boolean;
    preview: boolean;
}

type FileManagerPersistedState = {
    version: 1;
    openPaths: string[];
    activePath: string | null;
    previewByPath?: Record<string, boolean>;
};

export const FileManager: React.FC<FileManagerProps> = ({ onClose, addToast, theme, performanceMode = false }) => {
    const [fileTree, setFileTree] = useState<FileNode[]>([]);

    // Multi-tab state
    const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
    const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, node: FileNode } | null>(null);
    const [loading, setLoading] = useState(false);

    // Race condition prevention
    const loadingPathRef = React.useRef<string | null>(null);
    const restoreRequestedRef = React.useRef(false);

    // Modal State
    const [modalOpen, setModalOpen] = useState(false);
    const [modalType, setModalType] = useState<'createFile' | 'createFolder' | 'rename'>('createFile');
    const [modalInput, setModalInput] = useState('');

    const [useMonaco, setUseMonaco] = useState(() => readUseMonaco());

    useEffect(() => {
        storage.setBool('sentra_file_manager_use_monaco', useMonaco);
    }, [useMonaco]);
    const [targetNode, setTargetNode] = useState<FileNode | null>(null);

    const activeFilePathRef = React.useRef<string | null>(null);
    const latestContentRef = React.useRef<Record<string, string>>({});
    const contentDebounceRef = React.useRef<number | null>(null);
    const pendingUpdateRef = React.useRef<{ path: string; content: string } | null>(null);

    const activeFile = React.useMemo(() =>
        openFiles.find(f => f.node.path === activeFilePath) || null,
        [openFiles, activeFilePath]
    );

    useEffect(() => {
        activeFilePathRef.current = activeFilePath;
    }, [activeFilePath]);

    useEffect(() => {
        return () => {
            if (contentDebounceRef.current != null) {
                window.clearTimeout(contentDebounceRef.current);
                contentDebounceRef.current = null;
            }
        };
    }, []);

    const loadTree = useCallback(async () => {
        try {
            const tree = await fetchFileTree();
            const buildTree = (items: any[]): FileNode[] => {
                const root: FileNode[] = [];
                const map: { [key: string]: FileNode } = {};
                items.forEach(item => {
                    map[item.path] = { ...item, children: [] };
                });
                items.forEach(item => {
                    const node = map[item.path];
                    const parts = item.path.split('/');
                    if (parts.length === 1) {
                        root.push(node);
                    } else {
                        const parentPath = parts.slice(0, -1).join('/');
                        if (map[parentPath]) {
                            map[parentPath].children?.push(node);
                        } else {
                            root.push(node);
                        }
                    }
                });
                return root;
            };
            setFileTree(buildTree(tree));
        } catch (e) {
            console.error(e);
            addToast('error', '加载文件列表失败');
        }
    }, [addToast]);

    useEffect(() => {
        loadTree();
    }, [loadTree]);

    // Restore persisted tabs/active file on first tree load
    useEffect(() => {
        if (restoreRequestedRef.current) return;
        if (!fileTree || fileTree.length === 0) return;
        restoreRequestedRef.current = true;

        const persisted = storage.getJson<FileManagerPersistedState | null>('sentra_file_manager_state', { fallback: null });

        if (!persisted || persisted.version !== 1 || !Array.isArray(persisted.openPaths) || persisted.openPaths.length === 0) {
            return;
        }

        const findNodeByPath = (nodes: FileNode[], path: string): FileNode | null => {
            for (const n of nodes) {
                if (n.path === path) return n;
                if (n.children && n.children.length) {
                    const found = findNodeByPath(n.children, path);
                    if (found) return found;
                }
            }
            return null;
        };

        const previewByPath = persisted.previewByPath || {};

        const restoreOne = async (path: string) => {
            const node = findNodeByPath(fileTree, path);
            if (!node || node.type !== 'file') return;
            try {
                const data = await fetchFileContent(node.path);
                const restored: OpenFile = {
                    node,
                    content: data.content,
                    originalContent: data.content,
                    isBinary: data.isBinary,
                    isDirty: false,
                    preview: !!previewByPath[node.path],
                };
                latestContentRef.current[node.path] = data.content;
                setOpenFiles(prev => {
                    if (prev.some(f => f.node.path === node.path)) return prev;
                    return [...prev, restored];
                });
            } catch {
                // ignore restore failures
            }
        };

        (async () => {
            for (const p of persisted.openPaths.slice(0, 12)) {
                // eslint-disable-next-line no-await-in-loop
                await restoreOne(p);
            }
            if (persisted.activePath) {
                setActiveFilePath(persisted.activePath);
            } else if (persisted.openPaths.length > 0) {
                setActiveFilePath(persisted.openPaths[0]);
            }
        })();
    }, [fileTree]);

    // Persist tabs/active selection (do not store file content)
    useEffect(() => {
        try {
            const previewByPath: Record<string, boolean> = {};
            for (const f of openFiles) {
                if (f.preview) previewByPath[f.node.path] = true;
            }
            const snapshot: FileManagerPersistedState = {
                version: 1,
                openPaths: openFiles.map(f => f.node.path),
                activePath: activeFilePath,
                previewByPath,
            };
            storage.setJson('sentra_file_manager_state', snapshot);
        } catch {
            // ignore
        }
    }, [openFiles, activeFilePath]);

    const handleFileSelect = async (node: FileNode) => {
        if (node.type === 'directory') return;

        // Check if already open
        const existing = openFiles.find(f => f.node.path === node.path);
        if (existing) {
            setActiveFilePath(node.path);
            return;
        }

        // Prevent race condition: track the latest requested path
        loadingPathRef.current = node.path;
        setLoading(true);

        try {
            const data = await fetchFileContent(node.path);

            // Only update if this is still the most recent request
            if (loadingPathRef.current === node.path) {
                const newFile: OpenFile = {
                    node,
                    content: data.content,
                    originalContent: data.content,
                    isBinary: data.isBinary,
                    isDirty: false,
                    preview: false
                };
                latestContentRef.current[node.path] = data.content;
                setOpenFiles(prev => {
                    // Double check prevent duplicate
                    if (prev.some(f => f.node.path === node.path)) return prev;
                    return [...prev, newFile];
                });
                setActiveFilePath(node.path);
            }
        } catch (e) {
            if (loadingPathRef.current === node.path) {
                addToast('error', '读取文件失败');
            }
        } finally {
            if (loadingPathRef.current === node.path) {
                setLoading(false);
                loadingPathRef.current = null;
            }
        }
    };

    const handleCloseTab = (e: React.MouseEvent, path: string) => {
        e.stopPropagation();
        const fileToClose = openFiles.find(f => f.node.path === path);
        if (fileToClose?.isDirty) {
            if (!confirm(`文件 ${fileToClose.node.name} 有未保存的修改，确定要关闭吗？`)) return;
        }

        const newFiles = openFiles.filter(f => f.node.path !== path);
        setOpenFiles(newFiles);

        if (activeFilePath === path) {
            if (newFiles.length > 0) {
                // Switch to the last opened file or the one next to it
                setActiveFilePath(newFiles[newFiles.length - 1].node.path);
            } else {
                setActiveFilePath(null);
            }
        }
    };

    const updateActiveFileContent = (newContent: string) => {
        const path = activeFilePathRef.current;
        if (!path) return;
        latestContentRef.current[path] = newContent;
        pendingUpdateRef.current = { path, content: newContent };

        if (contentDebounceRef.current != null) {
            window.clearTimeout(contentDebounceRef.current);
        }

        contentDebounceRef.current = window.setTimeout(() => {
            contentDebounceRef.current = null;
            const pending = pendingUpdateRef.current;
            if (!pending) return;
            setOpenFiles(prev => prev.map(f => {
                if (f.node.path !== pending.path) return f;
                return {
                    ...f,
                    content: pending.content,
                    isDirty: pending.content !== f.originalContent
                };
            }));
        }, 120);
    };

    const togglePreview = () => {
        if (!activeFilePath) return;
        setOpenFiles(prev => prev.map(f => {
            if (f.node.path === activeFilePath) {
                return { ...f, preview: !f.preview };
            }
            return f;
        }));
    };

    const handleSaveFile = async () => {
        if (!activeFile) return;
        try {
            const latest = latestContentRef.current[activeFile.node.path];
            const contentToSave = latest != null ? latest : activeFile.content;
            await saveFileContent(activeFile.node.path, contentToSave);
            setOpenFiles(prev => prev.map(f => {
                if (f.node.path === activeFilePath) {
                    return {
                        ...f,
                        content: contentToSave,
                        originalContent: contentToSave,
                        isDirty: false
                    };
                }
                return f;
            }));
            latestContentRef.current[activeFile.node.path] = contentToSave;
            addToast('success', '保存成功');
        } catch (e) {
            addToast('error', '保存失败');
        }
    };

    // Keyboard Shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                e.stopPropagation();
                handleSaveFile();
            }
            // Ctrl+F handling
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                if (!e.defaultPrevented) {
                    // Allow bubbling
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeFile]);

    const handleCreate = async () => {
        if (!modalInput) return;
        let parentPath = '';
        if (targetNode && targetNode.type === 'directory') {
            parentPath = targetNode.path;
        } else if (targetNode) {
            const parts = targetNode.path.split('/');
            parentPath = parts.slice(0, -1).join('/');
        }

        const newPath = parentPath ? `${parentPath}/${modalInput}` : modalInput;
        const type = modalType === 'createFolder' ? 'directory' : 'file';

        try {
            await createFile(newPath, type);
            addToast('success', '创建成功');
            setModalOpen(false);
            loadTree();
        } catch (e) {
            addToast('error', '创建失败');
        }
    };

    const handleRename = async () => {
        if (!modalInput || !targetNode) return;
        const parts = targetNode.path.split('/');
        const parentPath = parts.slice(0, -1).join('/');
        const newPath = parentPath ? `${parentPath}/${modalInput}` : modalInput;

        try {
            await renameFile(targetNode.path, newPath);
            addToast('success', '重命名成功');
            setModalOpen(false);
            loadTree();

            // Update open files if renamed
            setOpenFiles(prev => prev.map(f => {
                if (f.node.path === targetNode.path) {
                    return { ...f, node: { ...f.node, path: newPath, name: modalInput } };
                }
                return f;
            }));
            if (activeFilePath === targetNode.path) {
                setActiveFilePath(newPath);
            }

        } catch (e) {
            addToast('error', '重命名失败');
        }
    };

    const handleDelete = async () => {
        if (!targetNode) return;
        if (!confirm(`确定要删除 ${targetNode.name} 吗？`)) return;

        try {
            await deleteFile(targetNode.path);
            addToast('success', '删除成功');
            loadTree();

            // Close if open
            if (openFiles.some(f => f.node.path === targetNode.path)) {
                const newFiles = openFiles.filter(f => f.node.path !== targetNode.path);
                setOpenFiles(newFiles);
                if (activeFilePath === targetNode.path) {
                    setActiveFilePath(newFiles.length > 0 ? newFiles[newFiles.length - 1].node.path : null);
                }
            }
        } catch (e) {
            addToast('error', '删除失败');
        }
    };

    // Close context menu on click elsewhere
    useEffect(() => {
        const handleClick = () => setContextMenu(null);
        window.addEventListener('click', handleClick);
        return () => window.removeEventListener('click', handleClick);
    }, []);

    return (
        <div className={`${styles.container} ${styles.desktopRoot}`} data-theme={theme} onContextMenu={(e) => e.preventDefault()}>
            <div className={styles.sidebar}>
                <div className={styles.sidebarHeader}>
                    <span>EXPLORER</span>
                    <button className={styles.refreshBtn} onClick={loadTree} title="刷新">
                        <IoRefresh />
                    </button>
                    <button className={styles.refreshBtn} onClick={onClose} title="关闭">
                        <IoClose />
                    </button>
                </div>
                <div className={styles.fileTree}>
                    {fileTree.map(node => (
                        <FileTreeItem
                            key={node.path}
                            node={node}
                            level={0}
                            selectedPath={activeFilePath}
                            onSelect={handleFileSelect}
                            onContextMenu={(e, n) => {
                                setContextMenu({ x: e.clientX, y: e.clientY, node: n });
                            }}
                        />
                    ))}
                </div>
            </div>

            <div className={styles.mainArea}>
                {/* Tabs Bar */}
                {openFiles.length > 0 && (
                    <div className={styles.tabs}>
                        {openFiles.map(file => (
                            <div
                                key={file.node.path}
                                className={`${styles.tab} ${activeFilePath === file.node.path ? styles.active : ''}`}
                                onClick={() => setActiveFilePath(file.node.path)}
                            >
                                <span className={styles.tabIcon}>{getFileIcon(file.node.name)}</span>
                                <span className={styles.tabName}>
                                    {file.node.name}
                                    {file.isDirty && <span style={{ marginLeft: 4 }}>●</span>}
                                </span>
                                <span className={styles.tabClose} onClick={(e) => handleCloseTab(e, file.node.path)}>
                                    <IoClose />
                                </span>
                            </div>
                        ))}

                        {/* Preview Toggle for Active File */}
                        {activeFile && activeFile.node.name.endsWith('.md') && (
                            <div className={styles.tab} onClick={togglePreview} style={{ marginLeft: 'auto', borderLeft: '1px solid #333', minWidth: 'auto', borderRight: 'none' }}>
                                {activeFile.preview ? <VscCode /> : <VscPreview />}
                                <span style={{ marginLeft: 6 }}>{activeFile.preview ? '编辑' : '预览'}</span>
                            </div>
                        )}

                        {/* Editor Toggle */}
                        <div
                            className={styles.tab}
                            onClick={() => {
                                setUseMonaco((v: boolean) => {
                                    const next = !v;
                                    if (performanceMode && next) {
                                        const ok = confirm('性能模式已开启，启用高级编辑器会增加内存占用并可能引发卡顿，仍要启用吗？');
                                        if (!ok) return v;
                                    }
                                    return next;
                                });
                            }}
                            style={{
                                marginLeft: activeFile && activeFile.node.name.endsWith('.md') ? 0 : 'auto',
                                borderLeft: '1px solid #333',
                                minWidth: 'auto',
                                borderRight: 'none'
                            }}
                            title={useMonaco ? '已启用高级编辑器（占用更高）' : '轻量编辑器（更省内存）'}
                        >
                            <IoCodeSlash />
                            <span style={{ marginLeft: 6 }}>{useMonaco ? '高级' : '轻量'}</span>
                        </div>
                    </div>
                )}

                <div className={styles.editorContainer}>
                    {activeFile ? (
                        (loading && loadingPathRef.current === activeFile.node.path) ? (
                            <div className={styles.emptyState}>加载中...</div>
                        ) : activeFile.isBinary ? (
                            <div className={styles.imagePreview}>
                                <img src={activeFile.content} alt={activeFile.node.name} />
                            </div>
                        ) : activeFile.preview && activeFile.node.name.endsWith('.md') ? (
                            <div className={styles.markdownPreview}>
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{activeFile.content}</ReactMarkdown>
                            </div>
                        ) : (
                            (() => {
                                const defaultLanguage =
                                    activeFile.node.name.endsWith('.json') ? 'json' :
                                        activeFile.node.name.endsWith('.ts') ? 'typescript' :
                                            activeFile.node.name.endsWith('.tsx') ? 'typescript' :
                                                activeFile.node.name.endsWith('.js') ? 'javascript' :
                                                    activeFile.node.name.endsWith('.css') ? 'css' :
                                                        activeFile.node.name.endsWith('.html') ? 'html' :
                                                            activeFile.node.name.endsWith('.py') ? 'python' :
                                                                activeFile.node.name.endsWith('.md') ? 'markdown' :
                                                                    'plaintext';

                                const fallback = (
                                    <textarea
                                        value={activeFile.content}
                                        onChange={(e) => updateActiveFileContent(e.target.value)}
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
                                            height="100%"
                                            path={activeFile.node.path}
                                            defaultLanguage={defaultLanguage}
                                            value={activeFile.content}
                                            onChange={(val) => updateActiveFileContent(val || '')}
                                            theme={theme === 'dark' ? 'vs-dark' : 'light'}
                                            options={{
                                                minimap: { enabled: !performanceMode },
                                                fontSize: 14,
                                                wordWrap: 'on',
                                                automaticLayout: true,
                                                contextmenu: true,
                                                find: {
                                                    addExtraSpaceOnTop: true,
                                                    autoFindInSelection: 'never',
                                                    seedSearchStringFromSelection: 'always'
                                                }
                                            }}
                                        />
                                    </Suspense>
                                );
                            })()
                        )
                    ) : (
                        <div className={styles.emptyState}>
                            <IoFolderOpen size={64} style={{ opacity: 0.1, marginBottom: 20 }} />
                            <div style={{ fontSize: 14, opacity: 0.6 }}>选择文件以开始编辑</div>
                            <div className={styles.shortcutHint}>
                                <span><span className={styles.keyCombo}>Ctrl</span> + <span className={styles.keyCombo}>S</span> 保存</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Custom Context Menu */}
            {contextMenu && (
                <div
                    className={styles.contextMenu}
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className={styles.menuItem} onClick={() => {
                        setModalType('createFile');
                        setTargetNode(contextMenu.node);
                        setModalInput('');
                        setModalOpen(true);
                        setContextMenu(null);
                    }}>
                        <div className={styles.menuLabel}><VscNewFile /> 新建文件</div>
                    </div>
                    <div className={styles.menuItem} onClick={() => {
                        setModalType('createFolder');
                        setTargetNode(contextMenu.node);
                        setModalInput('');
                        setModalOpen(true);
                        setContextMenu(null);
                    }}>
                        <div className={styles.menuLabel}><VscNewFolder /> 新建文件夹</div>
                    </div>
                    <div className={styles.menuSeparator} />
                    <div className={styles.menuItem} onClick={() => {
                        setModalType('rename');
                        setTargetNode(contextMenu.node);
                        setModalInput(contextMenu.node.name);
                        setModalOpen(true);
                        setContextMenu(null);
                    }}>
                        <div className={styles.menuLabel}><VscEdit /> 重命名</div>
                        <span className={styles.menuShortcut}>F2</span>
                    </div>
                    <div className={styles.menuItem} onClick={() => {
                        navigator.clipboard.writeText(contextMenu.node.path);
                        addToast('success', '路径已复制');
                        setContextMenu(null);
                    }}>
                        <div className={styles.menuLabel}><VscCopy /> 复制路径</div>
                    </div>
                    <div className={styles.menuSeparator} />
                    <div className={styles.menuItem} onClick={() => {
                        setTargetNode(contextMenu.node);
                        handleDelete();
                        setContextMenu(null);
                    }}>
                        <div className={styles.menuLabel}><VscTrash /> 删除</div>
                        <span className={styles.menuShortcut}>Delete</span>
                    </div>
                </div>
            )}

            {/* Modal */}
            {modalOpen && (
                <div className={styles.modalOverlay} onClick={() => setModalOpen(false)}>
                    <div className={styles.modalContent} onClick={e => e.stopPropagation()}>
                        <div className={styles.modalInputWrapper}>
                            <input
                                className={styles.modalInput}
                                value={modalInput}
                                onChange={e => setModalInput(e.target.value)}
                                placeholder={
                                    modalType === 'createFile' ? "文件名 (e.g. index.ts)" :
                                        modalType === 'createFolder' ? "文件夹名" :
                                            "新名称"
                                }
                                autoFocus
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        if (modalType === 'rename') handleRename();
                                        else handleCreate();
                                    }
                                    if (e.key === 'Escape') setModalOpen(false);
                                }}
                            />
                        </div>
                        <div className={styles.modalFooter}>
                            <button className={styles.modalBtn} onClick={() => setModalOpen(false)}>取消</button>
                            <button
                                className={`${styles.modalBtn} ${styles.primary}`}
                                onClick={() => {
                                    if (modalType === 'rename') handleRename();
                                    else handleCreate();
                                }}
                            >
                                确定
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
