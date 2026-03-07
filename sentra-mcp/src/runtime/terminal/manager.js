import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../../logger/index.js';
import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { validateAndRepairArgs } from '../../utils/schema.js';
import { parseFunctionCalls } from '../../utils/fc.js';
import { fail, ok } from '../../utils/result.js';
import { runTerminalCommand } from './service.js';
import {
  loadTerminalPrompt,
  pickTerminalPrompt,
  renderTemplate
} from './prompt_loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');

let managerConfigCache = null;
let managerPromptCache = null;
const TERMINAL_TYPES = new Set(['powershell', 'cmd', 'bash', 'zsh', 'sh']);

async function loadManagerConfig() {
  if (managerConfigCache) return managerConfigCache;
  const file = path.resolve(__dirname, 'manager.config.json');
  const raw = await fs.readFile(file, 'utf-8');
  const text = String(raw || '{}').replace(/^\uFEFF/, '');
  managerConfigCache = JSON.parse(text);
  return managerConfigCache;
}

async function loadManagerPrompt() {
  if (managerPromptCache) return managerPromptCache;
  managerPromptCache = await loadTerminalPrompt('terminal_manager');
  return managerPromptCache;
}

function normalizeObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function toPlainText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeTerminalType(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  if (TERMINAL_TYPES.has(s)) return s;
  if (s === 'pwsh' || s === 'pw') return 'powershell';
  if (s.includes('powershell')) return 'powershell';
  if (s.includes('cmd')) return 'cmd';
  if (s.includes('zsh')) return 'zsh';
  if (s.includes('bash')) return 'bash';
  if (s === 'shell') return process.platform === 'win32' ? 'powershell' : 'bash';
  return '';
}

function normalizeDirectoryPath(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  try {
    return path.resolve(s);
  } catch {
    return '';
  }
}

function resolvePathFromRoot(candidate = '', root = '') {
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  try {
    if (path.isAbsolute(raw)) return path.resolve(raw);
    return path.resolve(root || process.cwd(), raw);
  } catch {
    return '';
  }
}

function resolveProjectContext(input = {}, cwdHint = '') {
  const source = (input && typeof input === 'object') ? input : {};
  const projectRoot = normalizeDirectoryPath(DEFAULT_WORKSPACE_ROOT) || normalizeDirectoryPath(process.cwd()) || process.cwd();
  const effectiveCwd =
    resolvePathFromRoot(source.cwd, projectRoot)
    || resolvePathFromRoot(cwdHint, projectRoot)
    || projectRoot;

  return {
    effectiveCwd,
    projectRoot,
    projectRootSource: 'sentra_mcp_parent'
  };
}

function inferTerminalTypeHint(input = {}) {
  const candidates = [
    input?.terminalType,
    input?.shellType,
    input?.terminalHint,
    input?.shellHint
  ];
  for (const value of candidates) {
    const t = normalizeTerminalType(value);
    if (t) return t;
  }
  return '';
}

function inferPlatformFamily(terminalType = '') {
  const t = normalizeTerminalType(terminalType);
  if (t === 'powershell' || t === 'cmd') return 'windows';
  if (t === 'bash' || t === 'zsh' || t === 'sh') return 'unix';
  return process.platform === 'win32' ? 'windows' : 'unix';
}

function buildDynamicPromptHints({ input = {}, cwdHint = '', terminalHint = '', projectRoot = '' } = {}) {
  const hintedType = normalizeTerminalType(terminalHint);
  const inferredType = inferTerminalTypeHint(input) || hintedType || (process.platform === 'win32' ? 'powershell' : 'bash');
  const family = inferPlatformFamily(inferredType);
  const cwdText = cwdHint || '(current working directory)';
  const rootText = String(projectRoot || '').trim() || '(project root unavailable)';

  if (family === 'windows') {
    const useCmd = inferredType === 'cmd';
    if (useCmd) {
      return {
        recommendedTerminalType: 'cmd',
        platformProfile: `Platform family: Windows. Preferred shell style: cmd.exe. Keep command syntax compatible with cmd and current cwd: ${cwdText}. Project root: ${rootText}. Prefer paths within project root unless user explicitly requests otherwise.`,
        platformExamples: [
          'List folders: dir /ad',
          'Count .env-like files recursively: dir /s /b .env* | find /c /v ""',
          'Print current directory: cd'
        ].join('\n'),
        fileWriteExamples: [
          'Write one line file: > notes.txt echo hello',
          'Append line: >> notes.txt echo world',
          'Overwrite from command output: some_command > output.txt'
        ].join('\n'),
        httpJsonExamples: [
          'Prefer PowerShell for robust UTF-8 JSON HTTP calls on Windows (cmd is not ideal for non-ASCII payloads).',
          'If cmd is mandatory, invoke powershell explicitly for HTTP JSON: powershell -NoProfile -Command "<utf8-safe script>"'
        ].join('\n')
      };
    }
    return {
      recommendedTerminalType: 'powershell',
      platformProfile: `Platform family: Windows. Preferred shell style: PowerShell. Use PowerShell-native commands and pipelines in cwd: ${cwdText}. Project root: ${rootText}. Prefer paths within project root unless user explicitly requests otherwise.`,
      platformExamples: [
        'List folders: Get-ChildItem -Directory',
        'Count .env-like files recursively: (Get-ChildItem -Path . -Recurse -File -Filter \".env*\").Count',
        'Print current directory: Get-Location'
      ].join('\n'),
      fileWriteExamples: [
        'Write full file: Set-Content -Path \"notes.txt\" -Value \"hello\" -Encoding UTF8',
        'Append line: Add-Content -Path \"notes.txt\" -Value \"world\"',
        'Write multiline here-string: @\"\\nline1\\nline2\\n\"@ | Set-Content -Path \"notes.txt\" -Encoding UTF8'
      ].join('\n'),
      httpJsonExamples: [
        'UTF-8 safe JSON HTTP template:',
        '$utf8 = [System.Text.UTF8Encoding]::new($false)',
        '[Console]::InputEncoding = $utf8',
        '[Console]::OutputEncoding = $utf8',
        '$payload = @{ key = \"value\" }',
        '$json = $payload | ConvertTo-Json -Depth 12 -Compress',
        '$bytes = $utf8.GetBytes($json)',
        '$resp = Invoke-RestMethod -Uri \"https://example.com/api\" -Method Post -Headers @{ Authorization = \"Bearer <token>\" } -ContentType \"application/json; charset=utf-8\" -Body $bytes',
        '$resp | ConvertTo-Json -Depth 20 -Compress'
      ].join('\n')
    };
  }

  return {
    recommendedTerminalType: inferredType === 'zsh' ? 'zsh' : (inferredType === 'sh' ? 'sh' : 'bash'),
    platformProfile: `Platform family: Unix-like. Preferred shell style: ${inferredType || 'bash'}. Use POSIX-friendly command syntax in cwd: ${cwdText}. Project root: ${rootText}. Prefer paths within project root unless user explicitly requests otherwise.`,
    platformExamples: [
      'List folders: ls -la',
      'Count .env-like files recursively: find . -type f -name \".env*\" | wc -l',
      'Print current directory: pwd'
    ].join('\n'),
    fileWriteExamples: [
      'Write full file: cat > notes.txt <<\'EOF\'',
      'line1',
      'line2',
      'EOF',
      'Append line: echo \"world\" >> notes.txt'
    ].join('\n'),
    httpJsonExamples: [
      'UTF-8 JSON HTTP template:',
      'payload=$(jq -cn --arg q \"hello\" \'{query:$q}\')',
      'curl -sS -X POST \"https://example.com/api\" \\',
      '  -H \"Content-Type: application/json; charset=utf-8\" \\',
      '  -H \"Authorization: Bearer <token>\" \\',
      '  --data-binary \"$payload\"'
    ].join('\n')
  };
}

function pickRequestText(input = {}) {
  return toPlainText(
    input.request
    || input.prompt
    || input.text
    || input.message
    || ''
  );
}

function normalizeDirectArgs(input = {}) {
  const obj = normalizeObject(input);
  if (obj.args && typeof obj.args === 'object') return normalizeTerminalArgs(obj.args);
  if (obj.parameters && typeof obj.parameters === 'object') return normalizeTerminalArgs(obj.parameters);
  if (obj.command || obj.cmd) return normalizeTerminalArgs(obj);
  return {};
}

function normalizeTerminalArgs(raw = {}) {
  const input = normalizeObject(raw);
  const out = { ...input };
  if (!Object.prototype.hasOwnProperty.call(out, 'terminalType') && typeof out.terminal_type === 'string') {
    out.terminalType = out.terminal_type;
  }
  if (!Object.prototype.hasOwnProperty.call(out, 'sessionMode') && typeof out.session_mode === 'string') {
    out.sessionMode = out.session_mode;
  }
  if (!Object.prototype.hasOwnProperty.call(out, 'interactive') && out.isInteractive !== undefined) {
    out.interactive = !!out.isInteractive;
  }
  delete out.terminal_type;
  delete out.session_mode;
  delete out.isInteractive;
  return out;
}

function summarizeSchemaRequirements(schema = {}) {
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const properties = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
  const propertyNames = Object.keys(properties);
  return { required, propertyNames };
}

function enrichValidationErrors(errors = [], schema = {}) {
  const errList = Array.isArray(errors) ? errors : [];
  const { required, propertyNames } = summarizeSchemaRequirements(schema);
  return {
    errors: errList,
    required,
    properties: propertyNames
  };
}

function toInferenceConfig(configJson = {}) {
  const inferCfg = normalizeObject(configJson.inference);
  const cfgTemp = Number(inferCfg.temperature);
  const cfgMaxTokens = Number(inferCfg.maxTokens);
  return {
    temperature: Number.isFinite(cfgTemp) ? cfgTemp : (config.llm?.temperature ?? 0.1),
    maxTokens: Number.isFinite(cfgMaxTokens) && cfgMaxTokens > 0 ? cfgMaxTokens : null
  };
}

function buildExecutionOverrides(source = {}, args = {}) {
  const interactiveFromSource = (
    source.interactive !== undefined
      ? source.interactive
      : (source.interactiveHint !== undefined ? source.interactiveHint : undefined)
  );
  const sessionModeFromSource = source.sessionMode || source.session_mode || source.sessionModeHint || source.session_mode_hint || '';
  return {
    ...(source.cwd && !args.cwd ? { cwd: String(source.cwd) } : {}),
    ...(source.terminalType && !args.terminalType ? { terminalType: String(source.terminalType) } : {}),
    ...(interactiveFromSource !== undefined && args.interactive === undefined ? { interactive: !!interactiveFromSource } : {}),
    ...(sessionModeFromSource && !args.sessionMode ? { sessionMode: String(sessionModeFromSource) } : {})
  };
}

function parseInferenceResult(content = '', invokeName = '') {
  const calls = parseFunctionCalls(content, {});
  const chosen = calls.find((c) => String(c?.name || '').trim() === invokeName) || calls[0];
  const args = chosen && chosen.arguments && typeof chosen.arguments === 'object'
    ? chosen.arguments
    : null;
  return { calls, chosen, args };
}

function buildParseFailureDetail({ invokeName, model, content }) {
  return {
    invokeName,
    model,
    protocol: 'sentra-tools',
    expected: `<sentra-tools><invoke name=\"${invokeName}\">...</invoke></sentra-tools>`,
    preview: String(content || '').slice(0, 600)
  };
}

function buildNlMessages({ promptBlock, requestText, invokeName, schema, input }) {
  const cwdHintRaw = toPlainText(input?.cwdHint || input?.cwd || '');
  const terminalHint = toPlainText(
    input?.terminalType
    || input?.shellType
    || input?.terminalHint
    || ''
  );
  const interactiveHint = input?.interactive !== undefined
    ? String(!!input.interactive)
    : toPlainText(input?.interactiveHint || '');
  const sessionModeHint = toPlainText(
    input?.sessionMode
    || input?.session_mode
    || input?.sessionModeHint
    || ''
  );
  const projectContext = resolveProjectContext(input, cwdHintRaw);
  const cwdHint = toPlainText(projectContext.effectiveCwd || cwdHintRaw);
  const dynamicHints = buildDynamicPromptHints({
    input,
    cwdHint,
    terminalHint,
    projectRoot: projectContext.projectRoot
  });

  const system = renderTemplate(promptBlock.system, {
    invoke_name: invokeName,
    recommended_terminal_type: dynamicHints.recommendedTerminalType,
    platform_profile: dynamicHints.platformProfile,
    project_root: projectContext.projectRoot,
    effective_cwd: projectContext.effectiveCwd,
    project_root_source: projectContext.projectRootSource
  });

  const user = renderTemplate(promptBlock.user, {
    request: requestText,
    cwd_hint: cwdHint || '(none)',
    terminal_hint: terminalHint || '(none)',
    interactive_hint: interactiveHint || '(none)',
    session_mode_hint: sessionModeHint || '(none)',
    recommended_terminal_type: dynamicHints.recommendedTerminalType,
    platform_profile: dynamicHints.platformProfile,
    platform_examples: dynamicHints.platformExamples,
    file_write_examples: dynamicHints.fileWriteExamples,
    http_json_examples: dynamicHints.httpJsonExamples,
    project_root: projectContext.projectRoot || '(none)',
    effective_cwd: projectContext.effectiveCwd || '(none)',
    project_root_source: projectContext.projectRootSource || 'unknown',
    schema_json: JSON.stringify(schema || {}, null, 2)
  });

  const messages = [
    { role: 'system', content: system }
  ];

  const examples = Array.isArray(promptBlock.examples) ? promptBlock.examples : [];
  for (const ex of examples) {
    const exRequest = renderTemplate(ex.request, {
      invoke_name: invokeName,
      schema_json: JSON.stringify(schema || {}, null, 2)
    });
    const exResponse = renderTemplate(ex.response, {
      invoke_name: invokeName
    });
    if (!exRequest.trim() || !exResponse.trim()) continue;
    messages.push({ role: 'user', content: exRequest });
    messages.push({ role: 'assistant', content: exResponse });
  }

  messages.push({ role: 'user', content: user });
  return messages;
}

async function inferArgsFromNaturalLanguage(input = {}, configJson = {}) {
  const requestText = pickRequestText(input);
  if (!requestText) return fail('request is required for natural language terminal task', 'INVALID');

  const promptJson = await loadManagerPrompt();
  const promptBlock = pickTerminalPrompt(promptJson);
  const invokeName = String(configJson.invokeName || 'terminal_execute').trim() || 'terminal_execute';
  const schema = normalizeObject(configJson.argSchema);
  const messages = buildNlMessages({
    promptBlock,
    requestText,
    invokeName,
    schema,
    input
  });

  const provider = getStageProvider('arg');
  const model = getStageModel('arg');
  const timeoutMs = getStageTimeoutMs('arg');
  const inferConfig = toInferenceConfig(configJson);

  const res = await chatCompletion({
    messages,
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    model,
    temperature: inferConfig.temperature,
    timeoutMs,
    ...(inferConfig.maxTokens ? { max_tokens: inferConfig.maxTokens } : {})
  });

  const content = String(res?.choices?.[0]?.message?.content || '');
  const parsed = parseInferenceResult(content, invokeName);
  const args = parsed.args;

  if (!args) {
    const detail = buildParseFailureDetail({ invokeName, model, content });
    logger.warn?.('terminal_manager_infer_parse_failed', {
      label: 'RUNTIME',
      ...detail
    });
    return fail('failed to parse terminal args from model output', 'PARSE', {
      detail
    });
  }

  return ok({
    args,
    invokeName,
    model,
    contentPreview: String(content || '').slice(0, 400)
  });
}

function sanitizeTaskOptions(raw = {}) {
  const opts = normalizeObject(raw);
  const executionOptions = normalizeObject(opts.executionOptions);
  return { executionOptions };
}

function normalizeInputSource(input = {}) {
  if (typeof input === 'string') return { request: input };
  return normalizeObject(input);
}

function shouldUseNaturalLanguageMode(requestText = '', directArgs = {}) {
  return !!requestText && Object.keys(directArgs).length === 0;
}

export async function runTerminalTask(input = {}, options = {}) {
  try {
    const configJson = await loadManagerConfig();
    const invokeName = String(configJson.invokeName || 'terminal_execute').trim() || 'terminal_execute';
    const schema = normalizeObject(configJson.argSchema);
    const { executionOptions } = sanitizeTaskOptions(options);

    const source = normalizeInputSource(input);
    const requestText = pickRequestText(source);
    const directArgs = normalizeDirectArgs(source);

    let mode = 'json';
    let args = directArgs;
    let inferMeta = null;

    if (shouldUseNaturalLanguageMode(requestText, directArgs)) {
      mode = 'nl';
      const inferred = await inferArgsFromNaturalLanguage(source, configJson);
      if (!inferred.success) return inferred;
      args = normalizeTerminalArgs(inferred.data?.args);
      inferMeta = inferred.data;
    }

    const normalizedArgs = normalizeTerminalArgs({
      ...args,
      ...buildExecutionOverrides(source, args)
    });

    const checked = validateAndRepairArgs(schema, normalizedArgs);
    if (!checked.valid) {
      return fail('terminal args validation failed', 'INVALID_ARGS', {
        detail: {
          invokeName,
          ...enrichValidationErrors(checked.errors || [], schema)
        }
      });
    }

    const runRes = await runTerminalCommand(checked.output, executionOptions);
    if (!runRes.success) return runRes;

    return ok({
      mode,
      invokeName,
      resolvedArgs: checked.output,
      inference: inferMeta,
      terminal: runRes.data
    });
  } catch (error) {
    return fail(error, 'TERMINAL_TASK_FAILED');
  }
}

export default {
  runTerminalTask
};
