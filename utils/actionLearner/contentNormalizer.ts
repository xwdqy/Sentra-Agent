import { XMLParser } from 'fast-xml-parser';
import { getEnv } from '../envHotReloader.js';

export const ACTION_LEARNER_BOT_PLACEHOLDER = '__BOT_NAME__';

type NormalizeActionLearnerPayloadInput = {
  text?: unknown;
  rawContent?: unknown;
  botNames?: Array<string | number>;
};

export type NormalizeActionLearnerPayloadOutput = {
  text: string;
  payload?: {
    format: 'sentra_input_xml' | 'plain_text';
    canonicalContent: string;
    placeholder: string;
  };
  botNames: string[];
  usedSentraInputXml: boolean;
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false
});

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizeWhitespace(text: unknown): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBotNamesFromEnv(): string[] {
  const raw = String(getEnv('BOT_NAMES', '') ?? '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((v) => normalizeWhitespace(v))
    .filter(Boolean);
}

function normalizeBotNames(names: Array<string | number>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of names) {
    const s = normalizeWhitespace(value);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceBotNames(text: unknown, botNames: string[]): string {
  const input = String(text ?? '');
  if (!input || botNames.length === 0) return input;
  const pattern = botNames.map((name) => escapeRegex(name)).join('|');
  if (!pattern) return input;
  const re = new RegExp(pattern, 'giu');
  return input.replace(re, ACTION_LEARNER_BOT_PLACEHOLDER);
}

function readTextNode(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    const textValue = record['#text'];
    if (typeof textValue === 'string' || typeof textValue === 'number' || typeof textValue === 'boolean') {
      return String(textValue);
    }
  }
  return '';
}

function findFirstTag(root: unknown, tag: string): Record<string, unknown> | null {
  if (!root || typeof root !== 'object') return null;
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findFirstTag(item, tag);
      if (found) return found;
    }
    return null;
  }
  const record = root as Record<string, unknown>;
  const direct = record[tag];
  if (direct && typeof direct === 'object') {
    return Array.isArray(direct)
      ? (direct.find((x) => !!x && typeof x === 'object') as Record<string, unknown> | undefined) || null
      : (direct as Record<string, unknown>);
  }
  for (const child of Object.values(record)) {
    const found = findFirstTag(child, tag);
    if (found) return found;
  }
  return null;
}

function extractTextFromSentraInputNode(node: Record<string, unknown>): string {
  const currentMessages = node.current_messages as Record<string, unknown> | undefined;
  const sentraMessages = toArray(
    currentMessages?.['sentra-message'] ?? (currentMessages as Record<string, unknown> | undefined)?.sentra_message
  );

  const chunks: string[] = [];
  for (const sentraMessage of sentraMessages) {
    if (!sentraMessage || typeof sentraMessage !== 'object') continue;
    const sm = sentraMessage as Record<string, unknown>;
    const chatType = normalizeWhitespace(readTextNode(sm.chat_type)).toLowerCase();
    if (chatType === 'group' || chatType === 'private') {
      chunks.push(`[chat:${chatType}]`);
    }
    const messageNode = sm.message as Record<string, unknown> | undefined;
    const segments = toArray(messageNode?.segment);
    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') continue;
      const seg = segment as Record<string, unknown>;
      const segType = normalizeWhitespace(readTextNode(seg.type)).toLowerCase();
      const segData = (seg.data && typeof seg.data === 'object') ? seg.data as Record<string, unknown> : {};
      if (segType === 'text') {
        const text = normalizeWhitespace(readTextNode(segData.text));
        if (text) chunks.push(text);
        continue;
      }
      if (segType) chunks.push(`[seg:${segType}]`);
    }
  }
  return normalizeWhitespace(chunks.join(' '));
}

function normalizeFromSentraInputXml(rawXml: string, botNames: string[]): NormalizeActionLearnerPayloadOutput {
  const wrapped = `<root>${rawXml}</root>`;
  const parsed = xmlParser.parse(wrapped) as Record<string, unknown>;
  const rootNode = (parsed?.root && typeof parsed.root === 'object') ? parsed.root : {};
  const sentraInput = findFirstTag(rootNode, 'sentra-input');
  const text = sentraInput ? replaceBotNames(extractTextFromSentraInputNode(sentraInput), botNames) : '';
  return {
    text: normalizeWhitespace(text),
    payload: {
      format: 'sentra_input_xml',
      canonicalContent: replaceBotNames(rawXml, botNames),
      placeholder: ACTION_LEARNER_BOT_PLACEHOLDER
    },
    botNames,
    usedSentraInputXml: true
  };
}

export function normalizeActionLearnerPayload(
  input: NormalizeActionLearnerPayloadInput
): NormalizeActionLearnerPayloadOutput {
  const names = normalizeBotNames(
    Array.isArray(input.botNames) && input.botNames.length > 0 ? input.botNames : parseBotNamesFromEnv()
  );
  const rawContent = String(input.rawContent ?? '').trim();
  if (rawContent && rawContent.includes('<sentra-input')) {
    try {
      return normalizeFromSentraInputXml(rawContent, names);
    } catch {
      // fallback to plain mode when XML parse fails
    }
  }

  const plainSource = rawContent || String(input.text ?? '');
  const replaced = replaceBotNames(plainSource, names);
  const out: NormalizeActionLearnerPayloadOutput = {
    text: normalizeWhitespace(replaced),
    botNames: names,
    usedSentraInputXml: false
  };
  if (rawContent) {
    out.payload = {
      format: 'plain_text',
      canonicalContent: normalizeWhitespace(replaced),
      placeholder: ACTION_LEARNER_BOT_PLACEHOLDER
    };
  }
  return out;
}

export function normalizeActionLearnerText(text: unknown, botNames?: Array<string | number>): string {
  const names = normalizeBotNames(
    Array.isArray(botNames) && botNames.length > 0 ? botNames : parseBotNamesFromEnv()
  );
  return normalizeWhitespace(replaceBotNames(text, names));
}
