// Browser E2E (real Chromium): customer flow + cook signup → admin activation → visible to customers.
// Needs Playwright:  PLAYWRIGHT=<path to playwright/index.mjs> CHROMIUM=<path to chrome> node test/e2e/browser.e2e.mjs
import assert from 'node:assert/strict';
import { createApp } from '../../src/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96176691688',
  bootstrapAdmin: { username: 'ali.takaji', password: 'correct-horse-battery' }, rateLimitScale: 1000, placesFetcher: async () => [] });
await new Promise((r) => app.server.listen(0, r));
const B = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ZAHLE = { latitude: 33.8466, longitude: 35.9031, accuracy: 10 };
const errors = [];
const page = async (geo) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(geo ? { geolocation: geo, permissions: ['geolocation'] } : {}) });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.route('https://wa.me/**', (r) => r.fulfill({ status: 200, body: 'wa' }));
  await p.route('https://fonts.**', (r) => r.fulfill({ status: 200, body: '' }));
  return p;
};
const step = (s) => console.log('✓', s);

// 1) cook signs up
const cook = await page(ZAHLE);
await cook.goto(B + '/join'); await cook.waitForTimeout(1800);
await cook.fill('#fullName', 'أم علي'); await cook.fill('#whatsapp', '71000111');
await cook.click('#gpsBtn'); await cook.waitForSelector('#gpsAccuracy:not([hidden])', { timeout: 20000 });
await cook.check('#servedEditor input[type=checkbox] >> nth=0');
await cook.check('#serviceChips input >> nth=0');
await cook.click('#submitBtn'); await cook.waitForTimeout(1500);
if (!(await cook.isVisible('#doneView'))) {
  console.log('form error:', await cook.textContent('#formError'), '| field errors:', await cook.$$eval('.err:not([hidden])', (els) => els.map((e) => e.dataset.err + '=' + e.textContent)));
}
assert.ok(await cook.isVisible('#doneView'), 'application sent');
step('cook signed up with GPS and picked villages → pending');

// 2) admin activates the subscription
const adm = await page();
await adm.goto(B + '/admin/'); await adm.fill('#u', 'ALI.TAKAJI'); await adm.fill('#p', 'correct-horse-battery');
await adm.click('#loginForm button[type=submit]'); await adm.waitForTimeout(800);
await adm.click('.admin-row >> nth=0'); await adm.waitForTimeout(700);
await adm.click('[data-act=approve]'); await adm.waitForTimeout(500);
await adm.click('[data-act=activate]'); await adm.waitForTimeout(700);
assert.match(await adm.textContent('#dlgBody'), /فعّال/);
step('admin approved + activated the subscription');

// 3) customer: craving → location → nearby cooks → select → WhatsApp with the full order
const cust = await page(ZAHLE);
await cust.goto(B + '/'); await cust.waitForTimeout(1800);
await cust.fill('#requestText', 'بدي صينية كبة لـ 8 أشخاص نهار الجمعة');
await cust.click('#homeForm button[type=submit]');
await cust.click('#gpsBtn'); await cust.waitForSelector('#step-results:not([hidden])', { timeout: 20000 });
const found = await cust.$$eval('.cook-name', (els) => els.map((e) => e.textContent));
assert.ok(found.includes('أم علي'), 'cook appears for the customer');
step(`customer located → nearby cooks: ${found.join(', ')}`);
await cust.click('.cook >> nth=0'); await cust.waitForTimeout(300);
await cust.click('#waBtn'); await cust.waitForURL(/wa\.me/, { timeout: 10000 });
const wa = new URL(cust.url());
assert.equal(wa.pathname, '/96171000111');
assert.ok(wa.searchParams.get('text').includes('بدي صينية كبة لـ 8 أشخاص نهار الجمعة'));
step('WhatsApp opened for the cook with the whole order text');

assert.deepEqual(errors, [], 'no JavaScript errors');
step('no JavaScript errors on any page');
await browser.close(); await app.close();
console.log('E2E passed');
