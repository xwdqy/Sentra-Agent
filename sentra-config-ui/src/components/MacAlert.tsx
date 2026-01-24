import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SentraIcon } from './SentraIcon';

interface MacAlertProps {
    isOpen: boolean;
    title: string;
    message: React.ReactNode;
    onClose: () => void;
    onConfirm: () => void;
    confirmText?: string;
    cancelText?: string;
    isDanger?: boolean;
    showCancel?: boolean;
}

export const MacAlert: React.FC<MacAlertProps> = ({
    isOpen,
    title,
    message,
    onClose,
    onConfirm,
    confirmText = 'OK',
    cancelText = 'Cancel',
    isDanger = false,
    showCancel = true,
}) => {
    return (
        <AnimatePresence>
            {isOpen && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    width: '100vw',
                    height: '100vh',
                    zIndex: 1000000002,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(0,0,0,0.4)', // Darker dimmer, no blur
                    transform: 'translateZ(0)', // Force GPU
                }} onClick={onClose}>
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 0 }} // Simpler initial state
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 0 }}
                        transition={{ duration: 0.2 }} // Faster fixed duration instead of spring
                        onClick={e => e.stopPropagation()}
                        style={{
                            width: 320,
                            background: 'linear-gradient(var(--sentra-accent-tint-12), var(--sentra-accent-tint-12)), var(--sentra-panel-bg-strong)',
                            backdropFilter: 'blur(10px)', // Reduced blur
                            WebkitBackdropFilter: 'blur(10px)',
                            borderRadius: '12px',
                            boxShadow: '0 20px 40px rgba(0,0,0,0.2), 0 0 0 1px var(--sentra-border) inset',
                            padding: '24px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            textAlign: 'center',
                            willChange: 'transform, opacity', // Hint to browser
                            transform: 'translateZ(0)',
                        }}
                    >
                        <div style={{ marginBottom: 16 }}>
                            <SentraIcon size={48} />
                        </div>
                        <h3 style={{
                            margin: '0 0 8px 0',
                            fontSize: '15px',
                            fontWeight: 600,
                            color: 'var(--sentra-fg)'
                        }}>
                            {title}
                        </h3>
                        {typeof message === 'string' ? (
                            <p style={{
                                margin: '0 0 24px 0',
                                fontSize: '13px',
                                color: 'var(--sentra-muted-fg)',
                                lineHeight: '1.4',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                            }}>
                                {message}
                            </p>
                        ) : (
                            <div style={{
                                margin: '0 0 24px 0',
                                fontSize: '13px',
                                color: 'var(--sentra-muted-fg)',
                                lineHeight: '1.4',
                                width: '100%',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                            }}>
                                {message}
                            </div>
                        )}
                        <div style={{
                            display: 'flex',
                            gap: 12,
                            width: '100%',
                            justifyContent: 'flex-end'
                        }}>
                            {showCancel ? (
                                <button
                                    onClick={onClose}
                                    style={{
                                        flex: 1,
                                        padding: '6px 12px',
                                        borderRadius: '6px',
                                        border: '1px solid var(--sentra-border)',
                                        background: 'var(--sentra-glass-bg-strong)',
                                        fontSize: '13px',
                                        fontWeight: 500,
                                        color: 'var(--sentra-fg)',
                                        cursor: 'pointer',
                                        outline: 'none',
                                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                                    }}
                                    onMouseOver={e => e.currentTarget.style.background = 'rgba(var(--sentra-accent-rgb), 0.10)'}
                                    onMouseOut={e => e.currentTarget.style.background = 'var(--sentra-glass-bg-strong)'}
                                >
                                    {cancelText}
                                </button>
                            ) : null}
                            <button
                                onClick={() => {
                                    onConfirm();
                                    onClose();
                                }}
                                style={{
                                    flex: 1,
                                    padding: '6px 12px',
                                    borderRadius: '6px',
                                    border: 'none',
                                    background: isDanger ? '#FF3B30' : 'var(--sentra-accent)',
                                    fontSize: '13px',
                                    fontWeight: 600,
                                    color: isDanger ? 'white' : 'var(--sentra-accent-contrast)',
                                    cursor: 'pointer',
                                    outline: 'none',
                                    boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
                                }}
                                onMouseOver={e => e.currentTarget.style.background = isDanger ? '#FF2D55' : 'rgba(var(--sentra-accent-rgb), 0.90)'}
                                onMouseOut={e => e.currentTarget.style.background = isDanger ? '#FF3B30' : 'var(--sentra-accent)'}
                            >
                                {confirmText}
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
