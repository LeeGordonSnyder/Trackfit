// Offline support: try the network first (so updates show up), fall back to the cache
// when offline or when the gym's signal is too slow.
const CACHE = 'trackfit-v6';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon.svg',
  ...['barlow-400', 'barlow-500', 'barlow-600', 'barlow-700', 'barlow-condensed-600', 'barlow-condensed-700', 'barlow-condensed-800'].map((f) => `./fonts/${f}.woff2`)];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const network = fetch(event.request).then((res) => {
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      });
      network.catch(() => {}); // handled below via the cache fallback
      const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
      } catch { /* offline */ }
      return (await cache.match(event.request, { ignoreSearch: true })) || network;
    })
  );
});
