// Phase 5A — service worker registration + "Update available" UX.
//
// Deliberately decoupled from the app shell / router: this banner has to be
// able to appear no matter which view or auth/access state is currently
// rendered (including signed-out/login, where the shell in navigation.js
// isn't even mounted), so it manages its own tiny DOM node appended
// directly to <body> rather than going through the router's view outlet or
// the header shell.
//
// Update strategy ("Keep this simple" — Phase 5A spec): the browser's
// normal SW lifecycle already does the hard part (installs a new worker in
// the background, keeps it "waiting" while an old one still controls the
// page). All this module adds is: (1) notice a waiting worker, (2) show a
// small, dismissable-by-action banner, (3) on explicit user click, tell the
// waiting worker to skipWaiting, (4) reload exactly once, only after that
// worker actually takes control (`controllerchange`). Nothing here ever
// reloads on its own initiative or interrupts an active workout screen —
// the reload only happens after the person themselves taps "Reload".
const SW_URL = 'sw.js'; // relative — resolves under whatever path this app
                          // is served from (localhost root or a GitHub
                          // Pages repo subpath alike), matching every other
                          // relative asset reference already in index.html.

let waitingWorker = null;

function ensureBannerEl() {
  let el = document.getElementById('update-banner');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'update-banner';
  el.className = 'update-banner';
  el.hidden = true;
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <span>Update available.</span>
    <button type="button" id="update-banner-btn">Reload</button>
  `;
  document.body.appendChild(el);
  el.querySelector('#update-banner-btn').addEventListener('click', () => {
    if (!waitingWorker) return;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  });
  return el;
}

function showUpdateBanner(worker) {
  waitingWorker = worker;
  ensureBannerEl().hidden = false;
}

/**
 * Registers sw.js and wires the update-available flow. Safe to call
 * unconditionally — browsers without service worker support (or the
 * offline-friendly file:// / plain `npx serve .` case, which does support
 * it) simply skip registration and the app continues to work online
 * exactly as before; it just won't be installable or offline-capable.
 */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(SW_URL);

      // A worker may already be sitting in "waiting" from a previous visit
      // (e.g. this tab loaded after an earlier tab's update already
      // finished installing) — offer it right away rather than waiting for
      // a fresh `updatefound` that will never fire again this session.
      if (reg.waiting && reg.active) showUpdateBanner(reg.waiting);

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // `reg.active` already being set is what distinguishes "a new
          // version is available to replace the one already running" from
          // a brand-new first install (no previous worker was controlling
          // anything yet, so there is nothing to prompt an "update" for).
          if (installing.state === 'installed' && reg.active) {
            showUpdateBanner(installing);
          }
        });
      });
    } catch (err) {
      console.error('Service worker registration failed:', err);
    }
  });

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}
