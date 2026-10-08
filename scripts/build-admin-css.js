// Builds admin-ui/dx-scoped.css from public/assets/x/x.css: the same design, scoped to the admin panel's ".dx" boxes,
// without the page-wide colour variables (the admin panel keeps its own). Run after changing x.css:
//   node scripts/build-admin-css.js
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'public/assets/x/x.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function blocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    out.push({ head, body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}
const scopeSel = (sel) => sel.split(',').map((s) => {
  s = s.trim();
  if (!s) return s;
  if (/^(html|body|:root)\b/.test(s)) return s.replace(/^(html|body|:root)(\[[^\]]*\])?/, '.dx');
  if (s.startsWith('*')) return `.dx ${s}`;
  return `.dx ${s}`;
}).join(',');

function convert(css) {
  const out = [];
  for (const b of blocks(css)) {
    if (b.head.startsWith('@media') || b.head.startsWith('@supports')) {
      if (/prefers-color-scheme/.test(b.head)) continue;           // colours come from the admin panel's theme
      const inner = convert(b.body);
      if (inner.trim()) out.push(`${b.head}{${inner}}`);
    } else if (b.head.startsWith('@')) out.push(`${b.head}{${b.body}}`);   // keyframes etc.
    else if (/^:root/.test(b.head) && /--[\w-]+\s*:/.test(b.body)) continue; // variables
    else out.push(`${scopeSel(b.head)}{${b.body}}`);
  }
  return out.join('\n');
}

const defaults = `/* defaults for variables the design may not set (own-colours mode) */
:root{--soft:var(--surface,#F6F7F9);--ink:var(--text,#1F2937);--mute:var(--muted,#6B7280);--brand:var(--gold,#0E9F7E);--brand-ink:#fff;--brand-soft:rgba(14,159,126,.14);--accent:#FF7A59;--accent-soft:rgba(255,122,89,.15);--warn:#B45309;--warn-soft:rgba(245,158,11,.18);--bad:#B91C1C;--bad-soft:rgba(220,38,38,.15);--r:16px;--r-sm:12px;--accent-ink:#fff;--brand-text:var(--brand);--accent-text:var(--accent)}`;

writeFileSync(resolve(root, 'admin-ui/dx-scoped.css'), `/* generated from public/assets/x/x.css, scoped to .dx (admin panel sections) — node scripts/build-admin-css.js */\n${convert(src)}\n${defaults}\n`);
console.log('admin-ui/dx-scoped.css written');
