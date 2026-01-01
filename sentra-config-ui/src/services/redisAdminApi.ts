import { getAuthHeaders } from './api';

export type RedisAdminHealth = {
  enabled: boolean;
  sentraRoot: string;
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
  const res = await fetch('/api/redis-admin/health', { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminGroups(): Promise<{ groups: Record<string, string> }> {
  const res = await fetch('/api/redis-admin/groups', { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminOverview(params?: { count?: number }): Promise<any> {
  const qs = new URLSearchParams();
  if (params?.count != null) qs.set('count', String(params.count));
  const url = qs.toString() ? `/api/redis-admin/overview?${qs.toString()}` : '/api/redis-admin/overview';
  const res = await fetch(url, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminStats(params: { pattern: string; count?: number; limit?: number }): Promise<any> {
  const qs = new URLSearchParams();
  qs.set('pattern', params.pattern);
  if (params.count != null) qs.set('count', String(params.count));
  if (params.limit != null) qs.set('limit', String(params.limit));
  const res = await fetch(`/api/redis-admin/stats?${qs.toString()}`, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminList(params: { pattern: string; count?: number; withMeta?: boolean }): Promise<any> {
  const qs = new URLSearchParams();
  qs.set('pattern', params.pattern);
  if (params.count != null) qs.set('count', String(params.count));
  if (params.withMeta) qs.set('withMeta', '1');
  const res = await fetch(`/api/redis-admin/list?${qs.toString()}`, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminInspect(params: {
  key: string;
  preview?: number;
  head?: number;
  tail?: number;
  sample?: number;
  top?: number;
}): Promise<any> {
  const qs = new URLSearchParams();
  qs.set('key', params.key);
  if (params.preview != null) qs.set('preview', String(params.preview));
  if (params.head != null) qs.set('head', String(params.head));
  if (params.tail != null) qs.set('tail', String(params.tail));
  if (params.sample != null) qs.set('sample', String(params.sample));
  if (params.top != null) qs.set('top', String(params.top));
  const res = await fetch(`/api/redis-admin/inspect?${qs.toString()}`, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function fetchRedisAdminRelated(params: { groupId?: string; userId?: string; count?: number; withMeta?: boolean }): Promise<any> {
  const qs = new URLSearchParams();
  if (params.groupId) qs.set('groupId', params.groupId);
  if (params.userId) qs.set('userId', params.userId);
  if (params.count != null) qs.set('count', String(params.count));
  if (params.withMeta) qs.set('withMeta', '1');
  const url = qs.toString() ? `/api/redis-admin/related?${qs.toString()}` : '/api/redis-admin/related';
  const res = await fetch(url, { headers: getAuthHeaders() });
  return readJsonOrThrow(res);
}

export async function deleteRedisAdminByPattern(params: {
  pattern: string;
  dryRun?: boolean;
  count?: number;
}): Promise<any> {
  const res = await fetch('/api/redis-admin/deleteByPattern', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      pattern: params.pattern,
      dryRun: params.dryRun !== undefined ? params.dryRun : true,
      count: params.count,
    }),
  });
  return readJsonOrThrow(res);
}
