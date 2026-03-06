import { loadAgentPresetSync } from '../utils/agentPresetLoader.js';
import { normalizePresetJsonForRuntime } from '../utils/presetTextToJsonConverter.js';
import { buildAgentPresetXml, formatPresetJsonAsPlainText } from '../utils/jsonToSentraXmlConverter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentPresetInitializer');

export async function initAgentPresetCore(_agent: unknown) {
  let rawText = '';
  let presetJson: Record<string, unknown> | null = null;
  let presetXml = '';
  let presetPlainText = '';
  let sourcePath = '';
  let sourceFileName = '';

  try {
    const loaded = loadAgentPresetSync();
    sourcePath = loaded.path || '';
    sourceFileName = loaded.fileName || '';
    rawText = loaded.text || '';

    // json: normalize -> xml/plainText
    if (loaded.parsedJson) {
      presetJson = normalizePresetJsonForRuntime(loaded.parsedJson, {
        rawText,
        fileName: loaded.fileName
      }) as Record<string, unknown>;
    }

    if (presetJson) {
      presetXml = buildAgentPresetXml(presetJson) || '';
      presetPlainText = formatPresetJsonAsPlainText(presetJson) || '';
    } else {
      // txt/md: direct system plain text
      presetXml = '';
      presetPlainText = rawText || '';
    }

    logger.info('agent preset initialized', {
      hasJson: !!presetJson,
      hasXml: !!presetXml,
      rawLength: rawText.length,
      plainTextLength: presetPlainText.length,
      sourceFileName
    });
  } catch (e) {
    logger.warn('agent preset init failed', { err: String(e) });
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
