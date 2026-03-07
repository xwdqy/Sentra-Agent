# qq_user_sendPoke

## Capability

- Send QQ `user.sendPoke` RPC requests via WebSocket SDK.
- Support multi-round poke (`times`) with optional retry-on-failure per round.
- Return round-level execution evidence for each poke attempt.

## When to use

- The objective is to actively poke a QQ user, not just construct a message segment.
- You can provide required target parameter: `user_id`.
- You may need optional routing/control params: `group_id`, `target_id`, `times`.

## When not to use

- Required argument `user_id` is missing.
- Task is read-only (query/info-only) and should not trigger outbound side effects.
- You only need a sentra-message `poke` segment object without RPC execution.

## Success Criteria

- `result.success === true` and `result.code` is `OK` or `PARTIAL_SUCCESS`.
- `result.data.request.type === "sdk"` and `result.data.request.path === "user.sendPoke"`.
- `result.data.request.args` must exist and be an array whose first item is the target `user_id` (number form).
- `result.data.results` must be a non-empty per-round array.
- Every round item must include `round` (number) and `success` (boolean).
- Successful rounds must include `response`; failed rounds must include `error` (and normally include `attempts`).
- `result.code === "OK"` means all rounds are successful.
- `result.code === "PARTIAL_SUCCESS"` means at least one round success and at least one round failure.
- Retry guidance: timeout/transient RPC failures can retry per failed round; invalid/missing args should use `retry_regen`; all rounds failed should `replan`/`fail_fast`.

## Inputs

- Required:
  - `user_id` (string|number): target QQ user id.
- Optional:
  - `times` (number): poke rounds, internally clamped to `1..5`.
  - `group_id` (string|number): group context (if needed by adapter path).
  - `target_id` (string|number): optional extended target field for adapters requiring a 3rd arg.
  - `requestId` (string): custom RPC request id.

## Outputs

- Success (`OK` or `PARTIAL_SUCCESS`):
  - `data.request`: `{ type: "sdk", path: "user.sendPoke", args: [...] }`
  - `data.results`: per-round execution array.
  - `data` also includes aggregate counters and runtime config summary fields.
- Failure:
  - `INVALID`: missing required argument.
  - `TIMEOUT`: all rounds failed and timeout-like errors observed.
  - `ALL_FAILED`: all rounds failed for non-timeout reasons.
