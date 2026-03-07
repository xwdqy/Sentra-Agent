import { spawn } from 'node:child_process';
import process from 'node:process';
import iconv from 'iconv-lite';
import WebSocket from 'ws';
import logger from '../../logger/index.js';
import { ok, fail } from '../../utils/result.js';
import { makeAbortError, mergeAbortSignals } from '../../utils/signal.js';
import {
  buildCtrlCPayload,
  buildExecPayload,
  buildTerminalWsUrl,
  closeTerminalSession,
  createTerminalSession,
  decodeTerminalChunk,
  resolveTerminalHttpBase,
  resolveTerminalToken,
  resolveTerminalType,
} from './client.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function emit(hook, payload) {
  if (typeof hook !== 'function') return;
  try { hook(payload); } catch { }
}

function randomId(prefix = 'terminal') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function toBool(value, fallback) {
  if (value === undefined) return fallback;
  return !!value;
}

function toNumber(value, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function trimOutputText(text, { tailLines = 0, maxOutputChars = 0 } = {}) {
  let out = String(text || '');
  if (tailLines > 0) {
    const lines = out.split(/\r?\n/);
    if (lines.length > tailLines) out = lines.slice(-tailLines).join('\n');
  }
  if (maxOutputChars > 0 && out.length > maxOutputChars) {
    out = out.slice(-maxOutputChars);
  }
  while (out.endsWith('\n') || out.endsWith('\r')) {
    out = out.slice(0, -1);
  }
  return out;
}

function shouldTimeoutCode(err) {
  const code = String(err?.code || '').toUpperCase();
  if (code === 'TIMEOUT') return true;
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('timed out');
}

function resolveExecutionMode({ interactive = false, sessionMode = '' } = {}) {
  const mode = String(sessionMode || '').trim().toLowerCase();
  if (mode === 'exec') return 'exec';
  if (mode === 'pty') return 'pty';
  if (mode === 'tmux_control') return 'tmux_control';
  return interactive ? 'pty' : 'exec';
}

function normalizeTextEncoding(raw = 'utf8') {
  const enc = String(raw || '').trim().toLowerCase();
  if (!enc) return 'utf8';
  if (enc === 'utf8' || enc === 'utf-8') return 'utf8';
  if (enc === 'utf16le' || enc === 'utf-16le') return 'utf16le';
  if (enc === 'latin1' || enc === 'iso-8859-1') return 'latin1';
  return 'utf8';
}

function decodeBufferChunk(chunk, encoding = 'utf8') {
  if (chunk == null) return '';
  if (typeof chunk === 'string') return chunk;
  if (!Buffer.isBuffer(chunk)) return String(chunk || '');
  const rawEnc = String(encoding || '').trim().toLowerCase();
  if (rawEnc === 'gbk' || rawEnc === 'gb2312' || rawEnc === 'gb18030') {
    try {
      return iconv.decode(chunk, 'gbk');
    } catch { }
  }
  const enc = normalizeTextEncoding(rawEnc);
  try {
    return chunk.toString(enc);
  } catch {
    return chunk.toString('utf8');
  }
}

function hasOctalTriplet(str, start) {
  if ((start + 2) >= str.length) return false;
  const c1 = str.charCodeAt(start);
  const c2 = str.charCodeAt(start + 1);
  const c3 = str.charCodeAt(start + 2);
  const isOct = (c) => c >= 48 && c <= 55;
  return isOct(c1) && isOct(c2) && isOct(c3);
}

function decodeTmuxControlText(text) {
  const input = String(text || '');
  if (!input) return '';
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    if ((i + 1) >= input.length) {
      out += '\\';
      continue;
    }
    const n = input[i + 1];
    if (n === '\\') {
      out += '\\';
      i += 1;
      continue;
    }
    if (n === 'n') {
      out += '\n';
      i += 1;
      continue;
    }
    if (n === 'r') {
      out += '\r';
      i += 1;
      continue;
    }
    if (n === 't') {
      out += '\t';
      i += 1;
      continue;
    }
    if (hasOctalTriplet(input, i + 1)) {
      const oct = input.slice(i + 1, i + 4);
      const code = Number.parseInt(oct, 8);
      out += String.fromCharCode(Number.isFinite(code) ? code : 0);
      i += 3;
      continue;
    }
    out += n;
    i += 1;
  }
  return out;
}

function findDoneMarker(text = '') {
  const needle = '__SENTRA_DONE__:';
  const idx = String(text || '').lastIndexOf(needle);
  if (idx < 0) return null;
  const s = String(text || '');
  let i = idx + needle.length;
  let sign = 1;
  if (s[i] === '-') {
    sign = -1;
    i += 1;
  }
  let numText = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) break;
    numText += s[i];
    i += 1;
  }
  if (!numText) return null;
  const parsed = Number.parseInt(numText, 10);
  if (!Number.isFinite(parsed)) return null;
  return sign * parsed;
}

function stripDoneMarkerLines(text = '') {
  const s = String(text || '');
  if (!s) return '';
  const needle = '__SENTRA_DONE__:';
  let out = '';
  let cursor = 0;
  while (cursor < s.length) {
    const markerIdx = s.indexOf(needle, cursor);
    if (markerIdx < 0) {
      out += s.slice(cursor);
      break;
    }
    const lineStart = s.lastIndexOf('\n', markerIdx);
    const start = lineStart >= 0 ? lineStart + 1 : 0;
    out += s.slice(cursor, start);
    const lineEnd = s.indexOf('\n', markerIdx);
    if (lineEnd < 0) {
      cursor = s.length;
      break;
    }
    cursor = lineEnd + 1;
  }
  return out;
}

async function loadTerminalProjectorCtor() {
  try {
    const mod = await import('@xterm/headless');
    if (typeof mod?.Terminal === 'function') return mod.Terminal;
    if (typeof mod?.default?.Terminal === 'function') return mod.default.Terminal;
    if (typeof mod?.default === 'function') return mod.default;
  } catch { }
  try {
    const mod = await import('xterm-headless');
    if (typeof mod?.Terminal === 'function') return mod.Terminal;
    if (typeof mod?.default?.Terminal === 'function') return mod.default.Terminal;
    if (typeof mod?.default === 'function') return mod.default;
  } catch { }
  return null;
}

async function projectTerminalOutput(raw = '', opts = {}) {
  const text = String(raw || '');
  if (!text) return text;
  const TerminalCtor = await loadTerminalProjectorCtor();
  if (!TerminalCtor) return text;

  const cols = Math.max(40, Math.min(500, Number(opts.cols || 160) || 160));
  const rows = Math.max(10, Math.min(500, Number(opts.rows || 120) || 120));
  let term = null;
  try {
    term = new TerminalCtor({
      cols,
      rows,
      scrollback: 100000,
      convertEol: true,
      allowProposedApi: true
    });
    await new Promise((resolve) => {
      try {
        term.write(text, () => resolve());
      } catch {
        resolve();
      }
    });
    const active = term?.buffer?.active;
    if (!active || typeof active.length !== 'number' || typeof active.getLine !== 'function') {
      return text;
    }
    const lines = [];
    for (let i = 0; i < active.length; i += 1) {
      const line = active.getLine(i);
      if (!line || typeof line.translateToString !== 'function') continue;
      lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  } catch {
    return text;
  } finally {
    try { term?.dispose?.(); } catch { }
  }
}

async function createSessionWithRetry({ httpBase, token, shellType, cwd }, retries = 2) {
  let lastErr = null;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await createTerminalSession({ httpBase, token, shellType, cwd });
    } catch (e) {
      lastErr = e;
      if (i >= retries) break;
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr || new Error('Failed to create terminal session');
}

async function closeSessionWithRetry({ httpBase, token, sessionId }, retries = 2) {
  let lastErr = null;
  for (let i = 0; i <= retries; i += 1) {
    try {
      await closeTerminalSession({ httpBase, token, sessionId });
      return;
    } catch (e) {
      lastErr = e;
      if (i >= retries) break;
      await sleep(200 * (i + 1));
    }
  }
  if (lastErr) throw lastErr;
}

function normalizeCommandInput(params = {}, options = {}) {
  const p = (params && typeof params === 'object') ? params : {};
  const opts = (options && typeof options === 'object') ? options : {};
  const command = String(p.command || p.cmd || '').trim();
  const httpBase = resolveTerminalHttpBase(p.httpBase || p.baseUrl || opts.httpBase || opts.baseUrl);
  const token = resolveTerminalToken(p.token || opts.token);
  const terminalType = resolveTerminalType(p.terminalType || p.shellType || opts.terminalType || opts.shellType);
  const interactive = toBool(
    p.interactive !== undefined ? p.interactive : (opts.interactive !== undefined ? opts.interactive : false),
    false
  );
  const sessionMode = String(
    p.sessionMode
    || p.session_mode
    || opts.sessionMode
    || opts.session_mode
    || ''
  ).trim().toLowerCase();
  const executionMode = resolveExecutionMode({ interactive, sessionMode });
  const cwd = String(p.cwd || opts.cwd || '').trim();
  const timeoutMs = toNumber(p.timeoutMs, 180000, 1000, 900000);
  const expectExit = toBool(p.expectExit, true);
  const stopSignal = String(p.stopSignal || '').trim().toLowerCase() || 'ctrl_c';
  const closeOnFinish = toBool(p.closeOnFinish, true);
  const encoding = String(p.encoding || opts.encoding || 'utf8').trim().toLowerCase() || 'utf8';
  const maxOutputChars = toNumber(p.maxOutputChars, 0, 0, 2_000_000);
  const tailLines = toNumber(p.tailLines, 0, 0, 200000);
  return {
    command,
    httpBase,
    token,
    terminalType,
    interactive,
    sessionMode,
    executionMode,
    cwd,
    timeoutMs,
    expectExit,
    stopSignal,
    closeOnFinish,
    encoding,
    maxOutputChars,
    tailLines
  };
}

function buildExecLaunch(terminalType, command) {
  const shell = resolveTerminalType(terminalType);
  if (shell === 'powershell') {
    return {
      file: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    };
  }
  if (shell === 'cmd') {
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  if (shell === 'zsh') return { file: 'zsh', args: ['-lc', command] };
  if (shell === 'sh') return { file: 'sh', args: ['-lc', command] };
  return { file: 'bash', args: ['-lc', command] };
}

function terminateChildProcess(child, stopSignal = 'ctrl_c') {
  if (!child || typeof child.kill !== 'function') return;
  const mode = String(stopSignal || '').trim().toLowerCase();
  try {
    if (mode === 'ctrl_c') {
      child.kill('SIGINT');
      return;
    }
    child.kill('SIGTERM');
  } catch { }
}

async function runTmuxControlCommand(argv = [], opts = {}) {
  const cwd = opts?.cwd || process.cwd();
  const timeoutMs = toNumber(opts?.timeoutMs, 30000, 1000, 900000);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('tmux', argv, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const settle = (fn, payload) => {
      if (settled) return;
      settled = true;
      try { clearTimeout(timer); } catch { }
      fn(payload);
    };
    const timer = setTimeout(() => {
      terminateChildProcess(child, 'none');
      const err = new Error(`tmux command timeout after ${timeoutMs}ms`);
      err.code = 'TIMEOUT';
      settle(reject, err);
    }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += decodeBufferChunk(d, 'utf8'); });
    child.stderr?.on('data', (d) => { stderr += decodeBufferChunk(d, 'utf8'); });
    child.on('error', (e) => settle(reject, e));
    child.on('close', (code) => {
      if (Number(code || 0) !== 0) {
        settle(reject, new Error(stderr || stdout || `tmux command failed (${code})`));
        return;
      }
      settle(resolve, { stdout, stderr });
    });
  });
}

async function runViaExec(normalized, { onEvent, upstreamSignal }) {
  const startedAt = Date.now();
  const sessionId = randomId('exec');
  const launch = buildExecLaunch(normalized.terminalType, normalized.command);
  let output = '';
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let timedOut = false;
  let aborted = false;

  emit(onEvent, {
    type: 'session_created',
    sessionId,
    executionMode: 'exec',
    terminalType: normalized.terminalType,
    cwd: normalized.cwd || undefined
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(launch.file, launch.args, {
      cwd: normalized.cwd || process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const settle = (fn, payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(payload);
    };

    const onAbort = () => {
      aborted = true;
      terminateChildProcess(child, normalized.stopSignal);
      const err = upstreamSignal?.reason || makeAbortError('runTerminalCommand (exec) aborted');
      settle(reject, err);
    };

    const cleanup = () => {
      try { clearTimeout(timer); } catch { }
      if (upstreamSignal) {
        try { upstreamSignal.removeEventListener('abort', onAbort); } catch { }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      emit(onEvent, { type: 'timeout', timeoutMs: normalized.timeoutMs, executionMode: 'exec' });
      terminateChildProcess(child, normalized.stopSignal);
      if (normalized.expectExit) {
        const err = new Error(`Command timeout after ${normalized.timeoutMs}ms`);
        err.code = 'TIMEOUT';
        settle(reject, err);
        return;
      }
      settle(resolve);
    }, normalized.timeoutMs);

    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        onAbort();
        return;
      }
      upstreamSignal.addEventListener('abort', onAbort, { once: true });
    }

    emit(onEvent, {
      type: 'command_sent',
      command: normalized.command,
      expectExit: normalized.expectExit,
      executionMode: 'exec'
    });

    child.stdout?.on('data', (chunk) => {
      const delta = decodeBufferChunk(chunk, normalized.encoding);
      if (!delta) return;
      output += delta;
      emit(onEvent, {
        type: 'stdout',
        delta,
        outputLength: output.length,
        executionMode: 'exec'
      });
    });

    child.stderr?.on('data', (chunk) => {
      const delta = decodeBufferChunk(chunk, normalized.encoding);
      if (!delta) return;
      output += delta;
      emit(onEvent, {
        type: 'stderr',
        delta,
        outputLength: output.length,
        executionMode: 'exec'
      });
    });

    child.on('error', (e) => {
      settle(reject, e);
    });

    child.on('close', (code, signal) => {
      exited = true;
      exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
      exitSignal = signal != null ? String(signal) : null;
      emit(onEvent, { type: 'exit', exitCode, signal: exitSignal, executionMode: 'exec' });
      settle(resolve);
    });
  });

  const finalOutput = trimOutputText(output, {
    tailLines: normalized.tailLines,
    maxOutputChars: normalized.maxOutputChars
  });

  emit(onEvent, { type: 'session_closed', sessionId, executionMode: 'exec' });
  return {
    sessionId,
    executionMode: 'exec',
    terminalType: normalized.terminalType,
    cwd: normalized.cwd || undefined,
    command: normalized.command,
    exited,
    exitCode,
    signal: exitSignal,
    timedOut,
    aborted,
    output: finalOutput,
    outputLength: finalOutput.length,
    durationMs: Date.now() - startedAt,
    httpBase: normalized.httpBase
  };
}

async function runViaPty(normalized, { onEvent, upstreamSignal }) {
  if (!normalized.token) {
    return fail('Missing SECURITY_TOKEN for sentra-config-ui terminal executor.', 'CONFIG', {
      detail: { httpBase: normalized.httpBase }
    });
  }

  const startedAt = Date.now();
  let sessionId = '';
  let ws = null;
  let rawOutput = '';
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let timedOut = false;
  let aborted = false;

  try {
    if (upstreamSignal?.aborted) {
      throw upstreamSignal.reason || makeAbortError('runTerminalCommand aborted before start');
    }

    sessionId = await createSessionWithRetry({
      httpBase: normalized.httpBase,
      token: normalized.token,
      shellType: normalized.terminalType,
      cwd: normalized.cwd
    });
    emit(onEvent, {
      type: 'session_created',
      sessionId,
      executionMode: 'pty',
      terminalType: normalized.terminalType,
      cwd: normalized.cwd || undefined
    });

    const wsUrl = buildTerminalWsUrl(normalized.httpBase, sessionId, normalized.token, 0);
    ws = new WebSocket(wsUrl);
    const sendInput = (data) => {
      if (!data) return;
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      } catch { }
    };

    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      const timer = setTimeout(() => {
        if (normalized.expectExit) {
          const err = new Error(`Command timeout after ${normalized.timeoutMs}ms`);
          err.code = 'TIMEOUT';
          settle(reject, err);
          return;
        }
        timedOut = true;
        emit(onEvent, { type: 'timeout', timeoutMs: normalized.timeoutMs, executionMode: 'pty' });
        settle(resolve);
      }, normalized.timeoutMs);

      const onAbort = () => {
        aborted = true;
        const err = upstreamSignal?.reason || makeAbortError('runTerminalCommand aborted');
        settle(reject, err);
      };
      if (upstreamSignal) {
        if (upstreamSignal.aborted) {
          onAbort();
          return;
        }
        upstreamSignal.addEventListener('abort', onAbort, { once: true });
      }

      const cleanup = () => {
        try { clearTimeout(timer); } catch { }
        if (upstreamSignal) {
          try { upstreamSignal.removeEventListener('abort', onAbort); } catch { }
        }
      };

      ws.on('open', () => {
        const payload = buildExecPayload(normalized.command, normalized.terminalType, normalized.expectExit);
        sendInput(payload);
        emit(onEvent, {
          type: 'command_sent',
          command: normalized.command,
          expectExit: normalized.expectExit,
          executionMode: 'pty'
        });
      });

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw || ''));
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;

        if ((msg.type === 'init' || msg.type === 'data') && msg.data != null) {
          const chunk = decodeTerminalChunk(msg.data, normalized.encoding);
          if (!chunk) return;
          rawOutput += chunk;
          emit(onEvent, {
            type: 'stdout',
            delta: chunk,
            outputLength: rawOutput.length,
            cursor: Number(msg.cursor || 0) || undefined,
            executionMode: 'pty'
          });
          return;
        }

        if (msg.type === 'exit') {
          exited = true;
          exitCode = Number.isFinite(Number(msg.exitCode)) ? Number(msg.exitCode) : null;
          exitSignal = Number.isFinite(Number(msg.signal)) ? Number(msg.signal) : null;
          emit(onEvent, { type: 'exit', exitCode, signal: exitSignal, executionMode: 'pty' });
          settle(resolve);
          return;
        }

        if (msg.type === 'error') {
          settle(reject, new Error(String(msg.message || 'terminal ws error')));
        }
      });

      ws.on('error', (e) => {
        settle(reject, e);
      });

      ws.on('close', () => {
        if (settled || exited || timedOut || aborted) return;
        settle(reject, new Error('terminal websocket closed before receiving exit event'));
      });
    });

    if (!normalized.expectExit && !exited && normalized.stopSignal === 'ctrl_c') {
      sendInput(buildCtrlCPayload());
      emit(onEvent, { type: 'stop_signal_sent', signal: 'ctrl_c', executionMode: 'pty' });
      await sleep(80);
    }

    const projectedOutput = await projectTerminalOutput(rawOutput, {});
    const finalOutput = trimOutputText(projectedOutput, {
      tailLines: normalized.tailLines,
      maxOutputChars: normalized.maxOutputChars
    });

    return ok({
      sessionId,
      executionMode: 'pty',
      terminalType: normalized.terminalType,
      cwd: normalized.cwd || undefined,
      command: normalized.command,
      exited,
      exitCode,
      signal: exitSignal,
      timedOut,
      output: finalOutput,
      outputLength: finalOutput.length,
      durationMs: Date.now() - startedAt,
      httpBase: normalized.httpBase
    });
  } catch (e) {
    const code = shouldTimeoutCode(e) ? 'TIMEOUT' : (aborted ? 'ABORTED' : 'ERR');
    logger.warn?.('runtime_terminal_command_failed', {
      label: 'RUNTIME',
      code,
      error: String(e?.message || e),
      sessionId: sessionId || '',
      executionMode: 'pty',
      terminalType: normalized.terminalType
    });
    emit(onEvent, {
      type: 'error',
      code,
      message: String(e?.message || e),
      sessionId: sessionId || undefined,
      executionMode: 'pty'
    });
    return fail(e, code, {
      detail: {
        sessionId: sessionId || undefined,
        terminalType: normalized.terminalType,
        executionMode: 'pty',
        httpBase: normalized.httpBase
      }
    });
  } finally {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    } catch { }

    if (normalized.closeOnFinish && sessionId) {
      try {
        await sleep(50);
        await closeSessionWithRetry({
          httpBase: normalized.httpBase,
          token: normalized.token,
          sessionId
        });
        emit(onEvent, { type: 'session_closed', sessionId, executionMode: 'pty' });
      } catch (e) {
        emit(onEvent, { type: 'session_close_failed', sessionId, error: String(e?.message || e), executionMode: 'pty' });
      }
    }
  }
}

async function runViaTmuxControl(normalized, { onEvent, upstreamSignal }) {
  if (process.platform === 'win32') {
    return fail('tmux_control is not supported on Windows', 'UNSUPPORTED', {
      detail: { executionMode: 'tmux_control' }
    });
  }

  const startedAt = Date.now();
  const sessionId = randomId('tmux');
  const tmuxSessionName = `sentra_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const wrappedCommand = `${normalized.command}; printf "__SENTRA_DONE__:%s\\n" "$?"`;
  let controlProc = null;
  let rawOutput = '';
  let stderrOutput = '';
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let timedOut = false;
  let aborted = false;

  try {
    if (upstreamSignal?.aborted) {
      throw upstreamSignal.reason || makeAbortError('runTerminalCommand aborted before tmux start');
    }

    await runTmuxControlCommand(['-V'], { cwd: normalized.cwd, timeoutMs: 5000 });
    await runTmuxControlCommand(['new-session', '-d', '-s', tmuxSessionName, wrappedCommand], {
      cwd: normalized.cwd,
      timeoutMs: 15000
    });

    emit(onEvent, {
      type: 'session_created',
      sessionId,
      executionMode: 'tmux_control',
      tmuxSession: tmuxSessionName,
      terminalType: normalized.terminalType,
      cwd: normalized.cwd || undefined
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      let lineBuffer = '';

      const settle = (fn, payload) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(payload);
      };

      const cleanup = () => {
        try { clearTimeout(timer); } catch { }
        if (upstreamSignal) {
          try { upstreamSignal.removeEventListener('abort', onAbort); } catch { }
        }
      };

      const onAbort = () => {
        aborted = true;
        try { controlProc?.stdin?.write(`kill-session -t ${tmuxSessionName}\n`); } catch { }
        try { controlProc?.stdin?.write('detach-client\n'); } catch { }
        try { terminateChildProcess(controlProc, normalized.stopSignal); } catch { }
        const err = upstreamSignal?.reason || makeAbortError('runTerminalCommand (tmux_control) aborted');
        settle(reject, err);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        emit(onEvent, { type: 'timeout', timeoutMs: normalized.timeoutMs, executionMode: 'tmux_control' });
        try { controlProc?.stdin?.write(`kill-session -t ${tmuxSessionName}\n`); } catch { }
        try { controlProc?.stdin?.write('detach-client\n'); } catch { }
        terminateChildProcess(controlProc, normalized.stopSignal);
        if (normalized.expectExit) {
          const err = new Error(`Command timeout after ${normalized.timeoutMs}ms`);
          err.code = 'TIMEOUT';
          settle(reject, err);
          return;
        }
        settle(resolve);
      }, normalized.timeoutMs);

      if (upstreamSignal) {
        if (upstreamSignal.aborted) {
          onAbort();
          return;
        }
        upstreamSignal.addEventListener('abort', onAbort, { once: true });
      }

      controlProc = spawn('tmux', ['-C', 'attach-session', '-t', tmuxSessionName], {
        cwd: normalized.cwd || process.cwd(),
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      emit(onEvent, {
        type: 'command_sent',
        command: normalized.command,
        expectExit: normalized.expectExit,
        executionMode: 'tmux_control'
      });

      const processControlLine = (line) => {
        const text = String(line || '').trimEnd();
        if (!text) return;
        emit(onEvent, { type: 'tmux_event', line: text, executionMode: 'tmux_control' });
        if (!text.startsWith('%output ')) return;
        const first = text.indexOf(' ');
        const second = text.indexOf(' ', first + 1);
        if (second < 0) return;
        const payload = text.slice(second + 1);
        const decoded = decodeTmuxControlText(payload);
        if (!decoded) return;
        rawOutput += decoded;
        emit(onEvent, {
          type: 'stdout',
          delta: decoded,
          outputLength: rawOutput.length,
          executionMode: 'tmux_control'
        });
        const markerCode = findDoneMarker(rawOutput);
        if (markerCode != null) {
          exitCode = markerCode;
          exited = true;
          try { controlProc?.stdin?.write(`kill-session -t ${tmuxSessionName}\n`); } catch { }
          try { controlProc?.stdin?.write('detach-client\n'); } catch { }
        }
      };

      controlProc.stdout?.on('data', (chunk) => {
        const part = decodeBufferChunk(chunk, 'utf8');
        if (!part) return;
        lineBuffer += part;
        while (true) {
          const nl = lineBuffer.indexOf('\n');
          if (nl < 0) break;
          const line = lineBuffer.slice(0, nl);
          lineBuffer = lineBuffer.slice(nl + 1);
          processControlLine(line);
        }
      });

      controlProc.stderr?.on('data', (chunk) => {
        const part = decodeBufferChunk(chunk, 'utf8');
        if (!part) return;
        stderrOutput += part;
        emit(onEvent, {
          type: 'stderr',
          delta: part,
          outputLength: stderrOutput.length,
          executionMode: 'tmux_control'
        });
      });

      controlProc.on('error', (e) => settle(reject, e));
      controlProc.on('close', (code, signal) => {
        if (lineBuffer) {
          processControlLine(lineBuffer);
          lineBuffer = '';
        }
        exitSignal = signal != null ? String(signal) : null;
        if (!exited) {
          exited = true;
          const markerCode = findDoneMarker(rawOutput);
          if (markerCode != null) {
            exitCode = markerCode;
          } else {
            exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
          }
        }
        emit(onEvent, { type: 'exit', exitCode, signal: exitSignal, executionMode: 'tmux_control' });
        settle(resolve);
      });
    });

    const projectedOutput = await projectTerminalOutput(stripDoneMarkerLines(rawOutput), {});
    const finalOutput = trimOutputText(projectedOutput, {
      tailLines: normalized.tailLines,
      maxOutputChars: normalized.maxOutputChars
    });

    return ok({
      sessionId,
      executionMode: 'tmux_control',
      tmuxSession: tmuxSessionName,
      terminalType: normalized.terminalType,
      cwd: normalized.cwd || undefined,
      command: normalized.command,
      exited,
      exitCode,
      signal: exitSignal,
      timedOut,
      aborted,
      output: finalOutput,
      outputLength: finalOutput.length,
      durationMs: Date.now() - startedAt,
      httpBase: normalized.httpBase
    });
  } catch (e) {
    const code = shouldTimeoutCode(e) ? 'TIMEOUT' : (aborted ? 'ABORTED' : 'ERR');
    logger.warn?.('runtime_terminal_command_failed', {
      label: 'RUNTIME',
      code,
      error: String(e?.message || e),
      sessionId,
      executionMode: 'tmux_control',
      terminalType: normalized.terminalType
    });
    emit(onEvent, {
      type: 'error',
      code,
      message: String(e?.message || e),
      sessionId,
      executionMode: 'tmux_control'
    });
    return fail(e, code, {
      detail: {
        sessionId,
        terminalType: normalized.terminalType,
        executionMode: 'tmux_control',
        tmuxSession: tmuxSessionName
      }
    });
  } finally {
    try {
      await runTmuxControlCommand(['kill-session', '-t', tmuxSessionName], {
        cwd: normalized.cwd,
        timeoutMs: 5000
      });
    } catch { }
    emit(onEvent, { type: 'session_closed', sessionId, executionMode: 'tmux_control' });
  }
}

export async function runTerminalCommand(params = {}, options = {}) {
  const onEvent = (options && typeof options === 'object' && typeof options.onEvent === 'function')
    ? options.onEvent
    : ((options && typeof options === 'object' && typeof options.onStream === 'function') ? options.onStream : null);

  const normalized = normalizeCommandInput(params, options);
  if (!normalized.command) {
    return fail('command/cmd is required', 'INVALID');
  }
  const upstreamSignal = mergeAbortSignals([params?.signal, options?.signal]);

  try {
    if (upstreamSignal?.aborted) {
      throw upstreamSignal.reason || makeAbortError('runTerminalCommand aborted before start');
    }

    let runRes = null;
    if (normalized.executionMode === 'exec') {
      const data = await runViaExec(normalized, { onEvent, upstreamSignal });
      runRes = ok(data);
    } else if (normalized.executionMode === 'tmux_control') {
      runRes = await runViaTmuxControl(normalized, { onEvent, upstreamSignal });
    } else {
      runRes = await runViaPty(normalized, { onEvent, upstreamSignal });
    }

    if (!runRes?.success) return runRes;

    const terminalData = (runRes.data && typeof runRes.data === 'object') ? runRes.data : {};
    const expectExit = normalized.expectExit !== false;
    const exited = terminalData.exited === true;
    const exitCodeRaw = terminalData.exitCode;
    const exitCode = Number.isFinite(Number(exitCodeRaw)) ? Number(exitCodeRaw) : null;
    if (expectExit && exited && exitCode !== null && exitCode !== 0) {
      const message = `Command exited with non-zero code (${exitCode}).`;
      return fail(message, 'EXIT_NON_ZERO', {
        data: terminalData,
        detail: {
          exitCode,
          executionMode: terminalData.executionMode || normalized.executionMode,
          terminalType: terminalData.terminalType || normalized.terminalType,
          command: terminalData.command || normalized.command
        }
      });
    }

    return runRes;
  } catch (e) {
    const code = shouldTimeoutCode(e) ? 'TIMEOUT' : 'ERR';
    logger.warn?.('runtime_terminal_command_failed', {
      label: 'RUNTIME',
      code,
      error: String(e?.message || e),
      executionMode: normalized.executionMode,
      terminalType: normalized.terminalType
    });
    emit(onEvent, {
      type: 'error',
      code,
      message: String(e?.message || e),
      executionMode: normalized.executionMode
    });
    return fail(e, code, {
      detail: {
        terminalType: normalized.terminalType,
        executionMode: normalized.executionMode,
        httpBase: normalized.httpBase
      }
    });
  }
}

export default {
  runTerminalCommand
};

