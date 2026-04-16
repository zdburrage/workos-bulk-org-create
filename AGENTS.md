# AGENTS.md

Instructions for AI coding agents operating this tool. Applies to Claude Code, Cursor, Copilot, Windsurf, Cline, Aider, and similar.

## What this tool does

Bulk-create, update, verify, and delete WorkOS organizations, plus bulk-send user invitations, from CSV or JSONL files. Rate limits, retries, and resumability are built in.

## Setup

```sh
npm install
export WORKOS_API_KEY=sk_test_...   # or add to .env
```

The only required env var is `WORKOS_API_KEY`. Not needed for `--dry-run`.

## Commands

Use the direct CLI scripts. **Do not use `npm start`** (the interactive wizard) — it requires a TTY and blocks on readline prompts.

| Command | What it does |
|---------|-------------|
| `npm run create -- --input <file>` | Create (and optionally `--update`) organizations |
| `npm run verify -- --input <file>` | Read-only diff of input vs. live WorkOS state |
| `npm run delete -- --input <results.csv>` | Delete orgs listed in a results CSV (dry-run by default; pass `--yes` to delete) |
| `npm run invite -- --input <file>` | Send user invitations |
| `npm run generate-fixture -- --count N --output <file>` | Generate synthetic test data |

Pass `--help` to any script for its complete flag reference.

## Recommended workflow

```
1. Parse + validate    npm run create -- --input orgs.csv --dry-run
2. Create for real     npm run create -- --input orgs.csv
3. Verify              npm run verify -- --input orgs.csv
4. (if needed) Delete  npm run delete -- --input results.csv --yes
```

Always run `--dry-run` before a real create or invite. It requires no API key and catches input errors early.

## Input format

- CSV or JSONL, auto-detected from file extension (override with `--format`)
- See `examples/` for sample input files
- Org input requires `name`; `external_id` is optional (enables idempotent lookups and resume-by-ID)
- Invite input requires `email` and one of `organization_id` or `external_id`
- UTF-8 BOM from Excel is handled transparently

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Fatal error (bad arguments, missing API key, unrecoverable failure) |
| `2` | `verify` only — at least one row has drift, is missing, or errored |

Check exit code 2 from verify to detect state drift programmatically.

## Rate limits — do not override

Every script ships with safe defaults tuned to WorkOS's rate-limit buckets. **Do not raise `--rps` or `--concurrency`** unless the account has elevated limits from WorkOS support. The scripts warn on startup if you exceed safe values and will still retry 429s automatically, but the run will be slower than using defaults.

| Script | Default rps | Default concurrency | Underlying limit |
|--------|------------|--------------------|----|
| create / verify | 50 | 10 | 6,000 req / 60s per IP |
| delete | 0.75 | 1 | 50 req / 60s per API key |
| invite | 40 | 10 | 500 req / 10s per environment |

## Resumability

All scripts append to their output CSV. On re-run, rows with a terminal status (`created`, `updated`, `skipped_existing`, `invited`, `deleted`, `dry_run`) are skipped automatically. Only `failed` rows are retried.

To start completely fresh, delete the output CSV before re-running.

## Common mistakes

- Do not use `npm start` — it's the interactive wizard, not scriptable
- Do not raise `--rps` or `--concurrency` above defaults
- Do not skip `--dry-run` — it's free validation
- Do not delete the output CSV during a run — it's the resume state
- Do not pass `--yes` to delete without reviewing the dry-run output first

## Testing changes to this tool

```sh
npm test          # 55 unit tests
npm run typecheck # TypeScript strict mode
```

Run both before committing any changes.
