import { formatI18nTemplate, resolveI18nLocale, type I18nLocale } from './index.js';

type Catalog = Record<string, string>;

export const REPLY_GATE_REASON = Object.freeze({
  disabled: 'reply_gate_disabled',
  nonGroupMessage: 'non_group_message',
  emptyText: 'empty_text',
  analyzerError: 'analyzer_error',
  policyBlocked: 'policy_blocked',
  belowMinThreshold: 'below_min_threshold',
  passToLlm: 'pass_to_llm'
} as const);

const ZH_CN: Catalog = Object.freeze({
  [REPLY_GATE_REASON.disabled]: 'ReplyGate 已关闭，交给 LLM 决策',
  [REPLY_GATE_REASON.nonGroupMessage]: '非群聊消息，交给上层流程处理',
  [REPLY_GATE_REASON.emptyText]: '群消息无文本，直接忽略',
  [REPLY_GATE_REASON.analyzerError]: '分析器异常，保守交给 LLM',
  [REPLY_GATE_REASON.policyBlocked]: '命中策略拦截，直接忽略',
  [REPLY_GATE_REASON.belowMinThreshold]: '低于最小阈值，直接忽略',
  [REPLY_GATE_REASON.passToLlm]: '通过门禁，交给 LLM 细判'
});

const EN_US: Catalog = Object.freeze({
  [REPLY_GATE_REASON.disabled]: 'reply gate disabled',
  [REPLY_GATE_REASON.nonGroupMessage]: 'non-group message',
  [REPLY_GATE_REASON.emptyText]: 'empty text'
});

function getCatalog(locale: I18nLocale): Catalog {
  if (locale === 'en-US') return EN_US;
  return ZH_CN;
}

export function tReplyGate(
  key: string,
  params: Record<string, unknown> = {},
  locale = resolveI18nLocale()
): string {
  const catalog = getCatalog(locale);
  const template = catalog[key] || ZH_CN[key] || key;
  return formatI18nTemplate(template, params);
}
