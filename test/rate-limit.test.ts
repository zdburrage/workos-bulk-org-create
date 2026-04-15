import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/lib/rate-limit.ts";

test("RateLimiter allows burst up to capacity immediately", async () => {
  const limiter = new RateLimiter(10, 5);
  const start = Date.now();
  await Promise.all([
    limiter.acquire(),
    limiter.acquire(),
    limiter.acquire(),
    limiter.acquire(),
    limiter.acquire(),
  ]);
  const elapsed = Date.now() - start;
  // All 5 tokens should be available instantly.
  assert.ok(elapsed < 50, `expected burst to be fast, took ${elapsed}ms`);
});

test("RateLimiter throttles when over budget", async () => {
  const limiter = new RateLimiter(100); // 100 rps = 10ms per token, capacity 100
  // Drain the bucket.
  for (let i = 0; i < 100; i++) await limiter.acquire();
  const start = Date.now();
  // Next 10 should take ~100ms total (10 tokens × 10ms).
  for (let i = 0; i < 10; i++) await limiter.acquire();
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed >= 50 && elapsed < 500,
    `expected throttling to take ~100ms, took ${elapsed}ms`
  );
});
