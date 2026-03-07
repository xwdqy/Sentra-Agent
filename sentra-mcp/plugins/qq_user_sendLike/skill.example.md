# qq_user_sendLike

## Capability

- 给指定 QQ 账号发送资料点赞（可指定次数）。

## Real-world impact

- 真实互动行为：会对目标账号产生点赞。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `user.sendLike`。

## When to use

- 目标与工具能力一致：QQ平台：发送点赞
- 可提供必需入参：`times`、`user_id`。
- 目标路由已明确：`user_id`。
- 你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。

## When not to use

- 缺少必需入参时不要调用：`times`、`user_id`。
- 路由不明确时不要调用（需明确 `user_id`）。
- 仅希望查询信息、且不希望产生副作用时，不要调用。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`user_id, times`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Required:
  - `user_id` (number)
  - `times` (number)
- Optional:
  - `requestId` (string)

## Output

- `{ request, response }`

## Failure modes

- `INVALID`: `user_id` 或 `times` 非数字。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: WS 未连接/触发频率限制/账号状态异常。
