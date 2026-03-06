import { formatI18nTemplate, resolveI18nLocale, type I18nLocale } from './index.js';

type Catalog = Record<string, string>;

const ZH_CN: Catalog = Object.freeze({
  force_reply: '强制进入主流程（override 决策）',
  private_llm_delay: '私聊 LLM 决策：延迟回复',
  private_llm_delay_with_reason: '私聊 LLM 决策：{reason}',
  private_llm_short: '私聊 LLM 决策：短回复',
  private_llm_short_with_reason: '私聊 LLM 决策：{reason}',
  private_llm_action: '私聊 LLM 决策：正常回复',
  private_llm_action_with_reason: '私聊 LLM 决策：{reason}',
  private_llm_unavailable: '私聊消息：LLM 门禁不可用，按 action 处理',
  local_concurrency_queue: '并发限制：当前会话已有任务在处理，消息已进入队列等待',
  local_attention_list: '注意力名单未覆盖该发送者，且未@/未提及机器人名称：跳过本轮消息',
  local_attention_window: '注意力窗口已满：当前时间窗内活跃发送者过多，为避免刷屏本轮跳过',
  local_group_fatigue: '群疲劳：短期内机器人在该群回复过多，进入退避窗口',
  local_sender_fatigue: '用户疲劳：短期内机器人对该用户回复过多，进入退避窗口',
  local_reply_gate_ignore: '本地门禁判定无需回复',
  local_reply_gate_accum: '聚合门禁未通过：近期多条低价值消息累计不足阈值，或当前已有任务在处理（避免刷屏）',
  llm_reply_enter: 'LLM 决策：建议进入主对话流程',
  llm_reply_silent: 'LLM 决策：建议本轮不进入主对话流程',
  llm_reply_with_reason: 'LLM 决策：{reason}',
  local_mandatory_mention: '显式@且配置要求必须回复：强制覆盖为需要回复',
  final_no_reply: '本轮不回复',
  final_enter_main: '进入主对话流程'
});

const EN_US: Catalog = Object.freeze({
  force_reply: 'Force enter main flow (override decision)',
  private_llm_delay: 'Private chat LLM decision: delay reply',
  private_llm_delay_with_reason: 'Private chat LLM decision: {reason}',
  private_llm_short: 'Private chat LLM decision: short reply',
  private_llm_short_with_reason: 'Private chat LLM decision: {reason}',
  private_llm_action: 'Private chat LLM decision: normal reply',
  private_llm_action_with_reason: 'Private chat LLM decision: {reason}',
  private_llm_unavailable: 'Private chat: LLM gate unavailable, fallback to action',
  local_concurrency_queue: 'Concurrency limit: task queued for this conversation',
  local_attention_list: 'Sender outside attention list without mention, skip this turn',
  local_attention_window: 'Attention window full, skip this turn to avoid flooding',
  local_group_fatigue: 'Group fatigue: too many recent bot replies in this group',
  local_sender_fatigue: 'Sender fatigue: too many recent bot replies to this sender',
  local_reply_gate_ignore: 'Local gate decided no reply',
  local_reply_gate_accum: 'Accumulated gate threshold not met or conversation busy',
  llm_reply_enter: 'LLM decision: enter main flow',
  llm_reply_silent: 'LLM decision: stay silent this turn',
  llm_reply_with_reason: 'LLM decision: {reason}',
  local_mandatory_mention: 'Explicit mention must reply by policy',
  final_no_reply: 'No reply this turn',
  final_enter_main: 'Enter main flow'
});

const REPLY_GATE_BASE_ZH_CN: Record<string, string> = Object.freeze({
  reply_gate_disabled: 'ReplyGate 已关闭：跳过本地预判，交给 LLM 决策',
  non_group_message: '非群聊消息：ReplyGate 不参与（由上层策略处理）',
  empty_text: '空文本：群消息没有可分析的文本内容',
  analyzer_error: '本地分析器异常：已回退为 LLM 决策',
  policy_blocked: '合规策略拦截：检测到风险内容，本轮不进入回复流程',
  below_min_threshold: '价值极低：低于最小阈值，本轮直接忽略',
  pass_to_llm: '通过本地预判：进入 LLM 决策阶段'
});

const REPLY_GATE_CODE_ZH_CN: Record<string, string> = Object.freeze({
  EMPTY_OR_INVALID_INPUT: '空内容或非法输入',
  TEXT_TOO_SHORT: '文本过短（信息量不足）',
  LOW_ENTROPY_GIBBERISH: '疑似乱码/灌水（熵过低）',
  TOO_FEW_TOKENS: '有效词过少（信息量不足）',
  LOW_SEMANTIC_VALUE: '语义信息量低（缺少明确意图）',
  POLICY_BLOCKED: '合规拦截（辱骂/敏感/风险内容）',
  POLICY_FLAGGED: '合规提示（存在轻度风险内容）',
  HARD_REPEAT_SHRINK: '高度重复：与近期内容相似度过高，回复概率被强力下调',
  REPETITIVE_CONTENT: '重复内容：与历史消息过于相似',
  LOW_REPLY_PROBABILITY: '回复价值低：综合评估后概率偏低'
});

function getCatalog(locale: I18nLocale): Catalog {
  if (locale === 'en-US') return EN_US;
  return ZH_CN;
}

export function tReplyPolicy(key: string, params: Record<string, unknown> = {}, locale = resolveI18nLocale()): string {
  const catalog = getCatalog(locale);
  const template = catalog[key] || ZH_CN[key] || '';
  if (!template) return '';
  return formatI18nTemplate(template, params);
}

export function tReplyGateBase(base: string): string {
  return REPLY_GATE_BASE_ZH_CN[base] || base;
}

export function tReplyGateCode(code: string): string {
  return REPLY_GATE_CODE_ZH_CN[code] || code;
}

