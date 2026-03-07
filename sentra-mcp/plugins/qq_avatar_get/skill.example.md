# qq_avatar_get

## Capability

- 下载一个或多个 QQ 号的头像，并返回本地图片路径（用于后续识图/转发/存档）。

## Real-world impact

- 外部网络请求：会访问 QQ 头像接口（常见域名 `q.qlogo.cn`）。
- 写本地文件：会把头像下载到 `artifacts/`，并可能写入缓存。

## When to use

- 目标与工具能力一致：下载一个或多个 QQ 号的头像，并返回本地图片路径。
- 可提供以下任一入参组合：(`user_id`) 或 (`user_ids`)。
- 需要批量处理时，优先使用数组字段：`user_ids`。
- 目标路由已明确：`user_id`。

## When not to use

- 无法满足任一入参组合时不要调用：(`user_id`) 或 (`user_ids`)。
- 路由不明确时不要调用（需明确 `user_id`）。
- 参数不满足约束时不要调用：`user_ids` 数量范围需在 1 到 inf。

## Success Criteria

- This plugin is download-based HTTP flow (not WS RPC), so do not require `data.request/data.response`.
- Single-call success requires `result.success === true`, `result.code === "OK"`, plus `data.user_id`, `data.path_absolute`, and `data.path_markdown`.
- `data.path_absolute` must point to a local absolute avatar file path under workspace artifacts.
- Batch mode requires `data.mode === "batch"` with non-empty `data.results`; each item must include `user_id` + `success` + `data|error`, and at least one item must succeed.
- Retry guidance: timeout/download transient may retry once; invalid user args regenerate; repeated avatar fetch failures trigger replan.
## Input

- Provide one of:
  - `user_id` (string)
  - `user_ids` (string[])
- Optional:
  - `useCache` (boolean; default true)

## Output

- 单个：
  - `path_absolute`: 本地绝对路径
  - `path_markdown`: `![avatar](...)`
  - `content`: 同上（方便直接渲染）
- 批量：`{ mode: 'batch', results: [{ user_id, success, data|error }] }`

## Failure modes

- `INVALID`: 缺 `user_id/user_ids`。
- `TIMEOUT`: 下载超时。
- `ERR`: 网络不可达/接口异常/写文件失败。
