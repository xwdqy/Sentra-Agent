# video_generate

## Capability

- Generate video output from text prompt.

## Failure modes

- `INVALID`
- `NO_VIDEO_LINK`
- `NO_LOCAL_VIDEO`
- `TIMEOUT`
- `ERR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and non-empty `data.prompt`.
- Must include non-empty `data.content` with local markdown video evidence.
- `data.model` should be present.
- Text-only output without local video markdown evidence must not pass.
