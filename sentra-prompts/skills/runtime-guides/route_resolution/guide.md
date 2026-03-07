# Route Resolution and Top-Level Gate
Skill ID: `route_resolution`
UUID: `8c6fa5eb-17a9-4b2e-874f-d8e295ddf501`

## When to use
- Trigger in every round and every mode.
- Trigger before any segment composition or tool call planning.
- Trigger whenever the model sees `<sentra-input>` and must choose output root.

## When not to use
- Do not output both <group_id> and <user_id> in one <sentra-message>.
- Do not keep stale route from previous turn when current chat_type changed.
- Do not add group-only fields (for example `at` segments or `group_id`) to private-chat payloads.
## Input mapping
- Primary route anchors come from `<sentra-input>/<current_messages>/<sentra-message>`:
  - `<chat_type>`: `group` or `private`
  - `<group_id>` for group turns
  - `<sender_id>` for private turns
  - `<message>/<segment>/<data>/<message_id>` for quote/reply opportunities
- Supporting route hints can exist in:
  - `<sentra-pending-messages>`
  - `<sentra-history-messages>`
  - `<sentra-tool-results>`
- Non-route fields to ignore for routing:
  - `<sentra-result-group step_group_id="...">` uses internal execution grouping only.
  - never treat `step_group_id` (or result-group metadata) as chat `group_id`.
- Route priority:
  - `current_messages/sentra-message` route is authoritative
  - history and pending are advisory
  - never reuse stale route ids when current_messages/sentra-message disagrees
- Top-level gate decision:
  - result tags present -> output `<sentra-message>`
  - no result tags and no tool required -> output `<sentra-message>`
  - no result tags and tool required -> output `<sentra-tools>`

## Output contract
- Output exactly one top-level block.
- Allowed roots:
  - `<sentra-message>`
  - `<sentra-tools>`
- If root is `<sentra-message>`:
  - include `<chat_type>` with value `group` or `private`
  - include exactly one route tag
  - if `chat_type=group`, route tag must be `<group_id>` only
  - if `chat_type=private`, route tag must be `<user_id>` only
  - never include both in the same block
  - if `chat_type=private`, never emit group-only semantics in segments (for example `at` or `poke.data.group_id`)
- Route mapping rules:
  - if chat_type is `group` -> use `<group_id>` from current_messages/sentra-message
  - if chat_type is `private` -> use `<user_id>` equal to current_messages/sentra-message sender_id
- If root is `<sentra-tools>`:
  - do not include route tags
  - tool call payload only
- Do not output legacy wrappers or dual roots.

## Examples
Group response route:
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>I have received your request and will continue in this group thread.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Private response route:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2987345656</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>I can continue this in private chat and keep the same context.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Tools gate route:
<sentra-tools>
  <invoke name="local__search">
    <parameter name="query">
      <string>napcat message segment image send rule</string>
    </parameter>
  </invoke>
</sentra-tools>

Invalid dual-route response:
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <user_id>2987345656</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>This is invalid because two route tags are present.</text>
      </data>
    </segment>
  </message>
</sentra-message>

## Failure policy
- If chat_type is missing, repair by deriving from current_messages/sentra-message route context.
- If chat_type is private and sender_id is missing, return a single clarification text segment in the safest known route.
- If route is fully unknown, prefer a minimal clarification message over fabricated ids.
- If both roots are generated, keep only the gate-valid root and repair.
 - If private output contains group-only fields/tags, remove them before final output.

References:
- `references/sentra_input_model.md`
- `references/sentra_output_examples.md`
- `references/sentra_key_dictionary.md`

