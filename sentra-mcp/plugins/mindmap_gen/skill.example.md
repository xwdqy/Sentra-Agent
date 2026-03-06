# mindmap_gen

## Capability

- Generate mindmap markdown and optionally rendered image artifact.

## Failure modes

- `INVALID`
- `MARKDOWN_INVALID`
- `RENDER_FAILED`
- `TIMEOUT`
- `ERR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, non-empty `data.prompt`, and non-empty `data.markdown_content`.
- `data.generation_info` must exist.
- If `data.path_markdown` is present, it must be valid markdown image evidence.
- Empty markdown content means failure.
