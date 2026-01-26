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

export type McpServerType = 'stdio' | 'websocket' | 'http' | 'streamable_http';

export type McpServerDef = {
  id: string;
  type: McpServerType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
};

export type McpServersStatus = {
  baseDirAbs?: string;
  serversJsonAbs?: string;
  baseDirRel?: string;
  serversJsonRel?: string;
  baseDirExists?: boolean;
  serversJsonExists?: boolean;
  parseError?: string | null;
  count?: number;
};

export type McpServersItemsResponse = {
  serversJsonAbs?: string;
  serversJsonRel?: string;
  parseError?: string | null;
  items: McpServerDef[];
};

export type McpServersTestResponse =
  | { success: true; id: string; type: McpServerType; url?: string; status?: number; ok?: boolean }
  | { success: false; error?: string; id?: string; type?: McpServerType };

export async function getMcpServersStatus(): Promise<McpServersStatus> {
  const res = await fetch('/api/mcp-servers/status', {
    headers: getAuthHeaders({ json: false }),
  });
  return readJsonOrThrow(res);
}

export async function ensureMcpServersFile(): Promise<any> {
  const res = await fetch('/api/mcp-servers/ensure', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({}),
  });
  return readJsonOrThrow(res);
}

export async function fetchMcpServers(): Promise<McpServersItemsResponse> {
  const res = await fetch('/api/mcp-servers/items', {
    headers: getAuthHeaders({ json: false }),
  });
  return readJsonOrThrow(res);
}

export async function saveMcpServers(items: McpServerDef[]): Promise<{ success: boolean; count?: number }> {
  const res = await fetch('/api/mcp-servers/items', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ items }),
  });
  return readJsonOrThrow(res);
}

export async function testMcpServer(def: McpServerDef): Promise<McpServersTestResponse> {
  const res = await fetch('/api/mcp-servers/test', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(def),
  });
  return readJsonOrThrow(res);
}
