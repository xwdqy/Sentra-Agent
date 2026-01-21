import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import styles from './TerminalWindow.module.css';
import { storage } from '../utils/storage';

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
    const openedRef = useRef(false);
    const outputCursorRef = useRef(0);
    const [autoScroll, setAutoScroll] = useState(true);
    const autoScrollRef = useRef(true);
    const userScrolledRef = useRef(false);
    const lastScrollPositionRef = useRef(0);
    const disconnectedRef = useRef(false);
    const reconnectAttemptRef = useRef(0);
    const reconnectTimerRef = useRef<number | null>(null);
    const stoppedRef = useRef(false);
    const inputQueueRef = useRef<string[]>([]);
    const inputSendingRef = useRef(false);
    const inputFlushTimerRef = useRef<number | null>(null);

    useEffect(() => {
        autoScrollRef.current = autoScroll;
    }, [autoScroll]);

    // Initialize terminal
    useEffect(() => {
        if (!terminalRef.current) return;

        let disposed = false;
        let openRaf: number | null = null;

        stoppedRef.current = false;
        openedRef.current = false;
        outputCursorRef.current = 0;
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

        const fallbackTheme = {
            background: '#0b1020',
            foreground: '#e2e8f0',
            cursor: '#e2e8f0',
            selectionBackground: 'rgba(226, 232, 240, 0.20)',
        };

        const term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            theme: theme || fallbackTheme,
            allowProposedApi: true,
            convertEol: true,
            scrollback: 50000,
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

        xtermInstance.current = term;

        const safeWrite = (data: string) => {
            if (disposed || stoppedRef.current) return;
            try {
                term.write(data);
            } catch (e) {
                // Avoid crashing the whole app if xterm renderer is not ready / already disposed
                try { console.error('xterm write failed', e); } catch { }
            }
        };

        const canFitNow = () => {
            const el = terminalRef.current;
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return false;
            return rect.width >= 2 && rect.height >= 2;
        };

        const tryOpen = () => {
            if (disposed || stoppedRef.current) return;
            const el = terminalRef.current;
            if (!el) return;

            // Wait until layout is settled; prevents xterm internal timers running after
            // an early StrictMode cleanup (open->dispose race).
            if (!canFitNow()) {
                openRaf = requestAnimationFrame(tryOpen);
                return;
            }

            try {
                term.open(el);
                openedRef.current = true;
            } catch (e) {
                try { console.error('xterm open failed', e); } catch { }
                return;
            }

            // Initial fit (only after open)
            requestAnimationFrame(() => {
                try {
                    if (!disposed && openedRef.current && canFitNow()) {
                        fitAddon.fit();
                        safeScrollToBottom();
                    }
                } catch (e) { }
            });
        };

        openRaf = requestAnimationFrame(tryOpen);

        const safeScrollToBottom = () => {
            if (disposed || stoppedRef.current) return;
            if (!canFitNow()) return;
            try {
                if (!term.buffer || !term.buffer.active) return;
                term.scrollToBottom();
            } catch (e) {
                try { console.error('xterm scrollToBottom failed', e); } catch { }
            }
        };

        if (headerText) {
            safeWrite(`\x1b[1;36m${headerText}\x1b[0m\r\n\r\n`);
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

        // Auto-scroll after each write (if enabled)
        const originalWrite = term.write.bind(term);
        term.write = (data: string | Uint8Array, callback?: () => void) => {
            originalWrite(data, () => {
                // Auto-scroll to bottom after write if user hasn't scrolled up
                if (autoScrollRef.current && !userScrolledRef.current) {
                    requestAnimationFrame(() => {
                        safeScrollToBottom();
                    });
                }
                callback?.();
            });
        };

        const flushInputQueue = async () => {
            if (inputSendingRef.current) return;
            inputSendingRef.current = true;
            try {
                while (inputQueueRef.current.length > 0) {
                    const chunk = inputQueueRef.current.splice(0, Math.min(1024, inputQueueRef.current.length)).join('');

                    const token =
                        storage.getString('sentra_auth_token', { backend: 'session', fallback: '' }) ||
                        storage.getString('sentra_auth_token', { backend: 'local', fallback: '' });
                    try {
                        await fetch(`/api/scripts/input/${processId}?token=${token}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ data: chunk }),
                        });
                    } catch (err) {
                        console.error('Failed to send input:', err);
                        break;
                    }
                }
            } finally {
                inputSendingRef.current = false;
                if (inputQueueRef.current.length > 0) {
                    void flushInputQueue();
                }
            }
        };

        term.onData((data) => {
            const normalized = data === '\r' ? '\r\n' : data;
            inputQueueRef.current.push(normalized);
            if (inputSendingRef.current) return;
            if (inputFlushTimerRef.current != null) return;
            inputFlushTimerRef.current = window.setTimeout(() => {
                inputFlushTimerRef.current = null;
                void flushInputQueue();
            }, 8);
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
                safeScrollToBottom();
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
                if (!disposed && openedRef.current && canFitNow()) fitAddon.fit();
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
            const token =
                storage.getString('sentra_auth_token', { backend: 'session', fallback: '' }) ||
                storage.getString('sentra_auth_token', { backend: 'local', fallback: '' });
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
            if (disposed || stoppedRef.current) return;

            if (alive === 'not_found') {
                stoppedRef.current = true;
                if (reconnectTimerRef.current) {
                    window.clearTimeout(reconnectTimerRef.current);
                    reconnectTimerRef.current = null;
                }
                cleanupEventSource();
                safeWrite(`\r\n\x1b[31m✗ Process not found (stale terminal window).\x1b[0m\r\n`);
                try { onProcessNotFound?.(); } catch { }
                return;
            }
            cleanupEventSource();
            const token =
                storage.getString('sentra_auth_token', { backend: 'session', fallback: '' }) ||
                storage.getString('sentra_auth_token', { backend: 'local', fallback: '' });
            if (disposed || stoppedRef.current) return;
            const cursor = outputCursorRef.current;
            const es = new EventSource(`/api/scripts/stream/${processId}?token=${token}&cursor=${cursor}`);
            eventSourceRef.current = es;

            es.onopen = () => {
                reconnectAttemptRef.current = 0;
                if (reconnectTimerRef.current) {
                    window.clearTimeout(reconnectTimerRef.current);
                    reconnectTimerRef.current = null;
                }
                if (disconnectedRef.current) {
                    disconnectedRef.current = false;
                    safeWrite('\r\n\x1b[32m✓ Reconnected.\x1b[0m\r\n');
                }
            };

            es.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'output') {
                        safeWrite(String(data.data || ''));
                        outputCursorRef.current += 1;
                    } else if (data.type === 'exit') {
                        const exitCode = (data?.code ?? data?.exitCode) as any;
                        safeWrite(`\r\n\x1b[32m✓ Process exited with code ${exitCode ?? 'unknown'}\x1b[0m\r\n`);
                        stoppedRef.current = true;
                        if (reconnectTimerRef.current) {
                            window.clearTimeout(reconnectTimerRef.current);
                            reconnectTimerRef.current = null;
                        }
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
                    safeWrite('\r\n\x1b[31m✗ Connection lost, retrying...\x1b[0m\r\n');
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

        return () => {
            disposed = true;
            stoppedRef.current = true;
            openedRef.current = false;
            if (openRaf != null) {
                cancelAnimationFrame(openRaf);
                openRaf = null;
            }
            if (inputFlushTimerRef.current != null) {
                window.clearTimeout(inputFlushTimerRef.current);
                inputFlushTimerRef.current = null;
            }

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
    }, [processId, headerText]);

    useEffect(() => {
        const term = xtermInstance.current;
        if (!term) return;
        const fallbackTheme = {
            background: '#0b1020',
            foreground: '#e2e8f0',
            cursor: '#e2e8f0',
            selectionBackground: 'rgba(226, 232, 240, 0.20)',
        };
        try {
            term.options.theme = theme || fallbackTheme;
        } catch { }
    }, [theme]);

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
                    if (!openedRef.current) return;
                    const el = terminalRef.current;
                    if (!el) return;
                    const rect = el.getBoundingClientRect();
                    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
                    if (rect.width < 2 || rect.height < 2) return;

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
                        try {
                            const term = xtermInstance.current;
                            if (!term) return;
                            const el = terminalRef.current;
                            if (!el) return;
                            const rect = el.getBoundingClientRect();
                            if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
                            if (rect.width < 2 || rect.height < 2) return;
                            term.scrollToBottom();
                        } catch (e) {
                            try { console.error('xterm scroll hint failed', e); } catch { }
                        }
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