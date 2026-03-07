# realtime_search

## Capability

- **Multi-Source Resilience**: Execute web-grounded search with automatic fallback across multiple providers (Gemini Native Grounding, Tavily, Serper, or Model Knowledge).
- **Provider Chain**: Automatically tries the best available search engine based on configuration (`auto`, `serper`, `tavily`, etc.).
- **Performance Optimization**: Includes an internal memory cache to speed up repeated queries and reduce API costs.
- **Support**: Handles single query, batch queries, and raw request passthrough.

## Failure modes

- `INVALID`: Missing query/queries or malformed request.
- `TIMEOUT`: All upstream search providers (Gemini/Tavily/Serper) failed to respond within the `REALTIME_SEARCH_UPSTREAM_TIMEOUT_MS`.
- `ERR`: All configured providers in the chain failed (e.g., API keys invalid or rate-limited). Error messages are automatically redacted for security.

## Success Criteria

- **Single-query success**: Requires `result.success === true`, `result.code === "OK"`, and non-empty `data.answer_text`.
- **Provider Info**: Result must include `data.provider` (indicating which engine succeeded, e.g., "gemini" or "tavily+model") and `data.provider_chain`.
- **Citations**: `data.citations` must exist as an array. If `provider` is "gemini", citations usually contain titles and URIs.
- **Cache Metadata**: Successful results may optionally include `data.cache_hit: true`.
- **Batch success**: Requires `result.success === true`, `result.data.mode === "batch"`, and at least one item within `result.data.results` having `success === true`.
- **Content Integrity**: For any successful search, `item.data.answer_text` must not be empty and should contain source markers like [1], [2].
- **Security**: Error details in `result.error` must not leak API keys or tokens (verify redaction).
