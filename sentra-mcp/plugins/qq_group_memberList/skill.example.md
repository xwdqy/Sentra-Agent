# qq_group_memberList

## Capability

- 获取群成员列表（单群或批量）。

## Real-world impact

- 只读查询：不修改群/成员。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `group.memberList`。

## When to use

- 目标与工具能力一致：QQ平台：获取群成员列表
- 可提供以下任一入参组合：(`group_id`) 或 (`group_ids`)。
- 需要批量处理时，优先使用数组字段：`group_ids`。
- 目标路由已明确：`group_id`。

## When not to use

- 无法满足任一入参组合时不要调用：(`group_id`) 或 (`group_ids`)。
- 路由不明确时不要调用（需明确 `group_id`）。
- 参数不满足约束时不要调用：`group_ids` 数量范围需在 1 到 inf。
- 需要执行发送/修改/删除等动作时，不要调用。

## Success Criteria

- Single-call success: `result.success === true`, `result.code === "OK"`, and `data.request.path/requestId/args` + `data.response` are all present (`group_id`).
- Batch-call success: `data.mode === "batch"` and `data.results` is non-empty.
- In batch mode, each item must carry identifiers (`group_id`) plus per-item `success` and `data|error`; treat all-failed batch as incomplete.
- Retry guidance: timeout/network may retry once for failed items; arg/schema errors regenerate args; persistent remote failure triggers replan.
## Input

- Provide one of:
  - `group_id` (number)
  - `group_ids` (number[])
- Optional:
  - `requestId` (string)

## Output

- 单个群：`{ request, response }`
- 批量：`{ mode: 'batch', results: [{ group_id, success, data|error }] }`

## Failure modes

- `INVALID`: 缺 `group_id/group_ids`。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: WS 未连接/机器人不在群内/权限或参数问题。
