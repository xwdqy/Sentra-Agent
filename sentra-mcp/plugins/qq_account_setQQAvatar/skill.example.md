# qq_account_setQQAvatar

## Capability

- 将当前 QQ 账号头像更换为指定图片文件。

## Real-world impact

- 高影响账号资料操作：会修改真实账号头像。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `account.setQQAvatar`。
- 读取本地文件：`file` 必须是可访问的本地绝对路径。

## When to use

- 目标与工具能力一致：把当前 QQ 账号的头像换成你提供的图片。
- 可提供必需入参：`file`。

## When not to use

- 缺少必需入参时不要调用：`file`。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`{ file }`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Required:
  - `file` (string; 本地绝对路径)

## Output

- 返回 `{ request, response }`：request 会包含调用的 path 与 args；response 为 WS 侧回包。

## Failure modes

- `INVALID`: 缺 `file`。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: 文件路径不可用/格式不支持/WS 未连接。
