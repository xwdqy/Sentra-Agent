# realtime_search

## Capability

- Execute web-grounded search through configured search-capable LLM endpoint.
- Supports single query, batch queries, and raw request passthrough.

## Failure modes

- `INVALID`
- `TIMEOUT`
- `ERR`

## Success Criteria

- Single-query success requires `result.success === true`, `result.code === "OK"`, and non-empty `data.answer_text`.
- Single-query evidence must include `data.model`; `data.citations` must exist as array (can be empty).
- Batch success requires `result.success === true`, `result.data.mode === "batch"`, non-empty `result.data.results`, and at least one item with `success === true`.
- For successful batch items, `item.data.answer_text` must be non-empty.
- If all batch items fail, this step must not pass.
