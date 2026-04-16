import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { csvEscape, parseCsv } from "./parse.js";
import type { ResultRow } from "./types.js";

export const RESULT_HEADER = "external_id,name,org_id,status,error\n";

export function ensureHeader(path: string, header: string) {
  if (!existsSync(path)) writeFileSync(path, header);
}

/**
 * Returns a resume key for an org input row.
 * Uses external_id when available, otherwise falls back to name.
 */
export function resumeKey(externalId?: string, name?: string): string {
  return externalId || name || "";
}

/**
 * Returns the set of resume keys that are already recorded in `path` with a
 * terminal (non-`failed`) status. Used to make runs resumable.
 * Key is external_id when present, otherwise name.
 */
export function loadAlreadyProcessed(path: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length <= 1) return done;
  const header = rows[0]!.map(h => h.trim().toLowerCase());
  const extIdx = header.indexOf("external_id");
  const nameIdx = header.indexOf("name");
  const statusIdx = header.indexOf("status");
  for (let i = 1; i < rows.length; i++) {
    const ext = extIdx >= 0 ? (rows[i]?.[extIdx] ?? "").trim() : "";
    const name = nameIdx >= 0 ? (rows[i]?.[nameIdx] ?? "").trim() : "";
    const status = statusIdx >= 0 ? rows[i]?.[statusIdx] : undefined;
    const key = resumeKey(ext || undefined, name || undefined);
    if (key && status && status !== "failed") done.add(key);
  }
  return done;
}

export function appendResult(path: string, row: ResultRow, errorsPath?: string) {
  const line =
    [row.external_id, row.name, row.org_id, row.status, row.error].map(csvEscape).join(",") + "\n";
  appendFileSync(path, line);
  if (errorsPath && row.status === "failed") appendFileSync(errorsPath, line);
}

export function deriveErrorsPath(outputPath: string): string {
  const idx = outputPath.lastIndexOf(".");
  if (idx <= 0) return `${outputPath}.errors.csv`;
  return `${outputPath.slice(0, idx)}.errors${outputPath.slice(idx)}`;
}

/**
 * Returns the set of org_ids that already appear in `path` with a terminal
 * (non-`failed`) status. Used by delete-orgs.ts for resumability.
 */
export function loadProcessedOrgIds(path: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length <= 1) return done;
  const header = rows[0]!.map(h => h.trim().toLowerCase());
  const idIdx = header.indexOf("org_id");
  const statusIdx = header.indexOf("status");
  if (idIdx < 0) return done;
  for (let i = 1; i < rows.length; i++) {
    const id = rows[i]?.[idIdx];
    const status = statusIdx >= 0 ? rows[i]?.[statusIdx] : undefined;
    if (id && status && status !== "failed") done.add(id);
  }
  return done;
}

export const INVITE_RESULT_HEADER =
  "email,organization_id,external_id,invitation_id,status,error\n";

/**
 * Returns the set of "email|organization_id" keys that are already recorded in
 * `path` with a terminal (non-`failed`) status. Used by invite-users.ts for
 * resumability. An email invited to two different orgs is two distinct keys.
 */
export function loadAlreadyInvited(path: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length <= 1) return done;
  const header = rows[0]!.map(h => h.trim().toLowerCase());
  const emailIdx = header.indexOf("email");
  const orgIdx = header.indexOf("organization_id");
  const statusIdx = header.indexOf("status");
  if (emailIdx < 0 || orgIdx < 0) return done;
  for (let i = 1; i < rows.length; i++) {
    const email = rows[i]?.[emailIdx];
    const org = rows[i]?.[orgIdx];
    const status = statusIdx >= 0 ? rows[i]?.[statusIdx] : undefined;
    if (email && org && status && status !== "failed") {
      done.add(`${email}|${org}`);
    }
  }
  return done;
}

/**
 * Reads a results CSV and returns the successful rows (status === "created" or "updated")
 * that have a non-empty org_id. Used by delete-orgs.ts and verify-orgs.ts.
 */
export function readSuccessfulResults(
  path: string
): Array<{ external_id: string; name: string; org_id: string; status: string }> {
  if (!existsSync(path)) throw new Error(`Results file not found: ${path}`);
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length <= 1) return [];
  const header = rows[0]!.map(h => h.trim().toLowerCase());
  const extIdx = header.indexOf("external_id");
  const nameIdx = header.indexOf("name");
  const idIdx = header.indexOf("org_id");
  const statusIdx = header.indexOf("status");
  if (extIdx < 0 || idIdx < 0 || statusIdx < 0) {
    throw new Error(`Results CSV missing required columns (external_id, org_id, status): ${path}`);
  }
  const out: Array<{ external_id: string; name: string; org_id: string; status: string }> = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const status = (r[statusIdx] ?? "").trim();
    const org_id = (r[idIdx] ?? "").trim();
    if (!org_id) continue;
    if (status !== "created" && status !== "updated") continue;
    out.push({
      external_id: (r[extIdx] ?? "").trim(),
      name: nameIdx >= 0 ? (r[nameIdx] ?? "").trim() : "",
      org_id,
      status,
    });
  }
  return out;
}
