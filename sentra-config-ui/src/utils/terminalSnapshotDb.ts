export type TerminalSnapshotKind = 'script' | 'exec';

export type TerminalSnapshotRecord = {
  id: string;
  kind: TerminalSnapshotKind;
  ts: number;
  cursor: number;
  snapshot: string;
};

const DB_NAME = 'sentra_terminal_snapshots_v1';
const STORE_META = 'snapshots';
const STORE_CHUNKS = 'snapshot_chunks';
const DB_VERSION = 2;

type TerminalSnapshotMeta = {
  key: string;
  id: string;
  kind: TerminalSnapshotKind;
  ts: number;
  cursor: number;
  snapshot?: string;
  mode?: 'chunked';
  lastSeq?: number;
  headSeq?: number;
  totalChars?: number;
  chunkCount?: number;
};

type TerminalSnapshotChunk = {
  key: string;
  owner: string;
  seq: number;
  ts: number;
  cursor: number;
  data: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          const st = db.createObjectStore(STORE_CHUNKS, { keyPath: 'key' });
          try {
            st.createIndex('owner', 'owner', { unique: false });
          } catch {
          }
        } else {
          try {
            const tx = req.transaction;
            const st = tx?.objectStore(STORE_CHUNKS);
            if (st && !st.indexNames.contains('owner')) {
              st.createIndex('owner', 'owner', { unique: false });
            }
          } catch {
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

function makeKey(kind: TerminalSnapshotKind, id: string) {
  return `${kind}:${String(id || '')}`;
}

function withTx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (st: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(store, mode);
      const st = tx.objectStore(store);
      const req = fn(st);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    } catch (e) {
      reject(e);
    }
  });
}

function padSeq(n: number) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return String(v).padStart(12, '0');
}

function chunkKey(owner: string, seq: number) {
  return `${owner}:chunk:${padSeq(seq)}`;
}

async function loadAllChunks(db: IDBDatabase, owner: string): Promise<TerminalSnapshotChunk[]> {
  return new Promise((resolve) => {
    const out: TerminalSnapshotChunk[] = [];
    try {
      const tx = db.transaction(STORE_CHUNKS, 'readonly');
      const st = tx.objectStore(STORE_CHUNKS);
      let idx: IDBIndex | null = null;
      try {
        idx = st.index('owner');
      } catch {
        idx = null;
      }

      const range = IDBKeyRange.only(owner);
      const req = (idx ? idx.openCursor(range) : st.openCursor());
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const v: any = cur.value;
        if (!idx) {
          if (String(v?.owner || '') !== owner) {
            try { cur.continue(); } catch { }
            return;
          }
        }
        const data = typeof v?.data === 'string' ? v.data : '';
        out.push({
          key: String(v?.key || ''),
          owner: String(v?.owner || owner),
          seq: Number(v?.seq || 0),
          ts: Number(v?.ts || 0),
          cursor: Number(v?.cursor || 0),
          data,
        });
        try { cur.continue(); } catch { }
      };
      req.onerror = () => resolve(out);
      tx.oncomplete = () => resolve(out);
      tx.onabort = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

async function deleteChunksByOwner(db: IDBDatabase, owner: string): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_CHUNKS, 'readwrite');
      const st = tx.objectStore(STORE_CHUNKS);
      let idx: IDBIndex | null = null;
      try {
        idx = st.index('owner');
      } catch {
        idx = null;
      }
      const range = IDBKeyRange.only(owner);
      const req = (idx ? idx.openCursor(range) : st.openCursor());
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const v: any = cur.value;
        if (!idx) {
          if (String(v?.owner || '') !== owner) {
            try { cur.continue(); } catch { }
            return;
          }
        }
        try { cur.delete(); } catch { }
        try { cur.continue(); } catch { }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function getTerminalSnapshot(kind: TerminalSnapshotKind, id: string): Promise<TerminalSnapshotRecord | null> {
  const key = makeKey(kind, id);
  try {
    const db = await openDb();
    try {
      const raw = await withTx<any>(db, STORE_META, 'readonly', (st) => st.get(key));
      if (!raw) return null;

      const recKind: TerminalSnapshotKind = raw.kind === 'exec' ? 'exec' : 'script';
      const ts = Number(raw.ts || 0);
      const cursor = Number(raw.cursor || 0);

      if (raw.mode === 'chunked') {
        const owner = makeKey(recKind, id);
        const chunks = await loadAllChunks(db, owner);
        const snapshot = chunks.map(c => String(c.data || '')).join('');
        return {
          id: String(raw.id || ''),
          kind: recKind,
          ts,
          cursor,
          snapshot,
        };
      }

      return {
        id: String(raw.id || ''),
        kind: recKind,
        ts,
        cursor,
        snapshot: typeof raw.snapshot === 'string' ? raw.snapshot : '',
      };
    } finally {
      try { db.close(); } catch { }
    }
  } catch {
    return null;
  }
}

export async function setTerminalSnapshot(rec: TerminalSnapshotRecord): Promise<boolean> {
  const key = makeKey(rec.kind, rec.id);
  try {
    const db = await openDb();
    try {
      await withTx(db, STORE_META, 'readwrite', (st) => st.put({
          key,
          id: String(rec.id || ''),
          kind: rec.kind,
          ts: Number(rec.ts || 0),
          cursor: Number.isFinite(Number(rec.cursor)) ? Number(rec.cursor) : 0,
          snapshot: String(rec.snapshot || ''),
        }));
      return true;
    } finally {
      try { db.close(); } catch { }
    }
  } catch {
    return false;
  }
}

export async function appendTerminalSnapshotChunk(rec: { id: string; kind: TerminalSnapshotKind; ts: number; cursor: number; chunk: string }): Promise<boolean> {
  const id = String(rec.id || '');
  if (!id) return false;
  const kind: TerminalSnapshotKind = rec.kind === 'exec' ? 'exec' : 'script';
  const owner = makeKey(kind, id);
  const metaKey = owner;
  const ts = Number(rec.ts || 0);
  const cursor = Number.isFinite(Number(rec.cursor)) ? Number(rec.cursor) : 0;
  const chunk = String(rec.chunk || '');
  if (!chunk) return true;

  const MAX_TOTAL_CHARS = 200_000;
  const MAX_CHUNK_COUNT = 200;
  const MERGE_TARGET = 120;

  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        try {
          const tx = db.transaction([STORE_META, STORE_CHUNKS], 'readwrite');
          const metaSt = tx.objectStore(STORE_META);
          const chunkSt = tx.objectStore(STORE_CHUNKS);

          const getReq = metaSt.get(metaKey);
          getReq.onerror = () => reject(getReq.error);
          getReq.onsuccess = async () => {
            const raw: any = getReq.result;
            const meta: TerminalSnapshotMeta = raw && typeof raw === 'object'
              ? {
                  key: String(raw.key || metaKey),
                  id: String(raw.id || id),
                  kind: raw.kind === 'exec' ? 'exec' : 'script',
                  ts: Number(raw.ts || 0),
                  cursor: Number(raw.cursor || 0),
                  snapshot: typeof raw.snapshot === 'string' ? raw.snapshot : undefined,
                  mode: raw.mode === 'chunked' ? 'chunked' : undefined,
                  lastSeq: Number(raw.lastSeq || 0) || 0,
                  headSeq: Number(raw.headSeq || 0) || 0,
                  totalChars: Number(raw.totalChars || 0) || 0,
                  chunkCount: Number(raw.chunkCount || 0) || 0,
                }
              : {
                  key: metaKey,
                  id,
                  kind,
                  ts: 0,
                  cursor: 0,
                  mode: 'chunked',
                  lastSeq: 0,
                  headSeq: 0,
                  totalChars: 0,
                  chunkCount: 0,
                };

            meta.mode = 'chunked';
            meta.snapshot = undefined;
            meta.ts = ts;
            meta.cursor = cursor;

            const nextSeq = (meta.lastSeq || 0) + 1;
            meta.lastSeq = nextSeq;
            if (!meta.headSeq || meta.headSeq <= 0) meta.headSeq = nextSeq;

            const data = chunk;
            const ckey = chunkKey(owner, nextSeq);
            const crec: TerminalSnapshotChunk = { key: ckey, owner, seq: nextSeq, ts, cursor, data };
            try { chunkSt.put(crec as any); } catch { }

            meta.totalChars = (meta.totalChars || 0) + data.length;
            meta.chunkCount = (meta.chunkCount || 0) + 1;

            const trimOldest = () => {
              try {
                const idx = chunkSt.index('owner');
                const range = IDBKeyRange.only(owner);
                const curReq = idx.openCursor(range);
                curReq.onsuccess = () => {
                  const cur = curReq.result;
                  if (!cur) {
                    try { metaSt.put(meta as any); } catch { }
                    return;
                  }

                  const v: any = cur.value;
                  const vData = typeof v?.data === 'string' ? v.data : '';
                  const vSeq = Number(v?.seq || 0);

                  const overChars = (meta.totalChars || 0) > MAX_TOTAL_CHARS;
                  const overCount = (meta.chunkCount || 0) > MAX_CHUNK_COUNT;
                  if (!overChars && !overCount) {
                    if ((meta.chunkCount || 0) > MERGE_TARGET) {
                      try {
                        const allReq = idx.openCursor(range);
                        const parts: string[] = [];
                        const delKeys: string[] = [];
                        allReq.onsuccess = () => {
                          const c2 = allReq.result;
                          if (!c2) {
                            if (parts.length >= 2) {
                              const merged = parts.join('');
                              const mergeSeq = (meta.headSeq || 1);
                              const mergeKey = chunkKey(owner, mergeSeq);
                              const mergedRec: TerminalSnapshotChunk = {
                                key: mergeKey,
                                owner,
                                seq: mergeSeq,
                                ts: meta.ts || ts,
                                cursor: meta.cursor || cursor,
                                data: merged,
                              };
                              try { chunkSt.put(mergedRec as any); } catch { }
                              for (const dk of delKeys) {
                                if (dk !== mergeKey) {
                                  try { chunkSt.delete(dk); } catch { }
                                }
                              }
                              meta.chunkCount = Math.max(1, (meta.chunkCount || 0) - (delKeys.length - 1));
                            }
                            try { metaSt.put(meta as any); } catch { }
                            return;
                          }
                          const v2: any = c2.value;
                          const k2 = String(v2?.key || '');
                          if ((meta.chunkCount || 0) <= MERGE_TARGET) {
                            try { metaSt.put(meta as any); } catch { }
                            return;
                          }
                          if (parts.length < 40) {
                            delKeys.push(k2);
                            parts.push(typeof v2?.data === 'string' ? v2.data : '');
                          }
                          try { c2.continue(); } catch { }
                        };
                        allReq.onerror = () => {
                          try { metaSt.put(meta as any); } catch { }
                        };
                        return;
                      } catch {
                      }
                    }
                    try { metaSt.put(meta as any); } catch { }
                    return;
                  }

                  try { cur.delete(); } catch { }
                  meta.totalChars = Math.max(0, (meta.totalChars || 0) - vData.length);
                  meta.chunkCount = Math.max(0, (meta.chunkCount || 0) - 1);
                  if (Number.isFinite(vSeq) && vSeq > 0) {
                    meta.headSeq = Math.max((meta.headSeq || 0), vSeq + 1);
                  }
                  try { cur.continue(); } catch { }
                };
                curReq.onerror = () => {
                  try { metaSt.put(meta as any); } catch { }
                };
              } catch {
                try { metaSt.put(meta as any); } catch { }
              }
            };

            trimOldest();
          };

          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        } catch (e) {
          reject(e);
        }
      });
      return true;
    } finally {
      try { db.close(); } catch { }
    }
  } catch {
    return false;
  }
}

export async function removeTerminalSnapshot(kind: TerminalSnapshotKind, id: string): Promise<boolean> {
  const key = makeKey(kind, id);
  try {
    const db = await openDb();
    try {
      await deleteChunksByOwner(db, key);
      await withTx(db, STORE_META, 'readwrite', (st) => st.delete(key));
      return true;
    } finally {
      try { db.close(); } catch { }
    }
  } catch {
    return false;
  }
}

export async function cleanupTerminalSnapshots(opts: { ttlMs: number; keepKeys?: Set<string> }): Promise<void> {
  const ttlMs = Number.isFinite(Number(opts.ttlMs)) ? Number(opts.ttlMs) : 0;
  const keep = opts.keepKeys || new Set<string>();
  if (ttlMs <= 0) return;

  const now = Date.now();

  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        try {
          const tx = db.transaction([STORE_META, STORE_CHUNKS], 'readwrite');
          const st = tx.objectStore(STORE_META);
          const req = st.openCursor();
          tx.oncomplete = () => resolve();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              return;
            }
            const v: any = cursor.value;
            const key = String(v?.key || '');
            const ts = Number(v?.ts || 0);
            if (key && !keep.has(key) && (ts <= 0 || now - ts > ttlMs)) {
              try { cursor.delete(); } catch { }
              try {
                const chunkSt = tx.objectStore(STORE_CHUNKS);
                let idx: IDBIndex | null = null;
                try { idx = chunkSt.index('owner'); } catch { idx = null; }
                const range = IDBKeyRange.only(key);
                const dreq = (idx ? idx.openCursor(range) : chunkSt.openCursor());
                dreq.onsuccess = () => {
                  const c2 = dreq.result;
                  if (!c2) return;
                  const vv: any = c2.value;
                  if (!idx) {
                    if (String(vv?.owner || '') !== key) {
                      try { c2.continue(); } catch { }
                      return;
                    }
                  }
                  try { c2.delete(); } catch { }
                  try { c2.continue(); } catch { }
                };
              } catch { }
            }
            try { cursor.continue(); } catch { }
          };
          tx.onabort = () => reject(tx.error);
        } catch (e) {
          reject(e);
        }
      });
    } finally {
      try { db.close(); } catch { }
    }
  } catch {
    return;
  }
}
