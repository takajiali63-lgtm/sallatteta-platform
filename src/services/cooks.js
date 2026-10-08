import { GEOG } from '../db/postgis.js';
import { isCraft, isPrivateKind } from './categories.js';
import { isOpenNow } from '../lib/hours.js';
import { getCountry } from '../lib/countries.js';
import { haversineKm, roundTo } from '../lib/geo.js';
import { normalizeName } from '../../public/assets/normalize.js';
import { PLANS, GOVERNORATES } from '../db/seed-data.js';

export const SUBSCRIPTION_STATUSES = ['pending', 'active', 'expired', 'suspended'];
export const PAYMENT_STATUSES = ['unpaid', 'paid', 'waived'];
export const PLAN_KEYS = Object.keys(PLANS);


const nowIso = () => new Date().toISOString();
const iso = (d) => (d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

/** Cook is approved and has a subscription active right now. $1 = now. */
export const VISIBLE_SQL = `c.status = 'approved' AND c.is_hidden = 0 AND EXISTS (
  SELECT 1 FROM subscriptions s WHERE s.cook_id = COALESCE(c.parent_id, c.id) AND s.status = 'active'
  AND s.start_date <= $1 AND s.expiry_date > $1)`;

const placeholders = (n, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(',');

/* ---------------- shared lookups ---------------- */

export async function serviceKeysFor(db, ids) {
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = await db.query(
    `SELECT cst.cook_id, st.key FROM cook_service_types cst JOIN service_types st ON st.id = cst.service_type_id
     WHERE cst.cook_id IN (${placeholders(ids.length)}) ORDER BY st.sort_order`, ids);
  for (const r of rows) map.get(r.cook_id)?.push(r.key);
  return map;
}

export async function ratingsFor(db, ids) {
  const map = new Map(ids.map((id) => [id, { avg: null, count: 0 }]));
  if (!ids.length) return map;
  const rows = await db.query(
    `SELECT cook_id, CAST(COUNT(*) AS INTEGER) AS n, AVG(rating) AS avg FROM reviews
     WHERE is_hidden = 0 AND cook_id IN (${placeholders(ids.length)}) GROUP BY cook_id`, ids);
  for (const r of rows) map.set(r.cook_id, { avg: roundTo(Number(r.avg), 1), count: r.n });
  return map;
}

export async function likesFor(db, ids) {
  const map = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return map;
  const rows = await db.query(
    `SELECT cook_id, CAST(COUNT(*) AS INTEGER) AS n FROM cook_likes WHERE cook_id IN (${placeholders(ids.length)}) GROUP BY cook_id`, ids);
  for (const r of rows) map.set(r.cook_id, r.n);
  return map;
}

export async function servedAreaIds(db, cookId) {
  return (await db.query('SELECT area_id FROM cook_service_areas WHERE cook_id = $1', [cookId])).map((r) => r.area_id);
}

export async function setServedAreas(db, cookId, areaIds) {
  await db.query('DELETE FROM cook_service_areas WHERE cook_id = $1', [cookId]);
  for (const id of areaIds) {
    await db.query('INSERT INTO cook_service_areas (cook_id, area_id) VALUES (CAST($1 AS INTEGER), CAST($2 AS INTEGER)) ON CONFLICT DO NOTHING', [cookId, id]);
  }
}

export async function setCookServices(db, cookId, keys) {
  await db.query('DELETE FROM cook_service_types WHERE cook_id = $1', [cookId]);
  for (const key of keys) {
    await db.query(
      `INSERT INTO cook_service_types (cook_id, service_type_id)
       SELECT CAST($1 AS INTEGER), id FROM service_types WHERE key = $2 ON CONFLICT DO NOTHING`, [cookId, key]);
  }
}

/** Public card for a cook — never includes phone number or exact coordinates. */
async function cards(db, rows, areas, locale, extra = () => ({})) {
  const ids = rows.map((r) => r.id);
  const [services, ratings] = await Promise.all([serviceKeysFor(db, ids), ratingsFor(db, ids)]);
  return rows.map((r) => ({
    id: r.id,
    name: r.full_name,
    kind: r.kind || 'cook',
    specialty: r.specialty || '',
    area: r.area_label || areas.view(areas.get(r.area_id), locale)?.name,
    services: services.get(r.id) || [],
    bio: r.bio || '',
    photoUrl: r.photo_url || (Number(r.has_photo) ? `/media/cooks/${r.id}.jpg?v=${Date.parse(r.updated_at) || 0}` : null),
    rating: ratings.get(r.id),
    profileUrl: `/c/${r.id}`,
    subscriptionStatus: 'active',
    // what the customer can do — each one optional: order on WhatsApp, call (landline), get directions
    canOrder: r.has_wa === undefined ? true : !!Number(r.has_wa),
    callPhone: r.call_phone || (isCraft(r.kind) && r.wa_raw ? r.wa_raw : null),   // craftspeople want calls
    // directions only for shops (never a home cook's house) that allow it
    // directions: a basic feature for every shop with a location (never a home cook's house)
    nav: !isPrivateKind(r.kind) && r.lat != null && r.lng != null
      ? { lat: roundTo(Number(r.lat), 5), lng: roundTo(Number(r.lng), 5) } : null,
    fromMap: r.source === 'map',
    verified: !!Number(r.verified || 0),   // ✓ paying subscriber
    booking: !!Number(r.booking || 0),
    // opening hours (in the subscriber's own time zone): openNow true/false, or null when not set
    ...((() => { let h = null; try { h = r.hours ? JSON.parse(r.hours) : null; } catch { /* ignore */ }
      return { hours: h, openNow: isOpenNow(h, getCountry(r.cc || 'LB')?.timezone || 'Asia/Beirut') }; })()),
    ...extra(r),
  }));
}

export const KINDS = ['cook', 'restaurant'];   // the two original categories (others come from the admin's category list)
const kindOf = (k) => (/^[a-z][a-z0-9_]{1,30}$/.test(String(k || '')) ? String(k) : 'cook');
const CARD_COLS = `c.id, c.full_name, c.kind, c.specialty, c.area_id, c.area_label, c.lat, c.lng, c.bio, c.photo_url, c.updated_at,
  CASE WHEN c.photo IS NULL THEN 0 ELSE 1 END AS has_photo, CASE WHEN c.whatsapp <> '' THEN 1 ELSE 0 END AS has_wa,
  c.call_phone, c.allow_directions, c.source, c.whatsapp AS wa_raw, c.verified, c.hours, c.country AS cc, c.booking`;

/**
 * Active cooks who deliver to any of the customer's villages (areaIds), nearest first.
 * point = customer's position (GPS, or the village centre).
 */
export async function searchCooksForArea(db, areas, { areaIds = [], radiusKm = null, point, serviceType = null, kind = 'cook', locale = 'ar', limit = 30, now = nowIso(), country = null }) {
  const ids = [...new Set((areaIds || []).map(Number))].filter(Boolean);
  if (!ids.length && !radiusKm) return [];
  const params = [now];
  let geoSql;
  if (radiusKm) {
    // everything within radiusKm of the customer (straight-line pre-filter; road distance is checked afterwards)
    const dLat = radiusKm / 111.32, dLng = radiusKm / (111.32 * Math.max(0.05, Math.cos((Number(point.lat) * Math.PI) / 180)));
    params.push(point.lat - dLat, point.lat + dLat, point.lng - dLng, point.lng + dLng);
    geoSql = ` AND c.lat BETWEEN $2 AND $3 AND c.lng BETWEEN $4 AND $5`;
  } else {
    params.push(...ids);
    geoSql = ` AND EXISTS (SELECT 1 FROM cook_service_areas csa WHERE csa.cook_id = c.id AND csa.area_id IN (${placeholders(ids.length, 2)}))`;
  }
  // kind 'all' = every category ("everything near me")
  let kindSql = '';
  if (kind !== 'all') { params.push(kindOf(kind)); kindSql = ` AND c.kind = $${params.length}`; }
  if (country) { params.push(String(country).toUpperCase()); kindSql += ` AND COALESCE(c.country, 'LB') = $${params.length}`; }   // never across a border
  let sql = `SELECT ${CARD_COLS} FROM cooks c WHERE ${VISIBLE_SQL}${kindSql}${geoSql}`;
  if (serviceType) {
    params.push(serviceType);
    sql += ` AND EXISTS (SELECT 1 FROM cook_service_types cst JOIN service_types st ON st.id = cst.service_type_id
             WHERE cst.cook_id = c.id AND st.key = $${params.length})`;
  }
  // Bounded: the database orders by approximate distance and returns at most 300 candidates
  // (a dense city with thousands of subscribers never loads them all); exact metres are computed below.
  const cap = Math.max(limit, 300);
  const planar = () => {
    const pr = [...params, Number(point.lat), Number(point.lng), Math.cos((Number(point.lat) * Math.PI) / 180) || 1];
    const [a, b, k] = [pr.length - 2, pr.length - 1, pr.length];
    return [`${sql} ORDER BY CASE WHEN c.lat IS NULL OR c.lng IS NULL THEN 1 ELSE 0 END,
      ((c.lat - $${a}) * (c.lat - $${a}) + ((c.lng - $${b}) * $${k}) * ((c.lng - $${b}) * $${k})), c.id LIMIT ${cap}`, pr];
  };
  // PostGIS (when enabled): nearest-first straight from the spatial GiST index (KNN). Any failure → regular query.
  const spatial = () => {
    const pr = [...params, Number(point.lng), Number(point.lat)];
    return [`${sql} ORDER BY ${GEOG} <-> ST_SetSRID(ST_MakePoint($${pr.length - 1}, $${pr.length}), 4326)::geography, c.id LIMIT ${cap}`, pr];
  };
  let found;
  if (db.postgis) {
    try { found = await db.query(...spatial()); } catch (e) {
      db.postgis = false;   // never retry a broken spatial path; the regular search takes over immediately
      console.warn?.(`[postgis] spatial search failed, using the regular search: ${e.message}`);
    }
  }
  if (!found) found = await db.query(...planar());
  const rows = found
    .map((r) => ({ ...r, distance: haversineKm(point.lat, point.lng, r.lat, r.lng) }))
    .filter((r) => !radiusKm || r.distance <= radiusKm)
    .sort((a, b) => a.distance - b.distance || a.full_name.localeCompare(b.full_name, 'ar'))
    .slice(0, limit);
  // `straightM` is kept: the route endpoint may replace distanceM with the road distance
  return cards(db, rows, areas, locale, (r) => ({ distanceKm: roundTo(r.distance, 1), distanceM: Math.round(r.distance * 1000), straightM: Math.round(r.distance * 1000), distanceKind: 'straight' }));
}

/** Find an active cook by name (customers who want to order again from "their" cook). */
export async function searchCooksByName(db, areas, q, { locale = 'ar', limit = 10, kind = null, country = null, now = nowIso() } = {}) {
  const n = normalizeName(q);
  if (n.length < 2) return [];
  const params = [now, `%${n.replace(/[%_]/g, '')}%`];
  let extra = '';
  if (kind) { params.push(kindOf(kind)); extra += ` AND c.kind = $${params.length}`; }
  if (country) { params.push(country); extra += ` AND COALESCE(c.country, 'LB') = $${params.length}`; }
  const rows = await db.query(
    `SELECT ${CARD_COLS} FROM cooks c WHERE ${VISIBLE_SQL} AND c.name_norm LIKE $2${extra} ORDER BY c.full_name LIMIT ${Number(limit) | 0}`,
    params);
  return cards(db, rows, areas, locale);
}

/** Home-page sliders: latest dish photos + featured cooks. */
export async function homeFeed(db, areas, { locale = 'ar', country = null, now = nowIso() } = {}) {
  // every visitor sees ONE country (never a mix): unknown → the platform's default country
  country = country || process.env.DEFAULT_COUNTRY || 'LB';
  const cc = ` AND COALESCE(c.country, 'LB') = $2`;
  const P = [now, country];
  const photos = await db.query(
    `SELECT p.id, p.caption, p.url, p.thumb_url, p.cook_id, c.full_name, c.area_id, c.area_label FROM cook_photos p JOIN cooks c ON c.id = p.cook_id
     WHERE p.is_hidden = 0 AND ${VISIBLE_SQL}${cc} ORDER BY p.created_at DESC, p.id DESC LIMIT 12`, P);
  const cookRows = await db.query(`SELECT ${CARD_COLS} FROM cooks c WHERE ${VISIBLE_SQL} AND c.kind = 'cook'${cc} ORDER BY c.id DESC LIMIT 40`, P);
  const restPhotos = await db.query(
    `SELECT p.id, p.caption, p.url, p.cook_id, c.full_name, c.area_id, c.area_label FROM cook_photos p JOIN cooks c ON c.id = p.cook_id
     WHERE p.is_hidden = 0 AND c.kind = 'restaurant' AND ${VISIBLE_SQL}${cc} ORDER BY p.created_at DESC, p.id DESC LIMIT 15`, P);
  const cookCards = await cards(db, cookRows, areas, locale);
  cookCards.sort((a, b) => (b.rating.count - a.rating.count) || ((b.rating.avg || 0) - (a.rating.avg || 0)));
  return {
    dishes: photos.map((p) => ({
      photoUrl: p.thumb_url || p.url || `/media/photos/${p.id}.jpg`,
      fullUrl: p.url || `/media/photos/${p.id}.jpg`,
      caption: p.caption || '',
      cookId: p.cook_id,
      cookName: p.full_name,
      area: areas.view(areas.get(p.area_id), locale)?.name || p.area_label,
      profileUrl: `/c/${p.cook_id}`,
    })),
    cooks: cookCards.slice(0, 12),
    // Restaurant subscribers for the slider under "find a restaurant near you": their photo, or their latest dish photo.
    restaurants: await (async () => {
      const rows = await db.query(`SELECT ${CARD_COLS} FROM cooks c WHERE ${VISIBLE_SQL} AND c.kind = 'restaurant'${cc} ORDER BY c.id DESC LIMIT 20`, P);
      if (!rows.length) return [];
      const list = await cards(db, rows, areas, locale);
      const covers = new Map((await db.query(
        `SELECT p.cook_id, MAX(p.id) AS pid FROM cook_photos p WHERE p.is_hidden = 0 AND p.cook_id IN (${rows.map((_, i) => `$${i + 1}`).join(',')}) GROUP BY p.cook_id`,
        rows.map((r) => r.id))).map((r) => [r.cook_id, r.pid]));
      const urls = new Map((await db.query(`SELECT id, url FROM cook_photos WHERE id IN (${[...covers.values()].map((_, i) => `$${i + 1}`).join(',') || 'NULL'})`, [...covers.values()])).map((r) => [r.id, r.url]));
      return list.map((c) => {
        const pid = covers.get(c.id);
        const dish = pid ? (urls.get(pid) || `/media/photos/${pid}.jpg`) : null;
        return { ...c, cover: dish || c.photoUrl || null };
      });
    })(),
    // Small photo strips under each category on the home page: one card per subscriber (latest photo, else profile photo).
    byKind: await (async () => {
      const rows = await db.query(`SELECT ${CARD_COLS} FROM cooks c WHERE ${VISIBLE_SQL}${cc} ORDER BY c.id DESC LIMIT 400`, P);
      if (!rows.length) return {};
      const list = await cards(db, rows, areas, locale);
      const ids = rows.map((r) => r.id);
      const last = new Map((await db.query(
        `SELECT cook_id, MAX(id) AS pid FROM cook_photos WHERE is_hidden = 0 AND cook_id IN (${ids.map((_, i) => `$${i + 1}`).join(',')}) GROUP BY cook_id`, ids))
        .map((r) => [r.cook_id, r.pid]));
      const pids = [...last.values()];
      const urls = new Map(pids.length ? (await db.query(`SELECT id, url FROM cook_photos WHERE id IN (${pids.map((_, i) => `$${i + 1}`).join(',')})`, pids)).map((r) => [r.id, r.url]) : []);
      const out = {};
      for (const c of list) {
        const k = c.kind || 'cook';
        if ((out[k] ||= []).length >= 12) continue;
        const pid = last.get(c.id);
        out[k].push({ id: c.id, name: c.name, profileUrl: c.profileUrl, img: pid ? (urls.get(pid) || `/media/photos/${pid}.jpg`) : c.photoUrl || null });
      }
      return out;
    })(),
    restaurantPhotos: restPhotos.map((p) => ({
      photoUrl: p.url || `/media/photos/${p.id}.jpg`,
      caption: p.caption || '',
      restaurantId: p.cook_id,
      restaurantName: p.full_name,
      area: p.area_label || areas.view(areas.get(p.area_id), locale)?.name,
      profileUrl: `/c/${p.cook_id}`,
    })),
  };
}

/** Public profile page data. Returns null if the cook is not currently active. */
export async function publicProfile(db, areas, cookId, { locale = 'ar', now = nowIso() } = {}) {
  const row = await db.one(`SELECT ${CARD_COLS} FROM cooks c WHERE c.id = $2 AND ${VISIBLE_SQL}`, [now, cookId]);
  if (!row) return null;
  const [card] = await cards(db, [row], areas, locale);
  const served = (await servedAreaIds(db, cookId)).map((id) => areas.view(areas.get(id), locale)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  const photos = await db.query('SELECT id, caption, url FROM cook_photos WHERE cook_id = $1 AND is_hidden = 0 ORDER BY created_at DESC, id DESC', [cookId]);
  const likes = (await likesFor(db, [cookId])).get(cookId);
  const menu = true   // every category (cooks included) can have a menu / price list
    ? (await db.query('SELECT id, name, description, price, currency FROM menu_items WHERE cook_id = $1 AND is_available = 1 ORDER BY sort_order, id', [cookId]))
      .map((m) => ({ id: m.id, name: m.name, description: m.description || '', price: m.price == null ? null : Number(m.price), currency: m.currency || null }))
    : [];
  return {
    ...card,
    menu,
    servedAreas: served.map((a) => ({ id: a.id, name: a.name })),
    photos: photos.map((p) => ({ id: p.id, url: p.url || `/media/photos/${p.id}.jpg`, caption: p.caption || '' })),
    likes,
  };
}

export async function isCookVisible(db, cookId, now = nowIso()) {
  return !!(await db.one(`SELECT c.id FROM cooks c WHERE c.id = $2 AND ${VISIBLE_SQL}`, [now, cookId]));
}

/** Numbers the cook sees in her account. */
export async function cookStats(db, cookId) {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const s = await db.one(
    `SELECT
      (SELECT CAST(COUNT(*) AS INTEGER) FROM cook_page_views WHERE cook_id = $1) AS views_total,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM cook_page_views WHERE cook_id = $1 AND created_at >= $2) AS views_30d,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM cook_likes WHERE cook_id = $1) AS likes,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM request_impressions WHERE cook_id = $1) AS impressions_total,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM request_impressions WHERE cook_id = $1 AND created_at >= $2) AS impressions_30d,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM request_contact_events WHERE cook_id = $1) AS whatsapp_total,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM request_contact_events WHERE cook_id = $1 AND created_at >= $2) AS whatsapp_30d,
      (SELECT CAST(COUNT(*) AS INTEGER) FROM booking_events WHERE cook_id = $1 AND created_at >= $2) AS bookings_30d`,
    [cookId, since]);
  const rating = (await ratingsFor(db, [cookId])).get(cookId);
  return { ...s, rating };
}

/* ---------------- status & subscriptions ---------------- */

export function effectiveStatus(cook, sub, now = new Date()) {
  if (cook.status === 'rejected') return 'rejected';
  if (!sub) return cook.status === 'pending' ? 'pending' : 'no_subscription';
  if (sub.status === 'active') {
    if (!sub.expiry_date || new Date(sub.expiry_date) <= now) return 'expired';
    if (sub.start_date && new Date(sub.start_date) > now) return 'scheduled';
    return cook.status === 'approved' ? 'active' : 'pending';
  }
  return sub.status;
}

export async function expireSubscriptions(db, now = nowIso()) {
  const rows = await db.query(
    `UPDATE subscriptions SET status = 'expired', updated_at = $1 WHERE status = 'active' AND expiry_date <= $1 RETURNING id`, [now]);
  return rows.length;
}

export async function latestSubscription(db, cookId) {
  return db.one('SELECT * FROM subscriptions WHERE cook_id = $1 ORDER BY id DESC LIMIT 1', [cookId]);
}

export async function logAdminAction(db, adminId, cookId, action, details = null) {
  await db.query('INSERT INTO admin_actions (admin_id, cook_id, action, details) VALUES ($1,$2,$3,$4)',
    [adminId, cookId, action, details ? JSON.stringify(details) : null]);
}

export async function activateSubscription(db, cookId, { plan, startDate, expiryDate, paymentStatus }) {
  const start = startDate ? new Date(startDate) : new Date();
  const expiry = expiryDate ? new Date(expiryDate) : addMonths(start, PLANS[plan]);
  if (expiry <= start) throw Object.assign(new Error('expiry_before_start'), { code: 'expiry_before_start' });
  const now = nowIso();
  const latest = await latestSubscription(db, cookId);
  if (latest) {
    await db.query(
      `UPDATE subscriptions SET plan=$1, status='active', payment_status=$2, start_date=$3, expiry_date=$4, updated_at=$5 WHERE id=$6`,
      [plan, paymentStatus, iso(start), iso(expiry), now, latest.id]);
  } else {
    await db.query(
      `INSERT INTO subscriptions (cook_id, plan, status, payment_status, start_date, expiry_date) VALUES ($1,$2,'active',$3,$4,$5)`,
      [cookId, plan, paymentStatus, iso(start), iso(expiry)]);
  }
  await db.query(`UPDATE cooks SET status='approved', updated_at=$1 WHERE id=$2`, [now, cookId]);
  return latestSubscription(db, cookId);
}

export async function renewSubscription(db, cookId, { plan, months, paymentStatus }) {
  const latest = await latestSubscription(db, cookId);
  const add = months || PLANS[plan];
  const nowD = new Date();
  const running = latest && latest.status === 'active' && latest.expiry_date && new Date(latest.expiry_date) > nowD;
  const base = running ? new Date(latest.expiry_date) : nowD;
  const start = running ? new Date(latest.start_date) : nowD;
  return activateSubscription(db, cookId, {
    plan: plan || latest?.plan || 'monthly',
    startDate: start,
    expiryDate: addMonths(base, add),
    paymentStatus: paymentStatus || latest?.payment_status || 'paid',
  });
}

export async function setSubscriptionStatus(db, cookId, status) {
  const latest = await latestSubscription(db, cookId);
  if (!latest) return null;
  await db.query('UPDATE subscriptions SET status=$1, updated_at=$2 WHERE id=$3', [status, nowIso(), latest.id]);
  return latestSubscription(db, cookId);
}

export async function updateSubscriptionFields(db, cookId, fields) {
  const latest = await latestSubscription(db, cookId);
  if (!latest) return null;
  const next = {
    plan: fields.plan ?? latest.plan,
    payment_status: fields.paymentStatus ?? latest.payment_status,
    start_date: fields.startDate ? iso(fields.startDate) : latest.start_date,
    expiry_date: fields.expiryDate ? iso(fields.expiryDate) : latest.expiry_date,
    status: fields.status ?? latest.status,
    notes: fields.notes !== undefined ? fields.notes : latest.notes,
  };
  await db.query(
    `UPDATE subscriptions SET plan=$1, payment_status=$2, start_date=$3, expiry_date=$4, status=$5, notes=$6, updated_at=$7 WHERE id=$8`,
    [next.plan, next.payment_status, iso(next.start_date), iso(next.expiry_date), next.status, next.notes, nowIso(), latest.id]);
  return latestSubscription(db, cookId);
}

/** Active cooks grouped by governorate (from the cook's home village district), for "cooks by region". */
export async function cooksByRegion(db, areas, { country = 'LB', kind = 'cook', locale = 'ar', now = nowIso() } = {}) {
  const rows = await db.query(
    `SELECT ${CARD_COLS}, c.region_key, c.region_name, c.region_name_ar, c.region_name_en FROM cooks c
     WHERE ${VISIBLE_SQL} AND COALESCE(c.country, 'LB') = $2 AND c.kind = $3 ORDER BY c.full_name`, [now, country, kindOf(kind)]);
  const list = await cards(db, rows, areas, locale);
  const govs = GOVERNORATES[country];
  const other = { key: 'other', name: null, cooks: [] };
  if (govs) {
    // Countries with a built-in list (Lebanon): fixed order, every governorate shown.
    const byDistrict = new Map();
    for (const g of govs) for (const d of g.districts) byDistrict.set(d, g.key);
    const groups = new Map(govs.map((g) => [g.key, { key: g.key, name: locale === 'ar' ? g.ar : g.en, cooks: [] }]));
    rows.forEach((r, i) => {
      const g = groups.get(byDistrict.get(areas.get(r.area_id)?.district));
      (g || other).cooks.push(list[i]);
    });
    const out = [...groups.values()];
    if (other.cooks.length) out.push(other);
    return out;
  }
  // Any other country: regions learnt automatically from the map, alphabetical.
  const groups = new Map();
  rows.forEach((r, i) => {
    if (!r.region_key) { other.cooks.push(list[i]); return; }
    const name = (locale === 'ar' && r.region_name_ar) || (locale !== 'ar' && r.region_name_en) || r.region_name;
    if (!groups.has(r.region_key)) groups.set(r.region_key, { key: r.region_key, name, cooks: [] });
    groups.get(r.region_key).cooks.push(list[i]);
  });
  const out = [...groups.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (other.cooks.length) out.push(other);
  return out;
}

/** Dish photos of active cooks, newest first, `limit` at a time (for the "dish photos" page). */
export async function dishPhotos(db, areas, { offset = 0, limit = 10, locale = 'ar', country = null, now = nowIso() } = {}) {
  const lim = Math.min(30, Math.max(1, Number(limit) || 10));
  const off = Math.max(0, Number(offset) || 0);
  const rows = await db.query(
    `SELECT p.id, p.caption, p.url, p.cook_id, c.full_name, c.kind, c.area_id, c.area_label FROM cook_photos p JOIN cooks c ON c.id = p.cook_id
     WHERE p.is_hidden = 0 AND ${VISIBLE_SQL}${country ? ` AND COALESCE(c.country, 'LB') = $2` : ''} ORDER BY p.created_at DESC, p.id DESC LIMIT ${lim + 1} OFFSET ${off}`, country ? [now, country] : [now]);
  const more = rows.length > lim;
  return {
    dishes: rows.slice(0, lim).map((p) => ({
      id: p.id,
      photoUrl: p.url || `/media/photos/${p.id}.jpg`,
      caption: p.caption || '',
      cookId: p.cook_id,
      cookName: p.full_name,
      kind: p.kind || 'cook',
      area: p.area_label || areas.view(areas.get(p.area_id), locale)?.name,
      profileUrl: `/c/${p.cook_id}`,
    })),
    offset: off,
    hasMore: more,
  };
}
