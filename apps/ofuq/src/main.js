/**
 * OFUQ — entry point.
 * Boots the store, mounts the UI and registers the (scope-relative) service worker.
 */
import { APP } from './config.js';
import { createStore } from './store.js';
import { mount } from './ui.js';

const bootErrors = [];
const store = createStore({
  onError: (message, error) => {
    bootErrors.push({ message, error });
    console.warn('[ofuq]', message, error);
  }
});

const ui = mount(store);
document.documentElement.dataset.app = `${APP.id}@${APP.version}`;

if (bootErrors.length > 0) {
  ui.toast(bootErrors[0].message, 'bad');
}

// Runtime safety net: a broken render must never leave the player without feedback.
window.addEventListener('error', (event) => {
  console.error('[ofuq] uncaught', event.error ?? event.message);
  ui.toast('حدث خطأ غير متوقع — تم الاحتفاظ بتقدمك.', 'bad');
});

// Offline shell. Relative registration keeps the app installable both locally and
// under the GitHub Pages subpath.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((registration) => {
      registration.addEventListener('updatefound', () => registration.update().catch(() => {}));
    }).catch((error) => console.warn('[ofuq] service worker', error));
  });
}
