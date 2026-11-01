// Best-effort per-IP rate limiting. Counters live in isolate memory — they
// reset on eviction and do not coordinate across isolates, so this blunts
// bursts and brute force; it is not a hard quota. Hard quota for intake
// writes is the queue cap (query.ts / maintain.ts); a zone-level rule can
// still sit on top in Cloudflare.

const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 10_000;

function sweep(now: number): void {
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
  if (buckets.size > MAX_BUCKETS) buckets.clear();
}

// Counts one hit against key's fixed window and reports whether the caller
// is now over the limit. First hit starts a fresh window.
export function rateLimited(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  if (buckets.size > MAX_BUCKETS) sweep(now);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  b.count += 1;
  return b.count > limit;
}

// Read-only check — true when key already sits at or over its limit. Used
// for failure-counted limits (bad auth attempts, wrong PINs) where a hit
// must only be recorded on failure.
export function overLimit(key: string, limit: number, now = Date.now()) {
  const b = buckets.get(key);
  return !!b && b.resetAt > now && b.count >= limit;
}
