// Correction pass 6 — shared online/offline read strategy.
//
// This is the same pattern correction pass 3 already established privately
// inside js/services/workoutService.js (its own `getDocSafe`, plus the
// inline `navigator.onLine ? getDocs(q) : getDocsFromCache(q)` in
// getInProgressWorkout): a plain, online-preferring getDoc()/getDocs() can
// hang indefinitely once the client is offline, instead of promptly
// falling back to Firestore's own local persistent cache (same root cause
// already fixed once for access.js's "Checking access…" hang in pass 2,
// and again for workoutService.js's offline Start/autosave reads in pass
// 3). Correction pass 6 found the SAME unfixed pattern in userService.js
// and programService.js — both read directly by js/views/home.js and (for
// programService.js) also by js/views/workout.js's own mount() — which is
// the exact cause of "Workout -> Home navigation hangs on 'Loading
// dashboard…' while offline" (see this pass's report). Consolidated here
// once multiple services needed it, rather than re-pasting the ternary a
// third and fourth time.
//
// getDocSafe(ref): online -> plain getDoc(); offline -> getDocFromCache(),
// which REJECTS (code: 'unavailable') on a genuine "never cached on this
// device" miss — distinguishable from "cached, confirmed absent"
// (snap.exists() === false). Callers for which the document is REQUIRED to
// render should let that rejection propagate rather than swallow it: it is
// exactly what utils/offlineError.js's isOfflineUnavailableError is built
// to recognize, and core/router.js already turns it into a clear, terminal
// "not available offline yet" message instead of an infinite loading
// state (see router.js's render(), unchanged by this pass). A caller for
// which the document is optional (e.g. a user profile that every existing
// call site already treats as nullable) may instead catch it locally and
// substitute null — see userService.js's getUserProfile for that case.
//
// getDocsSafe(q): online -> plain getDocs(); offline -> getDocsFromCache(),
// which — verified, real SDK quirk (firebase-js-sdk#6851, already cited in
// workoutService.js's getInProgressWorkout) — resolves EMPTY for a query
// that was never itself cached, rather than rejecting. That ambiguity
// (genuinely-zero-matches vs. never-cached-so-unknown) is real and is
// deliberately left unresolved here, exactly as getInProgressWorkout
// already tolerated it for its own self-healing fallback layer: an empty
// offline result is a SAFE default for every current caller of this
// function (a dashboard stat reading "None yet"/0, a self-heal layer
// finding nothing more to do) — it never fabricates data and never
// overwrites or advances anything, it just under-reports in a rare,
// already-accepted edge case rather than hanging or crashing.
import {
  getDoc, getDocFromCache, getDocs, getDocsFromCache,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

export async function getDocSafe(ref) {
  return navigator.onLine ? getDoc(ref) : getDocFromCache(ref);
}

export async function getDocsSafe(q) {
  return navigator.onLine ? getDocs(q) : getDocsFromCache(q);
}
