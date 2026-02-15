/**
 * 消息处理工具模块
 * 包含文本段落解析
 */

import { unescapeXml } from './xmlUtils.js';

//import { createLogger } from './logger.js';

//const logger = createLogger('MessageUtils');

/**
 * 将文本段落数组转换为段落对象数组
 */
export function parseTextSegments(textSegments: Array<string | null | undefined>): Array<{ text: string }> {
  //logger.debug(`文本段落数: ${textSegments.length}`);
  
  const result = textSegments
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
    .map((text, index) => {
      //logger.debug(`  段落${index + 1}: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);
      return { text: text.trim() };
    });
  
  //logger.debug(`最终段落数: ${result.length}`);
  return result;
}

/**
 * 构建单个段落的消息段
 */
type SegmentLike = { text?: string | null };
type MessagePart = { type: 'text'; data: { text: string } };

export function buildSegmentMessage(segment: SegmentLike): MessagePart[] {
  const messageParts: MessagePart[] = [];
  
  if (segment.text) {
    const cleaned = unescapeXml(String(segment.text ?? '')).trim();
    if (cleaned) {
      messageParts.push({ type: 'text', data: { text: cleaned } });
    }
  }
  
  return messageParts;
}
