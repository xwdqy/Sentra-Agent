# html_to_app

## Capability

- Generate an Electron app project from description/html details.
- Can optionally run install/build/zip automation.

## Real-world impact

- Writes project files to local workspace.
- May install dependencies and run build commands.

## When to use

- User asks to generate a desktop app project.
- Required app description fields are available.

## When not to use

- Required fields are missing.
- Task is read-only.

## Input

- Required:
  - `description`
  - `app_name`
  - `details`
- Optional:
  - `html_content`
  - `framework`
  - automation flags

## Output

- Project generation result with file list and instructions.

## Failure modes

- `INVALID`
- `PROJECT_EXISTS`
- `INVALID_XML`
- `INVALID_PROJECT`
- `TIMEOUT`
- `GENERATION_ERROR`

## Success Criteria

- Success requires `result.success === true`, `result.code === "OK"`, and `data.action === "html_to_app"`.
- Required output evidence: non-empty `data.project_path`, non-empty `data.app_name`, numeric `data.files_count > 0`, and non-empty `data.files`.
- `data.generation_info` must exist.
- If `data.automation` exists, each present sub-block (`install`, `build`, `zip`) must be structurally valid.
- Missing project path or empty file list means failure.
