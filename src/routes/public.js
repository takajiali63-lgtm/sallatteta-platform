import { DESIGNS, designCss } from '../services/designs.js';
import { HttpError, readJson, sendJson } from '../lib/http.js';
import { Validator, validatePhoto } from '../lib/validate.js';
import { isValidLatLng, roundTo, haversineKm } from '../lib/geo.js';
import { normalizePhone, fillTemplate } from '../lib/whatsapp.js';
import { publicCountry, getCountry, COUNTRIES } from '../lib/countries.js';
import { randomToken, hmacHex, clientIp } from '../lib/security.js';
import { t, pickLocale } from '../lib/i18n.js';
import {
  searchCooksForArea, searchCooksByName, homeFeed, publicProfile, isCookVisible,
  setCookServices, setServedAreas, PLAN_KEYS, cooksByRegion, dishPhotos,
  VISIBLE_SQL,
} from '../services/cooks.js';
import { ensurePlacesAround } from '../services/osm.js';
import { createPlacesFetcher } from '../services/placeProviders.js';
import { priceFor, formatPrice, billingCurrency } from '../services/pricing.js';
import { formatDistance } from '../lib/distance.js';
import { sendText } from '../lib/http.js';
import { themeCss } from '../services/theme.js';
import { KEY_RE, activeKinds, nameOf } from '../services/categories.js';
import { withRoadDistances, roadDistances, ROUTE_BATCH } from '../services/routing.js';
import { referrerFor } from '../services/referrals.js';
import { cleanHours } from '../lib/hours.js';
import { isPrivateKind, isCraft, groupOf } from '../services/categories.js';
export const AD_PLACEMENTS = ['home_top', 'home_middle', 'home_bottom', 'results_top', 'browse_top', 'cook_page', 'join_top'];
import { COUNTRY_TIMEZONES } from '../lib/countries.js';
import { normalizeName } from '../../public/assets/normalize.js';
import { hashPassword } from '../lib/security.js';
import { dayInfo } from '../lib/day.js';
import { SERVICE_TYPES, MAX_PHOTOS_PER_COOK } from '../db/seed-data.js';

const MIN_FORM_MS = 1500;
export const TERMS_VERSION = '2026-10-07';
const REVIEW_WINDOW_DAYS = 60;

function antiSpam(body) {
  if (body.website) throw new HttpError(400, 'rejected'); // honeypot
  const started = Number(body.startedAt);
  if (Number.isFinite(started) && Date.now() - started < MIN_FORM_MS) throw new HttpError(400, 'too_fast');
}

// a country hidden by the owner, or a category hidden in one country only
function hiddenHere(settings, country) {
  const st = settings?.get() || {};
  const cc = String(country || '').toUpperCase();
  return { country: (st.countriesHidden || []).includes(cc), kinds: new Set(st.countryCatsHidden?.[cc] || []) };
}

export function publicRoutes({ db, cfg, limiters, areas, images, cache, channel, settings, geo }) {
  const ip = (req) => clientIp(req, cfg.trustProxy);
  const limit = async (limiter, req) => {
    const r = await limiter.take(ip(req));
    if (!r.ok) throw new HttpError(429, 'rate_limited', { retryAfterSec: r.retryAfterSec });
  };
  const viewerHash = (id) => {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(id || ''))) throw new HttpError(422, 'validation_failed', { fields: { viewerId: 'invalid' } });
    return hmacHex(cfg.sessionSecret, `viewer:${id}`);
  };
  const cookIdFrom = (m) => Number(m[1]);
  const placesOpts = { fetcher: cfg.placesFetcher, log: cfg.quiet ? {} : console };
  const placesFetcher = placesOpts.fetcher || createPlacesFetcher(cfg, { log: placesOpts.log });
  const withPlaces = (lat, lng, country = null) => ensurePlacesAround(db, areas, lat, lng, { km: 15, fetcher: placesFetcher, log: placesOpts.log, country });

  /** Saves a customer request and the cooks shown for it; returns its public id. */
  /** The customer's area name: neighbourhood/village from the map (cached per ~1 km), else the nearest known village. */
  async function customerPlace(point, area, locale) {
    // Never make the customer wait for the map service: 400 ms max (GEO_SEARCH_WAIT_MS), then our nearest village;
    // the lookup finishes in the background and is cached for the whole ~1 km cell.
    const where = await geo.resolve(point.lat, point.lng, { wait: Number(process.env.GEO_SEARCH_WAIT_MS) || 400 });
    const label = where.locality || where.district || (area ? areas.view(area, locale).name : null) || where.city || '-';
    return { where, label: String(label).slice(0, 80) };
  }
  /** Subscriber's GPS fix: refuse a reading worse than 150 m or older than 10 minutes. API clients without these fields are accepted. */
  function gpsFix(v, body) {
    const accuracy = body.accuracy == null || body.accuracy === '' ? null : Math.round(Number(body.accuracy));
    if (accuracy != null && (!Number.isFinite(accuracy) || accuracy < 0)) v.fail('location', 'invalid');
    else if (accuracy != null && accuracy > 150) v.fail('location', 'location_inaccurate');
    const at = body.locationAt == null ? Date.now() : Number(body.locationAt);
    if (!Number.isFinite(at) || Date.now() - at > 10 * 60_000 || at - Date.now() > 5 * 60_000) v.fail('location', 'location_stale');
    return { accuracy, at: new Date(Number.isFinite(at) ? at : Date.now()).toISOString() };
  }
  /** Reject a GPS fix that is far too inexact to trust (the page asks the customer to try again near a window). */
  function checkCustomerAccuracy(v, accuracy) {
    if (accuracy != null && Number(accuracy) > 1500) v.fail('location', 'location_inaccurate');
  }

  async function saveRequest(req, { text, area, point, source, serviceType, locale, cooks, areaLabel }) {
    const publicId = randomToken(12);
    const saved = await db.one(
      `INSERT INTO requests (public_id, body, area_label, approx_lat, approx_lng, location_source, service_type_key, results_count, locale, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [publicId, text, areaLabel || area.name_ar, roundTo(point.lat, 2), roundTo(point.lng, 2), source, serviceType, cooks.length, locale,
        hmacHex(cfg.sessionSecret, ip(req))]);
    // Impressions (analytics): ONE multi-row insert, not awaited — the customer never waits for it.
    if (cooks.length) {
      const vals = []; const params = [];
      cooks.forEach((c, i) => {
        const b = params.length;
        vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
        params.push(saved.id, c.id, c.distanceKm ?? 0, i + 1, c.distanceM ?? null);
      });
      db.query(`INSERT INTO request_impressions (request_id, cook_id, distance_km, position, distance_m) VALUES ${vals.join(',')}`, params)
        .catch((e) => { if (!cfg.quiet) console.warn(`[impressions] not saved: ${e.message}`); });
    }
    return publicId;
  }

  return [
    ['GET', /^\/api\/config$/, async (req, res) => {
      const locale = pickLocale(req, cfg.locales);
      const url = new URL(req.url, 'http://x');
      // Country of the visitor: asked by the page (from GPS / time zone), else CDN geo header, else the platform default.
      const asked = (url.searchParams.get('country') || '').toUpperCase();
      const hint = String(req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || req.headers['x-country-code'] || '').toUpperCase();
      const country = getCountry(asked)?.code || getCountry(hint)?.code || cfg.defaultCountry;
      const base = await cache.get(`config:${locale}`, 5 * 60_000, async () => ({
        locales: cfg.locales,
        serviceTypes: (await db.query('SELECT key FROM service_types ORDER BY sort_order')).map((x) => x.key),
        plans: PLAN_KEYS,
        districts: areas.districts(locale),
        maxPhotos: MAX_PHOTOS_PER_COOK,
        adminContactConfigured: !!cfg.adminWhatsapp,
        brand: cfg.brand,
        countries: Object.keys(COUNTRIES).filter((c) => !(settings?.get().countriesRemoved || []).includes(c)),
        countryTimezones: COUNTRY_TIMEZONES,
        contactChannel: channel.kind,
        geoAttribution: !!cfg.geoapifyKey,
        site: settings ? settings.publicView() : { announcement: '', sections: {} },
      }));
      sendJson(res, 200, {
        ...base,
        country: publicCountry(country),
        // categories that have shops IN THIS COUNTRY (an "auto" category shows only where it has shops)
        liveKinds: hiddenHere(settings, country).country ? [] : (await cache.get(`feed:liveKinds:${country}`, 60_000, async () => (await db.query(`SELECT DISTINCT c.kind FROM cooks c WHERE ${VISIBLE_SQL} AND COALESCE(c.country, 'LB') = $2`, [new Date().toISOString(), country])).map((r) => r.kind))).filter((x) => !hiddenHere(settings, country).kinds.has(x)),
        countryHint: getCountry(hint)?.code || null,
        billing: { currency: billingCurrency(country) },
      });
    }],

    /* ---------- villages ---------- */
    ['GET', /^\/api\/areas\/search$/, async (req, res) => {
      await limit(limiters.lookup, req);
      const url = new URL(req.url, 'http://x');
      sendJson(res, 200, { areas: areas.search(url.searchParams.get('q') || '', { locale: pickLocale(req, cfg.locales) }) });
    }],
    ['GET', /^\/api\/areas\/nearby$/, async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const km = Math.min(30, Math.max(1, Number(url.searchParams.get('km')) || 15));
      sendJson(res, 200, { areas: areas.nearby(url.searchParams.get('areaId'), { km, locale: pickLocale(req, cfg.locales) }) });
    }],
    // Villages & areas around the cook's GPS position (from OpenStreetMap, saved locally).
    ['GET', /^\/api\/areas\/around$/, async (req, res) => {
      await limit(limiters.places, req);
      const url = new URL(req.url, 'http://x');
      const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
      if (!isValidLatLng(lat, lng)) throw new HttpError(422, 'validation_failed', { fields: { location: 'invalid' } });
      const here = await geo.resolve(lat, lng);
      const r = await withPlaces(lat, lng, here.country);
      const locale = pickLocale(req, cfg.locales);
      const nearAny = areas.nearest(lat, lng);
      const near = nearAny && haversineKm(lat, lng, nearAny.lat, nearAny.lng) <= 30 ? nearAny : null; // never "nearest town 4000 km away"
      const where = await geo.resolve(lat, lng, { wait: false });
      sendJson(res, 200, {
        source: r.source,
        country: where.country || null,
        region: where.regionName || null,
        nearest: near ? areas.view(near, locale, { distanceKm: roundTo(haversineKm(lat, lng, near.lat, near.lng), 1) }) : null,
        areas: areas.around(lat, lng, { km: 15, locale }),
      });
    }],
    ['GET', /^\/api\/areas\/nearest$/, async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
      if (!isValidLatLng(lat, lng)) throw new HttpError(422, 'validation_failed', { fields: { location: 'invalid' } });
      sendJson(res, 200, { area: areas.view(areas.nearest(lat, lng), pickLocale(req, cfg.locales)) });
    }],
    ['GET', /^\/api\/areas\/district$/, async (req, res) => {
      const url = new URL(req.url, 'http://x');
      sendJson(res, 200, { areas: areas.inDistrict(url.searchParams.get('key') || '', pickLocale(req, cfg.locales)) });
    }],

    /* ---------- customer search & contact ---------- */
    ['POST', /^\/api\/search$/, async (req, res) => {
      await limit(limiters.search, req);
      const body = await readJson(req, 16 * 1024);
      antiSpam(body);
      const locale = pickLocale(req, cfg.locales);
      const v = new Validator();
      const text = v.text('text', body.text, { min: 5, max: 1000, multiline: true });
      const serviceType = v.oneOf('serviceType', body.serviceType, SERVICE_TYPES, { required: false });
      const loc = body.location || (body.areaId ? { type: 'area', areaId: body.areaId } : {});
      let area = null, point = null, source = null;
      if (loc.type === 'gps') {
        const lat = v.number('location', loc.lat, { min: -90, max: 90 });
        const lng = v.number('location', loc.lng, { min: -180, max: 180 });
        checkCustomerAccuracy(v, loc.accuracy);
        if (isValidLatLng(lat, lng)) {
          // Exact fix for the distance (≈1 m); only a ~1 km rounded copy is ever stored.
          point = { lat: roundTo(lat, 5), lng: roundTo(lng, 5) };
          withPlaces(point.lat, point.lng).catch(() => {}); // learn the villages around the customer in the background
          area = areas.nearest(point.lat, point.lng);
          source = 'gps';
        }
      } else if (loc.type === 'area') {
        area = areas.get(loc.areaId);
        if (!area) v.fail('location', 'invalid');
        else { point = { lat: area.lat, lng: area.lng }; source = 'area'; }
      } else {
        v.fail('location', 'required');
      }
      v.assert();
      // GPS: the nearest village + any place within 1.5 km (small villages sit next to each other). Typed village: exactly that one.
      const areaIds = source === 'gps' ? areas.idsNear(point.lat, point.lng, 1.5) : [area.id];
      const cooks = await searchCooksForArea(db, areas, { areaIds, point, serviceType, locale, limit: cfg.searchResultLimit });
      const place = source === 'gps' ? await customerPlace(point, area, locale) : { where: { country: area.country || null }, label: areas.view(area, locale).name };
      const requestId = await saveRequest(req, { text, area, point, source, serviceType, locale, cooks, areaLabel: place.label });
      const areaView = areas.view(area, locale, { distanceKm: roundTo(haversineKm(point.lat, point.lng, area.lat, area.lng), 1) });
      const where = place.where;
      sendJson(res, 200, { requestId, area: areaView, areaLabel: areaView.name, country: where.country || null, cooks });
    }],

    // Order straight from a cook's page (the customer already knows her).
    ['POST', /^\/api\/cooks\/(\d+)\/request$/, async (req, res, m) => {
      await limit(limiters.search, req);
      const body = await readJson(req, 32 * 1024);
      antiSpam(body);
      const locale = pickLocale(req, cfg.locales);
      const cookId = cookIdFrom(m);
      if (!(await isCookVisible(db, cookId))) throw new HttpError(404, 'cook_not_available');
      const target = await db.one('SELECT lat, lng, kind FROM cooks WHERE id = $1', [cookId]);
      const isRestaurant = true;   // every category (cooks included) can be ordered from its menu / price list
      const v = new Validator();
      // The order text is optional for everyone (menu items too); with neither, the subscriber gets a short contact message.
      let text = v.text('text', body.text, { max: 1000, required: false, multiline: true }) || '';
      let source = 'profile';
      if (isRestaurant) {
        const wanted = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
        const lines = [];
        const totals = new Map();
        if (wanted.length) {
          const ids = [...new Set(wanted.map((x) => Number(x.id)).filter(Boolean))];
          const menu = ids.length
            ? await db.query(`SELECT id, name, price, currency FROM menu_items WHERE cook_id = $1 AND is_available = 1 AND id IN (${ids.map((_, i) => `$${i + 2}`).join(',')})`, [cookId, ...ids])
            : [];
          const byId = new Map(menu.map((x) => [x.id, x]));
          for (const w of wanted) {
            const item = byId.get(Number(w.id));
            const qty = Math.min(99, Math.max(1, Math.floor(Number(w.qty) || 1)));
            if (!item) { v.fail('items', 'invalid'); break; }
            const price = item.price == null ? null : Number(item.price);
            lines.push(`${qty} × ${item.name}${price != null ? ` (${formatPrice(price * qty, item.currency || 'USD')})` : ''}`);
            if (price != null) totals.set(item.currency || 'USD', (totals.get(item.currency || 'USD') || 0) + price * qty);
          }
        }
        if (lines.length) {
          const total = [...totals].map(([cur, sum]) => formatPrice(Math.round(sum * 100) / 100, cur)).join(' + ');
          text = [...lines, total ? `${t(locale, 'order.total')}: ${total}` : '', text ? `${t(locale, 'order.note')}: ${text}` : ''].filter(Boolean).join('\n');
          source = 'order';
        } else source = text ? 'order' : 'contact';   // a note without dishes is still an order (it used to be dropped)
      } else if (!text) source = 'contact';             // a cook contacted without a written request
      // The customer's GPS position (required on the website); a village id is still accepted for API clients.
      let area = null, point = null;
      if (body.lat != null && body.lng != null) {
        const lat = v.number('location', body.lat, { min: -90, max: 90 });
        const lng = v.number('location', body.lng, { min: -180, max: 180 });
        checkCustomerAccuracy(v, body.accuracy);
        if (lat != null && lng != null && isValidLatLng(lat, lng)) {
          point = { lat: roundTo(lat, 5), lng: roundTo(lng, 5) };
          withPlaces(point.lat, point.lng).catch(() => {});
          area = areas.nearest(point.lat, point.lng);
        } else v.fail('location', 'invalid');
      } else if (body.areaId) {
        area = areas.get(body.areaId);
        if (!area) v.fail('location', 'invalid'); else point = { lat: area.lat, lng: area.lng };
      } else v.fail('location', 'location_required');
      v.assert();
      const km = haversineKm(point.lat, point.lng, target.lat, target.lng);
      const place = body.lat != null ? await customerPlace(point, area, locale) : { label: areas.view(area, locale).name };
      const requestId = await saveRequest(req, {
        text, area, point, source, serviceType: null, locale, areaLabel: place.label,
        cooks: [{ id: cookId, distanceKm: roundTo(km, 1), distanceM: Math.round(km * 1000) }],
      });
      sendJson(res, 200, { requestId, type: source });
    }],

    // wa.me link for that one cook only, plus a private token that lets this customer rate her later.
    ['POST', /^\/api\/contact$/, async (req, res) => {
      await limit(limiters.contact, req);
      const body = await readJson(req, 4 * 1024);
      const v = new Validator();
      const requestId = v.text('requestId', body.requestId, { min: 8, max: 40 });
      const cookId = v.int('cookId', body.cookId, { min: 1 });
      v.assert();
      const request = await db.one('SELECT id, body, area_label, locale, location_source, created_at FROM requests WHERE public_id = $1', [requestId]);
      if (!request) throw new HttpError(404, 'request_not_found');
      if (Date.now() - new Date(request.created_at).getTime() > 48 * 3600_000) throw new HttpError(410, 'request_expired');
      const shown = await db.one('SELECT 1 AS ok FROM request_impressions WHERE request_id = $1 AND cook_id = $2', [request.id, cookId]);
      if (!shown || !(await isCookVisible(db, cookId))) throw new HttpError(404, 'cook_not_available');
      const cook = await db.one('SELECT full_name, whatsapp FROM cooks WHERE id = $1', [cookId]);
      // a shop imported from the map without WhatsApp: customers call it or get directions instead
      if (cook && !cook.whatsapp) throw new HttpError(409, 'no_whatsapp');
      const tplKey = { order: 'wa.restaurantOrder', contact: 'wa.restaurantContact' }[request.location_source] || 'wa.customerMessage';
      const lang = request.locale || 'ar';
      // Straight-line distance computed when the customer searched/ordered (exact GPS); the address itself is never sent.
      const imp = await db.one('SELECT distance_m FROM request_impressions WHERE request_id = $1 AND cook_id = $2', [request.id, cookId]);
      const units = getCountry((await db.one('SELECT country FROM cooks WHERE id = $1', [cookId]))?.country)?.units || 'km';
      const distanceLine = imp?.distance_m != null && request.location_source !== 'area'
        ? fillTemplate(t(lang, 'wa.distanceLine'), { distance: formatDistance((k, vars) => t(lang, k, vars), imp.distance_m, units, { long: true }) })
        : '';
      const message = fillTemplate(t(lang, tplKey), { request: request.body, area: request.area_label || '-', distanceLine });
      const reviewToken = randomToken(18);
      await db.query('INSERT INTO request_contact_events (request_id, cook_id, channel, review_token) VALUES ($1,$2,$3,$4)',
        [request.id, cookId, 'whatsapp', reviewToken]);
      sendJson(res, 200, { whatsappUrl: channel.link(cook.whatsapp, message), reviewToken, cook: { id: cookId, name: cook.full_name } });
    }],

    /* ---------- discovery ---------- */
    ['GET', /^\/api\/feed$/, async (req, res) => {
      const locale = pickLocale(req, cfg.locales);
      // always ONE country: what is shown in Lebanon never appears in France (unknown → the default country, never "all")
      const asked = (new URL(req.url, 'http://x').searchParams.get('country') || '').toUpperCase();
      // a country that is not on the platform gets an empty home page (never another country's shops)
      const country = getCountry(asked)?.code || (/^[A-Z]{2}$/.test(asked) ? asked : cfg.defaultCountry || 'LB');
      const hf = hiddenHere(settings, country);
      if (hf.country) return sendJson(res, 200, { byKind: {}, dishes: [], cooks: [] });
      const feed = await cache.get(`feed:${locale}:${country}`, 60_000, () => homeFeed(db, areas, { locale, country }));
      if (feed?.byKind && hf.kinds.size) { const bk = { ...feed.byKind }; for (const k of hf.kinds) delete bk[k]; return sendJson(res, 200, { ...feed, byKind: bk }); }
      sendJson(res, 200, feed);
    }],
    // "Find a cook near me" — GPS only, no request text. Same matching & ordering as the normal search.
    ['GET', /^\/api\/cooks\/nearby$/, async (req, res) => {
      await limit(limiters.lookup, req);
      const url = new URL(req.url, 'http://x');
      const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
      if (!isValidLatLng(lat, lng)) throw new HttpError(422, 'validation_failed', { fields: { location: 'invalid' } });
      const point = { lat: roundTo(lat, 5), lng: roundTo(lng, 5) };
      withPlaces(point.lat, point.lng).catch(() => {});
      const locale = pickLocale(req, cfg.locales);
      const area = areas.nearest(point.lat, point.lng);
      const kind = KEY_RE.test(url.searchParams.get('type') || '') ? url.searchParams.get('type') : 'cook';
      // "all" = everything near me (every category, grouped on the page), with a larger but still bounded list
      // Everything within NEARBY_RADIUS_KM (default 10 km) of the customer, by ROAD distance (like the maps app), nearest first.
      const radiusKm = Number(process.env.NEARBY_RADIUS_KM) || 10;
      const listLimit = kind === 'all' ? Math.max(150, cfg.searchResultLimit || 30) : Math.max(30, cfg.searchResultLimit || 30);
      // ONE country: a customer near a border never sees shops across it (country from the map service, cached per ~1 km;
      // if it doesn't answer in time, the customer's nearest town decides)
      const here = await geo.resolve(point.lat, point.lng, { wait: 1500 }).catch(() => null);
      const myCountry = String(here?.country || areas.nearest(point.lat, point.lng)?.country || '').toUpperCase() || null;
      // a subscriber of a deleted category never shows; "everything near me" is per tab: shops OR craftspeople
      const grp = new URL(req.url, 'http://x').searchParams.get('group') === 'crafts' ? 'crafts' : 'shops';
      const allCats = (settings?.get().categories || []).filter((c) => !c.deleted);
      const hiddenGroups = new Set(settings?.get().groupsHidden || []);
      const liveCats = new Set(allCats.filter((c) => (kind !== 'all' || groupOf(c) === grp) && !hiddenGroups.has(groupOf(c))).map((c) => c.key));
      const hh = hiddenHere(settings, myCountry);
      const straight = hh.country ? [] : (await searchCooksForArea(db, areas, { radiusKm, point, kind, locale, limit: 200, country: myCountry })).filter((c) => liveCats.has(c.kind || 'cook') && !hh.kinds.has(c.kind || 'cook'));
      const cooks = (await withRoadDistances(point, straight, { key: cfg.geoapifyKey, fetchImpl: cfg.mapFetch || fetch, radiusM: radiusKm * 1000,
        perKind: kind === 'all' ? 5 : 0 })).slice(0, listLimit);   // "everything": the 3 shown per category
      const where = await geo.resolve(point.lat, point.lng, { wait: false });
      sendJson(res, 200, {
        area: area ? areas.view(area, locale, { distanceKm: roundTo(haversineKm(point.lat, point.lng, area.lat, area.lng), 1) }) : null,
        country: where.country || null,
        cooks,
      });
    }],
    ['GET', /^\/api\/cooks\/by-region$/, async (req, res) => {
      const locale = pickLocale(req, cfg.locales);
      const u = new URL(req.url, 'http://x');
      const asked = (u.searchParams.get('country') || '').toUpperCase();
      const country = getCountry(asked)?.code || cfg.defaultCountry || 'LB';
      const kind = KEY_RE.test(u.searchParams.get('type') || '') ? u.searchParams.get('type') : 'cook';
      sendJson(res, 200, { country, kind, regions: await cache.get(`feed:regions:${country}:${kind}:${locale}`, 60_000, () => cooksByRegion(db, areas, { country, kind, locale })) });
    }],
    ['GET', /^\/api\/dishes$/, async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const locale = pickLocale(req, cfg.locales);
      const offset = Number(url.searchParams.get('offset')) || 0;
      const lim = Number(url.searchParams.get('limit')) || 10;
      const country = getCountry((url.searchParams.get('country') || '').toUpperCase())?.code || null;
      sendJson(res, 200, await cache.get(`feed:dishes:${locale}:${country}:${offset}:${lim}`, 30_000, () => dishPhotos(db, areas, { offset, limit: lim, locale, country })));
    }],
    ['GET', /^\/api\/cooks\/search$/, async (req, res) => {
      await limit(limiters.lookup, req);
      const u = new URL(req.url, 'http://x');
      const q = u.searchParams.get('q') || '';
      // ONE country only: unknown / not on the platform → nothing (never shops of another country)
      const asked = (u.searchParams.get('country') || '').toUpperCase();
      const country = getCountry(asked)?.code || null;
      if (!country) return sendJson(res, 200, { cooks: [] });
      const hg = new Set(settings?.get().groupsHidden || []);
      const liveCats = new Set((settings?.get().categories || []).filter((c) => !c.deleted && !hg.has(groupOf(c))).map((c) => c.key));
      const hs = hiddenHere(settings, country);
      if (hs.country) return sendJson(res, 200, { cooks: [] });
      sendJson(res, 200, { cooks: (await searchCooksByName(db, areas, q, { locale: pickLocale(req, cfg.locales), country })).filter((c) => liveCats.has(c.kind || 'cook') && !hs.kinds.has(c.kind || 'cook')) });
    }],
    ['GET', /^\/api\/cooks\/(\d+)$/, async (req, res, m) => {
      const profile = await publicProfile(db, areas, cookIdFrom(m), { locale: pickLocale(req, cfg.locales) });
      if (!profile) throw new HttpError(404, 'cook_not_available');
      const qs = new URL(req.url, 'http://x').searchParams;
      // distance from the customer's CURRENT position (same source and same road calculation as the list)
      const plat = Number(qs.get('lat')), plng = Number(qs.get('lng'));
      if (qs.has('lat') && isValidLatLng(plat, plng)) {
        const origin = { lat: roundTo(plat, 5), lng: roundTo(plng, 5) };
        const raw = await db.one('SELECT lat, lng FROM cooks WHERE id = $1', [profile.id]);
        if (raw?.lat != null) {
          const m0 = Math.round(haversineKm(origin.lat, origin.lng, raw.lat, raw.lng) * 1000);
          Object.assign(profile, { distanceM: m0, straightM: m0, distanceKind: 'straight' });
          if (profile.nav) {
            const [road] = await withRoadDistances(origin, [profile], { key: cfg.geoapifyKey, fetchImpl: cfg.mapFetch || fetch });
            Object.assign(profile, { distanceM: road.distanceM, driveMin: road.driveMin ?? null, distanceKind: road.distanceKind });
          }
        }
      }
      const viewer = qs.get('viewerId');
      if (viewer) {
        profile.likedByMe = !!(await db.one('SELECT 1 AS ok FROM cook_likes WHERE cook_id = $1 AND viewer_hash = $2', [profile.id, viewerHash(viewer)]));
      }
      sendJson(res, 200, profile);
    }],
    // A visit to her page (counted once per visitor per 12 hours).
    ['POST', /^\/api\/cooks\/(\d+)\/view$/, async (req, res, m) => {
      await limit(limiters.lookup, req);
      const body = await readJson(req, 1024);
      const cookId = cookIdFrom(m);
      const vh = viewerHash(body.viewerId);
      if (!(await isCookVisible(db, cookId))) throw new HttpError(404, 'cook_not_available');
      const since = new Date(Date.now() - 12 * 3600_000).toISOString();
      const recent = await db.one('SELECT 1 AS ok FROM cook_page_views WHERE cook_id = $1 AND viewer_hash = $2 AND created_at >= $3', [cookId, vh, since]);
      if (!recent) await db.query('INSERT INTO cook_page_views (cook_id, viewer_hash) VALUES ($1,$2)', [cookId, vh]);
      sendJson(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/cooks\/(\d+)\/like$/, async (req, res, m) => {
      await limit(limiters.lookup, req);
      const body = await readJson(req, 1024);
      const cookId = cookIdFrom(m);
      const vh = viewerHash(body.viewerId);
      if (!(await isCookVisible(db, cookId))) throw new HttpError(404, 'cook_not_available');
      if (body.like === false) await db.query('DELETE FROM cook_likes WHERE cook_id = $1 AND viewer_hash = $2', [cookId, vh]);
      else await db.query('INSERT INTO cook_likes (cook_id, viewer_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING', [cookId, vh]);
      const n = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cook_likes WHERE cook_id = $1', [cookId]);
      sendJson(res, 200, { likes: n.n, likedByMe: body.like !== false });
    }],

    /* ---------- ratings (public average) & complaints (admin only) ---------- */
    ['POST', /^\/api\/reviews$/, async (req, res) => {
      await limit(limiters.contact, req);
      const body = await readJson(req, 2 * 1024);
      const v = new Validator();
      const token = v.text('token', body.token, { min: 10, max: 60 });
      const rating = v.int('rating', body.rating, { min: 1, max: 5 });
      v.assert();
      const ev = await db.one('SELECT id, cook_id, created_at FROM request_contact_events WHERE review_token = $1', [token]);
      if (!ev) throw new HttpError(404, 'review_not_allowed');
      if (Date.now() - new Date(ev.created_at).getTime() > REVIEW_WINDOW_DAYS * 86400_000) throw new HttpError(410, 'review_expired');
      const existing = await db.one('SELECT id FROM reviews WHERE contact_event_id = $1', [ev.id]);
      if (existing) await db.query('UPDATE reviews SET rating = $1, updated_at = $2 WHERE id = $3', [rating, new Date().toISOString(), existing.id]);
      else await db.query('INSERT INTO reviews (cook_id, contact_event_id, rating) VALUES ($1,$2,$3)', [ev.cook_id, ev.id, rating]);
      sendJson(res, 200, { ok: true, cookId: ev.cook_id, rating });
    }],

    ['POST', /^\/api\/feedback$/, async (req, res) => {
      await limit(limiters.feedback, req);
      const body = await readJson(req, 8 * 1024);
      antiSpam(body);
      const v = new Validator();
      const cookId = v.int('cookId', body.cookId, { min: 1 });
      const kind = v.oneOf('kind', body.kind, ['complaint', 'note']);
      const message = v.text('message', body.message, { min: 5, max: 1500, multiline: true });
      const name = v.text('name', body.name, { max: 60, required: false });
      const rawPhone = v.text('phone', body.phone, { max: 25, required: false });
      const phone = rawPhone ? normalizePhone(rawPhone, cfg.defaultCountry) : null;
      if (rawPhone && !phone) v.fail('phone', 'invalid_phone');
      v.assert();
      const cook = await db.one(`SELECT id FROM cooks WHERE id = $1 AND status <> 'rejected'`, [cookId]);
      if (!cook) throw new HttpError(404, 'not_found');
      await db.query(
        'INSERT INTO feedback (cook_id, kind, message, customer_name, customer_phone, ip_hash) VALUES ($1,$2,$3,$4,$5,$6)',
        [cookId, kind, message, name, phone, hmacHex(cfg.sessionSecret, ip(req))]);
      sendJson(res, 201, { ok: true });
    }],

    /* ---------- cook application ---------- */
    ['POST', /^\/api\/cook-applications$/, async (req, res) => {
      await limit(limiters.apply, req);
      const body = await readJson(req, 256 * 1024);
      antiSpam(body);
      const v = new Validator();
      const fullName = v.text('fullName', body.fullName, { min: 2, max: 80 });
      // The WhatsApp number is optional for shops ("I have no WhatsApp number"): they then sign in with their business name.
      // Home cooks always need it (customers can't get directions to a home).
      const kind = activeKinds(settings?.get().categories).includes(body.kind) ? body.kind : 'cook';
      const noNumber = body.noWhatsapp === true && kind !== 'cook';
      const rawPhone = noNumber ? null : v.text('whatsapp', body.whatsapp, { min: 6, max: 25 });
      const served = Array.isArray(body.servedAreaIds) ? [...new Set(body.servedAreaIds.map(Number))].filter((id) => areas.get(id)).slice(0, 300) : [];
      if (!served.length) v.fail('servedAreaIds', 'pick_one_area');
      // Two kinds of subscribers: a home cook (service chips) or a restaurant (free-text specialty, menu, more photos).
      const services = Array.isArray(body.services) ? [...new Set(body.services)].filter((s) => SERVICE_TYPES.includes(s)) : [];
      const specialty = v.text('specialty', body.specialty, { max: 120, required: false }) || null;
      // Subscribers must accept the terms (platform role, food safety & licences are their responsibility).
      if (body.acceptTerms !== true) v.fail('acceptTerms', 'required');
      // The subscriber chooses their own password (min 5 characters); it works as soon as the team activates the account.
      const chosenPassword = typeof body.password === 'string' ? body.password : '';
      if (!chosenPassword) v.fail('password', 'required');
      else if (chosenPassword.length < 5) v.fail('password', 'password_too_short');
      else if (chosenPassword.length > 100) v.fail('password', 'too_long');
      const bio = v.text('bio', body.bio, { max: 300, required: false, multiline: true });
      const areaLabel = v.text('areaLabel', body.areaLabel, { max: 80, required: false }); // optional, for information
      // v7.6: durations and prices come from "Prices & durations" (with / without drivers); hidden durations can't be chosen
      let newPlans = null;
      try { const row = await db.one(`SELECT value FROM app_meta WHERE key = 'plans'`); newPlans = row ? JSON.parse(row.value) : {}; } catch { newPlans = {}; }
      const kindKey = body.withDrivers === true ? 'delivery' : 'basic';
      const MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
      const oldHidden = settings?.get().plansHidden || [];   // the older "durations" switch still counts
      const plan = v.oneOf('plan', body.plan, Object.keys(MONTHS).filter((k) => !newPlans?.store?.[kindKey]?.[MONTHS[k]]?.hidden && !oldHidden.includes(k)));
      const photo = validatePhoto(body.photo, v);
      // GPS location is mandatory: it's how we find the villages around her.
      let lat = null, lng = null;
      if (body.lat == null || body.lng == null || body.lat === '' || body.lng === '') v.fail('location', 'location_required');
      else {
        lat = v.number('location', body.lat, { min: -90, max: 90 });
        lng = v.number('location', body.lng, { min: -180, max: 180 });
        if (lat != null && lng != null && !isValidLatLng(lat, lng)) v.fail('location', 'invalid');
      }
      // GPS quality: a kitchen is only saved from a precise, fresh fix (the page keeps listening up to 15 s for one).
      const fix = gpsFix(v, body);
      // The cook's country (and region) comes automatically from their GPS position — anywhere in the world.
      let place = { country: null };
      if (lat != null && lng != null && isValidLatLng(lat, lng)) place = await geo.resolve(lat, lng);
      const country = place.country || (body.country ? getCountry(body.country)?.code : null) || cfg.defaultCountry;
      const whatsapp = rawPhone ? normalizePhone(rawPhone, country) : null;
      if (rawPhone && !whatsapp) v.fail('whatsapp', 'invalid_phone');
      if ((settings?.get().groupsHidden || []).includes(groupOf((settings?.get().categories || []).find((c) => c.key === kind)))) v.fail('kind', 'invalid');   // hidden group
      // opening hours: required for every category (hours, or 24/7)
      const hours = cleanHours(body.hours);   // required on the sign-up page; the server refuses only invalid hours (old app versions keep working)
      if (hours === undefined) v.fail('hours', 'hours_required');
      const bk = settings?.get().booking || {};
      const booking = body.booking === true && bk.enabled !== false ? 1 : 0;   // optional add-on
      { const hj = hiddenHere(settings, country); if (hj.country) v.fail('country', 'country_closed'); else if (hj.kinds.has(kind)) v.fail('kind', 'invalid'); }
      // craftspeople must describe their services
      if (isCraft(kind) && String(body.bio || '').trim().length < 10) v.fail('bio', 'describe_services');
      v.assert();
      const picked = areas.get(body.areaId);
      const home = picked || areas.nearest(lat, lng);
      const homeLabel = areaLabel || home.name_ar;
      if (whatsapp && await db.one(`SELECT id FROM cooks WHERE whatsapp = $1 AND status = 'pending'`, [whatsapp])) throw new HttpError(409, 'application_exists');
      // without a number the business name is the login: it must be unique
      if (noNumber && await db.one('SELECT id FROM cooks WHERE name_norm = $1', [normalizeName(fullName)])) throw new HttpError(422, 'validation_failed', { fields: { fullName: 'name_taken' } });

      const price = priceFor(settings?.get(), plan, country, kind);
      const img = await images.save('cooks', photo);
      const cookId = await db.tx(async (q) => {
        const row = await q.one(
          `INSERT INTO cooks (full_name, whatsapp, area_id, area_label, lat, lng, service_radius_km, bio, photo, requested_plan, admin_notes, status, photo_url, name_norm, country,
             region_key, region_name, region_name_ar, region_name_en, kind, specialty, terms_accepted_at, terms_version, locale,
             location_accuracy_m, location_at, addr_city, addr_district, addr_locality, password_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$11,$7,$8,$9,$10,'pending',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
          [fullName, whatsapp || '', home.id, homeLabel, roundTo(lat, 5), roundTo(lng, 5), bio, img.data, plan, null, 0, img.url, normalizeName(fullName), country,
            place.regionKey || null, place.regionName || null, place.regionNameAr || null, place.regionNameEn || null, kind, specialty,
            new Date().toISOString(), TERMS_VERSION, pickLocale(req, cfg.locales),
            fix.accuracy, fix.at, place.city || null, place.district || null, place.locality || null, await hashPassword(chosenPassword)]);
        await setCookServices(q, row.id, services);
        await setServedAreas(q, row.id, served);
        await q.query(`INSERT INTO subscriptions (cook_id, plan, status, payment_status, currency, amount) VALUES ($1,$2,'pending','unpaid',$3,$4)`,
          [row.id, plan, price.currency, price.amount]);
        return row.id;
      });

      const lang = pickLocale(req, cfg.locales); // the subscriber's language
      const servedNames = served.map((id) => areas.get(id).name_ar);
      // came through a referral link? (only a link of this country counts)
      const ref = await referrerFor(db, body.ref, country);
      if (ref) await db.query('UPDATE cooks SET referrer_id = $1 WHERE id = $2', [ref.id, cookId]);
      await db.query('UPDATE cooks SET hours = $1, booking = $2 WHERE id = $3', [hours ? JSON.stringify(hours) : null, booking, cookId]);
      // v7.5: chosen subscription — with the "request a driver" feature or without it
      if (body.withDrivers === true) await db.query(`UPDATE cooks SET plan_delivery = 1, delivery_mode = 'delivery' WHERE id = $1`, [cookId]);
      const message = fillTemplate(t(lang, kind === 'cook' ? 'wa.adminApplication' : 'wa.adminApplicationRestaurant'), {
        category: nameOf(settings?.get().categories, kind, lang),
        id: cookId,
        specialty: specialty || '',
        name: fullName,
        whatsapp: whatsapp ? '+' + whatsapp.replace(/^\+/, '') : '—',
        area: homeLabel,
        map: `https://maps.google.com/?q=${roundTo(lat, 5)},${roundTo(lng, 5)}`,
        served: servedNames.slice(0, 8).join(t(lang, 'common.listSep')) + (servedNames.length > 8 ? t(lang, 'wa.moreAreas', { n: servedNames.length - 8 }) : ''),
        services: services.map((s) => t(lang, `services.${s}`)).join(t(lang, 'common.listSep')),
        plan: t(lang, `plans.${plan}`),
        price: price.amount != null ? formatPrice(price.amount, price.currency) : '—',
        phone: whatsapp ? whatsapp.replace(/^\+/, '') : `${fullName} — ${t(lang, 'join.loginByName')}`,   // login: number without '+', or the business name
        password: chosenPassword,      // the owner asked for it to be visible so the subscriber keeps it
        // country name in the message language ("لبنان", "Lebanon", "Liban"…), not the code
        country: (() => { try { return new Intl.DisplayNames([lang], { type: 'region' }).of(country) || country; } catch { return country; } })()
          + (place.regionName ? ` — ${place.regionName}` : ''),
      });
      sendJson(res, 201, { applicationId: cookId, kind, country, whatsappUrl: cfg.adminWhatsapp ? channel.link(cfg.adminWhatsapp, message) : null });
    }],

    /* ---------- ads / logos placed by the admin ---------- */
    ['GET', /^\/api\/banners$/, async (req, res) => {
      const rows = await cache.get(`feed:banners:${new Date().toISOString().slice(0, 15)}`, 60_000, () => db.query(
        `SELECT id, placement, image_url, link_url, title FROM banners WHERE is_active = 1 AND (expires_at IS NULL OR expires_at > $1) ORDER BY placement, sort_order, id`, [new Date().toISOString()]));
      sendJson(res, 200, { banners: rows.map((b) => ({
        id: b.id, placement: b.placement, title: b.title || '', linkUrl: b.link_url || null,
        imageUrl: b.image_url || `/media/banners/${b.id}.jpg`,
      })) });
    }],
    ['GET', /^\/media\/banners\/(\d+)\.jpg$/, async (req, res, m) => {
      const b = await db.one('SELECT image_data, image_url, is_active FROM banners WHERE id = $1', [Number(m[1])]);
      if (!b || !Number(b.is_active)) throw new HttpError(404, 'not_found');
      if (b.image_url) return redirect(res, b.image_url);
      sendPhoto(res, b.image_data, 'public, max-age=3600');
    }],

    /* ---------- 📅 pre-booking: the platform only prepares the WhatsApp message; shop and customer arrange the rest ---------- */
    ['POST', /^\/api\/booking$/, async (req, res) => {
      await limit(limiters.lookup, req);
      const body = await readJson(req, 8 * 1024);
      antiSpam(body);
      const v = new Validator();
      const cookId = v.number('cookId', body.cookId, { min: 1, max: 1e9 });
      const name = v.text('name', body.name, { min: 2, max: 60 });
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : v.fail('date', 'invalid');
      const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time || '')) ? String(body.time) : v.fail('time', 'invalid');
      const note = v.text('note', body.note, { max: 300, required: false, multiline: true });
      v.assert();
      const c = await db.one(`SELECT c.id, c.full_name, c.whatsapp, c.booking FROM cooks c WHERE c.id = $2 AND ${VISIBLE_SQL}`, [new Date().toISOString(), cookId]);
      if (!c || !Number(c.booking) || settings?.get().booking?.enabled === false) throw new HttpError(409, 'booking_off');
      if (!c.whatsapp) throw new HttpError(409, 'no_whatsapp');
      const lang = pickLocale(req, cfg.locales);
      const dayLabel = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-LB-u-nu-latn' : lang, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
      const text = t(lang, 'booking.message', { name, day: dayLabel, time, note: note ? `\n${t(lang, 'booking.noteLabel')}: ${note}` : '' });
      await db.query('INSERT INTO booking_events (cook_id) VALUES ($1)', [c.id]);
      sendJson(res, 201, { whatsappUrl: `https://wa.me/${String(c.whatsapp).replace(/\D/g, '')}?text=${encodeURIComponent(text)}` });
    }],

    /* ---------- 🚩 report a subscriber (Google Play: user-generated content must be reportable) ---------- */
    ['POST', /^\/api\/report$/, async (req, res) => {
      await limit(limiters.lookup, req);
      const body = await readJson(req, 8 * 1024);
      antiSpam(body);
      const v = new Validator();
      const cookId = v.number('cookId', body.cookId, { min: 1, max: 1e9 });
      const reason = v.oneOf('reason', body.reason, ['offensive', 'fake', 'scam', 'other']);
      const note = v.text('note', body.note, { max: 500, required: false, multiline: true });
      v.assert();
      const c = await db.one('SELECT id, full_name, country FROM cooks WHERE id = $1', [cookId]);
      if (!c) throw new HttpError(404, 'not_found');
      await db.query('INSERT INTO site_messages (name, contact, body, locale, ip_hash) VALUES ($1,$2,$3,$4,$5)',
        [`🚩 ${t('ar', `report.reason_${reason}`)}`, `#${c.id} ${c.full_name}${c.country ? ` (${c.country})` : ''}`, `${t('ar', 'report.adminTitle')}: ${c.full_name} — /c/${c.id}${note ? `\n${note}` : ''}`,
          pickLocale(req, cfg.locales), hmacHex(cfg.sessionSecret, clientIp(req, cfg.trustProxy)).slice(0, 16)]);
      sendJson(res, 201, { ok: true });
    }],

    /* ---------- road distances for the next places on screen (the list asks as the customer scrolls) ---------- */
    ['POST', /^\/api\/route\/distances$/, async (req, res) => {
      await limit(limiters.lookup, req);
      const body = await readJson(req, 4 * 1024);
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!isValidLatLng(lat, lng)) throw new HttpError(422, 'validation_failed', { fields: { location: 'invalid' } });
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, ROUTE_BATCH);
      if (!ids.length) return sendJson(res, 200, { distances: [] });
      const rows = await db.query(`SELECT c.id, c.lat, c.lng, c.kind FROM cooks c WHERE ${VISIBLE_SQL} AND c.kind <> 'cook' AND c.id IN (${ids.map((_, i) => `$${i + 2}`).join(',')})`,
        [new Date().toISOString(), ...ids]);
      const roads = await roadDistances({ lat, lng }, rows.filter((r) => !isPrivateKind(r.kind)).map((r) => ({ id: r.id, lat: Number(r.lat), lng: Number(r.lng) })), { key: cfg.geoapifyKey, fetchImpl: cfg.mapFetch || fetch });
      sendJson(res, 200, { distances: [...roads.entries()].map(([id, r]) => ({ id, distanceM: r.m, distanceKm: Math.round(r.m / 100) / 10,
        driveMin: r.s != null ? Math.max(1, Math.round(r.s / 60)) : null, distanceKind: 'road' })) });
    }],

    /* ---------- "Contact the team" (footer of every page) → admin panel ---------- */
    ['POST', /^\/api\/contact-admin$/, async (req, res) => {
      await limit(limiters.feedback || limiters.apply, req);
      const body = await readJson(req, 8 * 1024);
      antiSpam(body);
      const v = new Validator();
      const name = v.text('name', body.name, { max: 80, required: false });
      const contact = v.text('contact', body.contact, { max: 120, required: false });
      const message = v.text('message', body.message, { min: 5, max: 2000, multiline: true });
      v.assert();
      await db.query('INSERT INTO site_messages (name, contact, body, locale, ip_hash) VALUES ($1,$2,$3,$4,$5)',
        [name, contact, message, pickLocale(req, cfg.locales), hmacHex(cfg.sessionSecret, clientIp(req, cfg.trustProxy)).slice(0, 16)]);
      sendJson(res, 201, { ok: true });
    }],

    /* ---------- "Advertise with us": a business sends an ad; it waits for the owner's approval ---------- */
    ['POST', /^\/api\/ads$/, async (req, res) => {
      await limit(limiters.apply, req);
      const body = await readJson(req, 1300 * 1024);
      antiSpam(body);
      const v = new Validator();
      const name = v.text('name', body.name, { min: 2, max: 80 });
      const whatsapp = normalizePhone(body.whatsapp, cfg.defaultCountry);
      if (!whatsapp) v.fail('whatsapp', 'invalid_phone');
      const placement = v.oneOf('placement', body.placement, AD_PLACEMENTS);
      const duration = v.oneOf('duration', body.duration, ['week', 'month']);
      const linkUrl = v.text('linkUrl', body.linkUrl, { max: 300, required: false });
      if (linkUrl && !/^https?:\/\//i.test(linkUrl)) v.fail('linkUrl', 'invalid');
      const note = v.text('note', body.note, { max: 300, required: false, multiline: true });
      const photo = validatePhoto(body.image, v, 'image', { maxBytes: 1_200_000 });
      if (!photo) v.fail('image', 'required');
      v.assert();
      const country = getCountry(String(body.country || '').toUpperCase())?.code || cfg.defaultCountry || 'LB';
      const currency = billingCurrency(country);
      const p = settings?.get().adPrices?.[duration]?.[currency.toLowerCase()];
      const amount = p === '' || p == null || !Number.isFinite(Number(p)) ? null : Number(p);
      const img = await images.save('banners', photo);
      const row = await db.one(
        `INSERT INTO banners (image_data, image_url, link_url, title, placement, sort_order, is_active, status, advertiser_name, advertiser_whatsapp, note, duration_days, amount, currency)
         VALUES ($1,$2,$3,$4,$5,999,0,'pending',$6,$7,$8,$9,$10,$11) RETURNING id`,
        [img.data, img.url, linkUrl || null, name, placement, name, whatsapp, note, duration === 'week' ? 7 : 30, amount, currency]);
      const lang = pickLocale(req, cfg.locales);
      const message = fillTemplate(t(lang, 'wa.adRequest'), {
        id: row.id, name, whatsapp: whatsapp.replace(/^\+/, ''), placement: t(lang, `ads.place_${placement}`), duration: t(lang, `ads.${duration}`),
        price: amount != null ? formatPrice(amount, currency) : '—', link: linkUrl || '—', note: note || '—',
      });
      const adminWa = settings?.get().adminWhatsapp || cfg.adminWhatsapp;
      sendJson(res, 201, { ok: true, adId: row.id, whatsappUrl: adminWa ? channel.link(adminWa, message) : null });
    }],
    ['GET', /^\/media\/asset\/(\d+)$/, async (req, res, m) => {
      const row = await db.one('SELECT data FROM site_assets WHERE id = $1', [Number(m[1])]);
      if (!row) throw new HttpError(404, 'not_found');
      sendPhoto(res, row.data, 'public, max-age=604800, immutable');
    }],

    /* ---------- today's visitors & orders (reset at midnight, Beirut time) ---------- */
    ['POST', /^\/api\/visit$/, async (req, res) => {
      await limit(limiters.lookup, req);
      const body = await readJson(req, 512);
      const vid = String(body.vid || '').slice(0, 80);
      if (vid.length >= 8) {
        const { day } = dayInfo();
        await db.query('INSERT INTO daily_visits (day, visitor_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING', [day, hmacHex(cfg.sessionSecret, vid)]);
      }
      sendJson(res, 200, { ok: true });
    }],
    ['GET', /^\/api\/stats\/today$/, async (req, res) => {
      if (settings?.get().sections.dailyCounters === false) return sendJson(res, 200, { enabled: false });
      const { day, start, resetsAt } = dayInfo();
      const r = await cache.get(`feed:today:${day}`, 30_000, async () => db.one(
        `SELECT (SELECT CAST(COUNT(*) AS INTEGER) FROM daily_visits WHERE day = $1) AS visitors,
                (SELECT CAST(COUNT(*) AS INTEGER) FROM request_contact_events WHERE created_at >= $2) AS orders`, [day, start.toISOString()]));
      sendJson(res, 200, { enabled: true, day, visitors: r.visitors, orders: r.orders, resetsAt: resetsAt.toISOString() });
    }],

    /* ---------- the owner's design (colours, text size, layouts) and logo ---------- */
    ['GET', /^\/theme\.css$/, async (req, res) => {
      const th = settings?.get().theme || {};
      const preset = settings?.get().designPreset || 'emerald';
      // a ready design replaces the hand-picked colours; "custom" keeps them
      const css = preset === 'custom' || !DESIGNS[preset] ? themeCss(th) : themeCss({ ...th, colors: {}, background: 'preset:plain' }) + designCss(preset);
      sendText(req, res, css, 'text/css; charset=utf-8');
    }],
    ['GET', /^\/media\/logo$/, async (req, res) => {
      const row = await db.one(`SELECT value FROM app_meta WHERE key = 'site_logo'`);
      if (!row) throw new HttpError(404, 'not_found');
      sendPhoto(res, row.value, 'public, max-age=86400');
    }],

    /* ---------- worldwide counters (only when the admin turns them on) ---------- */
    ['GET', /^\/api\/stats\/public$/, async (req, res) => {
      if (!settings?.get().sections.globalCounters) return sendJson(res, 200, { enabled: false });
      const now = new Date().toISOString();
      // "Aklatak around the world": every country with published places (imported or subscribers) + countries the owner added
      const byCountry = await cache.get('feed:publicstats:countries', 5 * 60_000, async () => (await db.query(
        `SELECT COALESCE(c.country, 'LB') AS cc, CAST(COUNT(*) AS INTEGER) AS n FROM cooks c
          WHERE c.status = 'approved' AND c.is_hidden = 0
            AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.cook_id = c.id AND s.status = 'active' AND s.start_date <= $1 AND s.expiry_date > $1)
          GROUP BY COALESCE(c.country, 'LB') ORDER BY n DESC`, [now])).map((r) => ({ country: r.cc, n: Number(r.n) })));
      for (const cc of Object.keys(settings?.get().extraCountries || {})) if (!byCountry.some((x) => x.country === cc)) byCountry.push({ country: cc, n: 0 });
      const shownCountries = byCountry.filter((x) => !(settings?.get().countriesHidden || []).includes(x.country));
      const s2 = await cache.get('feed:publicstats', 5 * 60_000, async () => {
        const active = `c.status = 'approved' AND c.is_hidden = 0 AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.cook_id = c.id AND s.status = 'active' AND s.start_date <= $1 AND s.expiry_date > $1)`;
        const r = await db.one(
          `SELECT
             (SELECT CAST(COUNT(*) AS INTEGER) FROM cooks c WHERE ${active} AND c.kind = 'cook') AS cooks,
             (SELECT CAST(COUNT(*) AS INTEGER) FROM cooks c WHERE ${active} AND c.kind = 'restaurant') AS restaurants,
             (SELECT CAST(COUNT(DISTINCT COALESCE(c.country, 'LB')) AS INTEGER) FROM cooks c WHERE ${active}) AS countries,
             (SELECT CAST(COUNT(DISTINCT ip_hash) AS INTEGER) FROM requests) AS customers,
             (SELECT CAST(COUNT(DISTINCT viewer_hash) AS INTEGER) FROM cook_page_views) AS visitors`, [now]);
        return { cooks: r.cooks, restaurants: r.restaurants, countries: r.countries, users: Math.max(r.customers, r.visitors) };
      });
      sendJson(res, 200, { byCountry: shownCountries, enabled: true, ...s2 });
    }],

    /* ---------- media ---------- */
    ['GET', /^\/media\/cooks\/(\d+)\.jpg$/, async (req, res, m) => {
      const id = cookIdFrom(m);
      if (!(await isCookVisible(db, id))) throw new HttpError(404, 'not_found');
      const c = await db.one('SELECT photo, photo_url FROM cooks WHERE id = $1', [id]);
      if (c?.photo_url) return redirect(res, c.photo_url);
      sendPhoto(res, c?.photo);
    }],
    ['GET', /^\/media\/photos\/(\d+)\.jpg$/, async (req, res, m) => {
      const p = await db.one('SELECT cook_id, data, url, is_hidden FROM cook_photos WHERE id = $1', [Number(m[1])]);
      if (!p || p.is_hidden || !(await isCookVisible(db, p.cook_id))) throw new HttpError(404, 'not_found');
      if (p.url) return redirect(res, p.url);
      sendPhoto(res, p.data, 'public, max-age=86400');
    }],

    ['GET', /^\/healthz$/, async (req, res) => {
      await db.one('SELECT 1 AS ok');
      sendJson(res, 200, { ok: true });
    }],
  ];
}

export function redirect(res, url) {
  res.writeHead(302, { Location: url, 'Cache-Control': 'public, max-age=3600' });
  res.end();
}

export function sendPhoto(res, dataUrl, cache = 'private, max-age=300') {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new HttpError(404, 'not_found');
  const buf = Buffer.from(m[2], 'base64');
  res.writeHead(200, { 'Content-Type': m[1], 'Content-Length': buf.length, 'Cache-Control': cache });
  res.end(buf);
}
