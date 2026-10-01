// Target side of the Spark-compatible admin reset — model and rationale:
// ../utils/trainingReset.js. Runs in the TARGET user's own app with the
// owner's normal permissions (firestore.rules unchanged; no Cloud Functions).
//
//   applyPendingTrainingReset(uid) — called on sign-in (core/access.js, before
//     the 1RM onboarding check) and by the periodic generation check. If an
//     admin left a valid, unapplied request on /access/{uid}, it applies it in
//     ONE transaction: delete runs, in-progress workouts, PR cache and
//     suggestions; start the active program again at Week 1 / first day; clear
//     current 1RMs; set trainingResetAt (the archive boundary); switch to a new
//     training generation. Idempotent: the applied request id is recorded on
//     the profile, and the transaction re-checks it.
//   getResetBoundaries(uid) — the archive boundaries every read path filters
//     with (memoized per page; cleared when a reset is applied here).
import {
  doc, collection, getDoc, getDocs, query, where, runTransaction, serverTimestamp,
  writeBatch, getCountFromServer, updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { getDocSafe } from '../utils/firestoreRead.js';
import {
  evaluateResetRequest, planTrainingReset, pickResetPosition, newResetId,
  trainingBoundaryOf, bodyweightBoundaryOf, isArchivedMeasurement, expectedResetConfirmation,
} from '../utils/trainingReset.js';

const boundaries = new Map();
const unappliable = new Set(); // request ids that can never fit one transaction — not retried every minute
const appliedListeners = new Set();
let inFlight = null;

/** {training, bodyweight}: Timestamps (or null = never reset). Never throws. */
export function getResetBoundaries(uid) {
  if (!boundaries.has(uid)) {
    boundaries.set(uid, getDocSafe(doc(db, 'users', uid))
      .then((snap) => {
        const p = snap.exists() ? snap.data() : null;
        return { training: trainingBoundaryOf(p), bodyweight: bodyweightBoundaryOf(p) };
      })
      .catch(() => {
        boundaries.delete(uid);
        return { training: null, bodyweight: null };
      }));
  }
  return boundaries.get(uid);
}
export function clearResetBoundaries(uid) {
  if (uid) boundaries.delete(uid); else boundaries.clear();
}

export function onTrainingResetApplied(callback) {
  appliedListeners.add(callback);
  return () => appliedListeners.delete(callback);
}

const col = (uid, name) => collection(db, 'users', uid, name);

/** Runs reset work strictly one at a time (a check already running is waited for, never reused for a different job). */
function serialize(job) {
  const prior = inFlight;
  const p = (async () => {
    if (prior) await prior.catch(() => {});
    return job();
  })();
  inFlight = p;
  p.finally(() => { if (inFlight === p) inFlight = null; }).catch(() => {});
  return p;
}
let pendingCheck = null;

/** Online only. Resolves {state: 'offline'|'none'|'cancelled'|'applied'|'invalid'|'already-applied'|'pending', ...}; never applies twice. */
export function applyPendingTrainingReset(uid) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve({ state: 'offline' });
  if (!pendingCheck) pendingCheck = serialize(() => run(uid)).finally(() => { pendingCheck = null; });
  return pendingCheck;
}

/**
 * A user (an admin on Admin → their own account) resetting THEIR OWN data:
 * the owner already has every permission the reset needs, so no request on
 * /access is involved — same checks (exact RESET text) and same transaction.
 */
export function applyOwnTrainingReset(uid, { confirmation, deleteBodyweight = false }) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve({ state: 'offline' });
  const own = { id: newResetId(), requestedBy: uid, requestedAt: null, confirmation, deleteBodyweight: deleteBodyweight === true, status: 'requested' };
  return serialize(() => run(uid, own));
}

function evaluateOwn(access, uid, own) {
  if (own.confirmation !== expectedResetConfirmation(access?.email, uid)) return { state: 'invalid', reason: 'Confirmation text does not match this account.' };
  return { state: 'pending', request: own };
}

async function run(uid, own = null) {
  const accessRef = doc(db, 'access', uid);
  const profileRef = doc(db, 'users', uid);
  const [accessSnap, profileSnap] = await Promise.all([getDoc(accessRef), getDoc(profileRef)]);
  if (!accessSnap.exists() || !profileSnap.exists()) return { state: 'none' };
  const profile = profileSnap.data();
  const ev = own ? evaluateOwn(accessSnap.data(), uid, own) : evaluateResetRequest({ access: accessSnap.data(), profile, uid });
  if (ev.state !== 'pending') {
    await finishBodyweightCleanup(uid, profile).catch(() => {}); // an earlier reset's cleanup, if unfinished
    if (ev.state === 'invalid') console.warn('Ignored an invalid training-reset request:', ev.reason);
    return { state: ev.state === 'applied' ? 'already-applied' : ev.state, reason: ev.reason };
  }
  if (unappliable.has(ev.request.id)) return { state: 'invalid', reason: 'This reset is too large to apply in one step.' };

  // Everything the transaction must delete (client transactions can't query).
  const oldBoundary = trainingBoundaryOf(profile);
  const oldBodyweightBoundary = bodyweightBoundaryOf(profile);
  const [runsSnap, inProgressSnap, recordsSnap, suggestionsSnap, programsSnap, workoutCount, maxCount, measurementsSnap] = await Promise.all([
    getDocs(col(uid, 'programRuns')),
    getDocs(query(col(uid, 'workouts'), where('status', '==', 'in_progress'))),
    getDocs(col(uid, 'records')),
    getDocs(col(uid, 'progressionSuggestions')),
    getDocs(col(uid, 'programs')),
    getCountFromServer(oldBoundary
      ? query(col(uid, 'workouts'), where('status', '==', 'completed'), where('finishedAt', '>=', oldBoundary))
      : query(col(uid, 'workouts'), where('status', '==', 'completed'))),
    getCountFromServer(oldBoundary ? query(col(uid, 'maxes'), where('effectiveDate', '>=', oldBoundary)) : col(uid, 'maxes')),
    getDocs(col(uid, 'measurements')),
  ]);
  const runs = runsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const programs = programsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const activeIds = [...new Set(runs.filter((r) => r.status === 'active').map((r) => r.programId))].filter((id) => programs.some((p) => p.id === id));
  const daysByProgram = {};
  await Promise.all(activeIds.map(async (id) => {
    daysByProgram[id] = (await getDocs(collection(db, 'users', uid, 'programs', id, 'days'))).docs.map((d) => d.data());
  }));
  const { activeProgram, position } = pickResetPosition({ runs, programs, daysByProgram });
  const bodyweight = measurementsSnap.docs.filter((d) => !isArchivedMeasurement(d.data(), oldBodyweightBoundary)).length;
  const generation = newResetId();

  const result = await runTransaction(db, async (tx) => {
    const [a, p] = [await tx.get(accessRef), await tx.get(profileRef)];
    const again = own ? evaluateOwn(a.data(), uid, own) : evaluateResetRequest({ access: a.data(), profile: p.data(), uid });
    if (again.state !== 'pending' || again.request.id !== ev.request.id) return { state: again.state === 'applied' ? 'already-applied' : again.state };
    let plan;
    try {
      plan = planTrainingReset({
        uid,
        profile: p.data(),
        request: again.request,
        generation,
        serverTime: serverTimestamp(),
        runIds: runs.map((r) => r.id),
        inProgressWorkoutIds: inProgressSnap.docs.map((d) => d.id),
        recordIds: recordsSnap.docs.map((d) => d.id),
        progressionSuggestionIds: suggestionsSnap.docs.map((d) => d.id),
        activeProgram,
        position,
        current: { workouts: workoutCount.data().count, maxHistory: maxCount.data().count, bodyweight },
      });
    } catch (err) {
      unappliable.add(again.request.id);
      throw err;
    }
    plan.deletes.forEach((path) => tx.delete(doc(db, path)));
    plan.sets.forEach(([path, data]) => tx.set(doc(db, path), data));
    tx.update(profileRef, plan.profileUpdate);
    return { state: 'applied', requestId: again.request.id, generation, activeProgram, position, counts: plan.counts, deleteBodyweight: again.request.deleteBodyweight === true };
  });
  if (result.state !== 'applied') return result;

  clearResetBoundaries(uid);
  if (result.deleteBodyweight) {
    const fresh = await getDoc(profileRef).catch(() => null);
    await finishBodyweightCleanup(uid, fresh?.data()).catch((err) => console.warn('Bodyweight cleanup will be retried on next sign-in:', err));
  }
  appliedListeners.forEach((cb) => { try { cb(result); } catch (err) { console.error(err); } });
  return result;
}

/**
 * If the reset asked for the bodyweight log to be deleted, delete every entry
 * older than bodyweightResetAt (owner may delete measurements). Already hidden
 * from every screen by the boundary, so a failure is invisible; retried on
 * every sign-in until it completes.
 */
async function finishBodyweightCleanup(uid, profile) {
  const boundary = bodyweightBoundaryOf(profile);
  if (!boundary || profile?.trainingReset?.bodyweightCleanupDone === true) return;
  const snap = await getDocs(col(uid, 'measurements'));
  // A pending (not yet server-stamped) entry reads as date null → never archived → never deleted.
  const old = snap.docs.filter((d) => isArchivedMeasurement(d.data(), boundary));
  for (let i = 0; i < old.length; i += 400) {
    const batch = writeBatch(db);
    old.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await updateDoc(doc(db, 'users', uid), { 'trainingReset.bodyweightCleanupDone': true });
}
