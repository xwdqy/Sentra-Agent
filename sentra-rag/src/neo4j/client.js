import neo4j from 'neo4j-driver';
 import { getEnv } from '../config/env.js';

export function createNeo4jClient() {
  const uri = getEnv('NEO4J_URI', { required: true });
  const username = getEnv('NEO4J_USERNAME', { required: true });
  const password = getEnv('NEO4J_PASSWORD', { required: true });
  const database = getEnv('NEO4J_DATABASE', { defaultValue: 'neo4j' });

  const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));

  return {
    database,
    driver,
    async run(cypher, params = {}) {
      const session = driver.session({ database });
      try {
        return await session.run(cypher, params);
      } catch (err) {
        if (err?.code === 'Neo.ClientError.Database.DatabaseNotFound') {
          // Try to help the user by listing available databases from the default DB.
          let available = [];
          try {
            const s2 = driver.session();
            try {
              const r2 = await s2.run('SHOW DATABASES YIELD name RETURN name');
              available = r2.records.map((r) => r.get('name')).filter(Boolean);
            } finally {
              await s2.close();
            }
          } catch {
            // ignore probing errors
          }

          const suffix = available.length
            ? ` Available databases: ${available.join(', ')}. Note: Neo4j Desktop shows a DBMS name (e.g. "sentra-rag"), but you must set NEO4J_DATABASE to the database name (e.g. "sentra").`
            : ` Note: Neo4j Desktop shows a DBMS name (e.g. "sentra-rag"), but you must set NEO4J_DATABASE to the database name (e.g. "sentra").`;

          const e = new Error(`Database does not exist: "${database}".${suffix}`);
          e.cause = err;
          throw e;
        }
        throw err;
      } finally {
        await session.close();
      }
    },
    async close() {
      await driver.close();
    },
  };
}
