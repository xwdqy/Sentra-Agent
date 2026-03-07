# qq_system_setDiyOnlineStatus

## Capability

- 设置当前 QQ 账号的自定义在线状态（表情/挂件 + 文案）。

## Real-world impact

- 账号侧真实变更：会修改在线状态展示（对外可见）。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `system.setDiyOnlineStatus`。

## When to use

- 目标与工具能力一致：设置当前 QQ 账号的自定义在线状态，包括表情和文案。
- 可提供必需入参：`face_id`。
- 你明确接受该操作可能产生的副作用（发送/修改/写入/生成）。

## When not to use

- 缺少必需入参时不要调用：`face_id`。
- 仅希望查询信息、且不希望产生副作用时，不要调用。

## Success Criteria

- Must have `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be non-empty, `data.request.requestId` must be present, and `data.request.args` must match this call (`{ face_id + optional online status payload }`).
- `data.response` must be present (non-null object/string), proving RPC was sent and acknowledged.
- Retry guidance: timeout/network may retry once with same args; input/schema errors should regenerate args; business rejection should replan.
## Input

- Required:
  - `face_id` (number|string)
- Optional:
  - `face_type` (number|string)
  - `wording` (string)

## Output

- `{ request, response }`

## Failure modes

- `INVALID`: 缺 `face_id`。
- `TIMEOUT`: WS/QQ 侧超时。
- `ERR`: WS 未连接/机器人离线/不支持该 face_id。
