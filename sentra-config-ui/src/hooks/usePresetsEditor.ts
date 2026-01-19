import { useState, useEffect, useCallback, useRef } from 'react';
import { PresetFile } from '../types/config';
import { fetchPresets, fetchPresetFile, savePresetFile, deletePresetFile } from '../services/api';
import { storage } from '../utils/storage';

export interface PresetFolder {
    name: string;
    files: PresetFile[];
}

export interface PresetsEditorState {
    files: PresetFile[];
    folders: PresetFolder[];
    selectedFile: PresetFile | null;
    fileContent: string;
    searchTerm: string;
    loading: boolean;
    saving: boolean;
    loadingFile: boolean;
    expandedFolders: Set<string>;
    setSearchTerm: (term: string) => void;
    selectFile: (file: PresetFile | null) => void;
    saveFile: () => Promise<void>;
    setFileContent: (content: string) => void;
    createFile: (filename: string) => Promise<void>;
    deleteFile: (file: PresetFile) => Promise<void>;
    refreshFiles: () => Promise<void>;
    toggleFolder: (folderName: string) => void;
}

// Helper to group files by folder
function groupFilesByFolder(files: PresetFile[]): PresetFolder[] {
    const folderMap = new Map<string, PresetFile[]>();

    for (const file of files) {
        const folderPath = file.path.includes('/')
            ? file.path.substring(0, file.path.lastIndexOf('/'))
            : '';
        const folderName = folderPath || '根目录';

        if (!folderMap.has(folderName)) {
            folderMap.set(folderName, []);
        }
        folderMap.get(folderName)!.push(file);
    }

    // Convert to array and sort
    const folders = Array.from(folderMap.entries()).map(([name, files]) => ({
        name,
        files: files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    }));

    // Sort folders: root first, then alphabetically
    folders.sort((a, b) => {
        if (a.name === '根目录') return -1;
        if (b.name === '根目录') return 1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });

    return folders;
}

export function usePresetsEditor(
    addToast: (type: 'success' | 'error', title: string, message?: string) => void,
    isAuthenticated: boolean
): PresetsEditorState {
    const [files, setFiles] = useState<PresetFile[]>([]);
    const [folders, setFolders] = useState<PresetFolder[]>([]);
    const [selectedFile, setSelectedFile] = useState<PresetFile | null>(null);
    const [fileContent, setFileContentState] = useState<string>('');
    const fileContentRef = useRef<string>('');
    const fileContentDebounceRef = useRef<number | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [loadingFile, setLoadingFile] = useState(false);
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['根目录']));

    const loadFiles = useCallback(async (silent = false) => {
        const token = storage.getString('sentra_auth_token', { backend: 'session', fallback: '' })
            || storage.getString('sentra_auth_token', { fallback: '' });
        if (!token && !isAuthenticated) {
            console.log('Skipping presets load: not authenticated');
            return;
        }

        try {
            if (!silent) setLoading(true);
            const data = await fetchPresets();
            setFiles(data);
            setFolders(groupFilesByFolder(data));
        } catch (error) {
            console.error('Failed to load presets:', error);
            if (isAuthenticated) {
                addToast('error', '加载失败', '无法获取预设文件列表');
            }
        } finally {
            if (!silent) setLoading(false);
        }
    }, [addToast, isAuthenticated]);

    useEffect(() => {
        if (isAuthenticated) {
            loadFiles();
        }
    }, [loadFiles, isAuthenticated]);

    useEffect(() => {
        return () => {
            if (fileContentDebounceRef.current != null) {
                window.clearTimeout(fileContentDebounceRef.current);
                fileContentDebounceRef.current = null;
            }
        };
    }, []);

    const selectFile = useCallback(async (file: PresetFile | null) => {
        if (!file) {
            setSelectedFile(null);
            fileContentRef.current = '';
            setFileContentState('');
            return;
        }
        if (selectedFile?.path === file.path) return;

        try {
            setLoadingFile(true);
            setSelectedFile(file);
            const data = await fetchPresetFile(file.path);
            fileContentRef.current = data.content;
            setFileContentState(data.content);
        } catch (error) {
            console.error('Failed to load file content:', error);
            addToast('error', '加载失败', `无法读取文件 ${file.name}`);
            setSelectedFile(null);
        } finally {
            setLoadingFile(false);
        }
    }, [selectedFile, addToast]);

    const saveFile = useCallback(async () => {
        if (!selectedFile) return;

        try {
            setSaving(true);
            await savePresetFile(selectedFile.path, fileContentRef.current);
            addToast('success', '保存成功', `文件 ${selectedFile.name} 已保存`);
            loadFiles(true);
        } catch (error) {
            console.error('Failed to save file:', error);
            addToast('error', '保存失败', '无法保存文件更改');
        } finally {
            setSaving(false);
        }
    }, [selectedFile, addToast, loadFiles]);

    const setFileContent = useCallback((content: string) => {
        fileContentRef.current = content;
        if (fileContentDebounceRef.current != null) {
            window.clearTimeout(fileContentDebounceRef.current);
        }
        fileContentDebounceRef.current = window.setTimeout(() => {
            fileContentDebounceRef.current = null;
            setFileContentState(content);
        }, 120);
    }, []);

    const createFile = useCallback(async (filename: string) => {
        try {
            setSaving(true);
            if (files.some(f => f.path === filename || f.name === filename)) {
                addToast('error', '创建失败', '文件已存在');
                return;
            }

            await savePresetFile(filename, '');
            addToast('success', '创建成功', `文件 ${filename} 已创建`);
            await loadFiles(true);

            const newFile: PresetFile = {
                name: filename.split('/').pop() || filename,
                path: filename,
                size: 0,
                modified: new Date().toISOString()
            };
            await selectFile(newFile);

        } catch (error) {
            console.error('Failed to create file:', error);
            addToast('error', '创建失败', '无法创建新文件');
        } finally {
            setSaving(false);
        }
    }, [files, addToast, loadFiles, selectFile]);

    const deleteFile = useCallback(async (file: PresetFile) => {
        try {
            setSaving(true);
            await deletePresetFile(file.path);
            addToast('success', '删除成功', `文件 ${file.name} 已删除`);

            if (selectedFile?.path === file.path) {
                setSelectedFile(null);
                setFileContent('');
            }

            await loadFiles(true);
        } catch (error) {
            console.error('Failed to delete file:', error);
            addToast('error', '删除失败', '无法删除文件');
        } finally {
            setSaving(false);
        }
    }, [selectedFile, addToast, loadFiles]);

    const toggleFolder = useCallback((folderName: string) => {
        setExpandedFolders(prev => {
            const next = new Set(prev);
            if (next.has(folderName)) {
                next.delete(folderName);
            } else {
                next.add(folderName);
            }
            return next;
        });
    }, []);

    return {
        files,
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
        refreshFiles: () => loadFiles(false),
        toggleFolder
    };
}

