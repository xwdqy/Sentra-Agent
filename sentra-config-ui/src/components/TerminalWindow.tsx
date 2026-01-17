import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import styles from './TerminalWindow.module.css';

interface TerminalWindowProps {
    processId: string;
    theme?: any;
    headerText?: string;
    onProcessNotFound?: () => void;
}

export const TerminalWindow: React.FC<TerminalWindowProps> = ({ processId, theme, headerText, onProcessNotFound }) => {
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermInstance = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const eventSourceRef = useRef<EventSource | null>(null);
    const [autoScroll, setAutoScroll] = useState(true);
    const autoScrollRef = useRef(true);
    const userScrolledRef = useRef(false);
    const lastScrollPositionRef = useRef(0);
    const disconnectedRef = useRef(false);
    const reconnectAttemptRef = useRef(0);
    const reconnectTimerRef = useRef<number | null>(null);
    const stoppedRef = useRef(false);

    useEffect(() => {
        autoScrollRef.current = autoScroll;
    }, [autoScroll]);

    // Initialize terminal
    useEffect(() => {
        if (!terminalRef.current) return;

        stoppedRef.current = false;
        disconnectedRef.current = false;
        reconnectAttemptRef.current = 0;
        if (reconnectTimerRef.current) {
            window.clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
        }

        // Clean up previous instance
        if (xtermInstance.current) {
            xtermInstance.current.dispose();
        }
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        const term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            theme: theme || {
                background: '#000000',
                foreground: '#ffffff',
                cursor: '#ffffff',
                selectionBackground: 'rgba(255, 255, 255, 0.3)',
            },
            allowProposedApi: true,
            convertEol: true,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        fitAddonRef.current = fitAddon;

        const webLinksAddon = new WebLinksAddon((_event, uri) => {
            window.open(uri, '_blank');
        });
        term.loadAddon(webLinksAddon);

        const searchAddon = new SearchAddon();
        term.loadAddon(searchAddon);

        term.open(terminalRef.current);
        xtermInstance.current = term;

        if (headerText) {
            term.write(`\x1b[1;36m${headerText}\x1b[0m\r\n\r\n`);
        }

        // Auto-scroll logic: Monitor scroll position
        const checkScrollPosition = () => {
            if (!term.buffer || !term.buffer.active) return;

            const viewport = term.buffer.active.viewportY;
            const baseY = term.buffer.active.baseY;

            // Calculate if we're at the bottom (within 3 lines of the end)
            const isAtBottom = (baseY - viewport) <= 3;

            // If user scrolled up manually, disable auto-scroll
            if (!isAtBottom && viewport !== lastScrollPositionRef.current) {
                userScrolledRef.current = true;
                setAutoScroll(false);
            }

            // If user scrolled back to bottom, re-enable auto-scroll
            if (isAtBottom && userScrolledRef.current) {
                userScrolledRef.current = false;
                setAutoScroll(true);
            }

            lastScrollPositionRef.current = viewport;
        };

        // Listen to scroll events
        term.onScroll(() => {
            checkScrollPosition();
        });

        // Function to scroll to bottom
        const scrollToBottom = () => {
            if (!term.buffer || !term.buffer.active) return;
            term.scrollToBottom();
        };

        // Auto-scroll after each write (if enabled)
        const originalWrite = term.write.bind(term);
        term.write = (data: string | Uint8Array, callback?: () => void) => {
            originalWrite(data, () => {
                // Auto-scroll to bottom after write if user hasn't scrolled up
                if (autoScrollRef.current && !userScrolledRef.current) {
                    requestAnimationFrame(() => {
                        scrollToBottom();
                    });
                }
                callback?.();
            });
        };

        // Handle input
        term.onData((data) => {
            const token = sessionStorage.getItem('sentra_auth_token') || localStorage.getItem('sentra_auth_token');
            fetch(`/api/scripts/input/${processId}?token=${token}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ data }),
            }).catch(err => {
                console.error('Failed to send input:', err);
            });
        });

        // Enhanced keyboard handling
        term.attachCustomKeyEventHandler((event) => {
            // Handle Ctrl+C for copy (when text is selected)
            if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
                const selection = term.getSelection();
                if (selection) {
                    navigator.clipboard.writeText(selection).catch(err => {
                        console.error('Failed to copy to clipboard:', err);
                    });
                    return false;
                }
                return true;
            }

            // Handle Ctrl+V for paste
            if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
                navigator.clipboard.readText().then(text => {
                    if (text) {
                        term.paste(text);
                    }
                }).catch(err => {
                    console.error('Failed to paste from clipboard:', err);
                });
                return false;
            }

            // Handle Ctrl+A for select all
            if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
                term.selectAll();
                return false;
            }

            // Handle End key to jump to bottom and re-enable auto-scroll
            if (event.key === 'End') {
                scrollToBottom();
                userScrolledRef.current = false;
                setAutoScroll(true);
                return false;
            }

            return true;
        });

        // Right-click context menu for copy/paste
        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation(); // Prevent desktop context menu
            const selection = term.getSelection();

            if (selection) {
                navigator.clipboard.writeText(selection).catch(err => {
                    console.error('Failed to copy:', err);
                });
            } else {
                navigator.clipboard.readText().then(text => {
                    if (text) {
                        term.paste(text);
                    }
                }).catch(err => {
                    console.error('Failed to paste:', err);
                });
            }
        };

        terminalRef.current.addEventListener('contextmenu', handleContextMenu);

        // Handle resize
        const handleResize = () => {
            try {
                fitAddon.fit();
            } catch (e) {
                // Ignore resize errors if terminal is hidden
            }
        };
        window.addEventListener('resize', handleResize);

        // Connect to SSE
        const cleanupEventSource = () => {
            const es = eventSourceRef.current;
            if (es) {
                try { es.close(); } catch { }
            }
            eventSourceRef.current = null;
        };

        const scheduleReconnect = (reason: string) => {
            if (stoppedRef.current) return;
            if (reconnectTimerRef.current) return;

            const attempt = reconnectAttemptRef.current;
            const base = 500;
            const maxDelay = 15000;
            const delay = Math.min(maxDelay, base * Math.pow(2, Math.min(6, attempt)));
            const jitter = Math.floor(Math.random() * 250);
            const finalDelay = delay + jitter;

            reconnectTimerRef.current = window.setTimeout(() => {
                reconnectTimerRef.current = null;
                if (stoppedRef.current) return;
                connectEventSource(reason);
            }, finalDelay);
        };

        const checkProcessAlive = async (): Promise<'alive' | 'not_found' | 'ended'> => {
            const token = sessionStorage.getItem('sentra_auth_token') || localStorage.getItem('sentra_auth_token');
            try {
                const res = await fetch(`/api/scripts/status/${processId}?token=${encodeURIComponent(token || '')}`);
                if (res.status === 404) return 'not_found';
                if (!res.ok) return 'alive';
                const st: any = await res.json();
                if (st && (st.exitCode != null || st.endTime != null)) return 'ended';
                return 'alive';
            } catch {
                return 'alive';
            }
        };

        const connectEventSource = async (_reason?: string) => {
            const alive = await checkProcessAlive();
            if (alive === 'not_found') {
                stoppedRef.current = true;
                if (reconnectTimerRef.current) {
                    window.clearTimeout(reconnectTimerRef.current);
                    reconnectTimerRef.current = null;
                }
                cleanupEventSource();
                term.write(`\r\n\x1b[31m✗ Process not found (stale terminal window).\x1b[0m\r\n`);
                try { onProcessNotFound?.(); } catch { }
                return;
            }
            cleanupEventSource();
            const token = sessionStorage.getItem('sentra_auth_token') || localStorage.getItem('sentra_auth_token');
            const es = new EventSource(`/api/scripts/stream/${processId}?token=${token}`);
            eventSourceRef.current = es;

            es.onopen = () => {
                reconnectAttemptRef.current = 0;
                if (disconnectedRef.current) {
                    disconnectedRef.current = false;
                    term.write('\r\n\x1b[32m✓ Reconnected.\x1b[0m\r\n');
                }
            };

            es.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'output') {
                        term.write(data.data);
                    } else if (data.type === 'exit') {
                        stoppedRef.current = true;
                        if (reconnectTimerRef.current) {
                            window.clearTimeout(reconnectTimerRef.current);
                            reconnectTimerRef.current = null;
                        }
                        term.write(`\r\n\x1b[32m✓ Process exited with code ${data.code}\x1b[0m\r\n`);
                        cleanupEventSource();
                    }
                } catch (e) {
                    console.error('Failed to parse SSE message:', e);
                }
            };

            es.onerror = () => {
                if (stoppedRef.current) return;
                reconnectAttemptRef.current += 1;
                if (!disconnectedRef.current) {
                    disconnectedRef.current = true;
                    term.write('\r\n\x1b[31m✗ Connection lost, retrying...\x1b[0m\r\n');
                }
                scheduleReconnect('error');
            };
        };

        const handleOnline = () => {
            if (stoppedRef.current) return;
            void connectEventSource('online');
        };
        const handleVisibility = () => {
            if (stoppedRef.current) return;
            if (document.visibilityState === 'visible') {
                void connectEventSource('visible');
            }
        };

        window.addEventListener('online', handleOnline);
        document.addEventListener('visibilitychange', handleVisibility);

        void connectEventSource('init');

        // Initial fit
        requestAnimationFrame(() => {
            try {
                fitAddon.fit();
                scrollToBottom();
            } catch (e) { }
        });

        return () => {
            stoppedRef.current = true;
            if (reconnectTimerRef.current) {
                window.clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            window.removeEventListener('online', handleOnline);
            document.removeEventListener('visibilitychange', handleVisibility);
            window.removeEventListener('resize', handleResize);
            terminalRef.current?.removeEventListener('contextmenu', handleContextMenu);
            term.dispose();
            cleanupEventSource();
        };
    }, [processId, theme, headerText]);

    // Re-fit observer with requestAnimationFrame for smoothness
    useEffect(() => {
        if (!terminalRef.current) return;

        let animationFrameId: number;
        const ro = new ResizeObserver(() => {
            // Cancel any pending frame to avoid stacking
            cancelAnimationFrame(animationFrameId);

            // Schedule fit on next frame to ensure layout is settled
            animationFrameId = requestAnimationFrame(() => {
                try {
                    fitAddonRef.current?.fit();
                } catch (e) { }
            });
        });

        ro.observe(terminalRef.current);

        return () => {
            cancelAnimationFrame(animationFrameId);
            ro.disconnect();
        };
    }, []);

    return (
        <div className={styles.terminalContainer} style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden' }}>
            {headerText && (
                <div className={styles.header} style={{ flexShrink: 0 }}>
                    {headerText}
                </div>
            )}
            <div style={{ flex: 1, position: 'relative', width: '100%', overflow: 'hidden' }}>
                <div
                    ref={terminalRef}
                    className={styles.terminalWrapper}
                    style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}
                />
            </div>

            {!autoScroll && (
                <div
                    className={styles.scrollHint}
                    onClick={() => {
                        xtermInstance.current?.scrollToBottom();
                        userScrolledRef.current = false;
                        setAutoScroll(true);
                    }}
                >
                    ↓ 跳转到底部
                </div>
            )}
        </div>
    );
};