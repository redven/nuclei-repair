// ipad_repair/sw.js
// Offline: the app's own files network-first (fresh when online, cached when
// not); Pyodide from the CDN cache-first (its URLs carry the version).  Drive
// and the local exchange folder always go to the network.

const VERSION = new URL(self.location).searchParams.get('v') || '0';
const APP = `nuclei-repair-app-${VERSION}`;
const CDN = 'nuclei-repair-cdn';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nuclei-repair-app-') && k !== APP)
                                     .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/exchange/')) return;
    e.respondWith(networkFirst(e.request));
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(cacheFirst(e.request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(APP);
  try {
    // revalidate with the server: GitHub Pages lets browsers keep files for
    // 10 min, which would hide a fresh deploy (a new config.js) that long
    const response = await fetch(new Request(request.url,
                                             { cache: 'no-cache', credentials: 'same-origin' }));
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CDN);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
