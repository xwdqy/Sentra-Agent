import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../config/index.js';
import logger from '../logger/index.js';
import { HistoryStore } from '../history/store.js';
import { chatCompletion } from '../openai/client.js';
import { loadPrompt, renderTemplate, composeSystem } from './prompts/loader.js';
import { getPreThought } from './stages/prethought.js';
import { clip } from '../utils/text.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy } from '../utils/fc.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 最终总结：统一走 FC <sentra-tools> 方案
 * @returns {Object} { success: boolean, summary: string, error?: string, attempts?: number }
 */
export async function summarizeToolHistory(runId, objective = '', context = {}) {
  try {
    const history = await HistoryStore.list(runId, 0, -1);
    const fsPrompt = await loadPrompt('final_summary');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlaySum = overlays.final_summary?.system || overlays.final_summary || overlays.summary?.system || overlays.summary || '';
    const sys = composeSystem(fsPrompt.system, [overlayGlobal, overlaySum].filter(Boolean).join('\n\n'));
    let preThought = '';
    if (config.flags.summaryUsePreThought) {
      preThought = await getPreThought(objective || '总结工具调用与执行结果', [], []);
    }

    const baseMsgs = [
      { role: 'system', content: sys },
      { role: 'user', content: renderTemplate(fsPrompt.user_goal, { objective: objective || '总结工具调用与执行结果' }) },
      ...(config.flags.summaryUsePreThought ? [
        { role: 'assistant', content: renderTemplate(fsPrompt.assistant_thought || '思考（前置推演）：\n{{preThought}}', { preThought }) },
      ] : []),
      { role: 'user', content: fsPrompt.user_history_intro },
      { role: 'assistant', content: JSON.stringify({ runId, history }) },
      { role: 'user', content: fsPrompt.user_request }
    ];

    // 读取 final_summary 的 schema
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const schemaPath = path.resolve(__dirname, './tools/internal/final_summary.schema.json');
    let summarySchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
    try {
      const rawSchema = await fs.readFile(schemaPath, 'utf-8');
      summarySchema = JSON.parse(rawSchema);
    } catch {}

    const policy = await buildFCPolicy();
    const instr = await buildFunctionCallInstruction({ name: 'final_summary', parameters: summarySchema, locale: 'zh-CN' });

    const fc = config.fcLlm || {};
    const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
    // 默认只尝试 1 次，避免浪费 token（可通过 FC_SUMMARY_MAX_RETRIES 环境变量配置）
    const maxRetries = Math.max(1, Number(fc.summaryMaxRetries ?? 1));
    const temperature = Number.isFinite(config.fcLlm?.summaryTemperature) ? config.fcLlm.summaryTemperature : (Number.isFinite(fc.temperature) ? Math.min(0.3, fc.temperature) : 0.1);
    const top_p = Number.isFinite(config.fcLlm?.summaryTopP) ? config.fcLlm.summaryTopP : undefined;

    let summaryText = '';
    let lastContent = '';
    let lastError = null;
    let actualAttempts = 0;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      actualAttempts = attempt;
      let reinforce = '';
      if (attempt > 1) {
        try {
          const pr = await loadPrompt('fc_reinforce_summary');
          const tpl = pr.zh;
          reinforce = renderTemplate(tpl, { attempt: String(attempt), max_retries: String(maxRetries) });
        } catch {}
      }
      const messages = [...baseMsgs, { role: 'user', content: [reinforce, policy, instr].filter(Boolean).join('\n\n') }];
      const provider = getStageProvider('summary');
      const summaryModel = getStageModel('summary');
      const res = await chatCompletion({
        messages,
        temperature,
        top_p,
        timeoutMs: getStageTimeoutMs('summary'),
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        model: summaryModel,
        ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
      });
      const content = res?.choices?.[0]?.message?.content || '';
      lastContent = content;
      logger.info('FC 总结：模型原始响应内容', {
        label: 'SUMMARY', attempt,
        provider: { baseURL: provider.baseURL, model: summaryModel },
        contentPreview: clip(String(content)),
        length: String(content || '').length
      });

      const calls = parseFunctionCalls(String(content), {});
      logger.info('FC 总结：解析到的工具调用数量', { label: 'SUMMARY', attempt, count: calls.length, firstCallPreview: clip(calls?.[0]) });
      
      if (calls.length === 0) {
        lastError = `第 ${attempt} 次尝试：未能解析到任何工具调用`;
        if (config.flags.enableVerboseSteps) {
          logger.warn('Summary 解析失败：未能解析到工具调用', { 
            label: 'SUMMARY', 
            attempt, 
            maxRetries,
            contentPreview: clip(content, 500),
            willRetry: attempt < maxRetries
          });
        }
        continue;
      }
      
      const call = calls.find((c) => String(c.name) === 'final_summary') || calls[0];
      
      if (!call) {
        lastError = `第 ${attempt} 次尝试：未找到 final_summary 调用`;
        if (config.flags.enableVerboseSteps) {
          logger.warn('Summary 解析失败：未找到 final_summary 调用', { 
            label: 'SUMMARY', 
            attempt, 
            maxRetries,
            parsedCalls: calls.map(c => c.name),
            willRetry: attempt < maxRetries
          });
        }
        continue;
      }
      
      if (call.name !== 'final_summary') {
        lastError = `第 ${attempt} 次尝试：调用了错误的工具 "${call.name}"，期望 "final_summary"`;
        if (config.flags.enableVerboseSteps) {
          logger.warn('Summary 解析失败：工具名称错误', { 
            label: 'SUMMARY', 
            attempt, 
            maxRetries,
            actualTool: call.name,
            expectedTool: 'final_summary',
            willRetry: attempt < maxRetries
          });
        }
        continue;
      }
      
      try {
        const args = call?.arguments || {};
        
        // 检查必需字段
        if (!Object.prototype.hasOwnProperty.call(args, 'success')) {
          lastError = `第 ${attempt} 次尝试：缺少 success 字段`;
          if (config.flags.enableVerboseSteps) {
            logger.warn('Summary 验证失败：缺少 success 字段', { 
              label: 'SUMMARY', 
              attempt, 
              maxRetries,
              receivedFields: Object.keys(args),
              willRetry: attempt < maxRetries
            });
          }
          continue;
        }
        
        if (typeof args.summary !== 'string' || !args.summary.trim()) {
          lastError = `第 ${attempt} 次尝试：summary 字段为空或不是字符串类型`;
          if (config.flags.enableVerboseSteps) {
            logger.warn('Summary 验证失败：summary 字段无效', { 
              label: 'SUMMARY', 
              attempt, 
              maxRetries,
              summaryType: typeof args.summary,
              summaryValue: String(args.summary || '').slice(0, 50),
              willRetry: attempt < maxRetries
            });
          }
          continue;
        }
        
        // 解析成功，保存完整结果
        summaryText = args.summary.trim();
        const taskSuccess = Boolean(args.success);
        const failedSteps = Array.isArray(args.failedSteps) ? args.failedSteps : [];
        const highlights = Array.isArray(args.highlights) ? args.highlights : [];
        
        lastError = null;  // 成功，清除错误
        
        // 保存额外信息供后续使用
        summaryText._taskSuccess = taskSuccess;
        summaryText._failedSteps = failedSteps;
        summaryText._highlights = highlights;
        
        break;
      } catch (e) {
        lastError = `第 ${attempt} 次尝试：解析参数失败 - ${String(e)}`;
      }
    }

    // 返回结构化结果
    if (summaryText) {
      // 成功：提取保存的额外信息
      const taskSuccess = summaryText._taskSuccess ?? true;
      const failedSteps = summaryText._failedSteps || [];
      const highlights = summaryText._highlights || [];
      
      // 转换回纯字符串
      const summaryStr = String(summaryText);
      
      await HistoryStore.setSummary(runId, summaryStr);
      if (config.flags.enableVerboseSteps) {
        logger.info('总结生成成功', {
          label: 'SUMMARY',
          attempts: actualAttempts,
          taskSuccess,
          failedStepsCount: failedSteps.length,
          summaryPreview: clip(summaryStr, 200)
        });
      }
      return {
        success: true,
        summary: summaryStr,
        taskSuccess,       // 任务整体是否成功
        failedSteps,       // 失败的步骤
        highlights,        // 关键成果
        attempts: actualAttempts
      };
    } else {
      // 失败
      const raw = String(lastContent || '');
      const rawSlice = raw.length > 4000 ? `${raw.slice(0, 4000)}…[truncated ${raw.length - 4000}]` : raw;
      const errorMsg = lastError || '未能解析到有效的总结内容';
      
      logger.warn?.('总结生成失败', { 
        label: 'SUMMARY', 
        attempts: actualAttempts,
        error: errorMsg,
        contentRaw: rawSlice 
      });
      
      // 即使失败也保存空总结
      await HistoryStore.setSummary(runId, '');
      
      return {
        success: false,
        summary: '',
        error: errorMsg,
        attempts: actualAttempts,
        lastContent: rawSlice
      };
    }
  } catch (e) {
    logger.error('总结步骤异常', { label: 'SUMMARY', runId, error: String(e) });
    return {
      success: false,
      summary: '',
      error: `总结步骤异常: ${String(e)}`,
      attempts: 0
    };
  }
}

export default { summarizeToolHistory };
