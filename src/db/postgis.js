// PostGIS (free Postgres extension, available on Neon): a spatial GiST index on the subscribers' points, used for
// "nearest first" (KNN, the `<->` operator) — the standard way to search millions of places.
// Completely optional and safe: if the extension can't be enabled (SQLite, no permission, POSTGIS=off), or if a spatial
// query ever fails, search keeps working with the regular indexed query. Nothing to install or pay.

export const GEOG = 'ST_SetSRID(ST_MakePoint(c.lng, c.lat), 4326)::geography';
export const GEOG_INDEX_EXPR = 'ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography';

export async function enablePostgis(db, { log = console } = {}) {
  db.postgis = false;
  if (db.kind !== 'pg' || process.env.POSTGIS === 'off') return false;
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS postgis');
    const v = await db.one('SELECT postgis_version() AS v');
    // expression index: no new column, no trigger, nothing to keep in sync
    await db.query(`CREATE INDEX IF NOT EXISTS cooks_geog_gist ON cooks USING GIST ((${GEOG_INDEX_EXPR}))`);
    db.postgis = true;
    log.info?.(`[postgis] enabled (${v?.v || 'unknown version'}) — nearest-first search uses the spatial index`);
  } catch (e) {
    log.warn?.(`[postgis] not available (${e.message}) — using the regular nearby search`);
  }
  return db.postgis;
}
