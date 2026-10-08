// Great-circle distance (Haversine) and a cheap bounding box used to pre-filter in SQL.
const EARTH_RADIUS_KM = 6371.0088;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function boundingBox(lat, lng, km) {
  const dLat = km / 110.574;
  const dLng = km / (111.32 * Math.max(0.01, Math.cos(toRad(lat))));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

export const roundTo = (v, decimals) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

export const isValidLatLng = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
