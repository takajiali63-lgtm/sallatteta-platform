// In-memory index of villages/towns (a few hundred rows) for fast, typo-tolerant search.
import { haversineKm } from '../lib/geo.js';
import { normalizeName } from '../../public/assets/normalize.js';
import { DISTRICTS } from '../db/seed-data.js';

const CELL = 0.1; // grid cell size in degrees (~11 km)
const cellKey = (i, j) => `${i}:${j}`;

export class AreaIndex {
  constructor(db) { this.db = db; this.list = []; this.byId = new Map(); this.grid = new Map(); }

  /** Spatial grid: each place is filed under its ~11 km cell, so lookups only visit nearby cells. */
  _index(a, idx) {
    a._i = idx;
    const k = cellKey(Math.floor(a.lat / CELL), Math.floor(a.lng / CELL));
    let bucket = this.grid.get(k);
    if (!bucket) { bucket = []; this.grid.set(k, bucket); }
    bucket.push(a);
  }

  /** Add one place without reloading (used while importing places). */
  add(a) {
    this.list.push(a);
    this.byId.set(a.id, a);
    this._index(a, this.list.length - 1);
    return a;
  }

  /** Places in all cells overlapping the box of `km` around a point (a superset of what is within km). */
  _candidates(lat, lng, km) {
    const dLat = km / 110.574 + CELL;
    const cos = Math.max(0.01, Math.cos(((Math.abs(lat) + km / 110.574) * Math.PI) / 180));
    const dLng = km / (111.320 * cos) + CELL;
    const i0 = Math.floor((lat - dLat) / CELL), i1 = Math.floor((lat + dLat) / CELL);
    const j0 = Math.floor((lng - dLng) / CELL), j1 = Math.floor((lng + dLng) / CELL);
    const out = [];
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > this.grid.size) return this.list; // huge radius: scanning everything is cheaper
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const b = this.grid.get(cellKey(i, j)); if (b) out.push(...b); }
    return out;
  }

  async load() {
    const rows = await this.db.query(
      'SELECT id, slug, name_ar, name_en, name_fr, district, country, lat, lng FROM service_areas WHERE is_active = 1 ORDER BY sort_order, id');
    this.list = rows.map((r) => ({
      ...r,
      names: [...new Set([
        normalizeName(r.name_ar), normalizeName(r.name_ar, { keepAl: true }), normalizeName(r.name_en || ''),
      ].filter(Boolean))],
    }));
    this.byId = new Map(this.list.map((a) => [a.id, a]));
    this.grid = new Map();
    this.list.forEach((a, i) => this._index(a, i));
    return this;
  }

  get(id) { return this.byId.get(Number(id)) || null; }

  view(a, locale = 'ar', extra = {}) {
    if (!a) return null;
    const d = DISTRICTS[a.district];
    return {
      id: a.id,
      name: (locale === 'ar' ? a.name_ar : a.name_en) || a.name_ar,   // any non-Arabic language uses the Latin name
      district: a.district || null,
      districtName: d ? (locale === 'ar' ? d.ar : d.en) : null,
      lat: a.lat,
      lng: a.lng,
      ...extra,
    };
  }

  /** Prefix matches first, then "contains" matches. */
  search(q, { locale = 'ar', limit = 12 } = {}) {
    const qs = [...new Set([normalizeName(q), normalizeName(q, { keepAl: true })])].filter(Boolean);
    if (!qs.length) return [];
    const scored = [];
    for (const a of this.list) {
      let score = -1;
      for (const name of a.names) for (const n of qs) {
        if (name === n) score = Math.max(score, 3);
        else if (name.startsWith(n)) score = Math.max(score, 2);
        else if (name.split(' ').some((w) => w.startsWith(n))) score = Math.max(score, 1.5);
        else if (name.includes(n)) score = Math.max(score, 1);
      }
      if (score > 0) scored.push([score, a]);
    }
    scored.sort((x, y) => y[0] - x[0] || x[1].name_ar.localeCompare(y[1].name_ar, 'ar'));
    return scored.slice(0, limit).map(([, a]) => this.view(a, locale));
  }

  nearest(lat, lng) {
    if (!this.list.length) return null;
    // Search a growing box until the best place found is closer than anything outside the box could be.
    for (let km = 5; ; km *= 2) {
      let best = null;
      for (const a of this._candidates(lat, lng, km)) {
        const d = haversineKm(lat, lng, a.lat, a.lng);
        if (!best || d < best.d || (d === best.d && a._i < best.a._i)) best = { d, a };
      }
      if (best && (best.d <= km || km > 20_000)) return best.a;
      if (km > 20_000) return best ? best.a : null;
    }
  }

  /** Villages around a village, nearest first (for the cook's "where do you deliver" picker). */
  nearby(areaId, { km = 15, limit = 30, locale = 'ar' } = {}) {
    const c = this.get(areaId);
    if (!c) return [];
    return this._candidates(c.lat, c.lng, km)
      .map((a) => [haversineKm(c.lat, c.lng, a.lat, a.lng), a])
      .filter(([d]) => d <= km)
      .sort((x, y) => x[0] - y[0] || x[1]._i - y[1]._i)
      .slice(0, limit)
      .map(([d, a]) => this.view(a, locale, { distanceKm: Math.round(d * 10) / 10 }));
  }

  /** Villages & areas around a point (cook's GPS), nearest first. */
  around(lat, lng, { km = 15, limit = 120, locale = 'ar' } = {}) {
    return this._candidates(lat, lng, km)
      .map((a) => [haversineKm(lat, lng, a.lat, a.lng), a])
      .filter(([d]) => d <= km)
      .sort((x, y) => x[0] - y[0] || x[1]._i - y[1]._i)
      .slice(0, limit)
      .map(([d, a]) => this.view(a, locale, { distanceKm: Math.round(d * 10) / 10 }));
  }

  /** Area ids that count as "where the customer is": the nearest one + any within `km`. */
  idsNear(lat, lng, km = 2.5) {
    const ids = new Set();
    const n = this.nearest(lat, lng);
    if (n) ids.add(n.id);
    const within = this._candidates(lat, lng, km).filter((a) => haversineKm(lat, lng, a.lat, a.lng) <= km).sort((x, y) => x._i - y._i);
    for (const a of within) ids.add(a.id);
    return [...ids];
  }

  inDistrict(district, locale = 'ar') {
    return this.list.filter((a) => a.district === district).map((a) => this.view(a, locale));
  }

  districts(locale = 'ar') {
    return Object.entries(DISTRICTS).map(([key, d]) => ({ key, name: locale === 'ar' ? d.ar : d.en }));
  }
}
