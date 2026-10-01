// ─────────────────────────────────────────────────────────────────────────
// Access-control resolution (Phase 3C). Sits between raw Firebase Auth
// (auth.js) and the rest of the app: being signed in is no longer enough to
// use the app — a signed-in user must also have an APPROVED record in the
// top-level `/access/{uid}` collection (kept separate from fitness data in
// `/users/{uid}/...`, per the access-control data model).
//
// This module owns the client-side half of that lifecycle:
//   Google Sign-In -> access record lookup -> pending/approved/disabled ->
//   only approved users proceed.
// The REAL enforcement is firestore.rules (a client can be tricked or buggy;
// the rules cannot). Everything here is UX/state-machine, not security.
//
// Fitness-data initialization (`ensureUserProfile`) is deliberately called
// from HERE, and ONLY once status is confirmed 'approved' — never for a
// pending/disabled user, and never unconditionally on every sign-in the way
// it used to be (see auth.js, which no longer calls it at all).
// ─────────────────────────────────────────────────────────────────────────
import {
  doc, getDoc, getDocFromCache, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from './firebase.js';
import { onAuthChange } from './auth.js';
import { ensureUserProfile, getMissingRequiredMaxes } from '../services/userService.js';
import { applyPendingTrainingReset } from '../services/trainingResetService.js';
import { ensureStarterProgramForUser } from '../services/programService.js';

const accessDocRef = (uid) => doc(db, 'access', uid);

// phase: 'loading' | 'signed-out' | 'checking' | 'pending' | 'disabled' | 'error'
//      | 'approved' | 'offline-unavailable'
// ('offline-unavailable' — Phase 5A correction pass 2 — is a distinct
// terminal state from 'error': it means we are offline and this UID's
// access record was never cached on this device, so there is nothing safe
// to show but "reconnect to verify" — never a generic "something's wrong".)
let phase = 'loading';
let record = null;
// onboarding is only ever meaningful while phase === 'approved' — a fresh,
// still-empty shape otherwise (see resolveForUser's non-approved branches,
// which always pass this same reset shape rather than leaving a stale
// value from a previous user/session behind).
let onboarding = { needed: false, missingLiftIds: [] };
const listeners = new Set();

function setState(nextPhase, nextRecord, nextOnboarding = { needed: false, missingLiftIds: [] }) {
  phase = nextPhase;
  record = nextRecord;
  onboarding = nextOnboarding;
  listeners.forEach((cb) => cb({ phase, record, onboarding }));
}

/**
 * Correction pass 2 root cause: a plain `getDoc()` is server-preferring —
 * while genuinely offline it can wait far longer than acceptable (an
 * indefinite "Checking access…" hang, confirmed via real Chrome testing)
 * instead of promptly falling back to Firestore's own local IndexedDB
 * cache (js/core/firebase.js's persistentLocalCache, already populated for
 * this exact `/access/{uid}` doc the last time it was read while online).
 * Thrown ONLY when we are offline AND this UID's access record was never
 * cached on this device/browser at all, so resolveForUser can route it to
 * its own clear terminal phase ('offline-unavailable') instead of hanging
 * or falling through to the online create-request path below.
 */
class OfflineAccessUnavailable extends Error {
  constructor() { super('Access status is not available offline for this account yet.'); }
}

/**
 * Reads `/access/{uid}`; if it doesn't exist yet, creates the MINIMUM safe
 * pending request — never anything approved/admin, and no extra fields.
 * The exact shape here matches what firestore.rules requires for a
 * self-created access doc, so a user can never smuggle a privileged field
 * or value into their own first request.
 *
 * Idempotent: if the doc already exists (the common case for every login
 * after the first), this never writes — an existing approved/disabled
 * record is read as-is and never reset back to pending.
 *
 * Offline (Phase 5A correction pass 2): never reaches the network, never
 * creates anything, and never invents an outcome. Reads ONLY Firestore's
 * own local cache for this exact UID via `getDocFromCache` — a cache hit
 * returns the real last-known record (approved/pending/disabled, exactly
 * as it would online); a cache miss (nothing was ever cached for this UID
 * on this device) throws OfflineAccessUnavailable rather than treating
 * "no cached doc" as "create a new pending request" or "approved".
 */
async function ensureAccessRequest(user) {
  const ref = accessDocRef(user.uid);

  if (!navigator.onLine) {
    try {
      const snap = await getDocFromCache(ref);
      if (snap.exists()) return { id: snap.id, ...snap.data() };
    } catch {
      // getDocFromCache rejects when nothing has ever been cached for this
      // ref on this device — expected and everyday while offline, not a
      // bug. Falls through to the explicit "offline, unavailable" outcome.
    }
    throw new OfflineAccessUnavailable();
  }

  // Online: authoritative behavior, completely unchanged by this correction.
  const snap = await getDoc(ref);
  if (snap.exists()) return { id: snap.id, ...snap.data() };

  const request = {
    uid: user.uid,
    email: user.email ?? '',
    displayName: user.displayName ?? '',
    photoURL: user.photoURL ?? '',
    status: 'pending',
    role: 'user',
    requestedAt: serverTimestamp(),
  };
  await setDoc(ref, request);
  return { id: user.uid, ...request };
}

async function resolveForUser(user) {
  setState('checking', null);
  try {
    const rec = await ensureAccessRequest(user);
    if (rec.status === 'approved') {
      if (navigator.onLine) {
        // Fitness-data init happens HERE, gated behind approval, and only
        // here. ensureUserProfile only ever creates a doc that doesn't yet
        // exist (see userService.js) — for an already-provisioned approved
        // user this is a safe, cheap no-op (just a lastLoginAt bump), never
        // a re-seed of existing program/workouts/maxes/bodyweight/settings.
        try {
          await ensureUserProfile(user);
        } catch (err) {
          console.error('ensureUserProfile failed:', err);
        }

        // v22: an admin may have requested a training reset for this account
        // (Spark design — the user's own app applies it; utils/trainingReset.js).
        // Applied BEFORE the onboarding check below, so a reset account lands
        // straight on "enter your current 1RMs". Never blocks sign-in.
        try {
          await applyPendingTrainingReset(user.uid);
        } catch (err) {
          console.error('Pending training reset could not be applied (retried next time):', err);
        }

        // New-user onboarding (Phase 3E), same gating principle: runs ONLY
        // once approved, never for pending/disabled. ensureStarterProgramForUser
        // is a safe no-op for any user who already has a program (every
        // existing account, including the very first admin), so this adds no
        // behavior change for them beyond these two extra reads. Both steps
        // are wrapped in their own try/catch, separate from the outer one
        // below: a failure here should never flip a genuinely approved user
        // into the fail-closed 'error' state — it should just skip straight
        // to "no onboarding required" and get logged, so a transient/loading
        // issue can't lock someone out of an app they're already approved for.
        let missingLiftIds = [];
        try {
          await ensureStarterProgramForUser(user.uid);
          missingLiftIds = await getMissingRequiredMaxes(user.uid);
        } catch (err) {
          console.error('Starter program install / onboarding check failed:', err);
        }

        setState('approved', rec, { needed: missingLiftIds.length > 0, missingLiftIds });
      } else {
        // Offline (Phase 5A correction pass 2): these three steps are all
        // best-effort, ONLINE-ONLY upkeep — installing a brand-new
        // profile/starter program is itself a write that inherently needs
        // a first online session, and a returning, already-set-up user
        // (the real acceptance scenario) has nothing new for any of them
        // to do. Skipping them offline is a deliberate no-op for that
        // user, and simply defers first-time setup for a brand-new user
        // until they're next online — it never blocks the bootstrap, and
        // never invents an "onboarding complete" state that wasn't already
        // true, since the last known onboarding flag is carried forward
        // unchanged rather than reset.
        setState('approved', rec, onboarding);
      }
    } else if (rec.status === 'disabled') {
      setState('disabled', rec);
    } else {
      setState('pending', rec);
    }
  } catch (err) {
    if (err instanceof OfflineAccessUnavailable) {
      // Distinct from 'error': we are offline and this UID's access record
      // was never cached on this device — a clear, expected, reconnect-
      // required outcome, never an invented approval and never a hang.
      setState('offline-unavailable', null);
      return;
    }
    console.error('Access resolution failed:', err);
    // Fail CLOSED: any error while resolving access must never grant entry.
    setState('error', null);
  }
}

onAuthChange((user) => {
  if (!user) {
    setState('signed-out', null);
    return;
  }
  resolveForUser(user);
});

/** Subscribe to access-state changes. Calls back immediately with the current state. */
export function onAccessChange(callback) {
  listeners.add(callback);
  callback({ phase, record, onboarding });
  return () => listeners.delete(callback);
}

export function getAccessState() {
  return { phase, record, onboarding };
}

/** Re-runs access resolution for the given (currently signed-in) user — the pending/error screen's "Recheck access" action. */
export async function recheckAccess(user) {
  if (!user) return;
  await resolveForUser(user);
}
