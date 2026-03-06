# custom_music_card

## Capability

- Send a custom music-card payload through WS send endpoints.

## Real-world impact

- Sends outbound WS messages to QQ targets.

## When to use

- User wants to send a custom media card.
- Required media url and title are available.

## When not to use

- Missing required media/title fields.
- Task is read-only.

## Input

- Required:
  - `media_url`
  - `title`
- Optional:
  - `jump_url`
  - `cover_url`
  - `user_id` / `group_id`

## Output

- Result object with action, segments, send response, and timestamp.

## Failure modes

- `INVALID_MEDIA_URL`
- `INVALID_TITLE`
- `SEND_FAILED`
- `ERR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and `data.action === "custom_music_card"`.
- Must include non-empty `data.segments` array.
- Must include non-empty `data.response`.
- Must include send-path evidence and `data.timestamp`.
- Missing `segments/response/timestamp` means incomplete.
