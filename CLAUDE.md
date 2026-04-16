# CLAUDE.md

Agent instructions for workos-bulk-org-create.

## What this is

CLI tool to bulk-create, update, verify, delete WorkOS organizations and bulk-send user invitations from CSV or JSONL files. Rate limits, retries, and resumability are built in.

## Commands

All commands are run via `npm run <script> -- <flags>`. Pass `--help` to any script for the full flag reference.

| Command | What it does |
|---------|-------------|
| `npm run create -- --input <file>` | Create (and optionally `--update`) orgs |
| `npm run verify -- --input <file>` | Read-only diff of input vs. live WorkOS state |
| `npm run delete -- --input <results.csv>` | Delete orgs from a results CSV (dry-run default; `--yes` to delete) |
| `npm run invite -- --input <file>` | Send user invitations |
| `npm run generate-fixture -- --count N --output <file>` | Generate synthetic test data |

Do **not** use `npm start` (the interactive wizard) — it requires a TTY and blocks on readline prompts. Always use the direct CLI scripts above.

## Workflow

The standard sequence for an agent:

```
1. Dry-run first       npm run create -- --input orgs.csv --dry-run
2. Real create         npm run create -- --input orgs.csv
3. Verify              npm run verify -- --input orgs.csv
4. (If needed) Delete  npm run delete -- --input results.csv --yes
```

Always dry-run before a real create or invite. Dry-run requires no API key and catches input errors.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success (or `--help`) |
| `1` | Fatal error (bad args, missing API key, unrecoverable failure) |
| `2` | verify-orgs only: at least one row has drift, is missing, or errored |

Exit code 2 from verify means the input doesn't match live state — read the `verdict` column in the verify report CSV for details.

## Rate limits — do not override defaults

Every script ships with safe defaults tuned to WorkOS's rate-limit buckets. **Do not raise `--rps` or `--concurrency`** unless the customer's WorkOS account has elevated limits. If you exceed the bucket, the script warns on startup and retries 429s automatically — but the run will be slower than leaving defaults alone.

| Script | Default rps | Default concurrency | Why |
|--------|------------|--------------------|----|
| create / verify | 50 | 10 | General bucket: 6,000/60s per IP |
| delete | 0.75 | 1 | Delete bucket: 50/60s per API key |
| invite | 40 | 10 | User-management writes: 500/10s per env |

## Resumability

All scripts append to their output CSV. On re-run, rows with a terminal status (created, updated, skipped_existing, invited, deleted, dry_run) are skipped. Only `failed` rows are retried.

To force a completely fresh run, delete the output CSV first.

## Input format

- CSV or JSONL, auto-detected from file extension (override with `--format`)
- See `examples/` for sample files
- Org input requires `name`; `external_id` is optional (used for idempotency and lookup when present)
- Invite input requires `email` and one of `organization_id` or `external_id`
- UTF-8 BOM from Excel is handled transparently

## Environment

Only one env var is needed:

```
WORKOS_API_KEY=sk_test_...
```

Set it in `.env` (loaded via dotenv) or export it. Not needed for `--dry-run`.

## Testing changes

```
npm test          # unit tests (Node test runner)
npm run typecheck # tsc --noEmit
```

Run both before committing.

## Common mistakes to avoid

- **Don't use the wizard** (`npm start`) — use the direct CLI scripts
- **Don't raise rps/concurrency** — the defaults are already at the safe ceiling
- **Don't skip dry-run** — it catches malformed input for free
- **Don't delete the output CSV mid-run** — it's the resume state
- **Don't pass `--yes` to delete without reading the dry-run output first**
