import { randomUUID } from 'node:crypto';
import { escapeXml } from '../utils/xmlUtils.js';

function withTimeout(promise, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TOOL_PREREPLY_TIMEOUT')), ms);
    })
  ]);
}

function buildToolPreReplyRootDirectiveXml({
  judgeSummary,
  toolNames,
  skipToolNames,
  originalRootXml,
  scope = 'single_turn'
} = {}) {
  const summary = String(judgeSummary || '').trim();
  const tools0 = Array.isArray(toolNames) ? toolNames : [];
  const toolList = tools0
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const tools = toolList.filter((t, i) => toolList.indexOf(t) === i);

  const skip0 = Array.isArray(skipToolNames) ? skipToolNames : [];
  const skipList = skip0
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const skipSet = new Set(skipList);

  const focusTools = tools.filter((t) => !skipSet.has(t));
  const skippableTools = tools.filter((t) => skipSet.has(t));
  const focusLine = focusTools.length ? focusTools.join(', ') : '';
  const skippableLine = skippableTools.length ? skippableTools.join(', ') : '';
  const orig = String(originalRootXml || '').trim();

  return [
    '<sentra-root-directive>',
    `  <id>tool_prereply_${randomUUID()}</id>`,
    '  <type>tool_prereply</type>',
    `  <scope>${scope}</scope>`,
    '  <phase>ToolPreReply</phase>',
    '  <objective>你的任务是：在“确实有必要打断用户”的情况下，先生成一段很短的承上启下回复，让用户感知你正在处理，并说明你下一步会优先核实/查询/分析哪些关键方向。注意：对用户可见文本中不要提及“工具/MCP/调用工具/系统提示/协议/流程”等内部细节；不要直接罗列工具名称。若当前输入信息不足（例如只有图片/表情/动画表情且没有明确诉求）、或任务非常轻量无需打断，请输出空的 <sentra-response></sentra-response> 以保持沉默。</objective>',
    '  <allow_tools>false</allow_tools>',
    `  <judge_reason>${escapeXml(summary)}</judge_reason>`,
    (focusLine
      ? [
          `  <focus_tools>${escapeXml(focusLine)}</focus_tools>`
        ].join('\n')
      : ''),
    (skippableLine
      ? [
          `  <skippable_tools>${escapeXml(skippableLine)}</skippable_tools>`
        ].join('\n')
      : ''),
    (orig
      ? [
          `  <original_root_directive>${escapeXml(orig)}</original_root_directive>`
        ].join('\n')
      : ''),
    '  <constraints>',
    '    <item>你必须且只能输出一个顶层块：<sentra-response>...</sentra-response>；除此之外不要输出任何字符、解释、前后缀。</item>',
    '    <item>当你判断“不需要插嘴/信息不足/会打扰用户”时：输出空的 `<sentra-response></sentra-response>`（不要包含 text/resources/send/emoji 等任何内容）。</item>',
    '    <item>当你判断“需要预回复”时：最终输出的 `<sentra-response>` 必须包含至少一个非空的 `<text1>`。</item>',
    '    <item>强烈建议拆成多段 `<textN>`：优先使用 `<text1>` + `<text2>`（必要时可加 `<text3>`），每段表达一个语义块，避免把所有内容塞进一个很长的 `<text1>`。</item>',
    '    <item>推荐结构：<text1>承接/确认用户诉求（1句）</text1>；<text2>你接下来会先核实/查询/分析哪些方向，以及你稍后会给出什么结果（1句）</text2>；如需补充再用 <text3>。</item>',
    '    <item>语言要自然、像真人聊天。整体尽量短（建议 2-3 句），不要客套堆砌。</item>',
    '    <item>严禁泄露内部实现、工具名称、参数、调用链路；不要出现 “工具调用/根据系统提示/我将调用…” 等旁白。</item>',
    '    <item>你应当围绕 <focus_tools> 对应的关键方向来写预回复；<skippable_tools> 属于可跳过项：不要在对用户可见文本中提及或描述它们。</item>',
    '  </constraints>',
    '</sentra-root-directive>'
  ]
    .filter((x) => x !== '')
    .join('\n');
}

export async function generateToolPreReply({
  chatWithRetry,
  model,
  groupId,
  baseConversations,
  userContentNoRoot,
  judgeSummary,
  toolNames,
  skipToolNames,
  originalRootXml,
  timeoutMs
} = {}) {
  const baseConv = Array.isArray(baseConversations) ? baseConversations : [];
  const userBase = typeof userContentNoRoot === 'string' ? userContentNoRoot : '';

  const rootXml = buildToolPreReplyRootDirectiveXml({
    judgeSummary,
    toolNames,
    skipToolNames,
    originalRootXml
  });

  const fullUserContent = userBase ? `${rootXml}\n\n${userBase}` : rootXml;

  let result = null;
  try {
    result = await withTimeout(
      chatWithRetry(
        [...baseConv, { role: 'user', content: fullUserContent }],
        { model, __sentraExpectedOutput: 'sentra_response' },
        groupId
      ),
      timeoutMs
    );
  } catch {
    return null;
  }

  if (!result || !result.success || !result.response || result.toolsOnly) {
    return null;
  }

  return result.response;
}
