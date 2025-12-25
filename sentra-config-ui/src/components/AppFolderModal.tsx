import React from 'react';
import { IoClose } from 'react-icons/io5';
import type { AppFolder } from '../types/ui';

interface AppFolderProps {
    folder: AppFolder;
    anchorRect?: { left: number; top: number; width: number; height: number };
    theme?: 'light' | 'dark';
    onAppClick: (appId: string, onClick: () => void) => void;
    onClose: () => void;
}

export const AppFolderModal: React.FC<AppFolderProps> = ({ folder, anchorRect, theme = 'light', onAppClick, onClose }) => {
    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;

    const anchorX = anchorRect ? anchorRect.left + anchorRect.width / 2 : viewportW / 2;
    const anchorY = anchorRect ? anchorRect.top + anchorRect.height : viewportH / 2;

    const modalWidth = 520;
    const modalMaxH = 420;

    const left = Math.min(Math.max(18, anchorX - modalWidth / 2), Math.max(18, viewportW - modalWidth - 18));
    const top = Math.min(Math.max(60, anchorY + 12), Math.max(60, viewportH - modalMaxH - 24));
    const arrowLeft = Math.min(Math.max(24, anchorX - left - 10), modalWidth - 24);

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
                    background: 'rgba(0, 0, 0, 0.18)',
                    zIndex: 10000,
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
                    borderRadius: '20px',
                    border: '1px solid var(--sentra-folder-border)',
                    boxShadow: 'var(--sentra-folder-shadow)',
                    zIndex: 10001,
                    maxHeight: modalMaxH,
                    overflow: 'hidden',
                    animation: 'scaleIn 0.14s cubic-bezier(0.2, 0.8, 0.2, 1)',
                }}
            >
                <div
                    className="sentra-folder-arrow"
                    style={{
                        position: 'absolute',
                        top: -8,
                        left: arrowLeft,
                        width: 16,
                        height: 16,
                        transform: 'rotate(45deg)',
                        background: 'var(--sentra-folder-arrow-bg)',
                        borderLeft: '1px solid var(--sentra-folder-border)',
                        borderTop: '1px solid var(--sentra-folder-border)',
                    }}
                />

                {/* Header */}
                <div
                    className="sentra-folder-header"
                    style={{
                        padding: '12px 14px 10px',
                        borderBottom: '1px solid var(--sentra-folder-divider)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                    }}
                >
                    <div
                        className="sentra-folder-title"
                        style={{
                            fontSize: '13px',
                            fontWeight: 600,
                            color: 'var(--sentra-folder-title)',
                            letterSpacing: '0.2px',
                        }}
                    >
                        {folder.name}
                    </div>
                    <button
                        onClick={onClose}
                        className="sentra-folder-close"
                        style={{
                            background: 'var(--sentra-folder-close-bg)',
                            border: 'none',
                            borderRadius: '50%',
                            width: 32,
                            height: 32,
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
                        padding: '12px 12px 14px',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                        gap: '12px',
                    }}
                >
                    {folder.apps.map((app) => (
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
                                padding: '10px 8px',
                                borderRadius: '16px',
                                background: 'transparent',
                                border: '1px solid transparent',
                            }}
                        >
                            <div className="sentra-folder-icon" style={{ width: 56, height: 56, marginBottom: 8 }}>
                                {app.icon}
                            </div>
                            <div
                                className="sentra-folder-name"
                                style={{
                                    fontSize: 12,
                                    color: 'var(--sentra-folder-text)',
                                    textAlign: 'center',
                                    lineHeight: 1.3,
                                    fontWeight: 500,
                                    maxWidth: 90,
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
          --sentra-folder-bg: linear-gradient(180deg, rgba(252, 252, 253, 0.94), rgba(245, 246, 250, 0.92));
          --sentra-folder-blur: blur(14px);
          --sentra-folder-border: rgba(15, 23, 42, 0.10);
          --sentra-folder-divider: rgba(15, 23, 42, 0.08);
          --sentra-folder-shadow: 0 20px 60px rgba(0, 0, 0, 0.22), 0 2px 0 rgba(255, 255, 255, 0.65) inset;
          --sentra-folder-arrow-bg: rgba(252, 252, 253, 0.94);
          --sentra-folder-title: rgba(15, 23, 42, 0.92);
          --sentra-folder-text: rgba(15, 23, 42, 0.90);
          --sentra-folder-close-bg: rgba(15, 23, 42, 0.06);
        }

        .sentra-folder-popover[data-theme="dark"] {
          --sentra-folder-bg: linear-gradient(180deg, rgba(32, 33, 36, 0.72), rgba(18, 18, 20, 0.68));
          --sentra-folder-blur: blur(18px);
          --sentra-folder-border: rgba(255, 255, 255, 0.14);
          --sentra-folder-divider: rgba(255, 255, 255, 0.12);
          --sentra-folder-shadow: 0 26px 70px rgba(0, 0, 0, 0.55);
          --sentra-folder-arrow-bg: rgba(32, 33, 36, 0.72);
          --sentra-folder-title: rgba(255, 255, 255, 0.92);
          --sentra-folder-text: rgba(255, 255, 255, 0.86);
          --sentra-folder-close-bg: rgba(255, 255, 255, 0.10);
        }

        .sentra-folder-close:hover {
          background: rgba(255, 255, 255, 0.14) !important;
        }

        .sentra-folder-item {
          transition: background 0.12s ease, transform 0.12s ease, box-shadow 0.12s ease, border-color 0.12s ease;
        }

        .sentra-folder-item:hover {
          background: rgba(255, 255, 255, 0.14) !important;
          border-color: rgba(255, 255, 255, 0.18) !important;
          transform: translateY(-1px) scale(1.01);
          box-shadow: 0 10px 22px rgba(0, 0, 0, 0.10);
        }

        .sentra-folder-item:active {
          transform: translateY(0px);
          box-shadow: none;
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
      `}</style>
        </>
    );
};
