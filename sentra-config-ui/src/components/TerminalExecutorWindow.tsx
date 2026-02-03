import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import styles from './TerminalExecutorWindow.module.css';
import { storage } from '../utils/storage';
import { appendTerminalSnapshotChunk, getTerminalSnapshot, removeTerminalSnapshot } from '../utils/terminalSnapshotDb';
import { fontFiles } from 'virtual:sentra-fonts';

const TERMINAL_FONT_FALLBACK = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "DejaVu Sans Mono", "Noto Sans Mono", "Cascadia Mono", "Courier New", monospace';
const TERMINAL_PERSIST_TTL_MS = 1000 * 60 * 60 * 24;
const SENTRA_TERMINAL_FONT_FAMILY = 'SentraTerminal';

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
  const snapshotRef = useRef('');
  const snapshotSavedAtRef = useRef(0);
  const lastSavedCursorRef = useRef(0);
  const persistPendingRef = useRef('');
  const persistPendingCursorRef = useRef(0);
  const persistFlushTimerRef = useRef<number | null>(null);
  const [uiFontFamily, setUiFontFamily] = useState(TERMINAL_FONT_FALLBACK);
  const reconnectTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const lastPongAtRef = useRef(0);
  const stoppedRef = useRef(false);
  const onSessionNotFoundRef = useRef<TerminalExecutorWindowProps['onSessionNotFound']>(onSessionNotFound);
  const initSeenRef = useRef(false);

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

    const now0 = Date.now();

    const cursorKey = `sentra_exec_terminal_cursor:${String(sessionId || '')}`;
    const snapshotKey = `sentra_exec_terminal_snapshot:${String(sessionId || '')}`;
    const tsKey = `sentra_exec_terminal_persist_ts:${String(sessionId || '')}`;

    stoppedRef.current = false;
    openedRef.current = false;
    initSeenRef.current = false;
    cursorRef.current = 0;
    lastSavedCursorRef.current = 0;
    snapshotRef.current = '';
    persistPendingRef.current = '';
    persistPendingCursorRef.current = 0;
    if (persistFlushTimerRef.current != null) {
      window.clearTimeout(persistFlushTimerRef.current);
      persistFlushTimerRef.current = null;
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

    const fallbackTheme = {
      background: '#0b1020',
      foreground: '#e2e8f0',
      cursor: '#e2e8f0',
      selectionBackground: 'rgba(226, 232, 240, 0.20)',
    };

    setUiFontFamily(TERMINAL_FONT_FALLBACK);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: `"${SENTRA_TERMINAL_FONT_FAMILY}", ${TERMINAL_FONT_FALLBACK}`,
      theme: theme || fallbackTheme,
      allowProposedApi: true,
      convertEol: true,
      scrollback: 8000,
    });

    const pickSentraTermFontFile = () => {
      const files = Array.isArray(fontFiles) ? [...fontFiles] : [];
      const toBase = (v: string) => {
        const s = String(v || '');
        const parts = s.split(/[/\\]/);
        return parts[parts.length - 1] || s;
      };
      const candidates = files.map((f) => String(f || '')).filter(Boolean);
      const hit = candidates.find((f) => /^均衡.*\.(ttf|otf|woff2?|ttc)$/i.test(toBase(f)));
      return hit ? String(hit) : '';
    };

    const pickedFile = pickSentraTermFontFile();

    if (pickedFile) {
      void (async () => {
        try {
          const face = new FontFace(SENTRA_TERMINAL_FONT_FAMILY, `url(/fonts/${encodeURIComponent(pickedFile)})`);
          await face.load();
          document.fonts.add(face);
          const next = `"${SENTRA_TERMINAL_FONT_FAMILY}", ${TERMINAL_FONT_FALLBACK}`;
          term.options.fontFamily = next;
          if (!disposed) setUiFontFamily(next);
          try {
            fitAddonRef.current?.fit();
            sendResizeNow();
            term.refresh(0, term.rows - 1);
            requestAnimationFrame(() => {
              try { term.refresh(0, term.rows - 1); } catch { }
            });
          } catch { }
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

    const flushPersist = (force = false) => {
      const pending = persistPendingRef.current;
      if (!pending) return;
      persistPendingRef.current = '';

      if (persistFlushTimerRef.current != null) {
        window.clearTimeout(persistFlushTimerRef.current);
        persistFlushTimerRef.current = null;
      }

      const now = Date.now();
      const cursor = force ? cursorRef.current : persistPendingCursorRef.current;
      snapshotSavedAtRef.current = now;
      lastSavedCursorRef.current = cursor;
      void appendTerminalSnapshotChunk({
        id: String(sessionId || ''),
        kind: 'exec',
        ts: now,
        cursor,
        chunk: pending,
      });
    };

    const queuePersist = (chunk: string, cursor: number, force = false) => {
      persistPendingCursorRef.current = cursor;

      if (chunk) {
        persistPendingRef.current = (persistPendingRef.current || '') + chunk;
      }

      if (force) {
        flushPersist(true);
        return;
      }

      if (!persistPendingRef.current) return;

      const now = Date.now();
      if (cursor - lastSavedCursorRef.current < 25 && now - snapshotSavedAtRef.current < 800) {
        return;
      }

      if (persistPendingRef.current.length >= 16_000) {
        flushPersist(false);
        return;
      }

      if (persistFlushTimerRef.current != null) return;
      persistFlushTimerRef.current = window.setTimeout(() => {
        persistFlushTimerRef.current = null;
        flushPersist(false);
      }, 450);
    };

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

    const trimOverlap = (prev: string, next: string) => {
      if (!prev || !next) return next;
      const max = Math.min(8192, prev.length, next.length);
      for (let len = max; len > 0; len -= 1) {
        if (prev.slice(-len) === next.slice(0, len)) {
          return next.slice(len);
        }
      }
      return next;
    };

    const restorePromise = (async () => {
      const sid = String(sessionId || '');
      let restoredCursor = 0;
      let restoredSnapshot = '';
      let restoredTs = 0;

      const fromDb = await getTerminalSnapshot('exec', sid);
      if (fromDb && fromDb.ts > 0 && now0 - fromDb.ts <= TERMINAL_PERSIST_TTL_MS) {
        restoredCursor = Number(fromDb.cursor || 0);
        restoredSnapshot = String(fromDb.snapshot || '');
        restoredTs = Number(fromDb.ts || 0);
      } else if (fromDb) {
        try { await removeTerminalSnapshot('exec', sid); } catch { }
      }

      if (!restoredTs) {
        const restoredTsSession = storage.getNumber(tsKey, { backend: 'session', fallback: NaN });
        const restoredTsLocal = storage.getNumber(tsKey, { backend: 'local', fallback: NaN });
        const legacyTs = Number.isFinite(restoredTsSession) ? restoredTsSession : (Number.isFinite(restoredTsLocal) ? restoredTsLocal : 0);
        const legacyFresh = legacyTs > 0 && now0 - legacyTs <= TERMINAL_PERSIST_TTL_MS;
        if (legacyFresh) {
          const cursorSession = storage.getNumber(cursorKey, { backend: 'session', fallback: NaN });
          const cursorLocal = storage.getNumber(cursorKey, { backend: 'local', fallback: NaN });
          restoredCursor = Number.isFinite(cursorSession)
            ? cursorSession
            : (Number.isFinite(cursorLocal) ? cursorLocal : 0);
          const snapSession = storage.getString(snapshotKey, { backend: 'session', fallback: '' });
          const snapLocal = storage.getString(snapshotKey, { backend: 'local', fallback: '' });
          restoredSnapshot = snapSession || snapLocal;
          restoredTs = legacyTs;
          void appendTerminalSnapshotChunk({ id: sid, kind: 'exec', ts: legacyTs, cursor: restoredCursor, chunk: restoredSnapshot });
          try { storage.remove(tsKey, 'session'); } catch { }
          try { storage.remove(cursorKey, 'session'); } catch { }
          try { storage.remove(snapshotKey, 'session'); } catch { }
          try { storage.remove(tsKey, 'local'); } catch { }
          try { storage.remove(cursorKey, 'local'); } catch { }
          try { storage.remove(snapshotKey, 'local'); } catch { }
        }
        if (!legacyFresh && legacyTs > 0) {
          try { storage.remove(tsKey, 'session'); } catch { }
          try { storage.remove(cursorKey, 'session'); } catch { }
          try { storage.remove(snapshotKey, 'session'); } catch { }
          try { storage.remove(tsKey, 'local'); } catch { }
          try { storage.remove(cursorKey, 'local'); } catch { }
          try { storage.remove(snapshotKey, 'local'); } catch { }
        }
      }

      if (disposed || stoppedRef.current) return;
      cursorRef.current = Number.isFinite(Number(restoredCursor)) ? Number(restoredCursor) : 0;
      lastSavedCursorRef.current = cursorRef.current;
      snapshotRef.current = String(restoredSnapshot || '');
      if (snapshotRef.current) {
        safeWrite(snapshotRef.current);
      }

      try { storage.remove(tsKey, 'session'); } catch { }
      try { storage.remove(cursorKey, 'session'); } catch { }
      try { storage.remove(snapshotKey, 'session'); } catch { }
      try { storage.remove(tsKey, 'local'); } catch { }
      try { storage.remove(cursorKey, 'local'); } catch { }
      try { storage.remove(snapshotKey, 'local'); } catch { }
    })();

    function getToken() {
      return (
        storage.getString('sentra_auth_token', { backend: 'session', fallback: '' }) ||
        storage.getString('sentra_auth_token', { backend: 'local', fallback: '' })
      );
    }

    function connect(attempt = 0) {
      if (disposed || stoppedRef.current) return;
      if (!openedRef.current) return;

      const clearPingTimer = () => {
        if (pingTimerRef.current) {
          try { window.clearInterval(pingTimerRef.current); } catch { }
          pingTimerRef.current = null;
        }
      };

      const startPingTimer = () => {
        clearPingTimer();
        pingTimerRef.current = window.setInterval(() => {
          const ws0 = wsRef.current;
          if (!ws0 || ws0.readyState !== WebSocket.OPEN) return;

          const lastPong = lastPongAtRef.current;
          if (lastPong > 0 && Date.now() - lastPong > 45_000) {
            try { ws0.close(); } catch { }
            return;
          }

          try { ws0.send(JSON.stringify({ type: 'ping' })); } catch { }
        }, 15_000);
      };

      const token = getToken();
      const url = new URL(`/api/terminal-executor/ws/${encodeURIComponent(sessionId)}`, window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('token', token || '');
      url.searchParams.set('cursor', String(cursorRef.current || 0));

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => {
        try { console.debug('[TerminalExecutor] ws open', { sessionId }); } catch { }
        lastPongAtRef.current = Date.now();
        try {
          if (openedRef.current && canFitNow()) {
            fitAddonRef.current?.fit();
          }
        } catch { }
        sendResizeNow();
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch { }
        startPingTimer();
      };

      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(String(ev.data || ''));
        } catch {
          return;
        }

        if (msg?.type === 'pong') {
          lastPongAtRef.current = Date.now();
          return;
        }

        if (msg?.type === 'init' || msg?.type === 'data') {
          const rawData = String(msg?.data || '');
          const data = (msg?.type === 'init' && !initSeenRef.current && snapshotRef.current)
            ? trimOverlap(String(snapshotRef.current || ''), rawData)
            : rawData;

          if (msg?.type === 'init') initSeenRef.current = true;

          if (data) {
            safeWrite(data);
            const maxChars = 200000;
            snapshotRef.current = (snapshotRef.current || '') + data;
            if (snapshotRef.current.length > maxChars) {
              snapshotRef.current = snapshotRef.current.slice(-maxChars);
            }
          }
          const c = Number(msg?.cursor);
          if (Number.isFinite(c)) cursorRef.current = c;
          queuePersist(data, cursorRef.current, false);
          if (msg?.type === 'init') {
            try { console.debug('[TerminalExecutor] init', { sessionId, len: rawData.length, cursor: c }); } catch { }
          }
          if (msg?.type === 'init' && msg?.exited) {
            const ec = msg?.exitCode;
            safeWrite(`\r\n\x1b[33m[process exited: ${ec ?? 'unknown'}]\x1b[0m\r\n`);
            queuePersist('', cursorRef.current, true);
          }
          return;
        }

        if (msg?.type === 'exit') {
          const ec = msg?.exitCode;
          safeWrite(`\r\n\x1b[33m[process exited: ${ec ?? 'unknown'}]\x1b[0m\r\n`);
          const c = Number(msg?.cursor);
          if (Number.isFinite(c)) cursorRef.current = c;
          queuePersist('', cursorRef.current, true);
          return;
        }

        if (msg?.type === 'error') {
          const m = String(msg?.message || '');
          if (m.toLowerCase().includes('not found')) {
            try { void removeTerminalSnapshot('exec', String(sessionId || '')); } catch { }
            try { storage.remove(tsKey, 'session'); } catch { }
            try { storage.remove(cursorKey, 'session'); } catch { }
            try { storage.remove(snapshotKey, 'session'); } catch { }
            try { storage.remove(tsKey, 'local'); } catch { }
            try { storage.remove(cursorKey, 'local'); } catch { }
            try { storage.remove(snapshotKey, 'local'); } catch { }
            try { onSessionNotFoundRef.current?.(); } catch { }
          }
          safeWrite(`\r\n\x1b[31m[error] ${m}\x1b[0m\r\n`);
        }
      };

      ws.onclose = () => {
        if (pingTimerRef.current) {
          try { window.clearInterval(pingTimerRef.current); } catch { }
          pingTimerRef.current = null;
        }
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
        void restorePromise.then(() => {
          if (disposed || stoppedRef.current) return;
          if (wsStarted) return;
          wsStarted = true;
          connect(0);
        });
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

      if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
        term.selectAll();
        return false;
      }

      return true;
    });

    const handlePasteCapture = (e: ClipboardEvent) => {
      try {
        const text = e.clipboardData?.getData('text');
        if (!text) return;
        e.preventDefault();
        term.paste(text);
      } catch {
        // ignore
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      const selection = term.getSelection();
      if (selection) {
        e.preventDefault();
        e.stopPropagation();
        navigator.clipboard.writeText(selection).catch(() => undefined);
        return;
      }

      const readText = (navigator as any)?.clipboard?.readText;
      if (typeof readText === 'function') {
        e.preventDefault();
        e.stopPropagation();
        (navigator as any).clipboard.readText().then((text: string) => {
          if (text) {
            term.paste(text);
          }
        }).catch(() => undefined);
      }
    };

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
    terminalRef.current.addEventListener('paste', handlePasteCapture as any, true);
    terminalRef.current.addEventListener('contextmenu', handleContextMenu);

    return () => {
      disposed = true;
      stoppedRef.current = true;
      flushPersist(true);

      if (persistFlushTimerRef.current != null) {
        window.clearTimeout(persistFlushTimerRef.current);
        persistFlushTimerRef.current = null;
      }

      if (pingTimerRef.current) {
        try { window.clearInterval(pingTimerRef.current); } catch { }
        pingTimerRef.current = null;
      }

      window.removeEventListener('resize', onResize);
      terminalRef.current?.removeEventListener('pointerdown', focusOnPointer);
      terminalRef.current?.removeEventListener('paste', handlePasteCapture as any, true);
      terminalRef.current?.removeEventListener('contextmenu', handleContextMenu);

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
    <div className={styles.terminalContainer} style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden', fontFamily: uiFontFamily }}>
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
