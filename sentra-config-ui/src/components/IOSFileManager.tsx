import React, { useState, useEffect, useCallback } from 'react';
import {
    IoImage, IoChevronForward, IoChevronBack,
    IoFolder, IoSettings, IoLogoMarkdown, IoAdd, IoSave, IoTrash, IoDocumentText
} from 'react-icons/io5';
import {
    SiPython, SiJavascript, SiTypescript, SiHtml5, SiCss3,
    SiJson, SiGo, SiReact, SiGnubash, SiVite
} from 'react-icons/si';

import Editor from '@monaco-editor/react';
import '../utils/monacoSetup';
import {
    fetchFileTree, fetchFileContent, saveFileContent,
    createFile, deleteFile,
    FileNode
} from '../services/fileApi';
import { ToastMessage } from './Toast';

interface IOSFileManagerProps {
    onClose: () => void;
    addToast: (type: ToastMessage['type'], title: string, message?: string) => void;
    theme: 'light' | 'dark';
}

// Icon Helper (Copied from FileManager)
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

interface OpenFile {
    node: FileNode;
    content: string;
    originalContent: string;
    isBinary: boolean;
    isDirty: boolean;
    preview: boolean;
}

export const IOSFileManager: React.FC<IOSFileManagerProps> = ({ onClose, addToast }) => {
    const [fileTree, setFileTree] = useState<FileNode[]>([]);
    const [currentPath, setCurrentPath] = useState<string>(''); // Root path is empty string or specific root
    const [activeFile, setActiveFile] = useState<OpenFile | null>(null);
    const [viewMode, setViewMode] = useState<'list' | 'editor'>('list');

    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    // Modal State
    const [modalOpen, setModalOpen] = useState(false);
    const [modalType, setModalType] = useState<'createFile' | 'createFolder' | 'rename'>('createFile');
    const [modalInput, setModalInput] = useState('');

    // Load Tree
    const loadTree = useCallback(async () => {
        try {
            setLoading(true);
            const tree = await fetchFileTree();
            // Reconstruct tree
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
                            // If parent not found (maybe root is not empty), push to root
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
        } finally {
            setLoading(false);
        }
    }, [addToast]);

    useEffect(() => {
        loadTree();
    }, [loadTree]);

    // Get current directory nodes
    const getCurrentNodes = () => {
        if (!currentPath) return fileTree;

        // Find the node corresponding to currentPath
        const findNode = (nodes: FileNode[], path: string): FileNode | null => {
            for (const node of nodes) {
                if (node.path === path) return node;
                if (node.children) {
                    const found = findNode(node.children, path);
                    if (found) return found;
                }
            }
            return null;
        };

        const currentNode = findNode(fileTree, currentPath);
        return currentNode && currentNode.children ? currentNode.children : [];
    };

    const handleNodeClick = async (node: FileNode) => {
        if (node.type === 'directory') {
            setCurrentPath(node.path);
        } else {
            // Open File
            setLoading(true);
            try {
                const data = await fetchFileContent(node.path);
                setActiveFile({
                    node,
                    content: data.content,
                    originalContent: data.content,
                    isBinary: data.isBinary,
                    isDirty: false,
                    preview: node.name.endsWith('.md') // Default preview for md
                });
                setViewMode('editor');
            } catch (e) {
                addToast('error', '读取文件失败');
            } finally {
                setLoading(false);
            }
        }
    };

    const handleBack = () => {
        if (viewMode === 'editor') {
            if (activeFile?.isDirty) {
                if (!confirm('文件有未保存的修改，确定要离开吗？')) return;
            }
            setActiveFile(null);
            setViewMode('list');
        } else {
            // Go up one level
            if (!currentPath) {
                onClose(); // Close app if at root
                return;
            }
            const parts = currentPath.split('/');
            parts.pop();
            setCurrentPath(parts.join('/'));
        }
    };

    const handleSave = async () => {
        if (!activeFile) return;
        setSaving(true);
        try {
            await saveFileContent(activeFile.node.path, activeFile.content);
            setActiveFile(prev => prev ? ({ ...prev, originalContent: prev.content, isDirty: false }) : null);
            addToast('success', '保存成功');
        } catch (e) {
            addToast('error', '保存失败');
        } finally {
            setSaving(false);
        }
    };

    const handleCreate = async () => {
        if (!modalInput) return;
        const parentPath = currentPath;
        const newPath = parentPath ? `${parentPath}/${modalInput}` : modalInput;
        const type = modalType === 'createFolder' ? 'directory' : 'file';

        try {
            await createFile(newPath, type);
            addToast('success', '创建成功');
            setModalOpen(false);
            setModalInput('');
            loadTree();
        } catch (e) {
            addToast('error', '创建失败');
        }
    };

    const handleDelete = async (node: FileNode) => {
        if (!confirm(`确定要删除 ${node.name} 吗？`)) return;
        try {
            await deleteFile(node.path);
            addToast('success', '删除成功');
            loadTree();
        } catch (e) {
            addToast('error', '删除失败');
        }
    };

    // Render
    const currentNodes = getCurrentNodes();
    // Sort: Folders first, then files
    currentNodes.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'directory' ? -1 : 1;
    });

    return (
        <div className="ios-app-window" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#000' }}>
            {/* Header */}
            <div className="ios-app-header" style={{
                height: '44px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 16px',
                background: 'rgba(28, 28, 30, 0.95)',
                backdropFilter: 'blur(10px)',
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#fff',
                zIndex: 10
            }}>
                <div className="ios-back-btn" onClick={handleBack} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: '#0a84ff', fontSize: '17px' }}>
                    <IoChevronBack size={24} /> {viewMode === 'editor' ? '返回' : (currentPath ? '上一级' : '主页')}
                </div>
                <div style={{ fontWeight: 600, fontSize: '17px', maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {viewMode === 'editor' ? activeFile?.node.name : (currentPath ? currentPath.split('/').pop() : '文件管理')}
                </div>
                <div style={{ width: 60, display: 'flex', justifyContent: 'flex-end', gap: 16 }}>
                    {viewMode === 'editor' ? (
                        <div onClick={handleSave} style={{ color: '#0a84ff', cursor: 'pointer' }}>
                            {saving ? '...' : <IoSave size={22} />}
                        </div>
                    ) : (
                        <div onClick={() => {
                            setModalType('createFile');
                            setModalOpen(true);
                        }} style={{ color: '#0a84ff', cursor: 'pointer' }}>
                            <IoAdd size={28} />
                        </div>
                    )}
                </div>
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative', background: '#000' }}>
                {viewMode === 'list' ? (
                    <div style={{ height: '100%', overflowY: 'auto' }}>
                        {loading && !fileTree.length ? (
                            <div style={{ padding: 20, textAlign: 'center', color: '#666' }}>加载中...</div>
                        ) : (
                            currentNodes.map(node => (
                                <div
                                    key={node.path}
                                    style={{
                                        padding: '12px 16px',
                                        borderBottom: '1px solid #2c2c2e',
                                        display: 'flex',
                                        alignItems: 'center',
                                        cursor: 'pointer',
                                        background: '#1c1c1e'
                                    }}
                                    onClick={() => handleNodeClick(node)}
                                >
                                    <span style={{ marginRight: 12, display: 'flex', alignItems: 'center', fontSize: 24 }}>
                                        {node.type === 'directory' ? <IoFolder style={{ color: '#dcb67a' }} /> : getFileIcon(node.name)}
                                    </span>
                                    <div style={{ flex: 1, color: '#fff', fontSize: '16px' }}>
                                        {node.name}
                                    </div>
                                    {node.type === 'directory' && <IoChevronForward color="#666" />}

                                    {/* Simple Delete Action (Long press or right side button could be better, but for now simple icon) */}
                                    <div onClick={(e) => {
                                        e.stopPropagation();
                                        handleDelete(node);
                                    }} style={{ padding: 8, color: '#ff453a', marginLeft: 8 }}>
                                        <IoTrash size={18} />
                                    </div>
                                </div>
                            ))
                        )}
                        {currentNodes.length === 0 && !loading && (
                            <div style={{ padding: 40, textAlign: 'center', color: '#666' }}>空文件夹</div>
                        )}
                    </div>
                ) : (
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        {activeFile && (
                            <>
                                {activeFile.isBinary ? (
                                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#111' }}>
                                        <img src={activeFile.content} alt={activeFile.node.name} style={{ maxWidth: '100%', maxHeight: '100%' }} />
                                    </div>
                                ) : (
                                    <Editor
                                        height="100%"
                                        path={activeFile.node.path}
                                        defaultLanguage={
                                            activeFile.node.name.endsWith('.json') ? 'json' :
                                                activeFile.node.name.endsWith('.ts') ? 'typescript' :
                                                    activeFile.node.name.endsWith('.tsx') ? 'typescript' :
                                                        activeFile.node.name.endsWith('.js') ? 'javascript' :
                                                            activeFile.node.name.endsWith('.css') ? 'css' :
                                                                activeFile.node.name.endsWith('.html') ? 'html' :
                                                                    activeFile.node.name.endsWith('.py') ? 'python' :
                                                                        activeFile.node.name.endsWith('.md') ? 'markdown' :
                                                                            'plaintext'
                                        }
                                        value={activeFile.content}
                                        onChange={(val) => setActiveFile(prev => prev ? ({ ...prev, content: val || '', isDirty: val !== prev.originalContent }) : null)}
                                        theme="vs-dark"
                                        options={{
                                            minimap: { enabled: false },
                                            fontSize: 14,
                                            wordWrap: 'on',
                                            lineNumbers: 'on',
                                            folding: false,
                                            padding: { top: 10 }
                                        }}
                                    />
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* Create Modal */}
            {modalOpen && (
                <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    zIndex: 100
                }} onClick={() => setModalOpen(false)}>
                    <div style={{
                        width: '80%', background: '#1c1c1e', borderRadius: '14px', padding: '20px',
                        textAlign: 'center'
                    }} onClick={e => e.stopPropagation()}>
                        <h3 style={{ margin: '0 0 16px 0', color: '#fff' }}>
                            {modalType === 'createFile' ? '新建文件' : '新建文件夹'}
                        </h3>
                        <input
                            autoFocus
                            value={modalInput}
                            onChange={e => setModalInput(e.target.value)}
                            placeholder={modalType === 'createFile' ? "文件名" : "文件夹名"}
                            style={{
                                width: '100%', padding: '10px', borderRadius: '8px', border: 'none',
                                background: '#2c2c2e', color: '#fff', marginBottom: '20px', outline: 'none'
                            }}
                        />
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <button onClick={() => setModalOpen(false)} style={{
                                flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
                                background: '#2c2c2e', color: '#fff', fontSize: '16px'
                            }}>取消</button>
                            <button onClick={handleCreate} style={{
                                flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
                                background: '#0a84ff', color: '#fff', fontSize: '16px', fontWeight: 'bold'
                            }}>创建</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
