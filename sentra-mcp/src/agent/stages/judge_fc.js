/**
 * 判断阶段：判断是否需要调用工具（FC 模式）
 * 使用 Sentra XML 协议进行工具调用
 */

import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { manifestToXmlToolsCatalog } from '../plan/manifest.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { compactMessages, normalizeConversation } from '../utils/messages.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy } from '../../utils/fc.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolDef } from '../tools/loader.js';
import logger from '../../logger/index.js';

/**
 * 前置判定：判断是否需要调用工具（FC 模式）
 * @param {string} objective - 目标描述
 * @param {Array} manifest - 工具清单
 * @param {Array} conversation - 对话历史
 * @param {Object} context - 上下文信息
 * @returns {Promise<{need: boolean, summary: string, toolNames: string[]}>}
 */
export async function judgeToolNecessityFC(objective, manifest, conversation, context = {}) {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const allowedToolNames = Array.from(
      new Set((Array.isArray(manifest) ? manifest : []).map((m) => m?.aiName).filter(Boolean))
    );
    const toolDef = await loadToolDef({
      baseDir: __dirname,
      toolPath: '../tools/internal/emit_decision.tool.json',
      schemaPath: '../tools/internal/emit_decision.schema.json',
      mutateSchema: (schema) => {
        const items = schema?.properties?.tool_names?.items;
        if (items && Array.isArray(allowedToolNames) && allowedToolNames.length > 0) {
          items.enum = allowedToolNames;
        }
      },
      fallbackTool: { 
        type: 'function', 
        function: { 
          name: 'emit_decision', 
          description: '判断是否需要调用外部工具。返回结构化结果。', 
          parameters: { 
            type: 'object', 
            properties: { 
              need_tools: { type: 'boolean' }, 
              summary: { type: 'string' },
              tool_names: { type: 'array', items: { type: 'string' } }
            }, 
            required: ['need_tools', 'tool_names'], 
            additionalProperties: true 
          } 
        } 
      },
      fallbackSchema: { 
        type: 'object', 
        properties: { 
          need_tools: { type: 'boolean' }, 
          summary: { type: 'string' },
          tool_names: { type: 'array', items: { type: 'string' } }
        }, 
        required: ['need_tools', 'tool_names'], 
        additionalProperties: true 
      },
    });

    // 优先使用 FC 专用提示词，如果不存在则回退到通用 judge 提示词
    let jp;
    try {
      jp = await loadPrompt('judge_fc');
    } catch {
      jp = await loadPrompt('judge');
    }
    
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayJud = overlays.judge?.system || overlays.judge || '';
    const baseSystem = composeSystem(jp.system, [overlayGlobal, overlayJud].filter(Boolean).join('\n\n'));
    const manifestXml = manifestToXmlToolsCatalog(Array.isArray(manifest) ? manifest : []);
    
    // FC 模式：使用 Sentra XML 协议（统一使用英文提示词）
    const policy = await buildFCPolicy({ locale: 'en' });
    const fcInstruction = await buildFunctionCallInstruction({
      name: 'emit_decision',
      parameters: toolDef.function?.parameters || { type: 'object', properties: {} },
      locale: 'en'
    });
    
    const systemContent = [
      baseSystem,
      jp.concurrency_hint || '',
      jp.manifest_intro,
      manifestXml,
      policy,
      fcInstruction,
    ].filter(Boolean).join('\n');

    const conv = normalizeConversation(conversation);
    const userGoal = renderTemplate(jp.user_goal, { objective });
    const msgs = compactMessages([
      { role: 'system', content: systemContent },
      ...conv,
      { role: 'user', content: userGoal },
    ]);
    
    // Debug logging: 输出关键信息
    logger.debug?.('Judge FC 上下文构建', {
      label: 'JUDGE',
      toolCount: manifest.length,
      tools: manifest.slice(0, 5).map(m => m.aiName || m.name).join(', ') + (manifest.length > 5 ? '...' : ''),
      conversationLength: conv.length,
      objectivePreview: objective.substring(0, 200) + (objective.length > 200 ? '...' : ''),
      systemContentLength: systemContent.length,
      userGoalLength: userGoal.length
    });

    // 获取 FC 模式的模型配置（支持多模型列表）
    const defaultModel = getStageModel('judge');
    const models = Array.isArray(config?.fcLlm?.judgeModels) && config.fcLlm.judgeModels.length
      ? config.fcLlm.judgeModels
      : [defaultModel];

    const useOmit = Number(config?.fcLlm?.maxTokens ?? -1) <= 0;
    const timeoutMs = Math.max(0, Number(config?.judge?.raceTimeoutMs ?? 12000));
    const withTimeout = (p, ms) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('judge_timeout')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); })
       .catch((err) => { clearTimeout(t); reject(err); });
    });

    const provider = getStageProvider('judge');
    const attemptOnce = async (modelName) => {
      const res = await chatCompletion({
        messages: msgs,
        omitMaxTokens: useOmit,
        max_tokens: useOmit ? undefined : Number(config.fcLlm.maxTokens),
        temperature: Number(config.fcLlm.temperature ?? 0.2),
        timeoutMs: getStageTimeoutMs('judge'),
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        model: modelName,
      });
      const content = res?.choices?.[0]?.message?.content || '';
      const calls = parseFunctionCalls(String(content), {});
      const call = calls.find((c) => String(c.name) === 'emit_decision') || calls[0];
      let parsed;
      try {
        parsed = call?.arguments || null;
      } catch {
        parsed = null;
      }
      if (!parsed) throw new Error('judge_fc_parse_failed');
      const need = !!parsed.need_tools;
      const summary = String(parsed.summary || '').trim();
      const toolNames = Array.isArray(parsed.tool_names) ? parsed.tool_names.filter(Boolean) : [];
      logger.info?.('Judge结果（FC模式）', { need, summary, toolNames: toolNames.length > 0 ? toolNames : '(无)', model: modelName, label: 'JUDGE' });
      return { need, summary, toolNames, ok: true };
    };
    // 并发尝试多个 Judge 模型（FC 模式）：第一个成功返回的结果获胜
    if (models.length === 1) {
      try {
        const attemptPromise = attemptOnce(models[0]);
        const result = timeoutMs > 0 ? await withTimeout(attemptPromise, timeoutMs) : await attemptPromise;
        if (result && result.ok) return result;
      } catch (e) {
        logger.warn?.('Judge FC 模型尝试失败', { label: 'JUDGE', model: models[0], error: String(e) });
      }
      logger.error?.('Judge阶段异常（FC模式）', { label: 'JUDGE', error: 'single judge model failed' });
      return { need: false, summary: 'Judge阶段异常（FC）', toolNames: [], ok: false };
    }

    const tasks = models.map((modelName) => (async () => {
      try {
        const attemptPromise = attemptOnce(modelName);
        const result = timeoutMs > 0 ? await withTimeout(attemptPromise, timeoutMs) : await attemptPromise;
        return result;
      } catch (e) {
        logger.warn?.('Judge FC 模型尝试失败（并发）', { label: 'JUDGE', model: modelName, error: String(e) });
        throw e;
      }
    })());

    try {
      const first = await Promise.any(tasks);
      if (first && first.ok) return first;
    } catch (e) {
      logger.error?.('Judge阶段异常（FC模式）：所有模型均失败', { label: 'JUDGE', error: String(e) });
    }

    return { need: false, summary: 'Judge阶段异常（FC）', toolNames: [], ok: false };
  } catch (e) {
    logger.error?.('Judge阶段异常（FC模式）', { label: 'JUDGE', error: String(e) });
    return { need: false, summary: 'Judge阶段异常（FC）', toolNames: [], ok: false };
  }
}
