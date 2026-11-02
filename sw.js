// Lets the app open without internet. Network first (to pick up updates), cache as fallback.
// Requests bypass the browser HTTP cache (GitHub Pages sends max-age=600), otherwise a fresh
// deploy can take ~10 minutes to show up even though the service worker asks the network.
const CACHE = 'muse-eeg-v15';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'js/main.js', 'js/muse.js', 'js/protocol.js', 'js/dsp.js', 'js/recorder.js', 'js/chart.js', 'js/neuro.js', 'js/game.js', 'js/scene.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(e.request)),
  );
});
