# QQ 消息级操作（撤回 / 贴表情 / 最近联系人）

## 适用场景
- 对“某一条消息”执行操作：撤回、贴表情。
- 需要获取最近联系人列表用于后续发送。

## 工作流
1. 若需要操作某条消息
   - 必须先获得真实 `message_id`（来自上下文或工具返回）。
2. 执行操作
   - 撤回：`local__qq_message_recall`
   - 贴表情：`local__qq_message_emojiLike`
3. 若需要找会话目标
   - 最近联系人：`local__qq_message_recentContact`

## 参数/约束
- `message_id` 只能来自上下文/历史结果，禁止使用 schema examples 里的示例值当真实 ID。
- 贴表情时优先用 1 个 emoji，最多 3 个，避免刷屏。

## 常见错误与补救
- 找不到 `message_id`：先通过对话上下文/历史消息定位，再操作。
