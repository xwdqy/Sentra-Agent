# github_repo_info

## Capability

- Query GitHub repository information through GitHub REST API.
- Support both single repository query and batch repository query.
- Support optional enrichments (languages/topics/releases/tags/readme/community/stats).

## Real-world Impact

- Makes outbound network requests to GitHub API.
- May hit GitHub rate limit when unauthenticated.

## When to use

- You need repository inspection data (metadata, commits, contributors, open issues/PRs, branches).
- You can provide either `repoUrl` (single) or `repoUrls` (batch).
- You need read-only analysis, not mutation operations.

## When not to use

- Neither `repoUrl` nor `repoUrls` is available.
- Task requires writing/modifying/deleting resources.

## Success Criteria

- Single-repo success requires `result.success === true`, `result.code === "OK"`, and `result.data` as a non-empty object.
- Single-repo evidence must include repository basics block, summary block, quick links block, and metadata block.
- Quick links block should include link fields such as `Issues`, `PullRequests`, `Actions`, `Releases`, `Contributors`.
- Metadata block should include `rate_limit`; `partial_errors` may be empty or non-empty depending on optional endpoints.
- Batch success requires `result.success === true`, `result.code === "OK"`, `result.data.mode === "batch"`, non-empty `result.data.results`, and at least one item with `success === true`.
- Retry guidance: timeout/rate-limit can retry once with backoff; repo spec/schema errors should `retry_regen`; 404/permission failures should `replan`.

## Inputs

- One of:
  - `repoUrl` (string): `owner/repo` or full GitHub repo URL.
  - `repoUrls` (string[]): batch input.
- Optional limits:
  - `max_commits` (1-50)
  - `max_contributors` (1-50)
  - `max_tags` (1-50)
  - `readme_preview_chars` (50-5000)
- Optional include flags:
  - `include_languages`
  - `include_topics`
  - `include_releases`
  - `include_tags`
  - `include_readme_preview`
  - `include_community_profile`
  - `include_stats.commit_activity`

## Outputs

- Single repo: structured repository object (contains basics, summary, commits, contributors, links, and metadata).
- Batch: `{ mode: "batch", results: [{ input, success, code, data, error, hint, advice }] }`.

## Failure Modes

- `INVALID`: missing or invalid repo identifier.
- `NOT_FOUND`: repository not found or inaccessible.
- `UNAUTHORIZED`: token invalid or missing permission for private repo.
- `FORBIDDEN`: access denied.
- `RATE_LIMIT`: GitHub API rate limit reached.
- `BATCH_FAILED`: all batch items failed.
- `ERR`: other upstream/network/parsing errors.
