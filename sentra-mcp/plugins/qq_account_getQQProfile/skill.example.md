# qq_account_getQQProfile

## Capability

- 查询一个或多个 QQ 号的个人资料信息（单个或批量）。

## Real-world impact

- 只读查询：不修改账号资料。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `user.info`。

## When to use

- 目标与工具能力一致：查询一个或多个 QQ 号的个人资料信息。
- 可提供以下任一入参组合：(`user_id`) 或 (`user_ids`)。
- 需要批量处理时，优先使用数组字段：`user_ids`。
- 目标路由已明确：`user_id`。

## When not to use

- 无法满足任一入参组合时不要调用：(`user_id`) 或 (`user_ids`)。
- 路由不明确时不要调用（需明确 `user_id`）。
- 参数不满足约束时不要调用：`user_ids` 数量范围需在 1 到 inf。
- 需要执行发送/修改/删除等动作时，不要调用。

## Success Criteria

- Single-call success: `result.success === true`, `result.code === "OK"`, and `data.request.path/requestId/args` + `data.response` are all present (`user_id, refresh`).
- Batch-call success: `data.mode === "batch"` and `data.results` is non-empty.
- In batch mode, each item must carry identifiers (`user_id`) plus per-item `success` and `data|error`; treat all-failed batch as incomplete.
- Retry guidance: timeout/network may retry once for failed items; arg/schema errors regenerate args; persistent remote failure triggers replan.
## Input

- Provide one of:
  - `user_id` (number)
  - `user_ids` (number[])
- Optional:
  - `refresh` (boolean): 是否强制刷新（传给 WS）
  - `requestId` (string)

## Output

- 单个：`{ request, response }`
- 批量：`{ mode: 'batch', results: [{ user_id, success, data|error }] }`

## Failure modes

- `INVALID`: 缺 `user_id/user_ids`。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: WS 未连接/账号状态异常。
