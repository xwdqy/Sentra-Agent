import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../../logger/index.js';
import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { HistoryStore } from '../../history/store.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { loadToolDef } from '../tools/loader.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy } from '../../utils/fc.js';
import { clip } from '../../utils/text.js';
import { truncateTextByTokens } from '../../utils/tokenizer.js';
import {
  MINI_EVAL_DECISION,
  normalizeMiniEvalDecision
} from './runtime_step_policy.js';

const FAILURE_CLASSES = new Set(['', 'transient', 'arg_schema', 'tool_failure', 'permission', 'cancelled', 'unsupported', 'unknown']);

const MINI_EVAL_RESULT_MAX_TOKENS = 800;
const MINI_EVAL_ACTION_RESULT_MAX_TOKENS = 900;
const MINI_EVAL_CRITERIA_MAX_ITEMS = 16;
const MINI_EVAL_EVIDENCE_MAX_ITEMS = 8;
const MINI_EVAL_FEWSHOT_MAX_ITEMS = 5;
const MINI_EVAL_MAX_RETRIES = 2; // 1st attempt + 1 retry
const MINI_EVAL_STEP_HISTORY_MAX_ITEMS = 20;
const MINI_EVAL_STEP_HISTORY_JSON_MAX_TOKENS = 220;
const MINI_EVAL_DEP_CONTEXT_MAX_STEPS = 10;
const MINI_EVAL_DEP_RESULT_JSON_MAX_TOKENS = 280;
const MINI_EVAL_PLUGIN_CONTEXT_MAX_ITEMS = 16;

let cachedMiniEvalDefPromise = null;
let cachedMiniEvalPromptPromise = null;
let cachedMiniEvalReinforcePromptPromise = null;

function toText(v) {
  return String(v ?? '').trim();
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeStringArray(value, maxItems = 16) {
  const src = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const text = toText(item);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function clipByTokens(value, maxTokens) {
  const text = String(value ?? '');
  const limit = Number(maxTokens);
  if (!Number.isFinite(limit) || limit <= 0) return text;
  return truncateTextByTokens(text, {
    maxTokens: Math.max(1, Math.floor(limit)),
    model: getStageModel('mini_eval'),
    suffix: '\n...[truncated]'
  }).text;
}

function normalizeStepRetryState(retryState = {}) {
  const src = (retryState && typeof retryState === 'object') ? retryState : {};
  const attempts = Number.isFinite(Number(src.attempts)) ? Math.max(0, Math.floor(Number(src.attempts))) : 0;
  const sameRetries = Number.isFinite(Number(src.sameRetries)) ? Math.max(0, Math.floor(Number(src.sameRetries))) : 0;
  const regenRetries = Number.isFinite(Number(src.regenRetries)) ? Math.max(0, Math.floor(Number(src.regenRetries))) : 0;
  const forceRegenerate = src.forceRegenerate === true;
  const lastFailure = (src.lastFailure && typeof src.lastFailure === 'object') ? src.lastFailure : null;
  return { attempts, sameRetries, regenRetries, forceRegenerate, lastFailure };
}

function collectSuccessCriteriaLines(step = {}, manifestItem = null) {
  const own = normalizeStringArray(step?.successCriteria, MINI_EVAL_CRITERIA_MAX_ITEMS);
  if (own.length > 0) return own;
  return normalizeStringArray(manifestItem?.skillDoc?.successCriteria, MINI_EVAL_CRITERIA_MAX_ITEMS);
}

function isLikelySecretKey(key = '') {
  return /(api[_-]?key|token|secret|password|passwd)/i.test(String(key || ''));
}

function maskSecret(value = '') {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-3)}`;
}

function sanitizePluginRuntimeContext(pluginEnv = {}) {
  const src = (pluginEnv && typeof pluginEnv === 'object') ? pluginEnv : {};
  const keys = Object.keys(src).filter(Boolean).sort();
  const out = {};
  for (const key of keys) {
    const raw = src[key];
    if (raw === undefined || raw === null) continue;
    const upper = String(key || '').toUpperCase();
    const include =
      /(_MODEL$|_MODE$|_MODEL_FALLBACKS$|_MODEL_FALLBACK_MODELS$|_BASE_URL$|_TIMEOUT_MS$|FAILOVER|RETRY|STATUS_CODES)/.test(upper) ||
      /(MODEL|BASE_URL|TIMEOUT|FAILOVER)/.test(upper);
    if (!include) continue;
    const value = isLikelySecretKey(upper) ? maskSecret(raw) : String(raw);
    out[key] = value;
    if (Object.keys(out).length >= MINI_EVAL_PLUGIN_CONTEXT_MAX_ITEMS) break;
  }
  return out;
}

function collectDependencyStepIds(plan = null, stepIndex = -1, step = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length || stepIndex < 0 || stepIndex >= steps.length) return [];
  const idToIndex = new Map(
    steps
      .map((s, idx) => [toText(s?.stepId), idx])
      .filter(([sid]) => !!sid)
  );
  const visited = new Set();
  const out = [];
  const dfs = (sid) => {
    const k = toText(sid);
    if (!k || visited.has(k)) return;
    visited.add(k);
    const idx = idToIndex.get(k);
    if (!Number.isFinite(idx)) return;
    if (idx >= stepIndex) return;
    const depStep = steps[idx];
    const deps = Array.isArray(depStep?.dependsOnStepIds) ? depStep.dependsOnStepIds : [];
    for (const one of deps) dfs(one);
    out.push(k);
  };
  const direct = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
  for (const sid of direct) dfs(sid);
  if (out.length <= MINI_EVAL_DEP_CONTEXT_MAX_STEPS) return out;
  return out.slice(out.length - MINI_EVAL_DEP_CONTEXT_MAX_STEPS);
}

function buildStepHistoryXml(history = [], stepIndex = -1, stepId = '') {
  const sid = toText(stepId);
  const idx = Number.isFinite(Number(stepIndex)) ? Number(stepIndex) : -1;
  const events = (Array.isArray(history) ? history : [])
    .filter((ev) => {
      if (!ev || typeof ev !== 'object') return false;
      const evSid = toText(ev?.stepId);
      const evIdx = Number.isFinite(Number(ev?.plannedStepIndex)) ? Number(ev.plannedStepIndex) : NaN;
      const sameById = sid && evSid && sid === evSid;
      const sameByIndex = idx >= 0 && Number.isFinite(evIdx) && evIdx === idx;
      return sameById || sameByIndex;
    })
    .slice(-MINI_EVAL_STEP_HISTORY_MAX_ITEMS);

  if (!events.length) return '';
  const lines = [];
  lines.push('<current_step_history>');
  for (const ev of events) {
    const type = toText(ev?.type || 'unknown');
    const payload = clipByTokens(JSON.stringify(ev, null, 2), MINI_EVAL_STEP_HISTORY_JSON_MAX_TOKENS);
    lines.push(`  <event type="${escapeXmlText(type)}">`);
    lines.push(`    ${escapeXmlText(payload)}`);
    lines.push('  </event>');
  }
  lines.push('</current_step_history>');
  return lines.join('\n');
}

function buildDependencyContextXml(history = [], depStepIds = []) {
  const ids = Array.isArray(depStepIds) ? depStepIds.map((x) => toText(x)).filter(Boolean) : [];
  if (!ids.length) return '';
  const lastByStepId = new Map();
  for (const ev of (Array.isArray(history) ? history : [])) {
    if (!ev || ev.type !== 'tool_result') continue;
    const sid = toText(ev?.stepId);
    if (!sid) continue;
    lastByStepId.set(sid, ev);
  }
  const lines = [];
  lines.push('<dependency_context>');
  let appended = 0;
  for (const sid of ids) {
    const ev = lastByStepId.get(sid);
    if (!ev) continue;
    const code = toText(ev?.result?.code || '');
    const success = ev?.result?.success === true ? 'true' : 'false';
    const aiName = toText(ev?.aiName || '');
    const resultJson = clipByTokens(
      JSON.stringify(ev?.result || {}, null, 2),
      MINI_EVAL_DEP_RESULT_JSON_MAX_TOKENS
    );
    lines.push(`  <dependency step_id="${escapeXmlText(sid)}" ai_name="${escapeXmlText(aiName)}" success="${success}" code="${escapeXmlText(code)}">`);
    lines.push(`    ${escapeXmlText(resultJson)}`);
    lines.push('  </dependency>');
    appended += 1;
    if (appended >= MINI_EVAL_DEP_CONTEXT_MAX_STEPS) break;
  }
  lines.push('</dependency_context>');
  return appended > 0 ? lines.join('\n') : '';
}

function buildMiniEvalFewShotMessages(promptDef = {}) {
  const shots = Array.isArray(promptDef?.few_shots) ? promptDef.few_shots : [];
  const selectedShots = (() => {
    if (shots.length <= MINI_EVAL_FEWSHOT_MAX_ITEMS) return shots;
    // Keep head examples and always retain the latest tail example (often edge-case/fail-fast).
    return [
      ...shots.slice(0, Math.max(0, MINI_EVAL_FEWSHOT_MAX_ITEMS - 1)),
      shots[shots.length - 1]
    ];
  })();
  const out = [];
  for (const shot of selectedShots) {
    if (!shot || typeof shot !== 'object') continue;
    const user = toText(shot.user);
    const assistant = toText(shot.assistant);
    if (!user || !assistant) continue;
    out.push({ role: 'user', content: user });
    out.push({ role: 'assistant', content: assistant });
  }
  return out;
}

function normalizeFailureClass(value) {
  const s = toText(value).toLowerCase();
  if (FAILURE_CLASSES.has(s)) return s;
  return '';
}

function normalizeDecision(value) {
  return normalizeMiniEvalDecision(value);
}

function buildMiniEvalInputXml({
  objective = '',
  step = {},
  manifestItem = null,
  pluginRuntimeContext = {},
  result = {},
  actionResult = {},
  dependencyContextXml = '',
  stepHistoryXml = '',
  retryState = {},
  argValidationFailed = false,
  attemptNo = 1,
  criteriaLines = [],
}) {
  const skillPath = toText(manifestItem?.skillDoc?.path);
  const skillBody = clipByTokens(toText(manifestItem?.skillDoc?.body || manifestItem?.skillDoc?.raw || ''), 700);
  const resultJson = clipByTokens(JSON.stringify(result || {}, null, 2), MINI_EVAL_RESULT_MAX_TOKENS);
  const actionResultJson = clipByTokens(JSON.stringify(actionResult || {}, null, 2), MINI_EVAL_ACTION_RESULT_MAX_TOKENS);
  const retryStateJson = clipByTokens(JSON.stringify(retryState || {}, null, 2), 300);
  const lines = [];
  lines.push('<step_mini_eval_input>');
  lines.push(`  <objective>${escapeXmlText(String(objective || ''))}</objective>`);
  lines.push(`  <step step_id="${escapeXmlText(toText(step?.stepId))}" ai_name="${escapeXmlText(toText(step?.aiName))}" executor="${escapeXmlText(toText(step?.executor || 'mcp'))}" action_ref="${escapeXmlText(toText(step?.actionRef || ''))}" attempt_no="${escapeXmlText(String(Math.max(1, Number(attemptNo) || 1)))}">`);
  lines.push(`    <reason>${escapeXmlText(Array.isArray(step?.reason) ? step.reason.join('; ') : toText(step?.reason))}</reason>`);
  lines.push(`    <next_step>${escapeXmlText(toText(step?.nextStep || ''))}</next_step>`);
  lines.push(`    <arg_validation_failed>${argValidationFailed === true ? 'true' : 'false'}</arg_validation_failed>`);
  lines.push('  </step>');
  lines.push('  <success_criteria>');
  if (criteriaLines.length === 0) {
    lines.push('    <line>(none)</line>');
  } else {
    for (const one of criteriaLines.slice(0, MINI_EVAL_CRITERIA_MAX_ITEMS)) {
      lines.push(`    <line>${escapeXmlText(one)}</line>`);
    }
  }
  lines.push('  </success_criteria>');
  if (skillPath) lines.push(`  <skill_doc_path>${escapeXmlText(skillPath)}</skill_doc_path>`);
  if (skillBody) {
    lines.push('  <skill_doc_excerpt>');
    lines.push(`    ${escapeXmlText(skillBody)}`);
    lines.push('  </skill_doc_excerpt>');
  }
  lines.push('  <tool_result_json>');
  lines.push(`    ${escapeXmlText(resultJson)}`);
  lines.push('  </tool_result_json>');
  lines.push('  <action_result_json>');
  lines.push(`    ${escapeXmlText(actionResultJson)}`);
  lines.push('  </action_result_json>');
  lines.push('  <retry_state_json>');
  lines.push(`    ${escapeXmlText(retryStateJson)}`);
  lines.push('  </retry_state_json>');
  const pluginRuntimeJson = clipByTokens(JSON.stringify(pluginRuntimeContext || {}, null, 2), 220);
  if (pluginRuntimeJson && pluginRuntimeJson !== '{}') {
    lines.push('  <plugin_runtime_context_json>');
    lines.push(`    ${escapeXmlText(pluginRuntimeJson)}`);
    lines.push('  </plugin_runtime_context_json>');
  }
  if (stepHistoryXml) {
    lines.push(`  ${stepHistoryXml.split('\n').join('\n  ')}`);
  }
  if (dependencyContextXml) {
    lines.push(`  ${dependencyContextXml.split('\n').join('\n  ')}`);
  }
  lines.push('</step_mini_eval_input>');
  return lines.join('\n');
}

function buildMiniEvalOutput({
  stepId = '',
  aiName = '',
  decision = '',
  failureClass = '',
  reason = '',
  confidence = null,
  failedCriteria = [],
  evidence = [],
  retryHint = '',
  criteriaLines = [],
  retryState = {},
  source = 'llm_step_mini_eval',
}) {
  const decisionNorm = normalizeDecision(decision);
  if (!decisionNorm) throw new Error('STEP_MINI_EVAL_INVALID_DECISION');
  const pass = decisionNorm === 'pass';
  const failureClassNorm = pass ? '' : normalizeFailureClass(failureClass);
  if (!pass && !failureClassNorm) throw new Error('STEP_MINI_EVAL_MISSING_FAILURE_CLASS');
  const failedSet = new Set(normalizeStringArray(failedCriteria, MINI_EVAL_EVIDENCE_MAX_ITEMS));
  const rules = normalizeStringArray(criteriaLines, MINI_EVAL_CRITERIA_MAX_ITEMS).map((line) => {
    if (pass && failedSet.size === 0) return { rule: line, pass: true };
    if (failedSet.has(line)) return { rule: line, pass: false };
    return { rule: line, pass: pass ? true : undefined };
  });
  const numericConfidence = Number(confidence);
  const confidenceOut = Number.isFinite(numericConfidence)
    ? Math.max(0, Math.min(1, Number(numericConfidence.toFixed(4))))
    : undefined;
  return {
    stepId: toText(stepId),
    aiName: toText(aiName),
    decision: decisionNorm,
    pass,
    failureClass: failureClassNorm,
    reason: toText(reason),
    ...(confidenceOut !== undefined ? { confidence: confidenceOut } : {}),
    criteria: {
      rules: rules.slice(0, MINI_EVAL_CRITERIA_MAX_ITEMS),
      total: rules.length,
      failed: rules.filter((r) => r && r.pass === false).length,
    },
    policy: {
      source: toText(source) || 'llm_step_mini_eval',
      retryHint: toText(retryHint),
      retryState: {
        attempts: Number(retryState?.attempts || 0),
        sameRetries: Number(retryState?.sameRetries || 0),
        regenRetries: Number(retryState?.regenRetries || 0),
      }
    },
    evidence: normalizeStringArray(evidence, MINI_EVAL_EVIDENCE_MAX_ITEMS)
  };
}

function buildMiniEvalSkippedOutput({
  stepId = '',
  aiName = '',
  reason = '',
  criteriaLines = [],
  retryState = {},
} = {}) {
  const rules = normalizeStringArray(criteriaLines, MINI_EVAL_CRITERIA_MAX_ITEMS).map((line) => ({
    rule: line,
    pass: undefined
  }));
  return {
    stepId: toText(stepId),
    aiName: toText(aiName),
    decision: MINI_EVAL_DECISION.pass,
    pass: true,
    failureClass: '',
    reason: toText(reason) || 'mini eval skipped due to model parse failures',
    criteria: {
      rules,
      total: rules.length,
      failed: 0,
      skipped: true
    },
    policy: {
      source: 'mini_eval_skipped',
      retryHint: '',
      retryState: {
        attempts: Number(retryState?.attempts || 0),
        sameRetries: Number(retryState?.sameRetries || 0),
        regenRetries: Number(retryState?.regenRetries || 0),
      }
    },
    evidence: []
  };
}

function logMiniEvalFcPreview({ attempt, provider, model, content, calls }) {
  const count = Array.isArray(calls) ? calls.length : 0;
  const providerInfo = { baseURL: provider?.baseURL, model };
  if (count > 0) {
    logger.info('Step mini eval parsed output', {
      label: 'MINI_EVAL',
      attempt,
      provider: providerInfo,
      count,
      firstCallName: String(calls?.[0]?.name || ''),
      firstCallPreview: clip(calls?.[0]),
      length: String(content || '').length
    });
    return;
  }
  logger.warn('Step mini eval parse failed, raw preview', {
    label: 'MINI_EVAL',
    attempt,
    provider: providerInfo,
    count: 0,
    rawPreview: clip(String(content)),
    length: String(content || '').length
  });
}

async function getMiniEvalToolDef() {
  if (!cachedMiniEvalDefPromise) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    cachedMiniEvalDefPromise = loadToolDef({
      baseDir: __dirname,
      toolPath: '../tools/internal/step_mini_eval.tool.json',
      schemaPath: '../tools/internal/step_mini_eval.schema.json'
    });
  }
  return cachedMiniEvalDefPromise;
}

async function getMiniEvalPrompt() {
  if (!cachedMiniEvalPromptPromise) {
    cachedMiniEvalPromptPromise = loadPrompt('step_mini_eval');
  }
  return cachedMiniEvalPromptPromise;
}

async function getMiniEvalReinforcePrompt() {
  if (!cachedMiniEvalReinforcePromptPromise) {
    cachedMiniEvalReinforcePromptPromise = loadPrompt('fc_reinforce_mini_eval');
  }
  return cachedMiniEvalReinforcePromptPromise;
}

export async function evaluateStepMiniDecision({
  runId = '',
  stepIndex = -1,
  objective = '',
  step = {},
  manifestItem = null,
  currentToolFull = null,
  result = {},
  actionResult = {},
  retryState = {},
  argValidationFailed = false,
  context = {},
} = {}) {
  const stepId = toText(step?.stepId);
  const aiName = toText(step?.aiName);
  const criteriaLines = collectSuccessCriteriaLines(step, manifestItem);
  const retryStateNorm = normalizeStepRetryState(retryState);
  const attemptNo = Math.max(1, Number(retryStateNorm?.attempts || 0) + 1);

  let history = [];
  let plan = null;
  try {
    history = await HistoryStore.list(runId, 0, -1);
    plan = await HistoryStore.getPlan(runId);
  } catch {
    history = [];
    plan = null;
  }
  const depStepIds = collectDependencyStepIds(plan, stepIndex, step);
  const dependencyContextXml = buildDependencyContextXml(history, depStepIds);
  const stepHistoryXml = buildStepHistoryXml(history, stepIndex, stepId);
  const pluginRuntimeContext = sanitizePluginRuntimeContext(currentToolFull?.pluginEnv || manifestItem?.pluginEnv || {});
  const promptDef = await getMiniEvalPrompt();
  if (!promptDef || typeof promptDef !== 'object') {
    throw new Error('STEP_MINI_EVAL_PROMPT_MISSING');
  }
  const reinforceDef = await getMiniEvalReinforcePrompt().catch(() => null);
  const toolDef = await getMiniEvalToolDef();
  if (String(toolDef?.function?.name || '').trim() !== 'step_mini_eval') {
    throw new Error('STEP_MINI_EVAL_TOOL_DEF_INVALID');
  }
  const schema = toolDef?.function?.parameters || {};
  if (!schema || typeof schema !== 'object') {
    throw new Error('STEP_MINI_EVAL_SCHEMA_INVALID');
  }

  const overlays = (context?.promptOverlays || context?.overlays || {});
  const overlayGlobal = overlays.global?.system || overlays.global || '';
  const overlayMiniEval = overlays.step_mini_eval?.system || overlays.step_mini_eval || overlays.mini_eval?.system || overlays.mini_eval || '';
  const system = composeSystem(promptDef?.system || '', [overlayGlobal, overlayMiniEval].filter(Boolean).join('\n\n'));

  const inputXml = buildMiniEvalInputXml({
    objective,
    step,
    manifestItem,
    pluginRuntimeContext,
    result,
    actionResult,
    dependencyContextXml,
    stepHistoryXml,
    retryState: retryStateNorm,
    argValidationFailed,
    attemptNo,
    criteriaLines
  });

  const userPrompt = renderTemplate(promptDef?.user || '', {
    objective: String(objective || ''),
    input_xml: inputXml
  });

  const instruction = await buildFunctionCallInstruction({
    name: 'step_mini_eval',
    parameters: schema,
    locale: 'en'
  });
  const policy = await buildFCPolicy({ locale: 'en' });

  const fc = config.fcLlm || {};
  const provider = getStageProvider('mini_eval');
  const model = String(getStageModel('mini_eval') || '');
  const temperature = Number.isFinite(fc.evalTemperature)
    ? fc.evalTemperature
    : (Number.isFinite(fc.temperature) ? Math.min(0.2, fc.temperature) : 0.1);
  const top_p = Number.isFinite(fc.evalTopP) ? fc.evalTopP : undefined;
  const omitMaxTokens = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
  const maxRetries = MINI_EVAL_MAX_RETRIES;

  let lastError = '';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const reinforceTpl = toText(reinforceDef?.en || reinforceDef?.zh || '');
    const reinforce = attempt > 1 && reinforceTpl
      ? renderTemplate(reinforceTpl, {
        attempt: String(attempt),
        max_retries: String(maxRetries),
        error: lastError || '(none)'
      })
      : '';

    const messages = [
      { role: 'system', content: system },
      ...buildMiniEvalFewShotMessages(promptDef),
      { role: 'user', content: [userPrompt, policy, instruction, reinforce].filter(Boolean).join('\n\n') }
    ];

    const res = await chatCompletion({
      messages,
      temperature,
      top_p,
      timeoutMs: getStageTimeoutMs('mini_eval'),
      apiKey: provider?.apiKey,
      baseURL: provider?.baseURL,
      model,
      ...(omitMaxTokens ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
    });
    const content = res?.choices?.[0]?.message?.content || '';
    const calls = parseFunctionCalls(String(content), {});
    logMiniEvalFcPreview({ attempt, provider, model, content, calls });
    if (!Array.isArray(calls) || calls.length === 0) {
      lastError = 'no function call parsed';
      continue;
    }
    const call = calls.find((c) => String(c?.name || '').trim() === 'step_mini_eval') || calls[0];
    if (!call || String(call?.name || '').trim() !== 'step_mini_eval') {
      lastError = `unexpected function call: ${toText(call?.name) || '(empty)'}`;
      continue;
    }
    const args = (call.arguments && typeof call.arguments === 'object') ? call.arguments : {};
    const decision = normalizeDecision(args.decision);
    if (!decision) {
      lastError = 'missing or invalid decision';
      continue;
    }
    const reason = toText(args.reason);
    if (!reason) {
      lastError = 'missing reason';
      continue;
    }
    const failureClass = normalizeFailureClass(args.failureClass);
    if (decision !== 'pass' && !failureClass) {
      lastError = 'missing failureClass for non-pass decision';
      continue;
    }
    const failedCriteria = normalizeStringArray(args.failedCriteria, MINI_EVAL_EVIDENCE_MAX_ITEMS);
    const evidence = normalizeStringArray(args.evidence, MINI_EVAL_EVIDENCE_MAX_ITEMS);
    const retryHint = toText(args.retryHint);
    const confidence = Number(args.confidence);

    return buildMiniEvalOutput({
      stepId,
      aiName,
      decision,
      failureClass,
      reason,
      confidence,
      failedCriteria,
      evidence,
      retryHint,
      criteriaLines,
      retryState: retryStateNorm
    });
  }

  const fallbackReason = `mini eval skipped after ${maxRetries} attempts: ${lastError || 'unknown'}`;
  logger.warn('Step mini eval failed after retries; skip mini eval gate', {
    label: 'MINI_EVAL',
    runId,
    stepIndex,
    stepId,
    aiName,
    attemptNo,
    reason: fallbackReason
  });
  return buildMiniEvalSkippedOutput({
    stepId,
    aiName,
    reason: fallbackReason,
    criteriaLines,
    retryState: retryStateNorm
  });
}

export default {
  evaluateStepMiniDecision,
};
