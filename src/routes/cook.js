// The cook's own account: login with WhatsApp number + password, see her numbers, manage her page & photos.
// Complaints/notes about her are NEVER exposed here (admin only).
import { HttpError, readJson, sendJson } from '../lib/http.js';
import { Validator, validatePhoto, imageBytesOk } from '../lib/validate.js';
import { normalizePhone } from '../lib/whatsapp.js';
import { hashPassword, verifyPassword, clientIp, hmacHex } from '../lib/security.js';
import { normalizeName } from '../../public/assets/normalize.js';
import { cleanHours } from '../lib/hours.js';
import { sessionManager, checkCsrf } from '../lib/sessions.js';
import { pickLocale } from '../lib/i18n.js';
import {
  cookStats, latestSubscription, effectiveStatus, serviceKeysFor, servedAreaIds, setServedAreas, setCookServices,
} from '../services/cooks.js';
import { isValidLatLng, roundTo } from '../lib/geo.js';
import { getCountry } from '../lib/countries.js';
import { SERVICE_TYPES, MAX_PHOTOS_PER_COOK } from '../db/seed-data.js';
import { sendPhoto, redirect } from './public.js';

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';

export function cookRoutes({ db, cfg, limiters, areas, images, geo, settings, cache }) {
  /** Photo limit depends on the kind (restaurants get more), set by the admin. */
  const photoLimit = (kind) => {
    const l = settings?.get().limits || {};
    return kind && kind !== 'cook' ? (Number(l.restaurantPhotos) || 300) : (Number(l.cookPhotos) || 300);
  };
  const menuLimit = () => Number(settings?.get().limits?.menuItems) || 300;
  const parseSections = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
  async function addSection(cookId, name) {
    const cur = parseSections((await db.one('SELECT menu_sections FROM cooks WHERE id = $1', [cookId]))?.menu_sections);
    if (!cur.includes(name) && cur.length < 40) await db.query('UPDATE cooks SET menu_sections = $1 WHERE id = $2', [JSON.stringify([...cur, name]), cookId]);
  }
  // optional product photo (the app shrinks it first): stored with the product, served at /api/menu-photo/<id>
  function productPhoto(v, value) {
    if (value == null || value === '') return null;
    const s = String(value);
    const mm = /^data:(image\/(?:jpeg|png|webp));base64,/.exec(s);
    if (!mm || !imageBytesOk(s) || s.length > 450_000) { v.fail('photo', 'invalid'); return null; }
    return { mime: mm[1], data: s.split(',')[1] };
  }
  const sessions = sessionManager({ db, cfg, table: 'cook_sessions', cookie: 'st_cook', ownerColumn: 'cook_id', hours: 24 * 60 });
  // Same admin sessions as /admin — the owner can also sign in from the normal "Log in" page with his admin username.
  const adminSessions = sessionManager({ db, cfg, table: 'admin_sessions', cookie: 'st_admin', ownerColumn: 'admin_id', hours: 12 });

  const guard = (fn) => async (req, res, m) => {
    const cookId = await sessions.ownerId(req);
    if (!cookId) throw new HttpError(401, 'unauthorized');
    if (req.method !== 'GET') checkCsrf(req);
    const cook = await db.one(`SELECT id, status FROM cooks WHERE id = $1`, [cookId]);
    if (!cook || cook.status === 'rejected') throw new HttpError(401, 'unauthorized');
    return fn(req, res, m, cookId);
  };

  async function me(cookId, locale) {
    const c = await db.one(
      `SELECT id, full_name, whatsapp, area_id, area_label, lat, lng, bio, status, photo_url, is_hidden, kind, specialty, allow_directions, hours, booking, CASE WHEN photo IS NULL THEN 0 ELSE 1 END AS has_photo
       FROM cooks WHERE id = $1`, [cookId]);
    const sub = await latestSubscription(db, cookId);
    const photos = await db.query('SELECT id, caption, url, is_hidden, created_at FROM cook_photos WHERE cook_id = $1 ORDER BY created_at DESC, id DESC', [cookId]);
    return {
      id: c.id,
      name: c.full_name,
      whatsapp: c.whatsapp,
      area: { ...(areas.view(areas.get(c.area_id), locale) || {}), name: c.area_label || areas.get(c.area_id)?.name_ar },
      bio: c.bio || '',
      allowDirections: Number(c.allow_directions ?? 1) === 1,
      hours: (() => { try { return c.hours ? JSON.parse(c.hours) : null; } catch { return null; } })(),
      booking: !!Number(c.booking || 0),
      location: { lat: Number(c.lat), lng: Number(c.lng) },
      hidden: !!Number(c.is_hidden),
      photoUrl: c.photo_url || (Number(c.has_photo) ? `/api/cook/photo?ts=${Date.now()}` : null),
      profileUrl: `/c/${c.id}`,
      services: (await serviceKeysFor(db, [c.id])).get(c.id),
      servedAreas: (await servedAreaIds(db, c.id)).map((id) => areas.view(areas.get(id), locale)).filter(Boolean),
      subscription: sub ? { status: effectiveStatus(c, sub), plan: sub.plan, startDate: sub.start_date, expiryDate: sub.expiry_date } : null,
      stats: await cookStats(db, c.id),
      photos: photos.map((p) => ({ id: p.id, url: p.url || `/api/cook/photos/${p.id}.jpg`, caption: p.caption || '', hidden: !!p.is_hidden })),
      maxPhotos: photoLimit(c.kind),
      kind: c.kind || 'cook',
      specialty: c.specialty || '',
      menu: true   // every category can have a menu
        ? (await db.query('SELECT id, name, description, price, currency, is_available, section, CASE WHEN photo IS NULL THEN 0 ELSE 1 END AS has_photo FROM menu_items WHERE cook_id = $1 ORDER BY sort_order, id', [c.id]))
          .map((x) => ({ ...x, section: x.section || null, photo: Number(x.has_photo) ? `/api/menu-photo/${x.id}?v=${Date.now() % 1e6}` : null }))
          .map((m) => ({ id: m.id, name: m.name, description: m.description || '', price: m.price == null ? null : Number(m.price), currency: m.currency || null, available: !!Number(m.is_available), section: m.section, photo: m.photo }))
        : [],
      menuSections: parseSections((await db.one('SELECT menu_sections FROM cooks WHERE id = $1', [c.id]))?.menu_sections),
      unreadSupport: Number((await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM support_messages WHERE cook_id = $1 AND from_admin = 1 AND read_by_cook = 0', [c.id])).n),
    };
  }

  return [
    ['POST', /^\/api\/cook\/login$/, async (req, res) => {
      const r = await limiters.login.take('cook:' + clientIp(req, cfg.trustProxy));
      if (!r.ok) throw new HttpError(429, 'rate_limited', { retryAfterSec: r.retryAfterSec });
      checkCsrf(req);
      const body = await readJson(req, 2 * 1024);
      // Second way into the admin panel: an admin username (has letters) instead of a phone number.
      const login = String(body.whatsapp || '').trim();
      // Letters (any language) = a name: the admin's username, or a shop that signed up without a WhatsApp number.
      const username = login.toLowerCase().replace(/\s+/g, '.');
      const admin = /\p{L}/u.test(login) ? await db.one('SELECT id, password_hash, mfa_required FROM admin_users WHERE LOWER(username) = $1 AND disabled = 0', [username]) : null;
      if (/\p{L}/u.test(login) && !admin) {
        const shop = await db.one(`SELECT id, password_hash FROM cooks WHERE name_norm = $1 AND whatsapp = '' AND status = 'approved' AND password_hash IS NOT NULL ORDER BY id DESC LIMIT 1`,
          [normalizeName(login)]);
        const okShop = await verifyPassword(String(body.password || ''), shop?.password_hash || DUMMY_HASH);
        if (!shop || !okShop) throw new HttpError(401, 'invalid_cook_credentials');
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': await sessions.create(shop.id) });
      }
      if (admin) {
        const okAdmin = await verifyPassword(String(body.password || ''), admin?.password_hash || DUMMY_HASH);
        const ipHash = hmacHex(cfg.sessionSecret, clientIp(req, cfg.trustProxy)).slice(0, 16);
        await db.query('INSERT INTO admin_logins (admin_id, username, ok, method, ip_hash, user_agent) VALUES ($1,$2,$3,$4,$5,$6)',
          [admin?.id || null, username.slice(0, 60), admin && okAdmin ? 1 : 0, 'account_page', ipHash, String(req.headers['user-agent'] || '').slice(0, 200)]).catch(() => {});
        if (!admin || !okAdmin) throw new HttpError(401, 'invalid_cook_credentials');
        // With a passkey required, finish on the admin page (fingerprint / backup code) — never skip the second step.
        if (Number(admin.mfa_required)) return sendJson(res, 200, { ok: true, admin: true, redirect: '/admin/' });
        await db.query('UPDATE admin_users SET last_login_at = $1 WHERE id = $2', [new Date().toISOString(), admin.id]);
        return sendJson(res, 200, { ok: true, admin: true, redirect: '/admin/' }, { 'Set-Cookie': await adminSessions.create(admin.id) });
      }
      const phone = normalizePhone(body.whatsapp, cfg.defaultCountry);
      const cook = phone
        ? await db.one(`SELECT id, password_hash FROM cooks WHERE whatsapp = $1 AND status = 'approved' AND password_hash IS NOT NULL AND parent_id IS NULL ORDER BY id DESC LIMIT 1`, [phone])
        : null;
      const ok = await verifyPassword(String(body.password || ''), cook?.password_hash || DUMMY_HASH);
      if (!cook || !ok) throw new HttpError(401, 'invalid_cook_credentials');
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': await sessions.create(cook.id) });
    }],

    ['POST', /^\/api\/cook\/logout$/, async (req, res) => {
      checkCsrf(req);
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': await sessions.destroy(req) });
    }],

    ['GET', /^\/api\/cook\/me$/, guard(async (req, res, m, cookId) => {
      cache?.clear?.('feed:');
      sendJson(res, 200, await me(cookId, pickLocale(req, cfg.locales)));
    })],

    ['GET', /^\/api\/cook\/photo$/, guard(async (req, res, m, cookId) => {
      const c = await db.one('SELECT photo, photo_url FROM cooks WHERE id = $1', [cookId]);
      if (c?.photo_url) return redirect(res, c.photo_url);
      sendPhoto(res, c?.photo);
    })],

    // She can edit her description, profile photo, what she cooks and where she delivers.
    // Name and WhatsApp number are changed by the admin only.
    // Google Play requirement: a subscriber can delete their own account from inside the app. Permanent (photos too).
    ['POST', /^\/api\/cook\/me\/delete$/, guard(async (req, res, m, cookId) => {
      await limiters.login?.check?.(clientIp(req, cfg.trustProxy));   // slows down password guessing
      const body = await readJson(req, 4 * 1024);
      const c = await db.one('SELECT id, full_name, password_hash, photo_url FROM cooks WHERE id = $1', [cookId]);
      if (!c) throw new HttpError(404, 'not_found');
      if (!(await verifyPassword(String(body.password || ''), c.password_hash || DUMMY_HASH))) throw new HttpError(401, 'invalid_cook_credentials');
      const photoUrls = (await db.query('SELECT url FROM cook_photos WHERE cook_id = $1 AND url IS NOT NULL', [cookId])).map((r) => r.url);
      await db.tx(async (q) => { await q.query('DELETE FROM cooks WHERE id = $1', [cookId]); });   // cascades to every related table
      for (const u of [c.photo_url, ...photoUrls]) await images?.remove?.(u);
      cache?.clear?.('feed:');
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': await sessions.destroy(req) });
    })],
    ['PATCH', /^\/api\/cook\/me$/, guard(async (req, res, m, cookId) => {
      const body = await readJson(req, 256 * 1024);
      const v = new Validator();
      const sets = {};
      if (body.bio !== undefined) sets.bio = v.text('bio', body.bio, { max: 300, required: false, multiline: true });
      if (body.allowDirections !== undefined) sets.allow_directions = body.allowDirections ? 1 : 0;
      if (body.booking !== undefined) sets.booking = body.booking ? 1 : 0;   // the add-on can be turned on later (billing by the owner)
      if (body.hours !== undefined) { const h = cleanHours(body.hours); if (h === undefined) v.fail('hours', 'invalid'); else sets.hours = h ? JSON.stringify(h) : null; }   // "directions" button for customers (shops)
      if (body.specialty !== undefined) sets.specialty = v.text('specialty', body.specialty, { min: 2, max: 120 });
      let newPhoto;
      if (body.photo !== undefined) newPhoto = validatePhoto(body.photo, v) ?? null;
      if (body.lat !== undefined || body.lng !== undefined) {
        const lat = v.number('location', body.lat, { min: -90, max: 90 });
        const lng = v.number('location', body.lng, { min: -180, max: 180 });
        if (lat != null && lng != null && isValidLatLng(lat, lng)) {
          const acc = body.accuracy == null ? null : Math.round(Number(body.accuracy));
          if (acc != null && acc > 150) v.fail('location', 'location_inaccurate');
          if (body.locationAt != null && Date.now() - Number(body.locationAt) > 10 * 60_000) v.fail('location', 'location_stale');
          v.assert();
          sets.lat = roundTo(lat, 5); sets.lng = roundTo(lng, 5);
          sets.location_accuracy_m = acc; sets.location_at = new Date().toISOString();
          sets.area_id = areas.nearest(lat, lng).id;
          const place = geo ? await geo.resolve(lat, lng) : { country: null };
          if (place.country) {
            sets.country = place.country;
            sets.region_key = place.regionKey || null; sets.region_name = place.regionName || null;
            sets.region_name_ar = place.regionNameAr || null; sets.region_name_en = place.regionNameEn || null;
            sets.addr_city = place.city || null; sets.addr_district = place.district || null; sets.addr_locality = place.locality || null;
          }
        } else v.fail('location', 'invalid');
      }
      if (body.areaLabel !== undefined) sets.area_label = v.text('areaLabel', body.areaLabel, { max: 80, required: false }) || null;
      let services, served;
      if (body.services !== undefined) {
        services = Array.isArray(body.services) ? [...new Set(body.services)].filter((s) => SERVICE_TYPES.includes(s)) : [];
        // Restaurants have a free-text specialty instead of service types.
        const kindNow = (await db.one('SELECT kind FROM cooks WHERE id = $1', [cookId]))?.kind;
        // service types are optional now (every category describes itself in its description)
      }
      if (body.servedAreaIds !== undefined) {
        served = Array.isArray(body.servedAreaIds) ? [...new Set(body.servedAreaIds.map(Number))].filter((id) => areas.get(id)).slice(0, 300) : [];
        if (!served.length) v.fail('servedAreaIds', 'pick_one_area');
      }
      v.assert();
      if (newPhoto !== undefined) {
        const old = await db.one('SELECT photo_url FROM cooks WHERE id = $1', [cookId]);
        const img = await images.save(`cooks/${cookId}`, newPhoto);
        sets.photo = img.data; sets.photo_url = img.url;
        await images.remove(old?.photo_url);
      }
      const cols = Object.keys(sets);
      if (cols.length) {
        await db.query(`UPDATE cooks SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = $${cols.length + 1} WHERE id = $${cols.length + 2}`,
          [...cols.map((k) => sets[k]), new Date().toISOString(), cookId]);
      }
      if (services) await setCookServices(db, cookId, services);
      if (served) await setServedAreas(db, cookId, served);
      cache?.clear?.('feed:');
      sendJson(res, 200, await me(cookId, pickLocale(req, cfg.locales)));
    })],

    ['POST', /^\/api\/cook\/password$/, guard(async (req, res, m, cookId) => {
      const body = await readJson(req, 2 * 1024);
      const row = await db.one('SELECT password_hash FROM cooks WHERE id = $1', [cookId]);
      if (!(await verifyPassword(String(body.current || ''), row.password_hash || DUMMY_HASH))) {
        throw new HttpError(422, 'validation_failed', { fields: { current: 'wrong_password' } });
      }
      const next = String(body.next || '');
      if (next.length < 6 || next.length > 100) throw new HttpError(422, 'validation_failed', { fields: { next: 'password_too_short' } });
      await db.query('UPDATE cooks SET password_hash = $1 WHERE id = $2', [await hashPassword(next), cookId]);
      sendJson(res, 200, { ok: true });
    })],

    ['POST', /^\/api\/cook\/photos$/, guard(async (req, res, m, cookId) => {
      const rl = await limiters.upload.take(`c${cookId}`);
      if (!rl.ok) throw new HttpError(429, 'rate_limited', { retryAfterSec: rl.retryAfterSec });
      const body = await readJson(req, 600 * 1024);
      const v = new Validator();
      const caption = v.text('caption', body.caption, { max: 80, required: false });
      const data = String(body.data || '');
      if (!imageBytesOk(data)) v.fail('data', 'invalid');
      else if (data.length > 550_000) v.fail('data', 'too_large');
      // optional small version for lists (made on the phone); only kept when images live on object storage
      const thumb = body.thumb && imageBytesOk(body.thumb) && String(body.thumb).length <= 120_000 ? String(body.thumb) : null;
      v.assert();
      const n = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cook_photos WHERE cook_id = $1', [cookId]);
      const k = (await db.one('SELECT kind FROM cooks WHERE id = $1', [cookId]))?.kind;
      if (n.n >= photoLimit(k)) throw new HttpError(409, 'too_many_photos');
      const img = await images.save(`dishes/${cookId}`, data);
      const th = images.external && thumb ? await images.save(`dishes/${cookId}/thumbs`, thumb) : { url: null };
      await db.query('INSERT INTO cook_photos (cook_id, data, url, thumb_url, caption) VALUES ($1,$2,$3,$4,$5)', [cookId, img.data || '', img.url, th.url, caption]);
      cache?.clear?.('feed:');
      sendJson(res, 201, await me(cookId, pickLocale(req, cfg.locales)));
    })],

    ['GET', /^\/api\/cook\/photos\/(\d+)\.jpg$/, guard(async (req, res, m, cookId) => {
      const p = await db.one('SELECT data, url FROM cook_photos WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      if (p?.url) return redirect(res, p.url);
      sendPhoto(res, p?.data);
    })],

    ['DELETE', /^\/api\/cook\/photos\/(\d+)$/, guard(async (req, res, m, cookId) => {
      const p = await db.one('SELECT url, thumb_url FROM cook_photos WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      await db.query('DELETE FROM cook_photos WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      await images.remove(p?.url);
      await images.remove(p?.thumb_url);
      cache?.clear?.('feed:');
      sendJson(res, 200, await me(cookId, pickLocale(req, cfg.locales)));
    })],

    /* ---------- product sections (the store's own, in its order) ---------- */
    ['PUT', /^\/api\/cook\/menu-sections$/, guard(async (req, res, m, cookId) => {
      const body = await readJson(req, 8 * 1024);
      const list = Array.isArray(body.sections) ? body.sections : null;
      if (!list || list.length > 40) throw new HttpError(422, 'validation_failed', { fields: { sections: 'invalid' } });
      const clean = [...new Set(list.map((x) => String(x || '').trim().slice(0, 40)).filter(Boolean))];
      const old = parseSections((await db.one('SELECT menu_sections FROM cooks WHERE id = $1', [cookId]))?.menu_sections);
      // renamed: { from, to } pairs move the products along; removed sections leave their products without a section
      for (const r of Array.isArray(body.renamed) ? body.renamed.slice(0, 40) : []) {
        const from = String(r?.from || '').trim(), to = String(r?.to || '').trim().slice(0, 40);
        if (from && to) await db.query('UPDATE menu_items SET section = $1 WHERE cook_id = $2 AND section = $3', [to, cookId, from]);
      }
      for (const gone of old.filter((x) => !clean.includes(x) && !(body.renamed || []).some((r) => r?.from === x))) await db.query('UPDATE menu_items SET section = NULL WHERE cook_id = $1 AND section = $2', [cookId, gone]);
      await db.query('UPDATE cooks SET menu_sections = $1 WHERE id = $2', [JSON.stringify(clean), cookId]);
      cache?.clear?.('feed:');
      sendJson(res, 200, await me(cookId, pickLocale(req, cfg.locales)));
    })],

    /* ---------- restaurant menu ---------- */
    ['POST', /^\/api\/cook\/menu$/, guard(async (req, res, m, cookId) => {
      const me0 = await db.one('SELECT kind, country FROM cooks WHERE id = $1', [cookId]);
      const body = await readJson(req, 600 * 1024);   // with an optional product photo
      const v = new Validator();
      const name = v.text('name', body.name, { min: 1, max: 80 });
      const description = v.text('description', body.description, { max: 200, required: false });
      const price = body.price === '' || body.price == null ? null : v.number('price', body.price, { min: 0, max: 1000000 });
      const section = v.text('section', body.section, { max: 40, required: false }) || null;
      const photo = productPhoto(v, body.photo);
      v.assert();
      const n = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM menu_items WHERE cook_id = $1', [cookId]);
      if (n.n >= menuLimit()) throw new HttpError(409, 'too_many_items');
      const currency = getCountry(me0.country)?.currency || 'USD';
      await db.query('INSERT INTO menu_items (cook_id, name, description, price, currency, sort_order, section, photo_mime, photo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [cookId, name, description, price, currency, n.n, section, photo?.mime || null, photo?.data || null]);
      if (section) await addSection(cookId, section);
      cache?.clear?.('feed:');
      sendJson(res, 201, await me(cookId, pickLocale(req, cfg.locales)));
    })],
    ['PATCH', /^\/api\/cook\/menu\/(\d+)$/, guard(async (req, res, m, cookId) => {
      const body = await readJson(req, 600 * 1024);
      const v = new Validator();
      const sets = {};
      if (body.name !== undefined) sets.name = v.text('name', body.name, { min: 1, max: 80 });
      if (body.description !== undefined) sets.description = v.text('description', body.description, { max: 200, required: false });
      if (body.price !== undefined) sets.price = body.price === '' || body.price == null ? null : v.number('price', body.price, { min: 0, max: 1000000 });
      if (body.available !== undefined) sets.is_available = body.available ? 1 : 0;
      if (body.section !== undefined) sets.section = v.text('section', body.section, { max: 40, required: false }) || null;
      if (body.photo === null) { sets.photo = null; sets.photo_mime = null; }
      else if (body.photo !== undefined) { const ph = productPhoto(v, body.photo); if (ph) { sets.photo = ph.data; sets.photo_mime = ph.mime; } }
      v.assert();
      if (sets.section) await addSection(cookId, sets.section);
      const keys = Object.keys(sets);
      if (keys.length) {
        await db.query(`UPDATE menu_items SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} AND cook_id = $${keys.length + 2}`,
          [...keys.map((k) => sets[k]), Number(m[1]), cookId]);
      }
      cache?.clear?.('feed:');
      sendJson(res, 200, await me(cookId, pickLocale(req, cfg.locales)));
    })],
    ['DELETE', /^\/api\/cook\/menu\/(\d+)$/, guard(async (req, res, m, cookId) => {
      await db.query('DELETE FROM menu_items WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      cache?.clear?.('feed:');
      sendJson(res, 200, await me(cookId, pickLocale(req, cfg.locales)));
    })],

    /* ---------- contact the admin (support thread, shown in the admin panel) ---------- */
    ['GET', /^\/api\/cook\/support$/, guard(async (req, res, m, cookId) => {
      const rows = await db.query('SELECT id, from_admin, body, created_at FROM support_messages WHERE cook_id = $1 ORDER BY created_at, id', [cookId]);
      await db.query('UPDATE support_messages SET read_by_cook = 1 WHERE cook_id = $1 AND from_admin = 1 AND read_by_cook = 0', [cookId]);
      sendJson(res, 200, { messages: rows.map((r) => ({ id: r.id, fromAdmin: !!Number(r.from_admin), body: r.body, createdAt: r.created_at })) });
    })],
    ['POST', /^\/api\/cook\/support$/, guard(async (req, res, m, cookId) => {
      const r = await limiters.feedback.take('support:' + cookId);
      if (!r.ok) throw new HttpError(429, 'rate_limited', { retryAfterSec: r.retryAfterSec });
      const body = await readJson(req, 8 * 1024);
      const v = new Validator();
      const text = v.text('body', body.body, { min: 2, max: 2000, multiline: true });
      v.assert();
      await db.query('INSERT INTO support_messages (cook_id, from_admin, body, read_by_cook) VALUES ($1, 0, $2, 1)', [cookId, text]);
      sendJson(res, 201, { ok: true });
    })],
  ];
}
