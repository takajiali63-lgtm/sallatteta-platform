// Readable colours: whatever colours the owner or a store picks, text must stay readable (WCAG contrast).
// The same maths runs in the browser (public/assets/x/core.js → readableVars) for a store's own colour.

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
export const isHex = (c) => HEX.test(String(c || ''));

export function rgb(hex) {
  let h = String(hex).slice(1);
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const toHex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

export function luminance(hex) {
  const a = rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
export function ratio(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
export const isDark = (hex) => luminance(hex) < 0.2;

/** White or near-black: whichever reads better on this background. */
export function inkOn(bg) {
  return ratio('#FFFFFF', bg) >= ratio('#111827', bg) ? '#FFFFFF' : '#111827';
}

/** Keep the colour's hue but darken (on light backgrounds) or lighten (on dark ones) until it reads on every background given. */
export function readable(fg, bgs, min = 4.5) {
  const list = (Array.isArray(bgs) ? bgs : [bgs]).filter(isHex);
  if (!isHex(fg) || !list.length) return fg;
  const ok = (c) => list.every((b) => ratio(c, b) >= min);
  if (ok(fg)) return toHex(rgb(fg));
  const towards = isDark(list[0]) ? [255, 255, 255] : [0, 0, 0];
  const src = rgb(fg);
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = toHex(src.map((v, i) => v + (towards[i] - v) * t));
    if (ok(c)) return c;
  }
  return toHex(towards);
}

/** CSS variables that keep text readable for a set of colours (missing ones are skipped). */
export function readableVars({ bg, soft, brand, brandSoft, accent, accentSoft, ink, mute, brandInk } = {}) {
  const base = isHex(bg) ? bg : '#FFFFFF';
  const out = {};
  const surfaces = [base, soft].filter(isHex);
  if (isHex(ink)) out['--ink'] = readable(ink, surfaces, 7);
  if (isHex(mute)) out['--mute'] = readable(mute, surfaces, 4);
  if (isHex(brand)) {
    out['--brand-text'] = readable(brand, [base, brandSoft, soft].filter(isHex));
    out['--brand-ink'] = isHex(brandInk) && ratio(brandInk, brand) >= 3 ? brandInk : inkOn(brand);
  }
  if (isHex(accent)) {
    out['--accent-text'] = readable(accent, [base, accentSoft].filter(isHex));
    out['--accent-ink'] = inkOn(accent);
  }
  if (isDark(base)) Object.assign(out, { '--warn': '#FBBF24', '--warn-soft': '#3A2E12', '--bad': '#F87171', '--bad-soft': '#3B1515' });
  return out;
}
export const varsCss = (vars) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
