/*
 * OFUQ — service worker.
 * Scope-relative: the same file is valid locally (`/apps/ofuq/`) and on GitHub
 * Pages (`/faksab-smart-city/apps/ofuq/`). Bump APP_VERSION with the manifest.
 */
const APP_VERSION = '0.2.0';
const CACHE_NAME = `ofuq-v${APP_VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/style.css',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
  './assets/fonts/cairo-arabic.woff2',
  './assets/fonts/cairo-latin.woff2',
  './src/main.js',
  './src/config.js',
  './src/core.js',
  './src/store.js',
  './src/remote.js',
  './src/scene.js',
  './src/ui.js'
];

const toUrl = (path) => new URL(path, new URL(self.registration.scope)).href;
const indexUrl = () => toUrl('./index.html');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          ASSETS.map((path) =>
            fetch(toUrl(path), { cache: 'reload' }).then((response) => {
              if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
              return cache.put(toUrl(path), response);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(indexUrl(), copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(indexUrl()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    })
  );
});
