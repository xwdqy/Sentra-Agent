export type ScopeKind = 'group' | 'private' | 'unknown';

function cleanId(raw: unknown): string {
  return String(raw ?? '').trim();
}

export function buildGroupScopeId(groupId: unknown): string {
  const gid = cleanId(groupId);
  return gid ? `G_${gid}` : 'G_unknown';
}

export function buildPrivateScopeId(userId: unknown): string {
  const uid = cleanId(userId);
  return uid ? `U_${uid}` : 'U_unknown';
}

export function parseScopeId(raw: unknown): { kind: ScopeKind; id: string } {
  const s = cleanId(raw);
  if (!s) return { kind: 'unknown', id: '' };
  if (s.startsWith('G_') || s.startsWith('G:')) return { kind: 'group', id: s.slice(2).trim() };
  if (s.startsWith('U_') || s.startsWith('U:')) return { kind: 'private', id: s.slice(2).trim() };
  if (s.startsWith('group_')) {
    const [groupPart = ''] = s.slice('group_'.length).split('_sender_');
    return { kind: 'group', id: groupPart.trim() };
  }
  if (s.startsWith('private_')) return { kind: 'private', id: s.slice('private_'.length).trim() };
  return { kind: 'unknown', id: s };
}

export function isGroupScopeId(raw: unknown): boolean {
  return parseScopeId(raw).kind === 'group';
}

export function isPrivateScopeId(raw: unknown): boolean {
  return parseScopeId(raw).kind === 'private';
}

export function toCanonicalScopeId(raw: unknown): string {
  const parsed = parseScopeId(raw);
  if (parsed.kind === 'group') return buildGroupScopeId(parsed.id || 'unknown');
  if (parsed.kind === 'private') return buildPrivateScopeId(parsed.id || 'unknown');
  return cleanId(raw);
}

export function extractScopeId(raw: unknown): string {
  return parseScopeId(raw).id || '';
}
