import type { FastifyInstance } from 'fastify';
import { join, resolve } from 'path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
} from 'fs';
import dotenv from 'dotenv';

type StickerItem = {
  filename: string;
  description: string;
  category?: string;
  tags?: string[];
  enabled?: boolean;
};

type StickersJson = {
  version: number;
  updatedAt: string;
  items: StickerItem[];
};

function getRootDir(): string {
  return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

function safeString(v: any) {
  return v == null ? '' : String(v);
}

function normalizeFilename(input: string) {
  const name = safeString(input).trim();
  if (!name) return '';
  if (name.includes('..')) return '';
  if (name.includes('/') || name.includes('\\')) return '';
  // Basic allow-list (keep it conservative)
  if (/[<>:"|?*\x00-\x1F]/.test(name)) return '';
  if (/[. ]$/.test(name)) return '';
  if (name.length > 255) return '';
  const m = name.match(/\.([a-z0-9]+)$/i);
  const ext = m ? m[1].toLowerCase() : '';
  if (!/^(png|jpg|jpeg|gif|webp|bmp|svg|ico|tif|tiff|avif|heic|heif)$/i.test(ext)) return '';
  return name;
}

function parseDataUrl(dataUrl: string) {
  const raw = safeString(dataUrl).trim();
  const m = raw.match(/^data:(image\/[^;,]+)(?:;charset=[^;,]+)?(?:;(base64))?,([\s\S]+)$/i);
  if (!m) return null;
  try {
    const isBase64 = !!m[2];
    const payload = m[3] || '';
    if (isBase64) return Buffer.from(payload, 'base64');
    try {
      return Buffer.from(decodeURIComponent(payload), 'utf-8');
    } catch {
      return Buffer.from(payload, 'utf-8');
    }
  } catch {
    return null;
  }
}

function clampInt(v: any, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.round(n);
  return Math.min(max, Math.max(min, x));
}

function getExtLower(filename: string) {
  const s = safeString(filename).trim();
  const m = s.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

async function compressWithNapiRsImage(buf: Buffer, ext: string, maxDim: number, quality: number) {
  const mod: any = await import('@napi-rs/image');
  const Transformer = mod?.Transformer;
  if (!Transformer) throw new Error('Transformer not found');
  const t = new Transformer(buf).rotate().resize(maxDim, maxDim);

  if (ext === 'jpg' || ext === 'jpeg') return await t.jpeg(quality);
  if (ext === 'png') return await t.png({ compressionType: 2 });
  if (ext === 'webp') return await t.webp(quality);
  if (ext === 'avif') return await t.avif({ quality });

  // Unsupported encode format, return null to indicate no compression
  return null;
}

async function compressWithJimp(buf: Buffer, ext: string, maxDim: number, quality: number) {
  const mod: any = await import('jimp');
  const Jimp = mod?.default || mod;
  if (!Jimp?.read) throw new Error('Jimp.read not found');

  const image = await Jimp.read(buf);
  const w = Number(image?.bitmap?.width) || 0;
  const h = Number(image?.bitmap?.height) || 0;
  const maxSide = Math.max(w, h);
  if (maxSide > maxDim && maxSide > 0) {
    const scale = maxDim / maxSide;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    image.resize(nw, nh);
  }

  if (ext === 'jpg' || ext === 'jpeg') {
    image.quality(quality);
    return await image.getBufferAsync(Jimp.MIME_JPEG);
  }
  if (ext === 'png') {
    return await image.getBufferAsync(Jimp.MIME_PNG);
  }

  // Jimp may not support all formats; return null to indicate no compression
  return null;
}

async function maybeCompressImage(params: { buf: Buffer; filename: string; compress: boolean; maxDim: number; quality: number }) {
  const { buf, filename, compress, maxDim, quality } = params;
  if (!compress) return buf;

  const ext = getExtLower(filename);
  try {
    const out = await compressWithNapiRsImage(buf, ext, maxDim, quality);
    if (out && Buffer.isBuffer(out)) return out.length < buf.length ? out : buf;
  } catch {
    // ignore, fallback below
  }

  try {
    const out = await compressWithJimp(buf, ext, maxDim, quality);
    if (out && Buffer.isBuffer(out)) return out.length < buf.length ? out : buf;
  } catch {
    // ignore
  }

  return buf;
}

function ensureDir(dirPath: string) {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
}

function emojiBaseDirAbs() {
  return join(getRootDir(), 'utils', 'emoji-stickers');
}

function emojiDirAbs() {
  return join(emojiBaseDirAbs(), 'emoji');
}

function stickersJsonAbs() {
  return join(emojiBaseDirAbs(), 'stickers.json');
}

function emojiEnvAbs() {
  return join(emojiBaseDirAbs(), '.env');
}

function readStickersJson(): StickersJson | null {
  const p = stickersJsonAbs();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const items = Array.isArray((parsed as any).items) ? (parsed as any).items : [];
    return {
      version: typeof (parsed as any).version === 'number' ? (parsed as any).version : 1,
      updatedAt: typeof (parsed as any).updatedAt === 'string' ? (parsed as any).updatedAt : new Date().toISOString(),
      items: items
        .map((it: any) => ({
          filename: safeString(it?.filename).trim(),
          description: safeString(it?.description).trim(),
          category: safeString(it?.category).trim() || undefined,
          tags: Array.isArray(it?.tags)
            ? (it.tags as any[])
                .map((t) => safeString(t).trim())
                .filter(Boolean)
            : undefined,
          enabled: typeof it?.enabled === 'boolean' ? it.enabled : true,
        }))
        .map((it: StickerItem) => {
          const tags = Array.isArray(it.tags) ? it.tags!.filter(Boolean) : [];
          if (tags.length === 0 && it.category) {
            return { ...it, tags: [it.category] };
          }
          return it;
        })
        .filter((it: StickerItem) => !!normalizeFilename(it.filename)),
    };
  } catch {
    return null;
  }
}

function readEnvMapping(): Record<string, string> {
  const p = emojiEnvAbs();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, 'utf-8');
    // dotenv.parse ignores comments and blank lines.
    const parsed = dotenv.parse(raw);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      const fn = normalizeFilename(k);
      const desc = safeString(v).trim();
      if (!fn || !desc) continue;
      out[fn] = desc;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStickersJson(items: StickerItem[]) {
  const p = stickersJsonAbs();
  const payload: StickersJson = {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: (Array.isArray(items) ? items : [])
      .map((it) => ({
        filename: normalizeFilename(it.filename),
        description: safeString(it.description).trim(),
        category: safeString(it.category).trim() || undefined,
        tags: Array.isArray(it.tags)
          ? it.tags
              .map((t) => safeString(t).trim())
              .filter(Boolean)
          : undefined,
        enabled: typeof it.enabled === 'boolean' ? it.enabled : true,
      }))
      .filter((it) => !!it.filename),
  };
  writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function writeEmojiEnv(items: StickerItem[]) {
  // Keep env simple for EmojiManager compatibility: filename=description
  const lines: string[] = [];
  for (const it of Array.isArray(items) ? items : []) {
    const fn = normalizeFilename(it.filename);
    const desc = safeString(it.description).trim();
    const enabled = it.enabled !== false;
    if (!enabled) continue;
    if (!fn || !desc) continue;
    lines.push(`${fn}=${desc}`);
  }
  writeFileSync(emojiEnvAbs(), lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
}

function writeEnvMapping(map: Record<string, string>) {
  const entries = Object.entries(map || {})
    .map(([k, v]) => [normalizeFilename(k), safeString(v).trim()] as const)
    .filter(([k, v]) => !!k && !!v);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const lines = entries.map(([k, v]) => `${k}=${v}`);
  writeFileSync(emojiEnvAbs(), lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
}

function renameEmojiFile(from: string, to: string) {
  const src = normalizeFilename(from);
  const dst = normalizeFilename(to);
  if (!src || !dst) throw new Error('Invalid filename');
  if (src === dst) return;

  ensureDir(emojiBaseDirAbs());
  ensureDir(emojiDirAbs());

  const srcAbs = join(emojiDirAbs(), src);
  const dstAbs = join(emojiDirAbs(), dst);
  if (!existsSync(srcAbs)) throw new Error('File not found');
  if (existsSync(dstAbs)) throw new Error('Target filename already exists');
  renameSync(srcAbs, dstAbs);

  const json = readStickersJson();
  const items: StickerItem[] = Array.isArray(json?.items) ? json!.items : [];
  const next = items.map(it => {
    const fn = normalizeFilename(it.filename);
    if (fn === src) return { ...it, filename: dst };
    return it;
  });
  writeStickersJson(next);
}

function listEmojiFiles() {
  const dir = emojiDirAbs();
  if (!existsSync(dir)) return [] as Array<{ filename: string; size: number; modified: string }>;
  try {
    const ents = readdirSync(dir);
    const out: Array<{ filename: string; size: number; modified: string }> = [];
    for (const e of ents) {
      const fn = normalizeFilename(e);
      if (!fn) continue;
      const abs = join(dir, fn);
      try {
        const st = statSync(abs);
        if (!st.isFile()) continue;
        out.push({ filename: fn, size: st.size, modified: st.mtime.toISOString() });
      } catch {
        // ignore
      }
    }
    out.sort((a, b) => a.filename.localeCompare(b.filename));
    return out;
  } catch {
    return [];
  }
}

export async function emojiStickersRoutes(fastify: FastifyInstance) {
  fastify.get('/api/emoji-stickers/status', async () => {
    const baseDir = emojiBaseDirAbs();
    const emojiDir = emojiDirAbs();
    const jsonPath = stickersJsonAbs();
    const envPath = emojiEnvAbs();

    const baseDirExists = existsSync(baseDir);
    const emojiDirExists = existsSync(emojiDir);
    const jsonExists = existsSync(jsonPath);
    const envExists = existsSync(envPath);

    const files = listEmojiFiles();
    const json = readStickersJson();

    return {
      baseDirRel: 'utils/emoji-stickers',
      emojiDirRel: 'utils/emoji-stickers/emoji',
      baseDirExists,
      emojiDirExists,
      stickersJsonExists: jsonExists,
      envExists,
      totalFiles: files.length,
      totalConfigured: Array.isArray(json?.items) ? json!.items.length : 0,
    };
  });

  fastify.post('/api/emoji-stickers/ensure', async () => {
    ensureDir(emojiBaseDirAbs());
    ensureDir(emojiDirAbs());

    if (!existsSync(stickersJsonAbs())) {
      writeStickersJson([]);
    }

    return { success: true };
  });

  fastify.get('/api/emoji-stickers/items', async () => {
    const files = listEmojiFiles();

    const json = readStickersJson();
    const envMap = readEnvMapping();

    // Prefer stickers.json, but if empty and env has data, synthesize items from env.
    let items: StickerItem[] = Array.isArray(json?.items) ? json!.items : [];
    if (items.length === 0 && Object.keys(envMap).length > 0) {
      items = Object.entries(envMap).map(([filename, description]) => ({ filename, description, tags: [], enabled: true }));
    }

    const byFilename = new Map<string, StickerItem>();
    for (const it of items) {
      const fn = normalizeFilename(it.filename);
      if (!fn) continue;
      byFilename.set(fn, {
        filename: fn,
        description: safeString(it.description).trim(),
        category: safeString(it.category).trim() || undefined,
        tags: Array.isArray(it.tags)
          ? it.tags
              .map((t) => safeString(t).trim())
              .filter(Boolean)
          : (safeString(it.category).trim() ? [safeString(it.category).trim()] : []),
        enabled: it.enabled !== false,
      });
    }

    // Add any files not in config.
    for (const f of files) {
      if (!byFilename.has(f.filename)) {
        byFilename.set(f.filename, {
          filename: f.filename,
          description: '',
          category: undefined,
          tags: [],
          enabled: true,
        });
      }
    }

    const merged = Array.from(byFilename.values()).sort((a, b) => a.filename.localeCompare(b.filename));

    return {
      files,
      items: merged,
    };
  });

  fastify.post('/api/emoji-stickers/items', async (request, reply) => {
    try {
      const body: any = request.body || {};
      const items: StickerItem[] = Array.isArray(body.items) ? body.items : [];
      const applyEnv = body.applyEnv === true;

      ensureDir(emojiBaseDirAbs());
      ensureDir(emojiDirAbs());

      writeStickersJson(items);
      if (applyEnv) {
        writeEmojiEnv(items);
      }

      return { success: true };
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.post('/api/emoji-stickers/rename', async (request, reply) => {
    try {
      const body: any = request.body || {};
      const from = safeString(body.from);
      const to = safeString(body.to);
      renameEmojiFile(from, to);
      return { success: true };
    } catch (e: any) {
      reply.code(400).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.post('/api/emoji-stickers/apply-env', async (_request, reply) => {
    try {
      const json = readStickersJson();
      const items = Array.isArray(json?.items) ? json!.items : [];
      ensureDir(emojiBaseDirAbs());
      ensureDir(emojiDirAbs());
      writeEmojiEnv(items);
      return { success: true };
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.post('/api/emoji-stickers/upload', async (request, reply) => {
    try {
      const body: any = request.body || {};
      const filename = normalizeFilename(body.filename);
      const dataUrl = safeString(body.dataUrl);
      const compress = body.compress === true;
      const maxDim = clampInt(body.maxDim, 32, 2048, 160);
      const quality = clampInt(body.quality, 1, 100, 80);
      if (!filename) {
        reply.code(400).send({ success: false, error: 'Invalid filename' });
        return;
      }
      const buf = parseDataUrl(dataUrl);
      if (!buf) {
        reply.code(400).send({ success: false, error: 'Invalid dataUrl (expected data:image/*;base64,...)' });
        return;
      }

      ensureDir(emojiBaseDirAbs());
      ensureDir(emojiDirAbs());

      const abs = join(emojiDirAbs(), filename);
      const outBuf = await maybeCompressImage({ buf, filename, compress, maxDim, quality });
      writeFileSync(abs, outBuf);

      return { success: true };
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });

  fastify.delete('/api/emoji-stickers/file', async (request, reply) => {
    try {
      const q: any = (request as any).query || {};
      const filename = normalizeFilename(q.filename);
      if (!filename) {
        reply.code(400).send({ success: false, error: 'Invalid filename' });
        return;
      }
      const abs = join(emojiDirAbs(), filename);
      if (!existsSync(abs)) {
        reply.code(404).send({ success: false, error: 'File not found' });
        return;
      }
      unlinkSync(abs);

      // Also remove config entries to avoid stale items.
      try {
        ensureDir(emojiBaseDirAbs());
        ensureDir(emojiDirAbs());

        const json = readStickersJson();
        const items: StickerItem[] = Array.isArray(json?.items) ? json!.items : [];
        const nextItems = items.filter((it) => normalizeFilename(it.filename) !== filename);
        if (json) {
          writeStickersJson(nextItems);
        }

        // Always remove the corresponding env entry only (do not rewrite whole env).
        const envMap = readEnvMapping();
        if (envMap[filename]) {
          delete envMap[filename];
          writeEnvMapping(envMap);
        }
      } catch {
        // ignore config cleanup errors; file deletion already succeeded
      }

      return { success: true };
    } catch (e: any) {
      reply.code(500).send({ success: false, error: e?.message || String(e) });
    }
  });
}
