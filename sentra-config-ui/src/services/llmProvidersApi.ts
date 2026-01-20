import { getAuthHeaders } from './api';

async function readJsonOrThrow(res: Response) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `HTTP ${res.status}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return text;
  }
}

export async function testProviderModels(params: {
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  debug?: boolean;
}): Promise<{ models: any[] }> {
  const res = await fetch('/api/llm-providers/test-models', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      apiKeyHeader: params.apiKeyHeader,
      apiKeyPrefix: params.apiKeyPrefix,
      debug: !!params.debug,
    }),
  });
  return readJsonOrThrow(res);
}
