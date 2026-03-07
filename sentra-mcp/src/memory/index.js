import { getRedis } from '../redis/client.js';
import { config } from '../config/index.js';
import logger from '../logger/index.js';
import { clip } from '../utils/text.js';
import { embedTexts } from '../openai/client.js';

const NS = 'sentra-mcp';
const PREFIX = config.memory.prefix || 'sentra_mcp_mem';
const K_DOC = (id) => `${PREFIX}_doc_${id}`;
const K_IDX_TOOL = (aiName) => `${PREFIX}_index_tool_${aiName}`;
const MEMORY_TOOL_TOP_K = 3;
const MEMORY_MIN_SCORE = 0.7;
const MEMORY_CANDIDATE_POOL = 200;
const MEMORY_ONLY_SUCCESSFUL = true;
const RS_INDEX = 'mem_idx';
const RS_DIM = 0;
const RS_ENABLED = false;
const RS_DISTANCE = 'COSINE';
const RS_M = 16;
const RS_EF_CONSTRUCTION = 200;

let rsCapability = 'unknown'; // 'available' | 'missing' | 'error'
let rsWarned = false;

function warnRediSearchOnce(message, meta = {}) {
  if (!rsWarned) {
    logger.warn?.(message, { label: 'MEM', ...meta });
    rsWarned = true;
    return;
  }
  logger.debug?.(message, { label: 'MEM', ...meta });
}

function now() {
  return Date.now();
}

function cosineSim(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i] || 0);
    const y = Number(b[i] || 0);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function genId(prefix) {
  return `${prefix}_${now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeText(value, maxChars = 1200) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

async function embedQuery(text) {
  const [vector] = await embedTexts({
    texts: [String(text || '')],
    apiKey: config.embedding.apiKey,
    baseURL: config.embedding.baseURL,
    model: config.embedding.model,
  });
  return Array.isArray(vector) ? vector : [];
}

function toFloat32Buffer(vector = []) {
  try {
    const f = new Float32Array(vector);
    return Buffer.from(f.buffer);
  } catch {
    return null;
  }
}

async function ensureRSIndex(dim) {
  if (!RS_ENABLED) return false;
  if (rsCapability === 'missing') return false;

  const redis = getRedis();
  try {
    try {
      await redis.call('FT.INFO', RS_INDEX);
      rsCapability = 'available';
      return true;
    } catch {
      // Create below.
    }

    const vectorDim = Number.isFinite(RS_DIM) && RS_DIM > 0 ? RS_DIM : (Number(dim) || 0);
    if (!vectorDim) {
      logger.warn?.('RediSearch index creation skipped due to invalid vector dimension.', {
        label: 'MEM',
        index: RS_INDEX
      });
      return false;
    }

    const metric = RS_DISTANCE;
    const m = RS_M;
    const efConstruction = RS_EF_CONSTRUCTION;
    const hashPrefix = `${PREFIX}_doc_`;

    await redis.call(
      'FT.CREATE', RS_INDEX,
      'ON', 'HASH',
      'PREFIX', '1', hashPrefix,
      'SCHEMA',
      'ns', 'TAG',
      'type', 'TAG',
      'aiName', 'TAG',
      'stepIndex', 'NUMERIC',
      'success', 'TAG',
      'embedding_bin', 'VECTOR', 'HNSW', '6',
      'TYPE', 'FLOAT32', 'DIM', String(vectorDim), 'DISTANCE_METRIC', metric, 'M', String(m), 'EF_CONSTRUCTION', String(efConstruction)
    );

    logger.info?.('RediSearch index created for memory retrieval.', {
      label: 'MEM',
      index: RS_INDEX,
      dim: vectorDim,
      metric
    });
    rsCapability = 'available';
    return true;
  } catch (error) {
    const msg = String(error?.message || error);
    if (msg.includes('unknown command') && msg.includes('FT.')) {
      rsCapability = 'missing';
      warnRediSearchOnce('RediSearch commands are unavailable; fallback to cosine search.', {
        index: RS_INDEX,
        error: msg
      });
    } else {
      rsCapability = 'error';
      logger.warn?.('RediSearch index ensure failed; fallback search will be used.', {
        label: 'MEM',
        index: RS_INDEX,
        error: msg
      });
    }
    return false;
  }
}

export async function upsertToolMemory({ runId, stepIndex, aiName, objective, reason, args, result, success }) {
  if (!config.memory.enable) return;
  if (!aiName) return;

  try {
    const redis = getRedis();
    const id = genId('tool');
    const argsPreview = clip(args || {});
    const resultPreview = clip(result && (result.data ?? result));
    const previewText = sanitizeText([
      `objective: ${String(objective || '')}`,
      `tool: ${String(aiName || '')}`,
      reason ? `reason: ${clip(reason)}` : '',
      `args: ${argsPreview}`,
      `result: ${resultPreview}`,
    ].filter(Boolean).join('\n'));

    const emb = await embedQuery(String(reason || objective || ''));

    await redis.hset(K_DOC(id), {
      ns: NS,
      type: 'tool',
      runId: String(runId || ''),
      stepIndex: String(stepIndex ?? -1),
      aiName: String(aiName || ''),
      objective: String(objective || ''),
      reason: String(reason || ''),
      text: previewText,
      args: JSON.stringify(args ?? {}),
      embedding: JSON.stringify(emb),
      ts: String(now()),
      success: success ? '1' : '0',
    });

    if (RS_ENABLED) {
      const buf = toFloat32Buffer(emb);
      if (buf) {
        try {
          await ensureRSIndex(emb.length);
          await redis.hset(K_DOC(id), { embedding_bin: buf });
        } catch (error) {
          logger.warn?.('Failed to store vector blob for RediSearch.', {
            label: 'MEM',
            error: String(error?.message || error)
          });
        }
      }
    }

    await redis.zadd(K_IDX_TOOL(aiName), now(), id);
    logger.debug?.('Memory upsert tool success.', { label: 'MEM', id, aiName, success: !!success });
  } catch (error) {
    logger.warn?.('Memory upsert tool failed.', { label: 'MEM', error: String(error?.message || error) });
  }
}

async function fetchDocs(redis, ids = []) {
  if (!ids.length) return [];
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(K_DOC(id));
  const result = await pipeline.exec();
  return result.map(([, value]) => value || {}).filter(Boolean);
}

function parseJsonSafely(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return undefined;
  }
}

function escapeTagValue(raw) {
  return String(raw || '').replace(/([\\{}|:])/g, '\\$1');
}

export async function searchToolMemories({
  objective,
  reason,
  aiName,
  topK = MEMORY_TOOL_TOP_K,
  minScore = MEMORY_MIN_SCORE
}) {
  if (!config.memory.enable) return [];
  if (!aiName) return [];

  try {
    const redis = getRedis();
    const queryVector = await embedQuery(String(reason || objective || ''));

    if (RS_ENABLED && rsCapability !== 'missing') {
      try {
        const ready = await ensureRSIndex(queryVector.length);
        if (ready && rsCapability === 'available') {
          const vectorBlob = toFloat32Buffer(queryVector);
          if (vectorBlob) {
            const k = Math.max(1, Number(topK || 3));
            const successFilter = MEMORY_ONLY_SUCCESSFUL ? ' @success:{1}' : '';
            const aiNameTag = escapeTagValue(aiName);
            const query = `@ns:{${NS}} @type:{tool} @aiName:{${aiNameTag}}${successFilter}=>[KNN ${k} embedding_bin $VEC AS score]`;
            const resp = await redis.call(
              'FT.SEARCH',
              RS_INDEX,
              query,
              'PARAMS', '2', 'VEC', vectorBlob,
              'SORTBY', 'score',
              'DIALECT', '2',
              'RETURN', '5', 'runId', 'text', 'args', 'stepIndex', 'success'
            );

            const output = [];
            for (let i = 2; i < resp.length; i += 2) {
              const fields = resp[i + 1];
              const obj = {};
              for (let j = 0; j < fields.length; j += 2) obj[fields[j]] = fields[j + 1];
              output.push({
                score: 0,
                runId: obj.runId,
                stepIndex: Number(obj.stepIndex || -1),
                success: String(obj.success || '') === '1',
                text: obj.text,
                args: parseJsonSafely(obj.args),
              });
            }
            return output.slice(0, k);
          }
        }
      } catch (error) {
        const msg = String(error?.message || error);
        if (msg.includes('unknown command') && msg.includes('FT.')) {
          rsCapability = 'missing';
          warnRediSearchOnce('RediSearch is unavailable during search; fallback path engaged.', { error: msg });
        } else {
          logger.warn?.('RediSearch query failed; fallback cosine search will run.', {
            label: 'MEM',
            error: msg
          });
        }
      }
    }

    const poolSize = Math.max(10, Number(MEMORY_CANDIDATE_POOL));
    const ids = await redis.zrevrange(K_IDX_TOOL(aiName), 0, poolSize - 1);
    const docs = await fetchDocs(redis, ids);

    const scored = [];
    for (const doc of docs) {
      if (doc?.type !== 'tool' || doc?.aiName !== aiName) continue;
      if (MEMORY_ONLY_SUCCESSFUL && doc?.success !== '1') continue;
      const vector = parseJsonSafely(doc.embedding) || [];
      const score = cosineSim(queryVector, vector);
      if (score >= (minScore ?? 0)) scored.push({ score, doc });
    }

    scored.sort((a, b) => b.score - a.score);
    const selected = scored.slice(0, Math.max(1, Number(topK || 3)));
    return selected.map(({ score, doc }) => ({
      score,
      runId: doc.runId,
      stepIndex: Number(doc.stepIndex || -1),
      success: doc.success === '1',
      text: doc.text,
      args: parseJsonSafely(doc.args),
    }));
  } catch (error) {
    logger.warn?.('Memory search tool failed.', { label: 'MEM', error: String(error?.message || error) });
    return [];
  }
}

export default {
  upsertToolMemory,
  searchToolMemories,
};
