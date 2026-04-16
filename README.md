# workos-bulk-org-create

Bulk-create, update, verify, and delete WorkOS organizations from a CSV or JSONL file, plus bulk-send user invitations. Handles large batches with rate limiting, bounded concurrency, automatic retries on 429/5xx, and resumable result files.

## Quick start — interactive wizard

If you'd rather not memorize flags, run:

```sh
npm start
```

The wizard walks you through each flow (create, verify, delete, invite, generate fixture), always runs dry-run first for destructive actions, and prints the equivalent CLI command at every step so you can copy-paste it into scripts later.

## Scripts (direct CLI)

| Script | Purpose |
| --- | --- |
| `npm start` / `npm run wizard` | Interactive wizard that drives everything below |
| `npm run create` | Create organizations (and optionally update existing ones) |
| `npm run verify` | Read-only check that WorkOS state matches the input file |
| `npm run delete` | Delete organizations listed in a results CSV (dry-run by default) |
| `npm run invite` | Bulk-send user-management invitations from a CSV or JSONL file |
| `npm run generate-fixture` | Generate a large synthetic CSV/JSONL for load testing |

Pass `--help` to any script for its full flag reference.

## Requirements

- Node.js 20+ (see `.nvmrc`)
- A `WORKOS_API_KEY` with permission to create/update/delete organizations (not required for `--dry-run`)

## Install

```sh
npm install
cp .env.example .env   # set WORKOS_API_KEY
```

## Input formats

### CSV

Header required. Recognized columns:

| Column | Required | Description |
| --- | --- | --- |
| `name` | yes | Organization display name |
| `external_id` | yes | Your stable identifier; used for idempotency and lookup |
| `domains` | no | Pipe- or semicolon-separated domains, e.g. `acme.com\|acme.io`. Append `:verified` or `:pending` to set state per domain, e.g. `acme.com:verified\|acme.io:pending`. Unsuffixed domains use the global `--domain-state`. |
| `metadata` | no | JSON object string, e.g. `{"tier":"enterprise"}` (embed quotes per CSV rules) |

See `examples/orgs.csv` and `examples/orgs-with-metadata.csv`.

### JSONL

One JSON object per line. Keys:
- `name`
- `external_id` (or `externalId`)
- `domains` — either a delimited string (`"acme.com:verified|acme.io"`), an array of strings (`["acme.com:verified","acme.io"]`), or an array of objects (`[{"domain":"acme.com","state":"verified"},{"domain":"acme.io"}]`)
- `metadata` — JSON object

See `examples/orgs.jsonl`.

Excel-style CSVs with a UTF-8 BOM are handled automatically.

## Create

```sh
npm run create -- --input examples/orgs.csv --output results.csv
```

Common flags:

| Flag | Default | Description |
| --- | --- | --- |
| `--input` | (required) | Path to CSV or JSONL |
| `--output` | `results.csv` | Where results are appended |
| `--errors-output` | `<output>.errors.csv` | Errors-only CSV (same row shape) |
| `--format` | `auto` | `auto`, `csv`, or `jsonl` |
| `--rps` | `50` | Requests per second budget |
| `--concurrency` | `10` | Max in-flight requests |
| `--domain-state` | `pending` | Default state applied to domains that don't specify one inline (`pending` or `verified`) |
| `--max-attempts` | `6` | Retry attempts on 429/5xx |
| `--limit` | — | Process at most N rows (after `--filter`) |
| `--filter` | — | Regex that must match `external_id` |
| `--update` | off | Also update existing orgs whose fields differ |
| `--dry-run` | off | Parse and diff without hitting the API |

### Create vs. update

By default, rows whose `external_id` already exists in WorkOS are recorded as `skipped_existing` and left untouched.

With `--update`, the script additionally:

1. Fetches the existing org by `external_id`.
2. Diffs `name`, `domains`, and `metadata` against the input.
3. Sends an `updateOrganization` call only if something changed (otherwise records `skipped_unchanged`).

Domains are replaced wholesale when `--update` is used and the input provides a `domains` column; leave the column blank to leave existing domains untouched.

### Resumability

Each run appends to the output CSV. On re-run, any `external_id` already recorded with a terminal status (`created`, `updated`, `skipped_existing`, `skipped_unchanged`, `dry_run`) is skipped. `failed` rows are retried. To force a fresh run, delete the output CSV.

### Output

`results.csv` columns: `external_id,name,org_id,status,error`.

`status` ∈ `created | updated | skipped_existing | skipped_unchanged | failed | dry_run`.

## Verify

Read-only diff between the input file and live WorkOS data. Useful after a partial failure to see which orgs drifted.

```sh
npm run verify -- --input examples/orgs.csv
```

Produces `verify-report.csv` with columns `external_id,org_id,verdict,diff` where `verdict ∈ match | drift | missing | error`. The process exits non-zero if any row is not `match`, so it's safe to use in CI.

## Delete

Deletes orgs listed in a results CSV. **Dry-run is the default** — you must pass `--yes` to actually delete.

```sh
npm run delete -- --input results.csv                        # preview only
npm run delete -- --input results.csv --filter '^ext_test_'  # filtered preview
npm run delete -- --input results.csv --yes                  # actually delete
```

Only rows with `status=created` or `status=updated` and a non-empty `org_id` are considered — the script never deletes anything that wasn't created by this tool. Writes to `delete-results.csv` (resumable).

## Invite users

Bulk-send WorkOS user-management invitations from a CSV or JSONL file.

```sh
npm run invite -- --input examples/invites.csv --dry-run
npm run invite -- --input invites.csv --role-slug member
```

**Input columns** (CSV) / keys (JSONL):

| Column | Required | Description |
| --- | --- | --- |
| `email` | yes | Recipient email |
| `organization_id` | one of | Target org by WorkOS id |
| `external_id` | one of | Target org by external id (resolved via WorkOS lookup and cached) |
| `role_slug` | no | Role assigned when the recipient accepts |
| `expires_in_days` | no | 1-30 (defaults to WorkOS's default of 7) |
| `inviter_user_id` | no | Personalizes the invitation email |

If `organization_id` is empty and `external_id` is provided, the script calls `getOrganizationByExternalId` once per unique `external_id` and caches the result.

**Row-level vs. global defaults**: `--role-slug`, `--expires-in-days`, and `--inviter-user-id` apply when the row doesn't set them. Row values always win.

**Idempotency**: the script records every attempt to `invite-results.csv` keyed on `email|organization_id`. Re-running appends and skips any `(email, org)` pair already recorded with a terminal non-`failed` status. Duplicate-invite errors from WorkOS are also mapped to `skipped_existing` so re-runs don't noisy-fail.

`status` ∈ `invited | skipped_existing | dry_run | failed`.

## Rate limits

You should not need to tune rate-limit flags — the defaults are safe for every script.

| Script | Default rps | Default concurrency | Underlying WorkOS limit |
| --- | --- | --- | --- |
| `create` / `verify` | 50 | 10 | 6,000 req / 60s per IP (~100 rps) |
| `delete` | 0.75 | 1 | **50 req / 60s per API key** (~0.83 rps) |
| `invite` | 40 | 10 | 500 req / 10s per environment (~50 rps) for `/user_management` writes |

The delete endpoint is far more restrictive than the general IP bucket, so deletes take roughly `N * 1.35s` for `N` orgs. If you raise `--rps` or `--concurrency` above these defaults, the script prints a warning and you should expect 429s — retries with `Retry-After` will still eventually succeed, but the run will be slower than leaving the defaults alone. Only raise them if WorkOS support has raised your API key's limit.

## Testing this tool before running against production

1. **Generate a synthetic fixture** and run end-to-end in `--dry-run`:

    ```sh
    npm run generate-fixture -- --count 20000 --output fixtures/bulk-20k.csv
    npm run create -- --input fixtures/bulk-20k.csv --output fixtures/dry.csv --dry-run --rps 500 --concurrency 50
    ```

2. **Trial run against a small slice** of real data:

    ```sh
    npm run create -- --input orgs.csv --limit 5 --dry-run
    npm run create -- --input orgs.csv --limit 5           # real, 5 rows only
    npm run verify -- --input orgs.csv --limit 5
    ```

3. **Full run** with a conservative rps:

    ```sh
    npm run create -- --input orgs.csv --rps 50 --concurrency 10
    ```

## Unit tests

```sh
npm test
```

Covers CSV parsing (including BOM and escaped quotes), metadata coercion, the update diff, the rate limiter, and retry logic.

## Type check

```sh
npm run typecheck
```

## Support

Questions, bugs, or requests: **zac.burrage@workos.com**. Please include the relevant command line and the first few lines of the errors CSV when reporting failures.

## License

[MIT](LICENSE).

