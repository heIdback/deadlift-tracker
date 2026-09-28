import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  collection, addDoc, query, orderBy, limit, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';
import { getDocSafe } from '../utils/firestoreRead.js';
import { isOfflineUnavailableError } from '../utils/offlineError.js';
import { DEFAULTS, APP_META } from '../../config/app.config.js';
import { REQUIRED_STARTER_LIFTS } from '../utils/requiredLifts.js';

const userDocRef = (uid) => doc(db, 'users', uid);
const maxesColRef = (uid) => collection(db, 'users', uid, 'maxes');

/** Called on every sign-in. Creates the profile once; otherwise just bumps lastLoginAt. */
export async function ensureUserProfile(firebaseUser) {
  await trackWrite(async () => {
    const ref = userDocRef(firebaseUser.uid);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      await setDoc(ref, {
        uid: firebaseUser.uid,
        displayName: firebaseUser.displayName ?? '',
        email: firebaseUser.email ?? '',
        photoURL: firebaseUser.photoURL ?? '',
        createdAt: serverTimestamp(),
        lastLoginAt: serverTimestamp(),
        schemaVersion: APP_META.schemaVersion,
        settings: {
          units: DEFAULTS.units,
          rounding: DEFAULTS.rounding,
        },
        trainingProfile: {
          bodyweight: null,
          height: null,
          trainingGoal: '',
        },
        // Denormalized cache of the latest value per lift, for fast dashboard
        // reads. The source of truth is the users/{uid}/maxes history below.
        currentMaxes: {},
      });
    } else {
      await updateDoc(ref, { lastLoginAt: serverTimestamp() });
    }
  });
}

/**
 * Correction pass 6: this was a plain, online-preferring getDoc() with no
 * offline handling at all — read directly by js/views/home.js's mount()
 * (and, via getMissingRequiredMaxes, by js/core/access.js's online-only
 * boot path), it was one of the exact reads that left Home stuck on
 * "Loading dashboard…" indefinitely when navigated to while offline (see
 * this pass's report). Routed through the shared getDocSafe
 * (../utils/firestoreRead.js) so it falls back to Firestore's local cache
 * offline instead of hanging.
 *
 * A genuine cache miss (this profile was never read on this device while
 * online) is treated as `null`, not propagated as a terminal error: unlike
 * a program/workout, the profile has ALREADY been read as optional
 * everywhere it's consumed (`profile?.currentMaxes`, `profile?.settings`,
 * etc., in workoutService.js and every view that calls this) — a doc for
 * the CURRENTLY signed-in user's own account is also the single least
 * likely thing to have never been cached in practice (it's read on every
 * approved boot via access.js's ensureUserProfile). Any OTHER failure
 * (a real error, a permissions issue) still propagates normally.
 */
export async function getUserProfile(uid) {
  let snap;
  try {
    snap = await getDocSafe(userDocRef(uid));
  } catch (err) {
    if (isOfflineUnavailableError(err)) return null;
    throw err;
  }
  return snap.exists() ? snap.data() : null;
}

export async function updateSettings(uid, settingsPatch) {
  await trackWrite(() => updateDoc(userDocRef(uid), { settings: settingsPatch }));
}

export async function updateTrainingProfile(uid, patch) {
  await trackWrite(() => updateDoc(userDocRef(uid), { trainingProfile: patch }));
}

/**
 * Record a new 1RM value for a lift. This NEVER overwrites history — it adds
 * a new maxes document and updates the cheap currentMaxes cache on the user
 * doc. Existing completed workouts already snapshot the basis they used, so
 * they are unaffected by this change.
 */
export async function recordOneRepMax(uid, { exerciseId, kg, kind = 'training', source = 'manual' }) {
  if (!exerciseId || typeof kg !== 'number' || kg <= 0) {
    throw new Error('recordOneRepMax requires a valid exerciseId and a positive kg value.');
  }
  await trackWrite(async () => {
    await addDoc(maxesColRef(uid), {
      exerciseId,
      kg,
      kind, // 'tested' | 'training'
      effectiveDate: serverTimestamp(),
      source, // 'manual' | 'workout:<workoutId>' | 'import' | 'tested_pr'
    });
    await updateDoc(userDocRef(uid), {
      [`currentMaxes.${exerciseId}`]: { kg, kind, updatedAt: serverTimestamp() },
    });
  });
}

/**
 * New-user onboarding check (Phase 3E): which of the starter program's
 * required lifts (see utils/requiredLifts.js) the user does NOT yet have a
 * currentMaxes entry for. Returns an empty array for a user who already has
 * all four (the normal case for any existing user, and for a new user once
 * they finish onboarding) — never re-asks for a value that's already set,
 * whether it came from onboarding, a manual Profile edit, or (for an
 * existing pre-3E account) however it was originally set.
 */
export async function getMissingRequiredMaxes(uid) {
  const profile = await getUserProfile(uid);
  const have = profile?.currentMaxes || {};
  return REQUIRED_STARTER_LIFTS.filter((l) => !have[l.id]).map((l) => l.id);
}

export async function getMaxHistory(uid, exerciseId, max = 20) {
  const q = query(
    maxesColRef(uid),
    orderBy('effectiveDate', 'desc'),
    limit(max),
  );
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => d.exerciseId === exerciseId);
}
