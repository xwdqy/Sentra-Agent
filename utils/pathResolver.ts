import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

type ProbeMode = 'any' | 'all';

export type ResolveProjectAssetPathOptions = {
  importMetaUrl?: string;
  probePaths?: string[];
  probeMode?: ProbeMode;
  maxParentLevels?: number;
  extraBaseDirs?: string[];
};

function dedupe(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = String(item || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isCandidateMatched(candidate: string, probePaths: string[], probeMode: ProbeMode): boolean {
  if (!probePaths.length) return fs.existsSync(candidate);
  const checks = probePaths.map((p) => fs.existsSync(path.resolve(candidate, p)));
  return probeMode === 'all' ? checks.every(Boolean) : checks.some(Boolean);
}

export function resolveProjectAssetPath(
  relativePath: string,
  options: ResolveProjectAssetPathOptions = {}
): string {
  const rel = String(relativePath || '').trim();
  if (!rel) return path.resolve(process.cwd());

  const probePaths = Array.isArray(options.probePaths)
    ? options.probePaths.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const probeMode: ProbeMode = options.probeMode === 'all' ? 'all' : 'any';
  const maxParentLevels = Number.isFinite(Number(options.maxParentLevels))
    ? Math.max(0, Math.min(6, Number(options.maxParentLevels)))
    : 3;

  const candidates: string[] = [];
  candidates.push(path.resolve(process.cwd(), rel));

  if (typeof options.importMetaUrl === 'string' && options.importMetaUrl.trim()) {
    try {
      let dir = path.dirname(fileURLToPath(options.importMetaUrl));
      for (let i = 0; i <= maxParentLevels; i++) {
        candidates.push(path.resolve(dir, rel));
        dir = path.resolve(dir, '..');
      }
    } catch {
      // ignore invalid importMetaUrl
    }
  }

  if (Array.isArray(options.extraBaseDirs)) {
    for (const base of options.extraBaseDirs) {
      const s = String(base || '').trim();
      if (!s) continue;
      candidates.push(path.resolve(s, rel));
    }
  }

  const unique = dedupe(candidates);
  for (const candidate of unique) {
    if (isCandidateMatched(candidate, probePaths, probeMode)) return candidate;
  }

  return unique[0] || path.resolve(process.cwd(), rel);
}

