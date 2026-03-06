import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '');
}

// Load JSON prompt files under prompts/, e.g. loadPrompt('persona_initial') -> persona_initial.json
export async function loadPrompt(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('loadPrompt: name is required');
  }
  const filePath = path.resolve(__dirname, `${name}.json`);
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(stripBom(raw));
}

// Replace {{key}} with vars[key]
export function renderTemplate(str, vars = {}) {
  return String(str ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '';
  });
}

// Compose final system prompt: overlay first, then base
export function composeSystem(base, overlay) {
  const b = String(base ?? '');
  const o = overlay ? String(overlay) : '';
  return o ? `${o}\n\n${b}` : b;
}
