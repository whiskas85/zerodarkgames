// Service worker: app shell offline, font in cache, notifiche push.
const VERSION = 'zdg-v184';
const SHELL = [
  '/', '/index.html', '/css/base.css', '/css/app.css', '/js/lib.js', '/js/app.js',
  '/manifest.webmanifest', '/regia.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-round-192.png', '/icons/icon-round-512.png', '/icons/badge.png', '/img/zdt-logo.jpg', '/regolamento.html', '/vendor/jsQR.js', '/js/map.js', '/js/field-ui.js', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
];
const PAGES = { '/campo': '/campo.html', '/regia': '/regia.html', '/soglia': '/soglia.html', '/tabellone': '/tabellone.html', '/iscrizione': '/iscrizione.html' };

// Tiene al massimo ~1500 riquadri di mappa in cache.
let trimming = false;
async function trimTiles(c) {
  if (trimming) return;
  trimming = true;
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - 1500))) await c.delete(k);
  trimming = false;
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'zdg-fonts' && k !== 'zdg-tiles').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Riquadri OpenTopoMap: cache-first, così la mappa già vista funziona anche senza segnale nel bosco.
  if (url.hostname.endsWith('tile.opentopomap.org')) {
    e.respondWith(caches.open('zdg-tiles').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') {
          c.put(req, res.clone());
          trimTiles(c);
        }
        return res;
      } catch { return new Response('', { status: 504 }); }
    }));
    return;
  }

  // Font Google: cache-first.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open('zdg-fonts').then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      } catch { return new Response('', { status: 504 }); }
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/login/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/regia/stampa')) return;

  // Navigazione: rete prima, poi la shell in cache (anche per /a/<token> inquadrato senza rete).
  if (req.mode === 'navigate') {
    const page = PAGES[url.pathname] || '/index.html';
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && page === '/index.html') caches.open(VERSION).then((c) => c.put('/index.html', res.clone()));
      return res;
    }).catch(async () => (await caches.match(page)) || (await caches.match('/index.html'))));
    return;
  }

  // Risorse statiche: rete prima (aggiornamenti immediati), cache se la rete manca o tarda più di 3 secondi.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; });
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const res = await Promise.race([net, timeout]);
      if (res) return res;
    } catch { /* offline */ }
    const hit = await c.match(req, { ignoreSearch: true });
    return hit || net;
  }));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Consiglio Zero', body: e.data?.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'Consiglio Zero', {
      body: data.body || '',
      tag: data.tag,
      renotify: true,
      vibrate: [220, 100, 220, 100, 220],
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      data: { url: data.url || '/' },
      // Emergenza: la notifica resta finché non la si tocca.
      requireInteraction: !!data.requireInteraction,
    });
    const wins = await self.clients.matchAll({ type: 'window' });
    wins.forEach((w) => w.postMessage({ type: 'refresh' }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const url = new URL(target, location.origin);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // App già aperta: la porta in primo piano e cambia pagina (es. #/avvisi) senza ricaricare.
    const app = wins.find((w) => new URL(w.url).pathname === url.pathname || (url.pathname === '/' && new URL(w.url).pathname.startsWith('/a/')));
    if (app) {
      await app.focus();
      app.postMessage({ type: 'navigate', hash: url.hash || '#/home' });
      return null;
    }
    return self.clients.openWindow(url.href);
  })());
});
