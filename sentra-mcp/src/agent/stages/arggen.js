/**
 * 鍙傛暟鐢熸垚涓庝慨澶嶉樁娈碉紝鎸夊伐鍏?schema 鐢熸垚鍚堟硶鍙傛暟銆?
 */

import logger from '../../logger/index.js';
import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { validateAndRepairArgs } from '../../utils/schema.js';
import { clip } from '../../utils/text.js';
import { summarizeRequiredFieldsDetail, summarizeRequiredFieldsDetailXml } from '../plan/manifest.js';
import { buildDependentContextText } from '../plan/history.js';
import { searchToolMemories } from '../../memory/index.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { compactMessages } from '../utils/messages.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy } from '../../utils/fc.js';

function clipText(s, maxChars) {
  const t = String(s ?? '');
  const lim = Math.max(0, Number(maxChars) || 0);
  if (!lim) return t;
  return t.length > lim ? t.slice(0, lim) : t;
}

function toXmlCData(text) {
  return String(text ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
}

function isTimeoutLikeFailure(ctx = null) {
  if (!ctx || typeof ctx !== 'object') return false;
  const code = String(ctx.last_code || '').trim().toUpperCase();
  const err = String(ctx.last_error || '').trim().toLowerCase();
  if (code === 'TIMEOUT' || code.includes('TIMEOUT')) return true;
  return err.includes('timeout') || err.includes('timed out');
}

function buildTimeoutRetryHints(retryContext, useFC = false) {
  const ctx = (retryContext && typeof retryContext === 'object') ? retryContext : null;
  if (!isTimeoutLikeFailure(ctx)) return '';
  const lastArgs = (ctx?.last_args && typeof ctx.last_args === 'object') ? ctx.last_args : {};
  const payload = JSON.stringify({
    timeout_retry_policy: {
      must_not_repeat_same_unbounded_command: true,
      regenerate_or_shrink_scope: true,
      prefer_timeout_ms_range: [20000, 45000],
      require_output_bounds: {
        maxOutputChars_lte: 20000,
        tailLines_lte: 200
      },
      repo_scan_guardrails: [
        'avoid full-repo broad scans',
        'exclude heavy folders unless explicitly required: .git, node_modules, dist, artifacts',
        'prefer targeted files/paths first'
      ],
      last_args: lastArgs
    }
  }, null, 2);
  if (useFC) {
    return `<retry_timeout_hints><![CDATA[${toXmlCData(payload)}]]></retry_timeout_hints>`;
  }
  return `Timeout retry hard constraints (must follow):\n${payload}`;
}

function buildRetryContextText(retryContext, useFC = false) {
  const ctx = (retryContext && typeof retryContext === 'object') ? retryContext : null;
  if (!ctx) return '';
  const attemptNo = Number.isFinite(Number(ctx.attempt_no)) ? Number(ctx.attempt_no) : 0;
  const lastError = clipText(String(ctx.last_error || ''), 600);
  const lastCode = clipText(String(ctx.last_code || ''), 120);
  const lastArgs = (ctx.last_args && typeof ctx.last_args === 'object') ? ctx.last_args : {};
  const evidence = Array.isArray(ctx.evidence) ? ctx.evidence.slice(0, 8) : [];
  const body = JSON.stringify({
    attempt_no: attemptNo,
    last_code: lastCode,
    last_error: lastError,
    last_args: lastArgs,
    evidence
  }, null, 2);
  if (useFC) {
    const base = `<retry_context><![CDATA[${toXmlCData(body)}]]></retry_context>`;
    const timeoutHints = buildTimeoutRetryHints(ctx, useFC);
    return [base, timeoutHints].filter(Boolean).join('\n');
  }
  const timeoutHints = buildTimeoutRetryHints(ctx, useFC);
  return [
    `Retry context (must avoid repeating the same invalid args):\n${body}`,
    timeoutHints
  ].filter(Boolean).join('\n\n');
}

function parseCsvItems(value, maxItems = 12) {
  const src = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const text = String(item || '').trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function buildPluginModelRuntimeHints(currentToolFull = {}, retryContext = null, useFC = false) {
  const penv = (currentToolFull?.pluginEnv && typeof currentToolFull.pluginEnv === 'object')
    ? currentToolFull.pluginEnv
    : {};
  const keys = Object.keys(penv || {}).filter((k) => /_MODEL$/i.test(String(k || '')));
  if (!keys.length) return '';

  const ctx = (retryContext && typeof retryContext === 'object') ? retryContext : {};
  const lastCode = String(ctx?.last_code || '').toUpperCase();
  const lastError = String(ctx?.last_error || '').toLowerCase();
  const likelyServiceBusy = lastCode.includes('503')
    || lastError.includes('503')
    || lastError.includes('service unavailable')
    || lastError.includes('rate limit')
    || lastError.includes('too many requests');

  const lastArgs = (ctx.last_args && typeof ctx.last_args === 'object') ? ctx.last_args : {};
  const lastModel = String(lastArgs.model || '').trim();
  const entries = [];
  for (const key of keys) {
    const primary = String(penv[key] || '').trim();
    const fallbackRaw = penv[`${key}_FALLBACKS`] || penv[`${key}_FALLBACK_MODELS`] || penv.MODEL_FALLBACKS || '';
    const candidates = parseCsvItems([primary, ...parseCsvItems(fallbackRaw)], 10);
    if (!candidates.length) continue;
    entries.push({
      envKey: key,
      current: primary || '',
      candidates,
      lastTriedModel: lastModel || '',
      likelyServiceBusy
    });
    if (entries.length >= 8) break;
  }
  if (!entries.length) return '';
  const payload = JSON.stringify(entries, null, 2);
  if (useFC) {
    return `<plugin_model_hints><![CDATA[${toXmlCData(payload)}]]></plugin_model_hints>`;
  }
  return `Plugin model runtime hints (use when selecting/regenerating args, especially on 503/overload):\n${payload}`;
}

function logFcParsePreview({ phase, aiName, attempt, provider, content, calls }) {
  const providerInfo = provider && typeof provider === 'object'
    ? { baseURL: provider.baseURL, model: provider.model }
    : undefined;
  const count = Array.isArray(calls) ? calls.length : 0;
  if (count > 0) {
    logger.info(`${phase} parsed output`, {
      label: 'ARGS',
      aiName,
      attempt,
      provider: providerInfo,
      count,
      firstCallName: String(calls?.[0]?.name || ''),
      firstCallPreview: clip(calls?.[0]),
      length: String(content || '').length
    });
    return;
  }
  logger.warn(`${phase} parse failed, fallback raw preview`, {
    label: 'ARGS',
    aiName,
    attempt,
    provider: providerInfo,
    count: 0,
    rawPreview: clip(String(content)),
    length: String(content || '').length
  });
}

export async function generateToolArgs(params) {
  const {
    runId,
    stepIndex,
    objective,
    step,
    currentToolFull,
    manifestItem,
    conv,
    totalSteps,
    context,
    disableReuse, // retry mode: disable arg reuse
    retryContext,
  } = params;

  const { aiName, reason, draftArgs } = step;
  let toolArgs = draftArgs;

  const skillDoc = currentToolFull?.skillDoc && typeof currentToolFull.skillDoc === 'object'
    ? currentToolFull.skillDoc
    : (manifestItem?.skillDoc && typeof manifestItem.skillDoc === 'object' ? manifestItem.skillDoc : null);
  const skillMarkdownRaw = (skillDoc && typeof skillDoc.raw === 'string') ? skillDoc.raw : '';

  const perStepTools = [{
    type: 'function',
    function: {
      name: aiName,
      description: currentToolFull.description || '',
      parameters: currentToolFull.inputSchema || { type: 'object', properties: {} }
    }
  }];

  const requiredList = Array.isArray((currentToolFull.inputSchema || {}).required)
    ? currentToolFull.inputSchema.required
    : (Array.isArray(manifestItem?.inputSchema?.required) ? manifestItem.inputSchema.required : []);

  // 鏄惁浣跨敤 FC 妯″紡
  const useFC = String(config.llm?.toolStrategy || 'auto') === 'fc';
  const requiredDetail = useFC
    ? summarizeRequiredFieldsDetailXml(currentToolFull.inputSchema || {})
    : summarizeRequiredFieldsDetail(currentToolFull.inputSchema || {});

  const depRefs = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
  const depAppendText = await buildDependentContextText(runId, depRefs, useFC);

  let reused = false;
  if (disableReuse) {
    if (config.flags.enableVerboseSteps) {
      logger.info('Arg reuse is disabled for this retry', {
        label: 'ARGGEN',
        aiName,
        stepIndex
      });
    }
  } else if (config.memory?.enable && config.memory?.enableReuse) {
    const result = await tryReuseHistoryArgs({
      objective,
      reason,
      aiName,
      requiredList,
      currentToolFull
    });
    if (result.reused) {
      toolArgs = result.args;
      reused = true;
      logger.info('Args reused from memory, skip LLM generation', {
        label: 'MEM',
        aiName,
        score: result.score,
        fromRunId: result.fromRunId,
        fromStepIndex: result.fromStepIndex
      });
    }
  }

  // 鏈懡涓鐢紝杩涘叆 LLM 鍙傜敓
  if (!reused) {
    // FC 妯″紡浣跨敤 XML 鍗忚鎻愮ず
    const ap = await loadPrompt(useFC ? 'arggen_fc' : 'arggen');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayArgs = overlays.arggen?.system || overlays.arggen || overlays.args || '';

    let systemContent;
    if (useFC) {
      const policy = await buildFCPolicy();
      const userSystem = [overlayGlobal, overlayArgs, ap.system].filter(Boolean).join('\n\n');
      systemContent = userSystem
        ? `${policy}\n\n---\n[Protocol Requirements] Above is system protocol and must be followed strictly. Below are task-specific settings.\n---\n\n${userSystem}`
        : policy;
    } else {
      systemContent = composeSystem(ap.system, [overlayGlobal, overlayArgs].filter(Boolean).join('\n\n'));
    }

    const objectiveText = objective;

    let timingHint = '';
    if (useFC) {
      timingHint = ap.schedule_hint_en || '';
    } else {
      timingHint = ap.timing_hint || '';
    }

    const convWrapped = conv;

    const taskInstruction = renderTemplate(ap.user_task, {
      objective: objectiveText,
      stepIndex: stepIndex + 1,
      totalSteps,
      aiName,
      reason: reason || '',
      description: currentToolFull?.description || '',
      skillMarkdown: useFC ? toXmlCData(skillMarkdownRaw || '') : (skillMarkdownRaw || ''),
      draftArgs: draftArgs ? JSON.stringify(draftArgs, null, 2) : '(none)',
      requiredList: Array.isArray(requiredList) && requiredList.length ? requiredList.join(', ') : '(none)',
      requiredDetail: requiredDetail || '(none)',
      timingHint
    });
    const retryContextText = buildRetryContextText(retryContext, useFC);
    const pluginModelHints = buildPluginModelRuntimeHints(currentToolFull, retryContext, useFC);
    const taskInstructionWithRetry = [taskInstruction, retryContextText, pluginModelHints].filter(Boolean).join('\n\n');

    const baseMessages = compactMessages([
      { role: 'system', content: systemContent },
      ...convWrapped,
      ...(useFC ? [] : [{ role: 'user', content: [taskInstructionWithRetry, depAppendText || ''].filter(Boolean).join('\n\n') }])
    ]);

    const useAuto = String(config.llm?.toolStrategy || 'auto') === 'auto';

    if (useFC) {
      const fc = config.fcLlm || {};
      const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
      const maxRetries = Math.max(1, Number(fc.argMaxRetries ?? 3));
      let lastMissing = [];
      let lastInvalid = [];
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const instruction = await buildFunctionCallInstruction({ name: aiName, parameters: currentToolFull?.inputSchema || { type: 'object', properties: {} }, locale: 'zh-CN' });
        let reinforce = '';
        if (attempt > 1) {
          const pfRe = await loadPrompt('fc_reinforce_args');
          const tplRe = pfRe.zh;
          const required_line = (Array.isArray(requiredList) && requiredList.length) ? `- 蹇呭～瀛楁锛?{requiredList.join(', ')}` : '';
          const missing_line = Array.isArray(lastMissing) && lastMissing.length ? `- 缂哄け瀛楁锛?{lastMissing.join(', ')}` : '';
          const invalid_line = Array.isArray(lastInvalid) && lastInvalid.length ? `- 绫诲瀷涓嶅尮閰嶅瓧娈碉細${lastInvalid.join(', ')}` : '';
          reinforce = renderTemplate(tplRe, { required_line, missing_line, invalid_line, attempt: String(attempt), max_retries: String(maxRetries) });
        }
        // FC user 鎸囦护锛氫换鍔?+ 渚濊禆涓婁笅鏂?+ 寮哄寲鎻愮ず + 璋冪敤璇存槑
        const finalUserContent = [
          taskInstructionWithRetry,
          depAppendText || '',
          reinforce,
          instruction
        ].filter(Boolean).join('\n\n');

        const messagesFC = [...baseMessages, { role: 'user', content: finalUserContent }];

        // 涓嶆墦鍗板畬鏁?messages锛岄伩鍏嶆棩蹇楀櫔闊?

        const provider = getStageProvider('arg');
        const argModel = getStageModel('arg');
        const resp = await chatCompletion({
          messages: messagesFC,
          temperature: fc.temperature ?? config.llm.temperature,
          timeoutMs: getStageTimeoutMs('arg'),
          apiKey: provider.apiKey,
          baseURL: provider.baseURL,
          model: argModel,
          ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
        });
        const content = resp?.choices?.[0]?.message?.content || '';
        const calls = parseFunctionCalls(String(content), {});
        if (config.flags.enableVerboseSteps || !content || calls.length === 0) {
          logFcParsePreview({
            phase: 'FC arggen',
            aiName,
            attempt,
            provider: { baseURL: provider.baseURL, model: argModel },
            content,
            calls
          });
        }
        const target = calls.find((c) => String(c.name) === String(aiName)) || calls[0];
        if (target && target.arguments && typeof target.arguments === 'object') {
          const schemaToValidate = currentToolFull?.inputSchema || { type: 'object', properties: {} };
          const check = validateAndRepairArgs(schemaToValidate, target.arguments);
          if (check?.valid) {
            toolArgs = check.output;
            break;
          }
          const props = (schemaToValidate.properties) || {};
          const req0 = Array.isArray(schemaToValidate.required) ? schemaToValidate.required : [];
          lastMissing = Array.isArray(req0) ? req0.filter((k) => !Object.prototype.hasOwnProperty.call(target.arguments, k)) : [];
          const invalid = [];
          for (const [k, def] of Object.entries(props)) {
            if (!Object.prototype.hasOwnProperty.call(target.arguments, k)) continue;
            const v = target.arguments[k];
            const exp = Array.isArray(def?.type) ? def.type : (def?.type ? [def.type] : []);
            if (!exp.length) continue;
            const actual = Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
            const ok = exp.some((t) => {
              if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
              if (t === 'array') return Array.isArray(v);
              if (t === 'object') return v !== null && !Array.isArray(v) && typeof v === 'object';
              return typeof v === t;
            });
            if (!ok) {
              const expStr = exp.join('|');
              invalid.push(`${k}(${expStr} vs ${actual})`);
            }
          }
          lastInvalid = invalid;
        }
      }
    } else {
      // 鍘熺敓 tools 璋冪敤
      // 涓嶆墦鍗板畬鏁?messages锛岄伩鍏嶆棩蹇楀櫔闊?

      const resp = await chatCompletion({
        messages: baseMessages,
        tools: perStepTools,
        tool_choice: { type: 'function', function: { name: aiName } },
        temperature: config.llm.temperature,
        timeoutMs: getStageTimeoutMs('arg')
      });
      const call = resp.choices?.[0]?.message?.tool_calls?.[0];
      if (call?.function?.arguments) {
        try {
          toolArgs = JSON.parse(call.function.arguments);
        } catch (e) {
          logger.warn?.('Failed to parse native tool arguments', { label: 'ARGGEN', aiName, error: String(e) });
        }
      } else if (useAuto) {
        const fc = config.fcLlm || {};
        const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
        const maxRetries = Math.max(1, Number(fc.argMaxRetries ?? 3));
        let lastMissing2 = [];
        let lastInvalid2 = [];
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const instruction = await buildFunctionCallInstruction({ name: aiName, parameters: currentToolFull?.inputSchema || { type: 'object', properties: {} }, locale: 'zh-CN' });
          let reinforce = '';
          if (attempt > 1) {
            const pfRe = await loadPrompt('fc_reinforce_args');
            const tplRe = pfRe.zh;
            const required_line = (Array.isArray(requiredList) && requiredList.length) ? `- 蹇呭～瀛楁锛?{requiredList.join(', ')}` : '';
            const missing_line = Array.isArray(lastMissing2) && lastMissing2.length ? `- 缂哄け瀛楁锛?{lastMissing2.join(', ')}` : '';
            const invalid_line = Array.isArray(lastInvalid2) && lastInvalid2.length ? `- 绫诲瀷涓嶅尮閰嶅瓧娈碉細${lastInvalid2.join(', ')}` : '';
            reinforce = renderTemplate(tplRe, { required_line, missing_line, invalid_line, attempt: String(attempt), max_retries: String(maxRetries) });
          }
          // Auto 鍥為€€ FC锛氬湪 baseMessages 鍚庤拷鍔?user 鎸囦护
          const messagesFC = compactMessages([
            ...baseMessages,
            { role: 'user', content: [reinforce, instruction].filter(Boolean).join('\n\n') }
          ]);

          // 涓嶆墦鍗?auto 鍥為€€瀹屾暣 messages锛岄伩鍏嶆棩蹇楀櫔闊?

          const provider = getStageProvider('arg');
          const argModel = getStageModel('arg');
          const resp2 = await chatCompletion({
            messages: messagesFC,
            temperature: fc.temperature ?? config.llm.temperature,
            timeoutMs: getStageTimeoutMs('arg'),
            apiKey: provider.apiKey,
            baseURL: provider.baseURL,
            model: argModel,
            ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
          });
          const content2 = resp2?.choices?.[0]?.message?.content || '';
          const calls2 = parseFunctionCalls(String(content2), {});
          if (config.flags.enableVerboseSteps || !content2 || calls2.length === 0) {
            logFcParsePreview({
              phase: 'FC arggen fallback',
              aiName,
              attempt,
              provider: { baseURL: provider.baseURL, model: argModel },
              content: content2,
              calls: calls2
            });
          }
          const target2 = calls2.find((c) => String(c.name) === String(aiName)) || calls2[0];
          if (target2 && target2.arguments && typeof target2.arguments === 'object') {
            const schemaToValidate2 = currentToolFull?.inputSchema || { type: 'object', properties: {} };
            const check2 = validateAndRepairArgs(schemaToValidate2, target2.arguments);
            if (check2?.valid) {
              toolArgs = check2.output;
              break;
            }
            const props2 = (schemaToValidate2.properties) || {};
            const req02 = Array.isArray(schemaToValidate2.required) ? schemaToValidate2.required : [];
            lastMissing2 = Array.isArray(req02) ? req02.filter((k) => !Object.prototype.hasOwnProperty.call(target2.arguments, k)) : [];
            const invalid2 = [];
            for (const [k, def] of Object.entries(props2)) {
              if (!Object.prototype.hasOwnProperty.call(target2.arguments, k)) continue;
              const v = target2.arguments[k];
              const exp = Array.isArray(def?.type) ? def.type : (def?.type ? [def.type] : []);
              if (!exp.length) continue;
              const actual = Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
              const ok = exp.some((t) => {
                if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
                if (t === 'array') return Array.isArray(v);
                if (t === 'object') return v !== null && !Array.isArray(v) && typeof v === 'object';
                return typeof v === t;
              });
              if (!ok) {
                const expStr = exp.join('|');
                invalid2.push(`${k}(${expStr} vs ${actual})`);
              }
            }
            lastInvalid2 = invalid2;
          }
        }
      }
    }
  }

  return { toolArgs, reused };
}

/**
 * 鍙傛暟鏍￠獙涓庝慨澶?
 * @param {Object} params
 * @param {Object} params.toolArgs - 宸ュ叿鍙傛暟
 * @param {string} params.aiName - 宸ュ叿鍚?
 * @returns {Promise<Object>} { valid, errors, args }
 */
export async function validateArgs(params) {
  const { schema, toolArgs, aiName } = params;

  try {
    const props0 = ((schema || {}).properties) || {};
    if (toolArgs && typeof toolArgs === 'object' && props0 && typeof props0 === 'object') {
      for (const [k, def] of Object.entries(props0)) {
        const t = Array.isArray(def?.type) ? def.type : (def?.type ? [def.type] : []);
        if (t.includes('string') && Object.prototype.hasOwnProperty.call(toolArgs, k)) {
          const v = toolArgs[k];
          if (typeof v !== 'string' && v !== undefined && v !== null) {
            toolArgs[k] = String(v);
          }
        }
      }
    }
  } catch { }

  try {
    const out = validateAndRepairArgs(schema, toolArgs);
    if (!out.valid && config.flags.enableVerboseSteps) {
      logger.warn?.('Arg validation failed after repair', {
        label: 'ARGS',
        aiName,
        errors: out.errors
      });
    }
    return {
      valid: !!out.valid,
      errors: out.errors,
      args: out.output
    };
  } catch (e) {
    logger.warn?.('Arg validation error (ignored, continue)', {
      label: 'ARGS',
      aiName,
      error: String(e)
    });
    return {
      valid: true,
      errors: null,
      args: toolArgs
    };
  }
}

/**
 * 浣跨敤 LLM 淇鏃犳晥鍙傛暟
 * @param {Object} params
 * @param {string} params.runId - 杩愯 ID
 * @param {number} params.stepIndex - 姝ラ绱㈠紩
 * @param {string} params.objective - 鎬讳綋鐩爣
 * @param {Object} params.step - 褰撳墠姝ラ
 * @param {Object} params.currentToolFull - 瀹屾暣宸ュ叿瀹氫箟
 * @param {Object} params.schema - JSON Schema
 * @param {Array} params.ajvErrors - 鏍￠獙閿欒
 * @param {number} params.totalSteps - 鎬绘楠ゆ暟
 * @returns {Promise<Object>} 淇鍚庣殑鍙傛暟
 */
export async function fixToolArgs(params) {
  const {
    runId,
    stepIndex,
    objective,
    step,
    currentToolFull,
    schema,
    ajvErrors,
    draftArgs,
    totalSteps,
    context
  } = params;

  const { aiName, reason } = step;

  const skillDoc = currentToolFull?.skillDoc && typeof currentToolFull.skillDoc === 'object'
    ? currentToolFull.skillDoc
    : null;
  const skillMarkdownRaw = (skillDoc && typeof skillDoc.raw === 'string') ? skillDoc.raw : '';

  try {
    const requiredList = Array.isArray((schema || {}).required) ? schema.required : [];

    const useFC = String(config.llm?.toolStrategy || 'auto') === 'fc';
    const requiredDetail = useFC
      ? summarizeRequiredFieldsDetailXml(schema || {})
      : summarizeRequiredFieldsDetail(schema || {});
    const useAuto = String(config.llm?.toolStrategy || 'auto') === 'auto';

    // FC 妯″紡浣跨敤 XML 鍗忚鎻愮ず
    const ap = await loadPrompt(useFC ? 'arggen_fc' : 'arggen');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayFix = overlays.arggen_fix?.system || overlays.arggen_fix || overlays.argfix || overlays.arggen || '';

    let sysFix;
    if (useFC) {
      const policy = await buildFCPolicy();
      const userSystem = [overlayGlobal, overlayFix, ap.system_fix].filter(Boolean).join('\n\n');
      sysFix = userSystem
        ? `${policy}\n\n---\n[Protocol Requirements] Above is system protocol and must be followed strictly. Below are task-specific settings.\n---\n\n${userSystem}`
        : policy;
    } else {
      sysFix = composeSystem(ap.system_fix, [overlayGlobal, overlayFix].filter(Boolean).join('\n\n'));
    }

    const objectiveTextFix = objective;

    const taskInstructionFix = renderTemplate(ap.user_task_fix, {
      objective: objectiveTextFix,
      stepIndex: stepIndex + 1,
      totalSteps,
      aiName,
      reason: reason || '',
      description: currentToolFull?.description || '',
      draftArgs: draftArgs ? JSON.stringify(draftArgs, null, 2) : '(none)',
      skillMarkdown: useFC ? toXmlCData(skillMarkdownRaw || '') : (skillMarkdownRaw || ''),
      errors: JSON.stringify(ajvErrors || [], null, 2),
      requiredList: Array.isArray(requiredList) && requiredList.length ? requiredList.join(', ') : '(none)',
      requiredDetail: requiredDetail || '(none)'
    });

    const depRefs = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
    const depAppendText = await buildDependentContextText(runId, depRefs, useFC);

    const messagesFix = compactMessages([
      { role: 'system', content: sysFix },
      { role: 'user', content: [taskInstructionFix, depAppendText || ''].filter(Boolean).join('\n\n') }
    ]);

    let fixedArgs = params.toolArgs;
    if (useFC) {
      const fc = config.fcLlm || {};
      const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
      const maxRetries = Math.max(1, Number(fc.argMaxRetries ?? 3));
      const missingFromAjv = Array.isArray(ajvErrors) ? ajvErrors.filter((e) => e?.keyword === 'required' && e?.params?.missingProperty).map((e) => e.params.missingProperty) : [];
      const invalidFromAjv = Array.isArray(ajvErrors) ? ajvErrors.filter((e) => e?.keyword === 'type' && e?.params?.type && (e.instancePath || e.dataPath)).map((e) => `${(e.instancePath || e.dataPath || '').replace(/^\./, '') || 'value'}(${e.params.type})`) : [];
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const instruction = await buildFunctionCallInstruction({ name: aiName, parameters: schema || { type: 'object', properties: {} }, locale: 'zh-CN' });
        let reinforce = '';
        if (attempt > 1) {
          const pfRe = await loadPrompt('fc_reinforce_args');
          const tplRe = pfRe.zh;
          const required_line = (Array.isArray((schema || {}).required) && (schema.required || []).length) ? `- 蹇呭～瀛楁锛?{(schema.required || []).join(', ')}` : '';
          const missing_line = Array.isArray(missingFromAjv) && missingFromAjv.length ? `- 缂哄け瀛楁锛?{missingFromAjv.join(', ')}` : '';
          const invalid_line = Array.isArray(invalidFromAjv) && invalidFromAjv.length ? `- 绫诲瀷涓嶅尮閰嶅瓧娈碉細${invalidFromAjv.join(', ')}` : '';
          reinforce = renderTemplate(tplRe, { required_line, missing_line, invalid_line, attempt: String(attempt), max_retries: String(maxRetries) });
        }
        const policy = await buildFCPolicy();
        const messagesFixFC = [...messagesFix, { role: 'user', content: [reinforce, policy, instruction].filter(Boolean).join('\n\n') }];
        const provider = getStageProvider('arg');
        const argModel = getStageModel('arg');
        const respFix = await chatCompletion({
          messages: messagesFixFC,
          temperature: fc.temperature ?? config.llm.temperature,
          timeoutMs: getStageTimeoutMs('arg'),
          apiKey: provider.apiKey,
          baseURL: provider.baseURL,
          model: argModel,
          ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
        });
        const contentFix = respFix?.choices?.[0]?.message?.content || '';
        const callsFix = parseFunctionCalls(String(contentFix), { format: (config.fcLlm?.format || 'sentra') });
        if (config.flags.enableVerboseSteps || !contentFix || callsFix.length === 0) {
          logFcParsePreview({
            phase: 'FC argfix',
            aiName,
            attempt,
            provider: { baseURL: provider.baseURL, model: argModel },
            content: contentFix,
            calls: callsFix
          });
        }
        const targetFix = callsFix.find((c) => String(c.name) === String(aiName)) || callsFix[0];
        if (targetFix && targetFix.arguments) { fixedArgs = targetFix.arguments; break; }
      }
    } else {
      const perStepTools = [{
        type: 'function',
        function: {
          name: aiName,
          description: currentToolFull.description || '',
          parameters: schema || { type: 'object', properties: {} }
        }
      }];
      const respFix = await chatCompletion({
        messages: messagesFix,
        tools: perStepTools,
        tool_choice: { type: 'function', function: { name: aiName } },
        temperature: config.llm.temperature,
        timeoutMs: getStageTimeoutMs('arg')
      });
      const callFix = respFix.choices?.[0]?.message?.tool_calls?.[0];
      if (callFix?.function?.arguments) {
        try { fixedArgs = JSON.parse(callFix.function.arguments); } catch { }
      } else if (useAuto) {
        const fc = config.fcLlm || {};
        const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
        const maxRetries = Math.max(1, Number(fc.argMaxRetries ?? 3));
        const missingFromAjv2 = Array.isArray(ajvErrors) ? ajvErrors.filter((e) => e?.keyword === 'required' && e?.params?.missingProperty).map((e) => e.params.missingProperty) : [];
        const invalidFromAjv2 = Array.isArray(ajvErrors) ? ajvErrors.filter((e) => e?.keyword === 'type' && e?.params?.type && (e.instancePath || e.dataPath)).map((e) => `${(e.instancePath || e.dataPath || '').replace(/^\./, '') || 'value'}(${e.params.type})`) : [];
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const instruction = await buildFunctionCallInstruction({ name: aiName, parameters: schema || { type: 'object', properties: {} }, locale: 'zh-CN' });
          let reinforce = '';
          if (attempt > 1) {
            const pfRe = await loadPrompt('fc_reinforce_args');
            const tplRe = pfRe.zh;
            const required_line = (Array.isArray((schema || {}).required) && (schema.required || []).length) ? `- 蹇呭～瀛楁锛?{(schema.required || []).join(', ')}` : '';
            const missing_line = Array.isArray(missingFromAjv2) && missingFromAjv2.length ? `- 缂哄け瀛楁锛?{missingFromAjv2.join(', ')}` : '';
            const invalid_line = Array.isArray(invalidFromAjv2) && invalidFromAjv2.length ? `- 绫诲瀷涓嶅尮閰嶅瓧娈碉細${invalidFromAjv2.join(', ')}` : '';
            reinforce = renderTemplate(tplRe, { required_line, missing_line, invalid_line, attempt: String(attempt), max_retries: String(maxRetries) });
          }
          // FC 鍥為€€锛氳拷鍔?reinforce + instruction 浣滀负 user 娑堟伅
          const messagesFixFC = [...messagesFix, { role: 'user', content: [reinforce, instruction].filter(Boolean).join('\n\n') }];

          // 涓嶆墦鍗颁慨澶嶉樁娈靛畬鏁?messages锛岄伩鍏嶆棩蹇楀櫔闊?

          const provider = getStageProvider('arg');
          const argModel = getStageModel('arg');
          const respFix2 = await chatCompletion({
            messages: messagesFixFC,
            temperature: fc.temperature ?? config.llm.temperature,
            timeoutMs: getStageTimeoutMs('arg'),
            apiKey: provider.apiKey,
            baseURL: provider.baseURL,
            model: argModel,
            ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
          });
          const contentFix2 = respFix2?.choices?.[0]?.message?.content || '';
          const callsFix2 = parseFunctionCalls(String(contentFix2), { format: (config.fcLlm?.format || 'sentra') });
          if (config.flags.enableVerboseSteps || !contentFix2 || callsFix2.length === 0) {
            logFcParsePreview({
              phase: 'FC argfix fallback',
              aiName,
              attempt,
              provider: { baseURL: provider.baseURL, model: argModel },
              content: contentFix2,
              calls: callsFix2
            });
          }
          const targetFix2 = callsFix2.find((c) => String(c.name) === String(aiName)) || callsFix2[0];
          if (targetFix2 && targetFix2.arguments) { fixedArgs = targetFix2.arguments; break; }
        }
      }
    }

    // 閲嶆柊鏍￠獙
    try {
      const out2 = validateAndRepairArgs(schema, fixedArgs);
      if (!out2.valid && config.flags.enableVerboseSteps) {
        logger.warn?.('Arg fix output still invalid', {
          label: 'ARGS',
          aiName,
          errors: out2.errors
        });
      }
      return out2.output;
    } catch {
      return fixedArgs;
    }
  } catch (e) {
    logger.warn?.('Arg fix stage failed', {
      label: 'ARGS',
      aiName: step.aiName,
      error: String(e)
    });
    return params.toolArgs;
  }
}

/**
 * 浠庡巻鍙茶蹇嗗鐢ㄥ弬鏁?
 */
async function tryReuseHistoryArgs({ objective, reason, aiName, requiredList, currentToolFull }) {
  try {
    const mems = await searchToolMemories({ objective, reason, aiName, topK: 1 });
    const best = Array.isArray(mems) && mems[0];
    const threshold = Number(config.memory.reuseThreshold ?? 0.97);

    if (best && Number(best.score) >= threshold && best.args) {
      const okReq = (Array.isArray(requiredList) ? requiredList : []).every((k) =>
        Object.prototype.hasOwnProperty.call(best.args, k)
      );

      if (okReq) {
        const props = Object.keys(((currentToolFull || {}).inputSchema || {}).properties || {});
        if (props.length) {
          const pruned = {};
          for (const k of Object.keys(best.args)) {
            if (props.includes(k)) pruned[k] = best.args[k];
          }
          const dropped = Object.keys(best.args).filter((k) => !props.includes(k));
          if (config.flags.enableVerboseSteps && dropped.length) {
            logger.info('Reuse args dropped fields not in schema', { label: 'MEM', aiName, dropped });
          }
          return {
            reused: true,
            args: pruned,
            score: Number(best.score.toFixed?.(2) || best.score),
            fromRunId: best.runId,
            fromStepIndex: best.stepIndex
          };
        } else {
          return {
            reused: true,
            args: best.args,
            score: Number(best.score.toFixed?.(2) || best.score),
            fromRunId: best.runId,
            fromStepIndex: best.stepIndex
          };
        }
      }
    }
  } catch (e) {
    logger.warn?.('Memory args reuse failed', { label: 'MEM', error: String(e) });
  }

  return { reused: false };
}



