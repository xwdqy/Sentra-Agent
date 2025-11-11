/**
 * 回复干预判断模块
 * 使用轻量级模型进行二次判断，决定是否真的需要回复
 */

import { createLogger } from './logger.js';
import { extractXMLTag } from './xmlUtils.js';

const logger = createLogger('ReplyIntervention');

// 移除 tools 定义，统一使用 XML 解析

/**
 * 构建干预判断的提示词（标准 Sentra XML 协议格式）
 */
function buildInterventionPrompt(msg, probability, threshold, state) {
  const isGroup = msg.type === 'group';
  const chatType = isGroup ? 'group' : 'private';
  const pace = state.avgMessageInterval > 0 ? `${state.avgMessageInterval.toFixed(0)}s` : 'unknown';
  
  // 截断过长的文本（最多保留 200 字符）
  const maxTextLength = 200;
  let messageText = msg.text || '(empty)';
  if (messageText.length > maxTextLength) {
    messageText = messageText.substring(0, maxTextLength) + '...';
  }
  
  return `# Reply Decision Validator

You are a secondary validator for reply decisions. The base probability check has passed (${(probability * 100).toFixed(0)}% >= ${(threshold * 100).toFixed(0)}%), but you need to verify if a reply is **truly necessary** to avoid unnecessary responses.

## Input Context

**Chat Type**: ${chatType}
**Message Count**: ${state.messageCount} messages (ignored ${state.consecutiveIgnored} times)
**Pace**: Average interval ${pace}
**Base Probability**: ${(probability * 100).toFixed(0)}%

**Current Message**:
\`\`\`
${messageText}${msg.image ? '\n[Contains Image]' : ''}${msg.file ? '\n[Contains File]' : ''}
\`\`\`

## Decision Criteria

**SHOULD Reply (need=true)**:
- Explicit help requests or questions
- Tasks with clear intent
- Valuable topic discussions
- Content requiring acknowledgment or feedback

**SHOULD NOT Reply (need=false)**:
- Meaningless chitchat or spam
- Simple emojis or filler words
- Repetitive messages or flooding
- Rapid-fire messages in fast-paced conversations (<20s interval)
- Recent replies with no new topics (avoid over-engagement)

## Output Format (CRITICAL)

**MUST use Sentra XML Protocol format**:

\`\`\`xml
<sentra-decision>
  <need>true</need>
  <reason>用户询问具体问题</reason>
  <confidence>0.85</confidence>
</sentra-decision>
\`\`\`

**Field Requirements**:
- \`<need>\`: Boolean (true/false), primary decision
- \`<reason>\`: String (max 20 characters), concise explanation in Chinese
- \`<confidence>\`: Float (0.0-1.0), your confidence level

**DO NOT**:
- Include explanations outside the XML block
- Use markdown formatting inside XML tags
- Omit any required fields`;
}

/**
 * 解析 Sentra XML 格式的决策结果
 * 使用 xmlUtils 的 extractXMLTag 进行更可靠的解析
 */
function parseDecisionXML(xmlText) {
  // 1. 先提取整个 <sentra-decision> 块
  const decisionBlock = extractXMLTag(xmlText, 'sentra-decision');
  if (!decisionBlock) {
    logger.debug('未找到 <sentra-decision> 标签');
    return null;
  }
  
  // 2. 从决策块中提取各字段
  const needStr = extractXMLTag(decisionBlock, 'need');
  const reason = extractXMLTag(decisionBlock, 'reason');
  const confidenceStr = extractXMLTag(decisionBlock, 'confidence');
  
  // 3. 验证必填字段
  if (!needStr || !reason || !confidenceStr) {
    logger.debug(`决策字段不完整: need=${needStr}, reason=${reason}, confidence=${confidenceStr}`);
    return null;
  }
  
  // 4. 解析和验证值
  const need = needStr.toLowerCase() === 'true';
  const confidence = parseFloat(confidenceStr);
  
  if (isNaN(confidence) || confidence < 0 || confidence > 1) {
    logger.debug(`置信度无效: ${confidenceStr}`);
    return null;
  }
  
  return {
    need,
    reason: reason.trim(),
    confidence
  };
}

/**
 * 执行干预判断
 * @param {Object} agent - Agent 实例
 * @param {Object} msg - 消息对象
 * @param {number} probability - 基础概率
 * @param {number} threshold - 阈值
 * @param {Object} state - 会话状态
 * @returns {Promise<{need: boolean, reason: string, confidence: number}>}
 */
export async function executeIntervention(agent, msg, probability, threshold, state) {
  const model = process.env.REPLY_INTERVENTION_MODEL;
  const timeout = parseInt(process.env.REPLY_INTERVENTION_TIMEOUT || '2000');
  const onlyNearThreshold = process.env.REPLY_INTERVENTION_ONLY_NEAR_THRESHOLD === 'true';
  
  if (!model) {
    logger.warn('未配置 REPLY_INTERVENTION_MODEL，跳过干预判断');
    return { need: true, reason: '未配置干预模型', confidence: 0.5 };
  }
  
  // 仅在临界区间触发（可选优化）
  if (onlyNearThreshold) {
    const distance = Math.abs(probability - threshold);
    if (distance > 0.15) {
      logger.debug(`概率距离阈值${(distance * 100).toFixed(1)}% > 15%，跳过干预判断`);
      return { need: true, reason: '概率差距较大，跳过干预', confidence: 1.0 };
    }
  }
  
  try {
    logger.debug(`启动干预判断: model=${model}, prob=${(probability * 100).toFixed(1)}%, threshold=${(threshold * 100).toFixed(1)}%`);
    
    const systemPrompt = buildInterventionPrompt(msg, probability, threshold, state);
    const userPrompt = `请判断是否需要回复这条消息：\n\n${msg.text || '(无文本内容)'}`;
    
    // 使用 tools + tool_choice 强制函数调用
    const startTime = Date.now();
    const response = await Promise.race([
      agent.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        {
          model: model,
          temperature: 0.3,
          max_tokens: 300
        }
      ),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), timeout)
      )
    ]);
    
    const elapsed = Date.now() - startTime;
    
    // 统一使用 XML 解析
    const responseText = response.content || (typeof response === 'string' ? response : '');
    
    if (!responseText) {
      logger.warn('干预判断返回内容为空，回退到原判断');
      return { need: true, reason: '返回为空', confidence: 0.5 };
    }
    
    try {
      const xmlResult = parseDecisionXML(responseText);
      if (xmlResult) {
        logger.info(`干预判断完成(${elapsed}ms): need=${xmlResult.need}, reason="${xmlResult.reason}", confidence=${xmlResult.confidence}`);
        return xmlResult;
      }
    } catch (xmlError) {
      logger.warn('XML 解析失败', xmlError);
    }
    
    // 回退：返回默认值（倾向于回复）
    logger.warn('干预判断未返回有效结果，回退到原判断');
    return { need: true, reason: '解析失败，回退', confidence: 0.5 };
    
  } catch (error) {
    if (error.message === 'Timeout') {
      logger.warn(`干预判断超时(${timeout}ms)，回退到原判断`);
    } else {
      logger.error(`干预判断失败: ${error.message}`);
    }
    return { need: true, reason: '干预失败，回退', confidence: 0.5 };
  }
}

/**
 * 检查是否应该启用干预判断
 */
export function shouldEnableIntervention() {
  const enabled = process.env.ENABLE_REPLY_INTERVENTION === 'true';
  const hasModel = !!process.env.REPLY_INTERVENTION_MODEL;
  
  if (enabled && !hasModel) {
    logger.warn('ENABLE_REPLY_INTERVENTION=true 但未配置 REPLY_INTERVENTION_MODEL');
    return false;
  }
  
  return enabled;
}

/**
 * 获取干预配置
 */
export function getInterventionConfig() {
  return {
    enabled: shouldEnableIntervention(),
    model: process.env.REPLY_INTERVENTION_MODEL || 'gpt-4o-mini',
    timeout: parseInt(process.env.REPLY_INTERVENTION_TIMEOUT || '2000'),
    onlyNearThreshold: process.env.REPLY_INTERVENTION_ONLY_NEAR_THRESHOLD === 'true',
    desireReduction: parseFloat(process.env.REPLY_INTERVENTION_DESIRE_REDUCTION || '0.10')
  };
}
