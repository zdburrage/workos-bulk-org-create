import { test } from "node:test";
import assert from "node:assert/strict";
import { retryAfterMs, statusOf, withRetries } from "../src/lib/retry.ts";

test("statusOf reads from common error shapes", () => {
  assert.equal(statusOf({ status: 429 }), 429);
  assert.equal(statusOf({ httpStatus: 500 }), 500);
  assert.equal(statusOf({ response: { status: 503 } }), 503);
  assert.equal(statusOf({}), undefined);
  assert.equal(statusOf(null), undefined);
});

test("retryAfterMs reads numeric seconds header", () => {
  assert.equal(retryAfterMs({ response: { headers: { "retry-after": "2" } } }), 2000);
});

test("retryAfterMs reads HTTP-date header", () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const ms = retryAfterMs({ headers: { "retry-after": future } });
  assert.ok(ms && ms > 3000 && ms < 7000, `expected ~5000ms, got ${ms}`);
});

test("withRetries retries on 429 and eventually succeeds", async () => {
  let attempts = 0;
  const result = await withRetries(
    async () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("rate limited"), { status: 429 });
      return "ok";
    },
    "test",
    5
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("withRetries does not retry non-retryable errors", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetries(
      async () => {
        attempts++;
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
      "test",
      5
    ),
    /bad request/
  );
  assert.equal(attempts, 1);
});

test("withRetries surfaces error after maxAttempts", async () => {
  let attempts = 0;
  await assert.rejects(
    withRetries(
      async () => {
        attempts++;
        throw Object.assign(new Error("server error"), { status: 500 });
      },
      "test",
      3
    ),
    /server error/
  );
  assert.equal(attempts, 3);
});
