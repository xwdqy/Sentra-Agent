# qq_message_recall

## Capability

- 撤回指定 `message_id` 的 QQ 消息。

## Real-world impact

- 高风险消息操作：会影响真实聊天记录。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `message.recall`。

## When to use

- 目标与工具能力一致：QQ平台：撤回消息
- 可提供必需入参：`message_id`。
- 你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。

## When not to use

- 缺少必需入参时不要调用：`message_id`。
- 仅希望查询信息、且不希望产生副作用时，不要调用。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`message_id`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Required:
  - `message_id` (number; 必须来自上下文)
- Optional:
  - `requestId` (string)

## Output

- 返回 `{ request, response }`：request 会包含调用的 path 与 args；response 为 WS 侧回包。

## Failure modes

- `INVALID`: `message_id` 非数字。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: 常见为权限不足、超出撤回时间窗口、或 WS 未连接。
