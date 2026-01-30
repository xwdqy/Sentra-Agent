# 定时意图（Schedule Intent）

## 识别规则
- 用户提到未来时间/时间窗口/周期行为时，视为定时或延时意图
  - 例如：10 分钟后、今晚、明天早上、下周一、每天 9 点、每周五

## 参数生成规则（当 schema 存在 schedule 字段）
- 一律使用对象形式 schedule：
  - when: 使用中文可解析相对时间（N秒后/N分钟后/N小时后/N天后）或绝对时间（YYYY-MM-DD HH:mm 或 YYYY-MM-DD HH:mm:ss）
  - language: 'zh'
  - timezone: 'Asia/Shanghai'
  - targetISO: 可选（如果上游能解析到）

## 模糊时间必须具体化
- 如果用户只说“稍后/等会/之后/改天/有空的时候/尽快”，必须具体化为明确的相对时长或明确时间点
- 禁止把模糊词原样放入 schedule.when

## 不要凭空发明延迟
- 用户没表达延迟意图时，不要加 schedule
