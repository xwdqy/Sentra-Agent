# image_to_video

## Capability

- Generate video-like output from prompt + reference images.
- Returns local markdown video evidence.

## Failure modes

- `INVALID`
- `NO_VIDEO_LINK`
- `NO_LOCAL_VIDEO`
- `TIMEOUT`
- `ERR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and non-empty `data.prompt`.
- Must include non-empty `data.enhanced_prompt`, non-empty `data.content`, and non-empty `data.model`.
- `data.content` must contain usable local markdown video evidence.
- Missing local video markdown evidence means incomplete.
