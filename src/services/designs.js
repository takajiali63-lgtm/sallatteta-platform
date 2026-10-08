// Ready designs for the whole platform (customer app, store, driver, sign-up and the admin panel).
// The owner picks one in the admin panel; "custom" keeps the colours chosen by hand in "Design".
// Each design = colours (new + old style sheets) + its own shapes, image style and 3D effects.
import { readableVars, varsCss } from '../lib/contrast.js';

const shared3d = `
.store,.card,.stat,.cat span,.item .thumb,.panel,.admin-list>li{transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s ease}
.store:active,.card:active,.stat:active{transform:perspective(900px) rotateX(2.5deg) translateY(1px) scale(.992)}
@media (hover:hover){.store:hover{transform:perspective(900px) rotateX(3deg) translateY(-3px)}.stat:hover,.card:hover{transform:translateY(-2px)}}
@keyframes ak-up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.store,.card,.item{animation:ak-up .35s ease both}
@media (prefers-reduced-motion:reduce){.store,.card,.item{animation:none}.store:hover,.store:active,.card:active,.stat:active{transform:none}}`;

export const DESIGNS = {
  emerald: {
    name: { ar: 'زمرّدي فاتح', en: 'Emerald light' },
    vars: { bg: '#FFFFFF', soft: '#F6F7F9', line: '#E8EAED', ink: '#1F2937', mute: '#6B7280', brand: '#0E9F7E', brandInk: '#FFFFFF', brandSoft: '#E6F6F1', accent: '#FF7A59', accentSoft: '#FFF0EB', r: '16px' },
    css: `${shared3d}
.store .cover,.hero{box-shadow:0 10px 24px -14px rgba(16,24,40,.35)}
.card,.stat{box-shadow:0 1px 2px rgba(16,24,40,.05)}`,
  },
  midnight: {
    name: { ar: 'ليلي فخم (ذهبي)', en: 'Midnight gold' },
    vars: { bg: '#0B0F17', soft: '#141A26', line: '#232C3B', ink: '#F5F1E8', mute: '#9AA3B2', brand: '#D4AF37', brandInk: '#14110A', brandSoft: '#2A2412', accent: '#E8875B', accentSoft: '#33201A', r: '18px' },
    bgImage: 'radial-gradient(1200px 600px at 80% -10%, rgba(212,175,55,.12), transparent 60%), radial-gradient(900px 500px at -10% 110%, rgba(232,135,91,.10), transparent 60%)',
    css: `${shared3d}
.store .cover{box-shadow:0 18px 40px -18px rgba(0,0,0,.8),inset 0 0 0 1px rgba(212,175,55,.25)}
.store .cover::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 45%,rgba(0,0,0,.55))}
.card,.stat,.panel{background:linear-gradient(180deg,#161D2B,#111723)!important;border-color:#26304180!important;box-shadow:0 12px 30px -20px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.04)}
.btn{box-shadow:0 8px 20px -10px rgba(212,175,55,.55)}
.btn.alt{box-shadow:none}
.logo{box-shadow:0 0 0 3px var(--bg),0 0 0 4px rgba(212,175,55,.6)!important}`,
  },
  glass: {
    name: { ar: 'زجاجي ثلاثي الأبعاد', en: '3D glass' },
    vars: { bg: '#0E1030', soft: 'rgba(255,255,255,.08)', line: 'rgba(255,255,255,.14)', ink: '#F4F5FF', mute: '#B7BBE0', brand: '#7C5CFF', brandInk: '#FFFFFF', brandSoft: 'rgba(124,92,255,.22)', accent: '#00D1B2', accentSoft: 'rgba(0,209,178,.18)', r: '22px' },
    bgImage: 'radial-gradient(800px 500px at 10% 0%, #3B2A8C 0%, transparent 60%), radial-gradient(700px 500px at 100% 30%, #0F6E7A 0%, transparent 60%), linear-gradient(160deg,#0E1030,#151848)',
    css: `${shared3d}
.card,.stat,.panel,.search,.toggle,.list a,.list button.li,.sheet,.nav{background:rgba(255,255,255,.07)!important;backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);border:1px solid rgba(255,255,255,.14)!important}
.store .cover{transform:translateZ(0);box-shadow:0 24px 50px -24px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.12)}
.store:hover .cover{box-shadow:0 30px 60px -22px rgba(124,92,255,.55),0 0 0 1px rgba(255,255,255,.2)}
.cat span{background:linear-gradient(145deg,rgba(255,255,255,.16),rgba(255,255,255,.04))!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 10px 18px -12px rgba(0,0,0,.8)}
.btn{background:linear-gradient(135deg,#7C5CFF,#5B8CFF);box-shadow:0 10px 24px -10px rgba(124,92,255,.8)}
.btn.alt{background:rgba(255,255,255,.08)}
.btn.acc{background:linear-gradient(135deg,#00D1B2,#00A3FF)}`,
  },
  sand: {
    name: { ar: 'رملي أنيق', en: 'Elegant sand' },
    vars: { bg: '#FAF7F2', soft: '#F1EBE1', line: '#E4DACB', ink: '#2B2118', mute: '#7A6C5D', brand: '#B5651D', brandInk: '#FFFFFF', brandSoft: '#F5E6D6', accent: '#2F6F5E', accentSoft: '#E1EFEA', r: '24px' },
    css: `${shared3d}
.store .cover{border-radius:28px;box-shadow:0 14px 30px -18px rgba(90,60,20,.45)}
.logo{border-radius:14px!important}
.card,.stat{box-shadow:0 2px 0 #E4DACB}
h1,h2{letter-spacing:-.01em}`,
  },
  ocean: {
    name: { ar: 'أزرق محيطي', en: 'Ocean blue' },
    vars: { bg: '#F5F9FF', soft: '#E9F1FD', line: '#D7E3F5', ink: '#0F213D', mute: '#5B6B84', brand: '#1565D8', brandInk: '#FFFFFF', brandSoft: '#E3EEFF', accent: '#FF8A3D', accentSoft: '#FFF0E5', r: '14px' },
    css: `${shared3d}
.store{background:#fff;border-radius:20px;padding:8px;box-shadow:0 10px 28px -18px rgba(21,101,216,.45)}
.store .cover{border-radius:14px}
.btn{box-shadow:0 8px 18px -10px rgba(21,101,216,.7)}`,
  },
  rose: {
    name: { ar: 'وردي عصري', en: 'Modern rose' },
    vars: { bg: '#FFF8FA', soft: '#FBEDF2', line: '#F1D9E2', ink: '#2A1420', mute: '#86687A', brand: '#C2185B', brandInk: '#FFFFFF', brandSoft: '#FBE3EC', accent: '#6A1B9A', accentSoft: '#F1E4F8', r: '20px' },
    css: `${shared3d}
.store .cover{box-shadow:0 16px 34px -20px rgba(194,24,91,.55)}
.cat span{border-radius:50%!important}
.btn{border-radius:999px}`,
  },
};

export function designCss(key) {
  const d = DESIGNS[key];
  if (!d) return '';
  const v = d.vars;
  const root = [
    // new screens
    `--bg:${v.bg}`, `--soft:${v.soft}`, `--line:${v.line}`, `--ink:${v.ink}`, `--mute:${v.mute}`, `--brand:${v.brand}`, `--brand-ink:${v.brandInk}`,
    `--brand-soft:${v.brandSoft}`, `--accent:${v.accent}`, `--accent-soft:${v.accentSoft}`, `--r:${v.r}`,
    // older pages (sign-up, admin)
    `--surface:${v.soft}`, `--surface-2:${v.soft}`, `--gold:${v.brand}`, `--gold-soft:${v.brand}`, `--text:${v.ink}`, `--muted:${v.mute}`,
    // text that stays readable on this design's backgrounds (checked automatically)
    varsCss(readableVars({ bg: v.bg, soft: v.soft, brand: v.brand, brandSoft: v.brandSoft, accent: v.accent, accentSoft: v.accentSoft, ink: v.ink, mute: v.mute, brandInk: v.brandInk })),
  ].join(';');
  return `/* design: ${key} */
:root,:root[data-theme]{${root}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${root}}}
html,body{background-color:${v.bg}!important;color:${v.ink}}
body{background-image:${d.bgImage || 'none'}!important;background-attachment:fixed;background-size:cover}
.hero::after{display:none}
${d.css}
${OLD_PAGES}
`;
}

// Older pages (sign-up, info pages): boxes that had a fixed dark colour follow the design, buttons get readable text.
export const OLD_PAGES = `.why-box{background:var(--surface)!important;border-color:var(--line)!important;color:var(--text)}
.why-title{color:var(--brand-text)!important}
.btn-gold{color:var(--brand-ink,#1b1407)}`;
