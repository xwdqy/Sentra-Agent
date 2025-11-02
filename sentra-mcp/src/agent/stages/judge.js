/**
 * 判断阶段：判断是否需要调用工具
 */

import { config } from '../../config/index.js';
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
 * @param {Array} manifest - 已经重排序后的工具清单（按相关性排序）
 * @param {Array} conversation - 对话历史
 * @param {Object} context - 上下文信息
 * @returns {Promise<{need: boolean, reason: string, operations: string[]}>}
 */
export async function judgeToolNecessity(objective, manifest, conversation, context = {}) {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const toolDef = await loadToolDef({
      baseDir: __dirname,
      toolPath: '../tools/internal/emit_decision.tool.json',
      schemaPath: '../tools/internal/emit_decision.schema.json',
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
              operations: { type: 'array', items: { type: 'string' } }
            }, 
            required: ['need_tools'], 
            additionalProperties: true 
          } 
        } 
      },
      fallbackSchema: { 
        type: 'object', 
        properties: { 
          need_tools: { type: 'boolean' }, 
          summary: { type: 'string' },
          operations: { type: 'array', items: { type: 'string' } }
        }, 
        required: ['need_tools'], 
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
    
    // 新格式：使用结构化输出
    const outputFormat = `【输出格式要求】
- need_tools: 布尔值，判断是否需要调用工具
- summary: 1-2句话简要总结用户需求和关键信息
- operations: 字符串数组，每个元素是一个简短的操作描述（2-6个字，动词短语）

例如：
{
  "need_tools": true,
  "summary": "用户需要抓取网页内容并生成CSV文件",
  "operations": ["抓取网页", "解析表格", "生成CSV"]
}

重要：工具清单已按相关性排序，前面的工具更可能是你需要的。请重点关注排在前面的工具。`;
    
    const systemContent = [
      baseSystem,
      jp.manifest_intro,
      manifestBullet,
      outputFormat,
    ].join('\n');

    const conv = normalizeConversation(conversation);
    const msgs = compactMessages([
      { role: 'system', content: systemContent },
      ...conv,
      { role: 'user', content: renderTemplate(jp.user_goal, { objective }) },
    ]);

    const useOmit = Number(config?.judge?.maxTokens ?? -1) <= 0;
    const res = await chatCompletion({
      messages: msgs,
      tools,
      tool_choice: { type: 'function', function: { name: 'emit_decision' } },
      omitMaxTokens: useOmit,
      max_tokens: useOmit ? undefined : Number(config.judge.maxTokens),
      temperature: Number(config.judge.temperature ?? 0.1),
      apiKey: config.judge.apiKey,
      baseURL: config.judge.baseURL,
      model: config.judge.model,
    });

    const call = res?.choices?.[0]?.message?.tool_calls?.[0];
    let parsed;
    try {
      parsed = call?.function?.arguments ? JSON.parse(call.function.arguments) : { need_tools: true };
    } catch {
      parsed = { need_tools: true };
    }

    const need = !!parsed.need_tools;
    const summary = String(parsed.summary || '').trim();
    const operations = Array.isArray(parsed.operations) ? parsed.operations.filter(Boolean) : [];
    
    // 将结构化的 operations 数组转换为分号分隔的字符串（为了与后续代码兼容）
    let reason = summary;
    if (operations.length > 0) {
      const operationsStr = operations.join('; ');
      reason = summary ? `${summary}; ${operationsStr}` : operationsStr;
    }
    
    logger.info?.('Judge结果', { 
      need, 
      summary, 
      operations: operations.length,
      reason: reason.substring(0, 100),
      label: 'JUDGE' 
    });

    return { need, reason, operations };
  } catch (e) {
    return { need: true, reason: 'Judge阶段异常，默认需要工具' };
  }
}
