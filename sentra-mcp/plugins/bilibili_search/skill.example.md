# bilibili_search

## Capability

- Search Bilibili videos and either download locally or send as music-card style payload.
- Supports single keyword and batch keywords.

## Real-world impact

- External network requests to Bilibili APIs.
- May write downloaded files to `artifacts/`.
- May send outbound WS messages when card mode is enabled.

## When to use

- User asks to search/download/share Bilibili video results.
- You can provide `keyword` or `keywords`.

## When not to use

- No keyword is available.
- Send target is missing while send mode is required.

## Input

- One of:
  - `keyword`
  - `keywords`
- Optional:
  - `pick`
  - `send_as_music_card`
  - `user_id` / `group_id`

## Output

- Single: video search result object with status and evidence fields.
- Batch: `{ mode: "batch", results: [...] }`.

## Failure modes

- `INVALID`
- `TARGET_REQUIRED`
- `NO_RESULT`
- `NO_CID`
- `NO_PLAYURL`
- `SEND_FAILED`
- `TIMEOUT`
- `ERR`
- `BILIBILI_SEARCH_FAILED`

## Success Criteria

- Single-run success requires `result.success === true`, `result.code === "OK"`, and `data.action === "bilibili_search"`.
- Base evidence must include non-empty `data.keyword`, `data.bvid`, `data.url`, `data.title`, `data.status`, and `data.timestamp`.
- `data.status` must be one of: `OK_MUSIC_CARD_SENT`, `OK_LINK_ONLY`, `OK_DOWNLOADED`.
- If `data.status === "OK_DOWNLOADED"`, require `data.downloaded === true` and local artifact evidence in `data.path_markdown` or `data.video.path_markdown`.
- If `data.status === "OK_LINK_ONLY"`, require `data.downloaded === false` and non-empty `data.notice`.
- If `data.status === "OK_MUSIC_CARD_SENT"`, require `data.music_card_sent === true` and concrete send target evidence (`data.send_target`, `data.send_to`).
- Batch success requires `result.data.mode === "batch"`, non-empty `result.data.results`, and at least one item with `success === true`.
