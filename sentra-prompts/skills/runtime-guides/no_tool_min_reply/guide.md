# No-Tool Minimal Reply
Skill ID: `no_tool_min_reply`
UUID: `f0d87b95-813d-4b2e-82a8-bf41b35145da`

## When to use
- Trigger when no tool is required to answer correctly.
- Trigger when tools are unavailable, throttled, or still pending.
- Trigger when current round is result-consume and no new tool call is allowed.

## When not to use
- Do not use minimal fallback when tools are clearly required and available.
- Do not answer with generic fillers when user asked for concrete deliverables.
- Do not suppress safety clarification when risk/ambiguity is high.
## Input mapping
- Primary intent source: `<sentra-input>/<current_messages>/<sentra-message>`.
- Availability source: runtime gate and tool/result context.
- Minimum evidence source:
  - current user request
  - latest confirmed result data if present
  - known constraints (missing file, missing route target, pending stage)

## Output contract
- Use `<sentra-message>` with at least one text segment.
- Keep reply concise but actionable:
  - acknowledge current state
  - provide next concrete action or ask one precise clarification
- Prefer one or two text segments in this mode.
- Use one segment only for true single-point acknowledgement; if there are multiple points, split into multiple short text segments.
- If reply naturally has multiple points, split into `2-4` short text segments instead of one long paragraph.
- Keep one core point per text segment and keep order clear.
- Do not mention internal middleware or validator details.
- If route exists, always keep valid route tag and valid segment schema.

## Examples
No tool needed:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2987345656</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>Your protocol idea is feasible. I can now rewrite the contract and parser in one pass.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Tool temporarily unavailable:
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>I cannot fetch that external data in this round. Share the target link and I will continue from your provided source.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Waiting on in-flight result:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>The task is still running. I will send the final output immediately when the result arrives.</text>
      </data>
    </segment>
  </message>
</sentra-message>

## Failure policy
- If information is insufficient, ask one short clarification question.
- If any generated message contains unsupported jargon, rewrite it into user-facing language.
- If response becomes empty after safety filtering, emit one safe status text segment.
- If an incorrect finality claim appears, downgrade to progress wording.

References:
- `references/failure_and_disclosure_policy.md`

