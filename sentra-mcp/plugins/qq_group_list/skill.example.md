# qq_group_list

## Capability

- 获取当前账号加入的群列表。

## Real-world impact

- 只读查询：不修改群/成员。
- 依赖 WS SDK：通过 `ws://localhost:6702` 调用 `group.list`。

## When to use

- 目标与工具能力一致：QQ平台：获取群列表
- 已明确关键输入字段：`requestId`。
- 你需要查询或解析结果，而不是执行修改类操作。

## When not to use

- 缺少关键输入且无法从上下文可靠推断时，不要调用。
- 需要执行发送/修改/删除等动作时，不要调用。

## Success Criteria

- Require `result.success === true` and `result.code === "OK"`.
- `data.request.path` must be present and `data.request.args` must be an empty array for this RPC.
- `data.response` must be present and non-null.
- Retry guidance: timeout/network can retry once; config/schema problems regenerate args; persistent RPC failure triggers replan.
## Input

- Optional:
  - `requestId` (string)

## Output

- `{ request, response }`：request 为 `group.list` 调用信息；response 为 WS 侧回包。

## Failure modes

- `ERR`: WS 未连接/QQ 侧异常。
