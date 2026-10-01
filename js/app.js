import { renderShell, initShellBehavior } from './components/navigation.js';
import { startRouter } from './core/router.js';
import { onAuthChange } from './core/auth.js';
import { onAccessChange } from './core/access.js';
import { registerServiceWorker } from './core/pwa.js';
import { APP_TITLE } from '../config/app.config.js';
import {
  startTrainingGeneration, verifyTrainingGeneration, onTrainingGenerationStale,
} from './services/trainingGenerationService.js';
import { getUserProfile } from './services/userService.js';
import { clearLocalActiveWorkoutMarker } from './services/workoutService.js';
import { onTrainingResetApplied } from './services/trainingResetService.js';

// v1.1: tab title from APP_META (index.html carries the same static text
// for the moment before this module runs).
document.title = APP_TITLE;

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
onAuthChange((user) => { latestUser = user; maybeRenderShell(); maybeStartTrainingGeneration(); });
onAccessChange((access) => { latestAccess = access; maybeRenderShell(); maybeStartTrainingGeneration(); });

// v22 — stale-device protection after an admin "Reset training data"
// (services/trainingGenerationService.js). Started once per approved
// session from the profile this device booted with; the server check runs
// in the background and never blocks the UI.
let generationUid = null;
async function maybeStartTrainingGeneration() {
  const uid = latestUser?.uid;
  if (!uid || latestAccess.phase !== 'approved' || generationUid === uid) return;
  generationUid = uid;
  try {
    await startTrainingGeneration(uid, await getUserProfile(uid));
    verifyTrainingGeneration('boot', { force: true });
  } catch (err) {
    generationUid = null;
    console.warn('Training-generation start failed (retried on next state change):', err);
  }
}

// This device holds pre-reset state: training writes are already refused
// (and the server rejects any that were queued). Drop the local workout
// marker and reload from the server into the clean, reset state.
function showResetNotice(text) {
  document.getElementById('stale-reset-notice')?.remove();
  const notice = document.createElement('div');
  notice.className = 'update-banner';
  notice.id = 'stale-reset-notice';
  notice.setAttribute('role', 'status');
  notice.textContent = text;
  document.body.appendChild(notice);
  return notice;
}
let reloading = false;
function reloadIntoResetState(uid) {
  if (reloading) return;
  reloading = true;
  clearLocalActiveWorkoutMarker(uid);
  showResetNotice('Your training data was reset by an admin. Loading your fresh start…');
  setTimeout(() => {
    history.replaceState(null, '', '#/home');
    location.reload();
  }, 1500);
}
onTrainingGenerationStale(({ uid }) => reloadIntoResetState(uid));

// A reset applied by THIS app (Spark admin reset, services/trainingResetService.js):
// at sign-in it runs before the app is shown → just say so; while the app is
// already running (e.g. an admin resetting their own account) → reload.
onTrainingResetApplied(() => {
  const uid = latestUser?.uid;
  clearLocalActiveWorkoutMarker(uid);
  if (generationUid) {
    reloadIntoResetState(uid);
  } else {
    const notice = showResetNotice('Your training data was reset by an admin. Enter your current 1RMs to start fresh.');
    setTimeout(() => notice.remove(), 8000);
  }
});

startRouter();

// Phase 5A: registers the offline app-shell service worker + its
// "Update available" banner. Independent of auth/access/routing above —
// it must run (and the banner must be able to appear) even for a
// signed-out or not-yet-approved user.
registerServiceWorker();
