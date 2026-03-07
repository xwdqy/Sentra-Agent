# weather

## Capability

- Query weather data by city/cities with optional query type.

## Failure modes

- `INVALID`
- `NO_API_KEY`
- `WEATHER_API_FAILED`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and non-empty `data.results`.
- `data.queryType` must be present.
- At least one `data.results[*]` item must have `success === true` and include non-empty `city`, non-empty `formatted`, and `timestamp`.
- If `data.mode === "batch"`, `data.results` must include per-city success/failure evidence.
- If no city item succeeded, this step must not pass.
