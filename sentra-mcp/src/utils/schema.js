import Ajv from 'ajv';

// Simple per-process validator cache by schema signature
const ajv = new Ajv({
  allErrors: true,
  coerceTypes: true,
  useDefaults: true,
  removeAdditional: false,
  strict: false,
});

// Keep a weak map if schema objects are reused; fall back to stringified key
const compiled = new Map();

function schemaKey(schema) {
  try { return JSON.stringify(schema); } catch { return String(schema); }
}

function deepCloneJsonLike(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    if (value && typeof value === 'object') return { ...value };
    return value;
  }
}

export function validateAndRepairArgs(schema = {}, args = {}) {
  const key = schemaKey(schema);
  let validate = compiled.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(schema || { type: 'object' });
      compiled.set(key, validate);
    } catch (e) {
      // Fail-closed: schema compile failure must block execution.
      return {
        valid: false,
        output: args,
        errors: [{
          keyword: 'schema_compile_exception',
          message: String(e),
        }],
      };
    }
  }
  // Keep full args payload. Do not shallow-prune root keys, otherwise
  // valid fields under oneOf/allOf/patternProperties/additionalProperties
  // can be dropped before schema validation.
  const data = deepCloneJsonLike(args); // deep clone to avoid mutating callers
  const ok = validate(data);
  return { valid: !!ok, output: data, errors: validate.errors || [] };
}
