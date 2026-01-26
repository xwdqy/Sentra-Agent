/**
 * 判断阶段：判断是否需要调用工具
 */

import { config, getStageTimeoutMs } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { manifestToBulletedText } from '../plan/manifest.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { compactMessages, normalizeConversation } from '../utils/messages.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolDef } from '../tools/loader.js';
import logger from '../../logger/index.js';

/**
 * 前置判定：是否需要调用工具
 */
/**
 * 前置判定：判断是否需要调用工具
 * @param {string} objective - 目标描述
 * @param {Array} manifest - 工具清单
 * @param {Array} conversation - 对话历史
 * @param {Object} context - 上下文信息
 * @returns {Promise<{need: boolean, summary: string, toolNames: string[]}>}
 */
export async function judgeToolNecessity(objective, manifest, conversation, context = {}) {
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
    const tools = [toolDef];

    const jp = await loadPrompt('judge');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayJud = overlays.judge?.system || overlays.judge || '';
    const baseSystem = composeSystem(jp.system, [overlayGlobal, overlayJud].filter(Boolean).join('\n\n'));
    const manifestBullet = manifestToBulletedText(manifest);
    
    // 新格式：Judge 只做工具选择（不生成参数）
    const outputFormat = `【输出格式要求】
- need_tools: 布尔值，判断是否需要调用工具
- summary: 1-2句话简要总结用户需求和关键信息
- tool_names: 字符串数组，工具名称（aiName），只允许从工具清单中选择

例如：
{
  "need_tools": true,
  "summary": "用户需要抓取网页内容并生成CSV文件",
  "tool_names": ["local__read_url_content", "local__write_to_file"]
}

重要：
1) Judge 阶段只需要选择要调用的工具，不要生成任何工具参数。
2) 工具清单已按相关性排序，前面的工具更可能是你需要的。请重点关注排在前面的工具。`;
    
    const systemContent = [
      baseSystem,
      jp.concurrency_hint || '',
      jp.manifest_intro,
      manifestBullet,
      outputFormat,
    ].filter(Boolean).join('\n');

    const conv = normalizeConversation(conversation);
    const msgs = compactMessages([
      { role: 'system', content: systemContent },
      ...conv,
      { role: 'user', content: renderTemplate(jp.user_goal, { objective }) },
    ]);

    const useOmit = Number(config?.judge?.maxTokens ?? -1) <= 0;
    const timeoutMs = Math.max(0, Number(config?.judge?.raceTimeoutMs ?? 12000));
    const models = Array.isArray(config?.judge?.models) && config.judge.models.length
      ? config.judge.models
      : [config.judge.model];

    const withTimeout = (p, ms) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('judge_timeout')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); })
       .catch((err) => { clearTimeout(t); reject(err); });
    });

    const attemptOnce = async (modelName) => {
      const res = await chatCompletion({
        messages: msgs,
        tools,
        tool_choice: { type: 'function', function: { name: 'emit_decision' } },
        omitMaxTokens: useOmit,
        max_tokens: useOmit ? undefined : Number(config.judge.maxTokens),
        temperature: Number(config.judge.temperature ?? 0.1),
        timeoutMs: getStageTimeoutMs('judge'),
        apiKey: config.judge.apiKey,
        baseURL: config.judge.baseURL,
        model: modelName,
      });
      const call = res?.choices?.[0]?.message?.tool_calls?.[0];
      let parsed;
      try {
        parsed = call?.function?.arguments ? JSON.parse(call.function.arguments) : null;
      } catch {
        parsed = null;
      }
      if (!parsed) throw new Error('judge_parse_failed');
      const need = !!parsed.need_tools;
      const summary = String(parsed.summary || '').trim();
      const toolNames = Array.isArray(parsed.tool_names) ? parsed.tool_names.filter(Boolean) : [];
      logger.info?.('Judge结果', { need, summary, toolNames: toolNames.length > 0 ? toolNames : '(无)', model: modelName, label: 'JUDGE' });
      return { need, summary, toolNames, ok: true };
    };

    // 并发尝试多个 Judge 模型：第一个成功返回的结果获胜
    if (models.length === 1) {
      try {
        const attemptPromise = attemptOnce(models[0]);
        const result = timeoutMs > 0 ? await withTimeout(attemptPromise, timeoutMs) : await attemptPromise;
        if (result && result.ok) return result;
      } catch (e) {
        logger.warn?.('Judge模型尝试失败', { label: 'JUDGE', model: models[0], error: String(e) });
      }
      return { need: false, summary: 'Judge阶段异常', toolNames: [], ok: false };
    }

    const tasks = models.map((modelName) => (async () => {
      try {
        const attemptPromise = attemptOnce(modelName);
        const result = timeoutMs > 0 ? await withTimeout(attemptPromise, timeoutMs) : await attemptPromise;
        return result;
      } catch (e) {
        logger.warn?.('Judge模型尝试失败（并发）', { label: 'JUDGE', model: modelName, error: String(e) });
        throw e;
      }
    })());

    try {
      const first = await Promise.any(tasks);
      if (first && first.ok) return first;
    } catch (e) {
      logger.error?.('Judge阶段异常：所有模型均失败', { label: 'JUDGE', error: String(e) });
    }

    return { need: false, summary: 'Judge阶段异常', toolNames: [], ok: false };
  } catch (e) {
    return { need: false, summary: 'Judge阶段异常', toolNames: [], ok: false };
  }
}
