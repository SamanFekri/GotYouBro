export interface RateLimit {
  max: number;
  windowMs: number;
}

const UNITS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  second: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
};

export type TimeUnit = 'second' | 'minute' | 'hour' | 'day';

const PATTERN = /^\s*(\d+)\s*(?:\/\s*(\d+)?\s*([a-z]+?)s?)?\s*$/i;

/**
 * Parse a rate limit string such as `60/minute`, `30/hour`, `100/15m` or a bare number (uses
 * `defaultUnit`). `unlimited` / `0` mean no limit (returns null).
 */
export function parseRateLimit(input: string, defaultUnit: TimeUnit = 'minute'): RateLimit | null {
  const value = input.trim().toLowerCase();
  if (value === 'unlimited' || value === 'none' || value === '0') return null;
  const match = PATTERN.exec(value);
  if (!match) throw new Error(`Invalid rate limit "${input}" (expected e.g. "60/minute")`);
  const max = Number(match[1]);
  const multiplier = match[2] ? Number(match[2]) : 1;
  const unitMs = UNITS[match[3] ?? defaultUnit];
  if (!unitMs || multiplier < 1) throw new Error(`Invalid rate limit unit in "${input}"`);
  return { max, windowMs: unitMs * multiplier };
}

export function isValidRateLimit(input: string): boolean {
  try {
    parseRateLimit(input);
    return true;
  } catch {
    return false;
  }
}

export interface RateLimitCheck {
  /** Bucket key, e.g. `user:abc:backup`. */
  key: string;
  limit: RateLimit | null;
}

export interface RateLimitResult {
  allowed: boolean;
  /** The tightest applicable bucket (for response headers). */
  limit?: number;
  remaining?: number;
  resetAt?: number;
  /** Key of the bucket that rejected the request. */
  blockedBy?: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window rate limiter. Single-process by design (no Redis): counters reset when
 * the process restarts, which is acceptable for this service's abuse-prevention purpose.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Atomically check several buckets: the request is counted against all of them only if every
   * bucket has capacity, so a rejection by one level never consumes quota at another.
   */
  consume(checks: RateLimitCheck[]): RateLimitResult {
    const now = this.now();
    const active = checks.filter((c): c is { key: string; limit: RateLimit } => c.limit !== null);
    const resolved = active.map((c) => {
      const key = `${c.key}|${c.limit.max}/${c.limit.windowMs}`;
      let bucket = this.buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + c.limit.windowMs };
        this.buckets.set(key, bucket);
      }
      return { check: c, bucket };
    });

    const blocked = resolved.find(({ check, bucket }) => bucket.count >= check.limit.max);
    if (blocked) {
      return {
        allowed: false,
        limit: blocked.check.limit.max,
        remaining: 0,
        resetAt: blocked.bucket.resetAt,
        blockedBy: blocked.check.key,
      };
    }

    let tightest: { limit: number; remaining: number; resetAt: number } | undefined;
    for (const { check, bucket } of resolved) {
      bucket.count++;
      const remaining = check.limit.max - bucket.count;
      if (!tightest || remaining < tightest.remaining) {
        tightest = { limit: check.limit.max, remaining, resetAt: bucket.resetAt };
      }
    }
    return { allowed: true, ...tightest };
  }

  reset(): void {
    this.buckets.clear();
  }

  startSweeping(intervalMs = 60_000): void {
    this.stopSweeping();
    this.sweepTimer = setInterval(() => {
      const now = this.now();
      for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
    }, intervalMs);
    this.sweepTimer.unref();
  }

  stopSweeping(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}
