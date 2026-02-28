# realtime_search

## Capability

- 实时联网检索：支持 OpenAI 兼容（含 newapi 中转）、Gemini 原生 Google Search、Tavily 搜索。
- 支持单条查询、批量查询，以及 `rawRequest` 透传（OpenAI chat.completions payload）。

## Real-world impact

- 外部网络请求：会向配置的 OpenAI 兼容接口发起请求（会产生费用/额度消耗）。
- 不会下载网页内容到本地；结果引用来自模型输出的 URL。

## When to use

- 需要“最新信息/刚发生的事件/实时数据”的问题。
- 需要给出可核验来源（工具会从回答文本里提取 URL 作为 citations）。

## When NOT to use

- 用户问题不需要联网（例如纯常识/代码推理）时。
- 无法配置联网模型或网络受限时（此时应改为基于已有知识回答，并提示无法实时检索）。

## Input

- Provide one of:
  - `query` (string)
  - `queries` (string[])：批量同类查询（工具会顺序执行，并在批量项之间 sleep）
  - `rawRequest` (object)：透传请求（openai_compatible 透传 chat.completions；gemini/tavily 透传各自原生 payload）
- Optional:
  - `max_results` (integer 1-20; default 5)：写入 system prompt（提示模型最多参考 N 条）
  - `include_domains` (string|string[])：只引用这些域名
  - `exclude_domains` (string|string[])：排除这些域名

运行环境/配置（从插件 env 或进程 env 读取）：
- `REALTIME_SEARCH_PROVIDER`（默认 `openai_compatible`，可选：`openai_compatible`/`gemini`/`tavily`）
- `REALTIME_SEARCH_MODEL`（默认 `gpt-4o-search`）
- OpenAI 兼容模式：`REALTIME_SEARCH_BASE_URL` / `REALTIME_SEARCH_API_KEY`
- Gemini 模式：`REALTIME_SEARCH_GEMINI_BASE_URL`（默认 Google 官方地址）/ `REALTIME_SEARCH_GEMINI_API_KEY`
- Tavily 模式：`REALTIME_SEARCH_TAVILY_BASE_URL` / `REALTIME_SEARCH_TAVILY_API_KEY`
- `REALTIME_SEARCH_BATCH_DELAY_MS`（批量查询间隔，默认 250ms）
- provider 对应的 API Key 为空时会直接返回 `INVALID`（避免发起无效请求）

## Output

- 单条模式：
  - `query`
  - `answer_text`：模型生成的最终答案（通常末尾包含引用 URL）
  - `citations`：从 `answer_text` 里正则提取出的 URL 列表
  - `model/created/completion_id/usage`
- 批量模式：`{ mode: 'batch', results: [{ query, success, data|error|code|advice }] }`

## Failure modes

- `INVALID`: 未提供 `query/queries/rawRequest`。
- `TIMEOUT`: 上游请求超时。
- `ERR`: 上游接口报错/网络异常。
