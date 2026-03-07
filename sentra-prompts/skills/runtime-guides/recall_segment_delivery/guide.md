# Recall Segment Delivery
Skill ID: `recall_segment_delivery`
UUID: `3f4fb6eb-1781-45e7-9d6d-818d6ad6f216`

## When to use
- Trigger when user explicitly asks to recall/delete a sent message.
- Trigger when target message id is already known in context and output root is `<sentra-message>`.
- Trigger in both private and group routes after route resolution.

## When not to use
- Do not emit recall without valid numeric message_id.
- Do not recall arbitrary messages when user did not request recall intent.
- Do not treat vague delete intent as recall unless target message is clear.
## Input mapping
- Recall target mapping:
  - target message id -> `<segment type="recall"><data><message_id>...</message_id></data></segment>`
- Route mapping:
  - `chat_type=group` uses `<group_id>`
  - `chat_type=private` uses `<user_id>`
- Optional style mapping:
  - short `text` + `recall` (+ short `text`) is allowed when this improves clarity.

## Output contract
- Use native `recall` segment; do not fake recall as plain text.
- Required field:
  - always require `recall.data.message_id` (positive numeric id)
- Keep route consistency:
  - group route uses only `<group_id>`
  - private route uses only `<user_id>`
- If message id is missing:
  - do not fabricate
  - ask one concise clarification.

## Examples
Valid private recall:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>recall</type>
      <data>
        <message_id>1907295502</message_id>
      </data>
    </segment>
  </message>
</sentra-message>

Valid group recall with a short lead-in:
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>1002812301</group_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>收到，我现在撤回这条。</text>
      </data>
    </segment>
    <segment index="2">
      <type>recall</type>
      <data>
        <message_id>1772103757523</message_id>
      </data>
    </segment>
  </message>
</sentra-message>

Invalid recall (missing message_id):
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>recall</type>
      <data>
      </data>
    </segment>
  </message>
</sentra-message>

## Failure policy
- If message id is missing or invalid, request one short clarification.
- If recall conflicts with policy/safety constraints, return one concise text explanation.
