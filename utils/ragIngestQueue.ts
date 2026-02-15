import { createLogger } from './logger.js';
import { createRagSdk, getRagEnvNumber } from 'sentra-rag';

const logger = createLogger('RagIngestQueue');

type RagSdk = {
  ingestText: (text: string, opts: { docId: string; title?: string; source?: string; contextText?: string }) => Promise<unknown>;
};

type RagEnvNumber = (key: string, fallback: number) => number;

const ragSdkCreator: () => Promise<RagSdk> = createRagSdk as () => Promise<RagSdk>;
const ragEnvNumber: RagEnvNumber = getRagEnvNumber as RagEnvNumber;

type RagIngestJob = {
  text?: string | undefined;
  docId?: string | undefined;
  title?: string | undefined;
  source?: string | undefined;
  contextText?: string | undefined;
};

function serializeRagError(err: unknown): Record<string, unknown> {
  try {
    const e = err && typeof err === 'object' ? (err as Record<string, unknown>) : { message: String(err) };
    const status = e['status'] ?? e['statusCode'] ?? e['code'] ?? null;
    const name = e['name'] ?? null;
    const message = e['message'] ?? String(err);
    const requestId = e['request_id'] ?? e['requestId'] ?? null;
    const innerError = e['error'] && typeof e['error'] === 'object' ? (e['error'] as Record<string, unknown>) : null;
    const type = e['type'] ?? (innerError ? innerError['type'] : null);
    const errorMessage = innerError ? innerError['message'] : null;
    const errorParam = innerError ? innerError['param'] : null;
    const errorCode = innerError ? innerError['code'] : null;
    const response = e['response'] && typeof e['response'] === 'object' ? (e['response'] as Record<string, unknown>) : null;
    const body = (response ? response['data'] : null) ?? e['body'] ?? null;
    return {
      name,
      status,
      message,
      requestId,
      type,
      errorMessage,
      errorParam,
      errorCode,
      body,
    };
  } catch {
    return { message: String(err) };
  }
}

function takePrefix(text: string, count: number): string {
  if (!text || count <= 0) return '';
  let out = '';
  const max = Math.min(text.length, count);
  for (let i = 0; i < max; i++) {
    out += text[i] || '';
  }
  return out;
}

function sanitizeIngestText(rawText: unknown): string {
  const text = String(rawText ?? '');
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const maxCharsRaw = ragEnvNumber('INGEST_MAX_CHARS', 50000);
  const maxChars = Number.isFinite(maxCharsRaw) && maxCharsRaw > 0 ? maxCharsRaw : 0;
  if (maxChars > 0 && cleaned.length > maxChars) {
    return takePrefix(cleaned, maxChars);
  }
  return cleaned;
}

const queue: RagIngestJob[] = [];
let running = false;

let ragSdkPromise: Promise<RagSdk> | null = null;
async function getRagSdk(): Promise<RagSdk> {
  if (!ragSdkPromise) {
    ragSdkPromise = ragSdkCreator().catch((e) => {
      ragSdkPromise = null;
      throw e;
    });
  }
  return ragSdkPromise;
}

async function runLoop() {
  if (running) return;
  running = true;

  try {
    logger.info('RAG 入库队列开始消费', { pending: queue.length });
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) continue;

      const text = String(job.text || '').trim();
      const docId = String(job.docId || '').trim();
      const title = String(job.title || '').trim();
      const source = String(job.source || '').trim();
      const contextText = typeof job.contextText === 'string' ? job.contextText : '';

      if (!text || !docId) {
        logger.warn('RAG 入库任务缺少 text/docId，已跳过', { docId: docId || '', hasText: !!text });
        continue;
      }

      try {
        logger.info('RAG 入库处理中', { docId, remaining: queue.length });
        const rag = await getRagSdk();
        const safeText = sanitizeIngestText(text);
        if (safeText.length !== text.length) {
          logger.info('RAG 入库文本已清洗/截断', { docId, beforeChars: text.length, afterChars: safeText.length });
        }
        await rag.ingestText(safeText, {
          docId,
          title: title || docId,
          source: source || 'sentra_chat',
          contextText,
        });
        logger.info('RAG 入库完成', { docId });
      } catch (e) {
        logger.warn('RAG 入库失败（已忽略）', { docId, err: serializeRagError(e) });
      }
    }
  } finally {
    running = false;
  }
}

export function enqueueRagIngest({ text, docId, title, source, contextText }: RagIngestJob = {}) {
  queue.push({ text, docId, title, source, contextText });
  logger.info('RAG 入库任务入队', { docId: String(docId || ''), pending: queue.length });
  if (!running) {
    setTimeout(() => {
      runLoop().catch((e) => {
        logger.warn('RAG 入库队列运行异常（已忽略）', { err: String(e) });
      });
    }, 0);
  }
}
