export function fnv1a32(input: string, seed = 2166136261): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hashToIndex(input: string, dim: number): number {
  const d = Number(dim);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return fnv1a32(input) % d;
}

export function hashToSign(input: string): number {
  const h = fnv1a32(input, 2166136261 ^ 0x9e3779b9);
  return (h & 1) === 0 ? 1 : -1;
}

