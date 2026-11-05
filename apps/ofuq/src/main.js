/**
 * OFUQ — entry point.
 * Boots the store, mounts the UI and registers the (scope-relative) service worker.
 */
import { APP } from './config.js';
import { createSupabaseBackend } from './remote.js';
import { createStore } from './store.js';
import { mount } from './ui.js';

const bootErrors = [];

// Server mode is opt-in: without a configured project the app stays a local shell,
// and nothing silently pretends to be synced.
let remote = null;
if (APP.backend.mode === 'supabase' && APP.backend.supabaseUrl && APP.backend.publishableKey) {
  try {
    remote = createSupabaseBackend({
      url: APP.backend.supabaseUrl,
      publishableKey: APP.backend.publishableKey
    });
  } catch (error) {
    bootErrors.push({ message: 'تعذر تهيئة المدينة المشتركة — نعمل محلياً.', error });
  }
}

const store = createStore({
  remote,
  onError: (message, error) => {
    bootErrors.push({ message, error });
    console.warn('[ofuq]', message, error);
  }
});

const ui = mount(store);
document.documentElement.dataset.app = `${APP.id}@${APP.version}`;

// A returning player should not have to sign in again; a stale token fails quietly and
// the shell keeps working in «بحاجة لتسجيل الدخول» rather than pretending to be synced.
if (remote) {
  store.auth.restore().then((result) => {
    if (result.ok) ui.toast(result.message, 'ok');
  });
}

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
    navigator.serviceWorker
      .register('./sw.js')
      .then((registration) => {
        registration.addEventListener('updatefound', () => registration.update().catch(() => {}));
        // Check for a newer build on every visit; a stale cache must never look like
        // "nothing has been developed".
        registration.update().catch(() => {});
      })
      .catch((error) => console.warn('[ofuq] service worker', error));

    // A new worker taking control means the files on disk changed. Say it out loud
    // instead of reloading under the player's finger.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      ui.toast(`تم تحديث المدينة إلى نسخة ${APP.version} — أعد التحميل لرؤية الجديد.`, 'ok');
    });
  });
}
