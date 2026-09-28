// Status: 'offline' | 'syncing' | 'online'
//
// Deliberately does NOT use onSnapshotsInSync() as proof that pending writes
// have reached the backend — that API only reflects the local client's view
// and does not guarantee server acknowledgement. Instead:
//   - 'offline' / the base 'online' come from navigator.onLine (honest: this
//     is connectivity, not a sync guarantee)
//   - 'syncing' is shown while the app has explicitly told us a write is in
//     flight, via beginWrite()/endWrite() (`pendingWrites`, below) — AND/OR
//     while a write has settled locally but has not yet been confirmed
//     reaching the backend (`unconfirmedWrites`, Phase 5A, below).
//
// Phase 5A — the honesty gap this file used to have: a Firestore write's
// promise (what beginWrite/endWrite/trackWrite track) resolves as soon as
// the write is applied to the LOCAL cache — including while fully offline.
// So `pendingWrites` alone returns to 0 almost immediately regardless of
// whether the write has actually reached the server yet. On reconnect, that
// meant this module could report 'online' immediately even while several
// offline-queued writes were still silently flushing to the backend in the
// background — an inaccurate status.
//
// Fix: `waitForPendingWrites(db)` is Firestore's own primitive for "have ALL
// currently-queued writes been acknowledged by the backend yet" — unlike
// onSnapshotsInSync() (rejected above), it specifically tracks server
// acknowledgement, not just the local client's own view. `trackWrite` now
// also increments a SEPARATE `unconfirmedWrites` counter for every write
// that settles locally, and decrements it only once a `waitForPendingWrites`
// call resolves — which correctly stays pending across a reconnect boundary
// (offline → `unconfirmedWrites` keeps accumulating silently, since
// `computeStatus()` reports 'offline' unconditionally while
// `navigator.onLine` is false anyway; the moment connectivity returns, the
// 'online' event recomputes status and correctly shows 'syncing' until the
// real backlog actually clears and each pending `waitForPendingWrites` call
// resolves). This is an accuracy fix only — the public API
// (beginWrite/endWrite/trackWrite/getSyncStatus/onSyncStatusChange) and
// every existing caller are unchanged.
import { waitForPendingWrites } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from './firebase.js';

let pendingWrites = 0;
let unconfirmedWrites = 0;
let status = navigator.onLine ? 'online' : 'offline';
const listeners = new Set();

function computeStatus() {
  if (!navigator.onLine) return 'offline';
  return (pendingWrites > 0 || unconfirmedWrites > 0) ? 'syncing' : 'online';
}

function setStatus(next) {
  if (next === status) return;
  status = next;
  listeners.forEach((cb) => cb(status));
}

function recompute() {
  setStatus(computeStatus());
}

window.addEventListener('online', recompute);
window.addEventListener('offline', recompute);

/** Call immediately before starting a Firestore write. */
export function beginWrite() {
  pendingWrites += 1;
  recompute();
}

/** Call in a `finally` block after the write settles (success or error). */
export function endWrite() {
  pendingWrites = Math.max(0, pendingWrites - 1);
  recompute();
}

/**
 * Tracks a write that settled locally (the promise resolved — even if that
 * happened while offline, which is expected and fine) toward genuine
 * backend-confirmed sync, using `waitForPendingWrites(db)`. Never rejects
 * this module's own state on its account: if `waitForPendingWrites` itself
 * throws (unexpected — it normally just waits, including indefinitely while
 * offline, until the backlog clears), this still decrements the counter
 * rather than leaving the indicator stuck on "Syncing…" forever over an
 * unrelated error.
 */
function trackUntilServerConfirmed() {
  unconfirmedWrites += 1;
  recompute();
  const decrement = () => {
    unconfirmedWrites = Math.max(0, unconfirmedWrites - 1);
    recompute();
  };
  waitForPendingWrites(db).then(decrement, decrement);
}

/** Wraps an async Firestore operation, tracking it as a pending write. */
export async function trackWrite(promiseFactory) {
  beginWrite();
  let settledLocally = false;
  try {
    const result = await promiseFactory();
    settledLocally = true;
    return result;
  } finally {
    endWrite();
    if (settledLocally) trackUntilServerConfirmed();
  }
}

export function getSyncStatus() {
  return status;
}

export function onSyncStatusChange(callback) {
  listeners.add(callback);
  callback(status);
  return () => listeners.delete(callback);
}
