import React, { useState } from 'react';
import { IoChevronBack, IoAdd, IoSave, IoSearch, IoDocumentText, IoTrash, IoChevronDown, IoChevronForward, IoFolder, IoFolderOpen } from 'react-icons/io5';
import Editor from '@monaco-editor/react';
import { PresetsEditorState } from '../hooks/usePresetsEditor';
import '../utils/monacoSetup';


interface IOSPresetsEditorProps {
    onClose: () => void;
    addToast: (type: 'success' | 'error', title: string, message?: string) => void;
    state: PresetsEditorState;
}

export const IOSPresetsEditor: React.FC<IOSPresetsEditorProps> = ({ onClose, state }) => {
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

    const [showCreateModal, setShowCreateModal] = useState(false);
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

    const handleCreate = async () => {
        if (!newFileName) return;
        await createFile(newFileName);
        setShowCreateModal(false);
        setNewFileName('');
    };

    const handleDelete = async () => {
        if (!selectedFile) return;
        await deleteFile(selectedFile);
        setShowDeleteModal(false);
    };

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
                <div className="ios-back-btn" onClick={() => {
                    if (selectedFile) {
                        selectFile(null as any);
                    } else {
                        onClose();
                    }
                }} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: '#0a84ff', fontSize: '17px' }}>
                    <IoChevronBack size={24} /> {selectedFile ? '返回' : '主页'}
                </div>
                <div style={{ fontWeight: 600, fontSize: '17px' }}>
                    {selectedFile ? selectedFile.name : '预设撰写'}
                </div>
                <div style={{ width: 60, display: 'flex', justifyContent: 'flex-end' }}>
                    {selectedFile ? (
                        <div onClick={saveFile} style={{ color: '#0a84ff', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                            {saving ? '...' : <IoSave size={22} />}
                        </div>
                    ) : (
                        <div onClick={() => setShowCreateModal(true)} style={{ color: '#0a84ff', cursor: 'pointer' }}>
                            <IoAdd size={28} />
                        </div>
                    )}
                </div>
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                {selectedFile ? (
                    // Editor View
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        {loadingFile ? (
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
                                加载中...
                            </div>
                        ) : (
                            <>
                                <Editor
                                    height="100%"
                                    defaultLanguage="markdown"
                                    theme="vs-dark"
                                    value={fileContent}
                                    onChange={(val) => setFileContent(val || '')}
                                    options={{
                                        minimap: { enabled: false },
                                        fontSize: 14,
                                        wordWrap: 'on',
                                        lineNumbers: 'off',
                                        folding: false,
                                        padding: { top: 10 }
                                    }}
                                />
                                {/* Toolbar for file actions */}
                                <div style={{
                                    height: '44px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '0 20px',
                                    background: '#1c1c1e',
                                    borderTop: '1px solid #333'
                                }}>
                                    <div onClick={() => selectFile(null as any)} style={{ color: '#0a84ff', cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
                                        <IoChevronBack /> 返回列表
                                    </div>
                                    <div onClick={() => setShowDeleteModal(true)} style={{ color: '#ff453a', cursor: 'pointer' }}>
                                        <IoTrash size={20} />
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                ) : (
                    // File List View
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        {/* Search Bar */}
                        <div style={{ padding: '10px 16px', background: '#1c1c1e' }}>
                            <div style={{
                                background: '#2c2c2e',
                                borderRadius: '10px',
                                height: '36px',
                                display: 'flex',
                                alignItems: 'center',
                                padding: '0 10px'
                            }}>
                                <IoSearch color="#8e8e93" size={18} />
                                <input
                                    type="text"
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    placeholder="搜索预设..."
                                    style={{
                                        background: 'transparent',
                                        border: 'none',
                                        color: '#fff',
                                        marginLeft: '8px',
                                        flex: 1,
                                        outline: 'none',
                                        fontSize: '16px'
                                    }}
                                />
                            </div>
                        </div>

                        {/* List with folders */}
                        <div style={{ flex: 1, overflowY: 'auto' }}>
                            {loading ? (
                                <div style={{ padding: 20, textAlign: 'center', color: '#666' }}>加载中...</div>
                            ) : filteredFolders.length === 0 ? (
                                <div style={{ padding: 40, textAlign: 'center', color: '#666' }}>
                                    {searchTerm ? '未找到匹配文件' : '暂无预设文件'}
                                </div>
                            ) : (
                                filteredFolders.map(folder => (
                                    <div key={folder.name}>
                                        {/* Folder Header */}
                                        <div
                                            onClick={() => toggleFolder(folder.name)}
                                            style={{
                                                padding: '12px 16px',
                                                background: '#1c1c1e',
                                                borderBottom: '1px solid #2c2c2e',
                                                display: 'flex',
                                                alignItems: 'center',
                                                cursor: 'pointer'
                                            }}
                                        >
                                            {expandedFolders.has(folder.name) ? (
                                                <>
                                                    <IoChevronDown color="#8e8e93" size={16} style={{ marginRight: 8 }} />
                                                    <IoFolderOpen color="#ffd700" size={20} style={{ marginRight: 10 }} />
                                                </>
                                            ) : (
                                                <>
                                                    <IoChevronForward color="#8e8e93" size={16} style={{ marginRight: 8 }} />
                                                    <IoFolder color="#ffd700" size={20} style={{ marginRight: 10 }} />
                                                </>
                                            )}
                                            <span style={{ flex: 1, color: '#fff', fontSize: '15px', fontWeight: 500 }}>
                                                {folder.name}
                                            </span>
                                            <span style={{ color: '#666', fontSize: '13px' }}>
                                                ({folder.files.length})
                                            </span>
                                        </div>
                                        {/* Folder Files */}
                                        {expandedFolders.has(folder.name) && folder.files.map(file => (
                                            <div
                                                key={file.path}
                                                onClick={() => selectFile(file)}
                                                style={{
                                                    padding: '12px 16px 12px 52px',
                                                    borderBottom: '1px solid #2c2c2e',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    cursor: 'pointer',
                                                    background: '#000'
                                                }}
                                            >
                                                <IoDocumentText color="#0a84ff" size={22} style={{ marginRight: 12 }} />
                                                <div style={{ flex: 1 }}>
                                                    <div style={{ color: '#fff', fontSize: '15px', marginBottom: 2 }}>{file.name}</div>
                                                    <div style={{ color: '#666', fontSize: '11px' }}>
                                                        {new Date(file.modified).toLocaleString()} · {(file.size / 1024).toFixed(1)} KB
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Create Modal */}
            {showCreateModal && (
                <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    zIndex: 100
                }} onClick={() => setShowCreateModal(false)}>
                    <div style={{
                        width: '80%', background: '#1c1c1e', borderRadius: '14px', padding: '20px',
                        textAlign: 'center'
                    }} onClick={e => e.stopPropagation()}>
                        <h3 style={{ margin: '0 0 16px 0', color: '#fff' }}>新建预设</h3>
                        <input
                            autoFocus
                            value={newFileName}
                            onChange={e => setNewFileName(e.target.value)}
                            placeholder="文件名 (例如: my-preset)"
                            style={{
                                width: '100%', padding: '10px', borderRadius: '8px', border: 'none',
                                background: '#2c2c2e', color: '#fff', marginBottom: '20px', outline: 'none'
                            }}
                        />
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <button onClick={() => setShowCreateModal(false)} style={{
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

            {/* Delete Modal */}
            {showDeleteModal && (
                <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    zIndex: 100
                }} onClick={() => setShowDeleteModal(false)}>
                    <div style={{
                        width: '80%', background: '#1c1c1e', borderRadius: '14px', padding: '20px',
                        textAlign: 'center'
                    }} onClick={e => e.stopPropagation()}>
                        <h3 style={{ margin: '0 0 10px 0', color: '#fff' }}>确认删除?</h3>
                        <p style={{ color: '#888', marginBottom: '20px' }}>此操作无法撤销。</p>
                        <div style={{ display: 'flex', gap: '10px' }}>
                            <button onClick={() => setShowDeleteModal(false)} style={{
                                flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
                                background: '#2c2c2e', color: '#fff', fontSize: '16px'
                            }}>取消</button>
                            <button onClick={handleDelete} style={{
                                flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
                                background: '#ff453a', color: '#fff', fontSize: '16px', fontWeight: 'bold'
                            }}>删除</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
