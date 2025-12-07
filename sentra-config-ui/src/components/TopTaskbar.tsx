import React from 'react';
import { IoClose, IoTerminal } from 'react-icons/io5';
import { motion, AnimatePresence } from 'framer-motion';
import type { DeskWindow, TerminalWin } from '../types/ui';
import { getDisplayName, getIconForType } from '../utils/icons';

interface TopTaskbarProps {
    openWindows: DeskWindow[];
    terminalWindows: TerminalWin[];
    activeWinId: string | null;
    activeTerminalId: string | null;
    onActivateWindow: (id: string) => void;
    onActivateTerminal: (id: string) => void;
    onCloseWindow: (id: string) => void;
    onCloseTerminal: (id: string) => void;
}

export const TopTaskbar: React.FC<TopTaskbarProps> = ({
    openWindows,
    terminalWindows,
    activeWinId,
    activeTerminalId,
    onActivateWindow,
    onActivateTerminal,
    onCloseWindow,
    onCloseTerminal,
}) => {
    const allTabs = [
        ...openWindows.map(w => ({
            id: w.id,
            title: getDisplayName(w.file.name),
            type: 'app' as const,
            isActive: w.id === activeWinId,
            icon: getIconForType(w.file.name, w.file.type),
            onActivate: () => onActivateWindow(w.id),
            onClose: () => onCloseWindow(w.id),
        })),
        ...terminalWindows.map(t => ({
            id: t.id,
            title: t.title,
            type: 'terminal' as const,
            isActive: t.id === activeTerminalId,
            icon: <IoTerminal />,
            onActivate: () => onActivateTerminal(t.id),
            onClose: () => onCloseTerminal(t.id),
        }))
    ];

    if (allTabs.length === 0) return null;

    return (
        <div style={{
            position: 'fixed',
            top: 30, // Below MenuBar
            left: 0,
            width: '100%',
            height: 36,
            display: 'flex',
            alignItems: 'center',
            padding: '0 8px',
            zIndex: 9000,
            pointerEvents: 'none', // Let clicks pass through empty areas
        }}>
            <div style={{
                display: 'flex',
                gap: 6,
                pointerEvents: 'auto', // Re-enable clicks for tabs
                flex: 1, // Take available space
                overflowX: 'auto',
                padding: '4px 0',
                scrollbarWidth: 'none',
                alignItems: 'center',
            }}>
                <AnimatePresence>
                    {allTabs.map(tab => (
                        <motion.div
                            key={tab.id}
                            initial={{ opacity: 0, scale: 0.9, y: -10 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.9, width: 0 }}
                            onClick={(e) => {
                                e.stopPropagation(); // Prevent event bubbling
                                tab.onActivate();
                            }}
                            style={{
                                height: 28,
                                padding: '0 8px 0 6px',
                                background: tab.isActive
                                    ? 'rgba(255, 255, 255, 0.9)'
                                    : 'rgba(255, 255, 255, 0.4)',
                                backdropFilter: 'blur(10px)',
                                borderRadius: '6px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                cursor: 'pointer',
                                fontSize: 12,
                                color: '#333',
                                boxShadow: tab.isActive
                                    ? '0 2px 8px rgba(0,0,0,0.15)'
                                    : '0 1px 2px rgba(0,0,0,0.05)',
                                border: '1px solid rgba(255,255,255,0.2)',
                                transition: 'all 0.2s',
                                flex: '0 1 auto', // Allow growing/shrinking
                                minWidth: 0, // Allow shrinking below content size
                                maxWidth: 200, // Maximum width
                            }}
                            whileHover={{
                                background: tab.isActive
                                    ? 'rgba(255, 255, 255, 1)'
                                    : 'rgba(255, 255, 255, 0.6)'
                            }}
                        >
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: 16,
                                height: 16,
                                opacity: 0.8,
                                flexShrink: 0,
                            }}>
                                {tab.icon}
                            </div>
                            <div style={{
                                flex: 1,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                fontWeight: tab.isActive ? 600 : 400,
                                minWidth: 0,
                            }}>
                                {tab.title}
                            </div>
                            <div
                                onClick={(e) => {
                                    e.stopPropagation();
                                    tab.onClose();
                                }}
                                style={{
                                    width: 16,
                                    height: 16,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    borderRadius: '50%',
                                    cursor: 'pointer',
                                    opacity: 0.6,
                                    flexShrink: 0,
                                }}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.background = 'rgba(0,0,0,0.1)';
                                    e.currentTarget.style.opacity = '1';
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.background = 'transparent';
                                    e.currentTarget.style.opacity = '0.6';
                                }}
                            >
                                <IoClose size={12} />
                            </div>
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>
        </div>
    );
};
