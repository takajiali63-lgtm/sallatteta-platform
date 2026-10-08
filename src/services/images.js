// Saves images either in the database (default) or on object storage when configured.
export function imageStore(storage) {
  return {
    external: !!storage?.enabled,
    /** → { data, url }: `data` is kept in the DB only when there is no object storage. */
    async save(prefix, dataUrl) {
      if (!dataUrl) return { data: null, url: null };
      if (!storage?.enabled) return { data: dataUrl, url: null };
      return { data: null, url: await storage.putDataUrl(prefix, dataUrl) };
    },
    async remove(url) {
      if (url && storage?.enabled) await storage.deleteUrl(url).catch(() => {});
    },
  };
}
