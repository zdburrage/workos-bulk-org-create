/**
 * Bulk-create (and optionally update) WorkOS organizations from CSV or JSONL input.
 *
 * CSV columns (header required): name, external_id (optional), domains, metadata
 *   - domains: pipe/semicolon separated, e.g. "acme.com|acme.io"
 *   - metadata: JSON object string, e.g. "{""tier"":""enterprise""}"
 *
 * JSONL: one JSON object per line. Keys:
 *   { "name": "...", "external_id": "...", "domains": ["..."] | "a|b", "metadata": { ... } }
 *   (externalId is also accepted)
 *
 * Run with `--help` for full flag reference.
 */

import { WorkOS } from "@workos-inc/node";
import { resolve } from "node:path";
import "dotenv/config";

import { arg, flag, runPool } from "./lib/cli.js";
import { computePatch, resolveDomainData, type OrgPatch } from "./lib/diff.js";
import { LIMITS, warnIfOverLimit } from "./lib/limits.js";
import { detectFormat, loadInput, normalizeMetadata } from "./lib/parse.js";
import { RateLimiter } from "./lib/rate-limit.js";
import {
  appendResult,
  deriveErrorsPath,
  ensureHeader,
  loadAlreadyProcessed,
  resumeKey,
  RESULT_HEADER,
} from "./lib/results.js";
import { statusOf, withRetries } from "./lib/retry.js";
import type {
  DomainDataInput,
  DomainState,
  ExistingOrg,
  OrgInput,
  ResultRow,
} from "./lib/types.js";

const HELP = `
Usage: tsx src/create-orgs.ts --input <path> [options]

Required:
  --input <path>           Path to CSV or JSONL input file

Options:
  --output <path>          Results CSV (appended to; resumable). Default: results.csv
  --errors-output <path>   Errors-only CSV. Default: <output>.errors.<ext>
  --format auto|csv|jsonl  Input format. Default: auto (detected from extension)
  --rps <n>                Requests per second budget. Default: 50 (WorkOS general limit is ~100)
  --concurrency <n>        Max in-flight requests. Default: 10
                           These defaults stay under WorkOS's 6,000/60s IP limit. You
                           usually don't need to change them.
  --domain-state <s>       Default state for domains that don't specify one inline
                           ("pending" or "verified"). Inline syntax: "acme.com:verified".
                           Default: pending
  --max-attempts <n>       Max retry attempts on 429/5xx. Default: 6
  --limit <n>              Process at most N input rows (after --filter). Useful for a trial run.
  --filter <regex>         Only process rows whose external_id or name matches this regex.
  --update                 Also update existing orgs where fields differ from the input.
  --dry-run                Parse and diff without calling the API. No WORKOS_API_KEY needed.
  --help, -h               Show this help text.

Environment:
  WORKOS_API_KEY           Required unless --dry-run.

Examples:
  tsx src/create-orgs.ts --input examples/orgs.csv
  tsx src/create-orgs.ts --input orgs.jsonl --update --rps 30
  tsx src/create-orgs.ts --input orgs.csv --limit 5 --dry-run
`;

// ---------- CLI ----------
const argv = process.argv.slice(2);

if (flag(argv, "help") || flag(argv, "h")) {
  console.log(HELP.trim());
  process.exit(0);
}

const INPUT = arg(argv, "input");
const OUTPUT = arg(argv, "output", "results.csv")!;
const ERRORS_OUTPUT = arg(argv, "errors-output") ?? deriveErrorsPath(OUTPUT);
const FORMAT = (arg(argv, "format", "auto") as "auto" | "csv" | "jsonl") ?? "auto";
const RPS = Number(arg(argv, "rps", "50"));
const CONCURRENCY = Number(arg(argv, "concurrency", "10"));
const DOMAIN_STATE = (arg(argv, "domain-state", "pending") as DomainState) || "pending";
const MAX_ATTEMPTS = Number(arg(argv, "max-attempts", "6"));
const LIMIT = arg(argv, "limit") ? Number(arg(argv, "limit")) : undefined;
const FILTER = arg(argv, "filter");
const UPDATE_MODE = flag(argv, "update");
const DRY_RUN = flag(argv, "dry-run");

if (!INPUT) {
  console.error("Missing --input <path-to-csv|jsonl>. Use --help for details.");
  process.exit(1);
}
if (!process.env.WORKOS_API_KEY && !DRY_RUN) {
  console.error("Missing WORKOS_API_KEY env var. Set it in .env or the shell, or pass --dry-run.");
  process.exit(1);
}
if (!["pending", "verified"].includes(DOMAIN_STATE)) {
  console.error("--domain-state must be 'pending' or 'verified'");
  process.exit(1);
}
if (!["auto", "csv", "jsonl"].includes(FORMAT)) {
  console.error("--format must be auto, csv, or jsonl");
  process.exit(1);
}
if (!Number.isFinite(RPS) || RPS <= 0) {
  console.error("--rps must be a positive number");
  process.exit(1);
}
if (!Number.isFinite(CONCURRENCY) || CONCURRENCY <= 0) {
  console.error("--concurrency must be a positive number");
  process.exit(1);
}
if (!Number.isFinite(MAX_ATTEMPTS) || MAX_ATTEMPTS < 1) {
  console.error("--max-attempts must be a positive integer");
  process.exit(1);
}
if (LIMIT !== undefined && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
  console.error("--limit must be a positive integer");
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

// ---------- WorkOS ops ----------
const workos = DRY_RUN ? null : new WorkOS(process.env.WORKOS_API_KEY!);

async function findByExternalId(externalId: string): Promise<ExistingOrg | null> {
  if (!workos) return null;
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

async function createOrg(input: OrgInput): Promise<string> {
  if (!workos) return `dry_${input.externalId ?? input.name}`;
  const resolved = resolveDomainData(input, DOMAIN_STATE);
  const domainData: DomainDataInput[] | undefined =
    resolved && resolved.length ? resolved : undefined;
  const org = await workos.organizations.createOrganization({
    name: input.name,
    ...(input.externalId ? { externalId: input.externalId } : {}),
    ...(domainData ? { domainData } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  } as any);
  return (org as any).id as string;
}

async function updateOrg(orgId: string, patch: OrgPatch): Promise<void> {
  if (!workos) return;
  await workos.organizations.updateOrganization({
    organization: orgId,
    ...(patch.name != null ? { name: patch.name } : {}),
    ...(patch.externalId != null ? { externalId: patch.externalId } : {}),
    ...(patch.domainData ? { domainData: patch.domainData } : {}),
    ...(patch.metadata ? { metadata: patch.metadata } : {}),
  } as any);
}

// ---------- Main ----------
async function main() {
  let inputs = loadInput(INPUT!, FORMAT);
  const totalBeforeFilter = inputs.length;

  if (filterRe) {
    inputs = inputs.filter(i => filterRe!.test(i.externalId ?? i.name));
  }
  if (LIMIT !== undefined) {
    inputs = inputs.slice(0, LIMIT);
  }

  const filterNote =
    filterRe || LIMIT !== undefined
      ? ` (filtered ${inputs.length}/${totalBeforeFilter})`
      : "";
  console.log(
    `Loaded ${inputs.length} organization(s) from ${INPUT} (format=${detectFormat(INPUT!, FORMAT)}, mode=${UPDATE_MODE ? "create+update" : "create-only"})${filterNote}`
  );
  if (inputs.length === 0) return;

  ensureHeader(OUTPUT, RESULT_HEADER);
  ensureHeader(ERRORS_OUTPUT, RESULT_HEADER);

  const processed = loadAlreadyProcessed(OUTPUT);
  if (processed.size) {
    console.log(`Resuming — skipping ${processed.size} already-processed row(s)`);
  }

  if (!DRY_RUN) warnIfOverLimit("create-orgs", LIMITS.organizationsWrite, RPS, CONCURRENCY);
  const limiter = new RateLimiter(RPS, RPS);
  const counters = {
    created: 0,
    updated: 0,
    skippedExisting: 0,
    skippedUnchanged: 0,
    failed: 0,
    dry: 0,
  };
  const started = Date.now();

  const writeRow = (row: ResultRow) => appendResult(OUTPUT, row, ERRORS_OUTPUT);

  let completed = 0;
  const total = inputs.length;
  const logProgress = () => {
    completed++;
    if (completed % 500 === 0 || completed === total) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = completed / Math.max(0.001, elapsed);
      console.log(
        `progress ${completed}/${total} — created=${counters.created} updated=${counters.updated} skipped_existing=${counters.skippedExisting} skipped_unchanged=${counters.skippedUnchanged} failed=${counters.failed}${DRY_RUN ? ` dry=${counters.dry}` : ""} (${elapsed.toFixed(1)}s, ${rate.toFixed(0)}/s)`
      );
    }
  };

  await runPool(inputs, CONCURRENCY, async (input, _idx) => {
    const key = resumeKey(input.externalId, input.name);
    const label = input.externalId ?? input.name;
    const extId = input.externalId ?? "";

    if (processed.has(key)) {
      logProgress();
      return;
    }

    try {
      // Only look up by external_id if one is provided.
      let existing: ExistingOrg | null = null;
      if (input.externalId) {
        await limiter.acquire();
        existing = await withRetries(
          () => findByExternalId(input.externalId!),
          `lookup ${label}`,
          MAX_ATTEMPTS
        );
      }

      if (existing) {
        if (!UPDATE_MODE) {
          counters.skippedExisting++;
          writeRow({
            external_id: extId,
            name: input.name,
            org_id: existing.id,
            status: "skipped_existing",
            error: "",
          });
          return;
        }
        const patch = computePatch(input, existing, DOMAIN_STATE);
        if (!patch) {
          counters.skippedUnchanged++;
          writeRow({
            external_id: extId,
            name: input.name,
            org_id: existing.id,
            status: "skipped_unchanged",
            error: "",
          });
          return;
        }
        if (DRY_RUN) {
          counters.dry++;
          writeRow({
            external_id: extId,
            name: input.name,
            org_id: existing.id,
            status: "dry_run",
            error: `would update: ${Object.keys(patch).join(",")}`,
          });
          return;
        }
        await limiter.acquire();
        await withRetries(
          () => updateOrg(existing!.id, patch),
          `update ${label}`,
          MAX_ATTEMPTS
        );
        counters.updated++;
        writeRow({
          external_id: extId,
          name: input.name,
          org_id: existing.id,
          status: "updated",
          error: "",
        });
        return;
      }

      // Does not exist yet (or no external_id to look up).
      if (DRY_RUN) {
        counters.dry++;
        writeRow({
          external_id: extId,
          name: input.name,
          org_id: "",
          status: "dry_run",
          error: "would create",
        });
        return;
      }

      await limiter.acquire();
      const orgId = await withRetries(
        () => createOrg(input),
        `create ${label}`,
        MAX_ATTEMPTS
      );
      counters.created++;
      writeRow({
        external_id: extId,
        name: input.name,
        org_id: orgId,
        status: "created",
        error: "",
      });
    } catch (err: any) {
      counters.failed++;
      writeRow({
        external_id: extId,
        name: input.name,
        org_id: "",
        status: "failed",
        error: err?.message ?? String(err),
      });
      console.error(`[fail] ${label}: ${err?.message ?? err}`);
    } finally {
      logProgress();
    }
  });

  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `\nDone in ${elapsed.toFixed(1)}s — created=${counters.created} updated=${counters.updated} skipped_existing=${counters.skippedExisting} skipped_unchanged=${counters.skippedUnchanged} failed=${counters.failed}${DRY_RUN ? ` dry=${counters.dry}` : ""}`
  );
  console.log(`Results: ${resolve(OUTPUT)}`);
  if (counters.failed > 0) console.log(`Errors:  ${resolve(ERRORS_OUTPUT)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
