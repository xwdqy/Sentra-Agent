function cosineSafeScore(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return 0;
  return Math.max(0, Math.min(1, s));
}

function luceneEscapeTerm(term) {
  return String(term).replace(/[+\-!(){}\[\]^"~*?:\\/]|&&|\|\|/g, (m) => `\\${m}`);
}

function normalizeFulltextInput(queryText) {
  return String(queryText ?? '').replace(/[\p{C}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeForFulltext(text) {
  const input = String(text ?? '').trim();
  if (!input) return [];

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

  return input.match(/[\p{L}\p{N}][\p{L}\p{N}_@.\-]{1,}/gu) ?? [];
}

export function toFulltextQuery(queryText, { maxTerms = 12 } = {}) {
  const raw = normalizeFulltextInput(queryText);
  if (!raw) return '';

  const tokens = tokenizeForFulltext(raw)
    .map((t) => String(t).trim())
    .filter(Boolean)
    .filter((t) => t.length >= 2);

  const seen = new Set();
  const uniq = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
    if (uniq.length >= maxTerms) break;
  }

  if (!uniq.length) {
    const phrase = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${phrase}"`;
  }

  return uniq.map(luceneEscapeTerm).join(' OR ');
}

export async function retrieveVector(neo4j, indexName, embedding, k) {
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

export async function retrieveFulltext(neo4j, indexName, query, limit) {
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

export async function expandToParent(neo4j, chunkIds) {
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

export function dedupeByText(items) {
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

export function buildContextText(chunks, budgetChars = 12000) {
  let out = '';
  for (const c of chunks) {
    const piece = String(c.rawText || c.text || '').trim();
    if (!piece) continue;
    if (out.length + piece.length + 2 > budgetChars) break;
    out += piece + '\n\n';
  }
  return out.trim();
}
