# Changelog

All notable changes to this tool will be documented in this file.

## [0.2.0] - 2026-04-15

Initial customer release.

### Scripts
- `create-orgs.ts` — bulk create (and optionally update via `--update`) WorkOS organizations from a CSV or JSONL file.
- `verify-orgs.ts` — read-only check that live WorkOS state matches an input file. Exits non-zero on any drift.
- `delete-orgs.ts` — delete organizations listed in a results CSV. Dry-run by default; requires `--yes` to actually delete.
- `scripts/generate-fixture.ts` — deterministic synthetic CSV/JSONL generator for load testing.

### Input features
- CSV or JSONL, auto-detected from extension (or override with `--format`).
- Optional `metadata` column / key (JSON object).
- Optional `domains` column supporting `acme.com|acme.io`, per-domain state with `acme.com:verified|acme.io:pending`, or JSONL object form `[{"domain":"acme.com","state":"verified"}]`.
- UTF-8 BOM (from Excel CSV exports) handled transparently.

### Operator features
- `--dry-run` that parses, diffs, and writes a dry-run results CSV without hitting the API.
- `--limit` / `--filter` for trial runs on a slice of the input.
- `--rps`, `--concurrency`, `--max-attempts` for throughput control.
- Token-bucket rate limiter honoring WorkOS limits.
- Automatic retries on 429 / 5xx with `Retry-After` support.
- Resumable runs: re-running appends to the same results CSV and skips any `external_id` with a terminal (non-`failed`) status.
- Errors-only output CSV written alongside the main results.

### Tests
- 46 unit tests covering CSV parsing (including BOM, quoted fields, CRLF), metadata coercion, per-domain state parsing, update diff, rate limiter throughput, and retry behavior.
