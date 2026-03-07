# web_render_image

## Capability

- Render html/file input into PNG screenshot artifact.

## Failure modes

- `INVALID`
- `UNSUPPORTED`
- `NO_PUPPETEER`
- `FILE_NOT_FOUND`
- `SELECTOR_NOT_FOUND`
- `TIMEOUT`
- `RENDER_ERROR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and `data.action === "web_render_image"`.
- Must include non-empty `data.path_markdown` pointing to PNG render output.
- `data.size_bytes` must be numeric and > 0.
- `data.format` must equal `png`.
- `data.viewport` must exist with numeric width/height/scale fields.
