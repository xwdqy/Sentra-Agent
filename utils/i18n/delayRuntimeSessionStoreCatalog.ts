import { formatI18nTemplate, resolveI18nLocale, type I18nLocale } from './index.js';

type Catalog = Record<string, string>;

const ZH_CN: Catalog = Object.freeze({
  sessions_pruned: 'DelayRuntimeSessionStore: 会话已清理',
  session_created: 'DelayRuntimeSessionStore: 会话已创建'
});

const EN_US: Catalog = Object.freeze({
  sessions_pruned: 'DelayRuntimeSessionStore: sessions pruned',
  session_created: 'DelayRuntimeSessionStore: session created'
});

function getCatalog(locale: I18nLocale): Catalog {
  if (locale === 'en-US') return EN_US;
  return ZH_CN;
}

export function tDelayRuntimeSessionStore(
  key: string,
  params: Record<string, unknown> = {},
  locale = resolveI18nLocale()
): string {
  const catalog = getCatalog(locale);
  const template = catalog[key] || ZH_CN[key] || key;
  return formatI18nTemplate(template, params);
}
