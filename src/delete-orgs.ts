/**
 * Delete WorkOS organizations listed in a results CSV produced by create-orgs.ts.
 *
 * SAFETY: dry-run is the default. You must pass --yes to actually delete. The
 * script writes a delete-results CSV so the operation is auditable and resumable.
 *
 * Run with `--help` for full flag reference.
 */

import { WorkOS } from "@workos-inc/node";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";

import { arg, flag, runPool } from "./lib/cli.js";
import { LIMITS, warnIfOverLimit } from "./lib/limits.js";
import { csvEscape } from "./lib/parse.js";
import { RateLimiter } from "./lib/rate-limit.js";
import { loadProcessedOrgIds, readSuccessfulResults } from "./lib/results.js";
import { statusOf, withRetries } from "./lib/retry.js";

const HELP = `
Usage: tsx src/delete-orgs.ts --input <results.csv> [options]

Deletes WorkOS organizations listed in a results CSV (from create-orgs.ts).
Only rows with status=created or status=updated and a non-empty org_id are considered.

DANGER: This permanently deletes organizations. Dry-run is the default.

WorkOS rate-limits the delete-organization endpoint to 50 requests per 60
seconds per API key (~0.83 rps). The defaults below stay under that bucket —
you should not need to tune --rps or --concurrency. Deleting N orgs will take
roughly N * 1.35 seconds.

Required:
  --input <path>           Path to a results CSV from create-orgs.ts

Options:
  --output <path>          Delete-results CSV. Default: delete-results.csv
  --rps <n>                Requests per second. Default: 0.75 (safe under 50/60s limit)
  --concurrency <n>        Max in-flight requests. Default: 1 (safe under 50/60s limit)
  --max-attempts <n>       Max retry attempts on 429/5xx. Default: 6
  --filter <regex>         Only delete rows whose external_id matches this regex.
  --limit <n>              Delete at most N rows (after --filter).
  --yes                    Actually delete. Without this, the script runs in dry-run mode.
  --help, -h               Show this help text.

Environment:
  WORKOS_API_KEY           Required unless running without --yes (dry-run).

Examples:
  tsx src/delete-orgs.ts --input results.csv                        # dry-run preview
  tsx src/delete-orgs.ts --input results.csv --filter '^ext_test_'  # dry-run, filtered
  tsx src/delete-orgs.ts --input results.csv --yes                  # actually delete
`;

const argv = process.argv.slice(2);

if (flag(argv, "help") || flag(argv, "h")) {
  console.log(HELP.trim());
  process.exit(0);
}

const INPUT = arg(argv, "input");
const OUTPUT = arg(argv, "output", "delete-results.csv")!;
const RPS = Number(arg(argv, "rps", "0.75"));
const CONCURRENCY = Number(arg(argv, "concurrency", "1"));
const MAX_ATTEMPTS = Number(arg(argv, "max-attempts", "6"));
const FILTER = arg(argv, "filter");
const LIMIT = arg(argv, "limit") ? Number(arg(argv, "limit")) : undefined;
const CONFIRMED = flag(argv, "yes");

if (!INPUT) {
  console.error("Missing --input <path-to-results.csv>. Use --help for details.");
  process.exit(1);
}
if (!process.env.WORKOS_API_KEY && CONFIRMED) {
  console.error("Missing WORKOS_API_KEY env var. Required for actual deletion.");
  process.exit(1);
}

let filterRe: RegExp | undefined;
if (FILTER) {
  try {
    filterRe = new RegExp(FILTER);
  } catch (e: any) {
    console.error(`--filter is not a valid regex: ${e.message}`);
    process.exit(1);
  }
}

const workos = CONFIRMED ? new WorkOS(process.env.WORKOS_API_KEY!) : null;

const DELETE_HEADER = "external_id,name,org_id,status,error\n";

type DeleteStatus = "deleted" | "dry_run" | "failed" | "skipped_already_processed";

function ensureHeader(path: string, header: string) {
  if (!existsSync(path)) writeFileSync(path, header);
}

function appendRow(row: {
  external_id: string;
  name: string;
  org_id: string;
  status: DeleteStatus;
  error: string;
}) {
  const line =
    [row.external_id, row.name, row.org_id, row.status, row.error].map(csvEscape).join(",") + "\n";
  appendFileSync(OUTPUT, line);
}

async function deleteOrg(orgId: string): Promise<void> {
  if (!workos) return;
  await workos.organizations.deleteOrganization(orgId);
}

async function main() {
  const rows = readSuccessfulResults(INPUT!);
  let targets = rows;
  if (filterRe) targets = targets.filter(r => filterRe!.test(r.external_id));
  if (LIMIT !== undefined) targets = targets.slice(0, LIMIT);

  const totalNote =
    filterRe || LIMIT !== undefined ? ` (filtered ${targets.length}/${rows.length})` : "";
  console.log(
    `${CONFIRMED ? "DELETE" : "DRY-RUN"} — ${targets.length} organization(s) from ${INPUT}${totalNote}`
  );

  if (!CONFIRMED) {
    console.log("Pass --yes to actually delete. Preview only:\n");
    for (const r of targets.slice(0, 20)) {
      console.log(`  would delete ${r.org_id}  ${r.external_id}  ${r.name}`);
    }
    if (targets.length > 20) console.log(`  ... and ${targets.length - 20} more`);
    return;
  }

  if (targets.length === 0) {
    console.log("No targets to delete.");
    return;
  }

  ensureHeader(OUTPUT, DELETE_HEADER);

  // Resume: skip org_ids that already appear in OUTPUT with a terminal status.
  const alreadyDone = loadProcessedOrgIds(OUTPUT);
  if (alreadyDone.size) {
    console.log(`Resuming — skipping ${alreadyDone.size} org(s) already processed in ${OUTPUT}`);
  }

  warnIfOverLimit("delete-orgs", LIMITS.organizationsDelete, RPS, CONCURRENCY);
  const limiter = new RateLimiter(RPS, RPS);
  const counters = { deleted: 0, failed: 0, skipped: 0 };
  const started = Date.now();
  const total = targets.length;
  let completed = 0;
  const logProgress = () => {
    completed++;
    if (completed % 500 === 0 || completed === total) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = completed / Math.max(0.001, elapsed);
      console.log(
        `progress ${completed}/${total} — deleted=${counters.deleted} skipped=${counters.skipped} failed=${counters.failed} (${elapsed.toFixed(1)}s, ${rate.toFixed(0)}/s)`
      );
    }
  };

  await runPool(targets, CONCURRENCY, async (target, _idx) => {
    if (alreadyDone.has(target.org_id)) {
      counters.skipped++;
      appendRow({
        external_id: target.external_id,
        name: target.name,
        org_id: target.org_id,
        status: "skipped_already_processed",
        error: "",
      });
      logProgress();
      return;
    }
    try {
      await limiter.acquire();
      await withRetries(
        () => deleteOrg(target.org_id),
        `delete ${target.org_id}`,
        MAX_ATTEMPTS
      );
      counters.deleted++;
      appendRow({
        external_id: target.external_id,
        name: target.name,
        org_id: target.org_id,
        status: "deleted",
        error: "",
      });
    } catch (err: any) {
      const status = statusOf(err);
      // 404 = already gone. Treat as success for idempotency.
      if (status === 404) {
        counters.deleted++;
        appendRow({
          external_id: target.external_id,
          name: target.name,
          org_id: target.org_id,
          status: "deleted",
          error: "already-absent",
        });
        return;
      }
      counters.failed++;
      appendRow({
        external_id: target.external_id,
        name: target.name,
        org_id: target.org_id,
        status: "failed",
        error: err?.message ?? String(err),
      });
      console.error(`[fail] ${target.org_id}: ${err?.message ?? err}`);
    } finally {
      logProgress();
    }
  });

  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `\nDone in ${elapsed.toFixed(1)}s — deleted=${counters.deleted} skipped=${counters.skipped} failed=${counters.failed}`
  );
  console.log(`Results: ${resolve(OUTPUT)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
