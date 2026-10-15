// Short-lived cache for read-only chain calls. Several components on one page
// read the same contract state (e.g. stx-core get-stats); sharing the request
// keeps us well under Hiro's public rate limit. Failed reads are not cached.
const TTL_MS = 15_000;
const entries = new Map<string, { at: number; value: Promise<unknown> }>();

export function cachedRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = read().catch((err) => {
    entries.delete(key);
    throw err;
  });
  entries.set(key, { at: Date.now(), value });
  return value;
}
