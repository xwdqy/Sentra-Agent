# qq_system_setOnlineStatus

## Capability

- 设置当前 QQ 账号的在线状态（如在线/离开/隐身等，可附加扩展状态）。

## Real-world impact

- 账号侧真实变更：会改变在线状态的对外展示。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `system.setOnlineStatus`。

## When to use

- 目标与工具能力一致：设置当前 QQ 账号的在线状态，比如在线、离开、隐身等。
- 可提供必需入参：`battery_status`、`ext_status`、`status`。
- 你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。

## When not to use

- 缺少必需入参时不要调用：`battery_status`、`ext_status`、`status`。
- 仅希望查询信息、且不希望产生副作用时，不要调用。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`status, ext_status, battery_status`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Required:
  - `status` (integer)
  - `ext_status` (integer)
  - `battery_status` (integer)

## Output

- `{ request, response }`

## Failure modes

- `INVALID`: 任一字段不是有效整数。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: WS 未连接/机器人离线/状态码不支持。
