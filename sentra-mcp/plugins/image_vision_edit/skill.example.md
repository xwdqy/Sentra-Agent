# image_vision_edit

## Capability

- Edit/transform image output from image inputs + English prompt.

## Input

- Required:
  - `images`
  - `prompt` (English)

## Failure modes

- `INVALID`
- `PROMPT_NOT_ENGLISH`
- `INVALID_PATH`
- `IMAGE_READ_ERR`
- `NO_MD_IMAGE`
- `TIMEOUT`
- `ERR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and non-empty `data.prompt`.
- Must include non-empty `data.content` with markdown image evidence (`![...](...)`).
- `data.model` should be present.
- Text-only output without markdown image evidence must not pass.
