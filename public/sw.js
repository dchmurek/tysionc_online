// Service Worker: cache WYŁĄCZNIE zasobów statycznych (powłoka aplikacji).
// Dane z /api/ nigdy nie trafiają do cache Service Workera (prywatne dane innych użytkowników).
const VERSION = 'tysiac-v2.3.2-anim';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png',
  '/vendor/chart.umd.min.js', '/vendor/qrcode.js',
  '/js/main.js', '/js/dom.js', '/js/api.js', '/js/state.js', '/js/ws.js', '/js/ui.js', '/js/fx.js',
  '/js/views/auth.js', '/js/views/home.js', '/js/views/offline.js', '/js/views/match.js', '/js/views/charts.js',
  '/js/views/online.js', '/js/views/stats.js', '/js/views/history.js', '/js/views/profile.js', '/js/views/admin.js',
  '/shared/rules.js', '/shared/scoring.js', '/shared/stats.js', '/shared/nick.js', '/shared/cards.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return; // zawsze sieć
  // Sieć najpierw (świeża wersja po aktualizacji), cache jako zapas bez internetu.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(url.pathname === '/' ? '/index.html' : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))),
  );
});
