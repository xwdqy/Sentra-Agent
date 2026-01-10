import { randomUUID, createHash } from 'node:crypto';
import { getEnv } from '../config/env.js';

function nowIso() {
  return new Date().toISOString();
}

function sha1Hex(value) {
  return createHash('sha1').update(String(value ?? '')).digest('hex');
}

function normalizeName(x) {
  return String(x ?? '').trim();
}

function normalizeSegmentId(segmentId, fallbackValue) {
  const s = String(segmentId ?? '').trim();
  return s || String(fallbackValue ?? '').trim();
}

function makeChunkKey(docId, segmentId) {
  return `${String(docId)}:${String(segmentId)}`;
}

function getEntityKey(obj) {
  if (!obj) return { type: 'OTHER', canonical: '' };
  if (typeof obj === 'string') return { type: 'OTHER', canonical: normalizeName(obj) };
  const type = normalizeName(obj.type) || 'OTHER';
  const canonical = normalizeName(obj.canonical_name ?? obj.canonicalName ?? obj.name);
  return { type, canonical };
}

async function linkEntityByTextFallback(neo4j, docId, entityId, names) {
  const cleaned = names.map(normalizeName).filter(Boolean);
  if (!cleaned.length) return 0;

  // Try to find a chunk that contains the entity mention.
  for (const n of cleaned) {
    const res = await neo4j.run(
      `MATCH (c:Chunk {docId: $docId})
       WHERE coalesce(c.rawText, c.text) CONTAINS $name
       WITH c ORDER BY size(coalesce(c.rawText, c.text)) ASC
       LIMIT 1
       MATCH (en:Entity {entityId: $entityId})
       MERGE (c)-[r:HAS_ENTITY]->(en)
       ON CREATE SET r.confidence = 0.3, r.quote = $name
       RETURN count(r) AS linked`,
      { docId, entityId, name: n }
    );
    const linked = Number(res.records?.[0]?.get('linked') ?? 0);
    if (linked > 0) return 1;
  }
  return 0;
}

function slugId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function stableId(prefix, value) {
  const h = sha1Hex(value).slice(0, 24);
  return `${prefix}_${h}`;
}

function sliceRawSpan(documentText, startChar, endChar) {
  const text = String(documentText ?? '');
  const s = Number(startChar);
  const e = Number(endChar);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '';
  if (s < 0 || e <= s) return '';
  const ss = Math.max(0, Math.min(s, text.length));
  const ee = Math.max(0, Math.min(e, text.length));
  if (ee <= ss) return '';
  return text.slice(ss, ee).trim();
}

async function embedTexts(openai, texts) {
  const model = getEnv('OPENAI_EMBEDDING_MODEL', { defaultValue: 'text-embedding-3-small' });
  const resp = await openai.embeddings.create({ model, input: texts });
  const data = resp?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error('Embedding response size mismatch');
  }
  return data.map((d) => d.embedding);
}

function fallbackSegmentsFromText(documentText) {
  const text = String(documentText ?? '').trim();
  if (!text) return { parents: [], children: [] };

  // Simple paragraph-based parents, fixed-size children.
  const paras = text.split(/\n\s*\n+/g).map((p) => p.trim()).filter(Boolean);
  const parents = [];
  const children = [];

  let cursor = 0;
  const parentTexts = paras.length ? paras : [text];
  for (let i = 0; i < parentTexts.length; i++) {
    const pText = parentTexts[i];
    const startChar = text.indexOf(pText, cursor);
    const start = startChar >= 0 ? startChar : cursor;
    const end = start + pText.length;
    cursor = end;

    const pSeg = `p_${i}`;
    parents.push({ segment_id: pSeg, text: pText, start_char: start, end_char: end });

    const childSize = 600;
    const overlap = 80;
    let childIndex = 0;
    for (let off = 0; off < pText.length; off += childSize - overlap) {
      const slice = pText.slice(off, off + childSize).trim();
      if (!slice) continue;
      const cStart = start + off;
      const cEnd = Math.min(start + off + slice.length, end);
      children.push({
        segment_id: `c_${i}_${childIndex++}`,
        parent_id: pSeg,
        text: slice,
        start_char: cStart,
        end_char: cEnd,
      });
    }
  }

  return { parents, children };
}

export async function ingestContractToNeo4j(neo4j, openai, contract, { docId, title, source } = {}) {
  const documentText = contract?.normalized_input?.document_text || '';
  let parents = contract?.segments?.parent || [];
  let children = contract?.segments?.child || [];
  const entities = contract?.extraction?.entities || [];
  const relations = contract?.extraction?.relations || [];

  if ((!Array.isArray(parents) || parents.length === 0) && (!Array.isArray(children) || children.length === 0) && String(documentText || '').trim()) {
    const fb = fallbackSegmentsFromText(documentText);
    parents = fb.parents;
    children = fb.children;
  }

  const finalDocId = docId || stableId('doc', `${title ?? ''}|${source ?? ''}|${sha1Hex(documentText)}`);

  await neo4j.run(
    `MERGE (d:Document {docId: $docId})
     SET d.title = coalesce($title, d.title),
         d.source = coalesce($source, d.source),
         d.text = coalesce($text, d.text),
         d.name = coalesce($name, d.name),
         d.id = $docId,
         d.updatedAt = $now,
         d.createdAt = coalesce(d.createdAt, $now)
     RETURN d`,
    {
      docId: finalDocId,
      title: title || null,
      source: source || null,
      text: documentText || null,
      name: title || source || finalDocId,
      now: nowIso(),
    }
  );

  const parentIdBySegment = new Map();
  const childChunkIdBySegment = new Map();
  const parentChunkIdBySegment = new Map();
  let entityLinks = 0;
  let relationLinks = 0;

  let parentIndex = 0;
  for (const p of parents) {
    const segmentId = normalizeSegmentId(p.segment_id, `p_${parentIndex++}`);
    const chunkId = stableId('chunk', `${finalDocId}|${segmentId}`);
    const chunkKey = makeChunkKey(finalDocId, segmentId);
    const text = p.text || '';
    const rawText = sliceRawSpan(documentText, p.start_char ?? 0, p.end_char ?? 0);

    parentIdBySegment.set(p.segment_id, chunkId);
    parentChunkIdBySegment.set(String(segmentId), chunkId);

    await neo4j.run(
      `MATCH (d:Document {docId: $docId})
       MERGE (c:Chunk {chunkId: $chunkId})
       SET c:ChunkParent,
           c.level = 'parent',
           c.docId = $docId,
           c.segmentId = $segmentId,
           c.text = $text,
           c.rawText = $rawText,
           c.textHash = $textHash,
           c.rawTextHash = $rawTextHash,
           c.chunkKey = $chunkKey,
           c.name = $name,
           c.id = $chunkId,
           c.startChar = $startChar,
           c.endChar = $endChar,
           c.updatedAt = $now,
           c.createdAt = coalesce(c.createdAt, $now)
       MERGE (d)-[:HAS_CHUNK]->(c)
       MERGE (c)-[:PART_OF]->(d)`,
      {
        docId: finalDocId,
        chunkId,
        segmentId,
        text,
        rawText,
        textHash: sha1Hex(text),
        rawTextHash: sha1Hex(rawText),
        chunkKey,
        name: segmentId,
        startChar: Number(p.start_char ?? 0),
        endChar: Number(p.end_char ?? 0),
        now: nowIso(),
      }
    );
  }

  const childRows = [];

  const seenChildHashes = new Set();
  const seenChildChunkIds = new Set();
  let childIndex = 0;
  for (const c of children) {
    const parentChunkId = parentIdBySegment.get(c.parent_id);
    if (!parentChunkId) continue;

    const segmentId = normalizeSegmentId(c.segment_id, `c_${childIndex++}`);
    const chunkId = stableId('chunk', `${finalDocId}|${segmentId}`);
    const chunkKey = makeChunkKey(finalDocId, segmentId);
    const text = c.text || '';
    const rawText = sliceRawSpan(documentText, c.start_char ?? 0, c.end_char ?? 0);
    const textHash = sha1Hex(text);
    const rawTextHash = sha1Hex(rawText);

    // Avoid storing many identical child nodes when upstream segmentation is noisy.
    const dedupeKey = `${parentChunkId}:${rawTextHash || textHash}`;
    if (seenChildHashes.has(dedupeKey)) continue;
    seenChildHashes.add(dedupeKey);

    if (seenChildChunkIds.has(chunkId)) continue;
    seenChildChunkIds.add(chunkId);

    childChunkIdBySegment.set(String(segmentId), chunkId);

    childRows.push({
      chunkId,
      parentChunkId,
      segmentId,
      text,
      rawText,
      textHash,
      rawTextHash,
      chunkKey,
      startChar: Number(c.start_char ?? 0),
      endChar: Number(c.end_char ?? 0),
    });

    await neo4j.run(
      `MATCH (d:Document {docId: $docId})
       MATCH (p:Chunk {chunkId: $parentChunkId})
       MERGE (cc:Chunk {chunkId: $chunkId})
       SET cc:ChunkChild,
           cc.level = 'child',
           cc.docId = $docId,
           cc.segmentId = $segmentId,
           cc.text = $text,
           cc.rawText = $rawText,
           cc.textHash = $textHash,
           cc.rawTextHash = $rawTextHash,
           cc.chunkKey = $chunkKey,
           cc.name = $name,
           cc.id = $chunkId,
           cc.startChar = $startChar,
           cc.endChar = $endChar,
           cc.updatedAt = $now,
           cc.createdAt = coalesce(cc.createdAt, $now)
       MERGE (p)-[:HAS_CHILD]->(cc)
       MERGE (d)-[:HAS_CHUNK]->(cc)
       MERGE (cc)-[:PART_OF]->(d)`,
      {
        docId: finalDocId,
        parentChunkId,
        chunkId,
        segmentId,
        text,
        rawText,
        textHash,
        rawTextHash: sha1Hex(rawText),
        chunkKey,
        name: segmentId,
        startChar: Number(c.start_char ?? 0),
        endChar: Number(c.end_char ?? 0),
        now: nowIso(),
      }
    );
  }

  // Write embeddings for child chunks (batch)
  const batchSize = 64;
  for (let i = 0; i < childRows.length; i += batchSize) {
    const batch = childRows.slice(i, i + batchSize);
    const texts = batch.map((r) => r.text);
    const embeddings = await embedTexts(openai, texts);

    for (let j = 0; j < batch.length; j++) {
      await neo4j.run(
        `MATCH (c:ChunkChild {chunkId: $chunkId})
         SET c.embedding = $embedding`,
        { chunkId: batch[j].chunkId, embedding: embeddings[j] }
      );
    }
  }

  // Entities
  for (const e of entities) {
    const canonical = e.canonical_name || e.name || '';
    const type = e.type || 'OTHER';
    const entityId = stableId('ent', `${type}|${canonical}`);
    await neo4j.run(
      `MERGE (en:Entity {entityId: $entityId})
       SET en.name = $name,
           en.type = $type,
           en.canonicalName = $canonical,
           en.id = $entityId,
           en.updatedAt = $now,
           en.createdAt = coalesce(en.createdAt, $now)`,
      {
        entityId,
        name: e.name || '',
        type,
        canonical,
        now: nowIso(),
      }
    );

    const evidence = Array.isArray(e.evidence) ? e.evidence : [];
    for (const ev of evidence) {
      const segId = ev.segment_id;
      if (!segId) continue;

      const segKey = String(segId);
      const childId = childChunkIdBySegment.get(segKey);
      const parentId = parentChunkIdBySegment.get(segKey);
      const targetChunkId = childId || parentId;
      if (!targetChunkId) continue;

      await neo4j.run(
        `MATCH (c:Chunk {chunkId: $chunkId})
         MATCH (en:Entity {entityId: $entityId})
         MERGE (c)-[r:HAS_ENTITY]->(en)
         SET r.confidence = $confidence,
             r.quote = $quote`,
        {
          chunkId: targetChunkId,
          entityId,
          confidence: Number(e.confidence ?? 0),
          quote: String(ev.quote ?? ''),
        }
      );
      entityLinks += 1;
    }

    // Fallback: if no evidence links were created, try simple text match
    if (evidence.length === 0) {
      entityLinks += await linkEntityByTextFallback(neo4j, finalDocId, entityId, [canonical, e.name]);
    }
  }

  // Relations: persist as (:Entity)-[:RELATED]->(:Entity)
  for (const rel of relations) {
    const predicate = normalizeName(rel.predicate ?? rel.type ?? rel.relation ?? 'RELATED');
    const subj = getEntityKey(rel.subject ?? rel.from ?? rel.head ?? rel.a ?? rel.source);
    const obj = getEntityKey(rel.object ?? rel.to ?? rel.tail ?? rel.b ?? rel.target);
    if (!subj.canonical || !obj.canonical) continue;

    const subjId = stableId('ent', `${subj.type}|${subj.canonical}`);
    const objId = stableId('ent', `${obj.type}|${obj.canonical}`);

    // Ensure both entity nodes exist
    await neo4j.run(
      `MERGE (s:Entity {entityId: $sid})
       ON CREATE SET s.type = $stype, s.canonicalName = $scan, s.name = $scan, s.createdAt = $now
       SET s.updatedAt = $now
       MERGE (o:Entity {entityId: $oid})
       ON CREATE SET o.type = $otype, o.canonicalName = $ocan, o.name = $ocan, o.createdAt = $now
       SET o.updatedAt = $now
       MERGE (s)-[r:RELATED {predicate: $pred}]->(o)
       SET r.confidence = $conf,
           r.updatedAt = $now`,
      {
        sid: subjId,
        oid: objId,
        stype: subj.type,
        otype: obj.type,
        scan: subj.canonical,
        ocan: obj.canonical,
        pred: predicate,
        conf: Number(rel.confidence ?? 0.5),
        now: nowIso(),
      }
    );
    relationLinks += 1;

    // Optional evidence: attach first quote/segmentId if available
    const evs = Array.isArray(rel.evidence) ? rel.evidence : [];
    const ev0 = evs[0];
    const segId = ev0?.segment_id != null ? String(ev0.segment_id) : '';
    const quote = ev0?.quote != null ? String(ev0.quote) : '';
    if (segId || quote) {
      await neo4j.run(
        `MATCH (s:Entity {entityId: $sid})-[r:RELATED {predicate: $pred}]->(o:Entity {entityId: $oid})
         SET r.segmentId = $segId,
             r.quote = $quote`,
        { sid: subjId, oid: objId, pred: predicate, segId, quote }
      );
    }
  }

  // Post-check counts for smoke feedback
  const relCountRes = await neo4j.run(
    `MATCH (d:Document {docId: $docId})
     OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:Chunk)
     WITH d, count(c) AS chunks
     OPTIONAL MATCH (d)-[:HAS_CHUNK]->(:ChunkChild)-[he:HAS_ENTITY]->(:Entity)
     WITH chunks, count(he) AS hasEntity
     OPTIONAL MATCH (:Entity)-[rr:RELATED]->(:Entity)
     RETURN chunks AS chunks, hasEntity AS hasEntity, count(rr) AS related`,
    { docId: finalDocId }
  );
  const counts = relCountRes.records?.[0]
    ? {
        chunks: Number(relCountRes.records[0].get('chunks') ?? 0),
        hasEntity: Number(relCountRes.records[0].get('hasEntity') ?? 0),
        related: Number(relCountRes.records[0].get('related') ?? 0),
      }
    : { chunks: 0, hasEntity: 0, related: 0 };

  return {
    docId: finalDocId,
    parentChunks: parents.length,
    childChunks: childRows.length,
    entities: entities.length,
    relations: relations.length,
    entityLinks,
    relationLinks,
    counts,
  };
}
