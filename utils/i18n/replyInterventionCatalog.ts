import { formatI18nTemplate, resolveI18nLocale, type I18nLocale } from './index.js';

type Catalog = Record<string, string>;

const ZH_CN: Catalog = Object.freeze({
  reply_gate_chat_retry_failed: 'reply_gate_chat_retry_failed: {detail}',
  reply_gate_invalid_output: 'reply_gate_invalid_output',
  reply_gate_llm_failed: 'reply_gate_llm_failed: {detail}',
  override_chat_retry_failed: 'override_chat_retry_failed: {detail}',
  override_parse_failed: 'override_parse_failed',
  override_llm_failed: 'override_llm_failed: {detail}'
});

const EN_US: Catalog = Object.freeze({
  reply_gate_chat_retry_failed: 'reply_gate_chat_retry_failed: {detail}',
  reply_gate_invalid_output: 'reply_gate_invalid_output',
  reply_gate_llm_failed: 'reply_gate_llm_failed: {detail}',
  override_chat_retry_failed: 'override_chat_retry_failed: {detail}',
  override_parse_failed: 'override_parse_failed',
  override_llm_failed: 'override_llm_failed: {detail}'
});

function getCatalog(locale: I18nLocale): Catalog {
  if (locale === 'en-US') return EN_US;
  return ZH_CN;
}

export function tReplyIntervention(key: string, params: Record<string, unknown> = {}, locale = resolveI18nLocale()): string {
  const catalog = getCatalog(locale);
  const template = catalog[key] || ZH_CN[key] || '';
  if (!template) return '';
  return formatI18nTemplate(template, params);
}

