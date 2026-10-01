// Stale-device protection after an admin "Reset training data".
// Model and rationale: ../utils/trainingGeneration.js.
//
// Two layers:
//   1. SERVER-ENFORCED (the one that matters): every training-state write
//      goes through commitTrainingBatch(), which adds
//      `update(<this device's generation sentinel>)` to the batch. After a
//      reset that sentinel no longer exists → Firestore rejects the whole
//      batch → nothing from the old generation can land, whether the write
//      was made online, queued offline, or replayed after a refresh.
//   2. CLIENT UX: verifyTrainingGeneration() compares this device's
//      generation with the server's (boot, coming back online, returning to
//      the tab, navigation, any rejected guarded write). On a mismatch the
//      device is marked stale: further training writes are refused locally
//      and the app (js/app.js) discards local workout state and reloads
//      from the server.
//
// The guard is active once this device has confirmed its generation's
// sentinel exists (read from the persistent Firestore cache at boot, or from
// the server by verify). A never-reset account gets its 'initial' sentinel
// created on its first online verify, inside a transaction that re-reads the
// profile — so it can never be created for a generation a reset has already
// replaced. Until then (a device whose first-ever session on this version is
// entirely offline) writes go unguarded, as before this version.
import {
  doc, getDocFromCache, getDocFromServer, runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import {
  GENERATION_SENTINEL_COLLECTION, generationSentinelId, generationOf,
} from '../utils/trainingGeneration.js';

const VERIFY_THROTTLE_MS = 60 * 1000;

const profileRef = (uid) => doc(db, 'users', uid);
const sentinelRef = (uid, generation) => doc(db, 'users', uid, GENERATION_SENTINEL_COLLECTION, generationSentinelId(generation));

const state = { uid: null, generation: null, guarded: false, stale: false, lastVerifyAt: 0, verifying: null };
const staleListeners = new Set();
let listenersInstalled = false;

export class StaleTrainingStateError extends Error {
  constructor() {
    super('Your training data was reset on another device. Loading your fresh start…');
    this.name = 'StaleTrainingStateError';
    this.code = 'stale-training-generation';
  }
}

export function getTrainingGenerationState() {
  const { uid, generation, guarded, stale } = state;
  return { uid, generation, guarded, stale };
}

/** Called once per signed-in session with the profile the app booted from (server online, cache offline). */
export async function startTrainingGeneration(uid, profile) {
  Object.assign(state, { uid, generation: generationOf(profile), guarded: false, stale: false, lastVerifyAt: 0, verifying: null });
  try {
    state.guarded = (await getDocFromCache(sentinelRef(uid, state.generation))).exists();
  } catch {
    state.guarded = false; // not cached on this device yet — verify() confirms it online
  }
  installListeners();
  return getTrainingGenerationState();
}

export function onTrainingGenerationStale(callback) {
  staleListeners.add(callback);
  return () => staleListeners.delete(callback);
}

function markStale(reason) {
  if (state.stale) return;
  state.stale = true;
  state.guarded = false;
  const info = { uid: state.uid, reason };
  staleListeners.forEach((cb) => { try { cb(info); } catch (err) { console.error('stale-generation listener failed', err); } });
}

/**
 * Server check (online only; never blocks the UI). Resolves to one of
 * 'ok' | 'created' | 'stale' | 'offline' | 'throttled' | 'skipped' | 'error'.
 */
export function verifyTrainingGeneration(reason = 'manual', { force = false } = {}) {
  if (!state.uid || state.stale) return Promise.resolve(state.stale ? 'stale' : 'skipped');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve('offline');
  if (state.verifying) return state.verifying;
  if (!force && Date.now() - state.lastVerifyAt < VERIFY_THROTTLE_MS) return Promise.resolve('throttled');
  state.verifying = runVerify(reason).finally(() => {
    state.verifying = null;
    state.lastVerifyAt = Date.now();
  });
  return state.verifying;
}

async function runVerify(reason) {
  const { uid, generation } = state;
  let outcome;
  try {
    outcome = await runTransaction(db, async (tx) => {
      const profile = await tx.get(profileRef(uid));
      if (!profile.exists()) return 'skipped';
      if (generationOf(profile.data()) !== generation) return 'stale';
      const sentinel = await tx.get(sentinelRef(uid, generation));
      if (sentinel.exists()) return 'ok';
      // Missing for the CURRENT server generation: a never-reset account
      // (first run of this version) or a reset still in progress. Re-created
      // only because the transaction proves the profile still names this
      // generation; a reset that commits meanwhile makes it retry → 'stale'.
      tx.set(sentinelRef(uid, generation), { kind: 'trainingGeneration', generation, createdAt: serverTimestamp() });
      return 'created';
    });
  } catch (err) {
    console.warn('Training-generation check failed (will retry later):', err?.code ?? err);
    return 'error';
  }
  if (state.uid !== uid || state.generation !== generation) return 'skipped';
  if (outcome === 'stale') {
    // Pull the new profile/sentinel into the persistent cache so even an
    // offline reload after this boots in the new generation.
    await Promise.allSettled([getDocFromServer(profileRef(uid))]);
    markStale(reason);
    return 'stale';
  }
  if (outcome === 'ok' || outcome === 'created') {
    state.guarded = true;
    getDocFromServer(sentinelRef(uid, generation)).catch(() => {}); // cache it: the guard must survive an offline refresh
  }
  return outcome;
}

/** Throws if this device is known to hold pre-reset state. */
export function assertTrainingStateWritable(uid) {
  if (state.stale && uid === state.uid) throw new StaleTrainingStateError();
}

const isPreconditionRejection = (err) => ['not-found', 'failed-precondition']
  .includes(String(err?.code ?? '').replace(/^firestore\//, ''));

/**
 * Commits a training-state batch with this device's generation guard.
 * Same promise contract as batch.commit() (backend-ack gated; callers that
 * fire-and-forget keep doing so). Throws StaleTrainingStateError
 * synchronously-before-commit if the device is already known to be stale.
 */
export function commitTrainingBatch(uid, batch) {
  assertTrainingStateWritable(uid);
  if (state.guarded && uid === state.uid) {
    batch.update(sentinelRef(uid, state.generation), { generation: state.generation });
  }
  const committed = batch.commit();
  committed.catch((err) => {
    if (isPreconditionRejection(err)) verifyTrainingGeneration('write-rejected', { force: true });
  });
  return committed;
}

function installListeners() {
  if (listenersInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listenersInstalled = true;
  window.addEventListener('online', () => verifyTrainingGeneration('online', { force: true }));
  window.addEventListener('hashchange', () => verifyTrainingGeneration('navigation'));
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') verifyTrainingGeneration('visible');
    });
  }
}

/** TEST ONLY — forget the current session. */
export function __resetTrainingGenerationForTests() {
  Object.assign(state, { uid: null, generation: null, guarded: false, stale: false, lastVerifyAt: 0, verifying: null });
  staleListeners.clear();
}
