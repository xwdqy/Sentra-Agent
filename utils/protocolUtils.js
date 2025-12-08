/**
 * Sentra协议处理模块
 * 包含<sentra-result>、<sentra-user-question>、<sentra-response>的构建和解析
 */

import { z } from 'zod';
import { jsonToXMLLines, extractXMLTag, extractAllXMLTags, extractFilesFromContent, valueToXMLString, USER_QUESTION_FILTER_KEYS, extractFullXMLTag, extractAllFullXMLTags } from './xmlUtils.js';
import { createLogger } from './logger.js';

const logger = createLogger('ProtocolUtils');

// 内部：将 JS 值渲染为参数 <parameter> 的文本
function paramValueToText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // 对象/数组：用 JSON 字符串表达
  try { return JSON.stringify(v); } catch { return String(v); }
}

// 内部：将 args 对象渲染为 XML 子元素（用于 <args> 或 <sentra-tools><parameter>）
function argsObjectToParamEntries(args = {}) {
  const out = [];
  try {
    for (const [k, v] of Object.entries(args || {})) {
      out.push({ name: k, value: paramValueToText(v) });
    }
  } catch {}
  return out;
}

/**
 * 反转义 HTML 实体（处理模型可能输出的转义字符）
 * @param {string} text - 可能包含 HTML 实体的文本
 * @returns {string} 反转义后的文本
 */
function unescapeHTML(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Zod schema for resource validation
const ResourceSchema = z.object({
  type: z.enum(['image', 'video', 'audio', 'file', 'link']),
  source: z.string(),
  caption: z.string().optional()
});

const SentraResponseSchema = z.object({
  textSegments: z.array(z.string()),
  resources: z.array(ResourceSchema).optional().default([]),
  replyMode: z.enum(['none', 'first', 'always']).optional().default('none'),
  mentions: z.array(z.union([z.string(), z.number()])).optional().default([])
});

/**
 * 构建 Sentra XML 块：
 * - tool_result -> <sentra-result>
 * - tool_result_group -> <sentra-result-group> 包含多个 <sentra-result>
 */
export function buildSentraResultBlock(ev) {
  try {
    const type = ev?.type;
    if (type === 'tool_result') {
      return buildSingleResultXML(ev);
    }
    if (type === 'tool_result_group' && Array.isArray(ev?.events)) {
      const gid = ev.groupId != null ? String(ev.groupId) : '';
      const gsize = Number(ev.groupSize || ev.events.length);
      const order = Array.isArray(ev.orderIndices) ? ev.orderIndices.join(',') : '';
      const lines = [
        `<sentra-result-group group_id="${gid}" group_size="${gsize}" order="${order}">`
      ];
      for (const item of ev.events) {
        const xml = buildSingleResultXML(item);
        const indented = xml.split('\n').map(l => `  ${l}`).join('\n');
        lines.push(indented);
      }
      // 附带一次性提取到的文件资源（可选）
      const collected = [];
      ev.events.forEach((item, idx) => {
        if (!item || !item.result) return;
        const root = item.result && (item.result.data !== undefined ? item.result.data : item.result);
        if (!root || typeof root !== 'object') return;
        const fromResult = extractFilesFromContent(root, ['events', idx, 'result']);
        collected.push(...fromResult);
      });

      // 去重：按 path 聚合，避免同一文件被多次包含
      const seenPaths = new Set();
      const files = [];
      for (const f of collected) {
        const p = (f && typeof f.path === 'string') ? f.path.trim() : '';
        if (!p || seenPaths.has(p)) continue;
        seenPaths.add(p);
        files.push(f);
      }

      if (files.length > 0) {
        lines.push('  <extracted_files>');
        for (const f of files) {
          lines.push('    <file>');
          lines.push(`      <key>${f.key}</key>`);
          lines.push(`      <path>${valueToXMLString(f.path, 0)}</path>`);
          lines.push('    </file>');
        }
        lines.push('  </extracted_files>');
      }
      lines.push('</sentra-result-group>');
      return lines.join('\n');
    }
    return '';
  } catch (e) {
    // 发生异常时返回 JSON 包裹，避免终止主流程
    try { return `<sentra-result>${valueToXMLString(JSON.stringify(ev), 0)}</sentra-result>`; } catch { return '<sentra-result></sentra-result>'; }
  }
}

// 内部：构建单个 <sentra-result>（统一字段）
function buildSingleResultXML(ev) {
  const aiName = ev?.aiName || '';
  const step = Number(ev?.plannedStepIndex ?? ev?.stepIndex ?? 0);
  const reason = Array.isArray(ev?.reason) ? ev.reason.join('; ') : (ev?.reason || '');
  const success = ev?.result?.success !== false;
  const code = ev?.result?.code || '';
  const provider = ev?.result?.provider || ev?.toolMeta?.provider || '';
  const args = ev?.args || {};
  const data = (ev?.result && (ev.result.data !== undefined ? ev.result.data : ev.result)) || null;

  const lines = [`<sentra-result step="${step}" tool="${aiName}" success="${success}">`];
  if (reason) lines.push(`  <reason>${valueToXMLString(reason, 0)}</reason>`);
  // 同时输出 <aiName> 以便旧解析器兼容
  lines.push(`  <aiName>${valueToXMLString(aiName, 0)}</aiName>`);
  // args：同时提供结构化与 JSON 两种表示
  try {
    lines.push('  <args>');
    lines.push(...jsonToXMLLines(args, 2, 0, 6));
    lines.push('  </args>');
  } catch {}
  try {
    const jsonText = JSON.stringify(args || {});
    lines.push(`  <arguments>${valueToXMLString(jsonText, 0)}</arguments>`);
  } catch {}
  // result：拆为 success/code/data/provider
  lines.push('  <result>');
  lines.push(`    <success>${success}</success>`);
  if (code) lines.push(`    <code>${valueToXMLString(code, 0)}</code>`);
  if (provider) lines.push(`    <provider>${valueToXMLString(provider, 0)}</provider>`);
  try {
    lines.push('    <data>');
    lines.push(...jsonToXMLLines(data, 3, 0, 6));
    lines.push('    </data>');
  } catch {
    try { lines.push(`    <data>${valueToXMLString(JSON.stringify(data), 0)}</data>`); } catch {}
  }
  lines.push('  </result>');

  // 附带便于调试的元信息（可选）
  if (Array.isArray(ev?.dependsOn) || Array.isArray(ev?.dependedBy)) {
    lines.push('  <dependencies>');
    if (Array.isArray(ev.dependsOn)) lines.push(`    <depends_on>${ev.dependsOn.join(',')}</depends_on>`);
    if (Array.isArray(ev.dependedBy)) lines.push(`    <depended_by>${ev.dependedBy.join(',')}</depended_by>`);
    if (ev.dependsNote) lines.push(`    <note>${valueToXMLString(ev.dependsNote, 0)}</note>`);
    lines.push('  </dependencies>');
  }

  // 附带文件路径（可选）
  const fileRoot = ev?.result && (ev.result.data !== undefined ? ev.result.data : ev.result);
  const files = fileRoot ? extractFilesFromContent(fileRoot) : [];
  lines.push('  <extracted_files>');
  if (files.length > 0) {
    for (const f of files) {
      lines.push('    <file>');
      lines.push(`      <key>${f.key}</key>`);
      lines.push(`      <path>${valueToXMLString(f.path, 0)}</path>`);
      lines.push('    </file>');
    }
  } else {
    lines.push('    <no_resource>true</no_resource>');
  }
  lines.push('  </extracted_files>');

  lines.push('</sentra-result>');
  return lines.join('\n');
}

/**
 * 构建<sentra-user-question>块（用户提问）
 * 自动过滤segments、images、videos、files、records等冗余字段
 */
export function buildSentraUserQuestionBlock(msg) {
  const xmlLines = ['<sentra-user-question>'];

  const isMerged = !!msg?._merged && Array.isArray(msg?._mergedUsers) && msg._mergedUsers.length > 1 && msg?.type === 'group';

  if (isMerged) {
    const mergedUsers = msg._mergedUsers;
    const mergedLines = [];
    mergedUsers.forEach((u, idx) => {
      if (!u) return;
      const name = (u.sender_name || u.nickname || `User${idx + 1}`).trim();
      const baseText =
        (typeof u.text === 'string' && u.text.trim()) ||
        (u.raw && ((u.raw.summary && String(u.raw.summary).trim()) || (u.raw.text && String(u.raw.text).trim()))) ||
        '';
      if (!baseText) return;
      mergedLines.push(name ? `${name}: ${baseText}` : baseText);
    });

    const mergedText = mergedLines.join('\n\n');

    xmlLines.push('  <mode>group_multi_user_merge</mode>');
    if (msg.group_id != null) {
      xmlLines.push(`  <group_id>${valueToXMLString(String(msg.group_id), 0)}</group_id>`);
    }
    if (msg._mergedPrimarySenderId != null) {
      xmlLines.push(
        `  <primary_sender_id>${valueToXMLString(String(msg._mergedPrimarySenderId), 0)}</primary_sender_id>`
      );
    }
    if (typeof msg.sender_name === 'string' && msg.sender_name.trim()) {
      xmlLines.push(`  <primary_sender_name>${valueToXMLString(msg.sender_name, 0)}</primary_sender_name>`);
    }
    xmlLines.push(`  <user_count>${mergedUsers.length}</user_count>`);
    if (mergedText) {
      xmlLines.push(`  <text>${valueToXMLString(mergedText, 0)}</text>`);
    }

    xmlLines.push('  <multi_user merge="true">');
    mergedUsers.forEach((u, idx) => {
      if (!u) return;
      const uid = u.sender_id != null ? String(u.sender_id) : '';
      const uname = u.sender_name || '';
      const mid = u.message_id != null ? String(u.message_id) : '';
      const text =
        (typeof u.text === 'string' && u.text.trim()) ||
        (u.raw && ((u.raw.summary && String(u.raw.summary).trim()) || (u.raw.text && String(u.raw.text).trim()))) ||
        '';
      const time = u.time_str || (u.raw && u.raw.time_str) || '';

      xmlLines.push(`    <user index="${idx + 1}">`);
      if (uid) xmlLines.push(`      <user_id>${valueToXMLString(uid, 0)}</user_id>`);
      if (uname) xmlLines.push(`      <nickname>${valueToXMLString(uname, 0)}</nickname>`);
      if (mid) xmlLines.push(`      <message_id>${valueToXMLString(mid, 0)}</message_id>`);
      if (text) xmlLines.push(`      <text>${valueToXMLString(text, 0)}</text>`);
      if (time) xmlLines.push(`      <time>${valueToXMLString(time, 0)}</time>`);
      xmlLines.push('    </user>');
    });
    xmlLines.push('  </multi_user>');
  }

  // 递归遍历msg对象，过滤指定的键
  xmlLines.push(...jsonToXMLLines(msg, 1, 0, 6, USER_QUESTION_FILTER_KEYS));

  xmlLines.push('</sentra-user-question>');
  return xmlLines.join('\n');
}

/**
 * 解析<sentra-response>协议
 */
export function parseSentraResponse(response) {
  const hasSentraTag = typeof response === 'string' && response.includes('<sentra-response>');
  const responseContent = extractXMLTag(response, 'sentra-response');
  if (!responseContent) {
    if (hasSentraTag) {
      // 存在 <sentra-response> 标签但内容为空：视为“本轮选择保持沉默”，由上层跳过发送
      logger.warn('检测到空的 <sentra-response> 块，将跳过发送');
      return { textSegments: [], resources: [], replyMode: 'none', mentions: [], shouldSkip: true };
    }

    logger.warn('未找到 <sentra-response> 块，返回原文');
    return { textSegments: [response], resources: [] };
  }
  
  // 提取所有 <text1>, <text2>, <text3> ... 标签
  const textSegments = [];
  let index = 1;
  while (true) {
    const textTag = `text${index}`;
    const textContent = extractXMLTag(responseContent, textTag);
    if (!textContent) break;
    
    // 反转义 HTML 实体（处理模型可能输出的转义字符）
    const unescapedText = unescapeHTML(textContent.trim());
    textSegments.push(unescapedText);
    //logger.debug(`提取 <${textTag}>: ${unescapedText.slice(0, 80)}`);
    index++;
  }
  
  // 如果没有文本，直接跳过（保持空数组）
  if (textSegments.length === 0) {
    logger.warn('未找到任何文本段落，保持空数组');
  }
  
  logger.debug(`共提取 ${textSegments.length} 个文本段落`);
  
  // 提取 <resources> 块
  const resourcesBlock = extractXMLTag(responseContent, 'resources');
  let resources = [];
  
  if (resourcesBlock && resourcesBlock.trim()) {
    const resourceTags = extractAllXMLTags(resourcesBlock, 'resource');
    logger.debug(`找到 ${resourceTags.length} 个 <resource> 标签`);
    
    resources = resourceTags
      .map((resourceXML, idx) => {
        try {
          const type = extractXMLTag(resourceXML, 'type');
          const source = extractXMLTag(resourceXML, 'source');
          const caption = extractXMLTag(resourceXML, 'caption');
          
          if (!type || !source) {
            logger.warn(`resource[${idx}] 缺少必需字段`);
            return null;
          }
          
          const resource = { type, source };
          if (caption) resource.caption = caption;
          
          return ResourceSchema.parse(resource);
        } catch (e) {
          logger.warn(`resource[${idx}] 解析或验证失败: ${e.message}`);
          return null;
        }
      })
      .filter(Boolean);
    
    logger.success(`成功解析并验证 ${resources.length} 个 resources`);
  } else {
    logger.debug('无 <resources> 块或为空');
  }
  
  // 提取 <send> 指令（回复/艾特控制）
  const sendBlock = extractXMLTag(responseContent, 'send');
  let replyMode = 'none';
  let mentions = [];
  try {
    if (sendBlock && sendBlock.trim()) {
      const rm = (extractXMLTag(sendBlock, 'reply_mode') || '').trim().toLowerCase();
      if (rm === 'first' || rm === 'always') replyMode = rm; // 默认为 none
      const mentionsBlock = extractXMLTag(sendBlock, 'mentions');
      if (mentionsBlock) {
        const ids = extractAllXMLTags(mentionsBlock, 'id') || [];
        mentions = ids.map(v => (v || '').trim()).filter(Boolean);
      }
    }
  } catch (e) {
    logger.warn(`<send> 解析失败: ${e.message}`);
  }
  
  // 提取 <emoji> 标签（可选，最多一个）
  const emojiBlock = extractXMLTag(responseContent, 'emoji');
  let emoji = null;
  
  if (emojiBlock && emojiBlock.trim()) {
    try {
      const source = extractXMLTag(emojiBlock, 'source');
      const caption = extractXMLTag(emojiBlock, 'caption');
      
      if (source) {
        emoji = { source };
        if (caption) emoji.caption = caption;
        logger.debug(`找到 <emoji> 标签: ${source.slice(0, 60)}`);
      } else {
        logger.warn('<emoji> 标签缺少 <source> 字段');
      }
    } catch (e) {
      logger.warn(`<emoji> 解析失败: ${e.message}`);
    }
  }
  
  // 最终验证整体结构
  try {
    const validated = SentraResponseSchema.parse({ textSegments, resources, replyMode, mentions });
    //logger.success('协议验证通过');
    //logger.debug(`textSegments: ${validated.textSegments.length} 段`);
    //logger.debug(`resources: ${validated.resources.length} 个`);
    if (emoji) {
      //logger.debug(`emoji: ${emoji.source}`);
      validated.emoji = emoji;  // 添加 emoji 到返回结果
    }

    // 如果既没有文本也没有资源，则标记为 shouldSkip，供上层逻辑跳过发送
    if ((!validated.textSegments || validated.textSegments.length === 0) &&
        (!validated.resources || validated.resources.length === 0)) {
      validated.shouldSkip = true;
    }

    return validated;
  } catch (e) {
    logger.error('协议验证失败', e.errors);
    const hasTag = typeof response === 'string' && response.includes('<sentra-response>');
    let fallback;

    if (textSegments.length === 0 && hasTag) {
      // 已经有 sentra-response 标签，但解析/验证失败且没有任何有效文本：视为“本轮保持沉默”
      logger.warn('协议验证失败且 <sentra-response> 中没有有效内容，将跳过发送');
      fallback = { textSegments: [], resources: [], replyMode, mentions, shouldSkip: true };
    } else {
      // 旧行为回退：无 sentra-response 或仍有可用文本时，回退到原文
      fallback = {
        textSegments: textSegments.length > 0 ? textSegments : [response],
        resources: [],
        replyMode,
        mentions
      };
    }

    if (emoji) fallback.emoji = emoji;  // 即使验证失败也保留 emoji
    return fallback;
  }
}

/**
 * 转换历史对话为 MCP FC 协议格式
 * 从 user 消息中提取 <sentra-result>，转换为对应的 <sentra-tools> assistant 消息
 * 
 * @param {Array} historyConversations - 原始历史对话数组 [{ role, content }]
 * @returns {Array} 转换后的对话数组（不包含 system）
 */
export function convertHistoryToMCPFormat(historyConversations) {
  const mcpConversation = [];
  let convertedCount = 0;
  let skippedCount = 0;
  
  for (const msg of historyConversations) {
    if (msg.role === 'system') {
      // MCP 有自己的 system prompt，跳过
      skippedCount++;
      continue;
    }
    
    if (msg.role === 'user') {
      // 优先检查是否包含 <sentra-result-group>
      const groupBlocks = extractAllXMLTags(msg.content, 'sentra-result-group') || [];
      const singleResultContent = extractXMLTag(msg.content, 'sentra-result');
      if ((groupBlocks.length > 0) || singleResultContent) {
        // 提取待回复上下文和用户问题
        const pendingMessages = extractXMLTag(msg.content, 'sentra-pending-messages');
        const userQuestion = extractXMLTag(msg.content, 'sentra-user-question');
        
        if (userQuestion) {
          // 构建完整的 user 消息：pending-messages (如果有) + user-question
          let userContent = '';
          
          if (pendingMessages) {
            // 有对话上下文，放在前面
            userContent += `<sentra-pending-messages>\n${pendingMessages}\n</sentra-pending-messages>\n\n`;
          }
          
          userContent += `<sentra-user-question>\n${userQuestion}\n</sentra-user-question>`;
          
          mcpConversation.push({
            role: 'user',
            content: userContent
          });
        }
        
        // 将历史中的结果转换为 MCP 工具调用 + 结果块：
        // - 若存在 group：仅遍历组内 <sentra-result> 以生成 <invoke>，并保留完整的 <sentra-result-group> 作为结果块
        // - 否则：处理所有单个 <sentra-result>，并保留其完整块
        const invocations = [];
        const seen = new Set();
        let resultBlocksFull = [];
        if (groupBlocks.length > 0) {
          // 完整组块（保留属性和外层标签）
          const groupFullBlocks = extractAllFullXMLTags(msg.content, 'sentra-result-group') || [];
          resultBlocksFull = groupFullBlocks;
          for (const gb of groupBlocks) {
            const items = extractAllXMLTags(gb, 'sentra-result') || [];
            for (const it of items) {
              const aiName = extractXMLTag(it, 'aiName');
              let argsJSONText = extractXMLTag(it, 'arguments');
              let argsContent = argsJSONText || extractXMLTag(it, 'args');
              if (aiName && argsContent != null) {
                const key = `${aiName}|${String(argsJSONText || argsContent).trim()}`;
                if (seen.has(key)) continue; // 去重
                seen.add(key);
                invocations.push({ aiName, argsContent });
                logger.debug(`转换工具调用: ${aiName}`);
              }
            }
          }
        } else if (singleResultContent) {
          // 完整的单结果块（可能存在多个）
          const singlesFull = extractAllFullXMLTags(msg.content, 'sentra-result') || [];
          resultBlocksFull = singlesFull;
          const singlesContents = extractAllXMLTags(msg.content, 'sentra-result') || [];
          for (const it of singlesContents) {
            const aiName = extractXMLTag(it, 'aiName');
            let argsJSONText = extractXMLTag(it, 'arguments');
            let argsContent = argsJSONText || extractXMLTag(it, 'args');
            if (aiName && argsContent != null) {
              const key = `${aiName}|${String(argsJSONText || argsContent).trim()}`;
              if (!seen.has(key)) {
                seen.add(key);
                invocations.push({ aiName, argsContent });
                logger.debug(`转换工具调用: ${aiName}`);
              }
            }
          }
        }

        // 组合单条 assistant 内容：<sentra-tools>（如有） + 结果完整块（如有）
        let combined = '';
        if (invocations.length > 0) {
          const toolsXML = buildSentraToolsBatch(invocations);
          combined = toolsXML;
          convertedCount += invocations.length;
        }
        if (resultBlocksFull.length > 0) {
          const resultsXML = resultBlocksFull.join('\n\n');
          combined = combined ? `${combined}\n\n${resultsXML}` : resultsXML;
        }
        if (combined) {
          mcpConversation.push({ role: 'assistant', content: combined });
        }
      } else {
        // 没有 <sentra-result>：仍需生成一条 assistant，明确“未调用工具”的判定，便于AI判断
        mcpConversation.push(msg);

        // 从 <sentra-user-question> 提取 summary/text 作为原因
        const uq = extractXMLTag(msg.content, 'sentra-user-question') || '';
        let reasonText = extractXMLTag(uq, 'summary') || extractXMLTag(uq, 'text') || '';
        reasonText = (reasonText || '').trim();
        if (!reasonText) reasonText = 'No tool required for this message.';

        // 构建占位 tools：name="none"，标记 no_tool=true 与原因
        const toolsXML = [
          '<sentra-tools>',
          '  <invoke name="none">',
          '    <parameter name="no_tool">true</parameter>',
          `    <parameter name="reason">${valueToXMLString(reasonText, 0)}</parameter>`,
          '  </invoke>',
          '</sentra-tools>'
        ].join('\n');

        // 构建占位 result：tool="none"，code=NO_TOOL，data含原因
        const ev = {
          type: 'tool_result',
          aiName: 'none',
          plannedStepIndex: 0,
          reason: reasonText,
          result: {
            success: true,
            code: 'NO_TOOL',
            provider: 'system',
            data: { no_tool: true, reason: reasonText }
          }
        };
        const resultXML = buildSentraResultBlock(ev);

        const combined = `${toolsXML}\n\n${resultXML}`;
        mcpConversation.push({ role: 'assistant', content: combined });
      }
    }
    
    if (msg.role === 'assistant') {
      // 跳过旧格式响应与已存在的工具调用，避免重复
      const hasResponse = typeof msg.content === 'string' && msg.content.includes('<sentra-response>');
      const hasTools = typeof msg.content === 'string' && msg.content.includes('<sentra-tools>');
      if (hasResponse || hasTools) {
        skippedCount++;
        continue;
      }
      // 纯文本或其他说明类 assistant 内容，保留
      mcpConversation.push(msg);
    }
  }
  
  logger.debug(`MCP格式转换: ${historyConversations.length}条 → ${mcpConversation.length}条 (转换${convertedCount}个工具, 跳过${skippedCount}条)`);
  return mcpConversation;
}

/**
 * 从 <args> 内容构建 <sentra-tools> 块（MCP FC 标准格式）
 * 
 * @param {string} aiName - 工具名称
 * @param {string} argsContent - <args> 标签内的内容
 * @returns {string} <sentra-tools> XML 字符串
 */
function buildSentraToolsFromArgs(aiName, argsContent) {
  const xmlLines = ['<sentra-tools>'];
  xmlLines.push(`  <invoke name="${aiName}">`);

  // 优先尝试解析为 JSON（来自 <arguments> 或 <args> 中的 JSON）
  let parsed = null;
  try {
    const trimmed = String(argsContent || '').trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      parsed = JSON.parse(trimmed);
    }
  } catch {}

  if (parsed && typeof parsed === 'object') {
    const entries = argsObjectToParamEntries(parsed);
    for (const p of entries) {
      xmlLines.push(`    <parameter name="${p.name}">${valueToXMLString(p.value, 0)}</parameter>`);
    }
  } else {
    // 回退：从简单 XML 解析 <key>value</key> 对
    try {
      const re = /<([a-zA-Z0-9_\-]+)>([^<]*)<\/\1>/g;
      const matches = String(argsContent || '').matchAll(re);
      for (const m of matches) {
        const paramName = m[1];
        const paramValue = m[2];
        xmlLines.push(`    <parameter name="${paramName}">${paramValue}</parameter>`);
      }
    } catch {}
  }

  xmlLines.push('  </invoke>');
  xmlLines.push('</sentra-tools>');
  return xmlLines.join('\n');
}

// 批量构建 <sentra-tools>，包含多个 <invoke>
function buildSentraToolsBatch(items) {
  const xmlLines = ['<sentra-tools>'];
  for (const { aiName, argsContent } of items) {
    xmlLines.push(`  <invoke name="${aiName}">`);
    // 与 buildSentraToolsFromArgs 相同的解析逻辑：优先 JSON，回退 XML
    let parsed = null;
    try {
      const trimmed = String(argsContent || '').trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        parsed = JSON.parse(trimmed);
      }
    } catch {}
    if (parsed && typeof parsed === 'object') {
      const entries = argsObjectToParamEntries(parsed);
      for (const p of entries) {
        xmlLines.push(`    <parameter name="${p.name}">${valueToXMLString(p.value, 0)}</parameter>`);
      }
    } else {
      try {
        const re = /<([a-zA-Z0-9_\-]+)>([^<]*)<\/\1>/g;
        const matches = String(argsContent || '').matchAll(re);
        for (const m of matches) {
          const paramName = m[1];
          const paramValue = m[2];
          xmlLines.push(`    <parameter name="${paramName}">${paramValue}</parameter>`);
        }
      } catch {}
    }
    xmlLines.push('  </invoke>');
  }
  xmlLines.push('</sentra-tools>');
  return xmlLines.join('\n');
}
