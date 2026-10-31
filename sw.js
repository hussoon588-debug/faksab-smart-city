const CACHE_NAME = 'faksab-v8.2.4';
const APP_SHELL = [
  '/faksab-smart-city/',
  '/faksab-smart-city/index.html',
  '/faksab-smart-city/manifest.json',
  '/faksab-smart-city/icon-192.png',
  '/faksab-smart-city/icon-512.png',
  '/faksab-smart-city/vendor/three.module.js',
  '/faksab-smart-city/vendor/OrbitControls.js',
  '/faksab-smart-city/vendor/supabase.umd.js',
  '/faksab-smart-city/src/supabase-world.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isGitHubPagesAsset = url.pathname.startsWith('/faksab-smart-city/');

  if (!isSameOrigin || !isGitHubPagesAsset) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/faksab-smart-city/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/faksab-smart-city/index.html'))
        .then((cached) => cached || fetch('/faksab-smart-city/'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      }).catch(() => caches.match('/faksab-smart-city/index.html'));
    })
  );
});
