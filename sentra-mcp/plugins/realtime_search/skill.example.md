# realtime_search

## Capability

- 实时联网检索采用多级自动降级链路（默认 `provider=auto`）：
  1. **Gemini 官方原生搜索**（`googleSearch`）
  2. **Tavily 搜索**
  3. **Serper 搜索**
  4. **纯大模型回答**（无联网）
- 支持单条查询、批量查询，以及 `rawRequest` 透传（OpenAI chat.completions payload）。
- 内置查询缓存（默认 24h）减少重复搜索消耗。

## Real-world impact

- 会访问外部搜索 API（Gemini/Tavily/Serper）与 OpenAI 兼容模型接口，可能产生费用/额度消耗。
- 当上游搜索全部失败时，会自动降级为纯模型回答，保障可用性。

## When to use

- 需要“最新信息/刚发生的事件/实时数据”的问题。
- 需要给出可核验来源（citations）的问答场景。

## When NOT to use

- 用户问题不需要联网（如纯常识、代码推理）时。
- 无法配置任一上游搜索 API 且不接受“纯模型回答”时。

## Input

- Provide one of:
  - `query` (string)
  - `queries` (string[])：批量同类查询（顺序执行）
  - `rawRequest` (object)：透传到 OpenAI-compatible chat.completions（仍强制使用配置 model）
- Optional:
  - `provider` (`auto|gemini|tavily|serper|model`)：控制起始 provider 与降级顺序
  - `max_results` (1-20; default 5)
  - `include_domains` / `exclude_domains`（主要作用于 Tavily）

运行环境/配置（插件 env 或进程 env）：
- `REALTIME_SEARCH_PROVIDER`（默认 `auto`）
- `GEMINI_NATIVE_API_KEY` / `GEMINI_NATIVE_MODEL` / `GEMINI_NATIVE_BASE_URL`
- `TAVILY_API_KEY` / `TAVILY_BASE_URL`
- `SERPER_API_KEY` / `SERPER_BASE_URL`
- `REALTIME_SEARCH_BASE_URL` / `REALTIME_SEARCH_API_KEY` / `REALTIME_SEARCH_MODEL`（用于 Tavily/Serper 结果总结与最终纯模型兜底）
- `REALTIME_SEARCH_UPSTREAM_TIMEOUT_MS`
- `REALTIME_SEARCH_CACHE_TTL_MS` / `REALTIME_SEARCH_CACHE_MAX_SIZE`
- `REALTIME_SEARCH_BATCH_DELAY_MS`

## Output

- 单条模式：
  - `query`
  - `answer_text`
  - `citations`
  - `provider`（实际命中提供方）
  - `provider_chain`（本次尝试顺序）
  - `cache_hit`（可选，缓存命中）
  - `model/created/completion_id/usage`
- 批量模式：`{ mode: 'batch', results: [{ query, success, data|error|code|advice }] }`
- Execute web-grounded search through configured search-capable LLM endpoint.
- Supports single query, batch queries, and raw request passthrough.

## Failure modes

- `INVALID`
- `TIMEOUT`
- `ERR`

## Success Criteria

- `INVALID`: 未提供 `query/queries/rawRequest`。
- `TIMEOUT`: 上游搜索或模型请求超时。
- `ERR`: 全链路 provider 均失败或其他异常。
- Single-query success requires `result.success === true`, `result.code === "OK"`, and non-empty `data.answer_text`.
- Single-query evidence must include `data.model`; `data.citations` must exist as array (can be empty).
- Batch success requires `result.success === true`, `result.data.mode === "batch"`, non-empty `result.data.results`, and at least one item with `success === true`.
- For successful batch items, `item.data.answer_text` must be non-empty.
- If all batch items fail, this step must not pass.
