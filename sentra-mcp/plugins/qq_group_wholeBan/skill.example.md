# qq_group_wholeBan

## Capability

- 开启/关闭指定群的全员禁言。

## Real-world impact

- 高风险群管理操作：会影响整个群的发言权限。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `group.wholeBan`。

## When to use

- 目标与工具能力一致：QQ平台：设置全员禁言
- 可提供必需入参：`group_id`、`on`。
- 目标路由已明确：`group_id`。
- 你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。

## When not to use

- 缺少必需入参时不要调用：`group_id`、`on`。
- 路由不明确时不要调用（需明确 `group_id`）。
- 仅希望查询信息、且不希望产生副作用时，不要调用。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`group_id, on(enable)`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Required:
  - `group_id` (number)
  - `on` (boolean) or `enable` (boolean)
- Optional:
  - `requestId` (string)

## Output

- 返回 `{ request, response }`：request 会包含调用的 path 与 args；response 为 WS 侧回包。

## Failure modes

- `INVALID`: `group_id` 非数字，或 `on/enable` 不是布尔值。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: 常见为权限不足（机器人非管理员/群主）或 WS 未连接。
