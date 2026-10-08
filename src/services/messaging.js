// Contact channel between customers/admin and cooks, kept separate from business logic.
// Today: WhatsApp click-to-chat links (the customer's own WhatsApp opens with the order already written).
// Later: another provider (e.g. WhatsApp Business API, SMS) can implement the same interface
// { kind, link(toNumber, text) → url } without touching routes or matching.
import { buildWhatsAppLink } from '../lib/whatsapp.js';

export function createChannel(kind = 'wa.me') {
  if (kind === 'wa.me') return { kind, link: (to, text) => buildWhatsAppLink(to, text) };
  throw new Error(`unknown contact channel: ${kind}`);
}
