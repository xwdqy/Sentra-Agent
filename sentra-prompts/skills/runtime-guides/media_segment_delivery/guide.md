# Media Segment Delivery
Skill ID: `media_segment_delivery`
UUID: `4fd3d55a-515f-4d90-a82c-08028de31d8d`

## When to use
- Trigger when the reply includes any binary artifact.
- Trigger when result blocks contain artifact refs (`path`, `url`, mime type).
- Trigger whenever user asks for image, file, video, audio, or music delivery.

## When not to use
- Do not emit media segments without concrete file/path/url evidence.
- Do not downgrade required media delivery to plain text links only.
- Do not mix unrelated heavy media payload with route-unsafe segments.
## Input mapping
- Artifact evidence source:
  - `<sentra-result>` or `<sentra-result-group>`
  - `<result_ref ... path="..." type="...">`
- Requested media intent source:
  - current message segment types
  - explicit user text ("send image", "upload file", "voice", "video")
- Segment mapping:
  - image -> `image`
  - generic document/archive -> `file`
  - mp4/webm/mov -> `video`
  - audio voice clip -> `record`
  - music card -> `music` (`data.type` + `data.id`)

## Output contract
- Deliver media through native media segments only.
- For media segments:
  - always provide `<data><file>...</file></data>`
  - file path or adapter-supported URL must be concrete and non-empty
- Sticker rule:
  - local stickers must use `image` with concrete `data.file`.
  - do not use non-protocol custom segment types (for example `face`).
- If mixed with text:
  - text should describe what is being sent
  - media segment should follow descriptive text unless platform needs reverse order
- Composition rule for transport:
  - segment-first by default; keep model segment order and avoid broad local merging.
  - if `reply` is present, pair it with a `text` or `image` anchor in the same delivery unit.
  - `file/video/record/music` should be sent as standalone delivery actions (no mixed bundle with quote/mention/image flow).
- Do not claim delivery with plain markdown text.
- Do not fake resource links when no artifact evidence exists.

## Examples
Image delivery from result:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>The image is ready and I am sending it now.</text>
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

File delivery:
<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>The report has been exported. Sending the document.</text>
      </data>
    </segment>
    <segment index="2">
      <type>file</type>
      <data>
        <file>E:/sentra-agent/artifacts/weekly_report.pdf</file>
      </data>
    </segment>
  </message>
</sentra-message>

Invalid markdown-only media claim:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>Here is your image ![lolita](E:/sentra-agent/artifacts/draw.webp)</text>
      </data>
    </segment>
  </message>
</sentra-message>

## Failure policy
- If artifact path is missing, do not fabricate it; send a progress/clarification text.
- If artifact type is unknown, fallback to `file` segment.
- If path likely does not exist, avoid final-delivery wording and send a retry status message.
- If multiple artifacts are available, send in stable order with contiguous indexes.

References:
- `references/sentra_output_examples.md`
- `references/sentra_segment_schema.md`

