# Music Segment Delivery
Skill ID: `music_segment_delivery`
UUID: `9c2dc8c5-6a10-486c-ad90-bf901d85f9fd`

## When to use
- Trigger when user asks for songs, music cards, track recommendation, or direct playable music.
- Trigger in normal reply rounds and result rounds when tool output already includes provider + song id.
- Trigger after route is resolved and output root is `<sentra-message>`.

## When not to use
- Do not emit music segment when song_id is missing or uncertain.
- Do not infer song_id from song_name/artist/memory.
- Do not send unsupported provider values.
## Input mapping
- Music evidence source:
  - user text intent (music/song keywords)
  - tool result payload containing provider and song id
- Accepted structured evidence example:
  - `<provider>163</provider>`
  - `<song_id>2069697333</song_id>`
  - `<song_name>梦里什么都没有</song_name>`
- Required mapping:
  - `provider` -> `<segment type="music"><data><type>...</type></data></segment>`
  - `song_id` -> `<segment type="music"><data><id>...</id></data></segment>`
- Supported providers:
  - `qq`
  - `163`
  - `kugou`
  - `migu`
  - `kuwo`

## Output contract
- Use native `music` segment only, do not replace with plain text links.
- `music` segment must include both:
  - `<data><type>provider</type></data>`
  - `<data><id>song_id</id></data>`
- Hard gate:
  - output `music` segment only when `song_id` is explicit in trusted input/tool result.
  - never infer/fabricate `song_id` from `song_name`, artist, keyword, or memory.
- If provider or song id is missing:
  - do not fabricate values
  - fallback to one concise text segment asking for confirmation, or call search tool first.

## Examples
Valid music card:
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>Here is one song card. Tap to play directly.</text>
      </data>
    </segment>
    <segment index="2">
      <type>music</type>
      <data>
        <type>163</type>
        <id>2058931087</id>
      </data>
    </segment>
  </message>
</sentra-message>

Invalid (missing id):
<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>music</type>
      <data>
        <type>163</type>
      </data>
    </segment>
  </message>
</sentra-message>

## Failure policy
- If tool only returns keyword candidates without a confirmed `song_id` for the chosen song, ask one concise follow-up or run search tool first.
- If provider is unsupported, reply with concise text and ask user to choose supported platforms.
- Never output placeholder/dummy/random ids.
