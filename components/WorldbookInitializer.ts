import { loadWorldbookSync } from '../utils/worldbookLoader.js';
import { buildWorldbookXml, formatWorldbookJsonAsPlainText } from '../utils/jsonToSentraXmlConverter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('WorldbookInitializer');

type WorldbookJson = Record<string, unknown>;

function normalizeWorldbookJsonForRuntime(obj: unknown): WorldbookJson | null {
  let inner = obj;
  if (inner && typeof inner === 'object') {
    const maybeObj = inner as { worldbookJson?: unknown };
    if (maybeObj.worldbookJson && typeof maybeObj.worldbookJson === 'object') {
      inner = maybeObj.worldbookJson;
    }
  }
  return inner && typeof inner === 'object' ? (inner as WorldbookJson) : null;
}

export async function initWorldbookCore() {
  let rawText = '';
  let worldbookJson: WorldbookJson | null = null;
  let worldbookXml = '';
  let worldbookPlainText = '';
  let sourcePath = '';
  let sourceFileName = '';

  try {
    const loaded = loadWorldbookSync() as {
      path?: string;
      fileName?: string;
      text?: string;
      parsedJson?: unknown;
    };
    sourcePath = loaded.path || '';
    sourceFileName = loaded.fileName || '';
    rawText = loaded.text || '';

    if (loaded.parsedJson) {
      worldbookJson = normalizeWorldbookJsonForRuntime(loaded.parsedJson);
    }

    if (worldbookJson) {
      worldbookXml = buildWorldbookXml(worldbookJson) || '';
      worldbookPlainText = formatWorldbookJsonAsPlainText(worldbookJson) || '';
    } else {
      worldbookXml = '';
      worldbookPlainText = rawText || '';
    }

    logger.info('世界书初始化完成', {
      hasJson: !!worldbookJson,
      hasXml: !!worldbookXml,
      rawLength: rawText.length,
      plainTextLength: worldbookPlainText.length
    });
  } catch (e) {
    logger.warn('世界书初始化失败，将不注入世界书', { err: String(e) });
    rawText = '';
    worldbookJson = null;
    worldbookXml = '';
    worldbookPlainText = '';
    sourcePath = '';
    sourceFileName = '';
  }

  return {
    rawText,
    json: worldbookJson,
    xml: worldbookXml,
    plainText: worldbookPlainText,
    sourcePath,
    sourceFileName
  };
}
