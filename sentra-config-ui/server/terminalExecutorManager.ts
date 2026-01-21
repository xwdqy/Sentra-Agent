import os from 'os';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { IPty } from '@lydell/node-pty';
import pty from '@lydell/node-pty';
import fs from 'fs';
import path from 'path';

type ShellType = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh';

type TerminalExecutorSession = {
  id: string;
  shellType: ShellType;
  pty: IPty;
  emitter: EventEmitter;
  createdAt: number;
  lastClientAt: number;
  clients: number;
  killTimer: NodeJS.Timeout | null;
  buffer: string;
  bufferBaseCursor: number;
  totalCursor: number;
  exited: boolean;
  exitCode: number | null;
  exitSignal: number | null;
};

const MAX_BUFFER_CHARS = 240_000;
const IDLE_KILL_MS = 5 * 60 * 1000;

function capBuffer(s: TerminalExecutorSession, nextChunk: string) {
  if (!nextChunk) return;
  s.totalCursor += nextChunk.length;
  s.buffer += nextChunk;
  if (s.buffer.length > MAX_BUFFER_CHARS) {
    const drop = s.buffer.length - MAX_BUFFER_CHARS;
    s.buffer = s.buffer.slice(drop);
    s.bufferBaseCursor += drop;
  }
}

function resolveShell(shellType: ShellType): { file: string; args: string[] } {
  const isWin = os.platform() === 'win32';

  if (isWin) {
    if (shellType === 'cmd') {
      return { file: 'cmd.exe', args: ['/Q', '/K', 'chcp 65001>nul & PROMPT $P$G'] };
    }
    if (shellType === 'bash') {
      const pf = process.env['ProgramFiles'] || '';
      const pf86 = process.env['ProgramFiles(x86)'] || '';
      const lad = process.env['LocalAppData'] || '';

      const candidates = [
        'bash.exe',
        path.join(pf, 'Git', 'bin', 'bash.exe'),
        path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
        path.join(pf86, 'Git', 'bin', 'bash.exe'),
        path.join(pf86, 'Git', 'usr', 'bin', 'bash.exe'),
        path.join(lad, 'Programs', 'Git', 'bin', 'bash.exe'),
        path.join(lad, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
      ].filter(Boolean);

      for (const c of candidates) {
        if (c === 'bash.exe') return { file: c, args: ['-i'] };
        try {
          if (fs.existsSync(c)) return { file: c, args: ['-i'] };
        } catch {
          // ignore
        }
      }

      // Try WSL bash.
      return { file: 'wsl.exe', args: ['-e', 'bash', '-li'] };
    }
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoExit'] };
  }

  if (shellType === 'zsh') return { file: 'zsh', args: ['-i'] };
  if (shellType === 'sh') return { file: 'sh', args: ['-i'] };
  // Default to bash for linux/mac.
  return { file: 'bash', args: ['-i'] };
}

class TerminalExecutorManager {
  private sessions = new Map<string, TerminalExecutorSession>();

  createSession(params: { shellType: ShellType; cols?: number; rows?: number; cwd?: string }): TerminalExecutorSession {
    const id = `execpty-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const { file, args } = resolveShell(params.shellType);

    const baseEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
      CLICOLOR_FORCE: '1',
      LANG: process.env.LANG || 'en_US.UTF-8',
    };

    try {
      delete (baseEnv as any).NODE_OPTIONS;
    } catch {
    }

    const emitter = new EventEmitter();

    const spawnPty = (f: string, a: string[]) => {
      return pty.spawn(f, a, {
        name: 'xterm-256color',
        cols: Math.max(20, Math.min(400, Number(params.cols || 120))),
        rows: Math.max(5, Math.min(200, Number(params.rows || 32))),
        cwd: params.cwd || process.cwd(),
        env: baseEnv,
      });
    };

    let p: IPty;
    let usedFile = file;
    try {
      p = spawnPty(file, args);
    } catch (e) {
      // Windows fallback: if bash target fails (WSL not installed etc.), fall back to PowerShell.
      if (os.platform() === 'win32' && params.shellType === 'bash') {
        usedFile = 'powershell.exe';
        p = spawnPty(usedFile, ['-NoLogo', '-NoExit']);
      } else {
        throw e;
      }
    }

    const session: TerminalExecutorSession = {
      id,
      shellType: params.shellType,
      pty: p,
      emitter,
      createdAt: Date.now(),
      lastClientAt: Date.now(),
      clients: 0,
      killTimer: null,
      buffer: '',
      bufferBaseCursor: 0,
      totalCursor: 0,
      exited: false,
      exitCode: null,
      exitSignal: null,
    };

    // Inform user about Windows bash fallback decisions.
    if (os.platform() === 'win32' && params.shellType === 'bash') {
      const usedLower = String(usedFile || '').toLowerCase();
      if (usedLower.includes('wsl.exe')) {
        const msg = 'Bash not found in PATH / Git for Windows not detected. Trying WSL bash.\r\n';
        capBuffer(session, msg);
        try { emitter.emit('data', msg); } catch { }
      }
      if (usedLower.includes('powershell.exe')) {
        const msg = 'Bash/WSL not available. Falling back to PowerShell.\r\n';
        capBuffer(session, msg);
        try { emitter.emit('data', msg); } catch { }
      }
    }

    p.onData((d: string) => {
      capBuffer(session, d);
      try {
        emitter.emit('data', d);
      } catch {
        // ignore
      }
    });

    p.onExit((ev: { exitCode: number; signal: number }) => {
      session.exited = true;
      session.exitCode = typeof ev.exitCode === 'number' ? ev.exitCode : null;
      session.exitSignal = typeof ev.signal === 'number' ? ev.signal : null;
      try {
        emitter.emit('exit', { exitCode: session.exitCode, signal: session.exitSignal });
      } catch {
        // ignore
      }

      // Let clients receive the exit message; cleanup after a while.
      setTimeout(() => {
        this.cleanupSession(id);
      }, 5 * 60 * 1000);
    });

    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string) {
    return this.sessions.get(id);
  }

  closeSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      if (os.platform() === 'win32') {
        const pid = Number((s.pty as any).pid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid);
          } catch {
          }
        }
      } else {
        s.pty.kill();
      }
    } catch {
    }

    setTimeout(() => {
      const still = this.sessions.get(id);
      if (!still) return;
      if (still.exited) return;
      this.cleanupSession(id);
    }, 15_000);

    return true;
  }

  onClientConnected(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.clients += 1;
    s.lastClientAt = Date.now();
    if (s.killTimer) {
      clearTimeout(s.killTimer);
      s.killTimer = null;
    }
  }

  onClientDisconnected(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.clients = Math.max(0, s.clients - 1);
    s.lastClientAt = Date.now();
    if (s.clients === 0 && !s.killTimer) {
      s.killTimer = setTimeout(() => {
        this.closeSession(id);
      }, IDLE_KILL_MS);
    }
  }

  private cleanupSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.killTimer) {
      clearTimeout(s.killTimer);
      s.killTimer = null;
    }
    this.sessions.delete(id);
  }
}

export const terminalExecutorManager = new TerminalExecutorManager();
export type { ShellType, TerminalExecutorSession };
