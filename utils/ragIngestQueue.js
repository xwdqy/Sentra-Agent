import { createLogger } from './logger.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRagSdk } from 'sentra-rag';

import { loadEnv } from './envHotReloader.js';

const logger = createLogger('RagIngestQueue');

const queue = [];
let running = false;

let ragEnvLoaded = false;
function ensureRagEnvLoaded() {
  if (ragEnvLoaded) return;
  ragEnvLoaded = true;
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const ragEnvPath = path.resolve(__dirname, '..', 'sentra-rag', '.env');
    loadEnv(ragEnvPath);
  } catch {}
}

let ragSdkPromise = null;
async function getRagSdk() {
  if (!ragSdkPromise) {
    ensureRagEnvLoaded();
    ragSdkPromise = createRagSdk({ watchEnv: false }).catch((e) => {
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
        await rag.ingestText(text, {
          docId,
          title: title || docId,
          source: source || 'sentra_chat',
          contextText,
        });
        logger.info('RAG 入库完成', { docId });
      } catch (e) {
        logger.warn('RAG 入库失败（已忽略）', { docId, err: String(e) });
      }
    }
  } finally {
    running = false;
  }
}

export function enqueueRagIngest({ text, docId, title, source, contextText } = {}) {
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
