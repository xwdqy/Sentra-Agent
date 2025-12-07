import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SentraIcon } from './SentraIcon';

interface MacAlertProps {
    isOpen: boolean;
    title: string;
    message: string;
    onClose: () => void;
    onConfirm: () => void;
    confirmText?: string;
    cancelText?: string;
    isDanger?: boolean;
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
                    zIndex: 9999,
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
                            background: 'rgba(255, 255, 255, 0.90)', // More opaque
                            backdropFilter: 'blur(10px)', // Reduced blur
                            WebkitBackdropFilter: 'blur(10px)',
                            borderRadius: '12px',
                            boxShadow: '0 20px 40px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,255,255,0.4) inset',
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
                            color: '#333'
                        }}>
                            {title}
                        </h3>
                        <p style={{
                            margin: '0 0 24px 0',
                            fontSize: '13px',
                            color: '#666',
                            lineHeight: '1.4'
                        }}>
                            {message}
                        </p>
                        <div style={{
                            display: 'flex',
                            gap: 12,
                            width: '100%',
                            justifyContent: 'flex-end'
                        }}>
                            <button
                                onClick={onClose}
                                style={{
                                    flex: 1,
                                    padding: '6px 12px',
                                    borderRadius: '6px',
                                    border: '1px solid rgba(0,0,0,0.1)',
                                    background: 'white',
                                    fontSize: '13px',
                                    fontWeight: 500,
                                    color: '#333',
                                    cursor: 'pointer',
                                    outline: 'none',
                                    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                                }}
                                onMouseOver={e => e.currentTarget.style.background = '#f5f5f5'}
                                onMouseOut={e => e.currentTarget.style.background = 'white'}
                            >
                                {cancelText}
                            </button>
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
                                    background: isDanger ? '#FF3B30' : '#007AFF',
                                    fontSize: '13px',
                                    fontWeight: 600,
                                    color: 'white',
                                    cursor: 'pointer',
                                    outline: 'none',
                                    boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
                                }}
                                onMouseOver={e => e.currentTarget.style.background = isDanger ? '#FF2D55' : '#0066D6'}
                                onMouseOut={e => e.currentTarget.style.background = isDanger ? '#FF3B30' : '#007AFF'}
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
