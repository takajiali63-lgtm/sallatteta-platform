import { randomInt } from 'node:crypto';
import { HttpError, readJson, sendJson } from '../lib/http.js';
import { Validator, validatePhoto } from '../lib/validate.js';
import { roundTo } from '../lib/geo.js';
import { normalizePhone, fillTemplate } from '../lib/whatsapp.js';
import { toLocalFormat, getCountry, isBuiltInCountry, validCountryDef } from '../lib/countries.js';
import { hashPassword, verifyPassword, clientIp } from '../lib/security.js';
import { sessionManager, checkCsrf, publicBaseUrl } from '../lib/sessions.js';
import { t } from '../lib/i18n.js';
import {
  effectiveStatus, setCookServices, setServedAreas, servedAreaIds, logAdminAction, latestSubscription, activateSubscription,
  renewSubscription, setSubscriptionStatus, updateSubscriptionFields, ratingsFor, cookStats,
  PLAN_KEYS, PAYMENT_STATUSES, SUBSCRIPTION_STATUSES,
} from '../services/cooks.js';
import { SERVICE_TYPES, DISTRICTS } from '../db/seed-data.js';
import { sendPhoto, redirect } from './public.js';
import { normalizeName } from '../../public/assets/normalize.js';
import { isValidLatLng } from '../lib/geo.js';
import { baseLocale } from '../lib/i18n.js';
import { newChallenge, rpFromRequest, verifyRegistration, verifyAssertion, b64url } from '../lib/webauthn.js';
import { exportToFiles, importFromFiles } from '../lib/portability.js';
import { createZip, readZip } from '../lib/zip.js';
import { LAYOUTS, FONT_SCALES, COLOR_KEYS, isColor, SIZE_KEYS, SIZES, LOGO_PRESETS, BG_PRESETS, UI_SHAPES, UI_COLOR_KEYS } from '../services/theme.js';
import { KEY_RE, activeKinds, cleanCategories } from '../services/categories.js';
import { geoapifyGet } from '../services/geoapify.js';
import { translateText } from '../services/translate.js';
import { migratePhotos, storageCounts } from '../services/photoMigration.js';
import { findPlaceAndShops, findRegionShops } from '../services/mapImport.js';
import { newCode, creditReferral } from '../services/referrals.js';
import { computeFingerprint, ROOT } from '../lib/fingerprint.js';
import { readdirSync, readFileSync as rfs, statSync } from 'node:fs';
import { join as pjoin, relative as prel } from 'node:path';
import { randomToken, sha256 as sha256hex, hmacHex } from '../lib/security.js';
import { overpassCountryPlaces, savePlaces } from '../services/osm.js';

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';

export async function createAdminUser(db, username, password) {
  const name = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.\-]{3,40}$/.test(name)) throw new Error('Username: 3-40 chars, letters/digits/._-');
  if (String(password || '').length < 10) throw new Error('Password must be at least 10 characters');
  const hash = await hashPassword(password);
  const existing = await db.one('SELECT id FROM admin_users WHERE LOWER(username) = $1', [name]);
  if (existing) {
    await db.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hash, existing.id]);
    await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [existing.id]);
    return { id: existing.id, updated: true };
  }
  const row = await db.one('INSERT INTO admin_users (username, password_hash) VALUES ($1,$2) RETURNING id', [name, hash]);
  return { id: row.id, updated: false };
}

// Easy to read aloud / type on a phone: no 0/O, 1/l/I.
function generatePassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz', digits = '23456789';
  let p = '';
  for (let i = 0; i < 4; i++) p += letters[randomInt(letters.length)];
  for (let i = 0; i < 4; i++) p += digits[randomInt(digits.length)];
  return p;
}

export const BANNER_PLACEMENTS = ['home_top', 'home_middle', 'home_bottom', 'results_top', 'browse_top', 'cook_page', 'join_top'];

export function adminRoutes({ db, cfg, limiters, areas, images, channel, cache, settings, geo, storage }) {
  const sessions = sessionManager({ db, cfg, table: 'admin_sessions', cookie: 'st_admin', ownerColumn: 'admin_id', hours: 12 });

  const AGENT_ROUTES = [
    ['GET', /^\/api\/admin\/(me|stats|settings)$/], ['GET', /^\/api\/admin\/cooks$/],
    ['GET', /^\/api\/admin\/cooks\/(\d+)(\/photo)?$/], ['GET', /^\/api\/admin\/photos\/(\d+)\.jpg$/],
    ['POST', /^\/api\/admin\/cooks\/(\d+)\/(approve|reject)$/], ['POST', /^\/api\/admin\/cooks\/(\d+)\/subscription\/(activate|renew|suspend|expire|trial)$/],
    ['DELETE', /^\/api\/admin\/cooks\/(\d+)$/],
    ['GET', /^\/api\/admin\/referrers$/], ['POST', /^\/api\/admin\/referrers$/], ['GET', /^\/api\/admin\/referrers\/(\d+)\/earnings$/],
  ];
  async function agentGate(req, admin) {
    const u = new URL(req.url, 'http://x');
    const hit = AGENT_ROUTES.find(([mth, re]) => mth === req.method && re.test(u.pathname));
    if (!hit || !admin.country) throw new HttpError(403, 'owner_only');
    const cookId = u.pathname.match(/^\/api\/admin\/cooks\/(\d+)/)?.[1];
    if (cookId) {
      const c = await db.one('SELECT country FROM cooks WHERE id = $1', [Number(cookId)]);
      if (c && String(c.country || '').toUpperCase() !== admin.country) throw new HttpError(403, 'other_country');
    }
    const refId = u.pathname.match(/^\/api\/admin\/referrers\/(\d+)/)?.[1];
    if (refId) {
      const r = await db.one('SELECT country FROM referrers WHERE id = $1', [Number(refId)]);
      if (r && String(r.country || '').toUpperCase() !== admin.country) throw new HttpError(403, 'other_country');
    }
    if (u.pathname === '/api/admin/referrers') { u.searchParams.set('country', admin.country); req.url = u.pathname + u.search; req.agentCountry = admin.country; }
    const ph = u.pathname.match(/^\/api\/admin\/photos\/(\d+)\.jpg$/)?.[1];
    if (ph) {
      const c = await db.one('SELECT c.country FROM cook_photos p JOIN cooks c ON c.id = p.cook_id WHERE p.id = $1', [Number(ph)]);
      if (c && String(c.country || '').toUpperCase() !== admin.country) throw new HttpError(403, 'other_country');
    }
    // lists and numbers: always his own country, whatever the page asks
    if (/^\/api\/admin\/(cooks|stats)$/.test(u.pathname)) { u.searchParams.set('country', admin.country); req.url = u.pathname + u.search; }
  }

  const guard = (fn) => async (req, res, m) => {
    const adminId = await sessions.ownerId(req);
    if (!adminId) throw new HttpError(401, 'unauthorized');
    if (req.method !== 'GET') checkCsrf(req);
    const admin = await db.one('SELECT id, username, role, country FROM admin_users WHERE id = $1 AND disabled = 0', [adminId]);
    if (!admin) throw new HttpError(401, 'unauthorized');
    // A country agent may only: see join requests and subscribers, approve/reject, activate/renew/stop subscriptions,
    // give a trial and delete — in his own country. Everything else is the owner's. Enforced here, on the server.
    if (admin.role === 'agent') await agentGate(req, admin);
    const rl = await limiters.admin.take(`a${admin.id}`);
    if (!rl.ok) throw new HttpError(429, 'rate_limited', { retryAfterSec: rl.retryAfterSec });
    return fn(req, res, m, admin);
  };

  /** Ad end date: 'YYYY-MM-DD' (end of that day) or a full ISO time; empty = no end. */
  function bannerExpiry(value, v) {
    if (value === undefined || value === null || value === '') return null;
    const sv = String(value);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(sv) ? new Date(`${sv}T23:59:59`) : new Date(sv);
    if (Number.isNaN(d.getTime())) { v.fail('expiresAt', 'invalid'); return null; }
    return d.toISOString();
  }

  // one photo move at a time (per server); progress kept for the status panel
  const photoMove = { running: false, progress: null, lastResult: null, error: null };

  /** The site's full address for links people share (PUBLIC_BASE_URL, else the address this request came to). */
  const siteUrl = (req) => cfg.publicBaseUrl || `${String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()}://${String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()}`;

  async function logLogin(req, { adminId = null, username = null, ok, method }) {
    await db.query('INSERT INTO admin_logins (admin_id, username, ok, method, ip_hash, user_agent) VALUES ($1,$2,$3,$4,$5,$6)',
      [adminId, username ? String(username).slice(0, 60) : null, ok ? 1 : 0, method,
        hmacHex(cfg.sessionSecret, clientIp(req, cfg.trustProxy)).slice(0, 16), String(req.headers['user-agent'] || '').slice(0, 200)]).catch(() => {});
  }
  /** One-time challenge by token (login) — expired/unknown tokens are refused. */
  async function takeChallenge(token, kind, { keep = false } = {}) {
    const row = await db.one('SELECT id, admin_id, challenge, expires_at FROM admin_auth_challenges WHERE token_hash = $1 AND kind = $2',
      [sha256hex(String(token || '')), kind]);
    if (!row || Number(row.expires_at) < Date.now()) throw new HttpError(401, 'login_expired');
    if (!keep) await db.query('DELETE FROM admin_auth_challenges WHERE id = $1', [row.id]);
    return row;
  }

  async function loadCook(id) {
    const cook = await db.one(
      `SELECT c.id, c.full_name, c.whatsapp, c.area_id, c.area_label, c.lat, c.lng, c.bio, c.is_hidden, c.country, c.region_name, c.kind, c.specialty, c.locale, c.location_accuracy_m, c.location_at, c.addr_city, c.addr_district, c.addr_locality, c.service_radius_km, c.requested_plan, c.status, c.admin_notes,
         c.created_at, c.updated_at, c.photo_url, CASE WHEN c.photo IS NULL AND c.photo_url IS NULL THEN 0 ELSE 1 END AS has_photo,
         CASE WHEN c.password_hash IS NULL THEN 0 ELSE 1 END AS has_password
       FROM cooks c WHERE c.id = $1`, [id]);
    if (!cook) throw new HttpError(404, 'not_found');
    const services = (await db.query(
      `SELECT st.key FROM cook_service_types cst JOIN service_types st ON st.id = cst.service_type_id WHERE cst.cook_id = $1 ORDER BY st.sort_order`,
      [id])).map((r) => r.key);
    const sub = await latestSubscription(db, id);
    const served = (await servedAreaIds(db, id)).map((aid) => areas.view(areas.get(aid))).filter(Boolean);
    const warnings = await db.query('SELECT id, message, created_at FROM cook_warnings WHERE cook_id = $1 ORDER BY created_at DESC', [id]);
    const photos = await db.query('SELECT id, caption, url, is_hidden, created_at FROM cook_photos WHERE cook_id = $1 ORDER BY created_at DESC', [id]);
    const reviews = await db.query('SELECT id, rating, is_hidden, created_at FROM reviews WHERE cook_id = $1 ORDER BY created_at DESC LIMIT 100', [id]);
    const feedback = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM feedback WHERE cook_id = $1`, [id]);
    const stats = await cookStats(db, id);
    return {
      ...cook,
      services,
      servedAreas: served,
      subscription: sub,
      effectiveStatus: effectiveStatus(cook, sub),
      stats: { ...stats, impressions: stats.impressions_total, whatsapp_clicks: stats.whatsapp_total },
      warnings,
      photos: photos.map((p) => ({ id: p.id, caption: p.caption || '', hidden: !!p.is_hidden, url: p.url || `/api/admin/photos/${p.id}.jpg` })),
      feedbackCount: feedback.n,
      reviews: reviews.map((r) => ({ id: r.id, rating: r.rating, hidden: !!Number(r.is_hidden), createdAt: r.created_at })),
      menu: (await db.query('SELECT id, name, price, currency, is_available FROM menu_items WHERE cook_id = $1 ORDER BY sort_order, id', [id]))
        .map((x) => ({ id: x.id, name: x.name, price: x.price == null ? null : Number(x.price), currency: x.currency, available: !!Number(x.is_available) })),
      unreadSupport: Number((await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM support_messages WHERE cook_id = $1 AND from_admin = 0 AND read_by_admin = 0', [id])).n),
    };
  }

  function readCookFields(body, v, { partial }) {
    const out = {};
    if (!partial || body.fullName !== undefined) out.full_name = v.text('fullName', body.fullName, { min: 2, max: 80 });
    if (!partial || body.whatsapp !== undefined) {
      const raw = v.text('whatsapp', body.whatsapp, { min: 6, max: 25 });
      out.whatsapp = raw ? normalizePhone(raw, cfg.defaultCountry) : undefined;
      if (raw && !out.whatsapp) v.fail('whatsapp', 'invalid_phone');
    }
    if (!partial || body.areaId !== undefined) {
      const area = areas.get(body.areaId);
      if (!area) v.fail('areaId', body.areaId ? 'invalid' : 'required');
      else out.area = area;
    }
    if (body.lat !== undefined && body.lat !== null && body.lat !== '') out.lat = v.number('lat', body.lat, { min: -90, max: 90 });
    if (body.lng !== undefined && body.lng !== null && body.lng !== '') out.lng = v.number('lng', body.lng, { min: -180, max: 180 });
    if (body.bio !== undefined) out.bio = v.text('bio', body.bio, { max: 300, required: false, multiline: true });
    if (body.adminNotes !== undefined) out.admin_notes = v.text('adminNotes', body.adminNotes, { max: 1000, required: false, multiline: true });
    if (body.photo !== undefined) out.photo = validatePhoto(body.photo, v);
    if (!partial) out.kind = activeKinds(settings.get().categories).includes(body.kind) ? body.kind : 'cook';
    if (body.specialty !== undefined) out.specialty = v.text('specialty', body.specialty, { max: 120, required: false }) || null;
    if (!partial || body.services !== undefined) {
      const s = Array.isArray(body.services) ? [...new Set(body.services)].filter((x) => SERVICE_TYPES.includes(x)) : [];
      // service types are optional for every category now
      out.services = s;
    }
    if (!partial || body.servedAreaIds !== undefined) {
      const ids = Array.isArray(body.servedAreaIds) ? [...new Set(body.servedAreaIds.map(Number))].filter((id) => areas.get(id)) : [];
      if (!ids.length) v.fail('servedAreaIds', 'pick_one_area');
      out.servedAreaIds = ids;
    }
    return out;
  }

  /** Column values for the cooks table from validated fields. Moving her village moves her map point unless lat/lng given. */
  function cookColumns(f, current) {
    const cols = {};
    for (const k of ['full_name', 'whatsapp', 'bio', 'photo', 'photo_url', 'admin_notes', 'specialty']) if (f[k] !== undefined) cols[k] = f[k];
    if (f.full_name !== undefined) cols.name_norm = normalizeName(f.full_name);
    if (f.area) {
      cols.area_id = f.area.id;
      cols.area_label = f.area.name_ar;
      if (f.lat === undefined && (!current || current.area_id !== f.area.id)) { cols.lat = f.area.lat; cols.lng = f.area.lng; }
    }
    if (f.lat !== undefined) cols.lat = roundTo(f.lat, 5);
    if (f.lng !== undefined) cols.lng = roundTo(f.lng, 5);
    return cols;
  }

  /** Country + region columns for a location (automatic, any country). */
  async function placeColumns(lat, lng) {
    if (lat == null || lng == null || !geo) return {};
    const p = await geo.resolve(Number(lat), Number(lng));
    if (!p.country) return {};
    return { country: p.country, region_key: p.regionKey || null, region_name: p.regionName || null, region_name_ar: p.regionNameAr || null, region_name_en: p.regionNameEn || null };
  }

  function readSubFields(body, v, { requirePlan = true } = {}) {
    return {
      plan: v.oneOf('plan', body.plan, PLAN_KEYS, { required: requirePlan }),
      startDate: v.date('startDate', body.startDate, { required: false }),
      expiryDate: v.date('expiryDate', body.expiryDate, { required: false }),
      paymentStatus: v.oneOf('paymentStatus', body.paymentStatus, PAYMENT_STATUSES, { required: false }),
    };
  }
  const subError = (e) => {
    if (e.code === 'expiry_before_start') throw new HttpError(422, 'validation_failed', { fields: { expiryDate: 'expiry_before_start' } });
    throw e;
  };
  const ensureCook = async (id) => { if (!(await db.one('SELECT id FROM cooks WHERE id = $1', [id]))) throw new HttpError(404, 'not_found'); };

  return [
    // Step 1: username + password. If the admin requires a passkey, no session yet: a short-lived token for step 2.
    ['POST', /^\/api\/admin\/login$/, async (req, res) => {
      const r = await limiters.login.take('admin:' + clientIp(req, cfg.trustProxy));
      if (!r.ok) throw new HttpError(429, 'rate_limited', { retryAfterSec: r.retryAfterSec });
      checkCsrf(req);
      const body = await readJson(req, 4 * 1024);
      const username = String(body.username || '').trim().toLowerCase().replace(/\s+/g, '.');
      const user = await db.one('SELECT id, password_hash, mfa_required FROM admin_users WHERE LOWER(username) = $1 AND disabled = 0', [username]);
      const ok = await verifyPassword(String(body.password || ''), user?.password_hash || DUMMY_HASH);
      if (!user || !ok) {
        await logLogin(req, { adminId: user?.id || null, username, ok: false, method: 'password' });
        throw new HttpError(401, 'invalid_credentials');
      }
      if (Number(user.mfa_required)) {
        const token = randomToken(24);
        const challenge = newChallenge();
        await db.query('DELETE FROM admin_auth_challenges WHERE expires_at < $1', [Date.now()]);
        await db.query('INSERT INTO admin_auth_challenges (token_hash, admin_id, kind, challenge, expires_at) VALUES ($1,$2,$3,$4,$5)',
          [sha256hex(token), user.id, 'login', challenge, Date.now() + 5 * 60_000]);
        const creds = await db.query('SELECT credential_id FROM admin_passkeys WHERE admin_id = $1', [user.id]);
        const { rpId } = rpFromRequest(req, cfg);
        await logLogin(req, { adminId: user.id, username, ok: true, method: 'password_step' });
        return sendJson(res, 200, { mfa: true, token, options: {
          challenge, rpId, timeout: 120000, userVerification: 'required',
          allowCredentials: creds.map((c) => ({ type: 'public-key', id: c.credential_id })),
        } });
      }
      await db.query('UPDATE admin_users SET last_login_at = $1 WHERE id = $2', [new Date().toISOString(), user.id]);
      await logLogin(req, { adminId: user.id, username, ok: true, method: 'password' });
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': await sessions.create(user.id) });
    }],

    // Step 2a: Face ID / fingerprint (passkey).
    ['POST', /^\/api\/admin\/login\/passkey$/, async (req, res) => {
      const r = await limiters.login.take('admin2:' + clientIp(req, cfg.trustProxy));
      if (!r.ok) throw new HttpError(429, 'rate_limited', { retryAfterSec: r.retryAfterSec });
      checkCsrf(req);
      const body = await readJson(req, 16 * 1024);
      const pending = await takeChallenge(body.token, 'login');
      const stored = await db.one('SELECT id, public_key, alg, sign_count FROM admin_passkeys WHERE admin_id = $1 AND credential_id = $2',
        [pending.admin_id, String(body.credential?.id || '')]);
      if (!stored) { await logLogin(req, { adminId: pending.admin_id, ok: false, method: 'passkey' }); throw new HttpError(401, 'invalid_credentials'); }
      let result;
      try {
        result = verifyAssertion(body.credential, { publicKeyJwk: JSON.parse(stored.public_key), alg: Number(stored.alg), signCount: Number(stored.sign_count) },
          { challenge: pending.challenge, ...rpFromRequest(req, cfg) });
      } catch (err) {
        await logLogin(req, { adminId: pending.admin_id, ok: false, method: 'passkey' });
        throw new HttpError(401, 'invalid_credentials');
      }
      await db.query('UPDATE admin_passkeys SET sign_count = $1, last_used_at = $2 WHERE id = $3', [result.signCount, new Date().toISOString(), stored.id]);
      await db.query('UPDATE admin_users SET last_login_at = $1 WHERE id = $2', [new Date().toISOString(), pending.admin_id]);
      await logLogin(req, { adminId: pending.admin_id, ok: true, method: 'passkey' });
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': await sessions.create(pending.admin_id) });
    }],

    // Step 2b: a one-time backup code (phone lost / another computer without the phone).
    ['POST', /^\/api\/admin\/login\/backup$/, async (req, res) => {
      const r = await limiters.login.take('admin2:' + clientIp(req, cfg.trustProxy));
      if (!r.ok) throw new HttpError(429, 'rate_limited', { retryAfterSec: r.retryAfterSec });
      checkCsrf(req);
      const body = await readJson(req, 2 * 1024);
      const pending = await takeChallenge(body.token, 'login', { keep: true });
      const code = String(body.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const rows = await db.query('SELECT id, code_hash FROM admin_backup_codes WHERE admin_id = $1 AND used_at IS NULL', [pending.admin_id]);
      let hit = null;
      for (const row of rows) if (code.length === 8 && await verifyPassword(code, row.code_hash)) { hit = row; break; }
      if (!hit) { await logLogin(req, { adminId: pending.admin_id, ok: false, method: 'backup_code' }); throw new HttpError(401, 'invalid_credentials'); }
      await db.query('UPDATE admin_backup_codes SET used_at = $1 WHERE id = $2', [new Date().toISOString(), hit.id]);
      await db.query('DELETE FROM admin_auth_challenges WHERE token_hash = $1', [sha256hex(String(body.token))]);
      await logLogin(req, { adminId: pending.admin_id, ok: true, method: 'backup_code' });
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': await sessions.create(pending.admin_id) });
    }],

    ['POST', /^\/api\/admin\/logout$/, async (req, res) => {
      checkCsrf(req);
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': await sessions.destroy(req) });
    }],

    ['GET', /^\/api\/admin\/me$/, guard(async (req, res, m, admin) => {
      sendJson(res, 200, { username: admin.username, role: admin.role || 'owner', country: admin.country || null, adminWhatsappConfigured: !!cfg.adminWhatsapp });
    })],

    ['GET', /^\/api\/admin\/stats$/, guard(async (req, res, m, admin) => {
      // one country (the owner's country view, or always for a country agent)
      const onlyCountry = String(new URL(req.url, 'http://x').searchParams.get('country') || '').toUpperCase();
      if (/^[A-Z]{2}$/.test(onlyCountry)) {
        const nowIso = new Date().toISOString();
        const rows = await db.query(
          `SELECT COALESCE(c.kind, 'cook') AS kind,
                  CAST(SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS INTEGER) AS pending,
                  CAST(SUM(CASE WHEN c.status = 'approved' AND EXISTS (SELECT 1 FROM subscriptions x WHERE x.cook_id = c.id AND x.status = 'active'
                    AND x.start_date <= $1 AND x.expiry_date > $1) THEN 1 ELSE 0 END) AS INTEGER) AS active,
                  CAST(COUNT(*) AS INTEGER) AS total
             FROM cooks c WHERE c.country = $2 GROUP BY COALESCE(c.kind, 'cook')`, [nowIso, onlyCountry]);
        const byKind = Object.fromEntries(rows.map((r) => [r.kind, { pending: Number(r.pending), active: Number(r.active), total: Number(r.total) }]));
        const sum = (k) => Object.values(byKind).reduce((a, x) => a + x[k], 0);
        const byCountry = Object.fromEntries((await db.query(`SELECT COALESCE(country, 'LB') AS c, CAST(COUNT(*) AS INTEGER) AS n FROM cooks GROUP BY COALESCE(country, 'LB')`)).filter((r) => r.c).map((r) => [r.c, Number(r.n)]));
        return sendJson(res, 200, { country: onlyCountry, by_country: admin?.role === 'agent' ? undefined : byCountry, by_kind: byKind, active_cooks: sum('active'), pending_applications: sum('pending'),
          searches_30d: 0, searches_total: 0, whatsapp_clicks_30d: 0, whatsapp_clicks_total: 0, empty_searches_30d: 0,
          new_feedback: 0, new_support: 0, pending_ads: 0, new_messages: 0 });
      }
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const now = new Date().toISOString();
      const s = await db.one(
        `SELECT
          (SELECT CAST(COUNT(*) AS INTEGER) FROM requests WHERE created_at >= $1) AS searches_30d,
          (SELECT CAST(COUNT(*) AS INTEGER) FROM requests) AS searches_total,
          (SELECT CAST(COUNT(*) AS INTEGER) FROM request_contact_events WHERE created_at >= $1) AS whatsapp_clicks_30d,
          (SELECT CAST(COUNT(*) AS INTEGER) FROM request_contact_events) AS whatsapp_clicks_total,
          (SELECT CAST(COUNT(*) AS INTEGER) FROM requests WHERE created_at >= $1 AND results_count = 0) AS empty_searches_30d,
          (SELECT CAST(COUNT(*) AS INTEGER) FROM cooks c WHERE c.kind = 'cook' AND c.status = 'approved' AND EXISTS (SELECT 1 FROM subscriptions s
             WHERE s.cook_id = c.id AND s.status = 'active' AND s.start_date <= $2 AND s.expiry_date > $2)) AS active_cooks,
          (SELECT CAST(COUNT(*) AS INTEGER) FROM cooks c WHERE c.kind = 'restaurant' AND c.status = 'approved' AND EXISTS (SELECT 1 FROM subscriptions s
             WHERE s.cook_id = c.id AND s.status = 'active' AND s.start_date <= $2 AND s.expiry_date > $2)) AS active_restaurants,
          (SELECT CAST(COUNT(*) AS INTEGER) FROM cooks WHERE status = 'pending' AND kind = 'cook') AS pending_applications,
          (SELECT CAST(COUNT(*) AS INTEGER) FROM cooks WHERE status = 'pending' AND kind = 'restaurant') AS pending_restaurants,
          (SELECT CAST(COUNT(*) AS INTEGER) FROM feedback WHERE status = 'new') AS new_feedback,
          (SELECT CAST(COUNT(DISTINCT cook_id) AS INTEGER) FROM support_messages WHERE from_admin = 0 AND read_by_admin = 0) AS new_support`, [since, now]);
      // counts per category (tabs of the admin panel)
      const rows = await db.query(
        `SELECT COALESCE(c.kind, 'cook') AS kind,
                CAST(SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS INTEGER) AS pending,
                CAST(SUM(CASE WHEN c.status = 'approved' AND EXISTS (SELECT 1 FROM subscriptions x WHERE x.cook_id = c.id AND x.status = 'active'
                  AND x.start_date <= $1 AND x.expiry_date > $1) THEN 1 ELSE 0 END) AS INTEGER) AS active,
                CAST(COUNT(*) AS INTEGER) AS total
           FROM cooks c GROUP BY COALESCE(c.kind, 'cook')`, [now]);
      s.by_kind = Object.fromEntries(rows.map((r) => [r.kind, { pending: Number(r.pending), active: Number(r.active), total: Number(r.total) }]));
      s.pending_ads = (await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM banners WHERE status = 'pending'`)).n;
      s.new_messages = (await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM site_messages WHERE read_at IS NULL')).n;
      s.by_country = Object.fromEntries((await db.query(`SELECT COALESCE(country, 'LB') AS c, CAST(COUNT(*) AS INTEGER) AS n FROM cooks GROUP BY COALESCE(country, 'LB')`)).filter((r) => r.c).map((r) => [r.c, Number(r.n)]));
      sendJson(res, 200, s);
    })],

    // Paginated & filtered in SQL, so it stays fast with thousands of cooks.
    ['GET', /^\/api\/admin\/cooks$/, guard(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const filter = url.searchParams.get('filter') || 'all';
      const q = (url.searchParams.get('q') || '').trim();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const now = new Date().toISOString();
      const where = [];
      const params = [];
      const add = (v) => { params.push(v); return `$${params.length}`; };
      const byFilter = {
        pending: () => `c.status = 'pending'`,
        // separate lists: ✓ verified (paid) & active · imported (not paid) & active · active subscribers without the imported ones
        imported: () => { const t = add(now); return `c.source = 'map' AND c.status = 'approved' AND s.status = 'active' AND s.start_date <= ${t} AND s.expiry_date > ${t}`; },
        verified: () => { const t = add(now); return `c.verified = 1 AND COALESCE(c.source, '') <> 'map' AND c.status = 'approved' AND s.status = 'active' AND s.start_date <= ${t} AND s.expiry_date > ${t}`; },
        rejected: () => `c.status = 'rejected'`,
        active: () => { const t = add(now); return `COALESCE(c.source, '') <> 'map' AND c.status = 'approved' AND s.status = 'active' AND s.start_date <= ${t} AND s.expiry_date > ${t}`; },
        expired: () => { const t = add(now); return `c.status <> 'rejected' AND (s.status = 'expired' OR (s.status = 'active' AND s.expiry_date <= ${t}))`; },
        suspended: () => `c.status <> 'rejected' AND s.status = 'suspended'`,
        no_subscription: () => `c.status = 'approved' AND s.id IS NULL`,
        hidden: () => `c.is_hidden = 1`,
      };
      if (byFilter[filter]) where.push(byFilter[filter]());
      const kindF = url.searchParams.get('kind');
      if (KEY_RE.test(kindF || '') && !q) where.push(`c.kind = ${add(kindF)}`);   // searching by name/number: all categories, even deleted ones
      const onlyCountry = (url.searchParams.get('country') || '').toUpperCase();
      if (/^[A-Z]{2}$/.test(onlyCountry)) where.push(`COALESCE(c.country, 'LB') = ${add(onlyCountry)}`);
      if (q) {
        const digits = q.replace(/\D/g, '');
        const n = add(`%${normalizeName(q).replace(/[%_]/g, '')}%`);
        const alt = [`c.name_norm LIKE ${n}`, `c.area_label LIKE ${add(`%${q.replace(/[%_]/g, '')}%`)}`];
        if (digits.length >= 3) alt.push(`c.whatsapp LIKE ${add(`%${digits}%`)}`);
        where.push(`(${alt.join(' OR ')})`);
      }
      const from = `FROM cooks c LEFT JOIN subscriptions s ON s.id = (SELECT MAX(id) FROM subscriptions WHERE cook_id = c.id)
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
      const total = (await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n ${from}`, params)).n;
      const rows = await db.query(
        `SELECT c.id, c.full_name, c.whatsapp, c.area_label, c.status, c.created_at, c.requested_plan, c.is_hidden, c.verified, c.source, c.country, c.region_name, c.kind,
           s.id AS sub_id, s.plan, s.status AS sub_status, s.payment_status, s.start_date, s.expiry_date,
           (SELECT CAST(COUNT(*) AS INTEGER) FROM request_impressions i WHERE i.cook_id = c.id) AS impressions,
           (SELECT CAST(COUNT(*) AS INTEGER) FROM request_contact_events e WHERE e.cook_id = c.id) AS whatsapp_clicks,
           (SELECT CAST(COUNT(*) AS INTEGER) FROM cook_warnings w WHERE w.cook_id = c.id) AS warnings,
           (SELECT CAST(COUNT(*) AS INTEGER) FROM feedback f WHERE f.cook_id = c.id AND f.status = 'new') AS open_feedback
         ${from} ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit} OFFSET ${offset}`, params);
      const ratings = await ratingsFor(db, rows.map((r) => r.id));
      const nowD = new Date();
      const list = rows.map((r) => {
        const sub = r.sub_id ? { status: r.sub_status, start_date: r.start_date, expiry_date: r.expiry_date } : null;
        return {
          id: r.id, fullName: r.full_name, whatsapp: r.whatsapp, area: r.area_label,
          cookStatus: r.status, requestedPlan: r.requested_plan, createdAt: r.created_at, hidden: !!Number(r.is_hidden), country: r.country || null, region: r.region_name || null, kind: r.kind || 'cook',
          plan: r.plan, subscriptionStatus: r.sub_status, paymentStatus: r.payment_status,
          startDate: r.start_date, expiryDate: r.expiry_date,
          effectiveStatus: effectiveStatus(r, sub, nowD),
          impressions: r.impressions, whatsappClicks: r.whatsapp_clicks, verified: !!Number(r.verified || 0), imported: r.source === 'map', warnings: r.warnings, openFeedback: r.open_feedback,
          rating: ratings.get(r.id),
        };
      });
      sendJson(res, 200, { cooks: list, total, offset, limit, hasMore: offset + list.length < total });
    })],

    ['GET', /^\/api\/admin\/cooks\/(\d+)$/, guard(async (req, res, m) => {
      sendJson(res, 200, await loadCook(Number(m[1])));
    })],

    ['GET', /^\/api\/admin\/cooks\/(\d+)\/photo$/, guard(async (req, res, m) => {
      const c = await db.one('SELECT photo, photo_url FROM cooks WHERE id = $1', [Number(m[1])]);
      if (c?.photo_url) return redirect(res, c.photo_url);
      sendPhoto(res, c?.photo);
    })],

    ['POST', /^\/api\/admin\/cooks$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 256 * 1024);
      const v = new Validator();
      const f = readCookFields(body, v, { partial: false });
      const activate = body.activate ? readSubFields(body.activate, v) : null;
      v.assert();
      if (f.photo !== undefined) { const img = await images.save('cooks', f.photo); f.photo = img.data; f.photo_url = img.url; }
      const c = cookColumns(f, null);
      Object.assign(c, await placeColumns(c.lat, c.lng));
      if (c.country && body.whatsapp) { const w = normalizePhone(body.whatsapp, c.country); if (w) c.whatsapp = w; }
      const id = await db.tx(async (q) => {
        const row = await q.one(
          `INSERT INTO cooks (full_name, whatsapp, area_id, area_label, lat, lng, service_radius_km, bio, photo, admin_notes, requested_plan, status, photo_url, name_norm,
             country, region_key, region_name, region_name_ar, region_name_en, kind, specialty)
           VALUES ($1,$2,$3,$4,$5,$6,$11,$7,$8,$9,$10,'approved',$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
          [c.full_name, c.whatsapp, c.area_id, c.area_label, c.lat, c.lng, c.bio ?? null, c.photo ?? null, c.admin_notes ?? null, activate?.plan ?? null, 0,
            c.photo_url ?? null, c.name_norm, c.country || areas.get(c.area_id)?.country || cfg.defaultCountry, c.region_key ?? null, c.region_name ?? null, c.region_name_ar ?? null, c.region_name_en ?? null,
            f.kind || 'cook', c.specialty ?? null]);
        await setCookServices(q, row.id, f.services);
        await setServedAreas(q, row.id, f.servedAreaIds);
        return row.id;
      });
      if (activate) {
        await activateSubscription(db, id, { ...activate, paymentStatus: activate.paymentStatus || 'paid' }).catch(subError);
        if ((activate.paymentStatus || 'paid') === 'paid') { await db.query('UPDATE cooks SET verified = 1 WHERE id = $1', [id]); await creditReferral(db, id, 'activate'); }   // same rule everywhere: paid = ✓
      }
      await logAdminAction(db, admin.id, id, 'create', { activate: !!activate });
      sendJson(res, 201, await loadCook(id));
    })],

    ['PATCH', /^\/api\/admin\/cooks\/(\d+)$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      const current = await loadCook(id);
      const body = await readJson(req, 256 * 1024);
      const v = new Validator();
      const f = readCookFields(body, v, { partial: true });
      v.assert();
      if (f.photo !== undefined) {
        const img = await images.save(`cooks/${id}`, f.photo);
        await images.remove(current.photo_url);
        f.photo = img.data; f.photo_url = img.url;
      }
      const cols = cookColumns(f, current);
      if (cols.lat !== undefined) Object.assign(cols, await placeColumns(cols.lat, cols.lng ?? current.lng));
      const keys = Object.keys(cols);
      if (keys.length) {
        await db.query(`UPDATE cooks SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = $${keys.length + 1} WHERE id = $${keys.length + 2}`,
          [...keys.map((k) => cols[k]), new Date().toISOString(), id]);
      }
      if (f.services) await setCookServices(db, id, f.services);
      if (f.servedAreaIds) await setServedAreas(db, id, f.servedAreaIds);
      await logAdminAction(db, admin.id, id, 'edit', { fields: [...keys, ...(f.services ? ['services'] : []), ...(f.servedAreaIds ? ['servedAreas'] : [])] });
      sendJson(res, 200, await loadCook(id));
    })],

    ['POST', /^\/api\/admin\/cooks\/(\d+)\/(approve|reject)$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await ensureCook(id);
      await db.query('UPDATE cooks SET status = $1, updated_at = $2 WHERE id = $3', [m[2] === 'approve' ? 'approved' : 'rejected', new Date().toISOString(), id]);
      await logAdminAction(db, admin.id, id, m[2]);
      sendJson(res, 200, await loadCook(id));
    })],

    // Sets (or generates) the cook's password and returns a ready WhatsApp message with her login details.
    // Hide an account from the whole public site (search, pages, photos, name search). Reversible.
    ['POST', /^\/api\/admin\/cooks\/(\d+)\/(hide|unhide)$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await ensureCook(id);
      await db.query('UPDATE cooks SET is_hidden = $1, updated_at = $2 WHERE id = $3', [m[2] === 'hide' ? 1 : 0, new Date().toISOString(), id]);
      await logAdminAction(db, admin.id, id, m[2]);
      cache?.clear?.('feed:');
      sendJson(res, 200, await loadCook(id));
    })],

    // Delete an account permanently: the cook, subscriptions, photos (also from storage), reviews, stats… everything.
    ['DELETE', /^\/api\/admin\/cooks\/(\d+)$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      const cook = await db.one('SELECT id, full_name, whatsapp, photo_url FROM cooks WHERE id = $1', [id]);
      if (!cook) throw new HttpError(404, 'not_found');
      const photoUrls = (await db.query('SELECT url FROM cook_photos WHERE cook_id = $1 AND url IS NOT NULL', [id])).map((r) => r.url);
      await db.tx(async (q) => { await q.query('DELETE FROM cooks WHERE id = $1', [id]); }); // cascades to every related table
      for (const u of [cook.photo_url, ...photoUrls]) await images.remove(u);
      await logAdminAction(db, admin.id, null, 'delete_account', { cookId: id, name: cook.full_name, whatsapp: cook.whatsapp });
      cache?.clear?.('feed:');
      sendJson(res, 200, { ok: true, deleted: id });
    })],

    ['POST', /^\/api\/admin\/cooks\/(\d+)\/password$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await ensureCook(id);
      const body = await readJson(req, 2 * 1024);
      const password = body.password ? String(body.password) : generatePassword();
      if (password.length < 6 || password.length > 100) throw new HttpError(422, 'validation_failed', { fields: { password: 'password_too_short' } });
      await db.query('UPDATE cooks SET password_hash = $1 WHERE id = $2', [await hashPassword(password), id]);
      await db.query('DELETE FROM cook_sessions WHERE cook_id = $1', [id]);
      const cook = await db.one('SELECT full_name, whatsapp, locale FROM cooks WHERE id = $1', [id]);
      const message = fillTemplate(t(cfg.locales.includes(cook.locale) ? cook.locale : 'ar', 'wa.cookLogin'), {
        name: cook.full_name, url: publicBaseUrl(req, cfg), phone: toLocalFormat(cook.whatsapp), password,
      });
      await logAdminAction(db, admin.id, id, 'set_password');
      sendJson(res, 200, { password, whatsappUrl: channel.link(cook.whatsapp, message) });
    })],

    ['POST', /^\/api\/admin\/cooks\/(\d+)\/warnings$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await ensureCook(id);
      const body = await readJson(req, 8 * 1024);
      const v = new Validator();
      const message = v.text('message', body.message, { min: 3, max: 1500, multiline: true });
      const feedbackId = v.int('feedbackId', body.feedbackId, { min: 1, required: false });
      v.assert();
      await db.query('INSERT INTO cook_warnings (cook_id, admin_id, feedback_id, message) VALUES ($1,$2,$3,$4)', [id, admin.id, feedbackId, message]);
      if (feedbackId) await db.query(`UPDATE feedback SET status = 'resolved', updated_at = $1 WHERE id = $2 AND cook_id = $3`, [new Date().toISOString(), feedbackId, id]);
      const cook = await db.one('SELECT whatsapp FROM cooks WHERE id = $1', [id]);
      await logAdminAction(db, admin.id, id, 'warning', { feedbackId });
      sendJson(res, 201, { whatsappUrl: channel.link(cook.whatsapp, message), cook: await loadCook(id) });
    })],

    ['POST', /^\/api\/admin\/cooks\/(\d+)\/subscription\/activate$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await ensureCook(id);
      const v = new Validator();
      const s = readSubFields(await readJson(req), v);
      v.assert();
      await activateSubscription(db, id, { ...s, paymentStatus: s.paymentStatus || 'paid' }).catch(subError);
      if ((s.paymentStatus || 'paid') === 'paid') { await creditReferral(db, id, 'activate'); await db.query('UPDATE cooks SET verified = 1 WHERE id = $1', [id]); }   // commission for the referral link, if any
      await logAdminAction(db, admin.id, id, 'activate', s);
      sendJson(res, 200, await loadCook(id));
    })],

    ['POST', /^\/api\/admin\/cooks\/(\d+)\/subscription\/renew$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await ensureCook(id);
      const body = await readJson(req);
      const v = new Validator();
      const plan = v.oneOf('plan', body.plan, PLAN_KEYS);
      const paymentStatus = v.oneOf('paymentStatus', body.paymentStatus, PAYMENT_STATUSES, { required: false });
      v.assert();
      await renewSubscription(db, id, { plan, paymentStatus: paymentStatus || 'paid' }).catch(subError);
      if ((paymentStatus || 'paid') === 'paid') await creditReferral(db, id, 'renew');   // commission on every paid renewal
      await logAdminAction(db, admin.id, id, 'renew', { plan });
      sendJson(res, 200, await loadCook(id));
    })],

    ['POST', /^\/api\/admin\/cooks\/(\d+)\/subscription\/(suspend|expire)$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await ensureCook(id);
      if (!(await setSubscriptionStatus(db, id, m[2] === 'suspend' ? 'suspended' : 'expired'))) throw new HttpError(409, 'no_subscription');
      await logAdminAction(db, admin.id, id, m[2]);
      sendJson(res, 200, await loadCook(id));
    })],

    ['PATCH', /^\/api\/admin\/cooks\/(\d+)\/subscription$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await ensureCook(id);
      const body = await readJson(req);
      const v = new Validator();
      const s = readSubFields(body, v, { requirePlan: false });
      s.status = v.oneOf('status', body.status, SUBSCRIPTION_STATUSES, { required: false }) ?? undefined;
      v.assert();
      const cur = await latestSubscription(db, id);
      if (!cur) throw new HttpError(409, 'no_subscription');
      const start = s.startDate || (cur.start_date && new Date(cur.start_date));
      const end = s.expiryDate || (cur.expiry_date && new Date(cur.expiry_date));
      if (start && end && end <= start) throw new HttpError(422, 'validation_failed', { fields: { expiryDate: 'expiry_before_start' } });
      await updateSubscriptionFields(db, id, {
        plan: s.plan ?? undefined, paymentStatus: s.paymentStatus ?? undefined,
        startDate: s.startDate ?? undefined, expiryDate: s.expiryDate ?? undefined, status: s.status,
      });
      await logAdminAction(db, admin.id, id, 'edit_subscription', body);
      sendJson(res, 200, await loadCook(id));
    })],

    /* ---------- admin account security: passkeys, backup codes, sign-in history ---------- */
    ['GET', /^\/api\/admin\/security$/, guard(async (req, res, m, admin) => {
      const me = await db.one('SELECT mfa_required FROM admin_users WHERE id = $1', [admin.id]);
      const keys = await db.query('SELECT id, name, created_at, last_used_at FROM admin_passkeys WHERE admin_id = $1 ORDER BY id', [admin.id]);
      const left = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM admin_backup_codes WHERE admin_id = $1 AND used_at IS NULL', [admin.id]);
      const logins = await db.query('SELECT ok, method, user_agent, created_at FROM admin_logins WHERE admin_id = $1 OR admin_id IS NULL ORDER BY id DESC LIMIT 30', [admin.id]);
      sendJson(res, 200, {
        mfaRequired: !!Number(me.mfa_required),
        passkeys: keys.map((k) => ({ id: k.id, name: k.name || '', createdAt: k.created_at, lastUsedAt: k.last_used_at })),
        backupCodesLeft: left.n,
        logins: logins.map((l) => ({ ok: !!Number(l.ok), method: l.method, device: l.user_agent || '', at: l.created_at })),
      });
    })],
    ['POST', /^\/api\/admin\/passkeys\/options$/, guard(async (req, res, m, admin) => {
      const challenge = newChallenge();
      await db.query('DELETE FROM admin_auth_challenges WHERE admin_id = $1 AND kind = $2', [admin.id, 'register']);
      await db.query('INSERT INTO admin_auth_challenges (token_hash, admin_id, kind, challenge, expires_at) VALUES ($1,$2,$3,$4,$5)',
        [null, admin.id, 'register', challenge, Date.now() + 5 * 60_000]);
      const existing = await db.query('SELECT credential_id FROM admin_passkeys WHERE admin_id = $1', [admin.id]);
      const { rpId } = rpFromRequest(req, cfg);
      sendJson(res, 200, {
        challenge, timeout: 120000, attestation: 'none',
        rp: { id: rpId, name: cfg.brand?.nameEn || 'Aklatak' },
        user: { id: b64url(Buffer.from(`admin-${admin.id}`)), name: admin.username, displayName: admin.username },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.credential_id })),
      });
    })],
    ['POST', /^\/api\/admin\/passkeys$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 32 * 1024);
      const ch = await db.one('SELECT id, challenge, expires_at FROM admin_auth_challenges WHERE admin_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1', [admin.id, 'register']);
      if (!ch || Number(ch.expires_at) < Date.now()) throw new HttpError(400, 'login_expired');
      await db.query('DELETE FROM admin_auth_challenges WHERE id = $1', [ch.id]);
      let reg;
      try { reg = verifyRegistration(body.credential, { challenge: ch.challenge, ...rpFromRequest(req, cfg) }); }
      catch { throw new HttpError(422, 'validation_failed', { fields: { passkey: 'invalid' } }); }
      const name = String(body.name || '').trim().slice(0, 40) || 'Passkey';
      await db.query('INSERT INTO admin_passkeys (admin_id, credential_id, public_key, alg, sign_count, name) VALUES ($1,$2,$3,$4,$5,$6)',
        [admin.id, reg.credentialId, JSON.stringify(reg.publicKeyJwk), reg.alg, reg.signCount, name]);
      await logAdminAction(db, admin.id, null, 'passkey_add', { name });
      sendJson(res, 201, { ok: true });
    })],
    ['DELETE', /^\/api\/admin\/passkeys\/(\d+)$/, guard(async (req, res, m, admin) => {
      const me = await db.one('SELECT mfa_required FROM admin_users WHERE id = $1', [admin.id]);
      const n = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM admin_passkeys WHERE admin_id = $1', [admin.id]);
      if (Number(me.mfa_required) && n.n <= 1) throw new HttpError(409, 'last_passkey');
      await db.query('DELETE FROM admin_passkeys WHERE id = $1 AND admin_id = $2', [Number(m[1]), admin.id]);
      await logAdminAction(db, admin.id, null, 'passkey_remove');
      sendJson(res, 200, { ok: true });
    })],
    // New set of 10 backup codes (shown once; the old ones stop working).
    ['POST', /^\/api\/admin\/backup-codes$/, guard(async (req, res, m, admin) => {
      const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
      const codes = Array.from({ length: 10 }, () => Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join(''));
      await db.query('DELETE FROM admin_backup_codes WHERE admin_id = $1', [admin.id]);
      for (const c of codes) await db.query('INSERT INTO admin_backup_codes (admin_id, code_hash) VALUES ($1,$2)', [admin.id, await hashPassword(c)]);
      await logAdminAction(db, admin.id, null, 'backup_codes_new');
      sendJson(res, 201, { codes: codes.map((c) => `${c.slice(0, 4)}-${c.slice(4)}`) });
    })],
    // Require a passkey at sign-in (only once there is a passkey AND backup codes — so you can never lock yourself out).
    ['POST', /^\/api\/admin\/mfa$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 1024);
      if (body.required) {
        const keys = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM admin_passkeys WHERE admin_id = $1', [admin.id]);
        const codes = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM admin_backup_codes WHERE admin_id = $1 AND used_at IS NULL', [admin.id]);
        if (!keys.n) throw new HttpError(409, 'need_passkey');
        if (!codes.n) throw new HttpError(409, 'need_backup_codes');
      }
      await db.query('UPDATE admin_users SET mfa_required = $1 WHERE id = $2', [body.required ? 1 : 0, admin.id]);
      await logAdminAction(db, admin.id, null, body.required ? 'mfa_on' : 'mfa_off');
      sendJson(res, 200, { ok: true, mfaRequired: !!body.required });
    })],

    /* ---------- one-tap full backup (code + data + docs) and restore into a NEW site ---------- */
    ['GET', /^\/api\/admin\/backup$/, guard(async (req, res, m, admin) => {
      const r = await limiters.login.take('backup:' + admin.id);
      if (!r.ok) throw new HttpError(429, 'rate_limited', { retryAfterSec: r.retryAfterSec });
      const fp = computeFingerprint();
      let version = '';
      try { version = JSON.parse(rfs(pjoin(ROOT, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
      const { files, manifest } = await exportToFiles(db, { appVersion: version, storageKind: images.external ? 's3' : 'db', fingerprint: fp.fingerprint });
      // the code itself, so the backup alone is enough to run the platform anywhere (no secrets: they live in env vars)
      const code = [];
      const walk = (p) => { let st; try { st = statSync(p); } catch { return; } if (st.isDirectory()) { for (const f of readdirSync(p)) if (!['node_modules', 'data', 'backups', '.git'].includes(f)) walk(pjoin(p, f)); } else code.push(p); };
      for (const part of ['src', 'public', 'admin-ui', 'locales', 'scripts', 'docs', 'test', 'package.json', 'package-lock.json', 'render.yaml', 'Dockerfile', '.dockerignore', 'docker-compose.yml', '.env.example', 'README.md']) walk(pjoin(ROOT, part));
      for (const f of code) files.push({ name: `code/${prel(ROOT, f).split('\\').join('/')}`, data: rfs(f) });
      files.push({ name: 'READ-ME-FIRST.txt', data: [
        `Aklatak full backup — ${manifest.exportedAt} — version ${version} — fingerprint ${fp.fingerprint}`,
        '', 'code/  : the whole platform (see code/docs/MIGRATION.md)', 'data/  : every table as JSON (users, cooks, restaurants, subscriptions, photos stored in the DB…)',
        '', 'Restore: deploy code/ anywhere (Render, Docker…), open the new admin panel, "Backup & restore" → upload this file.',
        'No passwords or keys are inside this file. Keep it private: it contains personal data.',
      ].join('\n') });
      const zip = createZip(files);
      await logAdminAction(db, admin.id, null, 'backup_download', { bytes: zip.length, rows: Object.values(manifest.counts).reduce((a, b) => a + b, 0) });
      res.writeHead(200, {
        'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="aklatak-backup-${manifest.exportedAt.slice(0, 10)}-v${version}.zip"`,
      });
      res.end(zip);
    })],
    // Only on an EMPTY site (no cooks/restaurants yet) — so a live platform can never be overwritten by mistake.
    ['POST', /^\/api\/admin\/restore$/, guard(async (req, res, m, admin) => {
      const existing = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cooks');
      if (existing.n > 0) throw new HttpError(409, 'restore_not_empty');
      const max = Number(cfg.maxRestoreBytes) || 300 * 1024 * 1024;
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > max) throw new HttpError(413, 'too_large'); chunks.push(c); }
      let entries;
      try { entries = readZip(Buffer.concat(chunks)); } catch { throw new HttpError(422, 'validation_failed', { fields: { backup: 'invalid' } }); }
      let result;
      try { result = await importFromFiles(db, entries); } catch (err) { throw new HttpError(422, 'validation_failed', { fields: { backup: 'invalid' } }); }
      await areas.load();
      await settings.load();
      cache?.clear?.('');
      const mismatch = Object.entries(result.expected).filter(([t, n]) => result.inserted[t] !== undefined && result.inserted[t] !== n);
      sendJson(res, 200, { ok: mismatch.length === 0, tables: result.tables.length, rows: Object.values(result.inserted).reduce((a, b) => a + b, 0), mismatch, restoredFrom: result.manifest.exportedAt });
    })],

    /* ---------- ads sent by businesses: approve (starts now, for the chosen duration) or reject ---------- */
    ['POST', /^\/api\/admin\/banners\/(\d+)\/approve$/, guard(async (req, res, m, admin) => {
      const b = await db.one('SELECT id, duration_days FROM banners WHERE id = $1', [Number(m[1])]);
      if (!b) throw new HttpError(404, 'not_found');
      const end = new Date(Date.now() + (Number(b.duration_days) || 30) * 864e5).toISOString();
      await db.query(`UPDATE banners SET status = 'active', is_active = 1, expires_at = $1 WHERE id = $2`, [end, b.id]);
      cache?.clear?.('feed:');
      await logAdminAction(db, admin.id, null, 'ad_approve', { id: b.id });
      sendJson(res, 200, { ok: true, expiresAt: end });
    })],
    ['POST', /^\/api\/admin\/banners\/(\d+)\/reject$/, guard(async (req, res, m, admin) => {
      await db.query(`UPDATE banners SET status = 'rejected', is_active = 0 WHERE id = $1`, [Number(m[1])]);
      cache?.clear?.('feed:');
      await logAdminAction(db, admin.id, null, 'ad_reject', { id: Number(m[1]) });
      sendJson(res, 200, { ok: true });
    })],

    /* ---------- photo storage: status + "move photos to R2" (runs in the background, safe to repeat) ---------- */
    ['GET', /^\/api\/admin\/storage$/, guard(async (req, res) => {
      let host = '';
      try { host = cfg.s3?.publicUrl ? new URL(cfg.s3.publicUrl).host : ''; } catch { /* ignore */ }
      sendJson(res, 200, { enabled: !!storage?.enabled, kind: storage?.kind || 'db', publicHost: host, counts: await storageCounts(db),
        running: photoMove.running, progress: photoMove.progress, lastResult: photoMove.lastResult, error: photoMove.error });
    })],
    ['POST', /^\/api\/admin\/storage\/migrate$/, guard(async (req, res, m, admin) => {
      if (!storage?.enabled) throw new HttpError(409, 'storage_not_configured');
      if (photoMove.running) return sendJson(res, 202, { started: false, running: true });
      Object.assign(photoMove, { running: true, progress: { moved: 0, avatars: 0, kept: 0 }, error: null });
      await logAdminAction(db, admin.id, null, 'photos_move_start');
      migratePhotos({ db, storage, onProgress: (p) => { photoMove.progress = p; } })
        .then((r) => { photoMove.lastResult = { ...r, at: new Date().toISOString() }; cache?.clear?.('feed:'); })
        .catch((e) => { photoMove.error = e.message; })
        .finally(() => { photoMove.running = false; });
      sendJson(res, 202, { started: true, running: true });
    })],

    /* ---------- export: every subscriber with subscription dates (opens in Excel / Google Sheets) ---------- */
    ['GET', /^\/api\/admin\/export\/subscribers\.csv$/, guard(async (req, res, m, admin) => {
      const u = new URL(req.url, 'http://x');
      const country = String(u.searchParams.get('country') || '').toUpperCase().slice(0, 2);
      const rows = await db.query(
        `SELECT c.id, c.full_name, c.kind, c.country, c.area_label, c.whatsapp, c.call_phone, c.status, c.is_hidden, c.source, c.created_at,
                s.plan, s.start_date, s.expiry_date, s.payment_status
           FROM cooks c
           LEFT JOIN subscriptions s ON s.id = (SELECT x.id FROM subscriptions x WHERE x.cook_id = c.id ORDER BY x.expiry_date DESC, x.id DESC LIMIT 1)
          ${country ? 'WHERE c.country = $1' : ''}
          ORDER BY s.expiry_date ASC, c.id ASC`, country ? [country] : []);
      const cats = settings.get().categories;
      const q = (v) => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
      const now = Date.now();
      const head = ['id', 'name', 'category', 'country', 'area', 'whatsapp', 'phone', 'status', 'hidden', 'source', 'plan', 'start', 'expiry', 'days_left', 'payment', 'page'];
      const lines = rows.map((r) => [r.id, r.full_name, (cats.find((c) => c.key === (r.kind || 'cook'))?.names?.ar?.one) || r.kind, r.country, r.area_label,
        r.whatsapp ? `+${String(r.whatsapp).replace(/^\+/, '')}` : '', r.call_phone || '', r.status, Number(r.is_hidden) ? 'yes' : '', r.source || 'signup',
        r.plan || '', String(r.start_date || '').slice(0, 10), String(r.expiry_date || '').slice(0, 10),
        r.expiry_date ? Math.ceil((new Date(r.expiry_date).getTime() - now) / 864e5) : '', r.payment_status || '',
        `${cfg.publicBaseUrl || ''}/c/${r.id}`].map(q).join(','));
      await logAdminAction(db, admin.id, null, 'export_subscribers', { country: country || 'all', n: rows.length });
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="aklatak-subscribers-${country || 'all'}-${new Date().toISOString().slice(0, 10)}.csv"` });
      res.end('\uFEFF' + [head.join(','), ...lines].join('\r\n'));   // BOM: Arabic shows correctly in Excel
    })],

    /* ---------- import shops from the map: any place → shops around it, sorted into categories ---------- */
    ['GET', /^\/api\/admin\/import\/places$/, guard(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const q = String(u.searchParams.get('q') || '').trim().slice(0, 120);
      const radiusKm = Math.min(10, Math.max(0.5, Number(u.searchParams.get('radius')) || 5));
      if (q.length < 2) throw new HttpError(422, 'validation_failed', { fields: { q: 'required' } });
      if (!cfg.geoapifyKey) throw new HttpError(409, 'geoapify_missing');
      const out = await findPlaceAndShops({ q, radiusKm, categories: settings.get().categories, key: cfg.geoapifyKey, fetchImpl: cfg.mapFetch || fetch, db });
      sendJson(res, 200, out);
    })],
    ['GET', /^\/api\/admin\/import\/region$/, guard(async (req, res) => {
      const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim().slice(0, 120);
      if (q.length < 2) throw new HttpError(422, 'validation_failed', { fields: { q: 'required' } });
      if (!cfg.geoapifyKey) throw new HttpError(409, 'geoapify_missing');
      sendJson(res, 200, await findRegionShops({ q, categories: settings.get().categories, key: cfg.geoapifyKey, fetchImpl: cfg.mapFetch || fetch, db, areas }));
    })],
    ['POST', /^\/api\/admin\/import\/places$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 512 * 1024);
      const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
      const kinds = new Set(activeKinds(settings.get().categories));
      // optional visibility period: 30 / 90 / 365 days, or none (stays until removed)
      const days = [30, 90, 365].includes(Number(body.days)) ? Number(body.days) : 3650;
      const now = new Date(); const end = new Date(now.getTime() + days * 864e5);
      let created = 0, skipped = 0;
      for (const it of items) {
        const name = String(it.name || '').trim().slice(0, 80);
        const lat = Number(it.lat), lng = Number(it.lng);
        const ref = /^geoapify:[\w-]{1,200}$/.test(String(it.ref || '')) ? String(it.ref) : null;
        if (!name || !isValidLatLng(lat, lng) || !kinds.has(it.kind) || it.kind === 'cook') { skipped++; continue; }
        // never twice: same map reference, or the same name within ~200 m
        if (ref && await db.one('SELECT id FROM cooks WHERE ext_ref = $1', [ref])) { skipped++; continue; }
        if (await db.one('SELECT id FROM cooks WHERE name_norm = $1 AND lat BETWEEN $2 AND $3 AND lng BETWEEN $4 AND $5',
          [normalizeName(name), lat - 0.002, lat + 0.002, lng - 0.0025, lng + 0.0025])) { skipped++; continue; }
        const wa = it.whatsapp ? normalizePhone(String(it.whatsapp), cfg.defaultCountry) : null;
        const call = it.callPhone ? normalizePhone(String(it.callPhone), cfg.defaultCountry) : null;
        const near = areas.nearest(lat, lng);
        const served = [...new Set([...(near ? [near.id] : []), ...areas.idsNear(lat, lng, 5)])].slice(0, 60);
        const row = await db.one(
          `INSERT INTO cooks (full_name, name_norm, whatsapp, call_phone, area_id, area_label, lat, lng, service_radius_km, status, kind, bio, country, ext_ref, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,5,'approved',$9,$10,$11,$12,'map') RETURNING id`,
          [name, normalizeName(name), wa || '', call, near?.id || null, (near ? areas.view(near, 'ar').name : String(it.address || '-')).slice(0, 80),
            lat, lng, it.kind, String(it.address || '').slice(0, 300) || null, (near?.country || String(it.country || '').toUpperCase().slice(0, 2)) || null, ref]);
        for (const aid of served) await db.query('INSERT INTO cook_service_areas (cook_id, area_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.id, aid]);
        await db.query(`INSERT INTO subscriptions (cook_id, plan, status, payment_status, start_date, expiry_date) VALUES ($1,'yearly','active','waived',$2,$3)`,
          [row.id, now.toISOString(), end.toISOString()]);
        created++;
      }
      cache?.clear?.('feed:');
      await logAdminAction(db, admin.id, null, 'map_import', { created, skipped });
      sendJson(res, 201, { created, skipped, ids: created ? undefined : [] });
    })],

    /* ---------- country agents (owner only): one country each, limited rights ---------- */
    ['GET', /^\/api\/admin\/agents$/, guard(async (req, res) => {
      const rows = await db.query(`SELECT id, username, country, disabled, created_at, last_login_at FROM admin_users WHERE role = 'agent' ORDER BY country, username`);
      sendJson(res, 200, { agents: rows.map((r) => ({ id: r.id, username: r.username, country: r.country, disabled: !!Number(r.disabled), lastLogin: r.last_login_at })) });
    })],
    ['POST', /^\/api\/admin\/agents$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 4 * 1024);
      const v = new Validator();
      const username = String(body.username || '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(username)) v.fail('username', 'invalid');
      if (String(body.password || '').length < 10) v.fail('password', 'password_too_short');
      const country = String(body.country || '').toUpperCase();
      if (!getCountry(country)) v.fail('country', 'invalid');
      v.assert();
      if (await db.one('SELECT id FROM admin_users WHERE LOWER(username) = $1', [username])) throw new HttpError(409, 'username_taken');
      const row = await db.one(`INSERT INTO admin_users (username, password_hash, role, country) VALUES ($1,$2,'agent',$3) RETURNING id`, [username, await hashPassword(String(body.password)), country]);
      await logAdminAction(db, admin.id, null, 'agent_add', { username, country });
      sendJson(res, 201, { id: row.id, username, country });
    })],
    ['PATCH', /^\/api\/admin\/agents\/(\d+)$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 4 * 1024);
      const a = await db.one(`SELECT id FROM admin_users WHERE id = $1 AND role = 'agent'`, [Number(m[1])]);
      if (!a) throw new HttpError(404, 'not_found');
      if (body.country !== undefined) {
        const country = String(body.country).toUpperCase();
        if (!getCountry(country)) throw new HttpError(422, 'validation_failed', { fields: { country: 'invalid' } });
        await db.query('UPDATE admin_users SET country = $1 WHERE id = $2', [country, a.id]);
      }
      if (body.disabled !== undefined) {
        await db.query('UPDATE admin_users SET disabled = $1 WHERE id = $2', [body.disabled ? 1 : 0, a.id]);
        if (body.disabled) await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [a.id]);   // signed out at once
      }
      if (body.password !== undefined) {
        if (String(body.password).length < 10) throw new HttpError(422, 'validation_failed', { fields: { password: 'password_too_short' } });
        await db.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [await hashPassword(String(body.password)), a.id]);
        await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [a.id]);
      }
      await logAdminAction(db, admin.id, null, 'agent_change', { id: a.id });
      sendJson(res, 200, { ok: true });
    })],
    ['DELETE', /^\/api\/admin\/agents\/(\d+)$/, guard(async (req, res, m, admin) => {
      const a = await db.one(`SELECT id, username FROM admin_users WHERE id = $1 AND role = 'agent'`, [Number(m[1])]);
      if (!a) throw new HttpError(404, 'not_found');
      await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [a.id]);
      await db.query('DELETE FROM admin_users WHERE id = $1', [a.id]);
      await logAdminAction(db, admin.id, null, 'agent_remove', { username: a.username });
      sendJson(res, 200, { ok: true });
    })],

    ['GET', /^\/api\/admin\/cooks\/(\d+)\/report$/, guard(async (req, res, m) => {
      const id = Number(m[1]);
      const c = await db.one('SELECT full_name, whatsapp FROM cooks WHERE id = $1', [id]);
      if (!c) throw new HttpError(404, 'not_found');
      const st = await cookStats(db, id);
      const text = t('ar', 'report.monthly', { name: c.full_name, views: st.views_30d ?? 0, impressions: st.impressions_30d ?? 0, whatsapp: st.whatsapp_30d ?? 0, likes: st.likes ?? 0 });
      sendJson(res, 200, { stats: st, text, whatsappUrl: c.whatsapp ? `https://wa.me/${String(c.whatsapp).replace(/\D/g, '')}?text=${encodeURIComponent(text)}` : null });
    })],
    ['POST', /^\/api\/admin\/cooks\/(\d+)\/verify$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 1024);
      await db.query('UPDATE cooks SET verified = $1 WHERE id = $2', [body.on ? 1 : 0, Number(m[1])]);
      cache?.clear?.('feed:');
      await logAdminAction(db, admin.id, Number(m[1]), body.on ? 'verify' : 'unverify');
      sendJson(res, 200, { ok: true });
    })],
    // delete ALL imported places of one category (e.g. every imported pharmacy) in one country — subscribers are never touched
    ['DELETE', /^\/api\/admin\/imported$/, guard(async (req, res, m, admin) => {
      const u = new URL(req.url, 'http://x');
      const kind = u.searchParams.get('kind'); const country = String(u.searchParams.get('country') || '').toUpperCase();
      if (!KEY_RE.test(kind || '') || !/^[A-Z]{2}$/.test(country)) throw new HttpError(422, 'validation_failed', { fields: { kind: 'invalid' } });
      const n = (await db.query(`DELETE FROM cooks WHERE source = 'map' AND kind = $1 AND COALESCE(country, 'LB') = $2 RETURNING id`, [kind, country])).length;
      cache?.clear?.('feed:');
      await logAdminAction(db, admin.id, null, 'imported_delete', { kind, country, n });
      sendJson(res, 200, { ok: true, deleted: n });
    })],

    /* ---------- referral links (owner: any country · agent: his own) ---------- */
    ['GET', /^\/api\/admin\/referrers$/, guard(async (req, res) => {
      const country = String(new URL(req.url, 'http://x').searchParams.get('country') || '').toUpperCase();
      const rows = await db.query(
        `SELECT r.id, r.code, r.name, r.contact, r.country, r.commission, r.currency, r.is_active, r.created_at,
                (SELECT CAST(COUNT(*) AS INTEGER) FROM cooks c WHERE c.referrer_id = r.id) AS subscribers,
                (SELECT COALESCE(SUM(e.amount), 0) FROM referral_earnings e WHERE e.referrer_id = r.id AND e.paid_at IS NULL) AS due,
                (SELECT COALESCE(SUM(e.amount), 0) FROM referral_earnings e WHERE e.referrer_id = r.id AND e.paid_at IS NOT NULL) AS paid
           FROM referrers r ${/^[A-Z]{2}$/.test(country) ? 'WHERE r.country = $1' : ''} ORDER BY r.id DESC`, /^[A-Z]{2}$/.test(country) ? [country] : []);
      const base = siteUrl(req);
      sendJson(res, 200, { referrers: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, contact: r.contact || '', country: r.country, commission: Number(r.commission),
        currency: r.currency, active: !!Number(r.is_active), createdAt: r.created_at, subscribers: Number(r.subscribers), due: Number(r.due), paid: Number(r.paid), link: `${base}/join?ref=${r.code}` })) });
    })],
    ['POST', /^\/api\/admin\/referrers$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 4 * 1024);
      const v = new Validator();
      const name = v.text('name', body.name, { min: 2, max: 80 });
      const contact = v.text('contact', body.contact, { max: 80, required: false });
      const commission = v.number('commission', body.commission, { min: 0, max: 10000 });
      const currency = /^[A-Z]{3}$/.test(String(body.currency || '').toUpperCase()) ? String(body.currency).toUpperCase() : 'USD';
      const country = req.agentCountry || (body.country ? String(body.country).toUpperCase() : null);
      if (country && !getCountry(country)) v.fail('country', 'invalid');
      v.assert();
      let code = newCode();
      while (await db.one('SELECT id FROM referrers WHERE code = $1', [code])) code = newCode();
      const row = await db.one('INSERT INTO referrers (code, name, contact, country, commission, currency, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [code, name, contact, country, commission, currency, admin.id]);
      await logAdminAction(db, admin.id, null, 'referrer_add', { name, country });
      sendJson(res, 201, { id: row.id, code, link: `${siteUrl(req)}/join?ref=${code}` });
    })],
    ['PATCH', /^\/api\/admin\/referrers\/(\d+)$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 4 * 1024);
      const sets = {}; const v = new Validator();
      if (body.commission !== undefined) sets.commission = v.number('commission', body.commission, { min: 0, max: 10000 });
      if (body.active !== undefined) sets.is_active = body.active ? 1 : 0;
      if (body.name !== undefined) sets.name = v.text('name', body.name, { min: 2, max: 80 });
      v.assert();
      const keys = Object.keys(sets);
      if (keys.length) await db.query(`UPDATE referrers SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`, [...Object.values(sets), Number(m[1])]);
      await logAdminAction(db, admin.id, null, 'referrer_change', { id: Number(m[1]) });
      sendJson(res, 200, { ok: true });
    })],
    ['DELETE', /^\/api\/admin\/referrers\/(\d+)$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await db.query('UPDATE cooks SET referrer_id = NULL WHERE referrer_id = $1', [id]);
      await db.query('DELETE FROM referral_earnings WHERE referrer_id = $1', [id]);
      await db.query('DELETE FROM referrers WHERE id = $1', [id]);
      await logAdminAction(db, admin.id, null, 'referrer_delete', { id });
      sendJson(res, 200, { ok: true });
    })],
    ['GET', /^\/api\/admin\/referrers\/(\d+)\/earnings$/, guard(async (req, res, m) => {
      const rows = await db.query('SELECT id, cook_id, cook_name, reason, amount, currency, paid_at, created_at FROM referral_earnings WHERE referrer_id = $1 ORDER BY id DESC LIMIT 500', [Number(m[1])]);
      sendJson(res, 200, { earnings: rows.map((e) => ({ id: e.id, cookId: e.cook_id, cookName: e.cook_name, reason: e.reason, amount: Number(e.amount), currency: e.currency, paid: !!e.paid_at, at: e.created_at })) });
    })],
    ['POST', /^\/api\/admin\/referrers\/(\d+)\/pay$/, guard(async (req, res, m, admin) => {
      const n = (await db.query('UPDATE referral_earnings SET paid_at = $1 WHERE referrer_id = $2 AND paid_at IS NULL RETURNING id', [new Date().toISOString(), Number(m[1])])).length;
      await logAdminAction(db, admin.id, null, 'referrer_paid', { id: Number(m[1]), n });
      sendJson(res, 200, { ok: true, marked: n });
    })],

    /* ---------- messages from visitors (footer "Contact the team") ---------- */
    ['GET', /^\/api\/admin\/messages$/, guard(async (req, res) => {
      const rows = await db.query('SELECT id, name, contact, body, locale, read_at, created_at FROM site_messages ORDER BY id DESC LIMIT 200');
      sendJson(res, 200, { messages: rows.map((m) => ({ id: m.id, name: m.name || '', contact: m.contact || '', body: m.body, locale: m.locale, read: !!m.read_at, at: m.created_at })) });
    })],
    ['POST', /^\/api\/admin\/messages\/(\d+)\/read$/, guard(async (req, res, m) => {
      await db.query('UPDATE site_messages SET read_at = $1 WHERE id = $2', [new Date().toISOString(), Number(m[1])]);
      sendJson(res, 200, { ok: true });
    })],
    ['DELETE', /^\/api\/admin\/messages\/(\d+)$/, guard(async (req, res, m, admin) => {
      await db.query('DELETE FROM site_messages WHERE id = $1', [Number(m[1])]);
      await logAdminAction(db, admin.id, null, 'message_delete');
      sendJson(res, 200, { ok: true });
    })],

    /* ---------- logos & backgrounds library (the owner's uploads) ---------- */
    ['GET', /^\/api\/admin\/assets$/, guard(async (req, res) => {
      const rows = await db.query('SELECT id, kind, label, created_at FROM site_assets ORDER BY id DESC LIMIT 100');
      sendJson(res, 200, { assets: rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label || '', url: `/media/asset/${r.id}` })), logoPresets: LOGO_PRESETS, bgPresets: BG_PRESETS });
    })],
    ['POST', /^\/api\/admin\/assets$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 1300 * 1024);
      const v = new Validator();
      const kind = v.oneOf('kind', body.kind, ['logo', 'background']);
      const img = validatePhoto(body.image, v, 'image', { maxBytes: kind === 'logo' ? 500_000 : 1_200_000 });
      if (!img) v.fail('image', 'required');
      const label = v.text('label', body.label, { max: 60, required: false });
      v.assert();
      const row = await db.one('INSERT INTO site_assets (kind, data, label) VALUES ($1,$2,$3) RETURNING id', [kind, img, label]);
      await logAdminAction(db, admin.id, null, 'asset_add', { kind });
      sendJson(res, 201, { id: row.id, url: `/media/asset/${row.id}` });
    })],
    ['DELETE', /^\/api\/admin\/assets\/(\d+)$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await db.query('DELETE FROM site_assets WHERE id = $1', [id]);
      const th = settings.get().theme || {};
      const reset = {};
      if (th.logo === `asset:${id}`) reset.logo = '';
      if (th.background === `asset:${id}`) reset.background = '';
      if (Object.keys(reset).length) await settings.save({ theme: reset });
      cache?.clear?.('config:');
      await logAdminAction(db, admin.id, null, 'asset_remove');
      sendJson(res, 200, { ok: true });
    })],

    /* ---------- logo ---------- */
    ['POST', /^\/api\/admin\/logo$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 600 * 1024);
      const v = new Validator();
      const img = validatePhoto(body.image, v, 'image', { maxBytes: 500_000 });
      if (!img) v.fail('image', 'required');
      v.assert();
      const row = await db.one(`SELECT key FROM app_meta WHERE key = 'site_logo'`);
      if (row) await db.query(`UPDATE app_meta SET value = $1 WHERE key = 'site_logo'`, [img]);
      else await db.query(`INSERT INTO app_meta (key, value) VALUES ('site_logo', $1)`, [img]);
      await settings.save({ theme: { logoVersion: Date.now() } });
      cache?.clear?.('config:');
      await logAdminAction(db, admin.id, null, 'logo_change');
      sendJson(res, 200, { ok: true });
    })],
    ['DELETE', /^\/api\/admin\/logo$/, guard(async (req, res, m, admin) => {
      await db.query(`DELETE FROM app_meta WHERE key = 'site_logo'`);
      await settings.save({ theme: { logoVersion: 0 } });
      cache?.clear?.('config:');
      await logAdminAction(db, admin.id, null, 'logo_reset');
      sendJson(res, 200, { ok: true });
    })],

    /* ---------- find a place by name (for restaurants added by the admin) ---------- */
    ['GET', /^\/api\/admin\/geocode$/, guard(async (req, res) => {
      const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim().slice(0, 120);
      if (q.length < 2) return sendJson(res, 200, { places: [] });
      let places = [];
      try {
        if (!cfg.geoapifyKey) throw new Error('no key');
        const j = await geoapifyGet('/v1/geocode/autocomplete', { text: q, limit: '8', format: 'json' }, { key: cfg.geoapifyKey });
        places = (j.results || []).map((r) => ({ name: r.formatted || r.name, lat: r.lat, lng: r.lon, country: String(r.country_code || '').toUpperCase() }));
      } catch {
        // free fallback: OpenStreetMap Nominatim
        try {
          const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 7000);
          const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`,
            { headers: { 'User-Agent': 'aklatak-platform/4 (admin place search)' }, signal: ctrl.signal });
          clearTimeout(tm);
          if (r.ok) places = (await r.json()).map((x) => ({ name: x.display_name, lat: Number(x.lat), lng: Number(x.lon), country: null }));
        } catch { /* nothing */ }
      }
      sendJson(res, 200, { places: places.filter((p) => isValidLatLng(p.lat, p.lng)).slice(0, 8) });
    })],

    /* ---------- photos & menu of any subscriber (e.g. restaurants the admin publishes) ---------- */
    ['POST', /^\/api\/admin\/cooks\/(\d+)\/photos$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      const c = await db.one('SELECT kind FROM cooks WHERE id = $1', [id]);
      if (!c) throw new HttpError(404, 'not_found');
      const body = await readJson(req, 800 * 1024);
      const v = new Validator();
      const data = validatePhoto(body.data, v, 'photo', { maxBytes: 700_000 });
      if (!data) v.fail('photo', 'required');
      const caption = v.text('caption', body.caption, { max: 80, required: false });
      v.assert();
      const max = c.kind !== 'cook' ? Number(settings.get().limits?.restaurantPhotos) || 300 : Number(settings.get().limits?.cookPhotos) || 300;
      const n = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cook_photos WHERE cook_id = $1', [id]);
      if (n.n >= max) throw new HttpError(409, 'too_many_photos');
      const img = await images.save(`dishes/${id}`, data);
      await db.query('INSERT INTO cook_photos (cook_id, data, url, caption) VALUES ($1,$2,$3,$4)', [id, img.data || '', img.url, caption]);
      cache?.clear?.('feed:');
      await logAdminAction(db, admin.id, id, 'photo_add');
      sendJson(res, 201, await loadCook(id));
    })],
    ['POST', /^\/api\/admin\/cooks\/(\d+)\/menu$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      const c = await db.one('SELECT kind, country FROM cooks WHERE id = $1', [id]);
      if (!c) throw new HttpError(404, 'not_found');
      const body = await readJson(req, 8 * 1024);
      const v = new Validator();
      const name = v.text('name', body.name, { min: 1, max: 80 });
      const description = v.text('description', body.description, { max: 200, required: false });
      const price = body.price === '' || body.price == null ? null : v.number('price', body.price, { min: 0, max: 1000000 });
      v.assert();
      const n = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM menu_items WHERE cook_id = $1', [id]);
      const currency = getCountry(c.country)?.currency || 'USD';
      await db.query('INSERT INTO menu_items (cook_id, name, description, price, currency, sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, description, price, currency, n.n]);
      await logAdminAction(db, admin.id, id, 'menu_add');
      sendJson(res, 201, await loadCook(id));
    })],

    /* ---------- whole-site settings ---------- */
    ['GET', /^\/api\/admin\/settings$/, guard(async (req, res) => {
      sendJson(res, 200, { ...settings.get(), effectiveBrand: cfg.brand, effectiveAdminWhatsapp: cfg.adminWhatsapp });
    })],
    ['PUT', /^\/api\/admin\/settings$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 8 * 1024);
      const v = new Validator();
      const patch = {};
      if (body.brandName !== undefined) patch.brandName = v.text('brandName', body.brandName, { max: 40, required: false }) || '';
      if (body.brandNameEn !== undefined) patch.brandNameEn = v.text('brandNameEn', body.brandNameEn, { max: 40, required: false }) || '';
      if (body.announcement !== undefined) patch.announcement = v.text('announcement', body.announcement, { max: 300, required: false, multiline: true }) || '';
      if (body.adminWhatsapp !== undefined) {
        const raw = v.text('adminWhatsapp', body.adminWhatsapp, { max: 25, required: false });
        patch.adminWhatsapp = raw ? (normalizePhone(raw, cfg.defaultCountry) || (v.fail('adminWhatsapp', 'invalid_phone'), '')) : '';
      }
      if (body.sections && typeof body.sections === 'object') {
        patch.sections = {};
        for (const k of ['nearby', 'regions', 'dishes', 'nameSearch', 'cooksSlider', 'restaurants', 'globalCounters', 'dailyCounters']) if (k in body.sections) patch.sections[k] = !!body.sections[k];
      }
      if (body.prices && typeof body.prices === 'object') {
        patch.prices = {};
        for (const kind of activeKinds(settings.get().categories)) {
          const byPlan = body.prices[kind];
          if (!byPlan) continue;
          patch.prices[kind] = {};
          for (const plan of PLAN_KEYS) {
            const p = byPlan[plan];
            if (!p) continue;
            patch.prices[kind][plan] = {};
            for (const cur of ['usd', 'eur']) {
              if (!(cur in p)) continue;
              const val = p[cur] === '' || p[cur] == null ? '' : Number(p[cur]);
              if (val !== '' && (!Number.isFinite(val) || val < 0 || val > 100000)) v.fail(`prices.${kind}.${plan}.${cur}`, 'invalid');
              else patch.prices[kind][plan][cur] = val === '' ? '' : Math.round(val * 100) / 100;
            }
          }
        }
      }
      if (body.trial && typeof body.trial === 'object') {
        patch.trial = {};
        for (const kind of activeKinds(settings.get().categories)) {
          const tr = body.trial[kind];
          if (!tr) continue;
          const days = Math.round(Number(tr.days));
          if (tr.days !== undefined && (!Number.isFinite(days) || days < 1 || days > 365)) v.fail(`trial.${kind}.days`, 'invalid');
          patch.trial[kind] = { ...(tr.enabled !== undefined ? { enabled: !!tr.enabled } : {}), ...(tr.days !== undefined && days >= 1 && days <= 365 ? { days } : {}) };
        }
      }
      if (body.appLinks && typeof body.appLinks === 'object') {
        patch.appLinks = {};
        for (const k of ['android', 'ios']) {
          if (body.appLinks[k] === undefined) continue;
          const u = String(body.appLinks[k] || '').trim();
          if (u && (!/^https:\/\/\S+$/i.test(u) || u.length > 400)) v.fail(`appLinks.${k}`, 'invalid'); else patch.appLinks[k] = u;
        }
      }
      if (body.theme && typeof body.theme === 'object') {
        const th = { colors: {}, layouts: {} };
        for (const k of Object.keys(COLOR_KEYS)) {
          const c = body.theme.colors?.[k];
          if (c === undefined) continue;
          if (c === '' || c === null) th.colors[k] = '';
          else if (isColor(c)) th.colors[k] = c; else v.fail(`theme.colors.${k}`, 'invalid');
        }
        if (body.theme.fontScale !== undefined) {
          if (FONT_SCALES.includes(Number(body.theme.fontScale))) th.fontScale = Number(body.theme.fontScale); else v.fail('theme.fontScale', 'invalid');
        }
        for (const [k, allowed] of Object.entries(LAYOUTS)) {
          const l = body.theme.layouts?.[k];
          if (l === undefined) continue;
          if (allowed.includes(l)) th.layouts[k] = l; else v.fail(`theme.layouts.${k}`, 'invalid');
        }
        if (body.theme.sizes && typeof body.theme.sizes === 'object') {
          th.sizes = {};
          for (const k of SIZE_KEYS) {
            const z = body.theme.sizes[k];
            if (z === undefined) continue;
            if (SIZES.includes(z)) th.sizes[k] = z; else v.fail(`theme.sizes.${k}`, 'invalid');
          }
        }
        for (const k of ['logo', 'background']) {
          const val = body.theme[k];
          if (val === undefined) continue;
          const presets = k === 'logo' ? LOGO_PRESETS : BG_PRESETS;
          if (val === '' || (typeof val === 'string' && val.startsWith('preset:') && presets.includes(val.slice(7)))) th[k] = val;
          else if (typeof val === 'string' && /^asset:\d+$/.test(val)) {
            const a = await db.one('SELECT kind FROM site_assets WHERE id = $1', [Number(val.slice(6))]);
            if (a && a.kind === k) th[k] = val; else v.fail(`theme.${k}`, 'invalid');
          } else v.fail(`theme.${k}`, 'invalid');
        }
        if (body.theme.ui && typeof body.theme.ui === 'object') {
          th.ui = {};
          for (const k of ['btnShape', 'fieldShape']) { const x = body.theme.ui[k]; if (x === undefined) continue; if (x === '' || UI_SHAPES.includes(x)) th.ui[k] = x; else v.fail(`theme.ui.${k}`, 'invalid'); }
          for (const k of UI_COLOR_KEYS) { const x = body.theme.ui[k]; if (x === undefined) continue; if (x === '' || isColor(x)) th.ui[k] = x; else v.fail(`theme.ui.${k}`, 'invalid'); }
        }
        patch.theme = th;
      }
      if (body.booking !== undefined) {
        const b = body.booking || {};
        const prices = Object.entries(b.prices || {});
        if (prices.some(([k, v]) => !KEY_RE.test(k) || !(Number(v) >= 0 && Number(v) <= 10000))) v.fail('booking', 'invalid');
        else patch.booking = { enabled: b.enabled !== false, prices: Object.fromEntries(prices.map(([k, v]) => [k, Number(v)])) };
      }
      if (body.countriesHidden !== undefined) {
        if (!Array.isArray(body.countriesHidden) || body.countriesHidden.some((x) => !/^[A-Z]{2}$/.test(String(x)))) v.fail('countriesHidden', 'invalid'); else patch.countriesHidden = body.countriesHidden;
      }
      if (body.countryCatsHidden !== undefined) {
        const ok = body.countryCatsHidden && typeof body.countryCatsHidden === 'object' && Object.entries(body.countryCatsHidden).every(([k, v]) => /^[A-Z]{2}$/.test(k) && Array.isArray(v) && v.every((x) => KEY_RE.test(String(x))));
        if (!ok) v.fail('countryCatsHidden', 'invalid'); else patch.countryCatsHidden = body.countryCatsHidden;
      }
      if (body.groupsHidden !== undefined) {
        const ok = Array.isArray(body.groupsHidden) && body.groupsHidden.length < 2 && body.groupsHidden.every((x) => x === 'shops' || x === 'crafts');
        if (!ok) v.fail('groupsHidden', 'invalid'); else patch.groupsHidden = body.groupsHidden;   // one group always stays
      }
      if (body.plansHidden !== undefined) {
        const ok = Array.isArray(body.plansHidden) && body.plansHidden.every((x) => PLAN_KEYS.includes(x)) && body.plansHidden.length < PLAN_KEYS.length;
        if (!ok) v.fail('plansHidden', 'invalid'); else patch.plansHidden = body.plansHidden;   // at least one duration stays visible
      }
      if (body.menuHidden !== undefined) {
        if (!Array.isArray(body.menuHidden) || body.menuHidden.some((x) => !/^(join|login|app|advertise|cat:[a-z][a-z0-9_]{1,30})$/.test(String(x)))) v.fail('menuHidden', 'invalid');
        else patch.menuHidden = body.menuHidden;
      }
      if (body.extraCountries !== undefined) {
        // countries added by the owner (built-in countries can't be changed); {} removes them
        patch.extraCountries = {};
        for (const [code, def] of Object.entries(body.extraCountries || {})) {
          const c = String(code).toUpperCase();
          const ok = !isBuiltInCountry(c) && validCountryDef(c, def);
          if (!ok) v.fail(`extraCountries.${c}`, 'invalid'); else patch.extraCountries[c] = { ...def, nsn: ok.nsn, trunk: ok.trunk, units: ok.units };
        }
      }
      if (body.categories !== undefined) {
        const cats = cleanCategories(body.categories);
        if (!cats) v.fail('categories', 'invalid'); else patch.categories = cats;
      }
      if (body.adPrices && typeof body.adPrices === 'object') {
        patch.adPrices = {};
        for (const d of ['week', 'month']) {
          patch.adPrices[d] = {};
          for (const cur of ['usd', 'eur']) {
            const raw = body.adPrices[d]?.[cur];
            if (raw === undefined) continue;
            const val = raw === '' || raw === null ? '' : Number(raw);
            if (val !== '' && (!Number.isFinite(val) || val < 0 || val > 100000)) v.fail(`adPrices.${d}.${cur}`, 'invalid');
            else patch.adPrices[d][cur] = val === '' ? '' : Math.round(val * 100) / 100;
          }
        }
      }
      if (body.limits && typeof body.limits === 'object') {
        patch.limits = {};
        for (const [k, max] of [['cookPhotos', 1000], ['restaurantPhotos', 1000], ['menuItems', 1000]]) {
          if (body.limits[k] === undefined) continue;
          const n = Math.round(Number(body.limits[k]));
          if (!Number.isFinite(n) || n < 1 || n > max) v.fail(`limits.${k}`, 'invalid'); else patch.limits[k] = n;
        }
      }
      v.assert();
      const saved = await settings.save(patch);
      cache?.clear?.('config:'); cache?.clear?.('feed:');
      await logAdminAction(db, admin.id, null, 'settings', patch);
      sendJson(res, 200, { ...saved, effectiveBrand: cfg.brand, effectiveAdminWhatsapp: cfg.adminWhatsapp });
    })],

    /* ---------- edit any text of the site (any language), rename sections, legal pages ---------- */
    ['GET', /^\/api\/admin\/texts$/, guard(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const lang = cfg.locales.includes(u.searchParams.get('lang')) ? u.searchParams.get('lang') : 'ar';
      const q = normalizeName(u.searchParams.get('q') || '');
      const prefix = (u.searchParams.get('prefix') || '').replace(/[^a-zA-Z.]/g, '').slice(0, 20);
      const flat = (o, p = '', out = {}) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object') flat(v, p + k + '.', out); else out[p + k] = String(v); } return out; };
      const keysAr = flat(baseLocale('ar'));
      const base = flat(baseLocale(lang));
      const edits = settings.get().textOverrides?.[lang] || {};
      const items = Object.keys(keysAr)
        .map((key) => ({ key, base: base[key] ?? '', value: edits[key] ?? null }))
        .filter((it) => !prefix || it.key.startsWith(prefix))
        .filter((it) => !q || normalizeName(it.key).includes(q) || normalizeName(it.base).includes(q) || normalizeName(it.value || '').includes(q))
        .slice(0, 300);
      sendJson(res, 200, { langs: cfg.locales, lang, items, total: Object.keys(keysAr).length });
    })],
    ['PUT', /^\/api\/admin\/texts$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 16 * 1024);
      const v = new Validator();
      const lang = v.oneOf('lang', body.lang, cfg.locales);
      const key = v.text('key', body.key, { min: 3, max: 120 });
      const flat = (o, p = '', out = new Set()) => { for (const [k, val] of Object.entries(o)) { if (val && typeof val === 'object') flat(val, p + k + '.', out); else out.add(p + k); } return out; };
      if (key && !flat(baseLocale('ar')).has(key)) v.fail('key', 'invalid');
      const reset = body.value === null || body.value === '';
      const value = reset ? null : v.text('value', body.value, { min: 1, max: 6000, multiline: true });
      v.assert();
      // "translate": save in this language and translate into all the others (DeepL);
      // "allLangs": the same text in every language (a name, a number…). Reset applies to every language too.
      const patch = { [lang]: { [key]: value } };
      const translated = [];
      if (reset && (body.translate || body.allLangs)) for (const l of cfg.locales) patch[l] = { [key]: null };
      else if (body.allLangs) for (const l of cfg.locales) patch[l] = { [key]: value };
      else if (body.translate && value) {
        for (const l of cfg.locales.filter((x) => x !== lang)) {
          const tr = await translateText(value, lang, l, { key: cfg.deeplKey });
          if (tr) { patch[l] = { [key]: tr }; translated.push(l); }
        }
      }
      const langs = Object.keys(patch);
      await settings.save({ textOverrides: patch });
      cache?.clear?.('config:'); cache?.clear?.('feed:');
      await logAdminAction(db, admin.id, null, reset ? 'text_reset' : 'text_edit', { langs, key });
      sendJson(res, 200, { ok: true, key, lang, value, translated, translationAvailable: !!cfg.deeplKey });
    })],

    /* ---------- reviews & photos moderation ---------- */
    ['PATCH', /^\/api\/admin\/reviews\/(\d+)$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 1024);
      const r = await db.one('SELECT cook_id FROM reviews WHERE id = $1', [Number(m[1])]);
      if (!r) throw new HttpError(404, 'not_found');
      await db.query('UPDATE reviews SET is_hidden = $1 WHERE id = $2', [body.hidden ? 1 : 0, Number(m[1])]);
      await logAdminAction(db, admin.id, r.cook_id, body.hidden ? 'hide_review' : 'show_review');
      sendJson(res, 200, await loadCook(r.cook_id));
    })],
    ['PATCH', /^\/api\/admin\/photos\/(\d+)$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 1024);
      const p = await db.one('SELECT cook_id FROM cook_photos WHERE id = $1', [Number(m[1])]);
      if (!p) throw new HttpError(404, 'not_found');
      await db.query('UPDATE cook_photos SET is_hidden = $1 WHERE id = $2', [body.hidden ? 1 : 0, Number(m[1])]);
      await logAdminAction(db, admin.id, p.cook_id, body.hidden ? 'hide_photo' : 'show_photo');
      cache?.clear?.('feed:');
      sendJson(res, 200, await loadCook(p.cook_id));
    })],

    // Free trial: one click, length set in Site settings (per kind). Marked as a trial (payment waived).
    ['POST', /^\/api\/admin\/cooks\/(\d+)\/subscription\/trial$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      const c = await db.one('SELECT kind FROM cooks WHERE id = $1', [id]);
      if (!c) throw new HttpError(404, 'not_found');
      const days = Number(settings.get().trial?.[c.kind || 'cook']?.days) || 14;
      const start = new Date();
      await activateSubscription(db, id, { plan: 'monthly', startDate: start, expiryDate: new Date(start.getTime() + days * 86400_000), paymentStatus: 'waived' }).catch(subError);
      await db.query('UPDATE subscriptions SET is_trial = 1 WHERE id = (SELECT MAX(id) FROM subscriptions WHERE cook_id = $1)', [id]);
      await logAdminAction(db, admin.id, id, 'trial', { days });
      sendJson(res, 200, await loadCook(id));
    })],

    /* ---------- support conversations with cooks & restaurants ---------- */
    ['GET', /^\/api\/admin\/support$/, guard(async (req, res) => {
      const rows = await db.query(
        `SELECT c.id AS cook_id, c.full_name, c.kind,
           (SELECT MAX(created_at) FROM support_messages s WHERE s.cook_id = c.id) AS last_at,
           (SELECT body FROM support_messages s WHERE s.cook_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_body,
           (SELECT CAST(COUNT(*) AS INTEGER) FROM support_messages s WHERE s.cook_id = c.id AND s.from_admin = 0 AND s.read_by_admin = 0) AS unread
         FROM cooks c WHERE EXISTS (SELECT 1 FROM support_messages s WHERE s.cook_id = c.id)
         ORDER BY unread DESC, last_at DESC LIMIT 200`);
      sendJson(res, 200, { threads: rows.map((r) => ({ cookId: r.cook_id, name: r.full_name, kind: r.kind || 'cook', lastAt: r.last_at, lastBody: r.last_body, unread: r.unread })) });
    })],
    ['GET', /^\/api\/admin\/support\/(\d+)$/, guard(async (req, res, m) => {
      const id = Number(m[1]);
      const rows = await db.query('SELECT id, from_admin, body, created_at FROM support_messages WHERE cook_id = $1 ORDER BY created_at, id', [id]);
      await db.query('UPDATE support_messages SET read_by_admin = 1 WHERE cook_id = $1 AND from_admin = 0 AND read_by_admin = 0', [id]);
      sendJson(res, 200, { messages: rows.map((r) => ({ id: r.id, fromAdmin: !!Number(r.from_admin), body: r.body, createdAt: r.created_at })) });
    })],
    ['POST', /^\/api\/admin\/support\/(\d+)$/, guard(async (req, res, m, admin) => {
      const id = Number(m[1]);
      await ensureCook(id);
      const body = await readJson(req, 8 * 1024);
      const v = new Validator();
      const text = v.text('body', body.body, { min: 1, max: 2000, multiline: true });
      v.assert();
      await db.query('INSERT INTO support_messages (cook_id, from_admin, body, read_by_admin) VALUES ($1, 1, $2, 1)', [id, text]);
      await logAdminAction(db, admin.id, id, 'support_reply');
      sendJson(res, 201, { ok: true });
    })],

    /* ---------- ads & logos: upload, place, order, turn on/off ---------- */
    ['GET', /^\/api\/admin\/banners$/, guard(async (req, res) => {
      const rows = await db.query("SELECT id, placement, image_url, link_url, title, sort_order, is_active, created_at, expires_at, status, advertiser_name, advertiser_whatsapp, note, duration_days, amount, currency FROM banners ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, placement, sort_order, id");
      const nowIso = new Date().toISOString();
      sendJson(res, 200, { placements: BANNER_PLACEMENTS, banners: rows.map((b) => ({
        id: b.id, placement: b.placement, title: b.title || '', linkUrl: b.link_url || '', sortOrder: b.sort_order, active: !!Number(b.is_active),
        expiresAt: b.expires_at || null, expired: !!(b.expires_at && b.expires_at <= nowIso),
        status: b.status || 'active', advertiser: b.advertiser_name ? { name: b.advertiser_name, whatsapp: b.advertiser_whatsapp, note: b.note || '',
          days: b.duration_days, price: b.amount != null ? `${b.currency === 'EUR' ? '€' : '$'}${b.amount}` : null } : null,
        imageUrl: b.image_url || `/api/admin/banners/${b.id}.jpg`,
      })) });
    })],
    ['GET', /^\/api\/admin\/banners\/(\d+)\.jpg$/, guard(async (req, res, m) => {
      const b = await db.one('SELECT image_data, image_url FROM banners WHERE id = $1', [Number(m[1])]);
      if (b?.image_url) return redirect(res, b.image_url);
      sendPhoto(res, b?.image_data);
    })],
    ['POST', /^\/api\/admin\/banners$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 1300 * 1024);
      const v = new Validator();
      const placement = v.oneOf('placement', body.placement, BANNER_PLACEMENTS);
      const title = v.text('title', body.title, { max: 80, required: false });
      const linkUrl = v.text('linkUrl', body.linkUrl, { max: 300, required: false });
      if (linkUrl && !/^(https?:\/\/|\/)/i.test(linkUrl)) v.fail('linkUrl', 'invalid');
      const photo = validatePhoto(body.image, v, 'image', { maxBytes: 1_200_000 });
      const expiresAt = bannerExpiry(body.expiresAt, v);
      if (!photo) v.fail('image', 'required');
      v.assert();
      const img = await images.save('banners', photo);
      const n = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM banners WHERE placement = $1', [placement]);
      await db.query('INSERT INTO banners (image_data, image_url, link_url, title, placement, sort_order, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [img.data, img.url, linkUrl || null, title || null, placement, n.n, expiresAt]);
      cache?.clear?.('feed:');
      await logAdminAction(db, admin.id, null, 'banner_add', { placement });
      sendJson(res, 201, { ok: true });
    })],
    ['PATCH', /^\/api\/admin\/banners\/(\d+)$/, guard(async (req, res, m) => {
      const body = await readJson(req, 4 * 1024);
      const v = new Validator();
      const sets = {};
      if (body.placement !== undefined) sets.placement = v.oneOf('placement', body.placement, BANNER_PLACEMENTS);
      if (body.title !== undefined) sets.title = v.text('title', body.title, { max: 80, required: false }) || null;
      if (body.linkUrl !== undefined) {
        const l = v.text('linkUrl', body.linkUrl, { max: 300, required: false });
        if (l && !/^(https?:\/\/|\/)/i.test(l)) v.fail('linkUrl', 'invalid');
        sets.link_url = l || null;
      }
      if (body.active !== undefined) sets.is_active = body.active ? 1 : 0;
      if (body.expiresAt !== undefined) sets.expires_at = bannerExpiry(body.expiresAt, v);
      if (body.sortOrder !== undefined) sets.sort_order = Math.max(0, Math.min(1000, Math.round(Number(body.sortOrder) || 0)));
      v.assert();
      const keys = Object.keys(sets);
      if (keys.length) await db.query(`UPDATE banners SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`, [...keys.map((k) => sets[k]), Number(m[1])]);
      cache?.clear?.('feed:');
      sendJson(res, 200, { ok: true });
    })],
    ['DELETE', /^\/api\/admin\/banners\/(\d+)$/, guard(async (req, res, m) => {
      const b = await db.one('SELECT image_url FROM banners WHERE id = $1', [Number(m[1])]);
      await db.query('DELETE FROM banners WHERE id = $1', [Number(m[1])]);
      await images.remove(b?.image_url);
      cache?.clear?.('feed:');
      sendJson(res, 200, { ok: true });
    })],
    ['DELETE', /^\/api\/admin\/menu\/(\d+)$/, guard(async (req, res, m, admin) => {
      const it = await db.one('SELECT cook_id FROM menu_items WHERE id = $1', [Number(m[1])]);
      if (!it) throw new HttpError(404, 'not_found');
      await db.query('DELETE FROM menu_items WHERE id = $1', [Number(m[1])]);
      await logAdminAction(db, admin.id, it.cook_id, 'delete_menu_item');
      sendJson(res, 200, await loadCook(it.cook_id));
    })],

    /* ---------- complaints & notes (admin only) ---------- */
    ['GET', /^\/api\/admin\/feedback$/, guard(async (req, res) => {
      const status = new URL(req.url, 'http://x').searchParams.get('status') || 'new';
      const rows = await db.query(
        `SELECT f.id, f.cook_id, c.full_name AS cook_name, c.whatsapp AS cook_whatsapp, f.kind, f.message, f.customer_name, f.customer_phone,
           f.status, f.admin_note, f.created_at,
           (SELECT CAST(COUNT(*) AS INTEGER) FROM cook_warnings w WHERE w.cook_id = f.cook_id) AS cook_warnings
         FROM feedback f JOIN cooks c ON c.id = f.cook_id
         ${status === 'all' ? '' : 'WHERE f.status = $1'} ORDER BY f.created_at DESC LIMIT 200`, status === 'all' ? [] : [status]);
      sendJson(res, 200, { feedback: rows });
    })],
    ['PATCH', /^\/api\/admin\/feedback\/(\d+)$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 4 * 1024);
      const v = new Validator();
      const status = v.oneOf('status', body.status, ['new', 'resolved'], { required: false });
      const note = v.text('adminNote', body.adminNote, { max: 1000, required: false, multiline: true });
      v.assert();
      const cur = await db.one('SELECT status, admin_note, cook_id FROM feedback WHERE id = $1', [Number(m[1])]);
      if (!cur) throw new HttpError(404, 'not_found');
      await db.query('UPDATE feedback SET status = $1, admin_note = $2, updated_at = $3 WHERE id = $4',
        [status ?? cur.status, body.adminNote !== undefined ? note : cur.admin_note, new Date().toISOString(), Number(m[1])]);
      await logAdminAction(db, admin.id, cur.cook_id, 'feedback_update', { feedbackId: Number(m[1]), status });
      sendJson(res, 200, { ok: true });
    })],

    /* ---------- photos moderation ---------- */
    ['GET', /^\/api\/admin\/photos\/(\d+)\.jpg$/, guard(async (req, res, m) => {
      const p = await db.one('SELECT data, url FROM cook_photos WHERE id = $1', [Number(m[1])]);
      if (p?.url) return redirect(res, p.url);
      sendPhoto(res, p?.data);
    })],
    ['DELETE', /^\/api\/admin\/photos\/(\d+)$/, guard(async (req, res, m, admin) => {
      const p = await db.one('SELECT cook_id, url, thumb_url FROM cook_photos WHERE id = $1', [Number(m[1])]);
      if (!p) throw new HttpError(404, 'not_found');
      await db.query('DELETE FROM cook_photos WHERE id = $1', [Number(m[1])]);
      await images.remove(p.url);
      await images.remove(p.thumb_url);
      await logAdminAction(db, admin.id, p.cook_id, 'delete_photo');
      sendJson(res, 200, await loadCook(p.cook_id));
    })],

    /* ---------- villages ---------- */
    // Import every village of a country from OpenStreetMap (runs in the background, ~1–3 minutes).
    ['POST', /^\/api\/admin\/areas\/import$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req, 1024);
      const iso = String(body.country || cfg.defaultCountry).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
      const key = `import:${iso}`;
      const setStatus = async (v) => {
        const cur = await db.one('SELECT key FROM app_meta WHERE key = $1', [key]);
        if (cur) await db.query('UPDATE app_meta SET value = $1 WHERE key = $2', [JSON.stringify(v), key]);
        else await db.query('INSERT INTO app_meta (key, value) VALUES ($1,$2)', [key, JSON.stringify(v)]);
      };
      await setStatus({ state: 'running', startedAt: new Date().toISOString() });
      await logAdminAction(db, admin.id, null, 'areas_import', { country: iso });
      (async () => {
        try {
          const places = await (cfg.countryPlacesFetcher || overpassCountryPlaces)(iso);
          const added = await savePlaces(db, areas, places);
          await setStatus({ state: 'done', found: places.length, added, finishedAt: new Date().toISOString() });
          console.log(`[osm] country ${iso}: ${places.length} places (${added} new)`);
        } catch (err) {
          await setStatus({ state: 'failed', error: err.message.slice(0, 300), finishedAt: new Date().toISOString() });
          console.warn(`[osm] country ${iso} import failed: ${err.message}`);
        }
      })();
      sendJson(res, 202, { state: 'running' });
    })],
    ['GET', /^\/api\/admin\/areas\/import$/, guard(async (req, res) => {
      const iso = (new URL(req.url, 'http://x').searchParams.get('country') || cfg.defaultCountry).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
      const row = await db.one('SELECT value FROM app_meta WHERE key = $1', [`import:${iso}`]);
      const total = (await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM service_areas')).n;
      sendJson(res, 200, { ...(row ? JSON.parse(row.value) : { state: 'never' }), totalAreas: total });
    })],
    ['POST', /^\/api\/admin\/areas$/, guard(async (req, res, m, admin) => {
      const body = await readJson(req);
      const v = new Validator();
      const nameAr = v.text('nameAr', body.nameAr, { min: 2, max: 60 });
      const nameEn = v.text('nameEn', body.nameEn, { max: 60, required: false });
      const district = v.oneOf('district', body.district, Object.keys(DISTRICTS));
      let lat = v.number('lat', body.lat, { min: -90, max: 90, required: false });
      let lng = v.number('lng', body.lng, { min: -180, max: 180, required: false });
      v.assert();
      if (lat == null || lng == null) {
        // No coordinates given: use the district's first village as an approximate centre.
        const ref = areas.inDistrict(district)[0];
        const a = ref && areas.get(ref.id);
        if (!a) throw new HttpError(422, 'validation_failed', { fields: { lat: 'required' } });
        lat = a.lat; lng = a.lng;
      }
      const row = await db.one(
        `INSERT INTO service_areas (slug, name_ar, name_en, name_fr, region, district, lat, lng, sort_order)
         VALUES ($1,$2,$3,$3,$4,$4,$5,$6,1000) RETURNING id`, [`area-${Date.now().toString(36)}`, nameAr, nameEn, district, lat, lng]);
      await areas.load();
      await logAdminAction(db, admin.id, null, 'area_add', { id: row.id, nameAr, district });
      sendJson(res, 201, { id: row.id });
    })],
  ];
}

