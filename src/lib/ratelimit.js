// Rate limiting shared by every server instance.
// Stores:
//   memory   — one instance only (local dev, tests)
//   postgres — shared through the database; no extra infrastructure (default in production without Redis)
//   redis    — shared through Redis/Valkey; best for high traffic (used automatically when REDIS_URL is set)
// Fixed windows: same behaviour as the original limiter (N requests per window per key).
// If the store fails (e.g. Redis down), requests are ALLOWED (fail-open) and a warning is logged,
// so an infrastructure problem never locks real users out.

export class MemoryStore {
  constructor() { this.hits = new Map(); this.kind = 'memory'; }
  async hit(bucket, windowMs, now = Date.now()) {
    let h = this.hits.get(bucket);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; this.hits.set(bucket, h); }
    h.count++;
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    return { count: h.count, reset: h.reset };
  }
}

export class PgStore {
  constructor(db) { this.db = db; this.kind = 'postgres'; }
  async hit(bucket, windowMs, now = Date.now()) {
    // One atomic statement: start a new window if the old one ended, otherwise increment.
    const row = await this.db.one(
      `INSERT INTO rate_limits (bucket, count, reset_at) VALUES ($1, 1, $2)
       ON CONFLICT (bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= $3 THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= $3 THEN $2 ELSE rate_limits.reset_at END
       RETURNING count, reset_at`,
      [bucket, now + windowMs, now]);
    return { count: Number(row.count), reset: Number(row.reset_at) };
  }
  async cleanup(now = Date.now()) {
    return (await this.db.query('DELETE FROM rate_limits WHERE reset_at <= $1 RETURNING bucket', [now])).length;
  }
}

export class RedisStore {
  constructor(redis) { this.redis = redis; this.kind = 'redis'; }
  async hit(bucket, windowMs, now = Date.now()) {
    const slot = Math.floor(now / windowMs);
    const key = `rl:${bucket}:${slot}`;
    const count = Number(await this.redis.command('INCR', key));
    if (count === 1) await this.redis.command('PEXPIRE', key, windowMs + 1000);
    return { count, reset: (slot + 1) * windowMs };
  }
}

export class RateLimiter {
  constructor({ name, windowMs, max, store, log = console }) {
    Object.assign(this, { name, windowMs, max, store, log });
  }
  /** → { ok, retryAfterSec } */
  async take(key, now = Date.now()) {
    try {
      const { count, reset } = await this.store.hit(`${this.name}:${key}`, this.windowMs, now);
      if (count > this.max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((reset - now) / 1000)) };
      return { ok: true, remaining: this.max - count };
    } catch (err) {
      this.log.warn?.(`[ratelimit] ${this.store.kind} unavailable (${err.message}) — allowing request`);
      return { ok: true, degraded: true };
    }
  }
  stop() {}
}

export function pickStore({ cfg, db, redis }) {
  const want = cfg.rateLimitStore || (redis ? 'redis' : cfg.isProd ? 'postgres' : 'memory');
  if (want === 'redis' && redis) return new RedisStore(redis);
  if (want === 'postgres') return new PgStore(db);
  return new MemoryStore();
}
