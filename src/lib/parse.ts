import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DomainSpec, DomainState, OrgInput } from "./types.js";

/** RFC-4180-ish CSV parser. Handles quoted fields, escaped quotes, CRLF, and a leading UTF-8 BOM. */
export function parseCsv(text: string): string[][] {
  // Strip UTF-8 BOM (Excel CSV exports include one).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

export function csvEscape(v: string | undefined | null): string {
  if (v == null) return "";
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function parseDomainState(raw: unknown): DomainState | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (s === "") return undefined;
  if (s === "pending" || s === "verified") return s;
  throw new Error(`Invalid domain state ${JSON.stringify(raw)}; expected "pending" or "verified"`);
}

/**
 * Parse a single CSV/string domain token. Accepts:
 *   - "acme.com"                  → { domain: "acme.com" }
 *   - "acme.com:verified"         → { domain: "acme.com", state: "verified" }
 *   - "  acme.com : pending  "    → { domain: "acme.com", state: "pending" }
 */
function parseDomainToken(token: string): DomainSpec | undefined {
  const trimmed = token.trim();
  if (!trimmed) return undefined;
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) return { domain: trimmed };
  const domain = trimmed.slice(0, colon).trim();
  const statePart = trimmed.slice(colon + 1).trim();
  if (!domain) return undefined;
  const state = parseDomainState(statePart);
  return state ? { domain, state } : { domain };
}

/**
 * Parse a raw `domains` value from CSV or JSONL into DomainSpec objects.
 *
 * Accepted shapes:
 *   - undefined / null / ""                           → undefined
 *   - "acme.com|acme.io"                              → plain, state unset (falls back to --domain-state)
 *   - "acme.com:verified|acme.io:pending"             → explicit state per domain
 *   - ["acme.com", "acme.io:verified"]                → array of strings, colon-suffix allowed
 *   - [{ "domain": "acme.com", "state": "verified" }] → array of objects (JSONL)
 */
export function splitDomains(raw: unknown): DomainSpec[] | undefined {
  if (raw == null) return undefined;

  if (Array.isArray(raw)) {
    const out: DomainSpec[] = [];
    for (const item of raw) {
      if (item == null) continue;
      if (typeof item === "string") {
        const spec = parseDomainToken(item);
        if (spec) out.push(spec);
      } else if (typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const domain = typeof obj.domain === "string" ? obj.domain.trim() : "";
        if (!domain) continue;
        const state = parseDomainState(obj.state);
        out.push(state ? { domain, state } : { domain });
      } else {
        const spec = parseDomainToken(String(item));
        if (spec) out.push(spec);
      }
    }
    return out.length ? out : undefined;
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return undefined;
    const out: DomainSpec[] = [];
    for (const tok of trimmed.split(/[|;]/)) {
      const spec = parseDomainToken(tok);
      if (spec) out.push(spec);
    }
    return out.length ? out : undefined;
  }

  return undefined;
}

export function normalizeMetadata(obj: unknown): Record<string, string> | undefined {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v == null) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export function parseMetadata(raw: unknown): Record<string, string> | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "") return undefined;
    try {
      return normalizeMetadata(JSON.parse(t));
    } catch (e: any) {
      throw new Error(`Invalid metadata JSON: ${e.message}`);
    }
  }
  return normalizeMetadata(raw);
}

export type InputFormat = "csv" | "jsonl";

export function detectFormat(path: string, hint: "auto" | "csv" | "jsonl"): InputFormat {
  if (hint !== "auto") return hint;
  const lower = path.toLowerCase();
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  return "csv";
}

export function loadCsvInputs(text: string): OrgInput[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!.map(h => h.trim().toLowerCase());
  const nameIdx = header.indexOf("name");
  const extIdx = header.indexOf("external_id");
  const domIdx = header.indexOf("domains");
  const metaIdx = header.indexOf("metadata");
  if (nameIdx < 0 || extIdx < 0) {
    throw new Error("CSV must include 'name' and 'external_id' columns");
  }
  const out: OrgInput[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const name = (row[nameIdx] ?? "").trim();
    const externalId = (row[extIdx] ?? "").trim();
    if (!name || !externalId) continue;
    const domains = domIdx >= 0 ? splitDomains(row[domIdx] ?? "") : undefined;
    const metadata = metaIdx >= 0 ? parseMetadata(row[metaIdx] ?? "") : undefined;
    out.push({ name, externalId, domains, metadata });
  }
  return out;
}

export function loadJsonlInputs(text: string): OrgInput[] {
  const out: OrgInput[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch (e: any) {
      throw new Error(`Invalid JSON on line ${i + 1}: ${e.message}`);
    }
    const name = String(obj.name ?? "").trim();
    const externalId = String(obj.external_id ?? obj.externalId ?? "").trim();
    if (!name || !externalId) continue;
    out.push({
      name,
      externalId,
      domains: splitDomains(obj.domains),
      metadata: parseMetadata(obj.metadata),
    });
  }
  return out;
}

export function loadInput(path: string, hint: "auto" | "csv" | "jsonl"): OrgInput[] {
  const text = readFileSync(resolve(path), "utf8");
  return detectFormat(path, hint) === "jsonl" ? loadJsonlInputs(text) : loadCsvInputs(text);
}
