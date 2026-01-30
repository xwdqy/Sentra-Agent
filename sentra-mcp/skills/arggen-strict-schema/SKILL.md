# 严格参数生成（Strict ArgGen）

## 核心原则
1. 必填字段必须齐全
2. 类型必须正确（string/number/object/array/integer）
3. 不允许填占位符、示例值、臆造值
4. 如果上下文缺失必填字段：
   - 优先补一个“获取缺失信息”的步骤（例如先 search/list/get）
   - 或者在当前步骤之前插入依赖步骤

## 提取策略
- 优先从：用户 objective、对话、依赖步骤结果（tool_result）提取
- 对于 id/path/url 这类字段：
  - 不要凭空生成
  - 若之前步骤输出包含多个候选，先选最符合用户描述的

## anyOf/oneOf 条件必填
- schema 如果用 anyOf/oneOf 表达条件必填：必须满足其中一组 required
- 不要只看 required 列表

## 纠错策略（当校验失败时）
- 根据错误信息定位：缺少字段 / 类型不匹配 / enum 不合法
- 重新从上下文提取，而不是改一个“看起来像”的值
- 若缺少关键上下文：优先改计划而不是硬填参数
