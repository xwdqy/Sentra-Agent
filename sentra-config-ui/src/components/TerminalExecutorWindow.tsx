import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import styles from './TerminalWindow.module.css';
import { storage } from '../utils/storage';
import { fontFiles } from 'virtual:sentra-fonts';

interface TerminalExecutorWindowProps {
  sessionId: string;
  theme?: any;
  headerText?: string;
  onSessionNotFound?: () => void;
}

export const TerminalExecutorWindow: React.FC<TerminalExecutorWindowProps> = ({ sessionId, theme, headerText, onSessionNotFound }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const openedRef = useRef(false);
  const cursorRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  const onSessionNotFoundRef = useRef<TerminalExecutorWindowProps['onSessionNotFound']>(onSessionNotFound);

  useEffect(() => {
    onSessionNotFoundRef.current = onSessionNotFound;
  }, [onSessionNotFound]);

  const sendResizeNow = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const dims = (fitAddonRef.current as any)?.proposeDimensions?.();
      const cols = Number(dims?.cols);
      const rows = Number(dims?.rows);
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    } catch {
      // ignore
    }
  };

  const isIOS = (() => {
    try {
      const ua = String(navigator.userAgent || '');
      const isClassic = /iPad|iPhone|iPod/i.test(ua);
      const isIpadOS = /Macintosh/i.test(ua) && (navigator as any).maxTouchPoints > 1;
      return isClassic || isIpadOS;
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    if (!terminalRef.current) return;

    let disposed = false;
    let openRaf: number | null = null;
    let wsStarted = false;

    stoppedRef.current = false;
    openedRef.current = false;
    cursorRef.current = 0;

    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (wsRef.current) {
      try { wsRef.current.close(); } catch { }
      wsRef.current = null;
    }

    if (xtermInstance.current) {
      xtermInstance.current.dispose();
      xtermInstance.current = null;
    }

    const fallbackTheme = {
      background: '#0b1020',
      foreground: '#e2e8f0',
      cursor: '#e2e8f0',
      selectionBackground: 'rgba(226, 232, 240, 0.20)',
    };

    const terminalFontFallback = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", "Noto Sans Mono", "Cascadia Mono", "Courier New", monospace';

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: terminalFontFallback,
      theme: theme || fallbackTheme,
      allowProposedApi: true,
      convertEol: true,
      scrollback: 50000,
    });

    const pickSentraTermFontFile = () => {
      const files = Array.isArray(fontFiles) ? [...fontFiles] : [];
      const hit = files.find((f) => /^sentraterm\.(ttf|otf|woff2?|ttc)$/i.test(String(f || '')));
      return hit ? String(hit) : '';
    };

    const autoPickTerminalFontFile = () => {
      const files = Array.isArray(fontFiles) ? [...fontFiles] : [];
      const candidates = files
        .filter((f) => /\.(ttf|otf|woff2?|ttc)$/i.test(String(f || '')))
        .map((f) => String(f));
      if (!candidates.length) return '';

      const score = (name: string) => {
        const n = name.toLowerCase();
        let s = 0;
        if (n.includes('jetbrainsmono')) s += 100;
        if (n.includes('caskaydiacove') || n.includes('cascadiacove')) s += 90;
        if (n.includes('firacode')) s += 80;
        if (n.includes('cascadiacode')) s += 70;
        if (n.includes('nerd')) s += 30;
        if (n.includes('mono')) s += 15;
        if (n.includes('regular')) s += 5;
        if (n.includes('bold')) s -= 4;
        if (n.includes('italic')) s -= 4;
        return s;
      };

      return candidates.sort((a, b) => score(b) - score(a))[0] || '';
    };

    const forcedFile = pickSentraTermFontFile();
    const pickedFile = forcedFile || autoPickTerminalFontFile();

    if (pickedFile) {
      const baseName = String(pickedFile).replace(/\.[^/.]+$/, '');
      const family = `SentraFont_${baseName.replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
      void (async () => {
        try {
          const face = new FontFace(family, `url(/fonts/${encodeURIComponent(pickedFile)})`);
          await face.load();
          document.fonts.add(face);

          if (forcedFile) {
            term.options.fontFamily = `"${family}", ${terminalFontFallback}`;
            try {
              fitAddonRef.current?.fit();
            } catch { }
            return;
          }

          let isMono = false;
          try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.font = `16px "${family}", monospace`;
              const w1 = ctx.measureText('iiiiiiiiii').width;
              const w2 = ctx.measureText('WWWWWWWWWW').width;
              isMono = Number.isFinite(w1) && Number.isFinite(w2) && Math.abs(w1 - w2) < 0.5;
            }
          } catch { }

          if (isMono) {
            term.options.fontFamily = `"${family}", ${terminalFontFallback}`;
            try {
              fitAddonRef.current?.fit();
            } catch { }
          }
        } catch { }
      })();
    }

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

    const canFitNow = () => {
      const el = terminalRef.current;
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return false;
      return rect.width >= 2 && rect.height >= 2;
    };

    const safeWrite = (data: string) => {
      if (disposed || stoppedRef.current) return;
      try {
        term.write(data);
      } catch {
        // ignore
      }
    };

    function getToken() {
      return (
        storage.getString('sentra_auth_token', { backend: 'session', fallback: '' }) ||
        storage.getString('sentra_auth_token', { backend: 'local', fallback: '' })
      );
    }

    function connect(attempt = 0) {
      if (disposed || stoppedRef.current) return;
      if (!openedRef.current) return;

      const token = getToken();
      const url = new URL(`/api/terminal-executor/ws/${encodeURIComponent(sessionId)}`, window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('token', token || '');
      url.searchParams.set('cursor', String(cursorRef.current || 0));

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => {
        try { console.debug('[TerminalExecutor] ws open', { sessionId }); } catch { }
        try {
          if (openedRef.current && canFitNow()) {
            fitAddonRef.current?.fit();
          }
        } catch { }
        sendResizeNow();
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch { }
      };

      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(String(ev.data || ''));
        } catch {
          return;
        }

        if (msg?.type === 'init' || msg?.type === 'data') {
          const data = String(msg?.data || '');
          if (data) safeWrite(data);
          const c = Number(msg?.cursor);
          if (Number.isFinite(c)) cursorRef.current = c;
          if (msg?.type === 'init') {
            try { console.debug('[TerminalExecutor] init', { sessionId, len: data.length, cursor: c }); } catch { }
          }
          if (msg?.type === 'init' && msg?.exited) {
            const ec = msg?.exitCode;
            safeWrite(`\r\n\x1b[33m[process exited: ${ec ?? 'unknown'}]\x1b[0m\r\n`);
          }
          return;
        }

        if (msg?.type === 'exit') {
          const ec = msg?.exitCode;
          safeWrite(`\r\n\x1b[33m[process exited: ${ec ?? 'unknown'}]\x1b[0m\r\n`);
          const c = Number(msg?.cursor);
          if (Number.isFinite(c)) cursorRef.current = c;
          return;
        }

        if (msg?.type === 'error') {
          const m = String(msg?.message || '');
          if (m.toLowerCase().includes('not found')) {
            try { onSessionNotFoundRef.current?.(); } catch { }
          }
          safeWrite(`\r\n\x1b[31m[error] ${m}\x1b[0m\r\n`);
        }
      };

      ws.onclose = () => {
        if (disposed || stoppedRef.current) return;
        const delay = Math.min(6000, 500 + attempt * 600);
        reconnectTimerRef.current = window.setTimeout(() => connect(attempt + 1), delay);
      };

      ws.onerror = () => {
        // rely on onclose for reconnect
      };
    }

    const tryOpen = () => {
      if (disposed || stoppedRef.current) return;
      const el = terminalRef.current;
      if (!el) return;
      try {
        term.open(el);
        openedRef.current = true;
        try { term.focus(); } catch { }
        try {
          const rect = el.getBoundingClientRect();
          console.debug('[TerminalExecutor] opened', { sessionId, w: rect.width, h: rect.height });
        } catch { }
      } catch {
        try { console.debug('[TerminalExecutor] open retry'); } catch { }
        openRaf = requestAnimationFrame(tryOpen);
        return;
      }

      if (!wsStarted) {
        wsStarted = true;
        connect(0);
      }

      // Force a small write to trigger initial render even before any PTY output.
      safeWrite('');

      // Some layouts report 0 size briefly; ensure we eventually fit once size is ready.
      let fitTries = 0;
      const fitLoop = () => {
        if (disposed || stoppedRef.current || !openedRef.current) return;
        fitTries += 1;
        try {
          if (canFitNow()) {
            fitAddon.fit();
            sendResizeNow();
            try { term.focus(); } catch { }
            return;
          }
        } catch {
          // ignore
        }
        if (fitTries < 90) {
          requestAnimationFrame(fitLoop);
        }
      };
      requestAnimationFrame(fitLoop);

      requestAnimationFrame(() => {
        try {
          if (disposed || !openedRef.current) return;
          if (canFitNow()) {
            fitAddon.fit();
          }
          try { term.focus(); } catch { }
        } catch {
          // ignore
        }
      });
    };

    openRaf = requestAnimationFrame(tryOpen);

    if (headerText) {
      safeWrite(`\x1b[1;36m${headerText}\x1b[0m\r\n\r\n`);
    }

    term.onData((data) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'input', data }));
      } catch {
        // ignore
      }
    });

    term.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => undefined);
          return false;
        }
        return true;
      }
      return true;
    });

    const onResize = () => {
      try {
        if (!openedRef.current || !canFitNow()) return;
        fitAddon.fit();
        sendResizeNow();
      } catch {
        // ignore
      }
    };

    window.addEventListener('resize', onResize);

    const focusOnPointer = () => {
      try {
        term.focus();
      } catch {
        // ignore
      }
    };
    terminalRef.current.addEventListener('pointerdown', focusOnPointer);

    return () => {
      disposed = true;
      stoppedRef.current = true;

      window.removeEventListener('resize', onResize);
      terminalRef.current?.removeEventListener('pointerdown', focusOnPointer);

      if (openRaf != null) {
        cancelAnimationFrame(openRaf);
        openRaf = null;
      }
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { }
        wsRef.current = null;
      }
      if (xtermInstance.current) {
        xtermInstance.current.dispose();
        xtermInstance.current = null;
      }
    };
  }, [sessionId, headerText]);

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
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    if (!terminalRef.current) return;

    let animationFrameId: number;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = requestAnimationFrame(() => {
        try {
          if (!openedRef.current) return;
          const el = terminalRef.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
          if (rect.width < 2 || rect.height < 2) return;

          fitAddonRef.current?.fit();
          sendResizeNow();
        } catch {
          // ignore
        }
      });
    });

    ro.observe(terminalRef.current);

    return () => {
      cancelAnimationFrame(animationFrameId);
      ro.disconnect();
    };
  }, [sessionId]);

  const sendControl = (data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'input', data }));
    } catch {
      // ignore
    }
  };

  return (
    <div className={styles.terminalContainer} style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, position: 'relative', width: '100%', overflow: 'hidden' }}>
        <div
          ref={terminalRef}
          className={styles.terminalWrapper}
          style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}
        />
      </div>
      {isIOS ? (
        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: '8px 10px',
            background: 'rgba(20, 20, 22, 0.92)',
            borderTop: '1px solid rgba(255,255,255,0.10)',
            overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {(
            [
              { label: 'Ctrl+C', data: '\x03' },
              { label: 'Ctrl+D', data: '\x04' },
              { label: 'Ctrl+L', data: '\x0c' },
              { label: 'Esc', data: '\x1b' },
              { label: 'Tab', data: '\t' },
              { label: '↑', data: '\x1b[A' },
              { label: '↓', data: '\x1b[B' },
              { label: '←', data: '\x1b[D' },
              { label: '→', data: '\x1b[C' },
            ] as const
          ).map((b) => (
            <button
              key={b.label}
              onClick={() => sendControl(b.data)}
              style={{
                height: 34,
                padding: '0 10px',
                borderRadius: 10,
                background: 'rgba(255,255,255,0.10)',
                color: 'rgba(255,255,255,0.92)',
                border: '1px solid rgba(255,255,255,0.14)',
                fontSize: 13,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
