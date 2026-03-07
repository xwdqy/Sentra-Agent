# Poke Segment Delivery
Skill ID: `poke_segment_delivery`
UUID: `6ef7c6d3-3ec1-48a6-95cf-f24f2bdca78f`

## When to use
- Trigger when user explicitly requests poke/nudge behavior.
- Trigger when output root is `<sentra-message>` and action intent is poke, not plain text narration.
- Trigger in both private and group routes after route resolution.

## When not to use
- Do not emit poke segment without explicit target user_id.
- Do not use poke when user intent is pure text reply.
- Do not send group_id in private route poke payloads.
## Input mapping
- Route context:
  - `chat_type=group` uses route `<group_id>`
  - `chat_type=private` uses route `<user_id>`
- Poke target mapping:
  - poke target QQ -> `<segment type="poke"><data><user_id>...</user_id></data></segment>`
  - group poke must also provide `<group_id>` inside poke data
- Optional style mapping:
  - short `text` + `poke` (+ short `text`) is allowed when it improves naturalness

## Output contract
- Use native `poke` segment; do not fake poke as pure text.
- Required fields:
  - always require `poke.data.user_id`
  - require `poke.data.group_id` when `chat_type=group`
  - forbid `poke.data.group_id` when `chat_type=private`
- Keep route consistency:
  - group route id in message head and poke data must match
- Avoid over-talking:
  - if user asks direct poke-only, prefer direct poke action

## Examples
Valid group poke:
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>1002812301</group_id>
  <message>
    <segment index="1">
      <type>poke</type>
      <data>
        <user_id>2166683295</user_id>
        <group_id>1002812301</group_id>
      </data>
    </segment>
  </message>
</sentra-message>

Valid private poke:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>poke</type>
      <data>
        <user_id>2166683295</user_id>
      </data>
    </segment>
  </message>
</sentra-message>

Invalid private poke (must not include group_id):
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>poke</type>
      <data>
        <user_id>2166683295</user_id>
        <group_id>1002812301</group_id>
      </data>
    </segment>
  </message>
</sentra-message>

## Failure policy
- If user id is missing, ask one concise clarification message.
- If group route exists but poke group_id is missing, repair using message route group_id.
- If poke action conflicts with safety/policy constraints, downgrade to concise text explanation.
