# Rewrite and De-dup
Skill ID: `rewrite_and_dedup`
UUID: `3b211f58-ea30-4628-ae3e-7e0c335ca18b`

## When to use
- Trigger after a draft response is assembled.
- Trigger when duplicate statements appear across segments.
- Trigger when draft contains protocol pollution (escaped XML text, JSON-string-like wrappers, or repeated boilerplate).

## When not to use
- Do not remove required evidence, IDs, file paths, or constraints while deduplicating.
- Do not rewrite into over-short text that loses user-requested deliverables.
- Do not alter route/protocol fields during style cleanup.
## Input mapping
- Draft candidate:
  - generated `<sentra-message>` or `<sentra-tools>`
  - intermediate text planned from summary/objective/history/result
- Dedup signals:
  - repeated sentence with same semantic intent
  - repeated acknowledgements in adjacent segments
  - repeated status lines in the same round
- Rewrite signals:
  - internal jargon leakage
  - markdown media placeholders instead of native segments
  - escaped xml string fragments inside text nodes

## Output contract
- Keep one clear statement per segment.
- Remove semantically duplicate segments while preserving required evidence.
- Keep stable segment order after dedup and reindex contiguously from 1.
- Preserve route tag and segment type validity.
- If one text segment is overloaded with multiple points, split it into short ordered text segments.
- If rewriting text:
  - keep user language preference
  - keep factual constraints
  - keep actionable next step if needed
- Do not output serialized/escaped XML as user text payload.

## Examples
Before (duplicated text):
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>I have received your request.</text>
      </data>
    </segment>
    <segment index="2">
      <type>text</type>
      <data>
        <text>I have received your request and will continue.</text>
      </data>
    </segment>
  </message>
</sentra-message>

After (deduplicated):
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>I have received your request and will continue now.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Before (polluted escaped payload):
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>&lt;sentra-result-group step_group_id=&quot;0&quot; status=&quot;final&quot;&gt; ...</text>
      </data>
    </segment>
  </message>
</sentra-message>

After (clean user-facing rewrite):
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>The task has completed. I will send the result output in the next segment.</text>
      </data>
    </segment>
  </message>
</sentra-message>

## Failure policy
- If dedup would remove required evidence, keep the shorter evidence-preserving segment.
- If rewrite risks changing facts, keep original factual line and only remove duplication.
- If cleanup still leaves malformed payload, pass to XML format guard for final repair.
- If both brevity and completeness conflict, prefer correctness and explicit evidence.

References:
- `references/failure_and_disclosure_policy.md`

