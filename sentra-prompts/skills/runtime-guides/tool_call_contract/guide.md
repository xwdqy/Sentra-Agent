# Tool Call Contract
Skill ID: `tool_call_contract`
UUID: `42d9bd90-0564-4cef-bec8-48ad61f44387`

## When to use
- Trigger only when output gate selects tool mode.
- Trigger in `tools_only`, `router`, and `full` modes when no result tags exist and tools are necessary.
- Trigger before any `<invoke>` block is emitted.

## When not to use
- Do not output <sentra-tools> in response-only rounds.
- Do not invent tool names outside the provided catalog.
- Do not omit required parameters or rewrite parameter names.
## Input mapping
- Tool capability boundary: `<sentra-mcp-tools>`.
- Task intent source: `<sentra-input>/<current_messages>/<sentra-message>`.
- Parameter evidence source:
  - current turn payload
  - read-only context blocks
  - dependency outputs from prior tool results
- Key semantics in `<sentra-tools>`:
  - `<invoke name="...">`: `name` is the exact MCP tool id (`aiName`) to execute.
  - `<parameter name="...">`: `name` is the exact schema field name for that tool.
  - typed value node inside parameter:
    - `<string>`: free text, path, id, url, query, prompt.
    - `<number>`: numeric value only (int/float).
    - `<boolean>`: `true` or `false`.
    - `<null>`: explicit null value.
    - `<array>`: ordered list of typed nodes.
    - `<object>`: nested key-value map using child `<parameter name="...">`.

## Output contract
- Output root must be `<sentra-tools>`.
- `sentra-tools` structure:
  - one or more `<invoke name="tool_name">`
  - each invoke has zero or more `<parameter name="...">`
  - each parameter contains exactly one typed node
- Supported typed nodes:
  - `<string>`
  - `<number>`
  - `<boolean>`
  - `<null>`
  - `<array>`
  - `<object>`
- Array encoding:
  - children are typed nodes only
- Object encoding:
  - children are `<parameter name="...">` wrappers with typed-node values
- Constraints:
  - no user-facing prose in `<sentra-tools>`
  - do not include `<sentra-message>` in same output
  - do not invent tool names or undocumented parameters
- Value discipline:
  - one `<parameter>` must contain exactly one typed root node
  - do not place raw JSON strings as a substitute for typed nodes
  - keep keys stable: never rename schema keys

## Examples
Single-tool query:
<sentra-tools>
  <invoke name="local__search">
    <parameter name="query">
      <string>napcat at segment field mapping</string>
    </parameter>
  </invoke>
</sentra-tools>

Typed object and array:
<sentra-tools>
  <invoke name="local__batch_query">
    <parameter name="queries">
      <array>
        <string>sentra message segment contract</string>
        <string>napcat image segment send</string>
      </array>
    </parameter>
    <parameter name="options">
      <object>
        <parameter name="limit">
          <number>5</number>
        </parameter>
        <parameter name="strict">
          <boolean>true</boolean>
        </parameter>
      </object>
    </parameter>
  </invoke>
</sentra-tools>

Multiple invokes in one round:
<sentra-tools>
  <invoke name="local__read_file">
    <parameter name="path">
      <string>E:/sentra-agent/components/MessagePipeline.ts</string>
    </parameter>
  </invoke>
  <invoke name="local__read_file">
    <parameter name="path">
      <string>E:/sentra-agent/utils/protocolUtils.ts</string>
    </parameter>
  </invoke>
</sentra-tools>

## Failure policy
- If tool name is not in catalog, do not emit that invoke.
- If required parameter is unknown, emit a minimal valid call only when safe; otherwise switch to clarification message next round.
- If parameter typing is uncertain, prefer string over malformed object/array.
- If any invoke is invalid, remove invalid invoke and keep valid invokes.

References:
- `references/sentra_output_examples.md`
- `references/sentra_key_dictionary.md`

