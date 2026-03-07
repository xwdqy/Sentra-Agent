# web_parser

## Capability

- Parse rendered web pages and optionally run vision-on-screenshot analysis.

## Failure modes

- `INVALID_URL`
- `MISSING_PROMPT`
- `FETCH_FAILED`
- `BLOCKED`
- `TIMEOUT`
- `BATCH_FAILED`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and valid `data.url`.
- At least one content channel must be non-empty: `data.text` or `data.visionText`.
- `data.metadata` must exist.
- `data.vision` must exist as object evidence.
- If screenshot/artifact fields are present, they must be structurally valid.
- Empty `text` + empty `visionText` must not pass.
