import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '');
}

export async function loadPrompt(name) {
  const filePath = path.resolve(__dirname, `${name}.json`);
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(stripBom(raw));
}

export function renderTemplate(str, vars = {}) {
  return String(str ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '';
  });
}

export function composeSystem(base, overlay) {
  const b = String(base ?? '');
  const o = overlay ? String(overlay) : '';
  return o ? `${o}\n\n${b}` : b;
}

export function resolvePromptLocale(preferred = '') {
  const raw = String(preferred || process.env.PROMPT_LOCALE || 'en').trim().toLowerCase();
  return raw.startsWith('zh') ? 'zh' : 'en';
}

export function pickLocalizedPrompt(promptObj, preferred = '') {
  const locale = resolvePromptLocale(preferred);
  if (!promptObj || typeof promptObj !== 'object') return '';
  if (typeof promptObj[locale] === 'string') return promptObj[locale];
  const fallback = locale === 'en' ? 'zh' : 'en';
  if (typeof promptObj[fallback] === 'string') return promptObj[fallback];
  if (typeof promptObj.system === 'string') return promptObj.system;
  if (typeof promptObj.user === 'string') return promptObj.user;
  return '';
}
