import { loadAgentPresetSync } from '../utils/agentPresetLoader.js';
import { normalizePresetJsonForRuntime } from '../utils/presetTextToJsonConverter.js';
import { buildAgentPresetXml, formatPresetJsonAsPlainText } from '../utils/jsonToSentraXmlConverter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentPresetInitializer');

/**
 * 初始化 Agent 预设，并返回统一的快照结构，便于在 Main.js 或其它入口复用。
 *
 * - 优先使用 JSON 形式的预设（例如 .json 文件或文本以 { / [ 开头且可被 JSON.parse）。
 * - 如果是 .txt/.md 等纯文本，则调用 convertPresetTextToJson 通过轻量模型转换为 JSON。
 * - 始终补齐 meta/parameters/rules 等字段，返回标准化后的 JSON。
 * - 同时派生 XML 与纯文本视图，供下游 MCP / Prompt 组合使用。
 */
export async function initAgentPresetCore(agent) {
  let rawText = '';
  let presetJson = null;
  let presetXml = '';
  let presetPlainText = '';
  let sourcePath = '';
  let sourceFileName = '';

  try {
    const loaded = loadAgentPresetSync();
    sourcePath = loaded.path || '';
    sourceFileName = loaded.fileName || '';
    rawText = loaded.text || '';

    if (loaded.parsedJson) {
      presetJson = normalizePresetJsonForRuntime(loaded.parsedJson, {
        rawText,
        fileName: loaded.fileName
      });
    }

    if (presetJson) {
      presetXml = buildAgentPresetXml(presetJson) || '';
      presetPlainText = formatPresetJsonAsPlainText(presetJson) || '';
    } else {
      presetXml = '';
      presetPlainText = rawText || '';
    }

    logger.info('Agent 预设初始化完成', {
      hasJson: !!presetJson,
      hasXml: !!presetXml,
      rawLength: rawText.length,
      plainTextLength: presetPlainText.length
    });
  } catch (e) {
    logger.warn('Agent 预设初始化失败，将不使用结构化人设', { err: String(e) });
    rawText = '';
    presetJson = null;
    presetXml = '';
    presetPlainText = '';
    sourcePath = '';
    sourceFileName = '';
  }

  return {
    rawText,
    json: presetJson,
    xml: presetXml,
    plainText: presetPlainText,
    sourcePath,
    sourceFileName
  };
}
