import { ConfigData, EnvVariable } from '../types/config';
import { storage } from '../utils/storage';

const API_BASE = '/api';

async function readApiError(response: Response): Promise<string> {
  const status = response.status;
  const ct = response.headers.get('content-type') || '';
  try {
    if (/application\/(json|problem\+json)/i.test(ct)) {
      const data: any = await response.json().catch(() => null);
      const msg = data?.message || data?.error || data?.detail;
      if (msg) return `HTTP ${status}: ${String(msg)}`;
      return `HTTP ${status}`;
    }
  } catch {
    // ignore
  }

  try {
    const text = await response.text();
    const s = String(text || '').trim();
    if (s) return `HTTP ${status}: ${s}`;
  } catch {
    // ignore
  }
  return `HTTP ${status}`;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let backendReadyPromise: Promise<number | null> | null = null;

async function ensureBackendReady(timeoutMs = 12_000): Promise<boolean> {
  const startedAt = Date.now();
  if (!backendReadyPromise) {
    backendReadyPromise = waitForBackend(60, 500);
  }
  try {
    const bootTime = await Promise.race([
      backendReadyPromise,
      sleep(Math.max(0, timeoutMs)),
    ]);
    return typeof bootTime === 'number' && bootTime > 0;
  } catch {
    return Date.now() - startedAt < timeoutMs;
  }
}

async function ensureAuthTokenReady(timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const token = storage.getString('sentra_auth_token', { backend: 'session', fallback: '' })
      || storage.getString('sentra_auth_token', { fallback: '' });
    if (token) return;
    await sleep(150);
  }
}

export async function authedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Avoid spamming backend during boot (when it may briefly return 500 for various routes)
  await ensureBackendReady();
  // Avoid firing a burst of 401 before auth check finishes / token is restored
  await ensureAuthTokenReady();
  return fetch(input, init);
}

type StreamDebugEvent = {
  type: 'open' | 'chunk' | 'frame' | 'token' | 'done' | 'error';
  at: number;
  status?: number;
  contentType?: string;
  bytesReceived?: number;
  framesReceived?: number;
  tokensReceived?: number;
  event?: string;
  dataType?: string;
  message?: string;
};

async function consumeJsonSseStream<TDone>(params: {
  response: Response;
  onToken?: (delta: string) => void;
  onDebugEvent?: (evt: StreamDebugEvent) => void;
  mapJson: (data: any) => TDone;
  mapDone: (data: any) => TDone;
}): Promise<TDone> {
  const contentType = params.response.headers.get('content-type') || '';

  if (!/text\/event-stream/i.test(contentType)) {
    const data: any = await params.response.json();
    return params.mapJson(data);
  }

  if (!params.response.body) {
    if (params.onDebugEvent) {
      params.onDebugEvent({
        type: 'error',
        at: Date.now(),
        status: params.response.status,
        contentType,
        message: 'Missing response body (stream)',
      });
    }
    throw new Error('Missing response body (stream)');
  }

  if (params.onDebugEvent) {
    params.onDebugEvent({
      type: 'open',
      at: Date.now(),
      status: params.response.status,
      contentType,
      bytesReceived: 0,
      framesReceived: 0,
      tokensReceived: 0,
    });
  }

  const reader = params.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytesReceived = 0;
  let framesReceived = 0;
  let tokensReceived = 0;

  const findFrameBoundary = (s: string) => {
    const n1 = s.indexOf('\n\n');
    const n2 = s.indexOf('\r\n\r\n');
    if (n1 < 0 && n2 < 0) return { idx: -1, len: 0 };
    if (n1 < 0) return { idx: n2, len: 4 };
    if (n2 < 0) return { idx: n1, len: 2 };
    return n1 < n2 ? { idx: n1, len: 2 } : { idx: n2, len: 4 };
  };

  const tryParseSseFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const l of lines) {
      if (l.startsWith('event:')) event = l.slice(6).trim();
      if (l.startsWith('data:')) dataLines.push(l.slice(5).trim());
    }
    if (dataLines.length === 0) return null;
    const dataStr = dataLines.join('\n');
    if (!dataStr) return null;
    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return null;
    }
    return { event, data };
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesReceived += value?.byteLength || 0;
    if (params.onDebugEvent) {
      params.onDebugEvent({
        type: 'chunk',
        at: Date.now(),
        status: params.response.status,
        contentType,
        bytesReceived,
        framesReceived,
        tokensReceived,
      });
    }
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const { idx, len } = findFrameBoundary(buffer);
      if (idx < 0) break;
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + len);

      const parsed = tryParseSseFrame(frame);
      if (!parsed) continue;
      const { event, data } = parsed;

      framesReceived += 1;
      if (params.onDebugEvent) {
        params.onDebugEvent({
          type: 'frame',
          at: Date.now(),
          status: params.response.status,
          contentType,
          bytesReceived,
          framesReceived,
          tokensReceived,
          event,
          dataType: typeof data?.type === 'string' ? data.type : undefined,
        });
      }

      if (data?.type === 'token') {
        const delta = String(data.delta || '');
        tokensReceived += 1;
        if (delta && params.onToken) params.onToken(delta);
        if (params.onDebugEvent) {
          params.onDebugEvent({
            type: 'token',
            at: Date.now(),
            status: params.response.status,
            contentType,
            bytesReceived,
            framesReceived,
            tokensReceived,
          });
        }
      }

      if (event === 'error' || data?.type === 'error') {
        if (params.onDebugEvent) {
          params.onDebugEvent({
            type: 'error',
            at: Date.now(),
            status: params.response.status,
            contentType,
            bytesReceived,
            framesReceived,
            tokensReceived,
            event,
            dataType: typeof data?.type === 'string' ? data.type : undefined,
            message: String(data?.message || 'Stream error'),
          });
        }
        throw new Error(String(data?.message || 'Stream error'));
      }

      if (event === 'done' || data?.type === 'done') {
        if (params.onDebugEvent) {
          params.onDebugEvent({
            type: 'done',
            at: Date.now(),
            status: params.response.status,
            contentType,
            bytesReceived,
            framesReceived,
            tokensReceived,
            event,
            dataType: typeof data?.type === 'string' ? data.type : undefined,
          });
        }
        return params.mapDone(data);
      }
    }
  }

  if (buffer.trim()) {
    const parsed = tryParseSseFrame(buffer);
    if (parsed) {
      const { event, data } = parsed;
      if (event === 'error' || data?.type === 'error') {
        throw new Error(String(data?.message || 'Stream error'));
      }
      if (event === 'done' || data?.type === 'done') {
        return params.mapDone(data);
      }
    }
  }

  throw new Error('Stream ended without done');
}

export function getAuthHeaders(options?: { json?: boolean }) {
  const token = storage.getString('sentra_auth_token', { backend: 'session', fallback: '' })
    || storage.getString('sentra_auth_token', { fallback: '' });
  const headers: Record<string, string> = {
    'x-auth-token': token || ''
  };
  if (options?.json !== false) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

export async function generateWorldbook(params: {
  text: string;
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<{ worldbookXml: string; worldbookJson: any }> {
  const body: any = {
    text: params.text,
    apiBaseUrl: params.apiBaseUrl,
    apiKey: params.apiKey,
    model: params.model,
    temperature: params.temperature,
    stream: false,
  };
  if (typeof params.maxTokens === 'number') body.maxTokens = params.maxTokens;

  const response = await fetch(`${API_BASE}/worldbook/generate`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to generate worldbook');
  }
  const data: any = await response.json();
  return {
    worldbookXml: data?.worldbookXml || '',
    worldbookJson: data?.worldbookJson,
  };
}

export async function generateWorldbookStream(params: {
  text: string;
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
  onDebugEvent?: (evt: StreamDebugEvent) => void;
}): Promise<{ worldbookXml: string; worldbookJson: any }> {
  const body: any = {
    text: params.text,
    apiBaseUrl: params.apiBaseUrl,
    apiKey: params.apiKey,
    model: params.model,
    temperature: params.temperature,
    stream: true,
  };
  if (typeof params.maxTokens === 'number') body.maxTokens = params.maxTokens;

  const response = await fetch(`${API_BASE}/worldbook/generate`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    if (params.onDebugEvent) {
      params.onDebugEvent({
        type: 'error',
        at: Date.now(),
        status: response.status,
        contentType: response.headers.get('content-type') || undefined,
        message: text || 'Failed to generate worldbook (stream)',
      });
    }
    throw new Error(text || 'Failed to generate worldbook (stream)');
  }

  return consumeJsonSseStream({
    response,
    onToken: params.onToken,
    onDebugEvent: params.onDebugEvent,
    mapJson: (data: any) => ({
      worldbookXml: data?.worldbookXml || '',
      worldbookJson: data?.worldbookJson,
    }),
    mapDone: (data: any) => ({
      worldbookXml: data?.worldbookXml || '',
      worldbookJson: data?.worldbookJson,
    }),
  });
}

export async function verifyToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    if (!response.ok) return false;
    const ct = response.headers.get('content-type') || '';
    if (!/application\/(json|problem\+json)/i.test(ct)) return false;
    const data: any = await response.json().catch(() => null);
    return !!data?.success;
  } catch {
    return false;
  }
}

export async function checkHealth(): Promise<number | null> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.bootTime;
  } catch {
    return null;
  }
}

export async function waitForBackend(maxAttempts = 60, interval = 1000): Promise<number | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const bootTime = await checkHealth();
    if (bootTime !== null) {
      return bootTime;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return null;
}

export async function fetchConfigs(): Promise<ConfigData> {
  // Add timestamp to prevent caching
  const response = await authedFetch(`${API_BASE}/configs?t=${Date.now()}`, {
    headers: getAuthHeaders()
  });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  return response.json();
}

export async function convertPresetTextStream(params: {
  text: string;
  fileName?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
  onDebugEvent?: (evt: StreamDebugEvent) => void;
}): Promise<{ presetXml: string; presetJson: any }> {
  const body: any = {
    text: params.text,
    fileName: params.fileName,
    apiBaseUrl: params.apiBaseUrl,
    apiKey: params.apiKey,
    model: params.model,
    temperature: params.temperature,
    stream: true,
  };
  if (typeof params.maxTokens === 'number') body.maxTokens = params.maxTokens;

  const response = await fetch(`${API_BASE}/presets/convert`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    if (params.onDebugEvent) {
      params.onDebugEvent({
        type: 'error',
        at: Date.now(),
        status: response.status,
        contentType: response.headers.get('content-type') || undefined,
        message: text || 'Failed to convert preset (stream)',
      });
    }
    throw new Error(text || 'Failed to convert preset (stream)');
  }

  return consumeJsonSseStream({
    response,
    onToken: params.onToken,
    onDebugEvent: params.onDebugEvent,
    mapJson: (data: any) => ({
      presetXml: data?.presetXml || '',
      presetJson: data?.presetJson,
    }),
    mapDone: (data: any) => ({
      presetXml: data?.presetXml || '',
      presetJson: data?.presetJson,
    }),
  });
}

export async function saveModuleConfig(
  moduleName: string,
  variables: EnvVariable[]
): Promise<void> {
  const response = await authedFetch(`${API_BASE}/configs/module`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ moduleName, variables }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

export async function savePluginConfig(
  pluginName: string,
  variables: EnvVariable[]
): Promise<void> {
  const response = await authedFetch(`${API_BASE}/configs/plugin`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ pluginName, variables }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

export async function restoreModuleConfig(moduleName: string): Promise<void> {
  const response = await authedFetch(`${API_BASE}/configs/restore`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ moduleName }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

export async function restorePluginConfig(pluginName: string): Promise<void> {
  const response = await authedFetch(`${API_BASE}/configs/restore`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ pluginName }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

export async function fetchFileContent(path: string): Promise<{ content: string; isBinary: boolean }> {
  const response = await authedFetch(`${API_BASE}/files/content?path=${encodeURIComponent(path)}`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  return response.json();
}

export async function saveFileContent(path: string, content: string): Promise<void> {
  const response = await authedFetch(`${API_BASE}/files/content`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ path, content }),
  });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

export async function fetchPresets(): Promise<any[]> {
  const response = await authedFetch(`${API_BASE}/presets`, {
    headers: getAuthHeaders()
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export async function fetchPresetFile(path: string): Promise<{ content: string }> {
  const response = await authedFetch(`${API_BASE}/presets/file?path=${encodeURIComponent(path)}`, {
    headers: getAuthHeaders()
  });
  if (!response.ok) throw new Error(await readApiError(response));
  const data: any = await response.json();
  if (typeof data === 'string') {
    return { content: data };
  }
  if (data && typeof data === 'object') {
    const content = (data as any).content
      ?? (data as any).data?.content
      ?? (data as any).file?.content
      ?? (data as any).text;
    if (typeof content === 'string') return { content };
  }
  return { content: '' };
}

export async function savePresetFile(path: string, content: string): Promise<void> {
  const response = await authedFetch(`${API_BASE}/presets/file`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ path, content })
  });
  if (!response.ok) throw new Error(await readApiError(response));
}

export async function deletePresetFile(path: string): Promise<void> {
  const token = storage.getString('sentra_auth_token', { backend: 'session', fallback: '' })
    || storage.getString('sentra_auth_token', { fallback: '' });
  await ensureBackendReady();
  await ensureAuthTokenReady();
  const response = await fetch(`${API_BASE}/presets/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
    headers: {
      'x-auth-token': token || ''
    }
  });
  if (!response.ok) throw new Error(await readApiError(response));
}

export async function savePluginSkill(pluginName: string, content: string): Promise<void> {
  const response = await authedFetch(`${API_BASE}/configs/plugin-skill`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ pluginName, content }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

export async function restorePluginSkill(pluginName: string): Promise<void> {
  const response = await authedFetch(`${API_BASE}/configs/plugin-skill/restore`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ pluginName }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

export async function convertPresetText(params: {
  text: string;
  fileName?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<{ presetXml: string; presetJson: any }> {
  const body: any = {
    text: params.text,
    fileName: params.fileName,
    apiBaseUrl: params.apiBaseUrl,
    apiKey: params.apiKey,
    model: params.model,
    temperature: params.temperature,
  };
  if (typeof params.maxTokens === 'number') body.maxTokens = params.maxTokens;

  const response = await fetch(`${API_BASE}/presets/convert`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to convert preset');
  }

  return response.json();
}
