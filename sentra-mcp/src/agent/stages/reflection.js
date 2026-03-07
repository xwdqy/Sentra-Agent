import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import logger from '../../logger/index.js';
import { HistoryStore } from '../../history/store.js';
import { chatCompletion } from '../../openai/client.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy, formatSentraResult } from '../../utils/fc.js';
import { clip } from '../../utils/text.js';
import { manifestToXmlToolsCatalog } from '../plan/manifest.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function logReflectionFcPreview({ attempt, provider, model, content, calls }) {
  const count = Array.isArray(calls) ? calls.length : 0;
  const providerInfo = { baseURL: provider?.baseURL, model };
  if (count > 0) {
    logger.info('Reflection parsed output', {
      label: 'REFLECTION',
      attempt,
      provider: providerInfo,
      count,
      firstCallName: String(calls?.[0]?.name || ''),
      firstCallPreview: clip(calls?.[0]),
      length: String(content || '').length
    });
    return;
  }
  logger.warn('Reflection parse failed, fallback raw preview', {
    label: 'REFLECTION',
    attempt,
    provider: providerInfo,
    count: 0,
    rawPreview: clip(String(content)),
    length: String(content || '').length
  });
}

/**
 * Reflection 完整性检查阶段。
 * 使用 LLM Reflection 判断任务是否已经完整完成。
 * - Global Reflection: 最终完整性判定
 * @param {string} runId - 运行 ID
 * @param {string} objective - 当前目标
 * @param {Object} manifest - 可用工具清单
 * @param {Object} context - 上下文（包含 promptOverlays 等）
 * @returns {Object} { isComplete, analysis, missings, supplements }
 */
export async function checkTaskCompleteness(runId, objective = '', manifest = {}, context = {}) {
  try {
    // 获取执行历史
    const history = await HistoryStore.list(runId, 0, -1);
    const plan = await HistoryStore.getPlan(runId);
    
    const toolResults = history.filter(h => h.type === 'tool_result');
    
    if (toolResults.length === 0) {
      logger.info('Reflection: no tool execution, treat as complete', { label: 'REFLECTION', runId });
      return {
        isComplete: true,
        analysis: 'No tool execution records found; treat objective as complete.',
        missings: [],
        supplements: []
      };
    }
    // 生成可用工具 XML，供反思阶段参考
    const availableTools = manifestToXmlToolsCatalog(Array.isArray(manifest) ? manifest : []);
    
    const stepsArr = Array.isArray(plan?.steps) ? plan.steps : [];
    const toolHistoryXML = toolResults.map((h, idx) => {
      const plannedIdx = Number.isFinite(Number(h.plannedStepIndex)) ? Number(h.plannedStepIndex) : idx;
      const step = (plannedIdx >= 0 && plannedIdx < stepsArr.length) ? stepsArr[plannedIdx] : {};
      const displayIndex = Number.isFinite(Number(step?.displayIndex)) ? Number(step.displayIndex) : (plannedIdx + 1);
      const reason = Array.isArray(step?.reason) ? step.reason.join('; ') : String(step?.reason || '执行工具');

      return formatSentraResult({
        stepIndex: displayIndex,
        stepId: (typeof step?.stepId === 'string' ? step.stepId : h?.stepId),
        aiName: h.aiName,
        reason,
        args: h.args || {},
        result: h.result || {}
      });
    }).join('\n\n');
    
    const rfPrompt = await loadPrompt('reflection_fc');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayReflection = overlays.reflection?.system || overlays.reflection || '';
    const sys = composeSystem(rfPrompt.system, [overlayGlobal, overlayReflection].filter(Boolean).join('\n\n'));
    
    // 构造符合 Sentra XML 协议的消息
    const baseMsgs = [
      { role: 'system', content: sys },
      { role: 'user', content: renderTemplate(rfPrompt.user_objective, { objective: objective || '未提供目标' }) },
      { role: 'user', content: rfPrompt.user_history_intro },
      { role: 'assistant', content: toolHistoryXML },
      { role: 'user', content: renderTemplate(rfPrompt.user_available_tools, { availableTools }) },
      { role: 'user', content: rfPrompt.user_request }
    ];
    
    // 加载 check_completeness schema
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const schemaPath = path.resolve(__dirname, '../tools/internal/check_completeness.schema.json');
    let completenessSchema = {
      type: 'object',
      properties: {
        is_complete: { type: 'boolean' },
        completeness_analysis: { type: 'string' }
      },
      required: ['is_complete', 'completeness_analysis']
    };
    
    try {
      const rawSchema = await fs.readFile(schemaPath, 'utf-8');
      completenessSchema = JSON.parse(rawSchema);
    } catch (e) {
      logger.warn('Reflection: failed to load check_completeness schema, fallback to default', { label: 'REFLECTION', error: String(e) });
    }
    
    // 构建 FC 指令
    const policy = await buildFCPolicy();
    const instr = await buildFunctionCallInstruction({
      name: 'check_completeness',
      parameters: completenessSchema,
      locale: 'en'
    });
    
    // 反思阶段模型参数
    const fc = config.fcLlm || {};
    const reflectionModel = getStageModel('reflection');
    const temperature = Number.isFinite(fc.reflectionTemperature) 
      ? fc.reflectionTemperature 
      : (Number.isFinite(fc.temperature) ? Math.min(0.3, fc.temperature) : 0.2);
    const top_p = Number.isFinite(fc.reflectionTopP) ? fc.reflectionTopP : undefined;
    const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
    const maxRetries = Math.max(1, Number(fc.reflectionMaxRetries ?? 2));
    
    let result = null;
    let lastError = null;
    let lastContent = '';
    
    // 重试 + 逐步强化约束
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const reinforce = attempt > 1
        ? 'If is_complete is false, you must provide at least one missing_aspect and one suggested_supplement.'
        : '';
      const messages = [...baseMsgs, { role: 'user', content: [policy, instr, reinforce].filter(Boolean).join('\n\n') }];
      const provider = getStageProvider('reflection');
      
      const res = await chatCompletion({
        messages,
        temperature,
        top_p,
        timeoutMs: getStageTimeoutMs('reflection'),
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        model: reflectionModel,
        ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
      });
      
      const content = res?.choices?.[0]?.message?.content || '';
      lastContent = content;
      const calls = parseFunctionCalls(String(content), {});
      logReflectionFcPreview({ attempt, provider, model: reflectionModel, content, calls });
      if (calls.length === 0) {
        lastError = `第 ${attempt} 次：未解析到任何函数调用`;
        continue;
      }
      
      const call = calls.find((c) => String(c.name) === 'check_completeness') || calls[0];
      
      if (!call || call.name !== 'check_completeness') {
        lastError = `第 ${attempt} 次：函数名 "${call?.name}" 非法，期望 "check_completeness"`;
        continue;
      }
      
      try {
        const args = call?.arguments || {};
        
        // 字段校验
        if (!Object.prototype.hasOwnProperty.call(args, 'is_complete')) {
          lastError = `第 ${attempt} 次：缺少必填字段 is_complete`;
          continue;
        }
        
        if (typeof args.completeness_analysis !== 'string' || !args.completeness_analysis.trim()) {
          lastError = `第 ${attempt} 次：字段 completeness_analysis 不能为空`;
          continue;
        }
        
        // 解析成功
        result = {
          isComplete: Boolean(args.is_complete),
          analysis: String(args.completeness_analysis).trim(),
          missings: Array.isArray(args.missing_aspects) ? args.missing_aspects : [],
          supplements: Array.isArray(args.suggested_supplements) ? args.suggested_supplements : []
        };
        
        if (
          result && result.isComplete === false &&
          Array.isArray(result.missings) && Array.isArray(result.supplements) &&
          (result.missings.length === 0 || result.supplements.length === 0)
        ) {
          lastError = `第 ${attempt} 次：is_complete=false 时 ${result.missings.length === 0 ? 'missing_aspects 缺失' : ''}${result.missings.length === 0 && result.supplements.length === 0 ? '，' : ''}${result.supplements.length === 0 ? 'suggested_supplements 缺失' : ''}`.trim();
          continue;
        }
        
        lastError = null;
        break;
      } catch (e) {
        lastError = `第 ${attempt} 次：参数解析异常 - ${String(e)}`;
      }
    }
    
    // 后处理
    if (result) {
      if (result.isComplete === false && Array.isArray(result.missings) && Array.isArray(result.supplements)) {
        try {
          const failed = toolResults.filter((tr) => Number(tr?.result?.success) !== 1);
          if (failed.length > 0) {
            if (result.missings.length === 0) {
              result.missings = failed.map((tr, i) => `步骤${i + 1}失败`);
            }
            if (result.supplements.length === 0) {
              result.supplements = failed.map((tr, i) => ({
                operation: `重试 ${String(tr.aiName || '工具')}`.trim(),
                reason: `第 ${i + 1} 步 ${String(tr.aiName || '工具')} 调用失败：${String(tr.result?.error || tr.result?.message || '未知错误')}。需要重试以完成目标。`,
                suggested_tools: [tr.aiName].filter(Boolean)
              }));
            }
          }
          // 若 missings/supplements 其中之一为空，自动补齐
          if (result.supplements.length === 0 && result.missings.length > 0) {
            result.supplements = result.missings.map((m) => ({
              operation: String(m).slice(0, 50),
              reason: `缺失项“${String(m)}”未提供补充步骤，已自动生成默认补充建议。`,
              suggested_tools: []
            }));
          }
          if (result.missings.length === 0 && result.supplements.length > 0) {
            result.missings = result.supplements.map((s) => String(s?.operation || '未命名补充步骤'));
          }
        } catch {}
      }
      
      logger.info('Reflection: completeness check done', {
        label: 'REFLECTION',
        runId,
        isComplete: result.isComplete,
        missingsCount: result.missings.length,
        supplementsCount: result.supplements.length,
        analysis: clip(result.analysis, 200)
      });
      
      return result;
    } else {
      // 模型输出不合规时回退 complete，避免阻塞主流程
      logger.warn('Reflection: parse failed, fallback to complete', {
        label: 'REFLECTION',
        runId,
        error: lastError,
        contentRaw: clip(lastContent, 500)
      });
      
      return {
        isComplete: true,
        analysis: 'Reflection parse failed; fallback to complete.',
        missings: [],
        supplements: [],
        error: lastError
      };
    }
  } catch (e) {
    logger.error('Reflection: completeness check error', { label: 'REFLECTION', runId, error: String(e) });
    
    // 异常保护：反思失败不阻断流程
    return {
      isComplete: true,
      analysis: 'Reflection stage failed unexpectedly; fallback to complete.',
      missings: [],
      supplements: [],
      error: String(e)
    };
  }
}

export default { checkTaskCompleteness };
