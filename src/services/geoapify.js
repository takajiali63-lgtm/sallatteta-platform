// Geoapify client (server side only — the key never reaches the browser, the app, GitHub, logs or messages).
// Timeout, one retry on network/5xx, back-off on 429 (rate limit), and errors that never contain the key.

let backoffUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip the key from anything that might be logged. */
export const redact = (s, key) => (key ? String(s).split(key).join('***') : String(s));

// Circuit breaker: after 5 failures in a row (timeouts / 5xx / network), stop calling for 60 s.
// Callers fall back immediately (OpenStreetMap / cached data) instead of each waiting for a timeout.
const BREAKER = { failures: 0, openUntil: 0, threshold: 5, openMs: 60_000 };
export const geoapifyHealth = () => ({ failures: BREAKER.failures, open: Date.now() < BREAKER.openUntil, backingOff: Date.now() < backoffUntil });

export async function geoapifyGet(path, params, { key, timeoutMs = 6000, fetchImpl = fetch, body = null } = {}) {
  if (!key) throw new Error('geoapify: no key');
  if (Date.now() < backoffUntil) throw new Error('geoapify: rate limited (backing off)');
  if (Date.now() < BREAKER.openUntil) throw new Error('geoapify: temporarily unavailable (circuit open)');
  try {
    const out = await geoapifyCall(path, params, { key, timeoutMs, fetchImpl, body });
    BREAKER.failures = 0;
    return out;
  } catch (err) {
    if (!/key refused|HTTP 4\d\d|rate limited/.test(err.message) && ++BREAKER.failures >= BREAKER.threshold) {
      BREAKER.openUntil = Date.now() + BREAKER.openMs;
      BREAKER.failures = 0;
    }
    throw err;
  }
}

/** POST with a JSON body (route matrix). Same timeout, retry, back-off and circuit breaker as GET. */
export const geoapifyPost = (path, params, body, opts = {}) => geoapifyGet(path, params, { ...opts, body });

async function geoapifyCall(path, params, { key, timeoutMs, fetchImpl, body }) {
  const qs = new URLSearchParams({ ...params, apiKey: key }).toString();
  const url = `https://api.geoapify.com${path}?${qs}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, body
        ? { method: 'POST', signal: ctrl.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (res.status === 429) {
        const wait = Math.min(300, Number(res.headers?.get?.('retry-after')) || 60);
        backoffUntil = Date.now() + wait * 1000;
        throw Object.assign(new Error(`geoapify: rate limited (${wait}s)`), { noRetry: true });
      }
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`geoapify: key refused (${res.status})`), { noRetry: true });
      if (res.status >= 500) throw new Error(`geoapify: server error ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`geoapify: HTTP ${res.status}`), { noRetry: true });
      return await res.json();
    } catch (err) {
      const msg = redact(err.name === 'AbortError' ? 'geoapify: timeout' : err.message, key);
      if (err.noRetry || attempt === 1) throw new Error(msg);
      await sleep(300);
    } finally { clearTimeout(timer); }
  }
  throw new Error('geoapify: failed');
}

export const resetGeoapifyBackoff = () => { backoffUntil = 0; BREAKER.failures = 0; BREAKER.openUntil = 0; };

/** Reverse geocoding → structured place (any country). Never returns the street or house number. */
export async function geoapifyReverse(lat, lng, { key, fetchImpl } = {}) {
  const j = await geoapifyGet('/v1/geocode/reverse', { lat: String(lat), lon: String(lng), format: 'json', limit: '1' }, { key, fetchImpl });
  const r = j?.results?.[0];
  const country = String(r?.country_code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('geoapify: no country');
  const slug = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return {
    country,
    regionKey: r.state_code ? `${country}-${r.state_code}` : r.state ? `${country}-${slug(r.state)}` : null,
    regionName: r.state || null,
    regionNameAr: null,
    regionNameEn: null,
    city: r.city || r.town || r.village || r.county || null,
    district: r.district || null,
    locality: r.suburb || r.neighbourhood || r.quarter || r.village || r.hamlet || null,
  };
}
