# Sentra Prompt Skills

This directory stores prompt capabilities as composable skill units.
Single source of truth is now `runtime-guides/*` (directory-per-skill).

## Registry
- Each skill lives in one folder under `runtime-guides/<skill_id>/`.
- Required files:
  - `skill.json` (manifest)
  - `guide.md` (full prompt skill content)
- `skill.json` defines:
  - `id`
  - `uuid`
  - `title`
  - `summary`
  - `selection` (`manual` or `auto`)
  - `when`
  - `priority`
  - `deps`
  - `tags`
  - `guideFile`
  - `triggers.keywords` / `triggers.regex`

## Composition Rules
1. Select by tag set.
2. Filter by runtime mode (`full`, `response_only`, `tools_only`, `router`).
3. Resolve dependencies (`deps`).
4. Order by `priority` ascending.
5. For runtime auto-selection rounds, ties are resolved by `score` then `confidence`.
6. Render with metadata headers (`RULE-ID` == `uuid`, `skill_id`, `uuid`).

## Skill Template (Mandatory)
Each skill markdown should keep this exact section order:
1. `When to trigger`
2. `Input mapping`
3. `Output contract`
4. `Examples`
5. `Failure policy`

Optional:
- `References` section linking files under `references/`.

## Modes
- `full`: normal runtime composition.
- `response_only`: force `<sentra-message>`.
- `tools_only`: force `<sentra-tools>`.
- `router`: auto route with explicit gate.

## Extension Workflow
1. Create `runtime-guides/<new_skill_id>/`.
2. Add `skill.json` with full metadata (`tags`, `deps`, `when`, `priority`, triggers).
3. Add `guide.md` with full skill body.
4. If needed, reference new tags from `SECTION_SKILL_TAGS` in `functions/platform.js`.

## References
- Keep heavy content in `references/` (schema tables, long examples, fallback playbooks).
- Keep main skill file compact and execution-focused.
