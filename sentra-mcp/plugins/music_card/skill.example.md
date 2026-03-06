# music_card

## Capability

- Search music and return structured `song_id/provider/candidates` for model-side `sentra-message` composition.
- Supports direct mode via `song_id` without remote search.
- This plugin does **not** send any message and does not call `send.group` / `send.private`.

## Failure modes

- `INVALID`
- `INVALID_SONG_ID`
- `UNSUPPORTED_PROVIDER_SEARCH`
- `NOT_FOUND`
- `SEARCH_FAILED`
- `MUSIC_CARD_FAILED`

## Success Criteria

- Success requires `result.success === true` and `result.code === "OK"`.
- Direct mode must return non-empty `data.song_id`, `data.provider`, and `data.candidates[0].music_segment`.
- Search mode must return non-empty `data.results`.
- At least one `data.results[*]` item must satisfy `success === true` with non-empty `recommended` and `candidates`.
- Any failed item should include both `code` and `error.message`.
