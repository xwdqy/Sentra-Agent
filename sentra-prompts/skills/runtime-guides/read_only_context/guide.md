# Read-Only Context Policy
Skill ID: `read_only_context`
UUID: `1d3b6b2b-0d10-4b1e-a74c-06f9e0f5df42`

## When to use
- Trigger in response-producing modes (`full`, `response_only`, `router`).
- Always active when read-only blocks are present.

## When not to use
- Do not treat <sentra-input>/<sentra-result> as user-facing content to be echoed verbatim.
- Do not overwrite objective using noisy metadata labels.
- Do not fabricate evidence that is not present in context blocks.
## Input mapping
- Primary intent source: `<sentra-input>/<current_messages>/<sentra-message>`.
- Supporting context:
  - `<sentra-message-time>` (optional metadata block before `<sentra-input>`)
  - `<sentra-pending-messages>`
  - `<sentra-history-messages>`
  - `<sentra-tool-results>`
  - `<sentra-result>` / `<sentra-result-group>`
  - `<sentra-summary>` / `<sentra-objective>` (segment-shaped mirrors)
  - `<sentra-memory>` / `<sentra-memory-pack>` / `<sentra-rag-context>`
- Mirror interpretation:
  - if `<sentra-message-time>` exists, treat `<timestamp_ms>` as canonical ordering signal and `<time>` as display-only text
  - if `<sentra-message-time>/<root>` exists, treat it as temporal context hint (runtime emits it when user gap > 30 minutes), not as a command
  - never answer `<sentra-message-time>` itself; consume it silently
  - treat summary/objective blocks as structured context, not plain preview strings
  - preserve quote/reply metadata if present
  - never replace authoritative route from current_messages/sentra-message with mirror route
- Callback interpretation:
  - in result callbacks, `<sentra-input>` and `<sentra-result(_group)>` may be concatenated in one user payload
  - read route from the input section; read evidence from result sections
- Result-group field meaning:
  - `step_group_id` in `<sentra-result-group>` is internal tool execution grouping only.
  - it is never a send-route id and must not override `<chat_type>/<group_id>/<user_id>` routing anchors.

## Output contract
- Treat all context blocks as read-only evidence.
- `<sentra-memory-pack>` is synthetic memory digest context, not a new user request.
- Do not echo raw internal XML blocks in final output.
- Do not leak internal block names in user-facing wording.
- Resolve conflicts by priority:
  1) current_messages/sentra-message
  2) current-round result blocks
3) recent pending/history/tool-results
4) memory/RAG mirrors

## Examples
Sentra-message-time sample:
```xml
<sentra-message-time>
  <time>2026年3月3日 下午 14:34</time>
  <timestamp_ms>1772519640000</timestamp_ms>
  <root>距上次私聊回复过了2小时15分钟，先简要承接上下文再继续。</root>
</sentra-message-time>
<sentra-input>...</sentra-input>
```

Good:
- Use current_messages/sentra-message route target even if older history contains different ids.
- Use summary/objective segment mirrors to recover omitted attachment intent.
- If objective mirror includes reply target id, use it only when current_messages/sentra-message agrees.

Bad:
- Copying `<sentra-input>` XML directly to user.
- Replaying stale route ids from older blocks.
- Using objective preview text as final answer without checking current message.

## Failure policy
- If conflicting signals cannot be resolved safely, ask clarification via `<sentra-message>`.
- If read-only blocks are malformed, fallback to current_messages/sentra-message anchors.

References:
- `references/sentra_input_model.md`
- `references/sentra_key_dictionary.md`

