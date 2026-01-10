import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

const parser = new XMLParser({
  ignoreAttributes: false,
  preserveOrder: false,
  trimValues: false,
});

const ContractSchema = z.object({
  'sentra-contract': z.any(),
});

function ensureArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function readText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && typeof node.string === 'string') return node.string;
  return '';
}

function readBool(node) {
  if (node == null) return false;
  if (typeof node === 'boolean') return node;
  if (typeof node === 'object' && typeof node.boolean === 'string') return node.boolean === 'true';
  return false;
}

function readNumber(node) {
  if (node == null) return 0;
  if (typeof node === 'number') return node;
  if (typeof node === 'object' && typeof node.number === 'string') return Number(node.number);
  return 0;
}

function parseObject(objNode) {
  // object -> field[]
  const fields = ensureArray(objNode?.field);
  const out = {};
  for (const f of fields) {
    const name = f?.['@_name'];
    if (!name) continue;
    if (f.string != null) out[name] = f.string;
    else if (f.number != null) out[name] = Number(f.number);
    else if (f.boolean != null) out[name] = f.boolean === 'true';
    else if (f.null != null) out[name] = null;
    else if (f.array != null) out[name] = parseArray(f.array);
    else if (f.object != null) out[name] = parseObject(f.object);
    else out[name] = '';
  }
  return out;
}

function parseArray(arrayNode) {
  if (!arrayNode) return [];
  const values = [];
  const children = [];

  // fast-xml-parser flattens when tags are unique; handle common patterns:
  // <array><string>..</string><object>..</object></array>
  for (const k of Object.keys(arrayNode)) {
    const v = arrayNode[k];
    children.push({ k, v });
  }

  for (const { k, v } of children) {
    const items = ensureArray(v);
    for (const it of items) {
      if (k === 'string') values.push(String(it));
      else if (k === 'number') values.push(Number(it));
      else if (k === 'boolean') values.push(String(it) === 'true');
      else if (k === 'null') values.push(null);
      else if (k === 'object') values.push(parseObject(it));
      else if (k === 'array') values.push(parseArray(it));
    }
  }

  return values;
}

function parseSegments(root) {
  const segments = root?.segments;
  if (!segments) return { parent: [], child: [] };

  const parent = parseArray(segments?.parent?.array);
  const child = parseArray(segments?.child?.array);

  return { parent, child };
}

function parseExtraction(root) {
  const ext = root?.extraction;
  if (!ext) return { entities: [], relations: [], linking_hints: [] };

  return {
    entities: parseArray(ext?.entities?.array),
    relations: parseArray(ext?.relations?.array),
    linking_hints: parseArray(ext?.linking_hints?.array),
  };
}

function parseNeo4jSchema(root) {
  const s = root?.neo4j_schema;
  if (!s) return null;
  return {
    database: readText(s?.database),
    vector_indexes: parseArray(s?.vector_indexes?.array),
    fulltext_indexes: parseArray(s?.fulltext_indexes?.array),
    constraints: parseArray(s?.constraints?.array),
  };
}

function parseRouting(root) {
  const r = root?.routing;
  if (!r) return null;
  return {
    input_type: readText(r?.input_type),
    language: readText(r?.language),
    document_type: readText(r?.document_type),
    extraction_tier: readText(r?.extraction_tier),
    chunking_profile: readText(r?.chunking_profile),
    reasoning: parseArray(r?.reasoning?.array),
  };
}

function parseRetrievalPlan(root) {
  const p = root?.retrieval_plan;
  if (!p) return null;
  return {
    strategy: readText(p?.strategy),
    intent: readText(p?.intent),
    parameters: p?.parameters?.object ? parseObject(p.parameters.object) : {},
    steps: parseArray(p?.steps?.array),
  };
}

export function parseSentraContractXml(xml, { defaultTask } = {}) {
  try {
    const parsed = parser.parse(xml);
    const checked = ContractSchema.safeParse(parsed);
    if (!checked.success) return { ok: false, error: 'XML root is not <sentra-contract>' };

    const root = checked.data['sentra-contract'];

    const meta = root?.meta ?? {};
    const quality = root?.quality ?? {};

    const out = {
      meta: {
        task: readText(meta?.task),
        lang: readText(meta?.lang),
        version: readText(meta?.version),
        request_id: readText(meta?.request_id),
      },
      normalized_input: {
        query_text: readText(root?.normalized_input?.query_text),
        context_text: readText(root?.normalized_input?.context_text),
        document_text: readText(root?.normalized_input?.document_text),
      },
      routing: parseRouting(root),
      neo4j_schema: parseNeo4jSchema(root),
      segmentation: root?.segmentation ?? null,
      segments: parseSegments(root),
      extraction: parseExtraction(root),
      retrieval_plan: parseRetrievalPlan(root),
      final_answer: root?.final_answer ?? null,
      quality: {
        errors: parseArray(quality?.errors?.array),
        warnings: parseArray(quality?.warnings?.array),
        confidence: readNumber(quality?.confidence),
        can_execute: readBool(quality?.can_execute),
      },
    };

    if (!out.meta.task && defaultTask) out.meta.task = String(defaultTask);

    // Minimal sanity
    if (!out.meta.task) return { ok: false, error: 'Missing <meta><task>' };

    return { ok: true, value: out };
  } catch (e) {
    return { ok: false, error: `XML parse failed: ${e?.message || String(e)}` };
  }
}
