# suno_music_generate

## Purpose

- Generate music from `title + tags + lyrics` by calling Suno-compatible API.
- Extract audio links from model output.
- Send generated music card to QQ target via WebSocket RPC.

## Side Effects

- Outbound network calls to generation provider.
- Outbound QQ message send RPC.

## When to use

- You need generative music output with explicit lyric/style control.
- Required inputs are available: `title`, `tags`, `lyrics`.
- A delivery target exists (`user_id` or `group_id`) when send-back is required.

## When not to use

- Any required argument (`title`, `tags`, `lyrics`) is missing.
- Task is read-only and should not trigger generation/send side effects.

## Inputs

- Required:
  - `title` (string)
  - `tags` (string)
  - `lyrics` (string)
- Optional:
  - `user_id` / `group_id` (delivery target)

## Outputs

- On success (`result.success === true`, `code: OK`), `result.data` contains:
  - `action: "suno_music_generate"`
  - generated audio evidence (primary audio link + all extracted audio links)
  - send path evidence
  - timestamp evidence
- On failure, returns `code` + `error` (and optional `detail`), such as provider/send failure.

## Failure Modes

- `INVALID_TITLE`
- `INVALID_TAGS`
- `INVALID_LYRICS`
- `MISSING_API_KEY`
- `NO_AUDIO_LINK`
- `SEND_FAILED`
- `ERR`

## Success Criteria

- `result.success === true`, `result.code === "OK"`, and `result.data.action === "suno_music_generate"`.
- `result.data` must include non-empty generated audio link evidence and a non-empty extracted-links array.
- `result.data` must include send evidence (`send path`) and `timestamp`.
- If target routing was requested, returned payload must contain concrete target evidence (private/group target identity).
- Retry guidance: transient provider/send failures can retry once; missing-required-args should `retry_regen`; repeated provider/send failure should `replan`.
