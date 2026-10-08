// One distance format everywhere (cards, order summary, WhatsApp message):
//   metric:   < 1 km → metres rounded to 10 (min 10): "150 m";  1–10 km → one decimal: "1.2 km" ("1 km", never "1.0");  ≥ 10 km → whole km
//   imperial: < 0.1 mi → feet rounded to 50 (min 50);           0.1–10 mi → one decimal;                         ≥ 10 mi → whole miles
// Distances are straight-line (Haversine) between the customer's GPS fix and the subscriber's kitchen — computed locally, no API call.

const oneDecimal = (x) => { const r = Math.round(x * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };

/** → { value: '150', unit: 'm' | 'km' | 'ft' | 'mi' } */
export function distanceParts(meters, units = 'km') {
  const m = Math.max(0, Number(meters) || 0);
  if (units === 'mi') {
    const mi = m / 1609.344;
    const ft = Math.max(50, Math.round((m * 3.28084) / 50) * 50);
    if (mi < 0.1 && ft < 528) return { value: String(ft), unit: 'ft' };
    return { value: mi < 10 ? oneDecimal(mi) : String(Math.round(mi)), unit: 'mi' };
  }
  const tens = Math.max(10, Math.round(m / 10) * 10);
  if (tens < 1000) return { value: String(tens), unit: 'm' };   // 995 m rounds to 1000 → shown as "1 km" below
  const km = m / 1000;
  if (km < 10) {
    const v = oneDecimal(km);
    return v === '10' ? { value: '10', unit: 'km' } : { value: v, unit: 'km' };
  }
  return { value: String(Math.round(km)), unit: 'km' };
}

/** Text with the language's unit words. t = (key, vars) => string; long = words for messages ("150 متر") instead of symbols ("150 م"). */
export function formatDistance(t, meters, units = 'km', { long = false } = {}) {
  const { value, unit } = distanceParts(meters, units);
  return t(`units.${unit}${long ? 'Long' : ''}`, { d: value });
}
