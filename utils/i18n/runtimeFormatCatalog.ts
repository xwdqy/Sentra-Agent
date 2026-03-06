import { formatI18nTemplate, resolveI18nLocale, type I18nLocale } from './index.js';

type Catalog = Record<string, string>;

const ZH_CN: Catalog = Object.freeze({
  empty_or_non_string_response: '响应为空或不是字符串',
  missing_sentra_tools_block: '缺少 <sentra-tools> 顶层块',
  unexpected_sentra_message_block: '不允许输出 <sentra-message> 顶层块',
  invalid_sentra_message_segments: 'sentra-message 的 segment 无效',
  must_output_one_tools_or_message_block: '必须且只能输出一个顶层块：<sentra-tools> 或 <sentra-message>',
  sentra_message_must_contain_segment: 'sentra-message 至少需要一个 segment',
  sentra_message_must_contain_valid_segment: 'sentra-message 至少需要一个有效 segment',
  sentra_message_parse_failed: 'sentra-message 解析失败（message/segment）',
  sentra_message_must_include_chat_type: 'sentra-message 必须包含 chat_type=group|private',
  chat_type_group_requires_group_id: 'chat_type=group 时必须包含 group_id',
  chat_type_group_cannot_include_user_id: 'chat_type=group 时不能包含 user_id',
  chat_type_private_requires_user_id: 'chat_type=private 时必须包含 user_id',
  chat_type_private_cannot_include_group_id: 'chat_type=private 时不能包含 group_id',
  invalid_reply_gate_decision_enter: 'reply_gate_decision.enter 必须为 boolean',
  missing_override_intent_invoke: '缺少 override_intent_decision invoke',
  invalid_override_decision_value: 'override_intent_decision.decision 非法',
  missing_sentra_message_block: '缺少 <sentra-message> 顶层块',
  extra_content_outside_sentra_message: '检测到 <sentra-message> 外存在额外内容',
  forbidden_readonly_tag: '包含只读标签: {tag}',
  guard_empty: '空响应',
  guard_missing_sentra_tools: '未检测到 <sentra-tools> 顶层块',
  guard_missing_sentra_tools_or_message: '未检测到 <sentra-tools>/<sentra-message> 顶层块',
  guard_missing_sentra_message: '未检测到 <sentra-message> 顶层块',
  repaired_override_decision: '已自动修复 override 决策',

  protocol_fix_objective: '修复上一条输出格式，并重新输出符合协议的内容',
  c_xml_only: '输出必须是合法 XML，禁止 markdown 代码块',
  c_single_message_only: '只输出一个 <sentra-message>...</sentra-message> 顶层块',
  c_message_structure: '若输出 <sentra-message>，必须包含 <message> 且至少一个有效 <segment>',
  c_text_segment_non_empty: 'text segment 必须是 <type>text</type> 且 <text> 非空',
  c_route_required: '路由必须明确：二选一输出 <group_id> 或 <user_id>',
  c_single_tools_only: '只输出一个 <sentra-tools>...</sentra-tools> 顶层块',
  c_tools_or_message_only: '只允许输出一个顶层块：<sentra-tools> 或 <sentra-message>',

  cr_override_1: '只输出一个 <sentra-tools>，并且只包含一个 <invoke name="override_intent_decision">',
  cr_override_2: 'invoke 必须包含 decision(string)/confidence(number)/reason(string)',
  cr_override_3: '禁止输出 <sentra-message>',
  cr_override_4: '禁止使用 markdown 代码块',
  cr_gate_1: '只输出一个 <sentra-tools>，并且只包含一个 <invoke name="reply_gate_decision">',
  cr_gate_2: 'invoke 必须包含 enter(boolean) 和 reason(string)',
  cr_gate_3: '禁止输出 <sentra-message> 或其他额外文本',
  cr_gate_4: '禁止使用 markdown 代码块',

  log_attempt: 'AI 请求第 {attempt} 次尝试',
  log_stream_early_terminated: '流式提前终止: {reason}',
  log_protocol_reminder_injected: '已注入协议纠偏提醒: {reason}',
  log_format_check_failed: '格式校验失败: {reason}',
  log_raw_response_on_format_failed: '格式失败响应片段: {preview}',
  log_format_fix_success_append_root: '追加 root 指令后格式修复成功',
  log_format_fix_append_root_failed: '追加 root 指令修复失败: {reason}',
  log_retry_after_format_fail: '格式失败，开始第 {attempt} 次重试',
  log_format_fix_pipeline_success: '格式自动修复成功',
  log_format_fix_pipeline_failed_preview: '修复后仍不合规，响应片段: {preview}',
  log_format_fix_pipeline_failed: '格式修复失败: {reason}',
  log_format_final_failed: '格式校验最终失败，已达最大重试次数',
  log_last_raw_response: '最后一次原始响应片段: {preview}',
  log_expected_message_got_tools: '期望 sentra-message，但收到纯 sentra-tools，将上抛 toolsOnly',
  log_token_stats: 'Token 统计: {tokens} tokens, 文本长度: {length}',
  log_token_exceeded: 'Token 超限: {tokens} > {max}',
  log_raw_response_on_token_exceeded: 'Token 超限响应片段: {preview}',
  log_retry_after_token_exceeded: 'Token 超限，开始第 {attempt} 次重试',
  log_token_final_failed: 'Token 超限最终失败，已达最大重试次数',
  reason_token_exceeded: 'Token 超限: {tokens}>{max}',
  log_no_reply_by_zero_token: 'Token 为 0 且无非文本载荷，本轮按不回复处理',
  log_ai_success: 'AI 响应成功 ({tokens}/{limit} tokens)',
  log_ai_request_failed_attempt: 'AI 请求失败 - 第 {attempt} 次尝试',
  log_api_error_data: 'API 失败响应片段: {preview}',
  log_retry_after_network_error: '网络错误，1 秒后第 {attempt} 次重试',
  log_ai_request_failed_final: 'AI 请求失败 - 已达最大重试次数 {max}',
  log_last_success_response: '最后一次成功响应片段: {preview}',
  reason_unknown_error: '未知错误',

  fix_objective_message: '将 candidate_output 修复为合规的 sentra-message',
  fix_objective_tools: '将 candidate_output 修复为合规的 sentra-tools',
  fix_objective_tools_or_message: '将 candidate_output 修复为合规的 sentra-tools 或 sentra-message',
  fix_m_item_1: '仅输出一个顶层 <sentra-message>...</sentra-message>',
  fix_m_item_2: '禁止输出 <sentra-tools>/<sentra-result>/<sentra-input> 等只读标签',
  fix_m_item_3: '若需 text，使用 <message><segment><type>text</type><data><text>...</text></data></segment></message>',
  fix_t_item_1: '仅输出一个顶层 <sentra-tools>...</sentra-tools>',
  fix_t_item_2: '禁止输出 <sentra-message>/<sentra-result>/<sentra-input> 等只读标签',
  fix_t_item_3: 'sentra-tools 内仅包含合法 <invoke name="..."> 与 <parameter name="...">',
  fix_tm_item_1: '只允许一个顶层块',
  fix_tm_item_2: '可输出 <sentra-tools> 或 <sentra-message> 二选一',
  fix_tm_item_3: '若输出 <sentra-tools>，禁止包含 sentra-message/result/input',
  fix_tm_item_4: '若输出 <sentra-message>，禁止包含 sentra-tools/result/input',

  log_format_fix_agent_failed: '[{group}] 格式修复调用失败: {err}',
  log_trim_to_first_tools_block: '检测到 sentra-tools 外存在额外内容，已截取首个 sentra-tools',
  log_trim_to_first_tools_block_tools_or_message: 'tools_or_message: 截取首个 sentra-tools 作为兜底',
  log_trim_to_first_message_block: '检测到 sentra-message 外存在额外内容，已截取首个 sentra-message'
});

const EN_US: Catalog = Object.freeze({
  empty_or_non_string_response: 'empty or non-string response',
  reason_unknown_error: 'unknown error'
});

function getCatalog(locale: I18nLocale): Catalog {
  if (locale === 'en-US') return EN_US;
  return ZH_CN;
}

export function tRuntimeFormat(
  key: string,
  params: Record<string, unknown> = {},
  locale = resolveI18nLocale()
): string {
  const catalog = getCatalog(locale);
  const template = catalog[key] || ZH_CN[key] || key;
  return formatI18nTemplate(template, params);
}
