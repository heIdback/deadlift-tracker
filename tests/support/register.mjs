// Node: serve the Firebase CDN imports (https://www.gstatic.com/firebasejs/…/firebase-X.js)
// from tests/fakes/, and provide the few browser globals the services touch.
// Use:  node --import ./tests/support/register.mjs --test tests/service/*.test.mjs
import { register } from 'node:module';

register(new URL('./loader.mjs', import.meta.url));

const store = new Map();
globalThis.localStorage ??= {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
let online = true;
try {
  Object.defineProperty(globalThis.navigator ?? (globalThis.navigator = {}), 'onLine', { configurable: true, get: () => online });
} catch { /* ignore */ }
globalThis.__setOnline = (v) => { online = !!v; };

// Minimal window/document for modules that listen for online/visibility events.
if (typeof globalThis.window === 'undefined') {
  const target = new EventTarget();
  globalThis.window = globalThis;
  globalThis.addEventListener ??= target.addEventListener.bind(target);
  globalThis.removeEventListener ??= target.removeEventListener.bind(target);
  globalThis.dispatchEvent ??= target.dispatchEvent.bind(target);
}
if (typeof globalThis.document === 'undefined') {
  const t = new EventTarget();
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: t.addEventListener.bind(t),
    removeEventListener: t.removeEventListener.bind(t),
    dispatchEvent: t.dispatchEvent.bind(t),
    querySelector: () => null,
  };
}
