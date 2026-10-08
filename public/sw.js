// Aklatak service worker — makes the site installable as an app and shows a friendly screen when offline.
// Pages and API calls always go to the network (fresh data, nothing personal stored on the phone).
const CACHE = 'aklatak-shell-v77';
const SHELL = ['/offline.html', '/assets/offline.css', '/assets/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // The offline screen's own files: always from the phone, so it looks right without a connection.
  if (url.origin === self.location.origin && SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(req)));
    return;
  }
  if (req.mode !== 'navigate') return; // everything else (API, photos, scripts): normal network
  event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
});

// Phone notifications: shown even when the app is closed; tapping one opens the right screen.
self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(m.title || 'Aklatak', {
    body: m.body || '', icon: '/assets/icons/icon-192.png', badge: '/assets/icons/icon-192.png',
    data: { url: m.url || '/' }, vibrate: [200, 100, 200], tag: m.tag || undefined, renotify: !!m.tag,
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) if (w.url.startsWith(self.location.origin)) { w.navigate(url).catch(() => {}); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
