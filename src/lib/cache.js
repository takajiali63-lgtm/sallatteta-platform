// Tiny in-process cache with TTL + request coalescing (many simultaneous visitors → one DB query).
export class MemoryCache {
  constructor(maxEntries = 500) { this.map = new Map(); this.max = maxEntries; }
  async get(key, ttlMs, load) {
    const hit = this.map.get(key);
    if (hit && hit.exp > Date.now()) return hit.promise;
    const promise = Promise.resolve().then(load);
    this.map.set(key, { exp: Date.now() + ttlMs, promise });
    promise.catch(() => this.map.delete(key));
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return promise;
  }
  clear(prefix = '') { for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k); }
}

/**
 * Shared cache for several server instances (Redis/Valkey, REDIS_URL). Public data only (config, feed, banners…).
 * - small local layer (≤ 5 s) so a hot key is not fetched from Redis on every request
 * - request coalescing per instance
 * - Dates survive the trip through JSON
 * - if Redis is down, the value is simply loaded (the site keeps working)
 */
const enc = (v) => JSON.stringify(v, function (k, x) { const raw = this[k]; return raw instanceof Date ? { $d: raw.toISOString() } : x; });
const dec = (s) => JSON.parse(s, (k, x) => (x && typeof x === 'object' && typeof x.$d === 'string' && Object.keys(x).length === 1 ? new Date(x.$d) : x));

export class RedisCache {
  constructor(redis, { prefix = 'cache:', localMs = 5000, log = console } = {}) {
    this.redis = redis; this.prefix = prefix; this.local = new MemoryCache(1000); this.localMs = localMs; this.log = log;
  }
  async get(key, ttlMs, load) {
    return this.local.get(key, Math.min(ttlMs, this.localMs), async () => {
      const rk = this.prefix + key;
      try {
        const hit = await this.redis.command('GET', rk);
        if (hit != null) return dec(hit);
      } catch (e) { this.log.warn?.(`[cache] redis read failed: ${e.message}`); return load(); }
      const value = await load();
      this.redis.command('SET', rk, enc(value), 'PX', String(Math.max(1000, ttlMs))).catch((e) => this.log.warn?.(`[cache] redis write failed: ${e.message}`));
      return value;
    });
  }
  /** Remove every key starting with prefix, on every instance (Redis SCAN + DEL); the local layer expires within seconds. */
  clear(prefix = '') {
    this.local.clear(prefix);
    (async () => {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.command('SCAN', cursor, 'MATCH', `${this.prefix}${prefix}*`, 'COUNT', '200');
        cursor = String(next);
        if (keys?.length) await this.redis.command('DEL', ...keys);
      } while (cursor !== '0');
    })().catch((e) => this.log.warn?.(`[cache] redis clear failed: ${e.message}`));
  }
}
