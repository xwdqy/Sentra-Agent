# Sentra Segment Schema Reference

Required per segment type:
- `text`: `data.text` non-empty
- `at`: `data.qq` numeric id or `all`
- `reply`: `data.id` message id
- `image`: `data.file`
- `file`: `data.file`
- `video`: `data.file`
- `record`: `data.file`
- `music`: `data.type` + `data.id` (platform+song id)
- `poke`: `data.user_id` required; if `chat_type=group`, `data.group_id` is also required
- `recall`: `data.message_id` required (positive numeric message id)
- Optional common metadata on any segment: `data.message_id` (runtime delivery receipt id, read-only).
- Local stickers must use `image` with `data.file` absolute path.
- Do not use non-protocol custom segment types (for example `face`).

Common validation rules:
- Segment indexes must be contiguous and start from 1.
- Message must contain at least one valid segment.
- Message must contain `chat_type` (`group` or `private`).
- Route must contain exactly one tag matching chat_type:
  - `chat_type=group` -> `group_id` only
  - `chat_type=private` -> `user_id` only
- Text structuring guideline:
  - avoid collapsing multi-point replies into one giant text segment;
  - use `2-4` short text segments when message includes multiple points;
  - keep one main point per text segment with clear order.
- Do not fake media delivery via markdown in text segments.
