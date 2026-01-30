import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import logger from '../../logger/index.js';
import { HistoryStore } from '../../history/store.js';
import { chatCompletion } from '../../openai/client.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy, formatSentraResult } from '../../utils/fc.js';
import { clip } from '../../utils/text.js';
import { manifestToXmlToolsCatalog } from '../plan/manifest.js';
import { buildSelectedSkillsInstructionsText } from '../../skills/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reflection 阶段：检查任务完整性，识别遗漏的操作
 * 
 * 基于 LLM Agent Reflection 最佳实践：
 * - Global Reflection：分析整个任务历史
 * - Goal-Driven：基于目标判断完整性
 * - Adaptive：动态调整判断标准
 * 
 * @param {string} runId - 运行 ID
 * @param {string} objective - 任务目标
 * @param {Object} manifest - 可用工具清单
 * @param {Object} context - 上下文（promptOverlays 等）
 * @returns {Object} { isComplete: boolean, analysis: string, missings: string[], supplements: Array }
 */
export async function checkTaskCompleteness(runId, objective = '', manifest = {}, context = {}) {
  try {
    // 读取执行历史
    const history = await HistoryStore.list(runId, 0, -1);
    
    // 过滤出工具执行结果
    const toolResults = history.filter(h => h.type === 'tool_result');
    
    if (toolResults.length === 0) {
      // 没有执行任何工具，直接返回完整（避免不必要的补充）
      logger.info('Reflection: 任务未执行任何工具，判定为完整', { label: 'REFLECTION', runId });
      return {
        isComplete: true,
        analysis: '任务未执行任何工具，无需补充。',
        missings: [],
        supplements: []
      };
    }
    
    // 构建工具清单（XML，包含已使用和未使用的工具）
    const availableTools = manifestToXmlToolsCatalog(Array.isArray(manifest) ? manifest : []);
    
    // 构建工具执行历史（Sentra XML 格式）
    const toolHistoryXML = toolResults.map((h, idx) => {
      const step = history.filter(x => x.type === 'args' && x.aiName === h.aiName).findIndex(x => x.stepIndex === h.stepIndex);
      const stepIndex = step >= 0 ? step : idx;
      const reasonEntry = history.find(x => x.type === 'args' && x.stepIndex === h.stepIndex);
      const reason = Array.isArray(reasonEntry?.reason) 
        ? reasonEntry.reason.join('; ') 
        : String(reasonEntry?.reason || '执行工具');
      
      return formatSentraResult({
        stepIndex,
        aiName: h.aiName,
        reason,
        args: h.args || {},
        result: h.result || {}
      });
    }).join('\n\n');
    
    // 加载提示词
    const rfPrompt = await loadPrompt('reflection_fc');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayReflection = overlays.reflection?.system || overlays.reflection || '';
    const sys = composeSystem(rfPrompt.system, [overlayGlobal, overlayReflection].filter(Boolean).join('\n\n'));

    const skillsText = buildSelectedSkillsInstructionsText({
      selected: Array.isArray(context?.selectedSkills) ? context.selectedSkills : []
    });
    
    // 构建消息数组（使用 Sentra XML 格式传递工具历史）
    const baseMsgs = [
      { role: 'system', content: sys },
      { role: 'user', content: renderTemplate(rfPrompt.user_objective, { objective: objective || '无明确目标' }) },
      ...(skillsText ? [{ role: 'user', content: skillsText }] : []),
      { role: 'user', content: rfPrompt.user_history_intro },
      { role: 'assistant', content: toolHistoryXML },
      { role: 'user', content: renderTemplate(rfPrompt.user_available_tools, { availableTools }) },
      { role: 'user', content: rfPrompt.user_request }
    ];
    
    // 读取 check_completeness schema
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
      logger.warn('Reflection: 无法读取 check_completeness schema，使用默认', { label: 'REFLECTION', error: String(e) });
    }
    
    // 构建 FC 指令
    const policy = await buildFCPolicy();
    const instr = await buildFunctionCallInstruction({
      name: 'check_completeness',
      parameters: completenessSchema,
      locale: 'zh-CN'
    });
    
    // 获取 Reflection 模型配置
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
    
    // 尝试多次调用（处理解析失败）
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const reinforce = attempt > 1
        ? '注意：如果 is_complete=false，missing_aspects 和 suggested_supplements 必须各至少包含 1 项。请严格输出所有 4 个字段。'
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
      
      logger.info('Reflection: 模型响应', {
        label: 'REFLECTION',
        attempt,
        provider: { baseURL: provider.baseURL, model: reflectionModel },
        contentPreview: clip(String(content))
      });
      
      // 解析函数调用
      const calls = parseFunctionCalls(String(content), {});
      
      if (calls.length === 0) {
        lastError = `第 ${attempt} 次尝试：未能解析到工具调用`;
        continue;
      }
      
      const call = calls.find((c) => String(c.name) === 'check_completeness') || calls[0];
      
      if (!call || call.name !== 'check_completeness') {
        lastError = `第 ${attempt} 次尝试：调用了错误的工具 "${call?.name}"，期望 "check_completeness"`;
        continue;
      }
      
      try {
        const args = call?.arguments || {};
        
        // 验证必需字段
        if (!Object.prototype.hasOwnProperty.call(args, 'is_complete')) {
          lastError = `第 ${attempt} 次尝试：缺少 is_complete 字段`;
          continue;
        }
        
        if (typeof args.completeness_analysis !== 'string' || !args.completeness_analysis.trim()) {
          lastError = `第 ${attempt} 次尝试：completeness_analysis 字段为空或不是字符串`;
          continue;
        }
        
        // 解析成功
        result = {
          isComplete: Boolean(args.is_complete),
          analysis: String(args.completeness_analysis).trim(),
          missings: Array.isArray(args.missing_aspects) ? args.missing_aspects : [],
          supplements: Array.isArray(args.suggested_supplements) ? args.suggested_supplements : []
        };
        
        // 业务校验：若判定为不完整，但任一数组为空，则视为输出不合规，进入下一次重试
        if (
          result && result.isComplete === false &&
          Array.isArray(result.missings) && Array.isArray(result.supplements) &&
          (result.missings.length === 0 || result.supplements.length === 0)
        ) {
          lastError = `第 ${attempt} 次尝试：is_complete=false 但 ${result.missings.length === 0 ? 'missing_aspects 为空' : ''}${result.missings.length === 0 && result.supplements.length === 0 ? ' 且 ' : ''}${result.supplements.length === 0 ? 'suggested_supplements 为空' : ''}`.trim();
          continue;
        }
        
        lastError = null;
        break;
      } catch (e) {
        lastError = `第 ${attempt} 次尝试：解析参数失败 - ${String(e)}`;
      }
    }
    
    // 返回结果
    if (result) {
      // 兜底修正：若仍为不完整但任一数组为空，自动补全
      if (result.isComplete === false && Array.isArray(result.missings) && Array.isArray(result.supplements)) {
        try {
          const failed = toolResults.filter((tr) => Number(tr?.result?.success) !== 1);
          if (failed.length > 0) {
            if (result.missings.length === 0) {
              result.missings = failed.map((tr, i) => `步骤${i}失败`);
            }
            if (result.supplements.length === 0) {
              result.supplements = failed.map((tr, i) => ({
                operation: `重试 ${String(tr.aiName || '工具')}`.trim(),
                reason: `第${i}步 ${String(tr.aiName || '工具')} 调用失败：${String(tr.result?.error || tr.result?.message || '未知错误')}。需要重试以完成目标。`,
                suggested_tools: [tr.aiName].filter(Boolean)
              }));
            }
          }
          // 若没有失败步骤，但 missings 非空而 supplements 为空：基于 missings 生成通用补充建议
          if (result.supplements.length === 0 && result.missings.length > 0) {
            result.supplements = result.missings.map((m) => ({
              operation: String(m).slice(0, 50),
              reason: `针对遗漏事项“${String(m)}”进行补充执行，以确保任务完整。`,
              suggested_tools: []
            }));
          }
          // 若 supplements 非空但 missings 为空：由补充操作反推遗漏点
          if (result.missings.length === 0 && result.supplements.length > 0) {
            result.missings = result.supplements.map((s) => String(s?.operation || '未完成的关键操作'));
          }
        } catch {}
      }
      
      logger.info('Reflection: 完整性检查完成', {
        label: 'REFLECTION',
        runId,
        isComplete: result.isComplete,
        missingsCount: result.missings.length,
        supplementsCount: result.supplements.length,
        analysis: clip(result.analysis, 200)
      });
      
      return result;
    } else {
      // 解析失败，默认判定为完整（避免错误补充）
      logger.warn('Reflection: 解析失败，默认判定为完整', {
        label: 'REFLECTION',
        runId,
        error: lastError,
        contentRaw: clip(lastContent, 500)
      });
      
      return {
        isComplete: true,
        analysis: '完整性检查失败，默认判定为完整。',
        missings: [],
        supplements: [],
        error: lastError
      };
    }
  } catch (e) {
    logger.error('Reflection: 完整性检查异常', { label: 'REFLECTION', runId, error: String(e) });
    
    // 异常情况，默认判定为完整（避免错误补充）
    return {
      isComplete: true,
      analysis: '完整性检查异常，默认判定为完整。',
      missings: [],
      supplements: [],
      error: String(e)
    };
  }
}

export default { checkTaskCompleteness };
