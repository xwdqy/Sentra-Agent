# document_read

## Capability

- Read and parse documents/code files from local absolute paths or URLs.
- Supports single input and batch input.

## Real-world impact

- Reads local files.
- May fetch remote files over network.

## When to use

- User asks to read/parse file content.

## When not to use

- No valid file/url input.
- Task needs write/mutation behavior.

## Input

- One of:
  - `file`
  - `files`
- Optional:
  - `encoding`

## Output

- Parsed file list and aggregate counters.

## Failure modes

- `INVALID`
- `ALL_FAILED`
- parser/network specific errors per file item

## Success Criteria

- Success requires `result.success === true` and `result.code` in `OK|PARTIAL_SUCCESS`.
- `result.data.files` must be a non-empty array.
- `result.data.total`, `result.data.success`, and `result.data.failed` must be numeric and satisfy `success + failed == total`.
- At least one `data.files[*]` item must include non-empty parsed `content`.
- For `PARTIAL_SUCCESS`, failed items must carry failure evidence (`error`).
