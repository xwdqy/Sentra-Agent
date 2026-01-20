import React, { useEffect, useMemo, useState } from 'react';
import { IoClose } from 'react-icons/io5';
import type { AppFolder } from '../types/ui';

interface AppFolderProps {
    folder?: AppFolder;
    folders?: AppFolder[];
    initialFolderId?: string;
    anchorRect?: { left: number; top: number; width: number; height: number };
    theme?: 'light' | 'dark';
    onAppClick: (appId: string, onClick: () => void) => void;
    onClose: () => void;
}

export const AppFolderModal: React.FC<AppFolderProps> = ({ folder, folders, initialFolderId, anchorRect: _anchorRect, theme = 'light', onAppClick, onClose }) => {
    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;

    const allFolders = useMemo(() => {
        if (Array.isArray(folders) && folders.length) return folders;
        if (folder) return [folder];
        return [];
    }, [folder, folders]);

    const defaultFolderId = useMemo(() => {
        if (initialFolderId && allFolders.some(f => f.id === initialFolderId)) return initialFolderId;
        if (folder?.id && allFolders.some(f => f.id === folder.id)) return folder.id;
        return allFolders[0]?.id || '';
    }, [allFolders, folder?.id, initialFolderId]);

    const [activeFolderId, setActiveFolderId] = useState<string>(defaultFolderId);

    useEffect(() => {
        setActiveFolderId(defaultFolderId);
    }, [defaultFolderId]);

    const activeFolder = useMemo(() => {
        return allFolders.find(f => f.id === activeFolderId) || allFolders[0];
    }, [activeFolderId, allFolders]);

    const modalWidth = 640;
    const modalMaxH = 520;

    const top = Math.round(viewportH / 2);
    const left = Math.round(viewportW / 2);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onClose]);

    if (!activeFolder) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                onClick={onClose}
                className="sentra-folder-backdrop"
                style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'radial-gradient(circle at center, rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.32))',
                    backdropFilter: 'blur(6px)',
                    WebkitBackdropFilter: 'blur(6px)',
                    zIndex: 999999999,
                    animation: 'fadeIn 0.12s ease-out',
                }}
            />

            {/* Folder Modal - macOS Style */}
            <div
                className="sentra-folder-popover"
                data-theme={theme}
                style={{
                    position: 'fixed',
                    top,
                    left,
                    width: modalWidth,
                    background: 'var(--sentra-folder-bg)',
                    backdropFilter: 'var(--sentra-folder-blur)',
                    WebkitBackdropFilter: 'var(--sentra-folder-blur)',
                    borderRadius: '22px',
                    border: '1px solid var(--sentra-folder-border)',
                    boxShadow: 'var(--sentra-folder-shadow)',
                    zIndex: 1000000000,
                    maxHeight: modalMaxH,
                    overflow: 'hidden',
                    transform: 'translate(-50%, -50%)',
                    animation: 'scaleInCenter 0.14s cubic-bezier(0.2, 0.8, 0.2, 1)',
                }}
            >
                {/* Header */}
                <div
                    className="sentra-folder-header"
                    style={{
                        padding: '12px 14px 10px',
                        borderBottom: '1px solid var(--sentra-folder-divider)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
                        <div
                            className="sentra-folder-mini-icon"
                            style={{
                                width: 28,
                                height: 28,
                                borderRadius: 10,
                                overflow: 'hidden',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'var(--sentra-folder-surface)',
                                border: '1px solid var(--sentra-folder-border)',
                            }}
                        >
                            <div style={{ transform: 'scale(0.36)', transformOrigin: 'center' }}>{activeFolder.icon}</div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                            <div
                                className="sentra-folder-title"
                                style={{
                                    fontSize: '13px',
                                    fontWeight: 700,
                                    color: 'var(--sentra-folder-title)',
                                    letterSpacing: '0.2px',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                }}
                            >
                                {activeFolder.name}
                            </div>
                            <div
                                className="sentra-folder-subtitle"
                                style={{
                                    fontSize: 11,
                                    color: 'var(--sentra-folder-muted)',
                                    marginTop: 2,
                                }}
                            >
                                {activeFolder.apps.length} 项
                            </div>
                        </div>

                        {allFolders.length > 1 ? (
                            <div
                                className="sentra-folder-segmented"
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 2,
                                    padding: 3,
                                    borderRadius: 999,
                                    background: 'var(--sentra-folder-seg-bg)',
                                    border: '1px solid var(--sentra-folder-seg-border)',
                                    flexShrink: 0,
                                }}
                            >
                                {allFolders.map((f) => {
                                    const active = f.id === activeFolderId;
                                    return (
                                        <button
                                            key={f.id}
                                            type="button"
                                            className={`sentra-folder-seg-btn ${active ? 'sentra-folder-seg-btn-active' : ''}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setActiveFolderId(f.id);
                                            }}
                                            style={{
                                                height: 26,
                                                padding: '0 10px',
                                                borderRadius: 999,
                                                border: 'none',
                                                background: active ? 'var(--sentra-folder-seg-active-bg)' : 'transparent',
                                                color: active ? 'var(--sentra-folder-seg-active-fg)' : 'var(--sentra-folder-seg-fg)',
                                                cursor: 'pointer',
                                                fontSize: 12,
                                                fontWeight: 600,
                                                transition: 'background 0.14s ease, color 0.14s ease',
                                                whiteSpace: 'nowrap',
                                            }}
                                            title={f.name}
                                        >
                                            {f.name}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
                    <button
                        onClick={onClose}
                        className="sentra-folder-close"
                        style={{
                            background: 'var(--sentra-folder-close-bg)',
                            border: 'none',
                            borderRadius: '50%',
                            width: 30,
                            height: 30,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                            color: 'var(--sentra-folder-title)',
                        }}
                    >
                        <IoClose size={20} />
                    </button>
                </div>

                {/* Apps Grid */}
                <div
                    className="sentra-folder-grid"
                    style={{
                        padding: '14px',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                        gap: '12px',
                    }}
                >
                    {activeFolder.apps.map((app) => (
                        <div
                            key={app.id}
                            onClick={() => {
                                onAppClick(app.id, app.onClick);
                                onClose();
                            }}
                            className="sentra-folder-item"
                            style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                cursor: 'pointer',
                                padding: '14px 12px',
                                borderRadius: '16px',
                                background: 'var(--sentra-folder-item-bg)',
                                border: '1px solid var(--sentra-folder-item-border)',
                            }}
                        >
                            <div
                                className="sentra-folder-icon"
                                style={{
                                    width: 68,
                                    height: 68,
                                    marginBottom: 10,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    borderRadius: 18,
                                    background: 'var(--sentra-folder-surface)',
                                    border: '1px solid var(--sentra-folder-border)',
                                }}
                            >
                                <div style={{ transform: 'scale(0.90)', transformOrigin: 'center' }}>{app.icon}</div>
                            </div>
                            <div
                                className="sentra-folder-name"
                                style={{
                                    fontSize: 12,
                                    color: 'var(--sentra-folder-text)',
                                    textAlign: 'center',
                                    lineHeight: 1.3,
                                    fontWeight: 500,
                                    maxWidth: 130,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    display: '-webkit-box',
                                    WebkitLineClamp: 2,
                                    WebkitBoxOrient: 'vertical',
                                }}
                            >
                                {app.name}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <style>{`
        .sentra-folder-popover {
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          --sentra-folder-bg: linear-gradient(var(--sentra-accent-tint-12), var(--sentra-accent-tint-12)), var(--sentra-panel-bg-strong);
          --sentra-folder-blur: blur(18px);
          --sentra-folder-border: var(--sentra-border-strong);
          --sentra-folder-divider: var(--sentra-border);
          --sentra-folder-shadow: var(--mac-elev-3);
          --sentra-folder-title: var(--sentra-fg);
          --sentra-folder-text: var(--sentra-fg);
          --sentra-folder-close-bg: rgba(var(--sentra-accent-rgb), 0.10);
          --sentra-folder-muted: var(--sentra-muted-fg);
          --sentra-folder-surface: linear-gradient(var(--sentra-accent-tint-08), var(--sentra-accent-tint-08)), var(--sentra-glass-bg-strong);
          --sentra-folder-item-bg: rgba(var(--sentra-accent-rgb), 0.06);
          --sentra-folder-item-border: rgba(var(--sentra-accent-rgb), 0.10);

          --sentra-folder-seg-bg: rgba(var(--sentra-accent-rgb), 0.10);
          --sentra-folder-seg-border: rgba(var(--sentra-accent-rgb), 0.14);
          --sentra-folder-seg-fg: var(--sentra-muted-fg);
          --sentra-folder-seg-active-bg: rgba(var(--sentra-accent-rgb), 0.18);
          --sentra-folder-seg-active-fg: var(--sentra-fg);
        }

        .sentra-folder-popover[data-theme="dark"] {
          --sentra-folder-bg: linear-gradient(var(--sentra-accent-tint-12), var(--sentra-accent-tint-12)), var(--sentra-panel-bg-strong);
          --sentra-folder-blur: blur(18px);
          --sentra-folder-border: var(--sentra-border-strong);
          --sentra-folder-divider: var(--sentra-border);
          --sentra-folder-shadow: var(--mac-elev-3);
          --sentra-folder-title: var(--sentra-fg);
          --sentra-folder-text: var(--sentra-fg);
          --sentra-folder-close-bg: rgba(var(--sentra-accent-rgb), 0.14);
          --sentra-folder-muted: var(--sentra-muted-fg);
          --sentra-folder-surface: linear-gradient(var(--sentra-accent-tint-12), var(--sentra-accent-tint-12)), var(--sentra-glass-bg);
          --sentra-folder-item-bg: rgba(var(--sentra-accent-rgb), 0.08);
          --sentra-folder-item-border: rgba(var(--sentra-accent-rgb), 0.12);

          --sentra-folder-seg-bg: rgba(var(--sentra-accent-rgb), 0.12);
          --sentra-folder-seg-border: rgba(var(--sentra-accent-rgb), 0.16);
          --sentra-folder-seg-fg: var(--sentra-muted-fg);
          --sentra-folder-seg-active-bg: rgba(var(--sentra-accent-rgb), 0.22);
          --sentra-folder-seg-active-fg: var(--sentra-fg);
        }

        .sentra-folder-close:hover {
          background: rgba(var(--sentra-accent-rgb), 0.18) !important;
        }

        .sentra-folder-seg-btn {
          outline: none;
        }

        .sentra-folder-seg-btn:not(.sentra-folder-seg-btn-active):hover {
          background: rgba(var(--sentra-accent-rgb), 0.14) !important;
          color: var(--sentra-fg) !important;
        }

        .sentra-folder-seg-btn:not(.sentra-folder-seg-btn-active):active {
          background: rgba(var(--sentra-accent-rgb), 0.18) !important;
        }

        .sentra-folder-item {
          transition: background 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease, border-color 0.14s ease;
        }

        .sentra-folder-item:hover {
          background: rgba(var(--sentra-accent-rgb), 0.12) !important;
          border-color: rgba(var(--sentra-accent-rgb), 0.22) !important;
          transform: translateY(-2px);
          box-shadow: 0 18px 38px rgba(15, 23, 42, 0.16);
        }

        .sentra-folder-item:active {
          transform: translateY(-1px);
          box-shadow: 0 10px 22px rgba(15, 23, 42, 0.12);
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes scaleIn {
          from { 
            opacity: 0;
            transform: translateY(-6px) scale(0.98);
          }
          to { 
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        @keyframes scaleInCenter {
          from {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
          }
        }
      `}</style>
        </>
    );
};
