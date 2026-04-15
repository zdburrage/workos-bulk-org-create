export function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

export function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export function runPool<T>(
  items: T[],
  workerCount: number,
  worker: (item: T, i: number) => Promise<void>
): Promise<void[]> {
  let i = 0;
  const n = items.length;
  const runners = Array.from({ length: Math.max(1, workerCount) }, async () => {
    while (true) {
      const myIndex = i++;
      if (myIndex >= n) return;
      await worker(items[myIndex]!, myIndex);
    }
  });
  return Promise.all(runners);
}
