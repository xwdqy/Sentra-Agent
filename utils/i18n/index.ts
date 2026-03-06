import { getEnv } from '../envHotReloader.js';

export type I18nLocale = 'zh-CN' | 'en-US';

const DEFAULT_LOCALE: I18nLocale = 'zh-CN';

function normalizeLocale(raw: unknown): I18nLocale {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return DEFAULT_LOCALE;
  if (v === 'zh' || v === 'zh-cn' || v === 'zh_hans' || v === 'zh-hans') return 'zh-CN';
  if (v === 'en' || v === 'en-us') return 'en-US';
  return DEFAULT_LOCALE;
}

export function resolveI18nLocale(): I18nLocale {
  const explicit = getEnv('SENTRA_LOCALE', getEnv('LOCALE', ''));
  return normalizeLocale(explicit);
}

export function formatI18nTemplate(template: string, params: Record<string, unknown> = {}): string {
  if (!template) return '';
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
    const value = params[key];
    if (value == null) return '';
    return String(value);
  });
}

