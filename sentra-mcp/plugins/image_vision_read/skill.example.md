# image_vision_read

## Capability

- Read/analyze one or multiple images with prompt-guided vision inference.

## Input

- Required:
  - `image`/`images`
  - `prompt`

## Failure modes

- `INVALID`
- `INVALID_PATH`
- `IMAGE_READ_ERR`
- `TIMEOUT`
- `ERR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, non-empty `data.prompt`, and non-empty `data.description`.
- `data.image_count` must be an integer >= 1.
- `data.formats` must be a non-empty array.
- `data.model` should be present.
- Empty description means incomplete.
