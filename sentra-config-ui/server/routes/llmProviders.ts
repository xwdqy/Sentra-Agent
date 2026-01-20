import type { FastifyInstance } from 'fastify';

function asString(v: any) {
  return v == null ? '' : String(v);
}

function normalizeBaseUrl(url: string) {
  return asString(url).trim().replace(/\/+$/, '');
}

function isHttpUrl(url: string) {
  return /^https?:\/\//i.test(url);
}

function normalizeBaseUrlV1(url: string) {
  const u = normalizeBaseUrl(url);
  if (!u) return u;
  const lower = u.toLowerCase();
  if (lower.endsWith('/v1')) return u;
  return `${u}/v1`;
}

function extractModels(payload: any) {
  const direct = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : null;
  if (direct) return direct;

  const nested = Array.isArray(payload?.data?.data)
    ? payload.data.data
    : Array.isArray(payload?.data?.models)
      ? payload.data.models
      : Array.isArray(payload?.result?.data)
        ? payload.result.data
        : Array.isArray(payload?.result?.models)
          ? payload.result.models
          : null;

  return nested || [];
}

function extractErrorMessage(payload: any) {
  const msg = payload?.error?.message || payload?.error?.error || payload?.error || payload?.message;
  return msg == null ? '' : String(msg);
}

async function readTextSafe(res: Response) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export async function llmProvidersRoutes(fastify: FastifyInstance) {
  // NOTE: still protected by global x-auth-token middleware.

  fastify.post('/api/llm-providers/test-models', async (request, reply) => {
    try {
      const sendJson = (statusCode: number, payload: any) => {
        const out = JSON.stringify(payload ?? {});
        reply.hijack();
        reply.raw.statusCode = statusCode;
        reply.raw.setHeader('Content-Type', 'application/json; charset=utf-8');
        reply.raw.setHeader('Content-Encoding', 'identity');
        reply.raw.end(out);
      };

      const body: any = request.body || {};
      const baseUrl = normalizeBaseUrl(body.baseUrl);
      const apiKey = asString(body.apiKey).trim();
      const apiKeyHeader = asString(body.apiKeyHeader || 'Authorization').trim() || 'Authorization';
      const apiKeyPrefix = asString(body.apiKeyPrefix != null ? body.apiKeyPrefix : 'Bearer ');
      const debug = !!body.debug;

      if (!baseUrl) {
        sendJson(400, { success: false, error: 'baseUrl is required' });
        return;
      }

      if (!isHttpUrl(baseUrl)) {
        sendJson(400, { success: false, error: 'baseUrl must start with http:// or https://' });
        return;
      }

      const baseV1 = normalizeBaseUrlV1(baseUrl);
      const url = `${baseV1}/models`;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

      if (apiKey) {
        const prefix = apiKeyPrefix;
        const lowerToken = apiKey.toLowerCase();
        const lowerPrefix = prefix.toLowerCase();
        const tokenValue = prefix && !lowerToken.startsWith(lowerPrefix) ? `${prefix}${apiKey}` : apiKey;
        headers[apiKeyHeader] = tokenValue;
      }

      const ac = new AbortController();
      const timeoutMs = 15000;
      const timer = setTimeout(() => ac.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers,
          signal: ac.signal,
        } as any);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const text = await readTextSafe(res);
        sendJson(res.status, { success: false, error: text || `Upstream HTTP ${res.status}` });
        return;
      }

      const raw = await readTextSafe(res);
      if (!raw || !raw.trim()) {
        const ct = res.headers.get('content-type') || '';
        const cl = res.headers.get('content-length') || '';
        sendJson(502, {
          success: false,
          error: `Upstream returned empty response body (url=${url}${ct ? `; content-type=${ct}` : ''}${cl ? `; content-length=${cl}` : ''})`,
        });
        return;
      }

      let data: any = null;
      try {
        data = JSON.parse(raw);
      } catch {
        const ct = res.headers.get('content-type') || '';
        sendJson(502, {
          success: false,
          error: `Upstream returned non-JSON response (url=${url}${ct ? `; content-type=${ct}` : ''})`,
        });
        return;
      }

      const models = extractModels(data);
      if ((!models || models.length === 0) && data && typeof data === 'object') {
        const errMsg = extractErrorMessage(data);
        if (errMsg) {
          sendJson(502, { success: false, error: errMsg });
          return;
        }
      }

      if (debug) {
        sendJson(200, {
          models,
          debug: {
            url,
            upstreamStatus: res.status,
            contentType: res.headers.get('content-type') || '',
            contentLength: res.headers.get('content-length') || '',
            topKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : [],
            rawSnippet: raw.slice(0, 300),
          },
        });
        return;
      }

      sendJson(200, { models });
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? 'Upstream request timeout' : (e?.message || String(e));
      try {
        const out = JSON.stringify({ success: false, error: msg });
        reply.hijack();
        reply.raw.statusCode = 500;
        reply.raw.setHeader('Content-Type', 'application/json; charset=utf-8');
        reply.raw.setHeader('Content-Encoding', 'identity');
        reply.raw.end(out);
      } catch {
        reply.code(500).send({ success: false, error: msg });
      }
    }
  });
}
