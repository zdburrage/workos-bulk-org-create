/**
 * Known WorkOS rate limits (as of 2026-04). Used to pick safe defaults and to
 * warn operators who manually raise --rps / --concurrency beyond the
 * endpoint's bucket.
 *
 * Source: https://workos.com/docs/reference/rate-limits
 */

export type EndpointLimit = {
  /** Requests per second the endpoint will sustain without 429s. */
  safeRps: number;
  /** Concurrency that pairs with safeRps without bursting over the bucket. */
  safeConcurrency: number;
  /** Human-friendly description for warnings and --help text. */
  description: string;
};

export const LIMITS = {
  /** Organization create/update/get. General IP limit is ~100 rps. */
  organizationsWrite: {
    safeRps: 50,
    safeConcurrency: 10,
    description: "WorkOS general limit is 6,000 requests per 60 seconds per IP (~100 rps)",
  },
  /** Delete organization — has its own much stricter per-API-key bucket. */
  organizationsDelete: {
    safeRps: 0.75,
    safeConcurrency: 1,
    description:
      "WorkOS limits delete-organization to 50 requests per 60 seconds per API key (~0.83 rps)",
  },
  /** User management writes (send invitation, etc.). 500 req / 10s per env = ~50 rps. */
  userManagementWrite: {
    safeRps: 40,
    safeConcurrency: 10,
    description:
      "WorkOS limits /user_management writes to 500 requests per 10 seconds (~50 rps)",
  },
} as const satisfies Record<string, EndpointLimit>;

/**
 * Warn (to stderr) if the operator-supplied rps/concurrency exceed the known
 * safe bucket. We don't hard-cap — WorkOS support can raise a customer's limit
 * and we shouldn't get in the way. Retry logic with Retry-After handles the
 * fallout if we're wrong.
 */
export function warnIfOverLimit(
  label: string,
  limit: EndpointLimit,
  rps: number,
  concurrency: number
): void {
  const rpsOver = rps > limit.safeRps;
  const concOver = concurrency > limit.safeConcurrency;
  if (!rpsOver && !concOver) return;

  const parts: string[] = [];
  if (rpsOver) parts.push(`--rps=${rps} exceeds safe ${limit.safeRps}`);
  if (concOver) parts.push(`--concurrency=${concurrency} exceeds safe ${limit.safeConcurrency}`);

  console.warn(
    `\n[warn] ${label}: ${parts.join(", ")}.\n` +
      `       ${limit.description}.\n` +
      `       Expect 429s. Retries will back off, but the run will be slower than the defaults.\n` +
      `       Only raise these if WorkOS support has raised your API key's limit.\n`
  );
}
