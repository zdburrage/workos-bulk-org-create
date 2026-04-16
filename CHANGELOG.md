# Changelog

All notable changes to this tool will be documented in this file.

## [Unreleased]

### Added
- `wizard.ts` — zero-dependency interactive wizard (`npm start`) that walks through create / verify / delete / invite / generate-fixture flows, runs a dry-run first for destructive actions, and prints the equivalent CLI command at every step so you can script it later. No logic duplication — each flow spawns the existing script as a subprocess.
- `invite-users.ts` — bulk-send WorkOS user-management invitations from a CSV or JSONL file. Accepts `organization_id` or `external_id` (with one-lookup-per-unique-external-id resolution and caching), optional per-row `role_slug` / `expires_in_days` / `inviter_user_id`, and matching global-default flags. Resumable via `(email, org)` key; duplicate-invite errors mapped to `skipped_existing` for clean re-runs. Safe rate-limit defaults (40 rps, concurrency 10) under the user-management writes bucket (500 req / 10s).

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
