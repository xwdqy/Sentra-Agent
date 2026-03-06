# system_info

## Capability

- Collect local runtime/system information by requested categories.

## Real-world impact

- Reads local machine/system data.
- May read/write local cache depending on config.

## Failure modes

- `ERR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and `result.data` as a non-empty object.
- `result.data` must include at least one concrete category payload (e.g. `os`, `cpu`, `memory`, `gpu`, `disk`, `network`, `process`).
- Category payload must be object/array shaped data, not only empty placeholders.
- If cache metadata exists (`cached`, `source`), it must be consistent with returned data.
- Empty data object must not pass.
