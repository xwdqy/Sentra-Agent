import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '');
}

export async function loadTerminalPrompt(name) {
  const filePath = path.resolve(__dirname, 'prompts', `${name}.json`);
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(stripBom(raw));
}

export function renderTemplate(str, vars = {}) {
  return String(str ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '';
  });
}

function normalizeFewShots(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const request = String(item.request || '').trim();
    const response = String(item.response || '').trim();
    if (!request || !response) continue;
    out.push({ request, response });
    if (out.length >= 8) break;
  }
  return out;
}

export function pickTerminalPrompt(promptObj) {
  if (!promptObj || typeof promptObj !== 'object') {
    return { system: '', user: '', examples: [] };
  }

  return {
    system: typeof promptObj.system === 'string' ? promptObj.system : '',
    user: typeof promptObj.user === 'string' ? promptObj.user : '',
    examples: normalizeFewShots(promptObj.examples),
  };
}

export default {
  loadTerminalPrompt,
  renderTemplate,
  pickTerminalPrompt
};
