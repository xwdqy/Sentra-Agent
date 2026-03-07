# Result Round Bridge
Skill ID: `result_round_bridge`
UUID: `e95f6767-87ad-41f9-ac79-d91de0f65e9b`

## When to use
- Trigger when context contains `<sentra-result>` or `<sentra-result-group>`.
- Trigger in tool callback rounds (`tool_pre_reply`, `tool_progress`, `tool_result_stream`, final callback).
- Trigger when there is completed or partial evidence to convert into user-facing updates.

## When not to use
- Do not use this bridge when no <sentra-result> or <sentra-result-group> evidence exists.
- Do not ignore execution order fields when result_group is present.
- Do not claim final completion before result status indicates final/completed.
## Input mapping
- Result source:
  - `<sentra-result-group>`
  - nested `<sentra-result>`
  - `<reason>`, `<result_ref>`, status fields
  - runtime payloads in `<result>/<data>` (do not rely on `args` in result callbacks)
- Callback user payload shape:
  - a single `user` content block contains:
    1) `<sentra-input>` (current route + current message)
    2) followed by `<sentra-result>` or `<sentra-result-group>`
  - do not expect base input and result in separate `user` turns
- Result-group keys:
  - `step_group_id`: internal execution group id for ordering/correlation only.
  - `group_size`: total item count in the current result group.
  - `order_step_ids`: step ids in intended consume order.
  - `status`: progress/final state for bridge behavior.
- Route source:
  - current_messages/sentra-message route in sentra-input
  - existing conversation identity when callback route is implicit
- Delivery source:
  - file path / URL in result refs
  - status: progress vs final

## Output contract
- In result rounds, output `<sentra-message>`, not `<sentra-tools>`.
- Treat the appended result block as current-round evidence while keeping route from the `sentra-input` section above it.
- Bridge policy:
  - if status is progress -> progress text segments only
  - if status is final and artifact exists -> text + native media/file segment
  - if status is final but no deliverable -> text summary + next step
- Keep response grounded in actual result evidence.
- Do not repeat full internal result XML to users.
- Do not initiate unrelated new tasks in the same result bridge reply.

## Examples
Typical result payload (read-only evidence):
<sentra-result-group>
  <step_group_id>0</step_group_id>
  <group_size>1</group_size>
  <order_step_ids>s_draw_lolita_girl_1</order_step_ids>
  <status>final</status>
  <sentra-result>
    <step_id>s_draw_lolita_girl_1</step_id>
    <tool>local__image_draw</tool>
    <success>true</success>
    <status>final</status>
    <reason>The user requested a lolita-style character drawing and this tool can render it directly.</reason>
    <result_ref>
      <uuid>c2e32c5b-1e23-4f89-a4bf-a0c21834df5b</uuid>
      <path>E:/sentra-agent/artifacts/draw_1771683582860_0.webp</path>
      <type>image/webp</type>
    </result_ref>
  </sentra-result>
</sentra-result-group>

Final media bridge reply:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>The drawing is complete. Sending the generated image.</text>
      </data>
    </segment>
    <segment index="2">
      <type>image</type>
      <data>
        <file>E:/sentra-agent/artifacts/draw_1771683582860_0.webp</file>
      </data>
    </segment>
  </message>
</sentra-message>

Progress bridge reply:
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>The generation task is still running. I will send the final output as soon as it is done.</text>
      </data>
    </segment>
  </message>
</sentra-message>

## Failure policy
- If result status conflicts across items, report the most conservative state.
- If artifact path is missing, avoid "sent" wording and provide progress or retry text.
- If result is clearly failed, explain failure in user language and provide one practical next step.
- If callback route is ambiguous, prefer current conversation route and avoid cross-thread delivery claims.
- If legacy logs show split user turns (input/result separated), treat them as one logical callback input.

References:
- `references/sentra_output_examples.md`
- `references/failure_and_disclosure_policy.md`
- `references/sentra_key_dictionary.md`

