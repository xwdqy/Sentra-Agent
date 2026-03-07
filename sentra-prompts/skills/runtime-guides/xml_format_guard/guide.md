# XML Format Guard
Skill ID: `xml_format_guard`
UUID: `32d55f41-5c5d-4d3d-b536-d680ed9f7a57`

## When to use
- Trigger for every response before final emit.
- Trigger in all modes: `full`, `response_only`, `tools_only`, `router`.
- Trigger after rewrite/de-dup and before runtime parser validation.

## When not to use
- Do not change semantics while fixing XML format.
- Do not add extra top-level blocks beyond current gate requirement.
- Do not leave unescaped special characters in XML text nodes.
## Input mapping
- Candidate output payload generated for the current round.
- Gate expectation:
  - message mode expects `<sentra-message>`
  - tools mode expects `<sentra-tools>`
- Validation evidence:
  - top-level block count
  - XML nesting and escaping state
  - segment/type/parameter structure integrity

## Output contract
- Emit raw XML only.
- Do not wrap with markdown fences.
- Do not prepend explanation text.
- Exactly one top-level XML root.
- Allowed roots:
  - `<sentra-message>`
  - `<sentra-tools>`
- For `<sentra-message>`:
  - must include `<chat_type>` (`group` or `private`)
  - `chat_type=group` requires `<group_id>` and forbids `<user_id>`
  - `chat_type=private` requires `<user_id>` and forbids `<group_id>`
- Structural constraints:
  - balanced start/end tags
  - correct nesting order
  - valid attributes and quoted attribute values
- Escaping constraints in text nodes and string values:
  - `&` -> `&amp;`
  - `<` -> `&lt;`
  - `>` -> `&gt;`
  - `"` -> `&quot;`
  - `'` -> `&apos;`
- Serialization constraints:
  - do not output JSON-escaped xml blobs
  - do not output backslash-polluted content as protocol payload
  - do not output mixed raw text and XML siblings at root level

## Examples
Valid message output:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2987345656</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>Use &amp; and &lt;tag&gt; safely in content.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Valid tools output:
<sentra-tools>
  <invoke name="local__search">
    <parameter name="query">
      <string>sentra xml escaping rules</string>
    </parameter>
  </invoke>
</sentra-tools>

Invalid mixed root output:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2987345656</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>ok</text>
      </data>
    </segment>
  </message>
</sentra-message>
<sentra-tools>
  <invoke name="local__search">
    <parameter name="query">
      <string>x</string>
    </parameter>
  </invoke>
</sentra-tools>

Invalid escaped-string payload:
&lt;sentra-message&gt;\n  &lt;user_id&gt;2987345656&lt;/user_id&gt;\n&lt;/sentra-message&gt;

## Failure policy
- If malformed, repair XML first and revalidate.
- If multiple roots exist, keep only gate-valid root.
- If root mismatches gate mode, rebuild root with same intent under valid mode.
- If escaping is unsafe, escape then re-run structural checks.
- If final payload still cannot be validated, fallback to minimal safe `<sentra-message>` with one text segment.

References:
- `references/sentra_output_examples.md`

