# qq_user_deleteFriend

## Capability

- 删除指定 `user_id` 的 QQ 好友关系（不可逆）。

## Real-world impact

- 高风险不可逆操作：会删除真实好友关系。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `user.deleteFriend`。

## When to use

- 目标与工具能力一致：QQ平台：删除好友
- 可提供必需入参：`user_id`。
- 目标路由已明确：`user_id`。
- 你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。

## When not to use

- 缺少必需入参时不要调用：`user_id`。
- 路由不明确时不要调用（需明确 `user_id`）。
- 仅希望查询信息、且不希望产生副作用时，不要调用。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`user_id`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Required:
  - `user_id` (number)
- Optional:
  - `requestId` (string)

## Output

- 返回 `{ request, response }`：request 会包含调用的 path 与 args；response 为 WS 侧回包。

## Failure modes

- `INVALID`: `user_id` 非数字。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: WS 未连接、权限/关系状态异常。
