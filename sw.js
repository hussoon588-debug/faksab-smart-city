/*
 * FAKSAB SMART CITY — service worker.
 *
 * Scope-relative on purpose: the same file must work at a domain root
 * (`http://localhost:8000/`) and under the GitHub Pages repository subpath
 * (`https://<owner>.github.io/faksab-smart-city/`). Every precached path is
 * resolved against `self.registration.scope` instead of hard-coding a base path.
 */
const APP_VERSION = '8.2.4';
const CACHE_NAME = `faksab-v${APP_VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './vendor/three.module.js',
  './vendor/OrbitControls.js',
  './vendor/supabase.umd.js',
  './src/supabase-world.js'
];

const scopeUrl = () => new URL(self.registration.scope);
const toUrl = (path) => new URL(path, scopeUrl()).href;
const indexUrl = () => toUrl('./index.html');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // One failing optional asset must not break the whole install.
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

const inScope = (url) => url.origin === self.location.origin && url.href.startsWith(self.registration.scope);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!inScope(url)) return;

  // Navigations: network first so a fresh deploy lands immediately, cache as fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(indexUrl(), copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(indexUrl()).then((cached) => cached || caches.match(toUrl('./'))))
    );
    return;
  }

  // Static assets: cache first, refresh in the background, never mask a real 404
  // by returning the HTML shell for a missing script or image.
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
