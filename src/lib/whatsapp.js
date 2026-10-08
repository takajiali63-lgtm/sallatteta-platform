// WhatsApp click-to-chat (wa.me) — works in every country with the full international number.
// Phone parsing lives in countries.js; this file only builds links and fills message templates.
export { normalizePhone } from './countries.js';

export function buildWhatsAppLink(number, text) {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

export function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}
