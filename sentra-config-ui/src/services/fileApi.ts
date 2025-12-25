import { getAuthHeaders } from './api';

const API_BASE = '/api/files';

export interface FileNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size: number;
    modified: string;
    children?: FileNode[]; // For frontend tree structure
}

export interface FileContent {
    content: string;
    isBinary: boolean;
}

export interface GrepMatch {
    path: string;
    line: number;
    text: string;
}

export interface SymbolMatch {
    path: string;
    line: number;
    kind: string;
    symbol: string;
}

export async function fetchFileTree(path: string = ''): Promise<FileNode[]> {
    const headers = getAuthHeaders();
    const res = await fetch(`${API_BASE}/tree?path=${encodeURIComponent(path)}`, { headers });
    if (!res.ok) throw new Error('Failed to fetch file tree');
    return res.json();
}

export async function fetchFileContent(path: string): Promise<FileContent> {
    const headers = getAuthHeaders();
    const res = await fetch(`${API_BASE}/content?path=${encodeURIComponent(path)}`, { headers });
    if (!res.ok) throw new Error('Failed to fetch file content');
    return res.json();
}

export async function saveFileContent(path: string, content: string): Promise<void> {
    const headers = getAuthHeaders();
    const res = await fetch(`${API_BASE}/content`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path, content })
    });
    if (!res.ok) throw new Error('Failed to save file');
}

export async function createFile(path: string, type: 'file' | 'directory'): Promise<void> {
    const headers = getAuthHeaders();
    const res = await fetch(`${API_BASE}/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path, type })
    });
    if (!res.ok) throw new Error('Failed to create item');
}

export async function grepFiles(q: string, opts?: { path?: string; maxResults?: number; caseSensitive?: boolean }): Promise<GrepMatch[]> {
    const headers = getAuthHeaders();
    const params = new URLSearchParams();
    params.set('q', q);
    if (opts?.path) params.set('path', opts.path);
    if (opts?.maxResults != null) params.set('maxResults', String(opts.maxResults));
    if (opts?.caseSensitive) params.set('caseSensitive', 'true');
    const res = await fetch(`${API_BASE}/grep?${params.toString()}`, { headers });
    if (!res.ok) throw new Error('Failed to grep files');
    const data = await res.json();
    return (data?.results || []) as GrepMatch[];
}

export async function searchSymbols(q?: string, opts?: { path?: string; maxResults?: number }): Promise<SymbolMatch[]> {
    const headers = getAuthHeaders();
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (opts?.path) params.set('path', opts.path);
    if (opts?.maxResults != null) params.set('maxResults', String(opts.maxResults));
    const res = await fetch(`${API_BASE}/symbols?${params.toString()}`, { headers });
    if (!res.ok) throw new Error('Failed to search symbols');
    const data = await res.json();
    return (data?.results || []) as SymbolMatch[];
}

export async function renameFile(oldPath: string, newPath: string): Promise<void> {
    const headers = getAuthHeaders();
    const res = await fetch(`${API_BASE}/rename`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ oldPath, newPath })
    });
    if (!res.ok) throw new Error('Failed to rename item');
}

export async function deleteFile(path: string): Promise<void> {
    const headers = getAuthHeaders();
    // For DELETE requests with no body, we should NOT set Content-Type: application/json
    // getAuthHeaders sets it by default. We need to override or create a new object.
    const { 'Content-Type': _, ...deleteHeaders } = headers;

    const res = await fetch(`${API_BASE}/delete?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
        headers: { ...deleteHeaders, 'x-auth-token': headers['x-auth-token'] }
    });
    if (!res.ok) throw new Error('Failed to delete item');
}
