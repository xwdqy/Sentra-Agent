function boolFromEnv(v, { defaultValue = false } = {}) {
  if (v == null) return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (!s) return defaultValue;
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}

function buildRerankUrl(baseURL) {
  const root = String(baseURL || 'https://api.siliconflow.cn').replace(/\/+$/, '');
  if (/\/rerank$/i.test(root)) return root;
  if (/\/v\d+$/i.test(root)) return root + '/rerank';
  return root + '/v1/rerank';
}

export async function rerankDocumentsSiliconFlow({ query, documents, baseURL, apiKey, model, topN, timeoutMs } = {}) {
  const url = buildRerankUrl(baseURL);
  const docsClean = (documents || [])
    .map((d) => (typeof d === 'string' ? d : String(d?.text || '')))
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  const q = String(query || '').trim();
  if (!q || docsClean.length === 0) {
    throw new Error(`Invalid rerank inputs: query='${q}', docs=${docsClean.length}`);
  }

  const payload = { model: model || 'BAAI/bge-reranker-v2-m3', query: q, documents: docsClean };
  if (!Number.isFinite(topN) || Number(topN) <= 0) {
    payload.top_n = docsClean.length;
  } else {
    payload.top_n = Math.max(1, Math.min(Number(topN), docsClean.length));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs || 12000)));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const preview = text ? ` ${text.slice(0, 200)}` : '';
      throw new Error(`Rerank HTTP ${res.status}:${preview}`);
    }

    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.map((r) => ({ index: Number(r.index), score: Number(r.relevance_score || 0) }));
  } finally {
    clearTimeout(timer);
  }
}

function cosineSimilarity(a, b) {
  const L = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < L; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedTexts(openai, { model, texts }) {
  const res = await openai.embeddings.create({ model, input: texts });
  const rows = Array.isArray(res?.data) ? res.data : [];
  return rows.map((r) => r?.embedding).filter((e) => Array.isArray(e));
}

export async function rerankDocumentsByEmbedding({ query, documents, openai, embeddingModel, topN } = {}) {
  const q = String(query || '').trim();
  const docs = (documents || []).map((s) => String(s || '').trim());
  if (!q || docs.length === 0) return { indices: [], scores: [] };

  const embs = await embedTexts(openai, { model: embeddingModel, texts: [q, ...docs] });
  const qv = embs[0] || [];
  const dvs = embs.slice(1);

  const sims = dvs.map((v) => cosineSimilarity(qv, v));
  const order = sims.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s);

  const tn = !Number.isFinite(topN) || Number(topN) <= 0 ? order.length : Math.max(1, Math.min(Number(topN), order.length));
  const indices = order.slice(0, tn).map((x) => x.i);
  const scores = order.slice(0, tn).map((x) => x.s);
  return { indices, scores };
}

export async function rerankDocuments({
  query,
  documents,
  openai,
  embeddingModel,
  enableOnline,
  apiKey,
  baseURL,
  model,
  topN,
  timeoutMs,
} = {}) {
  const q = String(query || '').trim();
  const docs = (documents || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!q || docs.length === 0) return { indices: [], scores: [], mode: 'none' };

  const onlineEnabled = enableOnline ?? boolFromEnv(process.env.RAG_RERANK_ENABLE, { defaultValue: true });
  const key = apiKey || process.env.RAG_RERANK_API_KEY || '';

  if (onlineEnabled && key) {
    try {
      const results = await rerankDocumentsSiliconFlow({
        query: q,
        documents: docs,
        baseURL: baseURL || process.env.RAG_RERANK_BASE_URL,
        apiKey: key,
        model: model || process.env.RAG_RERANK_MODEL,
        topN,
        timeoutMs,
      });

      const raw = results
        .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < docs.length)
        .sort((a, b) => Number(b.score) - Number(a.score));

      const indices = raw.map((r) => r.index);
      const scores = raw.map((r) => Number(r.score) || 0);
      return { indices, scores, mode: 'online' };
    } catch {
      // fall through
    }
  }

  const out = await rerankDocumentsByEmbedding({ query: q, documents: docs, openai, embeddingModel, topN });
  return { ...out, mode: 'embedding' };
}
