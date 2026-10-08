// Turns the owner's design choices (admin panel → Design) into a small CSS file served at /theme.css.
// Only validated values are used: colours must be #rgb / #rrggbb, sizes and layouts come from fixed lists.
import { readableVars, varsCss, luminance } from '../lib/contrast.js';
import { OLD_PAGES } from './designs.js';

export const LAYOUTS = { cooks: ['slider', 'grid', 'list'], restaurants: ['slider', 'grid', 'list'] };
export const FONT_SCALES = [0.9, 1, 1.1, 1.2];
// Ready-made logos (public/assets/logos/*.svg) and backgrounds (public/assets/bg/*.svg); the owner can also upload his own.
export const UI_SHAPES = ['square', 'rounded', 'pill'];
export const UI_COLOR_KEYS = ['btnBg', 'btnText', 'fieldBg', 'fieldText', 'fieldBorder'];
export const LOGO_PRESETS = ['bowl', 'pin-bowl', 'pin-bag', 'basket', 'a-pin'];
export const BG_PRESETS = ['food', 'shops', 'map', 'dots', 'plain'];
// Image sizes per group: xs (very small) · s (small) · m (current design) · l (large)
export const SIZE_KEYS = ['dishes', 'restaurants', 'cooks', 'dishFeed', 'gallery'];
export const SIZES = ['xs', 's', 'm', 'l'];
const SIZE_CSS = {
  dishes: { xs: '.dish, .dish-ph { width: 9rem; } .dish-ph svg { width: 3rem; height: 3rem; }', s: '.dish, .dish-ph { width: 12rem; }', l: '.dish, .dish-ph { width: 18.5rem; }' },
  restaurants: { xs: '.rest-card { width: 46%; max-width: 11rem; }', s: '.rest-card { width: 62%; max-width: 15rem; }', l: '.rest-card { width: 90%; max-width: 26rem; }' },
  cooks: {
    xs: '.cook-card { width: 6rem; } .cook-card .avatar { width: 3.6rem; height: 3.6rem; font-size: 1.4rem; } .cat-thumb { width: 3.1rem; } .cat-thumb img, .cat-initial { width: 3.1rem; height: 3.1rem; font-size: 1.2rem; }',
    s: '.cook-card { width: 7.2rem; } .cook-card .avatar { width: 4.4rem; height: 4.4rem; font-size: 1.7rem; } .cat-thumb { width: 3.5rem; } .cat-thumb img, .cat-initial { width: 3.5rem; height: 3.5rem; }',
    l: '.cook-card { width: 10rem; } .cook-card .avatar { width: 6.4rem; height: 6.4rem; font-size: 2.4rem; } .cat-thumb { width: 5rem; } .cat-thumb img, .cat-initial { width: 5rem; height: 5rem; font-size: 1.9rem; }',
  },
  dishFeed: {
    xs: '.dish-feed { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; } .dish-post-text { padding: 0.4rem 0.5rem; font-size: 0.75rem; }',
    s: '.dish-feed { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem; } .dish-post-text { font-size: 0.85rem; }',
    l: '.dish-post img { aspect-ratio: 1 / 1; }',
  },
  gallery: { xs: '.gallery { grid-template-columns: repeat(4, 1fr); }', s: '.gallery { grid-template-columns: repeat(3, 1fr); }', l: '.gallery { grid-template-columns: 1fr; }' },
};
export const COLOR_KEYS = { gold: '--gold', goldSoft: '--gold-soft', bg: '--bg', surface: '--surface', text: '--text', muted: '--muted' };
export const isColor = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || ''));

export function themeCss(theme = {}) {
  const lines = ['/* Aklatak — design chosen in the admin panel */'];
  const vars = Object.entries(COLOR_KEYS)
    .filter(([k]) => isColor(theme.colors?.[k]))
    .map(([k, v]) => `${v}: ${theme.colors[k]};`);
  if (vars.length) lines.push(`:root { ${vars.join(' ')} }`, `body { background-color: var(--bg); }`);
  // whatever colours were picked, text stays readable (light mode; dark mode has its own safe colours)
  const c = theme.colors || {};
  const rv = readableVars({ bg: isColor(c.bg) ? c.bg : '#FFFFFF', soft: c.surface, brand: c.gold, ink: c.text, mute: c.muted });
  if (Object.keys(rv).length) lines.push(`:root { ${varsCss(rv)} }`);
  // a light page colour: the old dark boxes follow it so their text stays readable
  if (isColor(c.bg) && luminance(c.bg) > 0.4) lines.push(OLD_PAGES);
  const scale = FONT_SCALES.includes(Number(theme.fontScale)) ? Number(theme.fontScale) : 1;
  if (scale !== 1) lines.push(`html { font-size: ${Math.round(scale * 100)}%; }`);
  const grid = (sel, cols) => `${sel} { display: grid; grid-template-columns: repeat(${cols}, minmax(0, 1fr)); overflow: visible; scroll-snap-type: none; margin-inline: 0; padding-inline: 0; }`;
  const cooks = theme.layouts?.cooks;
  if (cooks === 'grid') lines.push(grid('#cookSlider', 2), '#cookSlider > * { width: auto; }');
  if (cooks === 'list') lines.push(grid('#cookSlider', 1), '#cookSlider > * { width: auto; }');
  const rest = theme.layouts?.restaurants;
  if (rest === 'grid') lines.push(grid('#restSlider', 2), '#restSlider .rest-card { width: auto; max-width: none; }');
  if (rest === 'list') lines.push(grid('#restSlider', 1), '#restSlider .rest-card { width: auto; max-width: none; }');
  const bg = theme.background || '';
  const bgUrl = bg.startsWith('asset:') ? `/media/asset/${bg.slice(6)}` : bg.startsWith('preset:') && bg !== 'preset:food' && bg !== 'preset:plain' ? `/assets/bg/${bg.slice(7)}.svg` : null;
  if (bg === 'preset:plain') lines.push('body { background-image: none; } .hero::after { display: none; }');
  else if (bgUrl) lines.push(`body { background-image: url('${bgUrl}'); background-size: ${bg.startsWith('asset:') ? 'cover' : '320px 320px'}; background-attachment: ${bg.startsWith('asset:') ? 'fixed' : 'scroll'}; } .hero::after { display: none; }`,
    // a picture behind the text: a veil of the page colour keeps every word readable
    `body::before { content: ''; position: fixed; inset: 0; background: var(--bg); opacity: ${bg.startsWith('asset:') ? 0.82 : 0.6}; pointer-events: none; z-index: -1; }`);
  // buttons & fields: shape and colours chosen by the owner
  const ui = theme.ui || {};
  const radius = { square: '4px', rounded: '14px', pill: '999px' };
  const btnSel = '.btn, .cat-btn, .all-near, .choice, .more-btn, .act, .kbd-toggle';
  const fieldSel = '.input, input.input, textarea.input, select.input';
  if (radius[ui.btnShape]) lines.push(`${btnSel} { border-radius: ${radius[ui.btnShape]} !important; }`);
  if (isColor(ui.btnBg)) lines.push(`.btn-gold, .cat-btn, .all-near { background: ${ui.btnBg} !important; }`);
  if (isColor(ui.btnText)) lines.push(`.btn-gold, .cat-btn, .all-near { color: ${ui.btnText} !important; }`);
  if (radius[ui.fieldShape]) lines.push(`${fieldSel} { border-radius: ${ui.fieldShape === 'pill' ? '24px' : radius[ui.fieldShape]} !important; }`);
  if (isColor(ui.fieldBg)) lines.push(`${fieldSel} { background-color: ${ui.fieldBg} !important; }`);
  if (isColor(ui.fieldText)) lines.push(`${fieldSel} { color: ${ui.fieldText} !important; }`);
  if (isColor(ui.fieldBorder)) lines.push(`${fieldSel} { border-color: ${ui.fieldBorder} !important; }`);
  for (const k of SIZE_KEYS) {
    const v = theme.sizes?.[k];
    if (v && v !== 'm' && SIZE_CSS[k][v]) lines.push(SIZE_CSS[k][v]);
  }
  return lines.join('\n') + '\n';
}
