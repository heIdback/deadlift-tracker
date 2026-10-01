// Admin "Reset training data" — admin side (Spark/free plan, no Cloud
// Functions, firestore.rules unchanged). Model: ../utils/trainingReset.js.
//
// The admin's app never writes another user's training data (the rules
// forbid it). It writes a RESET REQUEST onto /access/{targetUid} — the one
// document an approved admin may update — and the target's own app applies
// it (services/trainingResetService.js) the next time it is online. An admin
// resetting their OWN account gets it applied immediately.
import {
  doc, collection, getDoc, getDocs, updateDoc, serverTimestamp, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';
import {
  expectedResetConfirmation, evaluateResetRequest, newResetId, trainingBoundaryOf, bodyweightBoundaryOf,
  isArchivedWorkout, isArchivedMax, isArchivedMeasurement, toMillis,
} from '../utils/trainingReset.js';
import { applyOwnTrainingReset } from './trainingResetService.js';

export const expectedConfirmation = (access, uid) => expectedResetConfirmation(access?.email, uid);

const sub = (uid, name) => getDocs(collection(db, 'users', uid, name));
const offlineError = () => Object.assign(new Error('No connection. Nothing was changed — try again when online.'), { code: 'unavailable' });
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Current-period counts for confirmation step 1 (admin read access only — nothing is written). */
export async function getResetPreview(targetUid) {
  const [profileSnap, workouts, maxes, measurements, runs, programs] = await Promise.all([
    getDoc(doc(db, 'users', targetUid)),
    sub(targetUid, 'workouts'), sub(targetUid, 'maxes'), sub(targetUid, 'measurements'),
    sub(targetUid, 'programRuns'), sub(targetUid, 'programs'),
  ]);
  const profile = profileSnap.exists() ? profileSnap.data() : null;
  const tb = trainingBoundaryOf(profile);
  const bb = bodyweightBoundaryOf(profile);
  const currentWorkouts = workouts.docs.map((d) => d.data()).filter((w) => !isArchivedWorkout(w, tb));
  const programList = programs.docs.map((d) => ({ id: d.id, name: d.data().name ?? d.id }));
  // same choice as the reset itself (utils/trainingReset.js pickResetPosition): most recently started active run
  const activeRun = runs.docs.map((d) => d.data()).filter((r) => r.status === 'active')
    .sort((a, b) => (toMillis(b.startDate) ?? 0) - (toMillis(a.startDate) ?? 0))[0] ?? null;
  return {
    workouts: currentWorkouts.length,
    inProgressWorkouts: currentWorkouts.filter((w) => w.status === 'in_progress').length,
    maxHistory: maxes.docs.filter((d) => !isArchivedMax(d.data(), tb)).length,
    measurements: measurements.docs.filter((d) => !isArchivedMeasurement(d.data(), bb)).length,
    programRuns: runs.size,
    programs: programList,
    activeProgram: activeRun ? (programList.find((p) => p.id === activeRun.programId) ?? null) : null,
  };
}

/** Where this user's reset stands: none | pending | applied | cancelled | invalid. */
export async function getResetStatus(targetUid) {
  const [accessSnap, profileSnap] = await Promise.all([getDoc(doc(db, 'access', targetUid)), getDoc(doc(db, 'users', targetUid))]);
  const access = accessSnap.exists() ? accessSnap.data() : null;
  const profile = profileSnap.exists() ? profileSnap.data() : null;
  const ev = evaluateResetRequest({ access, profile, uid: targetUid });
  return { ...ev, applied: profile?.trainingReset ?? null };
}

/**
 * Writes the reset request (after the UI's two confirmations; the typed text
 * is re-checked here and again by the target's app). Self-reset is applied
 * immediately. Resolves {mode: 'requested', id} | {mode: 'applied', result}.
 */
export async function requestTrainingReset({ adminUid, targetUid, confirmation, deleteBodyweight = false }) {
  if (isOffline()) throw offlineError();
  if (targetUid === adminUid) {
    // Own account: the owner may do every write itself — no request needed
    // (and none could be written if this access record was created by hand).
    const result = await applyOwnTrainingReset(adminUid, { confirmation, deleteBodyweight });
    if (result.state === 'applied') return { mode: 'applied', result };
    throw Object.assign(new Error(result.state === 'invalid' ? 'The confirmation text did not match. Nothing was changed.' : 'The reset could not be applied. Nothing was changed.'), { code: 'failed-precondition' });
  }
  const accessRef = doc(db, 'access', targetUid);
  const snap = await getDoc(accessRef);
  if (!snap.exists()) throw Object.assign(new Error('That user no longer exists.'), { code: 'not-found' });
  const access = snap.data();
  if (access.status !== 'approved') throw Object.assign(new Error('Only an approved user can be reset.'), { code: 'failed-precondition' });
  if (confirmation !== expectedConfirmation(access, targetUid)) {
    throw Object.assign(new Error('The confirmation text did not match. Nothing was changed.'), { code: 'failed-precondition' });
  }
  const id = newResetId();
  try {
    await trackWrite(() => updateDoc(accessRef, {
      trainingResetRequest: {
        id, requestedBy: adminUid, requestedAt: serverTimestamp(), confirmation, deleteBodyweight: deleteBodyweight === true, status: 'requested',
      },
      approvedBy: adminUid, // required by the access rule for an approved account
    }));
  } catch (err) {
    throw Object.assign(new Error(err?.code === 'permission-denied'
      ? 'The security rules refused the request: only an approved admin can request a reset (a hand-made access record with missing fields is refused too). Nothing was changed.'
      : 'The reset request could not be saved. Nothing was changed.'), { code: err?.code ?? 'internal' });
  }
  return { mode: 'requested', id };
}

/**
 * Withdraws a request that has not been applied yet. A transaction that also
 * reads the user's profile: if their app applied it a moment ago, the cancel
 * fails and says so instead of claiming "nothing was changed".
 */
export async function cancelTrainingResetRequest({ adminUid, targetUid }) {
  if (isOffline()) throw offlineError();
  const accessRef = doc(db, 'access', targetUid);
  await trackWrite(() => runTransaction(db, async (tx) => {
    const [a, p] = [await tx.get(accessRef), await tx.get(doc(db, 'users', targetUid))];
    const ev = evaluateResetRequest({ access: a.data(), profile: p.exists() ? p.data() : null, uid: targetUid });
    if (ev.state === 'applied') throw Object.assign(new Error('Too late — the user\'s app has already applied this reset.'), { code: 'failed-precondition' });
    if (ev.state !== 'pending') throw Object.assign(new Error('There is no pending reset request to cancel.'), { code: 'failed-precondition' });
    tx.update(accessRef, {
      'trainingResetRequest.status': 'cancelled',
      'trainingResetRequest.cancelledBy': adminUid,
      'trainingResetRequest.cancelledAt': serverTimestamp(),
      approvedBy: adminUid,
    });
  }));
}
