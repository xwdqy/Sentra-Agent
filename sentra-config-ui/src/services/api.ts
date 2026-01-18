import { ConfigData, EnvVariable } from '../types/config';

const API_BASE = '/api';

export function getAuthHeaders() {
  const token = sessionStorage.getItem('sentra_auth_token') || localStorage.getItem('sentra_auth_token');
  return {
    'Content-Type': 'application/json',
    'x-auth-token': token || ''
  };
}

export async function verifyToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await response.json();
    return data.success;
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
  const response = await fetch(`${API_BASE}/configs?t=${Date.now()}`, {
    headers: getAuthHeaders()
  });
  if (!response.ok) {
    throw new Error('Failed to fetch configurations');
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
  onDebugEvent?: (evt: {
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
  }) => void;
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

  if (!response.body) {
    if (params.onDebugEvent) {
      params.onDebugEvent({
        type: 'error',
        at: Date.now(),
        status: response.status,
        contentType: response.headers.get('content-type') || undefined,
        message: 'Missing response body (stream)',
      });
    }
    throw new Error('Missing response body (stream)');
  }

  const contentType = response.headers.get('content-type') || '';
  if (params.onDebugEvent) {
    params.onDebugEvent({
      type: 'open',
      at: Date.now(),
      status: response.status,
      contentType,
      bytesReceived: 0,
      framesReceived: 0,
      tokensReceived: 0,
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytesReceived = 0;
  let framesReceived = 0;
  let tokensReceived = 0;

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
        status: response.status,
        contentType,
        bytesReceived,
        framesReceived,
        tokensReceived,
      });
    }
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const parsed = tryParseSseFrame(frame);
      if (!parsed) continue;
      const { event, data } = parsed;

      framesReceived += 1;
      if (params.onDebugEvent) {
        params.onDebugEvent({
          type: 'frame',
          at: Date.now(),
          status: response.status,
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
            status: response.status,
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
            status: response.status,
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
            status: response.status,
            contentType,
            bytesReceived,
            framesReceived,
            tokensReceived,
            event,
            dataType: typeof data?.type === 'string' ? data.type : undefined,
          });
        }
        return { presetXml: data.presetXml || '', presetJson: data.presetJson };
      }
    }
  }

  throw new Error('Stream ended without done');
}

export async function saveModuleConfig(
  moduleName: string,
  variables: EnvVariable[]
): Promise<void> {
  const response = await fetch(`${API_BASE}/configs/module`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ moduleName, variables }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to save module configuration');
  }
}

export async function savePluginConfig(
  pluginName: string,
  variables: EnvVariable[]
): Promise<void> {
  const response = await fetch(`${API_BASE}/configs/plugin`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ pluginName, variables }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to save plugin configuration');
  }
}

export async function restoreModuleConfig(moduleName: string): Promise<void> {
  const response = await fetch(`${API_BASE}/configs/restore`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ moduleName }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to restore module configuration');
  }
}

export async function restorePluginConfig(pluginName: string): Promise<void> {
  const response = await fetch(`${API_BASE}/configs/restore`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ pluginName }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to restore plugin configuration');
  }
}

export async function fetchFileContent(path: string): Promise<{ content: string; isBinary: boolean }>{
  const response = await fetch(`${API_BASE}/files/content?path=${encodeURIComponent(path)}`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to fetch file content');
  }
  return response.json();
}

export async function saveFileContent(path: string, content: string): Promise<void> {
  const response = await fetch(`${API_BASE}/files/content`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ path, content }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to save file content');
  }
}

export async function fetchPresets(): Promise<any[]> {
  const response = await fetch(`${API_BASE}/presets`, {
    headers: getAuthHeaders()
  });
  if (!response.ok) throw new Error('Failed to fetch presets');
  return response.json();
}

export async function fetchPresetFile(path: string): Promise<{ content: string }> {
  const response = await fetch(`${API_BASE}/presets/file?path=${encodeURIComponent(path)}`, {
    headers: getAuthHeaders()
  });
  if (!response.ok) throw new Error('Failed to fetch preset file');
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
  const response = await fetch(`${API_BASE}/presets/file`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ path, content })
  });
  if (!response.ok) throw new Error('Failed to save preset file');
}

export async function deletePresetFile(path: string): Promise<void> {
  const token = sessionStorage.getItem('sentra_auth_token');
  const response = await fetch(`${API_BASE}/presets/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
    headers: {
      'x-auth-token': token || ''
    }
  });
  if (!response.ok) throw new Error('Failed to delete preset file');
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
