// Cache only the application shell. Private API responses and project files never enter
// this cache; their existing workspace/asset stores remain the sole offline source.
const CACHE = 'tiksi-shell-v1';
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(c => c.add('/'))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') ||
      !(url.pathname === '/' || url.pathname === '/index.html' || /^\/(js|css|vendor|assets)\//.test(url.pathname))) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(c => c.put(event.request, copy))); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || Response.error()));
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'cache-shell' || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter(value => { try { const u = new URL(value); return u.origin === self.location.origin && /^\/(js|css|vendor)\//.test(u.pathname); } catch { return false; } });
  event.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(urls.map(u => c.add(u)))));
});
