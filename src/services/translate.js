// Automatic translation of texts edited in the admin panel (DeepL — key on the server only: DEEPL_API_KEY).
// Placeholders such as {name} or {distanceLine} and emojis are kept exactly as they are.
// Without a key (or if DeepL fails), nothing is translated and the caller decides what to do.

const DEEPL_LANG = { ar: 'AR', en: 'EN-US', fr: 'FR', es: 'ES' };

export async function translateText(text, from, to, { key, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!key || !DEEPL_LANG[to] || from === to) return null;
  // protect {placeholders}: DeepL keeps XML tags untouched
  const tokens = [];
  const xml = String(text).replace(/\{(\w+)\}/g, (_, n) => { tokens.push(n); return `<x i="${tokens.length - 1}"/>`; });
  const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://${host}/v2/translate`, {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [xml], source_lang: (DEEPL_LANG[from] || '').slice(0, 2) || undefined, target_lang: DEEPL_LANG[to], tag_handling: 'xml', ignore_tags: ['x'], preserve_formatting: true }),
    });
    if (!res.ok) return null;
    const out = (await res.json())?.translations?.[0]?.text;
    if (typeof out !== 'string') return null;
    return out.replace(/<x i="(\d+)"\s*\/>/g, (_, i) => `{${tokens[Number(i)]}}`);
  } catch { return null; } finally { clearTimeout(timer); }
}
