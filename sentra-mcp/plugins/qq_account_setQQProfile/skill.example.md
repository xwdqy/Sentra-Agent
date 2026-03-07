# qq_account_setQQProfile

## Capability

- 修改当前 QQ 账号个人资料（`nickname`/`personal_note`/`sex`）。

## Real-world impact

- 高影响账号资料操作：会修改真实账号资料。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `account.setQQProfile`。

## When to use

- 目标与工具能力一致：修改当前 QQ 账号的个人资料，比如昵称、签名或性别。
- 可提供以下任一入参组合：(`nickname`) 或 (`personal_note`) 或 (`sex`)。
- 你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。

## When not to use

- 无法满足任一入参组合时不要调用：(`nickname`) 或 (`personal_note`) 或 (`sex`)。
- 参数不满足约束时不要调用：`sex` 仅支持 `0` / `1` / `2`。
- 仅希望查询信息、且不希望产生副作用时，不要调用。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`{ nickname|personal_note|sex payload }`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Provide at least one:
  - `nickname` (string)
  - `personal_note` (string)
  - `sex` (string enum: "0"|"1"|"2")
- Optional:
  - `requestId` (string)

## Output

- 返回 `{ request, response }`：request 会包含 payload；response 为 WS 侧回包。

## Failure modes

- `INVALID`: 未提供任何字段，或 `sex` 非法。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: WS 未连接或平台拒绝该资料变更。
