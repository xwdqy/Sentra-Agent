# Sentra Output Examples

Valid message output:

<sentra-message>
  <chat_type>group</chat_type>
  <group_id>11234552</group_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>Acknowledged.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Valid structured text split output:

<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>Got it. Here is the short conclusion first.</text>
      </data>
    </segment>
    <segment index="2">
      <type>text</type>
      <data>
        <text>Current merge and dedup can stay, but add a lightweight pre-filter to reduce cost.</text>
      </data>
    </segment>
    <segment index="3">
      <type>text</type>
      <data>
        <text>If you agree, I will provide runnable parameters and defaults next.</text>
      </data>
    </segment>
  </message>
</sentra-message>

Valid tools output:

<sentra-tools>
  <invoke name="local__search">
    <parameter name="query"><string>sentra xml contract</string></parameter>
  </invoke>
</sentra-tools>

Invalid dual output:

<sentra-message>...</sentra-message>
<sentra-tools>...</sentra-tools>

Invalid markdown media fake:

<sentra-message>
  <chat_type>private</chat_type>
  <user_id>2166683295</user_id>
  <message>
    <segment index="1">
      <type>text</type>
      <data>
        <text>done ![img](E:/a.webp)</text>
      </data>
    </segment>
  </message>
</sentra-message>

Read-only result group evidence:

<sentra-result-group step_group_id="0" group_size="1" order_step_ids="s_draw_lolita_girl_1" status="final">
  <sentra-result step_id="s_draw_lolita_girl_1" tool="local__image_draw" success="true" status="final">
    <reason>User requested a lolita-style portrait and the draw tool can produce a direct image artifact.</reason>
    <result_ref uuid="c2e32c5b-1e23-4f89-a4bf-a0c21834df5b" path="E:/sentra-agent/artifacts/draw_1771683582860_0.webp" type="image/webp" />
  </sentra-result>
</sentra-result-group>
