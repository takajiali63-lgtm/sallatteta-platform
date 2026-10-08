// Countries the platform can serve. Adding a country = adding one line here (and its villages via the admin import).
// dial: international calling code · trunk: national prefix dropped in international format ("0" in most countries)
// nsn: allowed national-number lengths · locale: BCP-47 tag for dates/numbers · units: distance units shown to users
export const COUNTRIES = {
  LB: { dial: '961', trunk: '0', nsn: [7, 8], currency: 'USD', localCurrency: 'LBP', timezone: 'Asia/Beirut', locale: 'ar-LB', lang: 'ar', units: 'km' },
  SY: { dial: '963', trunk: '0', nsn: [9], currency: 'SYP', timezone: 'Asia/Damascus', locale: 'ar-SY', lang: 'ar', units: 'km' },
  JO: { dial: '962', trunk: '0', nsn: [8, 9], currency: 'JOD', timezone: 'Asia/Amman', locale: 'ar-JO', lang: 'ar', units: 'km' },
  PS: { dial: '970', trunk: '0', nsn: [9], currency: 'ILS', timezone: 'Asia/Hebron', locale: 'ar-PS', lang: 'ar', units: 'km' },
  IQ: { dial: '964', trunk: '0', nsn: [10], currency: 'IQD', timezone: 'Asia/Baghdad', locale: 'ar-IQ', lang: 'ar', units: 'km' },
  SA: { dial: '966', trunk: '0', nsn: [9], currency: 'SAR', timezone: 'Asia/Riyadh', locale: 'ar-SA', lang: 'ar', units: 'km' },
  AE: { dial: '971', trunk: '0', nsn: [8, 9], currency: 'AED', timezone: 'Asia/Dubai', locale: 'ar-AE', lang: 'ar', units: 'km' },
  KW: { dial: '965', trunk: '', nsn: [8], currency: 'KWD', timezone: 'Asia/Kuwait', locale: 'ar-KW', lang: 'ar', units: 'km' },
  QA: { dial: '974', trunk: '', nsn: [8], currency: 'QAR', timezone: 'Asia/Qatar', locale: 'ar-QA', lang: 'ar', units: 'km' },
  BH: { dial: '973', trunk: '', nsn: [8], currency: 'BHD', timezone: 'Asia/Bahrain', locale: 'ar-BH', lang: 'ar', units: 'km' },
  OM: { dial: '968', trunk: '', nsn: [8], currency: 'OMR', timezone: 'Asia/Muscat', locale: 'ar-OM', lang: 'ar', units: 'km' },
  EG: { dial: '20', trunk: '0', nsn: [9, 10], currency: 'EGP', timezone: 'Africa/Cairo', locale: 'ar-EG', lang: 'ar', units: 'km' },
  MA: { dial: '212', trunk: '0', nsn: [9], currency: 'MAD', timezone: 'Africa/Casablanca', locale: 'ar-MA', lang: 'ar', units: 'km' },
  DZ: { dial: '213', trunk: '0', nsn: [8, 9], currency: 'DZD', timezone: 'Africa/Algiers', locale: 'ar-DZ', lang: 'ar', units: 'km' },
  TN: { dial: '216', trunk: '', nsn: [8], currency: 'TND', timezone: 'Africa/Tunis', locale: 'ar-TN', lang: 'ar', units: 'km' },
  TR: { dial: '90', trunk: '0', nsn: [10], currency: 'TRY', timezone: 'Europe/Istanbul', locale: 'tr-TR', lang: 'tr', units: 'km' },
  FR: { dial: '33', trunk: '0', nsn: [9], currency: 'EUR', timezone: 'Europe/Paris', locale: 'fr-FR', lang: 'fr', units: 'km' },
  DE: { dial: '49', trunk: '0', nsn: [10, 11], currency: 'EUR', timezone: 'Europe/Berlin', locale: 'de-DE', lang: 'de', units: 'km' },
  ES: { dial: '34', trunk: '', nsn: [9], currency: 'EUR', timezone: 'Europe/Madrid', locale: 'es-ES', lang: 'es', units: 'km' },
  MX: { dial: '52', trunk: '', nsn: [10], currency: 'MXN', timezone: 'America/Mexico_City', locale: 'es-MX', lang: 'es', units: 'km' },
  AR: { dial: '54', trunk: '0', nsn: [10, 11], currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', locale: 'es-AR', lang: 'es', units: 'km' },
  CO: { dial: '57', trunk: '', nsn: [10], currency: 'COP', timezone: 'America/Bogota', locale: 'es-CO', lang: 'es', units: 'km' },
  CL: { dial: '56', trunk: '', nsn: [9], currency: 'CLP', timezone: 'America/Santiago', locale: 'es-CL', lang: 'es', units: 'km' },
  PE: { dial: '51', trunk: '', nsn: [9], currency: 'PEN', timezone: 'America/Lima', locale: 'es-PE', lang: 'es', units: 'km' },
  IT: { dial: '39', trunk: '', nsn: [9, 10], currency: 'EUR', timezone: 'Europe/Rome', locale: 'it-IT', lang: 'it', units: 'km' },
  BE: { dial: '32', trunk: '0', nsn: [8, 9], currency: 'EUR', timezone: 'Europe/Brussels', locale: 'fr-BE', lang: 'fr', units: 'km' },
  SE: { dial: '46', trunk: '0', nsn: [7, 8, 9], currency: 'SEK', timezone: 'Europe/Stockholm', locale: 'sv-SE', lang: 'sv', units: 'km' },
  GB: { dial: '44', trunk: '0', nsn: [10], currency: 'GBP', timezone: 'Europe/London', locale: 'en-GB', lang: 'en', units: 'mi' },
  US: { dial: '1', trunk: '', nsn: [10], currency: 'USD', timezone: 'America/New_York', locale: 'en-US', lang: 'en', units: 'mi' },
  CA: { dial: '1', trunk: '', nsn: [10], currency: 'CAD', timezone: 'America/Toronto', locale: 'en-CA', lang: 'en', units: 'km' },
  BR: { dial: '55', trunk: '0', nsn: [10, 11], currency: 'BRL', timezone: 'America/Sao_Paulo', locale: 'pt-BR', lang: 'pt', units: 'km' },
  AU: { dial: '61', trunk: '0', nsn: [9], currency: 'AUD', timezone: 'Australia/Sydney', locale: 'en-AU', lang: 'en', units: 'km' },
  MX: { dial: '52', trunk: '', nsn: [10], currency: 'MXN', timezone: 'America/Mexico_City', locale: 'es-MX', lang: 'es', units: 'km' },
  AR: { dial: '54', trunk: '0', nsn: [10], currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', locale: 'es-AR', lang: 'es', units: 'km' },
  CO: { dial: '57', trunk: '', nsn: [10], currency: 'COP', timezone: 'America/Bogota', locale: 'es-CO', lang: 'es', units: 'km' },
  CL: { dial: '56', trunk: '', nsn: [9], currency: 'CLP', timezone: 'America/Santiago', locale: 'es-CL', lang: 'es', units: 'km' },
  PE: { dial: '51', trunk: '', nsn: [9], currency: 'PEN', timezone: 'America/Lima', locale: 'es-PE', lang: 'es', units: 'km' },
};

/** Country by ISO code ("LB") or by calling code ("961"). */
/** Countries added by the owner in the admin panel (stored in the site settings). Built-in ones can't be overwritten. */
const BUILT_IN = new Set(Object.keys(COUNTRIES));
export const isBuiltInCountry = (code) => BUILT_IN.has(String(code || '').toUpperCase());
export function validCountryDef(code, d) {
  if (!/^[A-Z]{2}$/.test(code) || !d || typeof d !== 'object') return null;
  const nsn = (Array.isArray(d.nsn) ? d.nsn : [d.nsn]).map(Number).filter((n) => Number.isInteger(n) && n >= 5 && n <= 13);
  let tzOk = false; try { new Intl.DateTimeFormat('en', { timeZone: String(d.timezone) }); tzOk = true; } catch { /* invalid */ }
  if (!/^\d{1,4}$/.test(String(d.dial || '')) || !nsn.length || !tzOk || !/^[A-Z]{3}$/.test(String(d.currency || '')) || !['ar', 'en', 'fr', 'es'].includes(d.lang)) return null;
  return { dial: String(d.dial), trunk: d.trunk === '0' ? '0' : '', nsn: [...new Set(nsn)], currency: String(d.currency), timezone: String(d.timezone),
    locale: `${d.lang}-${code}`, lang: d.lang, units: d.units === 'mi' ? 'mi' : 'km', custom: true };
}
export function registerCountries(map = {}) {
  for (const k of Object.keys(COUNTRIES)) if (COUNTRIES[k].custom && !map[k]) delete COUNTRIES[k];   // removed by the owner
  for (const [code, d] of Object.entries(map)) { const v = validCountryDef(code, d); if (v && !BUILT_IN.has(code)) COUNTRIES[code] = v; }
}

export function getCountry(codeOrDial) {
  const c = String(codeOrDial || '').toUpperCase();
  if (COUNTRIES[c]) return { code: c, ...COUNTRIES[c] };
  const byDial = Object.entries(COUNTRIES).find(([, v]) => v.dial === c.replace(/\D/g, ''));
  return byDial ? { code: byDial[0], ...byDial[1] } : null;
}

/** The country an international number belongs to (longest matching calling code). */
export function countryForNumber(intl) {
  const s = String(intl || '');
  let best = null;
  for (const [code, v] of Object.entries(COUNTRIES)) {
    if (s.startsWith(v.dial) && (!best || v.dial.length > best.dial.length)) best = { code, ...v };
  }
  return best;
}

/**
 * Normalise a phone number to international digits (E.164 without "+"), e.g. 96171123456.
 * Numbers written with + or 00 keep their own country; local numbers get the given country's code.
 * Returns null if it isn't a plausible number.
 */
export function normalizePhone(input, countryCodeOrDial = 'LB') {
  const country = getCountry(countryCodeOrDial) || getCountry('LB');
  let s = String(input ?? '').trim().replace(/[\s\-().]/g, '');
  if (!s) return null;
  let intl;
  if (s.startsWith('+')) intl = s.slice(1);
  else if (s.startsWith('00')) intl = s.slice(2);
  else if (country.trunk && s.startsWith(country.trunk)) intl = country.dial + s.slice(country.trunk.length);
  else if (s.startsWith(country.dial) && country.nsn.includes(s.length - country.dial.length)) intl = s;
  else intl = country.dial + s;
  if (!/^[1-9]\d{6,14}$/.test(intl)) return null;
  const owner = countryForNumber(intl);
  if (owner) {
    const nsn = intl.length - owner.dial.length;
    if (!owner.nsn.includes(nsn)) return null;
  } else if (intl.length < 8) return null;
  return intl;
}

/** International number → how people write it locally (e.g. 96171123456 → 071123456 for Lebanon). */
export function toLocalFormat(intl) {
  const c = countryForNumber(intl);
  if (!c) return '+' + intl;
  return (c.trunk || '') + String(intl).slice(c.dial.length);
}

/** Public, client-safe description of a country. */
export function publicCountry(code) {
  const c = getCountry(code);
  return c && { code: c.code, dialCode: c.dial, currency: c.currency, timezone: c.timezone, locale: c.locale, lang: c.lang, units: c.units };
}

/** Time zone → country, used to guess the visitor's country before GPS (then GPS decides). */
export const COUNTRY_TIMEZONES = Object.assign(
  Object.fromEntries(Object.entries(COUNTRIES).map(([code, v]) => [v.timezone, code])),
  {
    'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Anchorage': 'US', 'Pacific/Honolulu': 'US',
    'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Winnipeg': 'CA', 'America/Halifax': 'CA', 'America/Montreal': 'CA',
    'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Australia/Adelaide': 'AU',
    'America/Manaus': 'BR', 'America/Fortaleza': 'BR', 'America/Recife': 'BR', 'America/Bahia': 'BR',
    'Europe/Monaco': 'FR', 'Atlantic/Canary': 'ES', 'Asia/Gaza': 'PS',
  },
);
