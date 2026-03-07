# video_vision_read

## Capability

- Analyze one or multiple videos with prompt-guided multimodal inference.

## Failure modes

- `INVALID`
- `INVALID_PATH`
- `VIDEO_TOO_LARGE`
- `VIDEO_READ_ERR`
- `TIMEOUT`
- `ERR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, non-empty `data.prompt`, and non-empty `data.description`.
- `data.video_count` must be an integer >= 1.
- `data.formats` must be a non-empty array.
- `data.total_size_mb` must be present as numeric-like size evidence.
- `data.model` should be present.
