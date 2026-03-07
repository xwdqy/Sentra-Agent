import { XMLParser } from 'fast-xml-parser';
import { loadActionLearnerConfig, type ActionLearnerConfig } from './config.js';
import { hashToIndex, hashToSign } from './hash.js';
import type { ActionFeatureInput, ActionFeatureVector } from './types.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false
});

function normalizeText(raw: unknown, maxLen: number): string {
  const text = String(raw ?? '')
    .normalize('NFKC')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return '';
  if (!Number.isFinite(maxLen) || maxLen <= 0 || text.length <= maxLen) return text;
  return text.slice(0, Math.max(1, Math.floor(maxLen)));
}

function splitTokens(text: string): string[] {
  if (!text) return [];
  const parts = text.split(/[\s,.;!?'"`~@#$%^&*()_+\-=[\]{}<>|\\/]+/g);
  const out: string[] = [];
  for (const p of parts) {
    const v = p.trim();
    if (!v) continue;
    out.push(v);
  }
  return out;
}

function addHashed(map: Map<number, number>, token: string, weight: number, dim: number): void {
  if (!token || !Number.isFinite(weight) || weight === 0) return;
  const idx = hashToIndex(token, dim);
  const sign = hashToSign(token);
  const prev = map.get(idx) || 0;
  map.set(idx, prev + sign * weight);
}

function addCharNgrams(
  map: Map<number, number>,
  text: string,
  minN: number,
  maxN: number,
  dim: number
): void {
  if (!text) return;
  const padded = `^${text}$`;
  for (let n = minN; n <= maxN; n++) {
    if (n <= 0 || n > padded.length) continue;
    for (let i = 0; i + n <= padded.length; i++) {
      const gram = padded.slice(i, i + n);
      addHashed(map, `cg:${n}:${gram}`, 1, dim);
    }
  }
}

function addWordNgrams(
  map: Map<number, number>,
  tokens: string[],
  minN: number,
  maxN: number,
  dim: number
): void {
  if (!tokens.length) return;
  for (let n = minN; n <= maxN; n++) {
    if (n <= 0 || n > tokens.length) continue;
    for (let i = 0; i + n <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n).join('_');
      addHashed(map, `wg:${n}:${gram}`, 1, dim);
    }
  }
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizeSimple(raw: unknown, maxLen = 64): string {
  const s = String(raw ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

function normalizeKey(raw: unknown): string {
  const s = normalizeSimple(raw, 96);
  if (!s) return 'unknown';
  return s.replace(/[^a-z0-9_.:-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function readTextNode(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if (typeof rec['#text'] === 'string' || typeof rec['#text'] === 'number' || typeof rec['#text'] === 'boolean') {
      return String(rec['#text']);
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
    if (Array.isArray(direct)) {
      for (const item of direct) {
        if (item && typeof item === 'object') return item as Record<string, unknown>;
      }
      return null;
    }
    return direct as Record<string, unknown>;
  }
  for (const child of Object.values(record)) {
    const found = findFirstTag(child, tag);
    if (found) return found;
  }
  return null;
}

type PayloadSegment = {
  segmentType: string;
  data: Record<string, unknown>;
};

type ParsedPayload = {
  chatTypes: string[];
  routeFlags: string[];
  messageCount: number;
  segments: PayloadSegment[];
};

function parseSentraInputPayload(rawXml: string): ParsedPayload | null {
  const xml = String(rawXml || '').trim();
  if (!xml || !xml.includes('<sentra-input')) return null;
  try {
    const parsed = xmlParser.parse(`<root>${xml}</root>`) as Record<string, unknown>;
    const rootNode = parsed?.root && typeof parsed.root === 'object' ? parsed.root : {};
    const sentraInput = findFirstTag(rootNode, 'sentra-input');
    if (!sentraInput) return null;

    const current = sentraInput.current_messages as Record<string, unknown> | undefined;
    const messages = toArray(
      current?.['sentra-message'] ?? (current as Record<string, unknown> | undefined)?.sentra_message
    );

    const chatTypes: string[] = [];
    const routeFlags: string[] = [];
    const segments: PayloadSegment[] = [];

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const record = msg as Record<string, unknown>;
      const chatType = normalizeSimple(readTextNode(record.chat_type), 24);
      if (chatType) chatTypes.push(chatType);
      if (normalizeSimple(readTextNode(record.group_id), 32)) routeFlags.push('has_group_id');
      if (normalizeSimple(readTextNode(record.user_id), 32)) routeFlags.push('has_user_id');
      if (normalizeSimple(readTextNode(record.sender_id), 32)) routeFlags.push('has_sender_id');
      if (normalizeSimple(readTextNode(record.message_id), 32)) routeFlags.push('has_message_id');

      const messageNode = record.message as Record<string, unknown> | undefined;
      const segs = toArray(messageNode?.segment);
      for (const seg of segs) {
        if (!seg || typeof seg !== 'object') continue;
        const segRecord = seg as Record<string, unknown>;
        const segmentType = normalizeSimple(readTextNode(segRecord.type), 32);
        if (!segmentType) continue;
        const dataRaw = segRecord.data;
        const data = dataRaw && typeof dataRaw === 'object'
          ? dataRaw as Record<string, unknown>
          : {};
        if (normalizeSimple(readTextNode(data.message_id), 32)) routeFlags.push('has_message_id');
        segments.push({ segmentType, data });
      }
    }

    return {
      chatTypes,
      routeFlags,
      messageCount: messages.length,
      segments
    };
  } catch {
    return null;
  }
}

function bucketCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n === 1) return '1';
  if (n === 2) return '2';
  if (n <= 4) return '3_4';
  if (n <= 8) return '5_8';
  return '9p';
}

function bucketLength(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n <= 4) return '1_4';
  if (n <= 8) return '5_8';
  if (n <= 16) return '9_16';
  if (n <= 32) return '17_32';
  if (n <= 64) return '33_64';
  return '65p';
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function looksLikePath(s: string): boolean {
  return /[\\/]/.test(s) || /^[a-z]:/i.test(s);
}

function extractExt(s: string): string {
  const m = s.match(/\.([a-z0-9]{1,8})(?:$|[?#])/i);
  return m && m[1] ? m[1].toLowerCase() : '';
}

type FlatDataEntry = { key: string; value: unknown };

function flattenDataEntries(
  value: unknown,
  keyPrefix = '',
  depth = 0,
  maxDepth = 3,
  out: FlatDataEntry[] = []
): FlatDataEntry[] {
  if (out.length >= 128) return out;
  if (depth > maxDepth) {
    out.push({ key: keyPrefix || 'value', value: value == null ? '' : String(value) });
    return out;
  }

  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    out.push({ key: keyPrefix || 'value', value });
    return out;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      out.push({ key: keyPrefix || 'value', value: [] });
      return out;
    }
    for (const item of value) {
      flattenDataEntries(item, keyPrefix || 'value', depth + 1, maxDepth, out);
      if (out.length >= 128) break;
    }
    return out;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  if (!entries.length) {
    out.push({ key: keyPrefix || 'value', value: {} });
    return out;
  }
  for (const [key, child] of entries) {
    const nextKey = keyPrefix ? `${keyPrefix}.${key}` : key;
    flattenDataEntries(child, nextKey, depth + 1, maxDepth, out);
    if (out.length >= 128) break;
  }
  return out;
}

function addPayloadValueFeatures(
  map: Map<number, number>,
  segmentType: string,
  key: string,
  value: unknown,
  dim: number
): void {
  const keyToken = normalizeKey(key);
  if (typeof value === 'string') {
    const s = normalizeSimple(value, 256);
    if (!s) {
      addHashed(map, `pl:val_kind:${segmentType}:${keyToken}:empty`, 1, dim);
      return;
    }

    addHashed(map, `pl:val_kind:${segmentType}:${keyToken}:str`, 1, dim);
    addHashed(map, `pl:val_len:${segmentType}:${keyToken}:${bucketLength(s.length)}`, 0.6, dim);

    if (looksLikeUrl(s)) {
      addHashed(map, `pl:val_shape:${segmentType}:${keyToken}:url`, 1, dim);
    }
    if (looksLikePath(s)) {
      addHashed(map, `pl:val_shape:${segmentType}:${keyToken}:path`, 1, dim);
      const ext = extractExt(s);
      if (ext) addHashed(map, `pl:val_ext:${segmentType}:${keyToken}:${ext}`, 1, dim);
    }
    if (/^\d+$/.test(s)) {
      addHashed(map, `pl:val_shape:${segmentType}:${keyToken}:numstr`, 1, dim);
      addHashed(map, `pl:val_numlen:${segmentType}:${keyToken}:${bucketLength(s.length)}`, 0.8, dim);
    }
    if (s.length <= 24 && /^[a-z0-9_.:-]+$/i.test(s)) {
      addHashed(map, `pl:val_atom:${segmentType}:${keyToken}:${s.toLowerCase()}`, 0.7, dim);
    }
    return;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    addHashed(map, `pl:val_kind:${segmentType}:${keyToken}:num`, 1, dim);
    addHashed(map, `pl:val_num_bucket:${segmentType}:${keyToken}:${bucketLength(Math.abs(Math.floor(value)).toString().length)}`, 0.8, dim);
    return;
  }

  if (typeof value === 'boolean') {
    addHashed(map, `pl:val_kind:${segmentType}:${keyToken}:bool`, 1, dim);
    addHashed(map, `pl:val_bool:${segmentType}:${keyToken}:${value ? '1' : '0'}`, 0.8, dim);
    return;
  }

  if (Array.isArray(value)) {
    addHashed(map, `pl:val_kind:${segmentType}:${keyToken}:array`, 1, dim);
    addHashed(map, `pl:val_array_size:${segmentType}:${keyToken}:${bucketCount(value.length)}`, 0.8, dim);
    return;
  }

  if (value && typeof value === 'object') {
    addHashed(map, `pl:val_kind:${segmentType}:${keyToken}:object`, 1, dim);
    const size = Object.keys(value as Record<string, unknown>).length;
    addHashed(map, `pl:val_object_size:${segmentType}:${keyToken}:${bucketCount(size)}`, 0.8, dim);
    return;
  }

  addHashed(map, `pl:val_kind:${segmentType}:${keyToken}:other`, 1, dim);
}

function addPayloadFeatures(
  map: Map<number, number>,
  input: ActionFeatureInput,
  dim: number
): void {
  const payload = input.payload;
  if (!payload || typeof payload !== 'object') return;

  const format = payload.format === 'sentra_input_xml' ? 'sentra_input_xml' : 'plain_text';
  const canonical = String(payload.canonicalContent || '').trim();
  if (!canonical) return;

  addHashed(map, `pl:format:${format}`, 1, dim);
  addHashed(map, `pl:size:${bucketLength(canonical.length)}`, 0.7, dim);

  if (format === 'plain_text') {
    const plain = normalizeText(canonical, 512);
    const plainTokens = splitTokens(plain).slice(0, 24);
    addHashed(map, `pl:plain_tok:${bucketCount(plainTokens.length)}`, 0.6, dim);
    for (const token of plainTokens) {
      addHashed(map, `pl:plain_w:${token}`, 0.4, dim);
    }
    return;
  }

  const parsed = parseSentraInputPayload(canonical);
  if (!parsed) {
    addHashed(map, 'pl:xml_parse_failed', 1, dim);
    return;
  }

  addHashed(map, `pl:msg_count:${bucketCount(parsed.messageCount)}`, 0.8, dim);

  const uniqueChatTypes = new Set(parsed.chatTypes.map((v) => normalizeKey(v)));
  for (const chatType of uniqueChatTypes) {
    addHashed(map, `pl:chat_type:${chatType}`, 1, dim);
  }

  const uniqueRouteFlags = new Set(parsed.routeFlags.map((v) => normalizeKey(v)));
  for (const flag of uniqueRouteFlags) {
    addHashed(map, `pl:route:${flag}`, 1, dim);
  }

  const segTypeCount = new Map<string, number>();
  for (const seg of parsed.segments) {
    const segmentType = normalizeKey(seg.segmentType);
    segTypeCount.set(segmentType, (segTypeCount.get(segmentType) || 0) + 1);
    addHashed(map, `pl:seg_type:${segmentType}`, 1, dim);

    const entries = flattenDataEntries(seg.data);
    if (!entries.length) {
      addHashed(map, `pl:seg_data_empty:${segmentType}`, 0.8, dim);
      continue;
    }

    for (const entry of entries) {
      const key = normalizeKey(entry.key);
      addHashed(map, `pl:seg_key:${segmentType}:${key}`, 0.9, dim);
      addPayloadValueFeatures(map, segmentType, key, entry.value, dim);
    }
  }

  for (const [segType, count] of segTypeCount.entries()) {
    addHashed(map, `pl:seg_count:${segType}:${bucketCount(count)}`, 0.8, dim);
  }
}

function addMetaFeatures(
  map: Map<number, number>,
  input: ActionFeatureInput,
  text: string,
  tokens: string[],
  dim: number
): void {
  addHashed(map, `meta:chat:${input.chatType}`, 1, dim);
  addHashed(map, `meta:mentioned:${input.isMentioned ? '1' : '0'}`, 1, dim);
  addHashed(map, `meta:followup:${input.isFollowupAfterBotReply ? '1' : '0'}`, 1, dim);

  const activeTask = Number.isFinite(input.activeTaskCount) ? Math.max(0, Math.floor(input.activeTaskCount)) : 0;
  const activeBucket = activeTask >= 5 ? '5+' : String(activeTask);
  addHashed(map, `meta:active_task:${activeBucket}`, 1, dim);

  const textLen = text.length;
  const textBucket = textLen < 6 ? 'xs' : textLen < 20 ? 's' : textLen < 60 ? 'm' : textLen < 140 ? 'l' : 'xl';
  addHashed(map, `meta:text_len:${textBucket}`, 1, dim);

  const tokenLen = tokens.length;
  const tokenBucket = tokenLen < 3 ? 'xs' : tokenLen < 8 ? 's' : tokenLen < 16 ? 'm' : 'l';
  addHashed(map, `meta:token_len:${tokenBucket}`, 1, dim);

  const questionCount = (text.match(/[?]/g) || []).length;
  const exclamCount = (text.match(/[!]/g) || []).length;
  const digitCount = (text.match(/\d/g) || []).length;
  const punctCount = (text.match(/[,.!?;:]/g) || []).length;

  if (questionCount > 0) addHashed(map, 'meta:has_question', 1, dim);
  if (exclamCount > 0) addHashed(map, 'meta:has_exclaim', 1, dim);
  if (digitCount > 0) addHashed(map, 'meta:has_digit', 1, dim);
  if (punctCount > 0) addHashed(map, 'meta:has_punct', 1, dim);
}

function toSparseVector(map: Map<number, number>, dim: number): ActionFeatureVector {
  const entries = Array.from(map.entries()).filter((entry) => Number.isFinite(entry[1]) && entry[1] !== 0);
  entries.sort((a, b) => a[0] - b[0]);

  let norm2 = 0;
  for (const [, value] of entries) {
    norm2 += value * value;
  }
  const l2Norm = Math.sqrt(norm2);
  const scale = l2Norm > 0 ? 1 / l2Norm : 1;

  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, value] of entries) {
    indices.push(idx);
    values.push(value * scale);
  }

  return {
    version: 'v2_char_word_hash_payload_struct',
    dim,
    indices,
    values,
    l2Norm
  };
}

export class ActionFeatureExtractor {
  private readonly config: ActionLearnerConfig;

  constructor(config?: Partial<ActionLearnerConfig>) {
    this.config = { ...loadActionLearnerConfig(), ...(config || {}) };
  }

  build(input: ActionFeatureInput): ActionFeatureVector {
    const text = normalizeText(input.text, this.config.maxTextLength);
    const tokens = splitTokens(text);
    const map = new Map<number, number>();

    addCharNgrams(map, text, this.config.charNgramMin, this.config.charNgramMax, this.config.dim);
    addWordNgrams(map, tokens, this.config.wordNgramMin, this.config.wordNgramMax, this.config.dim);
    addMetaFeatures(map, input, text, tokens, this.config.dim);
    addPayloadFeatures(map, input, this.config.dim);

    return toSparseVector(map, this.config.dim);
  }
}
