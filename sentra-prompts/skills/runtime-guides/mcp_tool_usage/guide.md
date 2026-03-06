# MCP Tool Usage Policy
Skill ID: `mcp_tool_usage`
UUID: `a0f66b40-27b5-47e5-a585-9008011af0df`

## When to use
- Trigger when MCP catalog is present and tools are part of current plan.
- Applies to both tool argument generation and result consumption behavior.

## When not to use
- Do not call tools when no external action/data is required.
- Do not describe tool execution process to users as final answer content.
- Do not convert incomplete tool output into fabricated definitive facts.
## Input mapping
- Capability boundary: `<sentra-mcp-tools>`.
- Tool request context: `<sentra-input>` and planning context.
- Artifact evidence: tool result contracts and dependency outputs (`uuid/path/hash`).
- Callback transport shape:
  - result callbacks are carried in a single user payload where `<sentra-input>` appears first
  - `<sentra-result>` / `<sentra-result-group>` is appended below in the same payload
- Result key semantics:
  - `<sentra-result-group step_group_id="...">`: internal execution group id, not chat route id.
  - `group_size`: number of result items in this group.
  - `order_step_ids`: execution/topology order to consume group items.
  - `status`: `progress` means partial callback; `final` means completion callback.
  - `<sentra-result step_id="..." tool="..." success="..." status="...">`:
    - `step_id`: stable step identifier in the current run.
    - `tool`: tool id (`aiName`) that produced this item.
    - `success`: tool success flag for this item.
    - `status`: per-item progress/final marker.
    - no `args` contract in result callbacks; read actionable evidence from `result/data`.

## Output contract
- Use only explicitly available MCP tools.
- Match schema fields/types exactly.
- Prefer batched operations when schema supports arrays.
- Reuse artifact evidence from dependency outputs instead of re-deriving paths.
- In response rounds, translate tool outcomes into user-facing `<sentra-message>`.
- Always resolve route from the `<sentra-input>` section, never from result-group ids.

## Examples
Good behavior:
- Choose listed tool only.
- Reuse returned file path in follow-up output segment.
- Report uncertainty when tool result is partial.

Bad behavior:
- Inventing tool names not present in catalog.
- Claiming completion without evidence.
- Exposing internal error object details directly to users.

## Failure policy
- On partial/missing result, provide a clear next step and keep claims conservative.
- On schema mismatch risk, prefer safe minimal valid call.
- On dependency ambiguity, request one clarifying detail.

References:
- `references/failure_and_disclosure_policy.md`
- `references/sentra_output_examples.md`
- `references/sentra_key_dictionary.md`

