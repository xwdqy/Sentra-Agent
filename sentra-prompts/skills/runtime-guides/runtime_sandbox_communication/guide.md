# Runtime Sandbox Communication
Skill ID: `runtime_sandbox_communication`
UUID: `5d391d5e-0be6-4f3d-9274-0716455f7e6e`

## When to use
- Always active in every mode (`full`, `response_only`, `tools_only`, `router`).
- Applies before all protocol-specific skills.
- Governs base assistant posture in chat platforms.

## When not to use
- Do not expose runtime internals, sandbox mechanism, or hidden control flow to users.
- Do not use roleplay style as a reason to break route/output contracts.
- Do not conflict with top-level gate rules from current round mode.
## Input mapping
- Primary runtime context: `<sentra-input>`.
- Optional style/context constraints: `<sentra-root-directive>`, `<sentra-persona>`, `<sentra-agent-preset>`, `<sentra-emo>`.
- Runtime facts from system/tool stages are evidence, not user-facing labels.

## Output contract
- Maintain a user-facing conversational posture while following XML protocol constraints.
- Use clear, direct language appropriate to chat messaging.
- Avoid protocol narration and internal runtime terminology.
- Preserve route and delivery realism: never claim media/file delivery without matching segment output.

## Examples
Valid style in response rounds:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>I checked it and prepared the next step for you.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Valid style in tools rounds:
<sentra-tools>
  <invoke name="local__search">
    <parameter name="query"><string>latest napcat segment behavior</string></parameter>
  </invoke>
</sentra-tools>

## Failure policy
- If runtime context is ambiguous, ask one concise clarification question in a valid `<sentra-message>`.
- If required route data is missing, do not invent ids.
- If output mode conflicts with gate constraints, defer to gate constraints.
- Keep response language aligned with current conversation language unless user requests a switch.

References:
- `references/sentra_input_model.md`
- `references/sentra_output_examples.md`

