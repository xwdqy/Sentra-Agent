# image_search

## Capability

- Search and download images from configured providers.
- Supports single query and batch queries.

## Real-world impact

- Network requests to search/image endpoints.
- Writes downloaded artifacts (and optionally zip) to local storage.

## Input

- One of:
  - `query`
  - `queries`
- Optional filters/count fields.

## Output

- Single: provider result with direct files or zip payload.
- Batch: `{ mode: "batch", results: [...] }`.

## Failure modes

- `INVALID_PARAM`
- `NO_RESULT`
- `DOWNLOAD_FAILED`
- `INTERNAL_ERROR`

## Success Criteria

- Single-query success requires `result.success === true`, `result.code === "OK"`, non-empty `data.query`, and `data.status` in `OK_DIRECT|OK_ZIPPED`.
- `OK_DIRECT` requires non-empty `data.files`, and each item must include non-empty `path_markdown`.
- `OK_ZIPPED` requires non-empty `data.zip_path_markdown` and non-empty `data.file_list`.
- `data.actual_count` and `data.summary` must be present.
- Batch success requires `result.data.mode === "batch"`, non-empty `result.data.results`, and at least one item with `success === true`.
