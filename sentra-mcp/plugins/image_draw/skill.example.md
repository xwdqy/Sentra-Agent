# image_draw

## Capability

- Generate image output from an English prompt.
- Returns markdown image content.

## Real-world impact

- Calls external generation API.
- Produces local artifact links in markdown.

## When to use

- User asks to generate/draw an image.
- Required prompt can be provided.

## When not to use

- Missing prompt.

## Input

- Required:
  - `prompt` (English)
- Optional:
  - `model`

## Output

- `{ prompt, content, model }`

## Failure modes

- `INVALID`
- `NO_IMAGE`
- `NO_MD_IMAGE`
- `NO_LOCAL_IMAGE`
- `TIMEOUT`
- `ERR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and non-empty `data.prompt`.
- `data.content` must include at least one markdown image link (`![...](...)`).
- Image evidence should be local artifact markdown, not text-only output.
- `data.model` should be present.
- Missing markdown image evidence means incomplete.
