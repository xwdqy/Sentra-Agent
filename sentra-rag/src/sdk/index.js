import { readFile } from 'node:fs/promises';

import { initDotenv } from '../config/dotenv.js';
import { getEnv, getEnvBoolean, getEnvNumber } from '../config/env.js';
import { loadContractPolicy } from '../contract/policy.js';
import { parseSentraContractXml } from '../contract/xml_parser.js';
import { normalizeMessagesToText } from '../messages/normalize.js';
import { createNeo4jClient } from '../neo4j/client.js';
import {
  buildContextText,
  dedupeByText,
  expandToParent,
  retrieveFulltext,
  retrieveVector,
} from '../neo4j/retrieval.js';
import { ensureNeo4jSchema } from '../neo4j/schema.js';
import { createOpenAIClient } from '../openai/client.js';
import { requestContractXml, requestContractXmlRepair } from '../openai/contract_call.js';
import { ingestContractToNeo4j } from '../pipelines/ingest.js';
import { queryWithNeo4j } from '../pipelines/query.js';
import { rerankDocuments } from '../rerank/index.js';

function previewText(text, maxChars = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '...';
}

function mergeByTextWithSources(items) {
  const seen = new Map();
  const out = [];
  for (const it of items) {
    const t = String(it?.text || '').trim();
    if (!t) continue;

    const existing = seen.get(t);
    if (existing) {
      const a = Array.isArray(existing.sources) ? existing.sources : [];
      const b = Array.isArray(it.sources) ? it.sources : [];
      existing.sources = Array.from(new Set([...a, ...b]));
      continue;
    }

    const next = { ...it };
    next.sources = Array.isArray(next.sources) ? Array.from(new Set(next.sources)) : [];
    seen.set(t, next);
    out.push(next);
  }
  return out;
}

async function requestAndParseContract(openai, policy, { task, queryText, contextText, documentText, lang }) {
  const xml = await requestContractXml(openai, policy, {
    task,
    queryText,
    contextText,
    documentText,
    lang,
  });

  let parsed = parseSentraContractXml(xml, { defaultTask: task });
  if (!parsed.ok) {
    const repaired = await requestContractXmlRepair(openai, policy, {
      badXml: xml,
      errorReport: parsed.error,
      lang,
    });
    parsed = parseSentraContractXml(repaired, { defaultTask: task });
  }

  if (!parsed.ok) {
    const e = new Error(parsed.error);
    e.xml = xml;
    throw e;
  }

  return parsed.value;
}

/**
 * 创建可复用的 RAG SDK。
 *
 * - 默认会加载 .env（等价于 dotenv/config）。
 * - 如需 .env 热更新：在 .env 里设置 RAG_ENV_WATCH=true 或 rag_ENV_WATCH=true。
 */
export async function createRagSdk({ lang, watchEnv } = {}) {
  initDotenv({ watch: watchEnv });

  const policy = await loadContractPolicy();
  const effectiveLang = lang || policy.lang || 'zh';

  const openai = createOpenAIClient();
  const neo4j = createNeo4jClient();

  let schemaEnsured = false;

  async function ensureSchemaIfNeeded(schemaFromContract) {
    if (schemaEnsured) return;
    await ensureNeo4jSchema(neo4j, schemaFromContract);
    schemaEnsured = true;
  }

  function readRetrieveDefaults() {
    return {
      fulltextLimit: getEnvNumber('RETRIEVE_FULLTEXT_LIMIT', { defaultValue: 10 }),
      vectorK: getEnvNumber('RETRIEVE_VECTOR_K', { defaultValue: 8 }),
      hybridKVector: getEnvNumber('RETRIEVE_HYBRID_K_VECTOR', { defaultValue: 8 }),
      hybridKFulltext: getEnvNumber('RETRIEVE_HYBRID_K_FULLTEXT', { defaultValue: 8 }),
      expandParent: getEnvBoolean('RETRIEVE_EXPAND_PARENT', { defaultValue: true }),
      budgetChars: getEnvNumber('RETRIEVE_BUDGET_CHARS', { defaultValue: 12000 }),
      rerankEnable: getEnvBoolean('RETRIEVE_RERANK_ENABLE', { defaultValue: true }),
      rerankCandidateK: getEnvNumber('RETRIEVE_RERANK_CANDIDATE_K', { defaultValue: 40 }),
      rerankTopN: getEnvNumber('RETRIEVE_RERANK_TOP_N', { defaultValue: 20 }),
      debug: getEnvBoolean('RETRIEVE_DEBUG', { defaultValue: false }),
    };
  }

  async function embedQuery(text) {
    const embeddingModel = getEnv('OPENAI_EMBEDDING_MODEL', { defaultValue: 'text-embedding-3-small' });
    const emb = await openai.embeddings.create({ model: embeddingModel, input: String(text ?? '') });
    const v = emb.data?.[0]?.embedding;
    if (!Array.isArray(v)) throw new Error('Embedding failed');
    return { embedding: v, embeddingModel };
  }

  async function rerankChunksByText(query, chunks, { candidateK = 40, topN = 20 } = {}) {
    const docs = chunks.map((c) => String(c?.text || '').trim());
    const pairs = docs.map((t, i) => ({ i, text: t })).filter((p) => p.text);

    if (!pairs.length) {
      return {
        chunks: [],
        stats: { rerankMode: 'none', candidateK: 0, topN: 0 },
        debug: { rerank: { mode: 'none', indices: [], scores: [] }, candidateDocs: [] },
      };
    }

    const Kraw = Number(candidateK);
    const K = !Number.isFinite(Kraw) || Kraw <= 0 ? pairs.length : Math.max(1, Math.min(Kraw, pairs.length));
    const topPairs = pairs.slice(0, K);
    const docTexts = topPairs.map((p) => p.text);

    const requestedTopN = Number(topN);
    const finalTopN = !Number.isFinite(requestedTopN) || requestedTopN <= 0 ? docTexts.length : Math.max(1, Math.min(requestedTopN, docTexts.length));

    const embeddingModel = getEnv('OPENAI_EMBEDDING_MODEL', { defaultValue: 'text-embedding-3-small' });
    const ranked = await rerankDocuments({
      query,
      documents: docTexts,
      openai,
      embeddingModel,
      topN: finalTopN,
      timeoutMs: Number(getEnv('RERANK_TIMEOUT_MS', { defaultValue: 12000 })),
      baseURL: getEnv('RERANK_BASE_URL', { defaultValue: undefined }),
      apiKey: getEnv('RERANK_API_KEY', { defaultValue: '' }),
      model: getEnv('RERANK_MODEL', { defaultValue: undefined }),
    });

    const idx = (ranked.indices || []).filter((x) => Number.isInteger(x) && x >= 0 && x < topPairs.length);
    const scores = idx.map((_, pos) => Number(ranked.scores?.[pos] ?? 0));

    const originalIndices = idx.map((j) => topPairs[j].i);
    const out = originalIndices.map((i) => chunks[i]).filter(Boolean);

    return {
      chunks: out,
      stats: {
        rerankMode: ranked.mode,
        candidateK: K,
        topN: out.length,
      },
      debug: {
        candidateDocs: topPairs.slice(0, 20).map((p) => ({ index: p.i, preview: previewText(p.text) })),
        rerank: {
          mode: ranked.mode,
          indices: originalIndices,
          scores,
        },
      },
    };
  }

  return {
    /**
     * 入库：给定纯文本，调用合约(ingest)→解析→确保 schema→写入 Neo4j（含 embedding）。
     */
    async ingestText(text, { docId, title, source, contextText } = {}) {
      const contract = await requestAndParseContract(openai, policy, {
        task: 'ingest',
        queryText: '',
        contextText: String(contextText ?? ''),
        documentText: String(text ?? ''),
        lang: effectiveLang,
      });

      await ensureSchemaIfNeeded(contract.neo4j_schema);
      return ingestContractToNeo4j(neo4j, openai, contract, { docId, title, source });
    },

    /**
     * 直接全文检索（不调用模型）。
     *
     * 用于：关键词检索、定位相关段落、做 UI 列表展示等。
     */
    async searchFulltext(query, { limit, indexName } = {}) {
      const contract = null;
      await ensureSchemaIfNeeded(contract?.neo4j_schema);
      const d = readRetrieveDefaults();
      const effLimit = limit ?? d.fulltextLimit;
      const fulltextIndex = indexName || getEnv('NEO4J_FULLTEXT_INDEX', { defaultValue: 'chunkText' });
      return retrieveFulltext(neo4j, fulltextIndex, query, Number(effLimit));
    },

    /**
     * 直接全文检索并拼接上下文（不调用模型）。
     *
     * - 可选：对命中的 child chunk 做 parent 扩展（更像“段落级”内容）
     * - 返回：chunks + contextText，便于你自己做后续处理（UI/规则/另一个系统）
     */
    async getContextFromFulltext(query, { limit, expandParent, budgetChars, indexName } = {}) {
      const d = readRetrieveDefaults();
      const effLimit = limit ?? d.fulltextLimit;
      const effExpandParent = expandParent ?? d.expandParent;
      const effBudgetChars = budgetChars ?? d.budgetChars;

      const hits = await this.searchFulltext(query, { limit: effLimit, indexName });
      const chunkIds = hits
        .filter((h) => Array.isArray(h.labels) && h.labels.includes('Chunk'))
        .map((h) => h.id)
        .filter(Boolean);

      const parentExpandedRaw = effExpandParent ? await expandToParent(neo4j, chunkIds) : [];
      const parentExpanded = parentExpandedRaw.map((c) => ({ ...c, sources: ['parent'] }));
      const fulltextChunks = hits.map((h) => ({ text: h.text || h.title || '', rawText: h.rawText, sources: ['fulltext'] }));
      const merged = mergeByTextWithSources([...parentExpanded, ...fulltextChunks]);

      return {
        chunks: merged,
        contextText: buildContextText(merged, Number(effBudgetChars)),
        stats: {
          fulltextHits: hits.length,
          parentExpanded: parentExpanded.length,
          mergedContextChunks: merged.length,
        },
        debug: {
          fulltextHits: hits.slice(0, 20).map((h) => ({
            id: h.id,
            labels: h.labels,
            segmentId: h.segmentId,
            score: h.score,
            preview: previewText(h.text || h.title),
          })),
          mergedChunks: merged.slice(0, 20).map((c) => ({
            chunkId: c.chunkId,
            segmentId: c.segmentId,
            name: c.name,
            chunkKey: c.chunkKey,
            level: c.level,
            sources: c.sources,
            preview: previewText(c.text),
          })),
        },
      };
    },

    /**
     * 直接向量检索（不调用模型生成答案，但需要 embedding）。
     */
    async searchVector(queryText, { k, indexName } = {}) {
      const contract = null;
      await ensureSchemaIfNeeded(contract?.neo4j_schema);

      const d = readRetrieveDefaults();
      const effK = k ?? d.vectorK;

      const kk = Math.floor(Number(effK));
      if (!Number.isFinite(kk) || kk <= 0) {
        return { hits: [], stats: { vectorHits: 0 }, debug: { indexName: indexName || null, topVector: [] } };
      }

      const { embedding } = await embedQuery(queryText);
      const vectorIndex = indexName || getEnv('NEO4J_VECTOR_INDEX', { defaultValue: 'chunkChildEmbedding' });
      const hits = await retrieveVector(neo4j, vectorIndex, embedding, kk);
      return {
        hits,
        stats: { vectorHits: hits.length },
        debug: {
          indexName: vectorIndex,
          topVector: hits.slice(0, 20).map((h) => ({
            chunkId: h.chunkId,
            segmentId: h.segmentId,
            score: h.score,
            chunkKey: h.chunkKey,
            preview: previewText(h.text),
          })),
        },
      };
    },

    /**
     * 向量检索 + parent 扩展 +（可选）重排序 + 拼接上下文（不调用模型生成答案）。
     */
    async getContextFromVector(
      queryText,
      {
        k,
        expandParent,
        budgetChars,
        rerank,
        candidateK,
        topN,
        indexName,
        debug,
      } = {}
    ) {
      const d = readRetrieveDefaults();
      const effK = k ?? d.vectorK;
      const effExpandParent = expandParent ?? d.expandParent;
      const effBudgetChars = budgetChars ?? d.budgetChars;
      const effRerank = rerank ?? d.rerankEnable;
      const effCandidateK = candidateK ?? d.rerankCandidateK;
      const effTopN = topN ?? d.rerankTopN;
      const effDebug = debug ?? d.debug;

      const vector = await this.searchVector(queryText, { k: effK, indexName });
      const hits = vector.hits;
      const parentExpandedRaw = effExpandParent ? await expandToParent(neo4j, hits.map((h) => h.chunkId).filter(Boolean)) : [];
      const parentExpanded = parentExpandedRaw.map((c) => ({ ...c, sources: ['parent'] }));
      const vectorChunks = hits.map((h) => ({ ...h, sources: ['vector'] }));

      const merged = mergeByTextWithSources([
        ...parentExpanded,
        ...vectorChunks,
      ]);

      let ordered = merged;
      let rerankStats = { rerankMode: 'none', candidateK: 0, topN: 0 };
      let rerankDebug = null;
      if (effRerank) {
        const r = await rerankChunksByText(String(queryText ?? ''), merged, { candidateK: effCandidateK, topN: effTopN });
        if (r.chunks.length) {
          ordered = r.chunks;
          rerankStats = r.stats;
          rerankDebug = r.debug;
        }
      }

      const contextText = buildContextText(ordered, Number(effBudgetChars));
      return {
        chunks: ordered,
        contextText,
        stats: {
          vectorHits: hits.length,
          parentExpanded: parentExpanded.length,
          mergedContextChunks: merged.length,
          contextChars: contextText.length,
          ...rerankStats,
        },
        debug: effDebug
          ? {
              vector: vector.debug,
              mergedChunks: merged.slice(0, 30).map((c) => ({
                chunkId: c.chunkId,
                segmentId: c.segmentId,
                name: c.name,
                chunkKey: c.chunkKey,
                level: c.level,
                sources: c.sources,
                preview: previewText(c.text),
              })),
              rerank: rerankDebug,
              finalChunks: ordered.slice(0, 30).map((c) => ({
                chunkId: c.chunkId,
                segmentId: c.segmentId,
                name: c.name,
                chunkKey: c.chunkKey,
                level: c.level,
                sources: c.sources,
                preview: previewText(c.text),
              })),
            }
          : undefined,
      };
    },

    /**
     * 混合检索（向量 + 全文）并可选重排序（不调用模型生成答案）。
     */
    async getContextHybrid(
      queryText,
      {
        kVector,
        kFulltext,
        expandParent,
        budgetChars,
        rerank,
        candidateK,
        topN,
        vectorIndexName,
        fulltextIndexName,
        debug,
      } = {}
    ) {
      const d = readRetrieveDefaults();
      const effKVector = kVector ?? d.hybridKVector;
      const effKFulltext = kFulltext ?? d.hybridKFulltext;
      const effExpandParent = expandParent ?? d.expandParent;
      const effBudgetChars = budgetChars ?? d.budgetChars;
      const effRerank = rerank ?? d.rerankEnable;
      const effCandidateK = candidateK ?? d.rerankCandidateK;
      const effTopN = topN ?? d.rerankTopN;
      const effDebug = debug ?? d.debug;

      const vector = await this.searchVector(queryText, { k: effKVector, indexName: vectorIndexName });
      const vectorHits = vector.hits;
      const fulltextHits = await this.searchFulltext(queryText, { limit: effKFulltext, indexName: fulltextIndexName });

      const chunkIds = vectorHits.map((h) => h.chunkId).filter(Boolean);
      const parentExpandedRaw = effExpandParent ? await expandToParent(neo4j, chunkIds) : [];
      const parentExpanded = parentExpandedRaw.map((c) => ({ ...c, sources: ['parent'] }));
      const vectorChunks = vectorHits.map((h) => ({ ...h, sources: ['vector'] }));
      const fulltextChunks = fulltextHits.map((h) => ({ text: h.text || h.title || '', rawText: h.rawText, sources: ['fulltext'] }));

      const merged = mergeByTextWithSources([
        ...parentExpanded,
        ...vectorChunks,
        ...fulltextChunks,
      ]);

      let ordered = merged;
      let rerankStats = { rerankMode: 'none', candidateK: 0, topN: 0 };
      let rerankDebug = null;
      if (effRerank) {
        const r = await rerankChunksByText(String(queryText ?? ''), merged, { candidateK: effCandidateK, topN: effTopN });
        if (r.chunks.length) {
          ordered = r.chunks;
          rerankStats = r.stats;
          rerankDebug = r.debug;
        }
      }

      const contextText = buildContextText(ordered, Number(effBudgetChars));
      return {
        chunks: ordered,
        contextText,
        stats: {
          vectorHits: vectorHits.length,
          fulltextHits: fulltextHits.length,
          parentExpanded: parentExpanded.length,
          mergedContextChunks: merged.length,
          contextChars: contextText.length,
          ...rerankStats,
        },
        debug: effDebug
          ? {
              vector: vector.debug,
              fulltextHits: fulltextHits.slice(0, 20).map((h) => ({
                id: h.id,
                labels: h.labels,
                segmentId: h.segmentId,
                score: h.score,
                preview: previewText(h.text || h.title),
              })),
              mergedChunks: merged.slice(0, 30).map((c) => ({
                chunkId: c.chunkId,
                segmentId: c.segmentId,
                name: c.name,
                chunkKey: c.chunkKey,
                level: c.level,
                sources: c.sources,
                preview: previewText(c.text),
              })),
              rerank: rerankDebug,
              finalChunks: ordered.slice(0, 30).map((c) => ({
                chunkId: c.chunkId,
                segmentId: c.segmentId,
                name: c.name,
                chunkKey: c.chunkKey,
                level: c.level,
                sources: c.sources,
                preview: previewText(c.text),
              })),
            }
          : undefined,
      };
    },

    /**
     * 入库：从文件读取文本并 ingest。
     */
    async ingestFile(filePath, { docId, title, source } = {}) {
      const text = await readFile(filePath, 'utf8');
      return this.ingestText(text, { docId, title, source: source ?? filePath });
    },

    /**
     * 检索问答：给定 OpenAI messages（content 可为 string 或多段数组），自动抽取 query/context。
     */
    async queryMessages(messages, { lang } = {}) {
      const { queryText, contextText } = normalizeMessagesToText(messages);
      return this.queryText(queryText, { contextText, lang });
    },

    /**
     * 检索问答：给定 queryText/contextText，执行 query 合约→确保 schema→检索→生成答案。
     */
    async queryText(queryText, { contextText = '', lang } = {}) {
      const qLang = lang || effectiveLang;
      const contract = await requestAndParseContract(openai, policy, {
        task: 'query',
        queryText: String(queryText ?? ''),
        contextText: String(contextText ?? ''),
        documentText: '',
        lang: qLang,
      });

      await ensureSchemaIfNeeded(contract.neo4j_schema);
      return queryWithNeo4j(neo4j, openai, policy, contract, {
        queryText: String(queryText ?? ''),
        contextText: String(contextText ?? ''),
        lang: qLang,
      });
    },

    /**
     * 释放资源。
     */
    async close() {
      await neo4j.close();
    },

    /**
     * 暴露底层客户端，方便高级扩展（可选使用）。
     */
    clients: {
      neo4j,
      openai,
    },

    policy,
  };
}
