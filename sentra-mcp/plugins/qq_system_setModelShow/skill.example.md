# qq_system_setModelShow

## Capability

- 设置当前 QQ 账号的设备/模型展示信息（对外可见文案）。

## Real-world impact

- 账号侧真实变更：会修改账号对外展示信息。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `system.setModelShow`。

## When to use

- 目标与工具能力一致：设置当前 QQ 账号的设备展示信息。
- 可提供必需入参：`model`、`model_show`。
- 你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。

## When not to use

- 缺少必需入参时不要调用：`model`、`model_show`。
- 仅希望查询信息、且不希望产生副作用时，不要调用。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`model, model_show (+optional fields)`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Required:
  - `model` (string)
  - `model_show` (string)
- Optional:
  - `requestId` (string)

## Output

- `{ request, response }`

## Failure modes

- `INVALID`: `model` 或 `model_show` 为空。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: WS 未连接/机器人离线/权限或协议不支持。
