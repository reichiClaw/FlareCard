/**
 * In-memory fixed-window rate limiter for authentication failures.
 *
 * FlareCard runs its HTTP app inside a single Durable Object, so one in-memory
 * instance sees every request and the counters are globally consistent without
 * any external store. This works identically on Cloudflare and workerd.
 *
 * Only *failed* authentication attempts are counted; a successful login clears
 * the counters for that key, so legitimate devices are never throttled.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets (0 when allowed). */
  retryAfterSeconds: number;
  remaining: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A limit of 0 (or less) disables this limiter entirely. */
  get enabled(): boolean {
    return this.max > 0;
  }

  check(key: string): RateLimitDecision {
    if (!this.enabled) return { allowed: true, retryAfterSeconds: 0, remaining: Number.POSITIVE_INFINITY };
    const bucket = this.buckets.get(key);
    const now = this.now();
    if (!bucket || bucket.resetAt <= now) return { allowed: true, retryAfterSeconds: 0, remaining: this.max };
    if (bucket.count >= this.max) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)), remaining: 0 };
    }
    return { allowed: true, retryAfterSeconds: 0, remaining: this.max - bucket.count };
  }

  recordFailure(key: string): void {
    if (!this.enabled) return;
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      bucket.count++;
    }
    if (this.buckets.size > 20_000) this.sweep(now);
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(now: number): void {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    // Still too large after removing expired entries (an attacker rotating keys):
    // drop everything rather than grow without bound.
    if (this.buckets.size > 20_000) this.buckets.clear();
  }
}

export interface AuthRateLimitEnv {
  /** Max failed attempts per client IP within the window. Default 60. */
  AUTH_RATE_LIMIT_IP?: string;
  /** Max failed attempts per username within the window. Default 15. */
  AUTH_RATE_LIMIT_USER?: string;
  /** Window length in seconds. Default 600 (10 minutes). */
  AUTH_RATE_LIMIT_WINDOW_SECONDS?: string;
}

/** Parses a non-negative integer; anything unset or malformed yields the fallback. */
function intOr(value: string | null | undefined, fallback: number, min = 0): number {
  // workerd's `fromEnvironment` bindings yield null (not undefined) for unset variables.
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/**
 * Guards a credential check with two independent budgets: one per client IP
 * (catches distributed guessing of many usernames from one host) and one per
 * username (catches guessing one account from many hosts).
 */
export class AuthRateLimiter {
  private byIp: RateLimiter;
  private byUser: RateLimiter;

  constructor(env: AuthRateLimitEnv = {}, now?: () => number) {
    const windowMs = intOr(env.AUTH_RATE_LIMIT_WINDOW_SECONDS, 600, 1) * 1000;
    this.byIp = new RateLimiter(intOr(env.AUTH_RATE_LIMIT_IP, 60), windowMs, now);
    this.byUser = new RateLimiter(intOr(env.AUTH_RATE_LIMIT_USER, 15), windowMs, now);
  }

  /** Returns a blocking decision if either budget is exhausted. */
  check(ip: string, username: string | null): RateLimitDecision {
    const ipDecision = this.byIp.check(`ip:${ip}`);
    if (!ipDecision.allowed) return ipDecision;
    if (username) {
      const userDecision = this.byUser.check(`user:${username.toLowerCase()}`);
      if (!userDecision.allowed) return userDecision;
    }
    return { allowed: true, retryAfterSeconds: 0, remaining: ipDecision.remaining };
  }

  recordFailure(ip: string, username: string | null): void {
    this.byIp.recordFailure(`ip:${ip}`);
    if (username) this.byUser.recordFailure(`user:${username.toLowerCase()}`);
  }

  recordSuccess(ip: string, username: string): void {
    this.byIp.reset(`ip:${ip}`);
    this.byUser.reset(`user:${username.toLowerCase()}`);
  }
}

/**
 * Best-effort client IP. Cloudflare sets CF-Connecting-IP; a reverse proxy in
 * front of workerd should set X-Forwarded-For (we take the first hop).
 */
export function clientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export function tooManyRequests(decision: RateLimitDecision, extraHeaders: Record<string, string> = {}): Response {
  return new Response("Too many failed authentication attempts. Try again later.", {
    status: 429,
    headers: {
      "Retry-After": String(decision.retryAfterSeconds),
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders,
    },
  });
}
