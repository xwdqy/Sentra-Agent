/**
 * 参数生成阶段：基于对话上下文和工具 schema 生成参数
 */

import logger from '../../logger/index.js';
import { config, getStageModel } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { validateAndRepairArgs } from '../../utils/schema.js';
import { clip } from '../../utils/text.js';
import { summarizeRequiredFieldsDetail, summarizeRequiredFieldsDetailXml } from '../plan/manifest.js';
import { buildToolDialogueMessages, buildDependentContextText } from '../plan/history.js';
import { searchToolMemories } from '../../memory/index.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { compactMessages } from '../utils/messages.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy, formatSentraUserQuestion } from '../../utils/fc.js';

/**
 * 生成工具调用参数
 * @param {Object} params
 * @param {string} params.runId - 运行 ID
 * @param {number} params.stepIndex - 步骤索引
 * @param {string} params.objective - 总体目标
 * @param {Object} params.step - 当前步骤 { aiName, reason, draftArgs, dependsOn }
 * @param {Object} params.currentToolFull - 完整工具定义
 * @param {Object} params.manifestItem - 清单项
 * @param {Array} params.conv - 对话上下文
 * @param {number} params.totalSteps - 总步骤数
 * @returns {Promise<Object>} { toolArgs, reused }
 */
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
    disableReuse  // 重试模式下禁用复用
  } = params;

  const { aiName, reason, draftArgs } = step;
  let toolArgs = draftArgs;

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

  // 判断是否使用 FC 模式
  const useFC = String(config.llm?.toolStrategy || 'auto') === 'fc';
  const requiredDetail = useFC
    ? summarizeRequiredFieldsDetailXml(currentToolFull.inputSchema || {})
    : summarizeRequiredFieldsDetail(currentToolFull.inputSchema || {});

  // 构建上下文（FC 模式使用 XML 格式）
  // 🔥 重试模式：includeCurrentStep=true 包含当前步骤的失败历史，让 LLM 看到之前的尝试
  const isRetryMode = disableReuse === true;
  const dialogueMsgs = await buildToolDialogueMessages(runId, stepIndex, useFC, isRetryMode);
  const depAppendText = await buildDependentContextText(runId, step.dependsOn, useFC);

  if (isRetryMode && config.flags.enableVerboseSteps) {
    logger.info('重试模式：使用完整工具执行历史（包含失败尝试）', {
      label: 'ARGGEN',
      aiName,
      stepIndex,
      dialogueMsgsCount: dialogueMsgs.length,
      note: 'LLM 将看到当前步骤的所有历史记录，包括失败的参数和结果'
    });
  }

  // 尝试复用历史高相似度参数（跳过 LLM 参数生成）
  // 重试模式下禁用复用，避免复用失败的参数导致重试失败
  let reused = false;
  if (disableReuse) {
    if (config.flags.enableVerboseSteps) {
      logger.info('重试模式：禁用参数复用，强制重新生成参数', {
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
      logger.info('复用历史参数，跳过LLM参数生成', {
        label: 'MEM',
        aiName,
        score: result.score,
        fromRunId: result.fromRunId,
        fromStepIndex: result.fromStepIndex
      });
    }
  }

  // 未复用则调用 LLM 生成参数
  if (!reused) {
    // FC 模式使用专用模板（XML 结构化格式）
    const ap = await loadPrompt(useFC ? 'arggen_fc' : 'arggen');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayArgs = overlays.arggen?.system || overlays.arggen || overlays.args || '';
    
    // FC 模式：构建 system（协议在前，用户内容在后）
    let systemContent;
    if (useFC) {
      const policy = await buildFCPolicy();
      const userSystem = [overlayGlobal, overlayArgs, ap.system].filter(Boolean).join('\n\n');
      systemContent = userSystem 
        ? `${policy}\n\n---\n【Protocol Requirements】Above is system protocol, must be strictly followed. Below are specific task settings and requirements:\n---\n\n${userSystem}`
        : policy;
    } else {
      systemContent = composeSystem(ap.system, [overlayGlobal, overlayArgs].filter(Boolean).join('\n\n'));
    }

    // FC 模式：不提前包装 objective（新模板已在整体结构外层使用 <sentra-user-question>）
    const objectiveText = objective;
    
    // FC 模式：也保留原始对话，确保能看到用户上下文（如 QQ 群消息），与 Plan 阶段保持一致
    // 历史工具调用通过 buildToolDialogueMessages 提供（XML 格式）
    const convWrapped = conv;
    
    const taskInstruction = renderTemplate(ap.user_task, {
      objective: objectiveText,
      stepIndex: stepIndex + 1,
      totalSteps,
      aiName,
      reason: reason || '',
      description: currentToolFull?.description || '',
      draftArgs: draftArgs ? JSON.stringify(draftArgs, null, 2) : '(无)',
      requiredList: Array.isArray(requiredList) && requiredList.length ? requiredList.join(', ') : '(无)',
      requiredDetail: requiredDetail || '(无)'
    });

    // FC 模式：baseMessages 不包含最终 user 消息（会在后面统一构建）
    // 非 FC 模式：baseMessages 包含完整 user 消息（用于原生 tools 调用）
    const baseMessages = compactMessages([
      { role: 'system', content: systemContent },
      ...convWrapped,
      ...dialogueMsgs,
      ...(useFC ? [] : [{ role: 'user', content: [taskInstruction, depAppendText || ''].filter(Boolean).join('\n\n') }])
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
          const required_line = (Array.isArray(requiredList) && requiredList.length) ? `- 必须包含必填字段：${requiredList.join(', ')}` : '';
          const missing_line = Array.isArray(lastMissing) && lastMissing.length ? `- 缺少字段：${lastMissing.join(', ')}` : '';
          const invalid_line = Array.isArray(lastInvalid) && lastInvalid.length ? `- 类型不匹配字段：${lastInvalid.join(', ')}` : '';
          reinforce = renderTemplate(tplRe, { required_line, missing_line, invalid_line, attempt: String(attempt), max_retries: String(maxRetries) });
        }
        // FC 模式：构建最终 user 消息，包含任务上下文 + 依赖结果 + 重试失败上下文 + 调用指令 + 重试强化
        const finalUserContent = [
          taskInstruction,
          depAppendText || '',
          reinforce,
          instruction
        ].filter(Boolean).join('\n\n');
        
        const messagesFC = [...baseMessages, { role: 'user', content: finalUserContent }];
        
        // 调试日志：打印请求的 messages 数组
        if (config.flags.enableVerboseSteps) {
          logger.info('ArgGen FC 请求 messages', {
            label: 'ARGS_DEBUG',
            aiName,
            attempt,
            messagesCount: messagesFC.length,
            messages: messagesFC.map((m, idx) => ({
              index: idx,
              role: m.role,
              contentPreview: clip(m.content, 200)
            }))
          });
        }
        
        const argModel = getStageModel('arg');
        const resp = await chatCompletion({
          messages: messagesFC,
          temperature: fc.temperature ?? config.llm.temperature,
          apiKey: fc.apiKey,
          baseURL: fc.baseURL,
          model: argModel,
          ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
        });
        const content = resp?.choices?.[0]?.message?.content || '';
        if (config.flags.enableVerboseSteps || !content) {
          logger.info('FC 参生：模型原始响应内容', {
            label: 'ARGS',
            aiName,
            attempt,
            provider: { baseURL: fc.baseURL, model: fc.model },
            contentPreview: clip(String(content)),
            length: String(content || '').length
          });
        }
        const calls = parseFunctionCalls(String(content), {});
        if (config.flags.enableVerboseSteps || calls.length === 0) {
          logger.info('FC 参生：解析到的工具调用数量', { label: 'ARGS', aiName, attempt, count: calls.length, firstCallPreview: clip(calls?.[0]) });
        }
        const target = calls.find((c) => String(c.name) === String(aiName)) || calls[0];
        if (target && target.arguments && typeof target.arguments === 'object') {
          const okReq = Array.isArray(requiredList) && requiredList.length ? requiredList.every((k) => Object.prototype.hasOwnProperty.call(target.arguments, k)) : true;
          if (okReq) { toolArgs = target.arguments; break; }
          // 记录缺失/类型错误字段，供下一轮提示
          const props = ((currentToolFull?.inputSchema || {}).properties) || {};
          lastMissing = Array.isArray(requiredList) ? requiredList.filter((k) => !Object.prototype.hasOwnProperty.call(target.arguments, k)) : [];
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
      // 原生 tools 调用
      // 调试日志：打印请求的 messages 数组
      if (config.flags.enableVerboseSteps) {
        logger.info('ArgGen Native 请求 messages', {
          label: 'ARGS_DEBUG',
          aiName,
          messagesCount: baseMessages.length,
          messages: baseMessages.map((m, idx) => ({
            index: idx,
            role: m.role,
            contentPreview: clip(m.content, 200)
          }))
        });
      }
      
      const resp = await chatCompletion({
        messages: baseMessages,
        tools: perStepTools,
        tool_choice: { type: 'function', function: { name: aiName } },
        temperature: config.llm.temperature
      });
      const call = resp.choices?.[0]?.message?.tool_calls?.[0];
      if (call?.function?.arguments) {
        try {
          toolArgs = JSON.parse(call.function.arguments);
        } catch (e) {
          logger.warn?.('参数解析失败', { label: 'ARGGEN', aiName, error: String(e) });
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
            const required_line = (Array.isArray(requiredList) && requiredList.length) ? `- 必须包含必填字段：${requiredList.join(', ')}` : '';
            const missing_line = Array.isArray(lastMissing2) && lastMissing2.length ? `- 缺少字段：${lastMissing2.join(', ')}` : '';
            const invalid_line = Array.isArray(lastInvalid2) && lastInvalid2.length ? `- 类型不匹配字段：${lastInvalid2.join(', ')}` : '';
            reinforce = renderTemplate(tplRe, { required_line, missing_line, invalid_line, attempt: String(attempt), max_retries: String(maxRetries) });
          }
          // Auto 回退：baseMessages 已包含完整 user，使用 compactMessages 合并避免两条 user
          const messagesFC = compactMessages([
            ...baseMessages, 
            { role: 'user', content: [reinforce, instruction].filter(Boolean).join('\n\n') }
          ]);
          
          // 调试日志：打印 auto 回退请求的 messages 数组
          if (config.flags.enableVerboseSteps) {
            logger.info('ArgGen Auto回退 请求 messages', {
              label: 'ARGS_DEBUG',
              aiName,
              attempt,
              messagesCount: messagesFC.length,
              messages: messagesFC.map((m, idx) => ({
                index: idx,
                role: m.role,
                contentPreview: clip(m.content, 200)
              }))
            });
          }
          
          const argModel = getStageModel('arg');
          const resp2 = await chatCompletion({
            messages: messagesFC,
            temperature: fc.temperature ?? config.llm.temperature,
            apiKey: fc.apiKey,
            baseURL: fc.baseURL,
            model: argModel,
            ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
          });
          const content2 = resp2?.choices?.[0]?.message?.content || '';
          if (config.flags.enableVerboseSteps || !content2) {
            logger.info('FC 参生(回退)：模型原始响应内容', {
              label: 'ARGS',
              aiName,
              attempt,
              provider: { baseURL: fc.baseURL, model: fc.model },
              contentPreview: clip(String(content2)),
              length: String(content2 || '').length
            });
          }
          const calls2 = parseFunctionCalls(String(content2), {});
          if (config.flags.enableVerboseSteps || calls2.length === 0) {
            logger.info('FC 参生(回退)：解析到的工具调用数量', { label: 'ARGS', aiName, attempt, count: calls2.length, firstCallPreview: clip(calls2?.[0]) });
          }
          const target2 = calls2.find((c) => String(c.name) === String(aiName)) || calls2[0];
          if (target2 && target2.arguments && typeof target2.arguments === 'object') {
            const okReq2 = Array.isArray(requiredList) && requiredList.length ? requiredList.every((k) => Object.prototype.hasOwnProperty.call(target2.arguments, k)) : true;
            if (okReq2) { toolArgs = target2.arguments; break; }
            const props2 = ((currentToolFull?.inputSchema || {}).properties) || {};
            lastMissing2 = Array.isArray(requiredList) ? requiredList.filter((k) => !Object.prototype.hasOwnProperty.call(target2.arguments, k)) : [];
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
 * 参数校验和修复
 * @param {Object} params
 * @param {Object} params.schema - JSON Schema
 * @param {Object} params.toolArgs - 工具参数
 * @param {string} params.aiName - 工具名称
 * @returns {Promise<Object>} { valid, errors, args }
 */
export async function validateArgs(params) {
  const { schema, toolArgs, aiName } = params;

  // 中文：在参数校验前做一次“类型兜底”——对 schema 声明为 string 的字段，若值非字符串则转为字符串
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
  } catch {}

  try {
    const out = validateAndRepairArgs(schema, toolArgs);
    if (!out.valid && config.flags.enableVerboseSteps) {
      logger.warn?.('参数校验不通过，已尝试轻量修复', {
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
    logger.warn?.('参数校验过程异常（忽略并继续）', {
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
 * 参数纠错（当校验失败时调用）
 * @param {Object} params
 * @param {string} params.runId - 运行 ID
 * @param {number} params.stepIndex - 步骤索引
 * @param {string} params.objective - 总体目标
 * @param {Object} params.step - 当前步骤
 * @param {Object} params.currentToolFull - 完整工具定义
 * @param {Object} params.schema - JSON Schema
 * @param {Array} params.ajvErrors - 校验错误
 * @param {number} params.totalSteps - 总步骤数
 * @returns {Promise<Object>} 修正后的参数
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

  try {
    const requiredList = Array.isArray((schema || {}).required) ? schema.required : [];

    // 判断是否使用 FC 模式（需要在构建上下文前判断）
    const useFC = String(config.llm?.toolStrategy || 'auto') === 'fc';
    const requiredDetail = useFC
      ? summarizeRequiredFieldsDetailXml(schema || {})
      : summarizeRequiredFieldsDetail(schema || {});
    const useAuto = String(config.llm?.toolStrategy || 'auto') === 'auto';
    
    // FC 模式使用专用模板（XML 结构化格式）
    const ap = await loadPrompt(useFC ? 'arggen_fc' : 'arggen');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayFix = overlays.arggen_fix?.system || overlays.arggen_fix || overlays.argfix || overlays.arggen || '';
    
    // FC 模式：构建 system（协议在前，用户内容在后）
    let sysFix;
    if (useFC) {
      const policy = await buildFCPolicy();
      const userSystem = [overlayGlobal, overlayFix, ap.system_fix].filter(Boolean).join('\n\n');
      sysFix = userSystem 
        ? `${policy}\n\n---\n【Protocol Requirements】Above is system protocol, must be strictly followed. Below are specific task settings and requirements:\n---\n\n${userSystem}`
        : policy;
    } else {
      sysFix = composeSystem(ap.system_fix, [overlayGlobal, overlayFix].filter(Boolean).join('\n\n'));
    }
    
    // FC 模式：不提前包装 objective（新模板已在整体结构外层使用 <sentra-user-question>）
    const objectiveTextFix = objective;
    
    const taskInstructionFix = renderTemplate(ap.user_task_fix, {
      objective: objectiveTextFix,
      stepIndex: stepIndex + 1,
      totalSteps,
      aiName,
      reason: reason || '',
      description: currentToolFull?.description || '',
      draftArgs: draftArgs ? JSON.stringify(draftArgs, null, 2) : '(无)',
      errors: JSON.stringify(ajvErrors || [], null, 2),
      requiredList: Array.isArray(requiredList) && requiredList.length ? requiredList.join(', ') : '(无)',
      requiredDetail: requiredDetail || '(无)'
    });

    // 构建上下文（FC 模式使用 XML 格式）
    const dialogueMsgs = await buildToolDialogueMessages(runId, stepIndex, useFC);
    const depAppendText = await buildDependentContextText(runId, step.dependsOn, useFC);

    const messagesFix = compactMessages([
      { role: 'system', content: sysFix },
      ...dialogueMsgs,
      { role: 'user', content: [taskInstructionFix, depAppendText || ''].filter(Boolean).join('\n\n') }
    ]);

    let fixedArgs = params.toolArgs;
    if (useFC) {
      const fc = config.fcLlm || {};
      const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
      const maxRetries = Math.max(1, Number(fc.argMaxRetries ?? 3));
      const missingFromAjv = Array.isArray(ajvErrors) ? ajvErrors.filter((e) => e?.keyword === 'required' && e?.params?.missingProperty).map((e) => e.params.missingProperty) : [];
      const invalidFromAjv = Array.isArray(ajvErrors) ? ajvErrors.filter((e) => e?.keyword === 'type' && e?.params?.type && (e.instancePath || e.dataPath)).map((e) => `${(e.instancePath || e.dataPath || '').replace(/^\./,'') || 'value'}(${e.params.type})`) : [];
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const instruction = await buildFunctionCallInstruction({ name: aiName, parameters: schema || { type: 'object', properties: {} }, locale: 'zh-CN' });
        let reinforce = '';
        if (attempt > 1) {
          const pfRe = await loadPrompt('fc_reinforce_args');
          const tplRe = pfRe.zh;
          const required_line = (Array.isArray((schema || {}).required) && (schema.required || []).length) ? `- 必须包含必填字段：${(schema.required || []).join(', ')}` : '';
          const missing_line = Array.isArray(missingFromAjv) && missingFromAjv.length ? `- 缺少字段：${missingFromAjv.join(', ')}` : '';
          const invalid_line = Array.isArray(invalidFromAjv) && invalidFromAjv.length ? `- 类型不匹配字段：${invalidFromAjv.join(', ')}` : '';
          reinforce = renderTemplate(tplRe, { required_line, missing_line, invalid_line, attempt: String(attempt), max_retries: String(maxRetries) });
        }
        const policy = await buildFCPolicy();
        const messagesFixFC = [...messagesFix, { role: 'user', content: [reinforce, policy, instruction].filter(Boolean).join('\n\n') }];
        const argModel = getStageModel('arg');
        const respFix = await chatCompletion({
          messages: messagesFixFC,
          temperature: fc.temperature ?? config.llm.temperature,
          apiKey: fc.apiKey,
          baseURL: fc.baseURL,
          model: argModel,
          ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
        });
        const contentFix = respFix?.choices?.[0]?.message?.content || '';
        if (config.flags.enableVerboseSteps || !contentFix) {
          logger.info('FC 参生纠错：模型原始响应内容', {
            label: 'ARGS',
            aiName,
            attempt,
            provider: { baseURL: fc.baseURL, model: fc.model },
            contentPreview: clip(String(contentFix)),
            length: String(contentFix || '').length
          });
        }
        const callsFix = parseFunctionCalls(String(contentFix), { format: (config.fcLlm?.format || 'sentra') });
        if (config.flags.enableVerboseSteps || callsFix.length === 0) {
          logger.info('FC 参生纠错：解析到的工具调用数量', { label: 'ARGS', aiName, attempt, count: callsFix.length, firstCallPreview: clip(callsFix?.[0]) });
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
        temperature: config.llm.temperature
      });
      const callFix = respFix.choices?.[0]?.message?.tool_calls?.[0];
      if (callFix?.function?.arguments) {
        try { fixedArgs = JSON.parse(callFix.function.arguments); } catch {}
      } else if (useAuto) {
        const fc = config.fcLlm || {};
        const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
        const maxRetries = Math.max(1, Number(fc.argMaxRetries ?? 3));
        const missingFromAjv2 = Array.isArray(ajvErrors) ? ajvErrors.filter((e) => e?.keyword === 'required' && e?.params?.missingProperty).map((e) => e.params.missingProperty) : [];
        const invalidFromAjv2 = Array.isArray(ajvErrors) ? ajvErrors.filter((e) => e?.keyword === 'type' && e?.params?.type && (e.instancePath || e.dataPath)).map((e) => `${(e.instancePath || e.dataPath || '').replace(/^\./,'') || 'value'}(${e.params.type})`) : [];
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const instruction = await buildFunctionCallInstruction({ name: aiName, parameters: schema || { type: 'object', properties: {} }, locale: 'zh-CN' });
          let reinforce = '';
          if (attempt > 1) {
            const pfRe = await loadPrompt('fc_reinforce_args');
            const tplRe = pfRe.zh;
            const required_line = (Array.isArray((schema || {}).required) && (schema.required || []).length) ? `- 必须包含必填字段：${(schema.required || []).join(', ')}` : '';
            const missing_line = Array.isArray(missingFromAjv2) && missingFromAjv2.length ? `- 缺少字段：${missingFromAjv2.join(', ')}` : '';
            const invalid_line = Array.isArray(invalidFromAjv2) && invalidFromAjv2.length ? `- 类型不匹配字段：${invalidFromAjv2.join(', ')}` : '';
            reinforce = renderTemplate(tplRe, { required_line, missing_line, invalid_line, attempt: String(attempt), max_retries: String(maxRetries) });
          }
          // FC 模式：policy 已在 system 中，这里只需要 reinforce 和 instruction
          const messagesFixFC = [...messagesFix, { role: 'user', content: [reinforce, instruction].filter(Boolean).join('\n\n') }];

          // 调试日志：打印修复请求的 messages 数组
          if (config.flags.enableVerboseSteps) {
            logger.info('ArgGen FC 修复请求 messages', {
              label: 'ARGS_FIX_DEBUG',
              aiName,
              attempt,
              messagesCount: messagesFixFC.length,
              messages: messagesFixFC.map((m, idx) => ({
                index: idx,
                role: m.role,
                contentPreview: clip(m.content, 200)
              }))
            });
          }

          const argModel = getStageModel('arg');
          const respFix2 = await chatCompletion({
            messages: messagesFixFC,
            temperature: fc.temperature ?? config.llm.temperature,
            apiKey: fc.apiKey,
            baseURL: fc.baseURL,
            model: argModel,
            ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
          });
          const contentFix2 = respFix2?.choices?.[0]?.message?.content || '';
          if (config.flags.enableVerboseSteps || !contentFix2) {
            logger.info('FC 参生纠错(回退)：模型原始响应内容', {
              label: 'ARGS',
              aiName,
              attempt,
              provider: { baseURL: fc.baseURL, model: fc.model },
              contentPreview: clip(String(contentFix2)),
              length: String(contentFix2 || '').length
            });
          }
          const callsFix2 = parseFunctionCalls(String(contentFix2), { format: (config.fcLlm?.format || 'sentra') });
          if (config.flags.enableVerboseSteps || callsFix2.length === 0) {
            logger.info('FC 参生纠错(回退)：解析到的工具调用数量', { label: 'ARGS', aiName, attempt, count: callsFix2.length, firstCallPreview: clip(callsFix2?.[0]) });
          }
          const targetFix2 = callsFix2.find((c) => String(c.name) === String(aiName)) || callsFix2[0];
          if (targetFix2 && targetFix2.arguments) { fixedArgs = targetFix2.arguments; break; }
        }
      }
    }

    // 重新校验
    try {
      const out2 = validateAndRepairArgs(schema, fixedArgs);
      if (!out2.valid && config.flags.enableVerboseSteps) {
        logger.warn?.('纠错回合后参数仍未通过校验', {
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
    logger.warn?.('纠错回合异常（忽略）', {
      label: 'ARGS',
      aiName: step.aiName,
      error: String(e)
    });
    return params.toolArgs;
  }
}

/**
 * 尝试复用历史参数
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
            logger.info('复用参数已按schema裁剪', { label: 'MEM', aiName, dropped });
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
    logger.warn?.('参数复用失败', { label: 'MEM', error: String(e) });
  }

  return { reused: false };
}
