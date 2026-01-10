import { requestContractXml } from '../openai/contract_call.js';
import { getEnv } from '../config/env.js';
import { rerankDocuments } from '../rerank/index.js';

function cosineSafeScore(score) {
  // Neo4j vector similarity yields [0..1] for cosine
  const s = Number(score);
  if (!Number.isFinite(s)) return 0;
  return Math.max(0, Math.min(1, s));
}

function luceneEscapeTerm(term) {
  // Escape Lucene special characters in a single token.
  // Ref: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
  return String(term).replace(/[+\-!(){}\[\]^"~*?:\\/]|&&|\|\|/g, (m) => `\\${m}`);
}

function normalizeFulltextInput(queryText) {
  // Keep it generic: only remove control characters (incl. newlines/tabs) and trim.
  // Avoid maintaining a punctuation blacklist.
  return String(queryText ?? '').replace(/[\p{C}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeForFulltext(text) {
  const input = String(text ?? '').trim();
  if (!input) return [];

  // Best practice (Node 18+ / modern JS): use Intl.Segmenter when available.
  // It handles many languages more gracefully than punctuation stripping.
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
    const out = [];
    for (const s of seg.segment(input)) {
      if (!s.isWordLike) continue;
      const w = String(s.segment).trim();
      if (w) out.push(w);
    }
    return out;
  }

  // Fallback: extract “word-like” sequences via Unicode properties.
  // Includes letters/numbers and a few connector characters common in ids/versions.
  return input.match(/[\p{L}\p{N}][\p{L}\p{N}_@.\-]{1,}/gu) ?? [];
}

function toFulltextQuery(queryText, { maxTerms = 12 } = {}) {
  const raw = normalizeFulltextInput(queryText);
  if (!raw) return '';

  const tokens = tokenizeForFulltext(raw)
    .map((t) => String(t).trim())
    .filter(Boolean)
    .filter((t) => t.length >= 2);

  // De-dupe while preserving order
  const seen = new Set();
  const uniq = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
    if (uniq.length >= maxTerms) break;
  }

  if (!uniq.length) {
    // Always-safe fallback: phrase query (escape backslash + quote)
    const phrase = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${phrase}"`;
  }

  // OR query gives recall; AND tends to be too strict for Chinese.
  return uniq.map(luceneEscapeTerm).join(' OR ');
}

async function retrieveVector(neo4j, indexName, embedding, k) {
  const kk = Math.floor(Number(k));
  if (!Number.isFinite(kk) || kk <= 0) return [];
  const res = await neo4j.run(
    `CALL db.index.vector.queryNodes($indexName, $k, $embedding) YIELD node, score
     RETURN node.chunkId AS chunkId,
            node.segmentId AS segmentId,
            node.name AS name,
            node.chunkKey AS chunkKey,
            node.text AS text,
            node.rawText AS rawText,
            node.level AS level,
            score`,
    { indexName, k: kk, embedding }
  );
  return res.records.map((r) => ({
    chunkId: r.get('chunkId'),
    segmentId: r.get('segmentId'),
    name: r.get('name'),
    chunkKey: r.get('chunkKey'),
    text: r.get('text'),
    rawText: r.get('rawText'),
    level: r.get('level'),
    score: cosineSafeScore(r.get('score')),
  }));
}

async function retrieveFulltext(neo4j, indexName, query, limit) {
  const safeQuery = toFulltextQuery(query);
  if (!safeQuery) return [];
  const lim = Math.floor(Number(limit));
  if (!Number.isFinite(lim) || lim <= 0) return [];
  const res = await neo4j.run(
    `CALL db.index.fulltext.queryNodes($indexName, $query, {limit: $limit}) YIELD node, score
     RETURN coalesce(node.chunkId, node.docId) AS id,
            labels(node) AS labels,
            node.segmentId AS segmentId,
            coalesce(node.name, node.title, node.docId, node.chunkId) AS name,
            node.text AS text,
            node.rawText AS rawText,
            node.title AS title,
            score`,
    { indexName, query: safeQuery, limit: lim }
  );
  return res.records.map((r) => ({
    id: r.get('id'),
    labels: r.get('labels'),
    segmentId: r.get('segmentId'),
    name: r.get('name'),
    text: r.get('text'),
    rawText: r.get('rawText'),
    title: r.get('title'),
    score: Number(r.get('score')),
  }));
}

async function expandToParent(neo4j, chunkIds) {
  if (!chunkIds.length) return [];
  const res = await neo4j.run(
    `MATCH (c:Chunk)
     WHERE c.chunkId IN $chunkIds
     OPTIONAL MATCH (c)<-[:HAS_CHILD]-(p:Chunk)
     WITH coalesce(p, c) AS ctx
     RETURN DISTINCT ctx.chunkId AS chunkId,
                     ctx.segmentId AS segmentId,
                     ctx.name AS name,
                     ctx.chunkKey AS chunkKey,
                     ctx.text AS text,
                     ctx.rawText AS rawText,
                     ctx.level AS level`,
    { chunkIds }
  );
  return res.records.map((r) => ({
    chunkId: r.get('chunkId'),
    segmentId: r.get('segmentId'),
    name: r.get('name'),
    chunkKey: r.get('chunkKey'),
    text: r.get('text'),
    rawText: r.get('rawText'),
    level: r.get('level'),
  }));
}

function dedupeByText(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const t = String(it.text || '').trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(it);
  }
  return out;
}

function buildContextText(chunks, budgetChars = 12000) {
  let out = '';
  for (const c of chunks) {
    const piece = String(c.rawText || c.text || '').trim();
    if (!piece) continue;
    if (out.length + piece.length + 2 > budgetChars) break;
    out += piece + '\n\n';
  }
  return out.trim();
}

async function rerankChunks(openai, queryText, chunks, { candidateK = 40, topN = 40 } = {}) {
  const docs = chunks.map((c) => String(c?.text || '').trim());
  const pairs = docs.map((t, i) => ({ i, text: t })).filter((p) => p.text);
  if (!pairs.length) return { chunks, stats: { rerankMode: 'none' } };

  const Kraw = Number(candidateK);
  const K = !Number.isFinite(Kraw) || Kraw <= 0 ? pairs.length : Math.max(1, Math.min(Kraw, pairs.length));
  const topPairs = pairs.slice(0, K);
  const docTexts = topPairs.map((p) => p.text);

  const requestedTopN = Number(topN);
  const finalTopN = !Number.isFinite(requestedTopN) || requestedTopN <= 0 ? docTexts.length : Math.max(1, Math.min(requestedTopN, docTexts.length));

  const embeddingModel = getEnv('OPENAI_EMBEDDING_MODEL', { defaultValue: 'text-embedding-3-small' });
  const ranked = await rerankDocuments({
    query: String(queryText ?? ''),
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
  const out = idx.map((j) => chunks[topPairs[j].i]).filter(Boolean);
  return { chunks: out.length ? out : chunks, stats: { rerankMode: ranked.mode, rerankTopN: out.length } };
}

export async function queryWithNeo4j(neo4j, openai, policy, contract, { queryText, contextText, lang }) {
  const plan = contract.retrieval_plan;
  const vectorIndex = getEnv('NEO4J_VECTOR_INDEX', { defaultValue: 'chunkChildEmbedding' });
  const fulltextIndex = getEnv('NEO4J_FULLTEXT_INDEX', { defaultValue: 'chunkText' });

  const kVectorRaw = Number(plan?.parameters?.k_vector ?? 8);
  const kFulltext = Number(plan?.parameters?.k_fulltext ?? 8);
  const tokenBudget = Number(plan?.parameters?.token_budget ?? 2500);
  const kVector = Math.floor(kVectorRaw);

  let vectorHits = [];
  if (Number.isFinite(kVector) && kVector > 0) {
    // Embedding
    const embeddingModel = getEnv('OPENAI_EMBEDDING_MODEL', { defaultValue: 'text-embedding-3-small' });
    const emb = await openai.embeddings.create({ model: embeddingModel, input: queryText });
    const queryEmbedding = emb.data?.[0]?.embedding;
    if (!Array.isArray(queryEmbedding)) throw new Error('Embedding failed');

    // Vector index is built on :ChunkChild(embedding), so results should always be child chunks.
    vectorHits = await retrieveVector(neo4j, vectorIndex, queryEmbedding, kVector);
  }
  const fulltextHits = await retrieveFulltext(neo4j, fulltextIndex, queryText, kFulltext);

  const parentExpanded = await expandToParent(neo4j, vectorHits.map((h) => h.chunkId).filter(Boolean));

  const merged = dedupeByText([
    ...parentExpanded,
    ...vectorHits,
    ...fulltextHits.map((h) => ({ text: h.text || h.title || '', rawText: h.rawText })),
  ]);

  const enableRerank = String(getEnv('RERANK_ENABLE', { defaultValue: 'true' })).toLowerCase() !== 'false';
  const candidateK = Number(getEnv('RERANK_CANDIDATE_K', { defaultValue: 40 }));
  const topN = Number(getEnv('RERANK_TOP_N', { defaultValue: 40 }));
  const reranked = enableRerank ? await rerankChunks(openai, queryText, merged, { candidateK, topN }) : { chunks: merged, stats: { rerankMode: 'disabled' } };

  const budgetChars = Math.max(4000, Math.floor(tokenBudget * 4));
  const context = buildContextText(reranked.chunks, budgetChars);

  // Ask model for final answer using the same contract policy but task=query
  const xml = await requestContractXml(openai, policy, {
    task: 'query',
    queryText,
    contextText: [contextText, '---', context].filter(Boolean).join('\n'),
    documentText: '',
    lang,
  });

  return {
    xml,
    stats: {
      vectorHits: vectorHits.length,
      fulltextHits: fulltextHits.length,
      parentExpanded: parentExpanded.length,
      mergedContextChunks: merged.length,
      contextChars: context.length,
      rerankMode: reranked.stats?.rerankMode,
      samples: {
        topVector: vectorHits.slice(0, 5).map((h) => ({ chunkId: h.chunkId, segmentId: h.segmentId, score: h.score })),
        topFulltext: fulltextHits.slice(0, 5).map((h) => ({ id: h.id, segmentId: h.segmentId, score: h.score })),
      },
    },
  };
}
