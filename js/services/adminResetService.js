// Admin "Reset training data" — client side. The client NEVER deletes or
// writes another user's data (firestore.rules forbid it, and keep forbidding
// it): the actual reset runs in the `adminResetUserFitness` Cloud Function
// (functions/src/resetCore.js), which re-checks the caller's admin role in
// /access and the typed confirmation on the server.
//
// This module only (a) reads counts for the confirmation screen, using the
// read access an approved admin already has, and (b) calls the function.
// The Functions SDK is imported lazily, so the Admin screens keep working
// offline exactly as before; the reset itself requires a connection.
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { app, db } from '../core/firebase.js';

const FUNCTIONS_SDK_URL = 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';
export const RESET_FUNCTION_NAME = 'adminResetUserFitness';

/** Must match functions/src/resetCore.js's expectedConfirmation exactly (the server re-checks it). */
export function expectedConfirmation(targetAccess, targetUid) {
  const email = typeof targetAccess?.email === 'string' ? targetAccess.email.trim() : '';
  return `RESET ${email || targetUid}`;
}

const sub = (uid, name) => getDocs(collection(db, 'users', uid, name));

/** Counts shown on confirmation step 1 (admin read access only — nothing is written). */
export async function getResetPreview(targetUid) {
  const [workouts, maxes, measurements, runs, programs] = await Promise.all([
    sub(targetUid, 'workouts'), sub(targetUid, 'maxes'), sub(targetUid, 'measurements'),
    sub(targetUid, 'programRuns'), sub(targetUid, 'programs'),
  ]);
  const programList = programs.docs.map((d) => ({ id: d.id, name: d.data().name ?? d.id }));
  const activeRun = runs.docs.map((d) => d.data()).find((r) => r.status === 'active') ?? null;
  return {
    workouts: workouts.size,
    inProgressWorkouts: workouts.docs.filter((d) => d.data().status === 'in_progress').length,
    maxHistory: maxes.size,
    measurements: measurements.size,
    programRuns: runs.size,
    programs: programList,
    activeProgram: activeRun ? (programList.find((p) => p.id === activeRun.programId) ?? null) : null,
  };
}

const ERROR_TEXT = {
  unauthenticated: 'You are signed out. Sign in again and retry.',
  'permission-denied': 'Only an approved admin can reset training data.',
  'not-found': 'That user no longer exists.',
  'failed-precondition': 'The confirmation text did not match. Nothing was reset.',
  'invalid-argument': 'The request was not valid. Nothing was reset.',
  aborted: null, // server message is specific (already running / incomplete)
  unavailable: 'No connection to the server. Nothing was reported as reset — try again when online.',
};

/** Calls the server. Resolves ONLY with the server's success result; anything else rejects. */
export async function runAdminReset(targetUid, confirmation) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const e = new Error(ERROR_TEXT.unavailable);
    e.code = 'unavailable';
    throw e;
  }
  const { getFunctions, httpsCallable } = await import(FUNCTIONS_SDK_URL);
  const call = httpsCallable(getFunctions(app), RESET_FUNCTION_NAME, { timeout: 300000 });
  try {
    const { data } = await call({ targetUid, confirmation });
    if (!data || data.ok !== true) throw Object.assign(new Error('The server did not confirm the reset.'), { code: 'internal' });
    return data;
  } catch (err) {
    const code = String(err?.code ?? 'internal').replace(/^functions\//, '');
    const e = new Error(ERROR_TEXT[code] ?? err?.message ?? 'The reset did not complete.');
    e.code = code;
    throw e;
  }
}
