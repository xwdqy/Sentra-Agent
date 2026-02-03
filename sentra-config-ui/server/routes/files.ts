import { FastifyInstance } from 'fastify';
import { join, resolve, relative, dirname, isAbsolute } from 'path';
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, rmSync, createReadStream } from 'fs';
import { getRuntimeConfig } from '../utils/runtimeConfig.ts';

// Helper to get root directory
function getRootDir(): string {
    return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

// Helper to check if path is safe (inside root)
function isSafePath(targetPath: string): boolean {
    const rootDir = getRootDir();
    const resolvedPath = resolve(rootDir, targetPath);
    const rel = relative(rootDir, resolvedPath);
    if (!rel) return true;
    if (rel.startsWith('..')) return false;
    if (isAbsolute(rel)) return false;
    return true;
}

// Helper to get absolute path
function getAbsolutePath(targetPath: string): string {
    return resolve(getRootDir(), targetPath);
}

function parseDotEnv(content: string): Record<string, string> {
    const out: Record<string, string> = {};
    const lines = String(content || '').split(/\r?\n/);
    for (const raw of lines) {
        const line = String(raw || '').trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const k = line.slice(0, idx).trim();
        let v = line.slice(idx + 1).trim();
        if (!k) continue;
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        out[k] = v;
    }
    return out;
}

function getNapcatEnvParsed(): { envPath?: string; vars: Record<string, string> } {
    const root = getRootDir();
    const override = String(process.env.NAPCAT_ENV_PATH || '').trim();
    const candidates = [
        override,
        join(root, 'sentra-adapter', 'napcat', '.env'),
        join(root, 'sentra-adapter', 'napcat', '.env.example'),
    ].filter(Boolean);

    for (const p of candidates) {
        try {
            const full = resolve(p);
            if (!existsSync(full)) continue;
            const content = readFileSync(full, 'utf-8');
            return { envPath: full, vars: parseDotEnv(content) };
        } catch {
        }
    }
    return { vars: {} };
}

function normalizeAbs(p: string): string {
    try {
        return resolve(p);
    } catch {
        return p;
    }
}

function normalizeAbsCompare(p: string): string {
    const abs = normalizeAbs(p);
    const norm = abs.replace(/\//g, '\\');
    if (process.platform === 'win32') return norm.toLowerCase();
    return norm;
}

function isAllowedAbsolutePath(absPath: string): boolean {
    const absRaw = normalizeAbs(absPath);
    const abs = normalizeAbsCompare(absRaw);
    const root = getRootDir();
    const allow: string[] = [];

    // Always allow Sentra-root relative by default (handled elsewhere)

    // Allow napcat cache dirs (env-driven)
    try {
        const { vars } = getNapcatEnvParsed();
        const imgDir = String(vars.IMAGE_CACHE_DIR || '').trim();
        const fileDir = String(vars.FILE_CACHE_DIR || '').trim();
        if (imgDir) allow.push(normalizeAbs(imgDir));
        if (fileDir) allow.push(normalizeAbs(fileDir));
    } catch {
    }

    // Allow default napcat cache under repo
    allow.push(normalizeAbs(join(root, 'sentra-adapter', 'napcat', 'cache')));
    allow.push(normalizeAbs(join(root, 'sentra-adapter', 'napcat', 'cache', 'images')));
    allow.push(normalizeAbs(join(root, 'sentra-adapter', 'napcat', 'cache', 'file')));

    // Extra allowlist via env (comma-separated)
    // Backward compatibility: also accept semicolon-separated.
    try {
        const parts = getRuntimeConfig().filesRawAllowDirs;
        for (const item of parts) {
            allow.push(normalizeAbs(item));
        }
    } catch {
    }

    for (const dir of allow) {
        if (!dir) continue;
        const d = normalizeAbsCompare(dir);
        if (abs === d) return true;
        const d1 = d.endsWith('\\') ? d : (d + '\\');
        if (abs.startsWith(d1)) {
            return true;
        }
    }
    return false;
}

const IGNORED_DIRS = ['node_modules', '.git', '.cache', 'dist', 'build', 'coverage', '.idea', '.vscode'];
const IGNORED_FILES = ['.DS_Store', 'Thumbs.db'];

type CacheEntry<T> = {
    expiresAt: number;
    etag: string;
    payload: T;
};

function getTreeCacheTtlMs(): number {
    try {
        return getRuntimeConfig().fileTreeCacheTtlMs;
    } catch {
        return clampInt(process.env.FILE_TREE_CACHE_TTL_MS, 0, 60_000, 6_000);
    }
}

function getSearchCacheTtlMs(): number {
    try {
        return getRuntimeConfig().fileSearchCacheTtlMs;
    } catch {
        return clampInt(process.env.FILE_SEARCH_CACHE_TTL_MS, 0, 60_000, 4_000);
    }
}

const treeCache = new Map<string, CacheEntry<any>>();
const treeInflight = new Map<string, Promise<{ payload: any; etag: string }>>();

const grepCache = new Map<string, CacheEntry<any>>();
const grepInflight = new Map<string, Promise<{ payload: any; etag: string }>>();

const symbolsCache = new Map<string, CacheEntry<any>>();
const symbolsInflight = new Map<string, Promise<{ payload: any; etag: string }>>();

function maybeTrimCache(map: Map<string, any>, maxSize: number) {
    if (map.size <= maxSize) return;
    map.clear();
}

function sendWithEtag(reply: any, etag: string) {
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
    reply.header('ETag', etag);
}

function isBinaryLikePath(p: string): boolean {
    return /\.(jpg|jpeg|png|gif|webp|svg|ico|bmp|tiff|mp4|mov|avi|mkv|zip|gz|tar|7z|rar|exe|dll|bin)$/i.test(p);
}

function shouldScanTextFile(p: string): boolean {
    if (isBinaryLikePath(p)) return false;
    if (/\.(lock|min\.js|min\.css)$/i.test(p)) return false;
    return true;
}

function clampInt(n: any, min: number, max: number, fallback: number) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(v)));
}

export async function fileRoutes(fastify: FastifyInstance) {
    fastify.get<{
        Querystring: { path: string; download?: string };
    }>('/api/files/raw', async (request, reply) => {
        try {
            const path = String(request.query.path || '');
            if (!path) return reply.code(400).send({ error: 'Missing path' });

            const allowAny = (() => {
                try {
                    return !!getRuntimeConfig().filesRawAllowAny;
                } catch {
                    const v = String(process.env.FILES_RAW_ALLOW_ANY || '').trim().toLowerCase();
                    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
                }
            })();

            const isAbs = isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
            const fullPath = isAbs ? normalizeAbs(path) : getAbsolutePath(path);

            if (!allowAny) {
                if (isAbs) {
                    if (!isAllowedAbsolutePath(fullPath)) {
                        return reply.code(403).send({ error: 'Access denied' });
                    }
                } else {
                    if (!isSafePath(path)) {
                        return reply.code(403).send({ error: 'Access denied' });
                    }
                }
            }

            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'File not found' });
            }

            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                return reply.code(400).send({ error: 'Cannot stream directory' });
            }

            const name = fullPath.split(/[/\\]/).pop() || 'file';
            const ext = name.toLowerCase().split('.').pop() || '';
            const type = (() => {
                if (/(jpg|jpeg)$/i.test(ext)) return 'image/jpeg';
                if (/png$/i.test(ext)) return 'image/png';
                if (/gif$/i.test(ext)) return 'image/gif';
                if (/webp$/i.test(ext)) return 'image/webp';
                if (/svg$/i.test(ext)) return 'image/svg+xml';
                if (/mp4$/i.test(ext)) return 'video/mp4';
                if (/mov$/i.test(ext)) return 'video/quicktime';
                if (/mkv$/i.test(ext)) return 'video/x-matroska';
                if (/mp3$/i.test(ext)) return 'audio/mpeg';
                if (/wav$/i.test(ext)) return 'audio/wav';
                if (/ogg$/i.test(ext)) return 'audio/ogg';
                if (/amr$/i.test(ext)) return 'audio/amr';
                return 'application/octet-stream';
            })();

            reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
            reply.type(type);
            if (String(request.query.download || '') === '1') {
                reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
            }

            const stream = createReadStream(fullPath);
            return reply.send(stream);
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to stream file',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Get file tree
    fastify.get<{
        Querystring: { path?: string };
    }>('/api/files/tree', async (request, reply) => {
        try {
            const relPath = request.query.path || '';

            if (!isSafePath(relPath)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(relPath);

            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Path not found' });
            }

            const stat = statSync(fullPath);
            if (!stat.isDirectory()) {
                return reply.code(400).send({ error: 'Path is not a directory' });
            }

            const cacheKey = `tree:${relPath}`;
            const ifNoneMatch = String(request.headers['if-none-match'] || '');
            const now = Date.now();

            const TREE_CACHE_TTL_MS = getTreeCacheTtlMs();

            if (TREE_CACHE_TTL_MS > 0) {
                const cached = treeCache.get(cacheKey);
                if (cached && cached.expiresAt > now) {
                    sendWithEtag(reply, cached.etag);
                    if (ifNoneMatch && ifNoneMatch === cached.etag) {
                        return reply.code(304).send();
                    }
                    return cached.payload;
                }
            }

            const inflight = treeInflight.get(cacheKey);
            if (inflight) {
                const resolved = await inflight;
                sendWithEtag(reply, resolved.etag);
                if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                    return reply.code(304).send();
                }
                return resolved.payload;
            }

            // Recursive scan function
            const job = (async () => {
                const results: any[] = [];

                const scanDir = (dir: string, baseDir: string) => {
                    const items = readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        const name = item.name;
                        if (IGNORED_DIRS.includes(name)) continue;
                        if (IGNORED_FILES.includes(name)) continue;

                        const fullItemPath = join(dir, name);
                        const relativePath = relative(baseDir, fullItemPath).replace(/\\/g, '/');

                        if (item.isDirectory()) {
                            let mtime = new Date(0);
                            try {
                                const st = statSync(fullItemPath);
                                mtime = st.mtime;
                            } catch {
                                // ignore
                            }
                            results.push({
                                name,
                                path: relativePath,
                                type: 'directory',
                                size: 0,
                                modified: mtime.toISOString(),
                            });
                            scanDir(fullItemPath, baseDir);
                            continue;
                        }

                        if (item.isFile()) {
                            try {
                                const st = statSync(fullItemPath);
                                results.push({
                                    name,
                                    path: relativePath,
                                    type: 'file',
                                    size: st.size,
                                    modified: st.mtime.toISOString(),
                                });
                            } catch {
                                // ignore
                            }
                        }
                    }
                };

                scanDir(fullPath, fullPath);

                const etag = `W/\"tree-${Date.now()}-${results.length}\"`;
                return { payload: results, etag };
            })();

            treeInflight.set(cacheKey, job);
            const resolved = await job;
            treeInflight.delete(cacheKey);

            if (TREE_CACHE_TTL_MS > 0) {
                treeCache.set(cacheKey, { expiresAt: now + TREE_CACHE_TTL_MS, etag: resolved.etag, payload: resolved.payload });
                maybeTrimCache(treeCache, 120);
            }

            sendWithEtag(reply, resolved.etag);
            if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                return reply.code(304).send();
            }

            const result = resolved.payload;

            // Sort by path to ensure hierarchy order (optional, but helpful)
            // Actually frontend builder handles it if we have all nodes.

            return result;
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to list files',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Get file content
    fastify.get<{
        Querystring: { path: string };
    }>('/api/files/content', async (request, reply) => {
        try {
            const { path } = request.query;
            if (!path) return reply.code(400).send({ error: 'Missing path' });

            if (!isSafePath(path)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(path);
            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'File not found' });
            }

            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                return reply.code(400).send({ error: 'Cannot read directory content' });
            }

            // Check if binary (simple check by extension)
            const isImage = /\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(path);

            if (isImage) {
                const buffer = readFileSync(fullPath);
                return {
                    content: `data:image/${path.split('.').pop()};base64,${buffer.toString('base64')}`,
                    isBinary: true
                };
            } else {
                const content = readFileSync(fullPath, 'utf-8');
                return { content, isBinary: false };
            }
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to read file',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    fastify.get<{
        Querystring: { q: string; path?: string; maxResults?: string; caseSensitive?: string };
    }>('/api/files/grep', async (request, reply) => {
        try {
            const q = (request.query.q || '').trim();
            if (!q) return reply.code(400).send({ error: 'Missing q' });

            const relPath = (request.query.path || '').trim();
            if (!isSafePath(relPath)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(relPath);
            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Path not found' });
            }

            const maxResults = clampInt(request.query.maxResults, 1, 500, 200);
            const caseSensitive = String(request.query.caseSensitive || '') === 'true';
            const needle = caseSensitive ? q : q.toLowerCase();

            const cacheKey = `grep:${relPath}|${caseSensitive ? '1' : '0'}|${maxResults}|${needle}`;
            const ifNoneMatch = String(request.headers['if-none-match'] || '');
            const now = Date.now();

            const SEARCH_CACHE_TTL_MS = getSearchCacheTtlMs();

            if (SEARCH_CACHE_TTL_MS > 0) {
                const cached = grepCache.get(cacheKey);
                if (cached && cached.expiresAt > now) {
                    sendWithEtag(reply, cached.etag);
                    if (ifNoneMatch && ifNoneMatch === cached.etag) {
                        return reply.code(304).send();
                    }
                    return cached.payload;
                }
            }

            const inflight = grepInflight.get(cacheKey);
            if (inflight) {
                const resolved = await inflight;
                sendWithEtag(reply, resolved.etag);
                if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                    return reply.code(304).send();
                }
                return resolved.payload;
            }

            const job = (async () => {
                const results: Array<{ path: string; line: number; text: string }> = [];

                const scanFile = (fullItemPath: string, relativePath: string) => {
                    if (!shouldScanTextFile(relativePath)) return;
                    let st;
                    try {
                        st = statSync(fullItemPath);
                    } catch {
                        return;
                    }
                    if (!st.isFile()) return;
                    if (st.size > 1024 * 1024) return;

                    let content = '';
                    try {
                        content = readFileSync(fullItemPath, 'utf-8');
                    } catch {
                        return;
                    }

                    const lines = content.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const hay = caseSensitive ? line : line.toLowerCase();
                        if (!hay.includes(needle)) continue;
                        results.push({
                            path: relativePath,
                            line: i + 1,
                            text: String(line).trim().slice(0, 260),
                        });
                        if (results.length >= maxResults) return true;
                    }
                    return false;
                };

                const scanDir = (dir: string, baseDir: string): boolean => {
                    const items = readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        const name = item.name;
                        if (IGNORED_DIRS.includes(name)) continue;
                        if (IGNORED_FILES.includes(name)) continue;

                        const fullItemPath = join(dir, name);
                        const relativePath = relative(baseDir, fullItemPath).replace(/\\/g, '/');

                        if (item.isDirectory()) {
                            const shouldStop = scanDir(fullItemPath, baseDir);
                            if (shouldStop) return true;
                            continue;
                        }

                        if (item.isFile()) {
                            const shouldStop = scanFile(fullItemPath, relativePath);
                            if (shouldStop) return true;
                        }
                    }
                    return false;
                };

                let rootStat;
                try {
                    rootStat = statSync(fullPath);
                } catch {
                    rootStat = null;
                }

                if (rootStat?.isDirectory()) {
                    scanDir(fullPath, fullPath);
                } else {
                    scanFile(fullPath, relPath);
                }

                const payload = { results };
                const etag = `W/\"grep-${Date.now()}-${results.length}\"`;
                return { payload, etag };
            })();

            grepInflight.set(cacheKey, job);
            const resolved = await job;
            grepInflight.delete(cacheKey);

            if (SEARCH_CACHE_TTL_MS > 0) {
                grepCache.set(cacheKey, { expiresAt: now + SEARCH_CACHE_TTL_MS, etag: resolved.etag, payload: resolved.payload });
                maybeTrimCache(grepCache, 200);
            }

            sendWithEtag(reply, resolved.etag);
            if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                return reply.code(304).send();
            }

            return resolved.payload;
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to grep files',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    fastify.get<{
        Querystring: { q?: string; path?: string; maxResults?: string };
    }>('/api/files/symbols', async (request, reply) => {
        try {
            const q = (request.query.q || '').trim();
            const relPath = (request.query.path || '').trim();
            if (!isSafePath(relPath)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(relPath);
            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Path not found' });
            }

            const maxResults = clampInt(request.query.maxResults, 1, 800, 300);
            const needle = q ? q.toLowerCase() : '';

            const cacheKey = `symbols:${relPath}|${maxResults}|${needle}`;
            const ifNoneMatch = String(request.headers['if-none-match'] || '');
            const now = Date.now();

            const SEARCH_CACHE_TTL_MS = getSearchCacheTtlMs();

            if (SEARCH_CACHE_TTL_MS > 0) {
                const cached = symbolsCache.get(cacheKey);
                if (cached && cached.expiresAt > now) {
                    sendWithEtag(reply, cached.etag);
                    if (ifNoneMatch && ifNoneMatch === cached.etag) {
                        return reply.code(304).send();
                    }
                    return cached.payload;
                }
            }

            const inflight = symbolsInflight.get(cacheKey);
            if (inflight) {
                const resolved = await inflight;
                sendWithEtag(reply, resolved.etag);
                if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                    return reply.code(304).send();
                }
                return resolved.payload;
            }

            const job = (async () => {
                const results: Array<{ path: string; line: number; kind: string; symbol: string }> = [];

                const isCodeFile = (p: string) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rs|c|cc|cpp|h|hpp)$/i.test(p);

                const scanFile = (absPath: string, rel: string) => {
                    if (!isCodeFile(rel)) return;
                    let st;
                    try {
                        st = statSync(absPath);
                    } catch {
                        return;
                    }
                    if (!st.isFile()) return;
                    if (st.size > 1024 * 1024) return;
                    let content = '';
                    try {
                        content = readFileSync(absPath, 'utf-8');
                    } catch {
                        return;
                    }

                    const lines = content.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const trimmed = line.trim();

                        let m: RegExpMatchArray | null = null;

                        m = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/);
                        if (m) {
                            const sym = m[1];
                            if (!needle || sym.toLowerCase().includes(needle)) {
                                results.push({ path: rel, line: i + 1, kind: 'function', symbol: sym });
                                if (results.length >= maxResults) return;
                            }
                            continue;
                        }

                        m = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z0-9_$]+)\b/);
                        if (m) {
                            const sym = m[1];
                            if (!needle || sym.toLowerCase().includes(needle)) {
                                results.push({ path: rel, line: i + 1, kind: 'class', symbol: sym });
                                if (results.length >= maxResults) return;
                            }
                            continue;
                        }

                        m = trimmed.match(/^def\s+([A-Za-z0-9_]+)\s*\(/);
                        if (m) {
                            const sym = m[1];
                            if (!needle || sym.toLowerCase().includes(needle)) {
                                results.push({ path: rel, line: i + 1, kind: 'function', symbol: sym });
                                if (results.length >= maxResults) return;
                            }
                            continue;
                        }

                        m = trimmed.match(/^class\s+([A-Za-z0-9_]+)\b/);
                        if (m && /\.py$/i.test(rel)) {
                            const sym = m[1];
                            if (!needle || sym.toLowerCase().includes(needle)) {
                                results.push({ path: rel, line: i + 1, kind: 'class', symbol: sym });
                                if (results.length >= maxResults) return;
                            }
                            continue;
                        }

                        m = trimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*\(/);
                        if (m) {
                            const sym = m[1];
                            if (!needle || sym.toLowerCase().includes(needle)) {
                                results.push({ path: rel, line: i + 1, kind: 'function', symbol: sym });
                                if (results.length >= maxResults) return;
                            }
                            continue;
                        }
                    }
                };

                const scanDir = (dir: string, baseDir: string): boolean => {
                    const items = readdirSync(dir, { withFileTypes: true });
                    for (const item of items) {
                        const name = item.name;
                        if (IGNORED_DIRS.includes(name)) continue;
                        if (IGNORED_FILES.includes(name)) continue;

                        const fullItemPath = join(dir, name);
                        const rel = relative(baseDir, fullItemPath).replace(/\\/g, '/');

                        if (item.isDirectory()) {
                            const stop = scanDir(fullItemPath, baseDir);
                            if (stop) return true;
                            continue;
                        }

                        if (item.isFile()) {
                            scanFile(fullItemPath, rel);
                            if (results.length >= maxResults) return true;
                        }
                    }
                    return false;
                };

                let rootStat;
                try {
                    rootStat = statSync(fullPath);
                } catch {
                    rootStat = null;
                }

                if (rootStat?.isDirectory()) {
                    scanDir(fullPath, fullPath);
                } else {
                    scanFile(fullPath, relPath);
                }

                const payload = { results };
                const etag = `W/\"symbols-${Date.now()}-${results.length}\"`;
                return { payload, etag };
            })();

            symbolsInflight.set(cacheKey, job);
            const resolved = await job;
            symbolsInflight.delete(cacheKey);

            if (SEARCH_CACHE_TTL_MS > 0) {
                symbolsCache.set(cacheKey, { expiresAt: now + SEARCH_CACHE_TTL_MS, etag: resolved.etag, payload: resolved.payload });
                maybeTrimCache(symbolsCache, 200);
            }

            sendWithEtag(reply, resolved.etag);
            if (ifNoneMatch && ifNoneMatch === resolved.etag) {
                return reply.code(304).send();
            }

            return resolved.payload;
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to search symbols',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Save file content
    fastify.post<{
        Body: { path: string; content: string };
    }>('/api/files/content', async (request, reply) => {
        try {
            const { path, content } = request.body;
            if (!path) return reply.code(400).send({ error: 'Missing path' });

            if (!isSafePath(path)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(path);

            // Ensure parent dir exists
            const parentDir = dirname(fullPath);
            if (!existsSync(parentDir)) {
                mkdirSync(parentDir, { recursive: true });
            }

            writeFileSync(fullPath, content, 'utf-8');
            return { success: true };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to save file',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Create file or directory
    fastify.post<{
        Body: { path: string; type: 'file' | 'directory' };
    }>('/api/files/create', async (request, reply) => {
        try {
            const { path, type } = request.body;
            if (!path || !type) return reply.code(400).send({ error: 'Missing parameters' });

            if (!isSafePath(path)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(path);
            if (existsSync(fullPath)) {
                return reply.code(400).send({ error: 'Path already exists' });
            }

            if (type === 'directory') {
                mkdirSync(fullPath, { recursive: true });
            } else {
                // Ensure parent dir exists
                const parentDir = dirname(fullPath);
                if (!existsSync(parentDir)) {
                    mkdirSync(parentDir, { recursive: true });
                }
                writeFileSync(fullPath, '', 'utf-8');
            }

            return { success: true };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to create item',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Rename
    fastify.post<{
        Body: { oldPath: string; newPath: string };
    }>('/api/files/rename', async (request, reply) => {
        try {
            const { oldPath, newPath } = request.body;
            if (!oldPath || !newPath) return reply.code(400).send({ error: 'Missing parameters' });

            if (!isSafePath(oldPath) || !isSafePath(newPath)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullOldPath = getAbsolutePath(oldPath);
            const fullNewPath = getAbsolutePath(newPath);

            if (!existsSync(fullOldPath)) {
                return reply.code(404).send({ error: 'Source path not found' });
            }
            if (existsSync(fullNewPath)) {
                return reply.code(400).send({ error: 'Destination path already exists' });
            }

            renameSync(fullOldPath, fullNewPath);
            return { success: true };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to rename',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Delete
    fastify.delete<{
        Querystring: { path: string };
    }>('/api/files/delete', async (request, reply) => {
        try {
            const { path } = request.query;
            if (!path) return reply.code(400).send({ error: 'Missing path' });

            if (!isSafePath(path)) {
                return reply.code(403).send({ error: 'Access denied' });
            }

            const fullPath = getAbsolutePath(path);
            if (!existsSync(fullPath)) {
                return reply.code(404).send({ error: 'Path not found' });
            }

            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                rmSync(fullPath, { recursive: true, force: true });
            } else {
                unlinkSync(fullPath);
            }

            return { success: true };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to delete',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
