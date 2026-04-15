export function statusOf(err: any): number | undefined {
  return err?.status ?? err?.httpStatus ?? err?.response?.status;
}

export function retryAfterMs(err: any): number | undefined {
  const h = err?.response?.headers?.["retry-after"] ?? err?.headers?.["retry-after"];
  if (!h) return undefined;
  const n = Number(h);
  if (!Number.isNaN(n)) return n * 1000;
  const when = Date.parse(h);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

export async function withRetries<T>(
  op: () => Promise<T>,
  label: string,
  maxAttempts = 6
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await op();
    } catch (err: any) {
      attempt++;
      const status = statusOf(err);
      const retryable = status === 429 || (status !== undefined && status >= 500);
      if (!retryable || attempt >= maxAttempts) throw err;
      const backoff =
        retryAfterMs(err) ??
        Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      console.warn(
        `[retry] ${label} attempt ${attempt} after ${status ?? "?"}, sleeping ${backoff}ms: ${err?.message}`
      );
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}
