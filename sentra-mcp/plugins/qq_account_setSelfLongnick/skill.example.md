# qq_account_setSelfLongnick

## Capability

- 设置当前 QQ 账号的个性签名（长签）为指定文本。

## Real-world impact

- 高影响账号资料操作：会修改真实账号签名。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `account.setSelfLongnick`。

## When to use

- 目标与工具能力一致：修改当前 QQ 账号的个性签名。
- 可提供必需入参：`longNick`。
- 你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。

## When not to use

- 缺少必需入参时不要调用：`longNick`。
- 仅希望查询信息、且不希望产生副作用时，不要调用。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`longNick`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Required:
  - `longNick` (string)
- Optional:
  - `requestId` (string)

## Output

- 返回 `{ request, response }`：request 会包含调用的 path 与 args；response 为 WS 侧回包。

## Failure modes

- `INVALID`: 缺 `longNick`。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: WS 未连接或平台拒绝该签名。
