/* Presenze FIRE - service worker: l'app funziona anche senza rete.
 * Cambiare VERSIONE a ogni pubblicazione, cosi' i telefoni scaricano i file nuovi. */
const VERSIONE = 'presenze-fire-2.0.0';
const FILE = ['./', './index.html', './app.js', './jsQR.js', './manifest.webmanifest',
              './icone/icon-192.png', './icone/icon-512.png', './icone/icon-512-maskable.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSIONE).then((c) => c.addAll(FILE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((nomi) => Promise.all(nomi.filter((n) => n !== VERSIONE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // il foglio Google: sempre dalla rete
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((trovato) => {
      if (trovato) return trovato;
      if (req.mode === 'navigate') return caches.match('./index.html');
      return fetch(req);
    })
  );
});
