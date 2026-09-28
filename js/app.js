import { renderShell, initShellBehavior } from './components/navigation.js';
import { startRouter } from './core/router.js';
import { onAuthChange } from './core/auth.js';
import { onAccessChange } from './core/access.js';
import { registerServiceWorker } from './core/pwa.js';

const appRoot = document.getElementById('app');

// The full shell (header + nav) only ever renders once access is confirmed
// 'approved' (Phase 3C) AND new-user onboarding (Phase 3E) is not pending —
// for signed-out, loading/checking, pending, error, disabled, and
// approved-but-onboarding states, it's a bare outlet, same as login's
// existing full-bleed treatment. This is what keeps the nav (including the
// admin-only tab) from ever being shown to a user who isn't actually
// allowed into the app yet, or who hasn't finished the one-time onboarding
// step; router.js is what stops the ROUTES themselves from rendering
// protected content, independently of this.
function renderForState(user, access) {
  if (user && access.phase === 'approved' && !access.onboarding?.needed) {
    appRoot.innerHTML = renderShell(access.record);
    initShellBehavior();
  } else {
    appRoot.innerHTML = '<main id="view-outlet" class="view-outlet"></main>';
  }
}

let latestUser = null;
let latestAccess = { phase: 'loading', record: null, onboarding: { needed: false, missingLiftIds: [] } };
let shellKey = null;

function maybeRenderShell() {
  const key = `${!!latestUser}:${latestAccess.phase}:${latestAccess.record?.role ?? ''}:${!!latestAccess.onboarding?.needed}`;
  if (key === shellKey) return;
  shellKey = key;
  renderForState(latestUser, latestAccess);
}

// Registered before startRouter() below, so the shell/outlet for a given
// auth+access state always exists by the time router.js's OWN listeners
// (registered inside startRouter) react to that same state change.
onAuthChange((user) => { latestUser = user; maybeRenderShell(); });
onAccessChange((access) => { latestAccess = access; maybeRenderShell(); });

startRouter();

// Phase 5A: registers the offline app-shell service worker + its
// "Update available" banner. Independent of auth/access/routing above —
// it must run (and the banner must be able to appear) even for a
// signed-out or not-yet-approved user.
registerServiceWorker();
