// Moves images stored inside the database to S3-compatible storage (Cloudflare R2 / AWS S3).
// Used by the admin panel button ("Move photos to R2") and by scripts/move-photos-to-storage.js.
// Safe to re-run: only images still in the database are moved; a database copy is dropped only after the
// uploaded file is really reachable at its public address (otherwise it stays in the database).

export async function verifyReachable(url, { fetchImpl = fetch, tries = 3, waitMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await fetchImpl(url, { method: 'HEAD' }).catch(() => null);
    if (r && r.ok) return true;
    if (i < tries - 1) await new Promise((res) => setTimeout(res, waitMs * (i + 1)));
  }
  return false;
}

export async function storageCounts(db) {
  const one = async (sql) => Number((await db.one(sql)).n);
  return {
    photosInDb: await one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cook_photos WHERE url IS NULL AND data <> ''`),
    photosInStorage: await one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cook_photos WHERE url IS NOT NULL`),
    avatarsInDb: await one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cooks WHERE photo IS NOT NULL AND photo_url IS NULL`),
    avatarsInStorage: await one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cooks WHERE photo_url IS NOT NULL`),
  };
}

export async function migratePhotos({ db, storage, fetchImpl = fetch, verify = verifyReachable, onProgress = () => {}, batch = 25 }) {
  if (!storage?.enabled) throw new Error('storage not configured');
  const result = { moved: 0, avatars: 0, kept: 0 };
  let lastId = 0;
  for (;;) {
    const rows = await db.query(`SELECT id, cook_id, data FROM cook_photos WHERE url IS NULL AND data <> '' AND id > $1 ORDER BY id LIMIT ${batch}`, [lastId]);
    if (!rows.length) break;
    for (const p of rows) {
      lastId = p.id;
      try {
        const url = await storage.putDataUrl(`dishes/${p.cook_id}`, p.data);
        if (!(await verify(url, { fetchImpl }))) { result.kept++; continue; }
        await db.query(`UPDATE cook_photos SET url = $1, data = '' WHERE id = $2`, [url, p.id]);
        result.moved++;
      } catch { result.kept++; }
    }
    onProgress({ ...result });
  }
  let lastCook = 0;
  for (;;) {
    const rows = await db.query(`SELECT id, photo FROM cooks WHERE photo IS NOT NULL AND photo_url IS NULL AND id > $1 ORDER BY id LIMIT ${batch}`, [lastCook]);
    if (!rows.length) break;
    for (const c of rows) {
      lastCook = c.id;
      try {
        const url = await storage.putDataUrl(`cooks/${c.id}`, c.photo);
        if (!(await verify(url, { fetchImpl }))) { result.kept++; continue; }
        await db.query('UPDATE cooks SET photo_url = $1, photo = NULL WHERE id = $2', [url, c.id]);
        result.avatars++;
      } catch { result.kept++; }
    }
    onProgress({ ...result });
  }
  return result;
}
