export type StorageBackend = 'local' | 'session';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

export type StorageOptions<T> = {
  backend?: StorageBackend;
  fallback: T;
};

function getBackend(backend: StorageBackend): Storage {
  return backend === 'session' ? sessionStorage : localStorage;
}

function safeParseJson<T>(raw: string | null): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class StorageService {
  getString(key: string, opts: StorageOptions<string>) {
    const backend = getBackend(opts.backend || 'local');
    try {
      const v = backend.getItem(key);
      return v == null ? opts.fallback : String(v);
    } catch {
      return opts.fallback;
    }
  }

  setString(key: string, value: string, backend: StorageBackend = 'local') {
    const st = getBackend(backend);
    try {
      st.setItem(key, String(value));
      return true;
    } catch {
      return false;
    }
  }

  getBool(key: string, opts: StorageOptions<boolean>) {
    const backend = getBackend(opts.backend || 'local');
    try {
      const v = backend.getItem(key);
      if (v == null) return opts.fallback;
      return v === 'true';
    } catch {
      return opts.fallback;
    }
  }

  setBool(key: string, value: boolean, backend: StorageBackend = 'local') {
    return this.setString(key, value ? 'true' : 'false', backend);
  }

  getNumber(key: string, opts: StorageOptions<number>) {
    const backend = getBackend(opts.backend || 'local');
    try {
      const v = backend.getItem(key);
      if (v == null) return opts.fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : opts.fallback;
    } catch {
      return opts.fallback;
    }
  }

  setNumber(key: string, value: number, backend: StorageBackend = 'local') {
    return this.setString(key, String(value), backend);
  }

  getJson<T>(key: string, opts: StorageOptions<T>) {
    const backend = getBackend(opts.backend || 'local');
    try {
      const parsed = safeParseJson<T>(backend.getItem(key));
      return parsed == null ? opts.fallback : parsed;
    } catch {
      return opts.fallback;
    }
  }

  setJson(key: string, value: unknown, backend: StorageBackend = 'local') {
    const st = getBackend(backend);
    try {
      st.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  remove(key: string, backend: StorageBackend = 'local') {
    const st = getBackend(backend);
    try {
      st.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  migrate(key: string, from: StorageBackend, to: StorageBackend) {
    if (from === to) return;
    const a = getBackend(from);
    const b = getBackend(to);
    try {
      const v = a.getItem(key);
      if (v == null) return;
      b.setItem(key, v);
      a.removeItem(key);
    } catch {
      return;
    }
  }
}

export const storage = new StorageService();
