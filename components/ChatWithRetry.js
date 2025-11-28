import { createLogger } from '../utils/logger.js';
import { tokenCounter } from '../src/token-counter.js';
import { repairSentraResponse } from '../utils/formatRepair.js';

const logger = createLogger('ChatWithRetry');

const MAX_RESPONSE_RETRIES = parseInt(process.env.MAX_RESPONSE_RETRIES || '2', 10);
const MAX_RESPONSE_TOKENS = parseInt(process.env.MAX_RESPONSE_TOKENS || '260', 10);
const TOKEN_COUNT_MODEL = process.env.TOKEN_COUNT_MODEL || 'gpt-4o-mini';
const ENABLE_STRICT_FORMAT_CHECK = (process.env.ENABLE_STRICT_FORMAT_CHECK || 'true') === 'true';
const ENABLE_FORMAT_REPAIR = (process.env.ENABLE_FORMAT_REPAIR || 'true') === 'true';

function validateResponseFormat(response) {
  if (!response || typeof response !== 'string') {
    return { valid: false, reason: '响应为空或非字符串' };
  }

  if (!response.includes('<sentra-response>')) {
    return { valid: false, reason: '缺少 <sentra-response> 标签' };
  }

  const forbiddenTags = [
    '<sentra-tools>',
    '<sentra-result>',
    '<sentra-result-group>',
    '<sentra-user-question>',
    '<sentra-pending-messages>',
    '<sentra-emo>',
    '<sentra-memory>'
  ];

  for (const tag of forbiddenTags) {
    if (response.includes(tag)) {
      return { valid: false, reason: `包含非法的只读标签: ${tag}` };
    }
  }

  return { valid: true };
}

function extractAndCountTokens(response) {
  const textMatches = response.match(/<text\d+>([\s\S]*?)<\/text\d+>/g) || [];
  const texts = textMatches
    .map((match) => {
      const content = match.replace(/<\/?text\d+>/g, '').trim();
      return content;
    })
    .filter(Boolean);

  const combinedText = texts.join(' ');
  const tokens = tokenCounter.countTokens(combinedText, TOKEN_COUNT_MODEL);

  return { text: combinedText, tokens };
}

function buildProtocolReminder() {
  return [
    'CRITICAL OUTPUT RULES:',
    '1) 必须使用 <sentra-response>...</sentra-response> 包裹整个回复',
    '2) 使用分段 <text1>, <text2>, <text3>, <textx>...（每段1句，语气自然）',
    '3) 严禁输出只读输入标签：<sentra-user-question>/<sentra-result>/<sentra-result-group>/<sentra-pending-messages>/<sentra-emo>',
    '4) 不要输出工具或技术术语（如 tool/success/return/data field 等）',
    '5) 文本标签内部不要做 XML 转义（直接输出原始内容）',
    '6) <resources> 可为空；若无资源，输出 <resources></resources>'
  ].join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function chatWithRetry(agent, conversations, modelOrOptions, groupId) {
  let retries = 0;
  let lastError = null;
  let lastResponse = null;
  let lastFormatReason = '';

  const options =
    typeof modelOrOptions === 'string'
      ? { model: modelOrOptions }
      : (modelOrOptions || {});

  while (retries <= MAX_RESPONSE_RETRIES) {
    try {
      const attemptIndex = retries + 1;
      logger.debug(`[${groupId}] AI请求第${attemptIndex}次尝试`);

      let convThisTry = conversations;
      if (ENABLE_STRICT_FORMAT_CHECK && lastFormatReason) {
        const allowInject =
          lastFormatReason.includes('缺少 <sentra-response> 标签') ||
          lastFormatReason.includes('包含非法的只读标签');
        if (allowInject) {
          const reminder = buildProtocolReminder();
          convThisTry = Array.isArray(conversations)
            ? [...conversations, { role: 'system', content: reminder }]
            : conversations;
          logger.info(`[${groupId}] 协议复述注入: ${lastFormatReason}`);
        }
      }

      let response = await agent.chat(convThisTry, options);
      lastResponse = response;

      if (ENABLE_STRICT_FORMAT_CHECK) {
        const formatCheck = validateResponseFormat(response);
        if (!formatCheck.valid) {
          lastFormatReason = formatCheck.reason || '';
          logger.warn(`[${groupId}] 格式验证失败: ${formatCheck.reason}`);

          if (retries < MAX_RESPONSE_RETRIES) {
            retries++;
            logger.debug(`[${groupId}] 格式验证失败，直接重试（第${retries + 1}次）...`);
            await sleep(1000);
            continue;
          }

          if (ENABLE_FORMAT_REPAIR && typeof response === 'string' && response.trim()) {
            try {
              const repaired = await repairSentraResponse(response, {
                agent,
                model: process.env.REPAIR_AI_MODEL
              });
              const repairedCheck = validateResponseFormat(repaired);
              if (repairedCheck.valid) {
                logger.success(`[${groupId}] 格式已自动修复`);
                return { response: repaired, retries, success: true };
              }
            } catch (e) {
              logger.warn(`[${groupId}] 格式修复失败: ${e.message}`);
            }
          }

          logger.error(`[${groupId}] 格式验证失败-最终: 已达最大重试次数`);
          return { response: null, retries, success: false, reason: formatCheck.reason };
        }
      }

      const { text, tokens } = extractAndCountTokens(response);
      logger.debug(`[${groupId}] Token统计: ${tokens} tokens, 文本长度: ${text.length}`);

      if (tokens > MAX_RESPONSE_TOKENS) {
        logger.warn(`[${groupId}] Token超限: ${tokens} > ${MAX_RESPONSE_TOKENS}`);
        if (retries < MAX_RESPONSE_RETRIES) {
          retries++;
          logger.debug(`[${groupId}] Token超限，直接重试（第${retries + 1}次）...`);
          await sleep(500);
          continue;
        }
        logger.error(`[${groupId}] Token超限-最终: 已达最大重试次数`);
        return {
          response: null,
          retries,
          success: false,
          reason: `Token超限: ${tokens}>${MAX_RESPONSE_TOKENS}`
        };
      }

      logger.success(`[${groupId}] AI响应成功 (${tokens}/${MAX_RESPONSE_TOKENS} tokens)`);
      return { response, retries, success: true };
    } catch (error) {
      logger.error(`[${groupId}] AI请求失败 - 第${retries + 1}次尝试`, error);
      lastError = error;
      lastFormatReason = '';
      if (retries < MAX_RESPONSE_RETRIES) {
        retries++;
        logger.warn(`[${groupId}] 网络错误，1秒后第${retries + 1}次重试...`);
        await sleep(1000);
        continue;
      }
      logger.error(`[${groupId}] AI请求失败 - 已达最大重试次数${MAX_RESPONSE_RETRIES}次`);
      return { response: null, retries, success: false, reason: lastError?.message };
    }
  }

  return {
    response: null,
    retries,
    success: false,
    reason: lastError?.message || '未知错误'
  };
}
