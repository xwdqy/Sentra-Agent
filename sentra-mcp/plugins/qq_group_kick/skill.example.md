# qq_group_kick

## Capability

- 将指定 `user_id` 从指定 `group_id` 中移除（踢人）。

## Real-world impact

- 高风险群管理操作：会影响真实群成员。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `group.kick`。

## When to use

- 目标与工具能力一致：QQ平台：移除群成员
- 可提供必需入参：`group_id`、`user_id`。
- 目标路由已明确：`group_id`、`user_id`。
- 你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。

## When not to use

- 缺少必需入参时不要调用：`group_id`、`user_id`。
- 路由不明确时不要调用（需明确 `group_id`、`user_id`）。
- 仅希望查询信息、且不希望产生副作用时，不要调用。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`group_id, user_id, reject`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Required:
  - `group_id` (number)
  - `user_id` (number)
- Optional:
  - `reject` (boolean): 是否拒绝再次加群（视平台实现）
  - `requestId` (string)

## Output

- 返回 `{ request, response }`：request 会包含调用的 path 与 args；response 为 WS 侧回包。

## Failure modes

- `INVALID`: `group_id/user_id` 不是有效数字。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: 常见为权限不足（机器人非管理员/群主）或 WS 未连接。
