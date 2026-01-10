import { Command } from 'commander';
import { readFile } from 'node:fs/promises';

import { loadContractPolicy } from './contract/policy.js';
import { parseSentraContractXml } from './contract/xml_parser.js';
import { getEnv } from './config/env.js';
import { initDotenv } from './config/dotenv.js';
import { normalizeMessagesToText } from './messages/normalize.js';
import { createNeo4jClient } from './neo4j/client.js';
import { ensureNeo4jSchema } from './neo4j/schema.js';
import { createOpenAIClient } from './openai/client.js';
import { requestContractXml, requestContractXmlRepair } from './openai/contract_call.js';
import { ingestContractToNeo4j } from './pipelines/ingest.js';
import { queryWithNeo4j } from './pipelines/query.js';
import { logger } from './logger.js';

initDotenv();

const program = new Command();

program
  .name('sentra-neo4j-rag')
  .description('Tool-free Sentra XML contract driven RAG with Neo4j')
  .version('0.1.0');

function contractLang() {
  return getEnv('SENTRA_CONTRACT_LANG', { defaultValue: 'zh' });
}

program
  .command('ingest')
  .requiredOption('-f, --file <path>', 'Text file to ingest')
  .option('--doc-id <id>', 'Document id')
  .option('--title <title>', 'Document title')
  .option('--source <source>', 'Source name')
  .option('--raw', 'Print raw contract XML')
  .action(async (opts) => {
    logger.info('ingest: loading contract policy');
    const policy = await loadContractPolicy();
    const text = await readFile(opts.file, 'utf8');

    const openai = createOpenAIClient();
    logger.info('ingest: requesting contract');
    const xml = await requestContractXml(openai, policy, {
      task: 'ingest',
      queryText: '',
      contextText: '',
      documentText: text,
      lang: contractLang(),
    });

    if (opts.raw) process.stdout.write(xml + '\n');

    let contract = parseSentraContractXml(xml, { defaultTask: 'ingest' });
    if (!contract.ok) {
      const repaired = await requestContractXmlRepair(openai, policy, {
        badXml: xml,
        errorReport: contract.error,
        lang: contractLang(),
      });
      contract = parseSentraContractXml(repaired, { defaultTask: 'ingest' });
    }
    if (!contract.ok) throw new Error(contract.error);

    logger.info('ingest: contract summary', {
      parents: contract.value.segments?.parent?.length ?? 0,
      children: contract.value.segments?.child?.length ?? 0,
      entities: contract.value.extraction?.entities?.length ?? 0,
      relations: contract.value.extraction?.relations?.length ?? 0,
      canExecute: contract.value.quality?.can_execute ?? false,
      confidence: contract.value.quality?.confidence ?? 0,
    });

    const neo4j = createNeo4jClient();
    logger.info('ingest: ensuring neo4j schema');
    await ensureNeo4jSchema(neo4j, contract.value.neo4j_schema);

    logger.info('ingest: writing graph');
    const result = await ingestContractToNeo4j(neo4j, openai, contract.value, {
      docId: opts.docId,
      title: opts.title,
      source: opts.source,
    });

    await neo4j.close();
    logger.success('ingest: done', result);
  });

program
  .command('query')
  .requiredOption('-m, --messages <path>', 'Messages JSON file (OpenAI format)')
  .option('--raw', 'Print raw XML')
  .action(async (opts) => {
    logger.info('query: loading contract policy');
    const policy = await loadContractPolicy();
    const raw = await readFile(opts.messages, 'utf8');
    const messages = JSON.parse(raw);

    const { queryText, contextText } = normalizeMessagesToText(messages);

    const openai = createOpenAIClient();
    logger.info('query: requesting contract');
    const xml = await requestContractXml(openai, policy, {
      task: 'query',
      queryText,
      contextText,
      documentText: '',
      lang: contractLang(),
    });

    let contract = parseSentraContractXml(xml, { defaultTask: 'query' });
    if (!contract.ok) {
      const repaired = await requestContractXmlRepair(openai, policy, {
        badXml: xml,
        errorReport: contract.error,
        lang: contractLang(),
      });
      contract = parseSentraContractXml(repaired, { defaultTask: 'query' });
    }
    if (!contract.ok) throw new Error(contract.error);

    const neo4j = createNeo4jClient();
    logger.info('query: ensuring neo4j schema');
    await ensureNeo4jSchema(neo4j, contract.value.neo4j_schema);

    logger.info('query: retrieving and answering');
    const out = await queryWithNeo4j(neo4j, openai, policy, contract.value, {
      queryText,
      contextText,
      lang: contractLang(),
    });

    await neo4j.close();
    logger.success('query: done', { queryText, stats: out.stats });

    // Parse final answer for human-friendly smoke output
    const parsed = parseSentraContractXml(out.xml, { defaultTask: 'query' });
    if (parsed.ok) {
      const fa = parsed.value.final_answer;
      const answer =
        typeof fa?.answer === 'string'
          ? fa.answer
          : typeof fa?.answer?.string === 'string'
            ? fa.answer.string
            : typeof fa?.text === 'string'
              ? fa.text
              : typeof fa?.text?.string === 'string'
                ? fa.text.string
                : '';
      if (answer) {
        process.stdout.write(answer.trim() + '\n');
      }
    }

    if (opts.raw) {
      process.stdout.write(out.xml + '\n');
    }
  });

await program.parseAsync(process.argv);
