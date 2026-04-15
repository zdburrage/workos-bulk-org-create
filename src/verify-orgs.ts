/**
 * Verify that WorkOS organizations match an input file.
 *
 * For each input row, fetches the org by external_id and compares name,
 * domains, and metadata against what the input declares. Writes a verify
 * report CSV with one row per input org.
 *
 * Read-only — never modifies WorkOS data.
 *
 * Run with `--help` for full flag reference.
 */

import { WorkOS } from "@workos-inc/node";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";

import { arg, flag, runPool } from "./lib/cli.js";
import { computePatch } from "./lib/diff.js";
import { LIMITS, warnIfOverLimit } from "./lib/limits.js";
import { csvEscape, detectFormat, loadInput, normalizeMetadata } from "./lib/parse.js";
import { RateLimiter } from "./lib/rate-limit.js";
import { statusOf, withRetries } from "./lib/retry.js";
import type { DomainState, ExistingOrg } from "./lib/types.js";

const HELP = `
Usage: tsx src/verify-orgs.ts --input <path> [options]

Read-only check that WorkOS organizations match an input file.

Required:
  --input <path>           CSV or JSONL describing expected organizations

Options:
  --output <path>          Verify report CSV. Default: verify-report.csv
  --format auto|csv|jsonl  Input format. Default: auto (detected from extension)
  --rps <n>                Requests per second. Default: 50 (safe under WorkOS's ~100 rps general limit)
  --concurrency <n>        Max in-flight requests. Default: 10
  --domain-state <s>       Expected domain state for diffing. Default: pending
  --max-attempts <n>       Max retry attempts on 429/5xx. Default: 6
  --filter <regex>         Only verify rows whose external_id matches this regex.
  --limit <n>              Verify at most N rows (after --filter).
  --help, -h               Show this help text.

Environment:
  WORKOS_API_KEY           Required.

Output columns: external_id, org_id, verdict, diff
  verdict ∈ { match, drift, missing, error }
`;

const argv = process.argv.slice(2);

if (flag(argv, "help") || flag(argv, "h")) {
  console.log(HELP.trim());
  process.exit(0);
}

const INPUT = arg(argv, "input");
const OUTPUT = arg(argv, "output", "verify-report.csv")!;
const FORMAT = (arg(argv, "format", "auto") as "auto" | "csv" | "jsonl") ?? "auto";
const RPS = Number(arg(argv, "rps", "50"));
const CONCURRENCY = Number(arg(argv, "concurrency", "10"));
const DOMAIN_STATE = (arg(argv, "domain-state", "pending") as DomainState) || "pending";
const MAX_ATTEMPTS = Number(arg(argv, "max-attempts", "6"));
const FILTER = arg(argv, "filter");
const LIMIT = arg(argv, "limit") ? Number(arg(argv, "limit")) : undefined;

if (!INPUT) {
  console.error("Missing --input <path>. Use --help for details.");
  process.exit(1);
}
if (!process.env.WORKOS_API_KEY) {
  console.error("Missing WORKOS_API_KEY env var.");
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

const workos = new WorkOS(process.env.WORKOS_API_KEY!);

const HEADER = "external_id,org_id,verdict,diff\n";

function ensureHeader(path: string, header: string) {
  if (!existsSync(path)) writeFileSync(path, header);
}

function appendRow(row: { external_id: string; org_id: string; verdict: string; diff: string }) {
  const line =
    [row.external_id, row.org_id, row.verdict, row.diff].map(csvEscape).join(",") + "\n";
  appendFileSync(OUTPUT, line);
}

async function findByExternalId(externalId: string): Promise<ExistingOrg | null> {
  try {
    const org = await (workos.organizations as any).getOrganizationByExternalId(externalId);
    if (!org?.id) return null;
    return {
      id: org.id,
      name: org.name,
      externalId: org.externalId ?? org.external_id ?? null,
      metadata: normalizeMetadata(org.metadata),
      domains: Array.isArray(org.domains)
        ? org.domains.map((d: any) => ({ domain: d.domain, state: d.state }))
        : [],
    };
  } catch (err: any) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

async function main() {
  let inputs = loadInput(INPUT!, FORMAT);
  const totalBeforeFilter = inputs.length;
  if (filterRe) inputs = inputs.filter(i => filterRe!.test(i.externalId));
  if (LIMIT !== undefined) inputs = inputs.slice(0, LIMIT);

  const filterNote =
    filterRe || LIMIT !== undefined ? ` (filtered ${inputs.length}/${totalBeforeFilter})` : "";
  console.log(
    `Verifying ${inputs.length} organization(s) from ${INPUT} (format=${detectFormat(INPUT!, FORMAT)})${filterNote}`
  );
  if (inputs.length === 0) return;

  ensureHeader(OUTPUT, HEADER);

  warnIfOverLimit("verify-orgs", LIMITS.organizationsWrite, RPS, CONCURRENCY);
  const limiter = new RateLimiter(RPS, RPS);
  const counters = { match: 0, drift: 0, missing: 0, error: 0 };
  const started = Date.now();
  const total = inputs.length;
  let completed = 0;
  const logProgress = () => {
    completed++;
    if (completed % 500 === 0 || completed === total) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = completed / Math.max(0.001, elapsed);
      console.log(
        `progress ${completed}/${total} — match=${counters.match} drift=${counters.drift} missing=${counters.missing} error=${counters.error} (${elapsed.toFixed(1)}s, ${rate.toFixed(0)}/s)`
      );
    }
  };

  await runPool(inputs, CONCURRENCY, async (input, _idx) => {
    try {
      await limiter.acquire();
      const existing = await withRetries(
        () => findByExternalId(input.externalId),
        `lookup ${input.externalId}`,
        MAX_ATTEMPTS
      );
      if (!existing) {
        counters.missing++;
        appendRow({
          external_id: input.externalId,
          org_id: "",
          verdict: "missing",
          diff: "org not found in WorkOS",
        });
        return;
      }
      const patch = computePatch(input, existing, DOMAIN_STATE);
      if (!patch) {
        counters.match++;
        appendRow({
          external_id: input.externalId,
          org_id: existing.id,
          verdict: "match",
          diff: "",
        });
        return;
      }
      counters.drift++;
      appendRow({
        external_id: input.externalId,
        org_id: existing.id,
        verdict: "drift",
        diff: Object.keys(patch).join(","),
      });
    } catch (err: any) {
      counters.error++;
      appendRow({
        external_id: input.externalId,
        org_id: "",
        verdict: "error",
        diff: err?.message ?? String(err),
      });
    } finally {
      logProgress();
    }
  });

  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `\nDone in ${elapsed.toFixed(1)}s — match=${counters.match} drift=${counters.drift} missing=${counters.missing} error=${counters.error}`
  );
  console.log(`Report: ${resolve(OUTPUT)}`);
  // Non-zero exit if anything is out of spec so CI/scripts can react.
  if (counters.drift || counters.missing || counters.error) process.exit(2);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
