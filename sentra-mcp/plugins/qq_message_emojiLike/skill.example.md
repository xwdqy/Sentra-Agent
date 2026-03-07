# qq_message_emojiLike

## Capability

- 给指定消息贴表情（reaction）。
- 支持 1~3 个表情（会去重），仅支持“添加”，不支持取消。

## Real-world impact

- 消息操作：会对真实消息产生互动效果。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `message.emojiLike`。

## When to use

- 目标与工具能力一致：QQ平台：给消息贴表情（emoji like/reaction）。支持单个或多个表情（最多3个），注意：仅支持添加表情，不支持取消
- 可提供必需入参：`emoji_ids`、`message_id`。

## When not to use

- 缺少必需入参时不要调用：`emoji_ids`、`message_id`。
- 参数不满足约束时不要调用：`message_id` 需匹配指定格式（pattern）。

## Success Criteria

- `result.success === true` and `result.code` is `OK` or `PARTIAL_SUCCESS`.
- `data.message_id` must be present, and `data.sdk_calls` must be a non-empty array.
- Every item in `data.sdk_calls` must include `emoji_id`, `success`, and `sdk.request`.
- For every `sdk.request`: `type === "sdk"`, `path === "message.emojiLike"`, and `args` is a 2-item array `[message_id_number, emoji_id_number]`.
- Successful items must include `sdk.response`; failed items must include `sdk.error` or top-level `error`.
- `result.code === "OK"` means all `data.sdk_calls[*].success === true`.
- `result.code === "PARTIAL_SUCCESS"` means at least one success and at least one failure, and `data.emojis_failed` should be present.
- Retry guidance: transient RPC failures may retry once for failed emoji IDs; schema/input errors regenerate args; all-failed should replan.
## Input

- Required:
  - `message_id` (string; 纯数字；必须来自上下文/引用)
  - `emoji_ids` (number or number[]; max 3)
- Notes:
  - 允许传 `emoji_id`（单数）作为兼容输入，会被当作 `emoji_ids`。
  - 表情 ID 必须是 face-map 内的有效值。

## Output

- Success `data` 常见字段：
  - `summary`, `message_id`, `success_count`, `failed_count`(可选)
  - `emojis` / `emojis_success` / `emojis_failed`
  - `sdk_calls`: 每个表情一次调用的 request/response 记录

## Failure modes

- `INVALID_MESSAGE_ID`: message_id 不是纯数字字符串。
- `INVALID_EMOJI_ID` / `INVALID`: emoji_id 不合法。
- `TIMEOUT`: WS/QQ 侧超时。
- `ALL_FAILED`: 全部贴加失败（权限/协议/WS 状态）。
