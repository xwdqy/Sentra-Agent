# av_transcribe

## Capability

- Transcribe audio/video to text from local absolute paths or http/https URLs.
- Supports single input (`file`) and batch input (`files`).

## Real-world impact

- Calls external transcription APIs.
- May invoke local `ffmpeg` for format conversion in some paths.

## When to use

- User asks to transcribe audio/video into text.
- You can provide `file` or `files`.

## When not to use

- No accessible file/url is available.
- Task does not require audio/video transcription.

## Input

- One of:
  - `file` (string)
  - `files` (string[])
- Optional:
  - `language`
  - `prompt`

## Output

- Single: normalized transcription object.
- Batch: `{ mode: "batch", results: [...] }`.

## Failure modes

- `INVALID`
- `NO_API_KEY`
- `FILE_NOT_FOUND`
- `UNSUPPORTED_AUDIO_FORMAT`
- `FFMPEG_ERR`
- `TIMEOUT`
- `ERR`

## Success Criteria

- Single-file success requires `result.success === true`, `result.code === "OK"`, and `result.data` as an object.
- Single-file evidence must include non-empty `data.file` and non-empty `data.text`.
- `data.segments` must be a non-empty array.
- `data.meta` must exist.
- Batch success requires `result.success === true`, `result.code === "OK"`, `result.data.mode === "batch"`, and non-empty `result.data.results`.
- In batch mode, at least one item must have `success === true`; otherwise treat as incomplete.
