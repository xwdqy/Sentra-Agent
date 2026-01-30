# 本地检索 / 解析 / 读取（Web Research）

## 适用场景
- 需要“最新信息/实时信息/网页内容摘要/仓库信息/天气/站内搜索”。

## 工作流
1. 先拿到来源
   - 实时搜索：`local__realtime_search`
   - B站搜索：`local__bilibili_search`
   - GitHub 仓库信息：`local__github_repo_info`
   - 天气：`local__weather`
2. 再解析/读取
   - 网页解析：`local__web_parser`
   - 文档读取：`local__document_read`
   - 网页渲染截图：`local__web_render_image`
3. 输出
   - 结论必须能对应到工具结果，不要编造“我点进去看了”。

## 常见错误与补救
- 只有结论没有证据：补一次 parser/read，把关键段落带出来。
