# send_private_message

## 能力

- 校验私聊目标与消息意图（routing helper）。
- 注意：本工具**不负责真正发送消息**，只返回 `target` 与路由规则提示；最终消息需要你在 `<sentra-response>` 里输出。

## 真实世界影响

- 不调用 WS/QQ，不写文件：仅做参数校验与路由提示。

## 何时使用

- 仅在“目标用户已明确”的情况下使用：你需要给某个 QQ 用户发私聊，并且已经知道要发给谁（user_id 已从上下文或联系人列表中确定）。
- 需要做“延迟发送/定时通知/到点提醒”等场景时：
  - 在参数里填写 `schedule`，让上层调度系统能够在指定时间点执行或反馈。
  - 典型例子：
    - “5 分钟后提醒他开会”
    - “明天 9 点给他发一条消息”
    - “到 21:30 再通知他结果”

## 何时不使用

- 目标用户不明确（只说“跟他说一下/私聊他一下”但没说明是谁、也无法从上下文唯一确定）。这种情况应先向用户追问目标是谁。
- 在当前私聊对话里直接回复且 `<sentra-user-question>` 已给出 `<sender_id>`，且你只是回复当前对话（不需要跨聊）：直接在最终 `<sentra-response>` 用该 id 路由即可，不必额外调用。

## 输入参数

- 必填:
  - `user_id` (string; 纯数字)
  - `content` (string; 意图/摘要)
- 可选:
  - `schedule` (object; 延迟/定时)
    - 当用户诉求是“稍后/定时/到点提醒/延迟通知/延迟执行”时，应填写该字段。
    - `when` 建议用清晰可解析表达（如“5分钟后”“明天09:00”或 ISO）。
    - `targetISO` 可选：若上游已解析出绝对时间，可提供以提高稳定性。
  - `media_hints` (array)

## 输出

- `data.action`: `send_private_message`
- `data.mode`: `routing_only`
- `data.can_send_message`: `false`（本工具不真正发送消息）
- `data.target`: `{ type: 'private', user_id: user_id }`
- `data.intent`: `content`
- `data.suggested_routing`: `{ tag: 'user_id', value: user_id, xml: '<user_id>...</user_id>' }`
- `data.suggested_next`: 生成最终 `<sentra-response>`（在 `<textN>` 写用户可见文本，并且必须包含且仅包含一个 `<user_id>` 路由标签）

## 失败模式

- `INVALID`: `user_id` 为空/非纯数字字符串，或 `content` 为空。
