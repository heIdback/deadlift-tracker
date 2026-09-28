import { ROUTES } from '../../config/app.config.js';
import { onAuthChange } from './auth.js';
import { onAccessChange } from './access.js';
import { mount as mountPendingScreen } from '../views/pending.js';
import { mount as mountDisabledScreen } from '../views/disabled.js';
import { mount as mountOnboardingScreen } from '../views/onboarding.js';
import { isOfflineUnavailableError, OFFLINE_UNAVAILABLE_MESSAGE } from '../utils/offlineError.js';

const outlet = () => document.getElementById('view-outlet');

let currentUnmount = null;
let authKnown = false;
let latestUser = null;
let latestAccess = { phase: 'loading', record: null, onboarding: { needed: false, missingLiftIds: [] } };

/**
 * Root cause of the Admin-route 404: `matchRoute` did an exact-string
 * lookup into ROUTES, so anything other than the literal bytes a config
 * entry uses (a trailing slash from `#/admin/`, a different case from
 * `#/Admin`, etc.) silently fell through to the 404 route — this was
 * already true for every existing route (`#/workout/` 404s the exact same
 * way), it just hadn't been noticed before because the nav links always
 * emit the exact stored string. Normalizing here (case-insensitive, no
 * trailing slash) is what "direct navigation to the admin hash/path"
 * actually needs, and fixes the same class of issue for every other route
 * too — not a rules or access-phase change.
 */
function normalizeRoutePath(rawPath) {
  const lower = rawPath.toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
}

function matchRoute(hash) {
  const path = (hash || '#/').replace(/^#/, '') || '/';
  const [base] = path.split('?');
  const normalized = normalizeRoutePath(base);
  return ROUTES[normalized] ? { name: ROUTES[normalized], path: normalized } : { name: '404', path: normalized };
}

function teardownCurrentView() {
  if (typeof currentUnmount === 'function') {
    try { currentUnmount(); } catch (err) { console.error('View unmount error:', err); }
    currentUnmount = null;
  }
}

async function render() {
  if (!authKnown) return; // wait for the first auth resolution before routing

  const { name, path } = matchRoute(location.hash);

  if (name !== 'login' && !latestUser) {
    location.hash = '#/login';
    return;
  }
  if (name === 'login' && latestUser) {
    location.hash = '#/home';
    return;
  }

  const root = outlet();
  if (!root) return; // app.js hasn't mounted the shell/outlet for this state yet; its own state change re-renders it, which re-triggers this

  if (latestUser) {
    // Every protected route — including whatever `name` a pending/disabled
    // user manually types into the hash — is gated here, BEFORE the normal
    // view-module dispatch below, so no fitness route/data can render
    // without a confirmed 'approved' access status. This also covers the
    // brief window while access is still resolving, so there's no flash of
    // protected content before that resolution completes.
    if (latestAccess.phase === 'loading' || latestAccess.phase === 'checking') {
      teardownCurrentView();
      root.innerHTML = '<div class="loading-state" role="status">Checking access…</div>';
      return;
    }
    if (
      latestAccess.phase === 'pending'
      || latestAccess.phase === 'error'
      || latestAccess.phase === 'offline-unavailable'
    ) {
      // 'offline-unavailable' (Phase 5A correction pass 2): offline, and
      // this UID's access record was never cached on this device — reuses
      // the exact same pending-screen shell/recheck/sign-out affordances,
      // just with its own distinct message (see pending.js).
      teardownCurrentView();
      await mountPendingScreen(root, { variant: latestAccess.phase });
      document.dispatchEvent(new CustomEvent('route:changed', { detail: { name: 'pending', path } }));
      return;
    }
    if (latestAccess.phase === 'disabled') {
      teardownCurrentView();
      await mountDisabledScreen(root);
      document.dispatchEvent(new CustomEvent('route:changed', { detail: { name: 'disabled', path } }));
      return;
    }
    // latestAccess.phase === 'approved' from here on.
    if (latestAccess.onboarding?.needed) {
      // New-user 1RM onboarding (Phase 3E) — gated exactly like
      // pending/disabled above: whatever route was requested, this is
      // what renders until the required maxes are saved. Saving triggers
      // recheckAccess() (see onboarding.js), which recomputes this flag
      // and re-fires this same render() via onAccessChange.
      teardownCurrentView();
      await mountOnboardingScreen(root, { missingLiftIds: latestAccess.onboarding.missingLiftIds });
      document.dispatchEvent(new CustomEvent('route:changed', { detail: { name: 'onboarding', path } }));
      return;
    }
    if (name === 'admin' && latestAccess.record?.role !== 'admin') {
      // Frontend gate for UX only — hiding/redirecting the Admin route does
      // not itself grant or deny data access. The real enforcement is
      // firestore.rules (`/access/{uid}`'s `list`/`update` rules require an
      // approved admin), so a non-admin who edits the hash by hand lands
      // safely back on Home with no data ever exposed either way.
      location.hash = '#/home';
      return;
    }
  }

  teardownCurrentView();
  root.innerHTML = '<div class="loading-state" role="status">Loading…</div>';

  try {
    const mod = await import(`../views/${name === '404' ? 'notFound' : name}.js`);
    const result = await mod.mount(root, { path });
    currentUnmount = typeof result === 'function' ? result : null;
  } catch (err) {
    console.error(`Failed to load view "${name}":`, err);
    // Phase 5A: a view that failed to load because its data was never
    // cached and the device is currently offline is an expected, everyday
    // condition — not "something went wrong" — so it gets its own plain
    // message instead of a raw Firebase error string. Any other failure
    // (a real bug, a permissions error, an online failure) is completely
    // unaffected and still shows exactly the same generic message as before.
    root.innerHTML = isOfflineUnavailableError(err)
      ? `
      <div class="empty-state">
        <p>${OFFLINE_UNAVAILABLE_MESSAGE}</p>
      </div>`
      : `
      <div class="empty-state">
        <p>Something went wrong loading this screen.</p>
        <p class="text-muted">${err.message ?? ''}</p>
      </div>`;
  }

  document.dispatchEvent(new CustomEvent('route:changed', { detail: { name, path } }));
}

export function startRouter() {
  window.addEventListener('hashchange', render);
  onAuthChange((user) => {
    latestUser = user;
    authKnown = true;
    render();
  });
  onAccessChange((access) => {
    latestAccess = access;
    render();
  });
  if (!location.hash) location.hash = '#/home';
}

export function navigate(path) {
  location.hash = `#${path}`;
}
