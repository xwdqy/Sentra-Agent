import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv } from '../config/env.js';

export async function loadContractPolicy() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const ragRoot = path.resolve(__dirname, '..', '..');
  const abs = path.join(ragRoot, 'prompts', 'sentra_policy_rag_contract.json');
  const raw = await readFile(abs, 'utf8');
  const json = JSON.parse(raw);

  const lang = String(getEnv('SENTRA_CONTRACT_LANG', { defaultValue: 'zh' })).toLowerCase();
  const text = lang.startsWith('zh') ? json.zh : json.en;
  if (!text) throw new Error('Contract policy missing for selected language');

  return { lang: lang.startsWith('zh') ? 'zh' : 'en', text };
}
