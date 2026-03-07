# Message Segment Contract
Skill ID: `message_segment_contract`
UUID: `c61ca347-d71e-4c67-b8ee-ebfb1f7458d9`

## When to use
- Trigger whenever output root is `<sentra-message>`.
- Trigger in normal reply rounds and result-consume rounds.
- Trigger after route resolution has produced one target route.

## When not to use
- Do not emit invalid segment types or non-contiguous segment indexes.
- Do not place protocol-only fields inside text content.
- Do not send at/group-target segments in private chat.
## Input mapping
- Message intent source:
  - `<sentra-input>/<current_messages>/<sentra-message>/<message>/<segment>`
- Evidence enrichers:
  - pending/history/tool-result blocks
  - current `<sentra-result>` or `<sentra-result-group>`
- Segment planning:
  - convert one user intent into ordered segments
  - keep each segment semantically atomic
  - prefer explicit type instead of overloaded text
- Key semantics in `<sentra-message>`:
  - `<chat_type>`: conversation route mode (`group` or `private`).
  - `<group_id>`: group target id; valid only when `chat_type=group`.
  - `<user_id>`: private target id; valid only when `chat_type=private`.
  - `<message>`: container of output segments.
  - `<segment index="N">`: one atomic delivery unit in send order.
  - `<type>`: segment channel (`text|at|reply|image|file|video|record|music|poke|recall`).
  - `<data>`: per-type payload object.
  - `<data><message_id>`: optional runtime delivery receipt id injected per segment after successful send; read-only for model.

## Output contract
- Canonical response shape:
  - `<sentra-message>`
  - one `<chat_type>` (`group` or `private`)
  - exactly one route tag
  - `<message>` containing one or more `<segment>`
- Route/chat consistency:
  - `chat_type=group` -> must include `<group_id>` only
  - `chat_type=private` -> must include `<user_id>` only
  - `chat_type=private` -> never include `<group_id>`
- Segment index rules:
  - index starts at `1`
  - index is contiguous and strictly increasing
  - no duplicate index values
- Supported segment types and required fields:
  - `text` -> `<data><text>...</text></data>`
  - `at` -> `<data><qq>...</qq></data>`
  - `reply` -> `<data><id>...</id></data>`
  - `image` -> `<data><file>...</file></data>`
  - `file` -> `<data><file>...</file></data>`
  - `video` -> `<data><file>...</file></data>`
  - `record` -> `<data><file>...</file></data>`
  - `music` -> `<data><type>163</type><id>123456</id></data>`
  - `poke` -> `<data><user_id>2166683295</user_id><group_id>1002812301</group_id></data>` (group) or `<data><user_id>2166683295</user_id></data>` (private)
  - `recall` -> `<data><message_id>1772103757523</message_id></data>`
  - optional common receipt field on any segment: `<data><message_id>...</message_id>` (runtime-injected, do not fabricate)
- Sticker rule:
  - local sticker delivery must use `image` segment with concrete local absolute path in `data.file`.
  - do not output non-protocol custom segment types (for example `face`).
- Type-value meaning:
  - `at.data.qq`: target QQ id (or platform-specific mention value such as `all` when supported).
  - `reply.data.id`: quoted/original message id.
  - `image/file/video/record.data.file`: concrete resource path or provider-accepted file locator.
  - `music.data.type`: music platform id (`qq|163|kugou|migu|kuwo`).
  - `music.data.id`: song id from target platform.
  - `poke.data.user_id`: target QQ id to poke (required).
  - `poke.data.group_id`: required when `chat_type=group`; must be omitted when `chat_type=private`.
  - `recall.data.message_id`: target message id for recall action (required).
  - `*.data.message_id`: runtime send receipt id for that segment; if present, treat as immutable context metadata.
- Composition constraints:
  - default behavior is segment-first delivery: keep each segment as one delivery unit in order.
  - for text-heavy replies, prefer structured split instead of one large paragraph:
    - use `1` segment for very short replies (single-point ack/answer).
    - use `2-4` text segments when there are multiple points (status, key facts, next action, clarification).
    - if your draft contains multiple lines, bullet-like clauses, or 2+ independent instructions, convert them into multiple text segments.
    - keep one core point per text segment; avoid mixing many instructions in one segment.
    - keep each text segment short (usually 1-2 short sentences).
    - recommended order: acknowledgement/progress -> key result or facts -> next step/question.
    - avoid newline-packed mega text in one segment.
  - `reply` is the only constrained control segment: it must be paired with a `text` or `image` anchor in the same delivery unit.
  - `chat_type=private`: do not output `at` segment.
  - `chat_type=group`: `at` can be standalone, and can also appear between `reply` and its anchor.
  - `file`, `video`, `record`, `music`, `poke`, and `recall` should be emitted as standalone delivery actions.
  - `music` compatibility rule:
    - in private chat, keep exactly one `music` segment per `<sentra-message>`;
    - if user wants multiple songs, send one song card per message turn (or ask user to pick one first).
  - for human-like poke turns, `text + poke (+ text)` is allowed in one `<sentra-message>` as ordered segments; keep `poke` itself as native `type=poke`.
  - this is advisory, not mandatory: when user asks for direct poke-only action, avoid adding unnecessary text.
  - put `at` before related text when addressing a target user.
  - do not place markdown image links inside text as media substitute.
  - do not output empty `<message>`.

## Examples
Valid reply-bound flow (reply + at + text):
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <message>
    <segment index="1">
      <type>reply</type>
      <data>
        <id>9988776655</id>
      </data>
    </segment>
    <segment index="2">
      <type>at</type>
      <data>
        <qq>2166683295</qq>
      </data>
    </segment>
    <segment index="3">
      <type>text</type>
      <data>
        <text>The image is ready.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Valid structured text split (multi-point answer):
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2987345656</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>Received. I will first organize the key points you requested.</text>
      </data>
    </segment>
    <segment index="2">
      <type>text</type>
      <data>
        <text>First, windowing and dedup can share one budget layer to reduce cumulative latency.</text>
      </data>
    </segment>
    <segment index="3">
      <type>text</type>
      <data>
        <text>Second, add lightweight pre-filtering before semantic similarity for steadier performance.</text>
      </data>
    </segment>
    <segment index="4">
      <type>text</type>
      <data>
        <text>Do you want me to implement the runnable constants-based version next?</text>
      </data>
    </segment>
  </message>
</sentra-message>

Valid standalone file delivery action:
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>The export is complete. Sending the file as a standalone action.</text>
      </data>
    </segment>
    <segment index="2">
      <type>file</type>
      <data>
        <file>E:/sentra-agent/artifacts/final_patch.diff</file>
      </data>
    </segment>
  </message>
</sentra-message>

Valid private text-only reply:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2987345656</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>I checked your request and prepared the next concrete step.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Valid private music card delivery:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2987345656</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>Here is the song card. Tap it to play directly.</text>
      </data>
    </segment>
    <segment index="2">
      <type>music</type>
      <data>
        <type>163</type>
        <id>347230</id>
      </data>
    </segment>
  </message>
</sentra-message>

Invalid segment payload:
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <message>
    <segment index="1">
      <type>image</type>
      <data>
        <text>![img](E:/a.webp)</text>
      </data>
    </segment>
  </message>
</sentra-message>

## Failure policy
- If one segment is invalid, repair that segment and keep valid siblings.
- If all segments are invalid after repair, fallback to one safe text segment.
- If index sequence is broken, regenerate indexes from 1 in displayed order.
- If type field is unsupported, replace with text that explains the same intent.

References:
- `references/sentra_segment_schema.md`
- `references/sentra_output_examples.md`
- `references/sentra_key_dictionary.md`

