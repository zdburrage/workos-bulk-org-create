/** Token-bucket rate limiter. Acquire one token per request. */
export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;

  constructor(rps: number, burst: number = rps) {
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.refillPerMs = rps / 1000;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const delta = (now - this.lastRefill) * this.refillPerMs;
    if (delta > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + delta);
      this.lastRefill = now;
    }
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await new Promise(r => setTimeout(r, waitMs));
    return this.acquire();
  }
}
