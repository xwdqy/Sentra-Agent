# ppt_gen

## Capability

- Generate/render PPTX files from AI outline or direct slide input.

## Failure modes

- `INVALID`
- `TIMEOUT`
- `ERR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and `data.mode` in `ai_generate|direct_render`.
- Must include non-empty `data.path_abs`, non-empty `data.rel_path`, and numeric `data.page_count >= 1`.
- `data.theme` must be present.
- In `ai_generate` mode, `data.design` should be present with generation trace fields; in `direct_render` mode `data.design` may be null.
- Missing output path or zero slide count means failure.
