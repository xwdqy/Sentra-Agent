import neo4j from 'neo4j-driver';
import { getEnv, getEnvNumber } from '../config/env.js';

function quoteName(name) {
  // Backticks for Neo4j names; escape backticks by doubling.
  const safe = String(name).replace(/`/g, '``');
  return `\`${safe}\``;
}

function normalizeDims() {
  const dims = getEnvNumber('NEO4J_VECTOR_DIMENSIONS', { defaultValue: 1536 });
  if (!Number.isInteger(dims) || dims <= 0) throw new Error('Invalid NEO4J_VECTOR_DIMENSIONS');
  return dims;
}

export async function ensureNeo4jSchema(neo4jClient, schemaFromContract) {
  // If contract declares schema, prefer it; otherwise use env defaults.
  const vectorIndexName = getEnv('NEO4J_VECTOR_INDEX', { defaultValue: 'chunkChildEmbedding' });
  const fulltextIndexName = getEnv('NEO4J_FULLTEXT_INDEX', { defaultValue: 'chunkText' });
  const similarity = getEnv('NEO4J_VECTOR_SIMILARITY', { defaultValue: 'cosine' });
  const dims = normalizeDims();

  // Minimal default schema for our pipeline
  // 1) constraints
  await neo4jClient.run(
    `CREATE CONSTRAINT Document_docId_unique IF NOT EXISTS FOR (d:Document) REQUIRE d.docId IS UNIQUE`
  );
  await neo4jClient.run(
    `CREATE CONSTRAINT Chunk_chunkId_unique IF NOT EXISTS FOR (c:Chunk) REQUIRE c.chunkId IS UNIQUE`
  );
  await neo4jClient.run(
    `CREATE CONSTRAINT Entity_entityId_unique IF NOT EXISTS FOR (e:Entity) REQUIRE e.entityId IS UNIQUE`
  );

  // Helpful lookup for evidence linking/debugging
  await neo4jClient.run(
    `CREATE INDEX Chunk_segmentId IF NOT EXISTS FOR (c:Chunk) ON (c.segmentId)`
  );

  // 2) vector index on ChunkChild.embedding (only child chunks should be embedded)
  await neo4jClient.run(
    `CREATE VECTOR INDEX ${quoteName(vectorIndexName)} IF NOT EXISTS FOR (c:ChunkChild) ON c.embedding OPTIONS { indexConfig: { \`vector.dimensions\`: $dims, \`vector.similarity_function\`: $sim } }`,
    { dims: neo4j.int(dims), sim: similarity }
  );

  // 3) fulltext index
  await neo4jClient.run(
    `CREATE FULLTEXT INDEX ${quoteName(fulltextIndexName)} IF NOT EXISTS FOR (n:Chunk|Document) ON EACH [n.text, n.title]`
  );

  // Optional: contract-declared schema could be applied here, but we keep it minimal and safe.
  // If you want strict contract-driven schema, we can implement it next.
  void schemaFromContract;
}
