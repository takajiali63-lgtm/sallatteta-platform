// Cookie sessions shared by the admin panel and the cook account.
import { HttpError, parseCookies } from './http.js';
import { randomToken, sha256 } from './security.js';

export function sessionManager({ db, cfg, table, cookie, ownerColumn, hours }) {
  const attrs = `Path=/; HttpOnly; SameSite=Strict${cfg.isProd ? '; Secure' : ''}`;
  return {
    async create(ownerId) {
      const token = randomToken(32);
      const expires = new Date(Date.now() + hours * 3600_000).toISOString();
      await db.query(`INSERT INTO ${table} (${ownerColumn}, token_hash, expires_at) VALUES ($1,$2,$3)`, [ownerId, sha256(token), expires]);
      return `${cookie}=${token}; ${attrs}; Max-Age=${hours * 3600}`;
    },
    async ownerId(req) {
      const token = parseCookies(req.headers.cookie)[cookie];
      if (!token) return null;
      const row = await db.one(`SELECT ${ownerColumn} AS id FROM ${table} WHERE token_hash = $1 AND expires_at > $2`,
        [sha256(token), new Date().toISOString()]);
      return row ? row.id : null;
    },
    async destroy(req) {
      const token = parseCookies(req.headers.cookie)[cookie];
      if (token) await db.query(`DELETE FROM ${table} WHERE token_hash = $1`, [sha256(token)]);
      return `${cookie}=; ${attrs}; Max-Age=0`;
    },
    async destroyAll(ownerId) {
      await db.query(`DELETE FROM ${table} WHERE ${ownerColumn} = $1`, [ownerId]);
    },
  };
}

// CSRF defence for state-changing calls: SameSite=Strict cookie + custom header + Origin check.
export function checkCsrf(req) {
  if (req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'csrf');
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try { if (new URL(origin).host !== host) throw new Error(); } catch { throw new HttpError(403, 'csrf'); }
  }
}

export function publicBaseUrl(req, cfg) {
  if (cfg.publicBaseUrl) return cfg.publicBaseUrl;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
