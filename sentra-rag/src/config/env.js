let envSource = null;

export function setEnvSource(map) {
  if (map && typeof map === 'object') {
    envSource = map;
  } else {
    envSource = null;
  }
}

function pickEnv(baseName) {
  const candidates = [`RAG_${baseName}`, `rag_${baseName}`];
  for (const key of candidates) {
    let v;
    if (envSource && Object.prototype.hasOwnProperty.call(envSource, key)) {
      v = envSource[key];
    }
    if (v != null && String(v).length > 0) return { key, value: v };
  }
  return { key: candidates[0], value: undefined };
}

export function getEnv(baseName, { defaultValue, required = false } = {}) {
  const { key, value } = pickEnv(baseName);
  if (value == null || String(value).length === 0) {
    if (required) {
      throw new Error(`${key} is required`);
    }
    return defaultValue;
  }
  return value;
}

export function getEnvNumber(baseName, { defaultValue, required = false } = {}) {
  const raw = getEnv(baseName, { defaultValue: defaultValue != null ? String(defaultValue) : undefined, required });
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number for RAG_${baseName}`);
  }
  return n;
}

export function getEnvBoolean(baseName, { defaultValue = false } = {}) {
  const raw = getEnv(baseName, { defaultValue: defaultValue ? 'true' : 'false', required: false });
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'n' || s === 'off') return false;
  return Boolean(defaultValue);
}
