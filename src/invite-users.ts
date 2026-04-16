/**
 * Bulk-send WorkOS user invitations from a CSV or JSONL file.
 *
 * Input columns (CSV) / keys (JSONL):
 *   - email (required)
 *   - organization_id and/or external_id (at least one required)
 *   - role_slug, expires_in_days, inviter_user_id (all optional, per-row)
 *
 * Run with `--help` for the full flag reference.
 */

import { WorkOS } from "@workos-inc/node";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";

import { arg, flag, runPool } from "./lib/cli.js";
import { LIMITS, warnIfOverLimit } from "./lib/limits.js";
import { csvEscape, detectFormat, loadInviteInput } from "./lib/parse.js";
import { RateLimiter } from "./lib/rate-limit.js";
import { INVITE_RESULT_HEADER, loadAlreadyInvited } from "./lib/results.js";
import { statusOf, withRetries } from "./lib/retry.js";
import type { InviteInput, InviteResultRow, InviteStatus } from "./lib/types.js";

const HELP = `
Usage: tsx src/invite-users.ts --input <path> [options]

Sends WorkOS user-management invitations in bulk.

Input columns (CSV) / keys (JSONL):
  email                     (required) Recipient email
  organization_id            Target org by WorkOS id
  external_id                Target org by external id (resolved via WorkOS lookup)
                             One of organization_id or external_id is required.
  role_slug                  Optional role to assign on accept
  expires_in_days            Optional (1-30), defaults to WorkOS default (7)
  inviter_user_id            Optional; personalizes the invitation email

Required:
  --input <path>            Path to CSV or JSONL

Options:
  --output <path>           Results CSV. Default: invite-results.csv
  --errors-output <path>    Errors-only CSV. Default: <output>.errors.<ext>
  --format auto|csv|jsonl   Input format. Default: auto (detected from extension)
  --rps <n>                 Requests per second. Default: 40 (safe under 500/10s user-management write limit)
  --concurrency <n>         Max in-flight requests. Default: 10
  --max-attempts <n>        Max retry attempts on 429/5xx. Default: 6
  --filter <regex>          Only invite rows whose email matches this regex.
  --limit <n>               Invite at most N rows (after --filter).
  --role-slug <s>           Default role_slug applied when a row doesn't set one.
  --expires-in-days <n>     Default expires_in_days applied when a row doesn't set one (1-30).
  --inviter-user-id <id>    Default inviter_user_id applied when a row doesn't set one.
  --dry-run                 Parse and preview without calling the API. No WORKOS_API_KEY needed.
  --help, -h                Show this help text.

Environment:
  WORKOS_API_KEY            Required unless --dry-run.

Examples:
  tsx src/invite-users.ts --input invites.csv --dry-run
  tsx src/invite-users.ts --input invites.csv --role-slug member
  tsx src/invite-users.ts --input invites.csv --filter '@acme\\.com$' --limit 50
`;

const argv = process.argv.slice(2);

if (flag(argv, "help") || flag(argv, "h")) {
  console.log(HELP.trim());
  process.exit(0);
}

const INPUT = arg(argv, "input");
const OUTPUT = arg(argv, "output", "invite-results.csv")!;
const ERRORS_OUTPUT =
  arg(argv, "errors-output") ?? OUTPUT.replace(/\.([^.]+)$/, ".errors.$1") ?? "invite-results.errors.csv";
const FORMAT = (arg(argv, "format", "auto") as "auto" | "csv" | "jsonl") ?? "auto";
const RPS = Number(arg(argv, "rps", "40"));
const CONCURRENCY = Number(arg(argv, "concurrency", "10"));
const MAX_ATTEMPTS = Number(arg(argv, "max-attempts", "6"));
const FILTER = arg(argv, "filter");
const LIMIT = arg(argv, "limit") ? Number(arg(argv, "limit")) : undefined;
const DEFAULT_ROLE = arg(argv, "role-slug");
const DEFAULT_EXPIRES = arg(argv, "expires-in-days")
  ? Number(arg(argv, "expires-in-days"))
  : undefined;
const DEFAULT_INVITER = arg(argv, "inviter-user-id");
const DRY_RUN = flag(argv, "dry-run");

if (!INPUT) {
  console.error("Missing --input <path>. Use --help for details.");
  process.exit(1);
}
if (!process.env.WORKOS_API_KEY && !DRY_RUN) {
  console.error("Missing WORKOS_API_KEY env var. Set it in .env or pass --dry-run.");
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
if (DEFAULT_EXPIRES !== undefined) {
  if (!Number.isFinite(DEFAULT_EXPIRES) || DEFAULT_EXPIRES < 1 || DEFAULT_EXPIRES > 30) {
    console.error("--expires-in-days must be an integer between 1 and 30");
    process.exit(1);
  }
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

const workos = DRY_RUN ? null : new WorkOS(process.env.WORKOS_API_KEY!);

function ensureHeader(path: string, header: string) {
  if (!existsSync(path)) writeFileSync(path, header);
}

function appendRow(path: string, row: InviteResultRow) {
  const line =
    [row.email, row.organization_id, row.external_id, row.invitation_id, row.status, row.error]
      .map(csvEscape)
      .join(",") + "\n";
  appendFileSync(path, line);
}

/** LRU-ish cache: external_id -> organization_id (or null if not found). */
const extIdCache = new Map<string, string | null>();

async function resolveOrgId(input: InviteInput): Promise<string | null> {
  if (input.organizationId) return input.organizationId;
  const ext = input.externalId!;
  if (extIdCache.has(ext)) return extIdCache.get(ext) ?? null;
  if (!workos) {
    // Dry-run: fake id so dry-run output is meaningful
    const fake = `dry_${ext}`;
    extIdCache.set(ext, fake);
    return fake;
  }
  try {
    const org = await (workos.organizations as any).getOrganizationByExternalId(ext);
    const id = org?.id ?? null;
    extIdCache.set(ext, id);
    return id;
  } catch (err: any) {
    if (statusOf(err) === 404) {
      extIdCache.set(ext, null);
      return null;
    }
    throw err;
  }
}

function isDuplicateInviteError(err: any): boolean {
  const status = statusOf(err);
  if (status !== 409 && status !== 422) return false;
  const msg = String(err?.message ?? "").toLowerCase();
  const code = String(err?.code ?? err?.response?.data?.code ?? "").toLowerCase();
  // Match both a stable-ish code and the common human-readable phrase.
  return (
    code.includes("invitation_already_exists") ||
    code.includes("already_invited") ||
    msg.includes("already") && msg.includes("invit")
  );
}

async function sendInvitation(
  email: string,
  organizationId: string,
  role?: string,
  expiresInDays?: number,
  inviterUserId?: string
): Promise<string | null> {
  if (!workos) return null;
  const opts: Record<string, unknown> = { email, organizationId };
  if (role) opts.roleSlug = role;
  if (expiresInDays !== undefined) opts.expiresInDays = expiresInDays;
  if (inviterUserId) opts.inviterUserId = inviterUserId;
  const inv = await (workos.userManagement as any).sendInvitation(opts);
  return (inv?.id as string) ?? null;
}

async function main() {
  let inputs: InviteInput[];
  try {
    inputs = loadInviteInput(INPUT!, FORMAT);
  } catch (e: any) {
    console.error(`Failed to parse ${INPUT}: ${e.message}`);
    process.exit(1);
  }

  const totalBeforeFilter = inputs.length;
  if (filterRe) inputs = inputs.filter(i => filterRe!.test(i.email));
  if (LIMIT !== undefined) inputs = inputs.slice(0, LIMIT);

  const filterNote =
    filterRe || LIMIT !== undefined ? ` (filtered ${inputs.length}/${totalBeforeFilter})` : "";
  console.log(
    `${DRY_RUN ? "DRY-RUN" : "INVITE"} — ${inputs.length} invitation(s) from ${INPUT} (format=${detectFormat(INPUT!, FORMAT)})${filterNote}`
  );
  if (inputs.length === 0) return;

  ensureHeader(OUTPUT, INVITE_RESULT_HEADER);
  ensureHeader(ERRORS_OUTPUT, INVITE_RESULT_HEADER);

  const alreadyDone = loadAlreadyInvited(OUTPUT);
  if (alreadyDone.size) {
    console.log(`Resuming — skipping ${alreadyDone.size} invitation(s) already processed in ${OUTPUT}`);
  }

  if (!DRY_RUN) warnIfOverLimit("invite-users", LIMITS.userManagementWrite, RPS, CONCURRENCY);
  const limiter = new RateLimiter(RPS, RPS);
  const counters = { invited: 0, skipped: 0, failed: 0, dry_run: 0 };
  const started = Date.now();
  const total = inputs.length;
  let completed = 0;
  const logProgress = () => {
    completed++;
    if (completed % 500 === 0 || completed === total) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = completed / Math.max(0.001, elapsed);
      console.log(
        `progress ${completed}/${total} — invited=${counters.invited} skipped=${counters.skipped} dry_run=${counters.dry_run} failed=${counters.failed} (${elapsed.toFixed(1)}s, ${rate.toFixed(0)}/s)`
      );
    }
  };

  const record = (row: InviteResultRow) => {
    appendRow(OUTPUT, row);
    if (row.status === "failed") appendRow(ERRORS_OUTPUT, row);
  };

  await runPool(inputs, CONCURRENCY, async (input, _idx) => {
    const externalId = input.externalId ?? "";
    try {
      const orgId = await resolveOrgId(input);
      if (!orgId) {
        counters.failed++;
        record({
          email: input.email,
          organization_id: "",
          external_id: externalId,
          invitation_id: "",
          status: "failed",
          error: `external_id not found: ${externalId}`,
        });
        return;
      }
      const resumeKey = `${input.email}|${orgId}`;
      if (alreadyDone.has(resumeKey)) {
        counters.skipped++;
        record({
          email: input.email,
          organization_id: orgId,
          external_id: externalId,
          invitation_id: "",
          status: "skipped_existing",
          error: "already-processed",
        });
        return;
      }

      if (DRY_RUN) {
        counters.dry_run++;
        record({
          email: input.email,
          organization_id: orgId,
          external_id: externalId,
          invitation_id: "",
          status: "dry_run",
          error: "",
        });
        return;
      }

      await limiter.acquire();
      const invitationId = await withRetries(
        () =>
          sendInvitation(
            input.email,
            orgId,
            input.roleSlug ?? DEFAULT_ROLE,
            input.expiresInDays ?? DEFAULT_EXPIRES,
            input.inviterUserId ?? DEFAULT_INVITER
          ),
        `invite ${input.email} -> ${orgId}`,
        MAX_ATTEMPTS
      );
      counters.invited++;
      record({
        email: input.email,
        organization_id: orgId,
        external_id: externalId,
        invitation_id: invitationId ?? "",
        status: "invited",
        error: "",
      });
    } catch (err: any) {
      // Treat "already invited" as an idempotent skip so re-runs are clean.
      if (isDuplicateInviteError(err)) {
        counters.skipped++;
        record({
          email: input.email,
          organization_id: input.organizationId ?? extIdCache.get(input.externalId ?? "") ?? "",
          external_id: externalId,
          invitation_id: "",
          status: "skipped_existing",
          error: `already-invited: ${err?.message ?? err}`,
        });
        return;
      }
      counters.failed++;
      const orgId = input.organizationId ?? extIdCache.get(input.externalId ?? "") ?? "";
      record({
        email: input.email,
        organization_id: orgId,
        external_id: externalId,
        invitation_id: "",
        status: "failed" as InviteStatus,
        error: err?.message ?? String(err),
      });
      console.error(`[fail] ${input.email} -> ${orgId}: ${err?.message ?? err}`);
    } finally {
      logProgress();
    }
  });

  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `\nDone in ${elapsed.toFixed(1)}s — invited=${counters.invited} skipped=${counters.skipped} dry_run=${counters.dry_run} failed=${counters.failed}`
  );
  console.log(`Results: ${resolve(OUTPUT)}`);
  if (counters.failed) console.log(`Errors: ${resolve(ERRORS_OUTPUT)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
