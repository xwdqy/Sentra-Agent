function toText(value) {
  return String(value ?? '').trim();
}

const FAILURE_CLASS_RULES = Object.freeze({
  transient: Object.freeze(new Set([
    'TIMEOUT',
    'RATE_LIMIT',
    'COOLDOWN_ACTIVE',
    'NETWORK_ERROR'
  ])),
  arg_schema: Object.freeze(new Set([
    'INVALID',
    'ARG_VALIDATION_FAILED',
    'SCHEMA_INVALID',
    'MISSING_REQUIRED_PARAMETERS'
  ])),
  permission: Object.freeze(new Set([
    'FORBIDDEN',
    'UNAUTHORIZED',
    'AUTH_FAILED'
  ])),
  cancelled: Object.freeze(new Set([
    'RUN_CANCELLED',
    'CANCELLED'
  ])),
  unsupported: Object.freeze(new Set([
    'UNSUPPORTED',
    'UNSUPPORTED_SANDBOX_ACTION',
    'NOT_IMPLEMENTED'
  ]))
});

const RETRYABLE_FAILURE_CLASSES = Object.freeze(new Set([
  'transient',
  'arg_schema'
]));

export function classifyFailureByCode(code = '', options = {}) {
  const success = options?.success === true;
  const emptyClass = toText(options?.emptyClass || 'unknown');
  if (success) return { errorClass: '', retryable: false };

  const normalized = toText(code).toUpperCase();
  if (!normalized) {
    return {
      errorClass: emptyClass,
      retryable: RETRYABLE_FAILURE_CLASSES.has(emptyClass)
    };
  }

  for (const [failureClass, codes] of Object.entries(FAILURE_CLASS_RULES)) {
    if (codes.has(normalized)) {
      return {
        errorClass: failureClass,
        retryable: RETRYABLE_FAILURE_CLASSES.has(failureClass)
      };
    }
  }

  return { errorClass: 'tool_failure', retryable: false };
}

export default {
  classifyFailureByCode
};
