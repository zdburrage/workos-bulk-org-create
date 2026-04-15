/**
 * Generate a large fixture CSV for load testing create-orgs.ts in --dry-run mode.
 *
 * Usage:
 *   tsx scripts/generate-fixture.ts [--count 20000] [--output fixtures/bulk.csv] [--format csv|jsonl] [--seed 1]
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { arg } from "../src/lib/cli.js";

const argv = process.argv.slice(2);
const COUNT = Number(arg(argv, "count", "20000"));
const OUTPUT = arg(argv, "output", "fixtures/bulk.csv")!;
const FORMAT = (arg(argv, "format", "csv") as "csv" | "jsonl") ?? "csv";
const SEED = Number(arg(argv, "seed", "1"));

if (!Number.isFinite(COUNT) || COUNT <= 0) {
  console.error("--count must be a positive integer");
  process.exit(1);
}

// Deterministic pseudo-random so regenerating the fixture is reproducible.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

const NAME_PREFIXES = [
  "Acme", "Globex", "Initech", "Umbrella", "Soylent", "Stark", "Wayne",
  "Cyberdyne", "Tyrell", "Weyland", "Nakatomi", "Pied Piper", "Dunder",
  "Massive", "Vandelay", "Bluth", "Sterling", "Hooli", "Pearson", "Planet",
];
const NAME_SUFFIXES = [
  "Corp", "Industries", "Holdings", "Labs", "Systems", "Dynamics", "Group",
  "Partners", "Technologies", "Enterprises", "Solutions", "Ventures",
];
const TIERS = ["starter", "growth", "enterprise"];
const REGIONS = ["us-east", "us-west", "eu-central", "apac"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function pad(n: number, width: number) {
  return n.toString().padStart(width, "0");
}

mkdirSync(dirname(resolve(OUTPUT)), { recursive: true });

if (FORMAT === "csv") {
  const lines: string[] = ["name,external_id,domains,metadata"];
  for (let i = 1; i <= COUNT; i++) {
    const name = `${pick(NAME_PREFIXES)} ${pick(NAME_SUFFIXES)} ${pad(i, 5)}`;
    const externalId = `ext_bulk_${pad(i, 6)}`;
    const domainCount = Math.floor(rng() * 3); // 0, 1, or 2 domains
    const domains =
      domainCount === 0
        ? ""
        : Array.from({ length: domainCount }, (_, d) => `org${pad(i, 6)}-${d}.example.test`).join("|");
    const metadata = JSON.stringify({
      tier: pick(TIERS),
      region: pick(REGIONS),
      seat_pool: String(10 + Math.floor(rng() * 990)),
    });
    // Escape the metadata JSON for CSV (contains commas + quotes).
    const escName = /[",\n]/.test(name) ? `"${name.replace(/"/g, '""')}"` : name;
    const escMeta = `"${metadata.replace(/"/g, '""')}"`;
    lines.push(`${escName},${externalId},${domains},${escMeta}`);
  }
  writeFileSync(resolve(OUTPUT), lines.join("\n") + "\n");
} else {
  const chunks: string[] = [];
  for (let i = 1; i <= COUNT; i++) {
    const name = `${pick(NAME_PREFIXES)} ${pick(NAME_SUFFIXES)} ${pad(i, 5)}`;
    const externalId = `ext_bulk_${pad(i, 6)}`;
    const domainCount = Math.floor(rng() * 3);
    const domains = Array.from(
      { length: domainCount },
      (_, d) => `org${pad(i, 6)}-${d}.example.test`
    );
    const metadata = {
      tier: pick(TIERS),
      region: pick(REGIONS),
      seat_pool: String(10 + Math.floor(rng() * 990)),
    };
    chunks.push(JSON.stringify({ name, external_id: externalId, domains, metadata }));
  }
  writeFileSync(resolve(OUTPUT), chunks.join("\n") + "\n");
}

console.log(`Wrote ${COUNT} ${FORMAT.toUpperCase()} rows to ${resolve(OUTPUT)}`);
