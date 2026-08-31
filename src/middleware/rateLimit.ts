import type { Context } from "hono";

import { RATE_LIMIT_PER_MINUTE } from "../services/configService.ts";

export interface RateLimitConfig {
  maxPerMinute: number;
}

interface Bucket {
  count: number;
  resetAt: number;
  lastSeen: number;
}

const buckets = new Map<string, Bucket>();

export async function rateLimitMiddleware(
  c: Context,
  _key: string,
  cfg?: Partial<RateLimitConfig>,
): Promise<Response | null> {
  const max = cfg?.maxPerMinute ?? RATE_LIMIT_PER_MINUTE;
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000, lastSeen: now };
    buckets.set(ip, bucket);
  }
  bucket.count++;
  bucket.lastSeen = now;
  if (bucket.count > max) {
    return c.json({ error: { message: "Rate limit exceeded" } }, 429);
  }
  return null;
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function cleanupIdleBuckets(maxIdleMinutes = 60): void {
  const cutoff = Date.now() - maxIdleMinutes * 60_000;
  for (const [key, bucket] of buckets) {
    if (bucket.lastSeen < cutoff) buckets.delete(key);
  }
}

export function startAutoCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => cleanupIdleBuckets(), 10 * 60_000);
  cleanupTimer.unref?.();
}

export function stopAutoCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
