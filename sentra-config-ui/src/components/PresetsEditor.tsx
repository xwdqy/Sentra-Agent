import React, { useState } from 'react';
import styles from './PresetsEditor.module.css';
import { IoSearch, IoDocumentText, IoSave, IoReload, IoInformationCircle, IoAdd, IoTrash, IoChevronDown, IoChevronForward, IoFolder, IoFolderOpen, IoCloudDownload } from 'react-icons/io5';
import Editor from '@monaco-editor/react';
import { SafeInput } from './SafeInput';
import { PresetsEditorState } from '../hooks/usePresetsEditor';

interface PresetsEditorProps {
    onClose: () => void;
    theme: 'light' | 'dark';
    addToast: (type: 'success' | 'error', title: string, message?: string) => void;
    state: PresetsEditorState;
    onOpenPresetImporter?: () => void;
}

export const PresetsEditor: React.FC<PresetsEditorProps> = ({ theme, state, onOpenPresetImporter }) => {
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
                        <IoSearch className={styles.searchIcon} />
                        <SafeInput
                            type="text"
                            placeholder="搜索文件..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className={styles.searchInput}
                        />
                        <button
                            className={styles.actionBtn}
                            style={{ marginLeft: 8, padding: '6px 8px' }}
                            onClick={() => setShowNewFileModal(true)}
                            title="新建文件"
                        >
                            <IoAdd size={16} />
                        </button>
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
                                            <IoChevronDown size={14} className={styles.folderChevron} />
                                            <IoFolderOpen size={16} className={styles.folderIcon} />
                                        </>
                                    ) : (
                                        <>
                                            <IoChevronForward size={14} className={styles.folderChevron} />
                                            <IoFolder size={16} className={styles.folderIcon} />
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
                                                <IoDocumentText className={styles.fileIcon} />
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
                                <button
                                    className={styles.actionBtn}
                                    onClick={() => onOpenPresetImporter && onOpenPresetImporter()}
                                    title="打开预设导入"
                                >
                                    <IoCloudDownload size={14} />
                                    导入
                                </button>
                                <button
                                    className={styles.actionBtn}
                                    onClick={() => selectFile(selectedFile)}
                                    title="重新加载"
                                >
                                    <IoReload size={14} />
                                </button>
                                <button
                                    className={`${styles.actionBtn} ${styles.danger}`}
                                    onClick={() => setShowDeleteModal(true)}
                                    title="删除文件"
                                >
                                    <IoTrash size={14} />
                                </button>
                                <button
                                    className={`${styles.actionBtn} ${styles.primary}`}
                                    onClick={saveFile}
                                    disabled={saving}
                                >
                                    <IoSave size={14} />
                                    {saving ? '保存中...' : '保存'}
                                </button>
                            </div>
                        </div>
                        {loadingFile ? (
                            <div className={styles.emptyState}>读取文件中...</div>
                        ) : (
                            <div className={styles.editorSplit}>
                                <div className={styles.editorMain}>
                                    <Editor
                                        height="100%"
                                        language={getLanguage(selectedFile.name)}
                                        value={fileContent}
                                        onChange={(value) => setFileContent(value || '')}
                                        theme={theme === 'dark' ? 'vs-dark' : 'light'}
                                        options={{
                                            minimap: { enabled: true },
                                            fontSize: 13,
                                            fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
                                            scrollBeyondLastLine: false,
                                            automaticLayout: true,
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </>
                ) : (
                    <div className={styles.emptyState}>
                        <IoInformationCircle size={48} style={{ marginBottom: 16, opacity: 0.5 }} />
                        <div>选择一个文件开始编辑</div>
                    </div>
                )}
            </div>

            {showNewFileModal && (
                <div className={styles.modalOverlay}>
                    <div className={styles.modalContent}>
                        <div className={styles.modalTitle}>新建文件</div>
                        <input
                            type="text"
                            className={styles.modalInput}
                            placeholder="文件名 (例如: new_preset.json)"
                            value={newFileName}
                            onChange={(e) => setNewFileName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
                            autoFocus
                        />
                        <div className={styles.modalActions}>
                            <button
                                className={styles.cancelBtn}
                                onClick={() => setShowNewFileModal(false)}
                            >
                                取消
                            </button>
                            <button
                                className={styles.confirmBtn}
                                onClick={handleCreateFile}
                            >
                                创建
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showDeleteModal && selectedFile && (
                <div className={styles.modalOverlay}>
                    <div className={styles.modalContent}>
                        <div className={styles.modalTitle}>确认删除</div>
                        <div style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>
                            确定要删除文件 <strong>{selectedFile.name}</strong> 吗？此操作无法撤销。
                        </div>
                        <div className={styles.modalActions}>
                            <button
                                className={styles.cancelBtn}
                                onClick={() => setShowDeleteModal(false)}
                            >
                                取消
                            </button>
                            <button
                                className={styles.deleteBtn}
                                onClick={handleDeleteFile}
                            >
                                删除
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
