import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TERMINAL_RUNTIME_AI_NAME = 'runtime__terminal_task';
export const TERMINAL_RUNTIME_ACTION = 'terminal.run';
export const TERMINAL_RUNTIME_PINNED_INDEX = 4;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const managerConfigPath = path.resolve(__dirname, 'manager.config.json');

const FALLBACK_ARG_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      minLength: 1,
      description: 'Executable shell command. Must match terminalType syntax. If terminalType is omitted, runtime default is powershell on Windows and bash on Unix-like systems.'
    },
    terminalType: {
      type: 'string',
      enum: ['powershell', 'cmd', 'bash', 'zsh', 'sh'],
      description: 'Target shell dialect used to execute command. Choose explicitly when command syntax is shell-specific.'
    },
    cwd: { type: 'string' },
    interactive: { type: 'boolean' },
    sessionMode: { type: 'string', enum: ['exec', 'pty', 'tmux_control'] },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 900000 },
    expectExit: { type: 'boolean' },
    stopSignal: { type: 'string', enum: ['ctrl_c', 'none'] },
    closeOnFinish: { type: 'boolean' },
    encoding: { type: 'string' },
    maxOutputChars: { type: 'integer', minimum: 0, maximum: 2000000 },
    tailLines: { type: 'integer', minimum: 0, maximum: 200000 }
  },
  required: ['command'],
  additionalProperties: false
};

let cachedSchema = null;

function safeClone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function readManagerArgSchema() {
  try {
    const raw = fs.readFileSync(managerConfigPath, 'utf-8');
    const parsed = JSON.parse(String(raw || '{}').replace(/^\uFEFF/, ''));
    const schema = parsed?.argSchema;
    if (schema && typeof schema === 'object') return schema;
  } catch { }
  return FALLBACK_ARG_SCHEMA;
}

export function getTerminalTaskArgSchema() {
  if (!cachedSchema) {
    cachedSchema = safeClone(readManagerArgSchema()) || safeClone(FALLBACK_ARG_SCHEMA);
  }
  return safeClone(cachedSchema) || safeClone(FALLBACK_ARG_SCHEMA);
}

export function buildTerminalRuntimeManifestEntry() {
  return {
    aiName: TERMINAL_RUNTIME_AI_NAME,
    name: 'sentra_terminal_task',
    provider: 'runtime',
    executor: 'sandbox',
    actionRef: TERMINAL_RUNTIME_ACTION,
    description: 'Execute workspace terminal commands via Sentra runtime sandbox.',
    inputSchema: getTerminalTaskArgSchema(),
    meta: {
      runtimeExecutor: true,
      actionRef: TERMINAL_RUNTIME_ACTION
    },
    skillDoc: {
      whenToUse: [
        'Need local workspace shell actions (read/write files, run scripts, inspect repo state).',
        'Need command output (stdout/stderr/exit code) as execution evidence.',
        'Need command-oriented operations where shell syntax can be specified precisely.'
      ],
      whenNotToUse: [
        'Task is fully covered by a structured MCP plugin and shell execution adds no value.',
        'Need remote external capability that terminal command cannot access in current runtime.',
        'Cannot provide shell-correct command syntax for the chosen terminalType.'
      ],
      successCriteria: [
        'Success requires terminal execution to finish with success=true and a successful status code.',
        'Command evidence should include exitCode=0 when available; if exitCode is unavailable, use runtime success plus non-failure evidence.',
        'Produced stdout/stderr evidence must match the requested shell action outcome.',
        'Retry policy: transient execution errors may retry_same once; arg/schema mismatch should retry_regen; repeated TIMEOUT with near-identical args should move to retry_regen or replan.'
      ]
    }
  };
}

export function pinTerminalRuntimeInManifest(manifest = [], options = {}) {
  const list = Array.isArray(manifest) ? manifest.filter(Boolean) : [];
  const insertIfMissing = options?.insertIfMissing === true;

  let runtimeEntry = list.find((item) => String(item?.aiName || '').trim() === TERMINAL_RUNTIME_AI_NAME) || null;
  if (!runtimeEntry && insertIfMissing) {
    runtimeEntry = buildTerminalRuntimeManifestEntry();
  }

  const others = list.filter((item) => String(item?.aiName || '').trim() !== TERMINAL_RUNTIME_AI_NAME);
  if (!runtimeEntry) return others;

  const index = Math.max(0, Math.min(TERMINAL_RUNTIME_PINNED_INDEX, others.length));
  return [
    ...others.slice(0, index),
    runtimeEntry,
    ...others.slice(index)
  ];
}

export function isTerminalRuntimeStep(step = {}) {
  const s = (step && typeof step === 'object') ? step : {};
  const aiName = String(s.aiName || '').trim();
  const actionRef = String(s.actionRef || s.action || '').trim().toLowerCase();
  const executor = String(s.executor || '').trim().toLowerCase();
  if (aiName === TERMINAL_RUNTIME_AI_NAME) return true;
  if (executor === 'sandbox' && actionRef === TERMINAL_RUNTIME_ACTION) return true;
  return false;
}

export default {
  TERMINAL_RUNTIME_AI_NAME,
  TERMINAL_RUNTIME_ACTION,
  TERMINAL_RUNTIME_PINNED_INDEX,
  getTerminalTaskArgSchema,
  buildTerminalRuntimeManifestEntry,
  pinTerminalRuntimeInManifest,
  isTerminalRuntimeStep
};
