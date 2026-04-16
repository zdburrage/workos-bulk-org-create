/**
 * Interactive wizard for workos-bulk-org-create.
 *
 * Drives the create / verify / delete / invite / fixture flows by spawning the
 * existing scripts as subprocesses — no business logic is duplicated here.
 * Every flow prints the equivalent CLI so you can copy-paste it later.
 *
 * Run:  npm start     (or  npm run wizard)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface, Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import "dotenv/config";

// ---------- tiny ANSI helpers (no deps) ----------
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// ---------- prompt helpers ----------
let rl: Interface | null = null;
function getRl(): Interface {
  if (!rl) rl = createInterface({ input, output });
  return rl;
}

async function ask(q: string, defVal?: string): Promise<string> {
  const suffix = defVal !== undefined && defVal !== "" ? c.dim(` [${defVal}]`) : "";
  const a = (await getRl().question(`${q}${suffix} `)).trim();
  return a || defVal || "";
}

async function confirm(q: string, defYes = false): Promise<boolean> {
  const hint = defYes ? c.dim("[Y/n]") : c.dim("[y/N]");
  const a = (await getRl().question(`${q} ${hint} `)).trim().toLowerCase();
  if (!a) return defYes;
  return a === "y" || a === "yes";
}

type Choice<T> = { key: string; label: string; value: T };

async function menu<T>(title: string, opts: Array<Choice<T>>): Promise<T | "exit"> {
  console.log("\n" + c.bold(title));
  for (const o of opts) console.log(`  ${c.cyan(o.key)}) ${o.label}`);
  console.log(`  ${c.dim("q) Quit")}`);
  const pick = (await getRl().question("\nChoose: ")).trim().toLowerCase();
  if (pick === "q" || pick === "quit" || pick === "exit") return "exit";
  const found = opts.find(o => o.key === pick);
  if (found) return found.value;
  console.log(c.red("Invalid choice."));
  return menu(title, opts);
}

async function askExistingPath(prompt: string, defVal: string): Promise<string | null> {
  while (true) {
    const p = await ask(prompt, defVal);
    if (!p) return null;
    if (existsSync(p)) return p;
    console.log(c.red(`Not found: ${p}`));
    if (!(await confirm("Try another path?", true))) return null;
  }
}

// ---------- spawning ----------
function quoteIfNeeded(s: string): string {
  return /[\s"'$`\\]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

function previewCommand(cmd: string, args: string[]) {
  const tokens = [...cmd.split(/\s+/).filter(Boolean), ...args];
  console.log("\n" + c.dim("Equivalent command:"));
  console.log("  " + c.cyan(tokens.map(quoteIfNeeded).join(" ")));
}

function run(script: string, args: string[]): Promise<number> {
  return new Promise(resolve => {
    // Pause readline so the child owns the TTY, then resume.
    const wasRl = rl;
    if (wasRl) wasRl.pause();
    const child = spawn("npx", ["tsx", script, ...args], { stdio: "inherit" });
    child.on("exit", code => {
      if (wasRl) wasRl.resume();
      resolve(code ?? 0);
    });
    child.on("error", err => {
      console.error(c.red(`Failed to start subprocess: ${err.message}`));
      if (wasRl) wasRl.resume();
      resolve(1);
    });
  });
}

function haveApiKey(): boolean {
  return !!process.env.WORKOS_API_KEY;
}

function requireApiKey(flow: string): boolean {
  if (haveApiKey()) return true;
  console.log(
    c.red(`WORKOS_API_KEY is not set. Real ${flow} runs are disabled — only --dry-run.`)
  );
  console.log(c.dim("Set it in .env (see .env.example) or export it in your shell, then retry."));
  return false;
}

// ---------- flows ----------
async function createFlow() {
  console.log("\n" + c.bold("Create organizations"));
  const input = await askExistingPath("Path to input CSV/JSONL?", "examples/orgs.csv");
  if (!input) return;
  const output = await ask("Path for results CSV?", "results.csv");
  const updateMode = await confirm("Also update existing orgs where fields differ?", false);
  const limit = await ask("Limit to first N rows (blank for all)?", "");
  const defaultState = await ask(
    "Default domain state for rows without inline state? (pending/verified)",
    "pending"
  );
  const doDryFirst = await confirm("Run --dry-run first (recommended)?", true);

  const baseArgs = ["--input", input, "--output", output];
  if (updateMode) baseArgs.push("--update");
  if (limit) baseArgs.push("--limit", limit);
  if (defaultState && defaultState !== "pending") baseArgs.push("--domain-state", defaultState);

  if (doDryFirst) {
    const dryArgs = [...baseArgs, "--dry-run"];
    previewCommand("tsx src/create-orgs.ts", dryArgs);
    if (!(await confirm("Run dry-run now?", true))) return;
    const code = await run("src/create-orgs.ts", dryArgs);
    if (code !== 0) {
      console.log(c.red("Dry-run exited non-zero. Fix the issue before the real run."));
      return;
    }
    if (!(await confirm("Dry-run looks good. Proceed with the real create?", false))) return;
  }

  if (!requireApiKey("create")) return;
  previewCommand("tsx src/create-orgs.ts", baseArgs);
  if (!(await confirm("Proceed?", false))) return;
  await run("src/create-orgs.ts", baseArgs);
}

async function verifyFlow() {
  console.log("\n" + c.bold("Verify organizations (read-only)"));
  if (!requireApiKey("verify")) return;
  const input = await askExistingPath("Path to input CSV/JSONL?", "examples/orgs.csv");
  if (!input) return;
  const output = await ask("Path for verify report?", "verify-report.csv");
  const limit = await ask("Limit to first N rows (blank for all)?", "");

  const args = ["--input", input, "--output", output];
  if (limit) args.push("--limit", limit);
  previewCommand("tsx src/verify-orgs.ts", args);
  if (!(await confirm("Run verify?", true))) return;
  await run("src/verify-orgs.ts", args);
}

async function deleteFlow() {
  console.log("\n" + c.bold("Delete organizations") + c.red(" — DESTRUCTIVE"));
  const input = await askExistingPath(
    "Path to results CSV from create-orgs?",
    "results.csv"
  );
  if (!input) return;
  const output = await ask("Path for delete-results CSV?", "delete-results.csv");
  const filter = await ask(
    "Only delete rows whose external_id matches this regex? (blank = all)",
    ""
  );
  const limit = await ask("Delete at most N rows (blank = all)?", "");

  const baseArgs = ["--input", input, "--output", output];
  if (filter) baseArgs.push("--filter", filter);
  if (limit) baseArgs.push("--limit", limit);

  console.log(
    c.yellow("\nRunning a dry-run first — delete has a stricter rate limit (50/60s per API key).")
  );
  previewCommand("tsx src/delete-orgs.ts", baseArgs);
  if (!(await confirm("Run dry-run?", true))) return;
  const code = await run("src/delete-orgs.ts", baseArgs);
  if (code !== 0) {
    console.log(c.red("Dry-run failed."));
    return;
  }

  if (!requireApiKey("delete")) return;
  console.log("\n" + c.red(c.bold("You are about to PERMANENTLY DELETE WorkOS organizations.")));
  console.log(c.dim("At ~0.83 rps, deleting N orgs takes roughly N * 1.35 seconds."));
  const typed = await ask('Type DELETE to confirm, or anything else to cancel:', "");
  if (typed !== "DELETE") {
    console.log(c.yellow("Cancelled."));
    return;
  }
  const realArgs = [...baseArgs, "--yes"];
  previewCommand("tsx src/delete-orgs.ts", realArgs);
  await run("src/delete-orgs.ts", realArgs);
}

async function inviteFlow() {
  console.log("\n" + c.bold("Invite users"));
  const input = await askExistingPath(
    "Path to invites CSV/JSONL?",
    "examples/invites.csv"
  );
  if (!input) return;
  const output = await ask("Path for invite-results CSV?", "invite-results.csv");
  const defaultRole = await ask("Default role_slug for rows without one? (blank = none)", "");
  const defaultExpires = await ask(
    "Default expires_in_days for rows without one? (1-30, blank = WorkOS default of 7)",
    ""
  );
  const defaultInviter = await ask(
    "Default inviter_user_id for rows without one? (blank = none)",
    ""
  );
  const filter = await ask("Only invite rows whose email matches this regex? (blank = all)", "");
  const limit = await ask("Invite at most N rows (blank = all)?", "");
  const doDryFirst = await confirm("Run --dry-run first?", true);

  const baseArgs = ["--input", input, "--output", output];
  if (defaultRole) baseArgs.push("--role-slug", defaultRole);
  if (defaultExpires) baseArgs.push("--expires-in-days", defaultExpires);
  if (defaultInviter) baseArgs.push("--inviter-user-id", defaultInviter);
  if (filter) baseArgs.push("--filter", filter);
  if (limit) baseArgs.push("--limit", limit);

  if (doDryFirst) {
    const dryArgs = [...baseArgs, "--dry-run"];
    previewCommand("tsx src/invite-users.ts", dryArgs);
    if (!(await confirm("Run dry-run?", true))) return;
    const code = await run("src/invite-users.ts", dryArgs);
    if (code !== 0) {
      console.log(c.red("Dry-run failed."));
      return;
    }
    if (!(await confirm("Dry-run looks good. Send real invitations?", false))) return;
  }

  if (!requireApiKey("invite")) return;
  previewCommand("tsx src/invite-users.ts", baseArgs);
  if (!(await confirm("Proceed?", false))) return;
  await run("src/invite-users.ts", baseArgs);
}

async function fixtureFlow() {
  console.log("\n" + c.bold("Generate a synthetic fixture (load testing)"));
  const format = await ask("Format? (csv/jsonl)", "csv");
  const count = await ask("How many rows?", "1000");
  const output = await ask(
    "Output path?",
    format === "jsonl" ? "fixtures/bulk.jsonl" : "fixtures/bulk.csv"
  );
  const args = ["--format", format, "--count", count, "--output", output];
  previewCommand("tsx scripts/generate-fixture.ts", args);
  if (!(await confirm("Generate?", true))) return;
  await run("scripts/generate-fixture.ts", args);
}

// ---------- main ----------
async function main() {
  console.log(c.bold("\nWorkOS Bulk Org Tools — wizard"));
  console.log(c.dim("Every flow prints the equivalent CLI command, so you can script it later.\n"));
  if (!haveApiKey()) {
    console.log(
      c.yellow("Heads up: WORKOS_API_KEY is not set — only --dry-run operations are available.")
    );
    console.log(c.dim("Set it in .env (see .env.example) before a real run.\n"));
  }

  while (true) {
    const choice = await menu<string>("What would you like to do?", [
      { key: "1", label: "Create organizations", value: "create" },
      { key: "2", label: "Verify organizations (read-only)", value: "verify" },
      { key: "3", label: "Delete organizations (dry-run default)", value: "delete" },
      { key: "4", label: "Invite users", value: "invite" },
      { key: "5", label: "Generate a synthetic fixture", value: "fixture" },
    ]);
    if (choice === "exit") break;
    try {
      if (choice === "create") await createFlow();
      else if (choice === "verify") await verifyFlow();
      else if (choice === "delete") await deleteFlow();
      else if (choice === "invite") await inviteFlow();
      else if (choice === "fixture") await fixtureFlow();
    } catch (err: any) {
      console.error(c.red(`Flow errored: ${err?.message ?? err}`));
    }
    console.log(c.dim("\n— back to main menu —"));
  }

  getRl().close();
  console.log(c.dim("Bye."));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
