# QQ 群管理（Group Admin）

## 适用场景
- 查询群列表/群信息/成员信息。
- 执行群管理动作：禁言、全员禁言、踢人、改群名、改群名片、退群。

## 工作流
1. 定位对象
   - `group_id` 不确定：先 `local__qq_group_list` -> 再选定
   - `user_id` 不确定：先 `local__qq_group_memberList` / `local__qq_group_memberInfo`
2. 执行动作（高风险操作前要再确认一次目标）
   - 禁言：`local__qq_group_ban`（默认 600 秒，可按需求调整）
   - 全员禁言：`local__qq_group_wholeBan`
   - 踢人：`local__qq_group_kick`
   - 改群名：`local__qq_group_setName`
   - 改名片：`local__qq_group_setCard`
   - 退群：`local__qq_group_leave`

## 参数/约束
- `group_id` / `user_id` 必须来自上下文或工具结果。
- 禁言 `duration` 以秒为单位；不确定时用默认值。

## 常见错误与补救
- 群/成员 ID 不确定：先 list/info 再执行。
- 操作失败：返回原因要可恢复（如权限不足、目标不存在）。
