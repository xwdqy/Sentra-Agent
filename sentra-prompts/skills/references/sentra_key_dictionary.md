# Sentra Key Dictionary

This document defines key/value meanings for the core Sentra XML blocks.

## 1) `sentra-input`
- `current_messages`: authoritative current-turn message container.
- `sentra-message.chat_type`: route mode (`group` or `private`).
- `sentra-message.group_id`: target group id, valid only when `chat_type=group`.
- `sentra-message.user_id`: target private id, valid only when `chat_type=private`.
- `sentra-message.sender_id`: original sender id of current message.
- `sentra-message.sender_name`: sender display name.
- `sentra-message.message_id`: platform message id for quote/reply context.
- `sentra-message.message.segment@index`: delivery order index.
- `sentra-message.message.segment.type`: segment channel type.
- `sentra-message.message.segment.data`: per-type payload object.
- `sentra-pending-messages`: recent unresolved messages.
- `sentra-history-messages`: historical message context.
- `sentra-tool-results`: tool-result context snapshot.

## 2) `sentra-message` (output)
- `chat_type`: output route mode.
- `group_id` / `user_id`: exactly one route key according to `chat_type`.
- `message`: output segment list.
- `segment@index`: strict contiguous sequence starting at 1.
- `segment.type`:
  - `text`: user-facing natural language.
  - `at`: mention target.
  - `reply`: quote target message.
  - `image` / `file` / `video` / `record`: native media/file delivery.
  - `music`: native music card delivery.
  - `poke`: native poke action delivery.
  - `recall`: native message recall action delivery.
- `segment.data` required keys:
  - `text` -> `data.text`
  - `at` -> `data.qq`
  - `reply` -> `data.id`
  - `image/file/video/record` -> `data.file`
  - `music` -> `data.type` + `data.id`
  - `poke` -> `data.user_id` (+ `data.group_id` when `chat_type=group`)
  - `recall` -> `data.message_id`

## 3) `sentra-tools` (output)
- `invoke@name`: exact MCP tool id (`aiName`) to call.
- `parameter@name`: exact schema field key for this tool.
- parameter typed value nodes:
  - `string`: text/path/url/prompt/id.
  - `number`: numeric scalar.
  - `boolean`: `true` or `false`.
  - `null`: explicit null.
  - `array`: ordered typed values.
  - `object`: nested key-value map using child `parameter@name`.
- Contract:
  - one parameter = exactly one typed root node.
  - no raw JSON text as replacement for typed nodes.

## 4) `sentra-result` (read-only)
- All keys in this section are element fields (child tags), not XML attributes.
- `step_id`: step identifier within run.
- `tool`: tool id (`aiName`) that produced this result.
- `success`: tool success flag.
- `status`: `progress` or `final`.
- `reason`: planner/tool rationale text.
- `result`: execution result payload (`code`, `provider`, `data`, optional `error`).
- `dependencies`: step-level dependency relation fields.
- `extracted_files`: extracted file/resource paths.
- Note: under the current protocol, `sentra-result` does not carry `args`; consume runtime evidence from `result/data`.

## 5) `sentra-result-group` (read-only)
- Keys are carried as child tags under `<sentra-result-group>`.
- `step_group_id`: internal execution group id.
  - IMPORTANT: this is NOT chat `group_id`.
- `group_size`: count of `sentra-result` items in this group.
- `order_step_ids`: consume order for grouped results.
- `status`: group progress/final marker.

## 6) Routing vs internal execution ids
- Route ids for sending messages come from:
  - `sentra-message.chat_type + group_id/user_id`
- Internal execution ids:
  - `sentra-result.step_id`
  - `sentra-result-group.step_group_id`
- Never use internal execution ids as send-route ids.

## 7) Callback payload composition
- In tool callback rounds, runtime can package one user payload as:
  1. `<sentra-input>...</sentra-input>`
  2. followed by `<sentra-result ...>` or `<sentra-result-group ...>`
- Interpretation:
  - routing and target identity are read from `sentra-input`
  - execution evidence is read from appended result block(s)
- Do not treat this as two independent user turns.
