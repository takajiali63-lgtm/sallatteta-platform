// Business categories (restaurants, home cooks, bakeries, butchers, pharmacies…) — fully managed from the admin panel.
// A category is { key, icon, names: { lang: { one, many } }, home, deleted }. Order = array order.
// "home: false" hides it from the home page and the menu, but it stays in the sign-up list so the first subscriber can join.
// "deleted: true" removes it everywhere new (existing subscribers keep their data).

const n = (arOne, arMany, enOne, enMany, frOne, frMany, esOne, esMany) => ({
  ar: { one: arOne, many: arMany }, en: { one: enOne, many: enMany }, fr: { one: frOne, many: frMany }, es: { one: esOne, many: esMany },
});

export const DEFAULT_CATEGORIES = [
  { key: 'restaurant', icon: '🍽️', home: true, names: n('مطعم', 'مطاعم', 'Restaurant', 'Restaurants', 'Restaurant', 'Restaurants', 'Restaurante', 'Restaurantes') },
  { key: 'cook', icon: '👩‍🍳', home: true, names: n('طبّاخ منزلي', 'طبّاخون منزليون', 'Home cook', 'Home cooks', 'Cuisinier à domicile', 'Cuisiniers à domicile', 'Cocinero casero', 'Cocineros caseros') },
  { key: 'bakery', icon: '🥖', home: true, names: n('فرن', 'أفران', 'Bakery', 'Bakeries', 'Boulangerie', 'Boulangeries', 'Panadería', 'Panaderías') },
  { key: 'butcher', icon: '🥩', home: true, names: n('ملحمة', 'ملاحم', 'Butcher', 'Butchers', 'Boucherie', 'Boucheries', 'Carnicería', 'Carnicerías') },
  { key: 'supermarket', icon: '🛒', home: true, names: n('سوبرماركت', 'سوبرماركات', 'Supermarket', 'Supermarkets', 'Supermarché', 'Supermarchés', 'Supermercado', 'Supermercados') },
  { key: 'minimarket', icon: '🏪', home: true, names: n('ميني ماركت', 'ميني ماركت', 'Mini market', 'Mini markets', 'Supérette', 'Supérettes', 'Minimercado', 'Minimercados') },
  { key: 'produce', icon: '🍎', home: true, names: n('محل خضار وفواكه', 'محلات خضار وفواكه', 'Fruit & vegetable shop', 'Fruit & vegetable shops', 'Primeur', 'Primeurs', 'Frutería', 'Fruterías') },
  { key: 'juice', icon: '🧃', home: true, names: n('محل عصير وحلويات', 'محلات عصير وحلويات', 'Juice & sweets shop', 'Juice & sweets shops', 'Jus et pâtisserie', 'Jus et pâtisseries', 'Jugos y dulces', 'Jugos y dulces') },
  { key: 'pharmacy', icon: '💊', home: true, names: n('صيدلية', 'صيدليات', 'Pharmacy', 'Pharmacies', 'Pharmacie', 'Pharmacies', 'Farmacia', 'Farmacias') },
  { key: 'gym', icon: '🏋️', home: true, names: n('نادٍ رياضي', 'أندية رياضية', 'Gym', 'Gyms', 'Salle de sport', 'Salles de sport', 'Gimnasio', 'Gimnasios') },
];

// Craftspeople who work for themselves, without a shop (group "crafts"): they come to the customer; their location is never shown.
export const CRAFT_DEFAULTS = [
  { key: 'electrician', icon: '⚡', names: n('كهربائي', 'كهربائيون', 'Electrician', 'Electricians', 'Électricien', 'Électriciens', 'Electricista', 'Electricistas') },
  { key: 'plumber', icon: '🔧', names: n('سبّاك', 'سبّاكون', 'Plumber', 'Plumbers', 'Plombier', 'Plombiers', 'Fontanero', 'Fontaneros') },
  { key: 'mechanic', icon: '🚗', names: n('ميكانيكي', 'ميكانيكيون', 'Mechanic', 'Mechanics', 'Mécanicien', 'Mécaniciens', 'Mecánico', 'Mecánicos') },
  { key: 'carpenter', icon: '🪚', names: n('نجّار', 'نجّارون', 'Carpenter', 'Carpenters', 'Menuisier', 'Menuisiers', 'Carpintero', 'Carpinteros') },
  { key: 'painter', icon: '🎨', names: n('دهّان', 'دهّانون', 'Painter', 'Painters', 'Peintre', 'Peintres', 'Pintor', 'Pintores') },
  { key: 'ac_tech', icon: '❄️', names: n('فنّي تكييف وتبريد', 'فنّيو تكييف وتبريد', 'AC technician', 'AC technicians', 'Frigoriste', 'Frigoristes', 'Técnico de aire', 'Técnicos de aire') },
  { key: 'cleaner', icon: '🧹', names: n('عامل تنظيف', 'عمّال تنظيف', 'Cleaner', 'Cleaners', 'Agent de ménage', 'Agents de ménage', 'Limpiador', 'Limpiadores') },
  { key: 'blacksmith', icon: '🔩', names: n('حدّاد', 'حدّادون', 'Blacksmith', 'Blacksmiths', 'Ferronnier', 'Ferronniers', 'Herrero', 'Herreros') },
  { key: 'repair_tech', icon: '📺', names: n('فنّي تصليح أجهزة', 'فنّيو تصليح أجهزة', 'Appliance repair', 'Appliance repairers', 'Réparateur', 'Réparateurs', 'Técnico de reparación', 'Técnicos de reparación') },
].map((c) => ({ ...c, home: true, group: 'crafts' }));
for (const c of CRAFT_DEFAULTS) DEFAULT_CATEGORIES.push(c);

// Which kinds are crafts (kept in sync with the saved categories): private location, "come to me", call.
let CRAFT_KINDS = new Set(CRAFT_DEFAULTS.map((c) => c.key));
export const setCategories = (cats) => { CRAFT_KINDS = new Set((cats || []).filter((c) => c.group === 'crafts').map((c) => c.key)); };
export const isCraft = (kind) => CRAFT_KINDS.has(kind);
/** Home cooks and craftspeople: their exact location (a home) is never shown, no directions to it. */
export const isPrivateKind = (kind) => (kind || 'cook') === 'cook' || CRAFT_KINDS.has(kind);
export const groupOf = (c) => (c?.group === 'crafts' ? 'crafts' : 'shops');

export const KEY_RE = /^[a-z][a-z0-9_]{1,30}$/;
export const LANGS = ['ar', 'en', 'fr', 'es'];

/** Clean a list sent by the admin panel (names trimmed, emoji short, unknown fields dropped). Returns null if invalid. */
export function cleanCategories(list) {
  if (!Array.isArray(list) || list.length > 60) return null;
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c || !KEY_RE.test(String(c.key)) || seen.has(c.key)) return null;
    seen.add(c.key);
    const names = {};
    for (const l of LANGS) {
      const one = String(c.names?.[l]?.one || '').trim().slice(0, 40);
      const many = String(c.names?.[l]?.many || '').trim().slice(0, 40);
      if (one || many) names[l] = { one: one || many, many: many || one };
    }
    if (!names.ar && !names.en) return null;
    // home: true (always shown) · false (hidden) · 'auto' (appears by itself once it has an active subscriber)
    const map = String(c.map || '').split(',').map((x) => x.trim()).filter((x) => /^[a-z_]+(\.[a-z_]+)*$/.test(x)).slice(0, 10).join(',');
    out.push({ key: c.key, icon: String(c.icon || '🏷️').slice(0, 8), home: c.home === 'auto' ? 'auto' : c.home !== false, deleted: c.deleted === true, names, ...(map ? { map } : {}), group: c.group === 'crafts' ? 'crafts' : 'shops' });
  }
  if (!out.some((c) => c.key === 'cook') || !out.some((c) => c.key === 'restaurant')) return null; // the two original kinds always exist
  return out;
}

/** Keys a subscriber may choose (everything not deleted). */
export const activeKinds = (cats) => (cats || DEFAULT_CATEGORIES).filter((c) => !c.deleted).map((c) => c.key);
export const nameOf = (cats, key, lang = 'ar', form = 'one') => {
  const c = (cats || DEFAULT_CATEGORIES).find((x) => x.key === key);
  return c?.names?.[lang]?.[form] || c?.names?.en?.[form] || c?.names?.ar?.[form] || key;
};
