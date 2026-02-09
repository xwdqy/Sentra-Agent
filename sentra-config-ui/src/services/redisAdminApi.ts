import { authedFetch, getAuthHeaders } from './api';

export type RedisAdminHealth = {
  enabled: boolean;
  sentraRoot: string;
};

export type RedisAdminInfo = {
  success: boolean;
  profile?: 'main' | 'mcp';
  envPath?: string;
  host: string | null;
  port: number | null;
  db: number | null;
  hasPassword: boolean;
  prefixes?: Record<string, string>;
};

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

export async function fetchRedisAdminHealth(): Promise<RedisAdminHealth> {
  const res = await authedFetch('/api/redis-admin/health', { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function deleteRedisAdminKeys(params: {
  profile?: 'main' | 'mcp';
  keys: string[];
  dryRun?: boolean;
}): Promise<any> {
  const res = await authedFetch('/api/redis-admin/deleteKeys', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      profile: params.profile,
      keys: Array.isArray(params.keys) ? params.keys : [],
      dryRun: params.dryRun !== undefined ? params.dryRun : true,
    }),
  });
  return readJsonOrThrow(res);
}

export async function deleteRedisAdminKey(params: {
  profile?: 'main' | 'mcp';
  key: string;
  dryRun?: boolean;
}): Promise<any> {
  const res = await authedFetch('/api/redis-admin/deleteKey', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      profile: params.profile,
      key: params.key,
      dryRun: params.dryRun !== undefined ? params.dryRun : true,
    }),
  });
  return readJsonOrThrow(res);
}

export async function deleteRedisAdminAllKeys(params: {
  profile?: 'main' | 'mcp';
  dryRun?: boolean;
  scanCount?: number;
}): Promise<any> {
  const res = await authedFetch('/api/redis-admin/deleteAllKeys', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      profile: params.profile,
      dryRun: params.dryRun !== undefined ? params.dryRun : true,
      scanCount: params.scanCount,
    }),
  });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminInfo(): Promise<RedisAdminInfo> {
  const res = await authedFetch('/api/redis-admin/info', { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminInfoByProfile(profile?: 'main' | 'mcp'): Promise<RedisAdminInfo> {
  const qs = new URLSearchParams();
  if (profile) qs.set('profile', profile);
  const url = qs.toString() ? `/api/redis-admin/info?${qs.toString()}` : '/api/redis-admin/info';
  const res = await authedFetch(url, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminGroups(params?: { profile?: 'main' | 'mcp' }): Promise<{ groups: Record<string, string> }> {
  const qs = new URLSearchParams();
  if (params?.profile) qs.set('profile', params.profile);
  const url = qs.toString() ? `/api/redis-admin/groups?${qs.toString()}` : '/api/redis-admin/groups';
  const res = await authedFetch(url, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminOverview(params?: { profile?: 'main' | 'mcp'; count?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.profile) qs.set('profile', params.profile);
  if (params?.count != null) qs.set('count', String(params.count));
  const url = qs.toString() ? `/api/redis-admin/overview?${qs.toString()}` : '/api/redis-admin/overview';
  const res = await authedFetch(url, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminStats(params: { profile?: 'main' | 'mcp'; pattern: string; count?: number; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params.profile) qs.set('profile', params.profile);
  qs.set('pattern', params.pattern);
  if (params.count != null) qs.set('count', String(params.count));
  if (params.limit != null) qs.set('limit', String(params.limit));
  const res = await authedFetch(`/api/redis-admin/stats?${qs.toString()}`, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminList(params: { profile?: 'main' | 'mcp'; pattern: string; count?: number; withMeta?: boolean }): Promise<any> {
  const qs = new URLSearchParams();
  if (params.profile) qs.set('profile', params.profile);
  qs.set('pattern', params.pattern);
  if (params.count != null) qs.set('count', String(params.count));
  if (params.withMeta) qs.set('withMeta', '1');
  const res = await authedFetch(`/api/redis-admin/list?${qs.toString()}`, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminInspect(params: {
  profile?: 'main' | 'mcp';
  key: string;
  preview?: number;
  head?: number;
  tail?: number;
  sample?: number;
  top?: number;
}): Promise<any> {
  const qs = new URLSearchParams();
  if (params.profile) qs.set('profile', params.profile);
  qs.set('key', params.key);
  if (params.preview != null) qs.set('preview', String(params.preview));
  if (params.head != null) qs.set('head', String(params.head));
  if (params.tail != null) qs.set('tail', String(params.tail));
  if (params.sample != null) qs.set('sample', String(params.sample));
  if (params.top != null) qs.set('top', String(params.top));
  const res = await authedFetch(`/api/redis-admin/inspect?${qs.toString()}`, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminRelated(params: { profile?: 'main' | 'mcp'; groupId?: string; userId?: string; count?: number; withMeta?: boolean }): Promise<any> {
  const qs = new URLSearchParams();
  if (params.profile) qs.set('profile', params.profile);
  if (params.groupId) qs.set('groupId', params.groupId);
  if (params.userId) qs.set('userId', params.userId);
  if (params.count != null) qs.set('count', String(params.count));
  if (params.withMeta) qs.set('withMeta', '1');
  const url = qs.toString() ? `/api/redis-admin/related?${qs.toString()}` : '/api/redis-admin/related';
  const res = await authedFetch(url, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function deleteRedisAdminByPattern(params: {
  profile?: 'main' | 'mcp';
  pattern: string;
  dryRun?: boolean;
  count?: number;
}): Promise<any> {
  const res = await authedFetch('/api/redis-admin/deleteByPattern', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      profile: params.profile,
      pattern: params.pattern,
      dryRun: params.dryRun !== undefined ? params.dryRun : true,
      count: params.count,
    }),
  });
  return readJsonOrThrow(res);
}

export async function deleteRedisAdminGroupStatePairs(params: {
  profile?: 'main' | 'mcp';
  groupId: string;
  pairIds: string[];
  dryRun?: boolean;
}): Promise<any> {
  const res = await authedFetch('/api/redis-admin/groupState/deletePairs', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      profile: params.profile,
      groupId: params.groupId,
      pairIds: params.pairIds,
      dryRun: params.dryRun !== undefined ? params.dryRun : true,
    }),
  });
  return readJsonOrThrow(res);
}

export async function setRedisAdminStringValue(params: {
  profile?: 'main' | 'mcp';
  key: string;
  value: string;
}): Promise<any> {
  const res = await authedFetch('/api/redis-admin/string/set', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      profile: params.profile,
      key: params.key,
      value: params.value,
    }),
  });
  return readJsonOrThrow(res);
}

export async function updateRedisAdminGroupStatePairMessage(params: {
  profile?: 'main' | 'mcp';
  groupId: string;
  pairId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number | null;
}): Promise<any> {
  const res = await authedFetch('/api/redis-admin/groupState/updatePairMessage', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      profile: params.profile,
      groupId: params.groupId,
      pairId: params.pairId,
      role: params.role,
      content: params.content,
      timestamp: params.timestamp ?? null,
    }),
  });
  return readJsonOrThrow(res);
}
