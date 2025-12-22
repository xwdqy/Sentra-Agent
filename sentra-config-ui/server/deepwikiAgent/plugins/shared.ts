import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { XMLParser } from 'fast-xml-parser';

export function projectRoot(): string {
  return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

export function isSafeRepoPath(repoRelPath: string): boolean {
  const root = projectRoot();
  const resolvedPath = resolve(root, repoRelPath);
  return resolvedPath.startsWith(root);
}

export function isBlockedWritePath(repoRelPath: string): boolean {
  const p = String(repoRelPath || '').replace(/\\/g, '/');
  if (!p) return true;
  const isEnv = /(^|\/)\.env(\.|$)/i.test(p);
  if (!isEnv) return true;
  if (/(^|\/)(id_rsa|id_ed25519)(\.|$)/i.test(p)) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(p)) return true;
  return false;
}

export function formatEnvValue(v: any): string {
  const s = typeof v === 'object' && v != null ? JSON.stringify(v) : String(v ?? '');
  if (/\s|#/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

export function escapeRegex(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let typedXmlParser: XMLParser | null = null;

function getTypedXmlParser(): XMLParser {
  if (typedXmlParser) return typedXmlParser;
  typedXmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: false,
    allowBooleanAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  return typedXmlParser;
}

function extractAstText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map((n) => extractAstText(n)).join('');
  if (typeof node === 'object') {
    if (typeof node['#text'] === 'string') return node['#text'];
    let out = '';
    for (const [k, v] of Object.entries(node)) {
      if (k === '#text') continue;
      if (k.startsWith('@_')) continue;
      out += extractAstText(v);
    }
    return out;
  }
  return '';
}

function inferScalarType(v: string): any {
  const t = String(v ?? '').trim();
  const low = t.toLowerCase();
  if (low === 'true') return true;
  if (low === 'false') return false;
  if (low === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

function decodeAstArray(arrayNode: any): any[] {
  if (arrayNode == null) return [];
  const values: any[] = [];
  const containers = Array.isArray(arrayNode) ? arrayNode : [arrayNode];
  const typeKeys = ['string', 'number', 'boolean', 'null', 'array', 'object'];
  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    for (const key of typeKeys) {
      if (!Object.prototype.hasOwnProperty.call(c, key)) continue;
      const raw = (c as any)[key];
      const items = Array.isArray(raw) ? raw : [raw];
      for (const it of items) {
        const wrapper: any = { [key]: it };
        values.push(decodeAstTypedValue(wrapper));
      }
    }
  }
  return values;
}

function decodeAstObject(objectNode: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (objectNode == null) return out;
  const containers = Array.isArray(objectNode) ? objectNode : [objectNode];
  for (const c of containers) {
    if (!c || typeof c !== 'object') continue;
    const rawParams = (c as any).parameter;
    const params = Array.isArray(rawParams) ? rawParams : (rawParams ? [rawParams] : []);
    for (const p of params) {
      if (!p || typeof p !== 'object') continue;
      const key = String((p as any)['@_name'] || '').trim();
      if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key] = decodeAstTypedValue(p);
    }
  }
  return out;
}

function decodeAstTypedValue(node: any): any {
  if (node == null) return null;
  if (typeof node !== 'object') return inferScalarType(String(node));

  if (Object.prototype.hasOwnProperty.call(node, 'string')) return extractAstText((node as any).string);
  if (Object.prototype.hasOwnProperty.call(node, 'number')) return inferScalarType(extractAstText((node as any).number));
  if (Object.prototype.hasOwnProperty.call(node, 'boolean')) return inferScalarType(extractAstText((node as any).boolean));
  if (Object.prototype.hasOwnProperty.call(node, 'null')) return null;
  if (Object.prototype.hasOwnProperty.call(node, 'array')) return decodeAstArray((node as any).array);
  if (Object.prototype.hasOwnProperty.call(node, 'object')) return decodeAstObject((node as any).object);

  const hasTypedChild = ['string', 'number', 'boolean', 'null', 'array', 'object'].some((k) => Object.prototype.hasOwnProperty.call(node, k));
  if (hasTypedChild) return decodeAstTypedValue({ object: node });
  return inferScalarType(extractAstText(node));
}

function parseOperationsFromString(raw: string): any {
  const t = String(raw ?? '').trim();
  if (!t) return raw;

  if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
    try {
      return JSON.parse(t);
    } catch {
    }
  }

  const first = t.indexOf('[');
  const last = t.lastIndexOf(']');
  if (first >= 0 && last > first) {
    const sub = t.slice(first, last + 1);
    try {
      return JSON.parse(sub);
    } catch {
    }
  }

  if (/<\s*(array|object|string|number|boolean|null)\b/i.test(t)) {
    try {
      const wrapped = `<root>${t}</root>`;
      const ast = getTypedXmlParser().parse(wrapped);
      const root = (ast as any)?.root;
      if (root && typeof root === 'object') {
        const key = ['array', 'object', 'string', 'number', 'boolean', 'null'].find((k) => (root as any)[k] !== undefined);
        if (key) {
          return decodeAstTypedValue({ [key]: (root as any)[key] });
        }
      }
    } catch {
    }
  }

  const linesRaw = t.split(/\r?\n/);
  const dslOps: any[] = [];
  for (const line of linesRaw) {
    const ln = String(line || '').trim();
    if (!ln || ln.startsWith('#')) continue;
    const mSetEq = ln.match(/^set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/i);
    if (mSetEq) {
      dslOps.push({ op: 'set', key: mSetEq[1], value: mSetEq[2] ?? '' });
      continue;
    }
    const mUnset = ln.match(/^unset\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (mUnset) {
      dslOps.push({ op: 'unset', key: mUnset[1] });
      continue;
    }
  }
  if (dslOps.length > 0) return dslOps;

  return raw;
}

export function readFileTool(repoRelPath: string, maxChars: number | undefined): { success: boolean; data: any } {
  if (!repoRelPath || typeof repoRelPath !== 'string') {
    return { success: false, data: { error: 'Missing path' } };
  }
  const rel = repoRelPath.replace(/\\/g, '/');
  if (!isSafeRepoPath(rel)) {
    return { success: false, data: { error: 'Access denied' } };
  }
  const full = resolve(projectRoot(), rel);
  if (!existsSync(full)) {
    return { success: false, data: { error: 'File not found' } };
  }
  const st = statSync(full);
  if (!st.isFile()) {
    return { success: false, data: { error: 'Not a file' } };
  }

  const isImage = /\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(rel);
  if (isImage) {
    const buf = readFileSync(full);
    const ext = rel.split('.').pop() || 'png';
    return {
      success: true,
      data: {
        path: rel,
        isBinary: true,
        content: `data:image/${ext};base64,${buf.toString('base64')}`,
      },
    };
  }

  let content = readFileSync(full, 'utf-8');
  const limit = Number.isFinite(maxChars as any) && (maxChars as any) > 0 ? Number(maxChars) : 20000;
  if (content.length > limit) {
    content = content.slice(0, limit) + '\n...[内容截断]';
  }
  return { success: true, data: { path: rel, isBinary: false, content } };
}

export function listDirTool(repoRelPath: string, opts: { recursive?: boolean; max_entries?: number } = {}): { success: boolean; data: any } {
  if (!repoRelPath || typeof repoRelPath !== 'string') {
    return { success: false, data: { error: 'Missing path' } };
  }
  const rel = repoRelPath.replace(/\\/g, '/').replace(/^\.(\/|\\)/, '');
  if (!isSafeRepoPath(rel)) {
    return { success: false, data: { error: 'Access denied' } };
  }

  const recursive = !!opts.recursive;
  const maxEntriesRaw = opts.max_entries != null ? Number(opts.max_entries) : 300;
  const maxEntries = Number.isFinite(maxEntriesRaw) && maxEntriesRaw > 0 ? Math.min(2000, Math.max(1, Math.floor(maxEntriesRaw))) : 300;

  const base = resolve(projectRoot(), rel);
  if (!existsSync(base)) {
    return { success: false, data: { error: 'Path not found' } };
  }
  const st = statSync(base);
  if (!st.isDirectory()) {
    return { success: false, data: { error: 'Not a directory' } };
  }

  const entries: Array<{ path: string; type: 'file' | 'dir'; size?: number }> = [];
  const walk = (absDir: string, relDir: string) => {
    if (entries.length >= maxEntries) return;
    let items: any[] = [];
    try {
      items = readdirSync(absDir, { withFileTypes: true }) as any;
    } catch {
      return;
    }
    for (const it of items) {
      if (entries.length >= maxEntries) return;
      const name = String(it?.name || '');
      if (!name || name === '.' || name === '..') continue;
      const childRel = relDir ? `${relDir}/${name}` : name;
      const childAbs = resolve(absDir, name);
      if (it.isDirectory && it.isDirectory()) {
        entries.push({ path: `${rel}/${childRel}`.replace(/\\/g, '/'), type: 'dir' });
        if (recursive) walk(childAbs, childRel);
      } else {
        let size: number | undefined;
        try {
          const s = statSync(childAbs);
          if (s.isFile()) size = s.size;
        } catch {
        }
        entries.push({ path: `${rel}/${childRel}`.replace(/\\/g, '/'), type: 'file', size });
      }
    }
  };

  walk(base, '');

  return {
    success: true,
    data: {
      path: rel,
      recursive,
      max_entries: maxEntries,
      entries,
    },
  };
}

export function editEnvFileTool(repoRelPath: string, operations: any): { success: boolean; data: any } {
  if (!repoRelPath || typeof repoRelPath !== 'string') {
    return { success: false, data: { error: 'Missing path' } };
  }
  const rel = repoRelPath.replace(/\\/g, '/');
  if (!isSafeRepoPath(rel)) {
    return { success: false, data: { error: 'Access denied' } };
  }
  if (isBlockedWritePath(rel)) {
    return { success: false, data: { error: 'Write blocked (only .env* is editable)' } };
  }

  const full = resolve(projectRoot(), rel);
  if (!existsSync(full)) {
    const parent = dirname(full);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(full, '', 'utf-8');
  }
  const st = statSync(full);
  if (!st.isFile()) {
    return { success: false, data: { error: 'Not a file' } };
  }

  let opsInput: any = operations;
  if (typeof opsInput === 'string') {
    opsInput = parseOperationsFromString(opsInput);
  }

  if (opsInput && typeof opsInput === 'object' && !Array.isArray(opsInput) && Array.isArray((opsInput as any).operations)) {
    opsInput = (opsInput as any).operations;
  }

  if (opsInput && typeof opsInput === 'object' && !Array.isArray(opsInput) && typeof (opsInput as any).op === 'string') {
    opsInput = [opsInput];
  }

  if (!Array.isArray(opsInput) || opsInput.length === 0) {
    return {
      success: false,
      data: {
        error: 'Invalid operations: must be a non-empty array',
        received_type: typeof operations,
        received_preview: typeof operations === 'string' ? String(operations).slice(0, 200) : undefined,
      },
    };
  }

  const ops = opsInput;
  const before = readFileSync(full, 'utf-8');
  const lines = before.split(/\r?\n/);
  const applied: any[] = [];
  const warnings: string[] = [];

  const maskValuePreview = (key: string, value: any): string => {
    const k = String(key || '').toUpperCase();
    const raw = value == null ? '' : String(value);
    const shouldMask = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)/i.test(k);
    if (!shouldMask) {
      const s = raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
      return s;
    }
    if (!raw) return '';
    if (raw.length <= 8) return '****';
    return `${raw.slice(0, 3)}****${raw.slice(-4)}`;
  };

  const setKey = (key: string, value: any): { ok: boolean; changed: boolean } => {
    if (!key) return { ok: false, changed: false };
    const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`, 'i');
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln) continue;
      if (/^\s*#/.test(ln)) continue;
      if (re.test(ln)) {
        idx = i;
        break;
      }
    }
    const nextLine = `${key}=${formatEnvValue(value)}`;
    if (idx >= 0) {
      const prevLine = lines[idx];
      if (prevLine === nextLine) return { ok: true, changed: false };
      lines[idx] = nextLine;
      return { ok: true, changed: true };
    }
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(nextLine);
    return { ok: true, changed: true };
  };

  const unsetKey = (key: string) => {
    if (!key) return false;
    const re = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`, 'i');
    let removed = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (!ln) continue;
      if (/^\s*#/.test(ln)) continue;
      if (re.test(ln)) {
        lines.splice(i, 1);
        removed = true;
      }
    }
    return removed;
  };

  const replaceLine = (match: string, replacement: string) => {
    if (!match) return false;
    const idx = lines.findIndex((ln) => ln === match);
    if (idx < 0) return false;
    lines[idx] = String(replacement ?? '');
    return true;
  };

  for (const op of ops) {
    const type = String(op?.op || '').toLowerCase();
    if (type === 'set') {
      const key = String(op?.key || '').trim();
      const value = op?.value ?? '';
      const r = setKey(key, value);
      if (r.ok) {
        if (r.changed) applied.push({ op: 'set', key, value_preview: maskValuePreview(key, value) });
      } else {
        warnings.push(`set failed: ${key}`);
      }
      continue;
    }
    if (type === 'unset') {
      const key = String(op?.key || '').trim();
      const ok = unsetKey(key);
      if (ok) applied.push({ op: 'unset', key });
      else warnings.push(`unset not found: ${key}`);
      continue;
    }
    if (type === 'replace_line') {
      const match = String(op?.match || '');
      const replacement = String(op?.replacement ?? '');
      const ok = replaceLine(match, replacement);
      if (ok) applied.push({ op: 'replace_line' });
      else warnings.push('replace_line failed: match not found');
      continue;
    }

    warnings.push(`Unknown operation: ${type || '(empty)'}`);
  }

  const next = lines.join('\n');
  if (next !== before) {
    writeFileSync(full, next, 'utf-8');
  }

  if (applied.length === 0 && warnings.length > 0) {
    return {
      success: false,
      data: {
        error: 'No operations applied',
        path: rel,
        changed: false,
        applied,
        warnings,
      },
    };
  }

  return {
    success: true,
    data: {
      path: rel,
      changed: next !== before,
      applied,
      warnings,
    },
  };
}
