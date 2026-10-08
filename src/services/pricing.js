// Subscription prices. Two billing currencies: EUR for euro countries, USD everywhere else.
// Prices are set by the admin (Site settings → prices); nothing is invented here.
import { getCountry } from '../lib/countries.js';

export const BILLING_CURRENCIES = ['USD', 'EUR'];

export function billingCurrency(country) {
  return getCountry(country)?.currency === 'EUR' ? 'EUR' : 'USD';
}

/** → { currency, amount|null } for a plan, kind (cook|restaurant) and country, from admin settings. */
export function priceFor(settings, plan, country, kind = 'cook') {
  const currency = billingCurrency(country);
  const v = settings?.prices?.[kind]?.[plan]?.[currency.toLowerCase()];
  const amount = v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  return { currency, amount };
}

export function formatPrice(amount, currency) {
  return `${currency === 'EUR' ? '€' : '$'}${Number(amount).toFixed(Number(amount) % 1 ? 2 : 0)}`;
}
