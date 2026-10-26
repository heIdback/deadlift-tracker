// v31 — Hide / Unhide / Delete an inactive program. Rules and the delete
// plan: ../utils/programManage.js. Composes programService + workoutService
// (like programSwitchService), so neither imports the other.
//
// No firestore.rules change: owners may write their own programs/{id}, its
// days and programRuns. Both actions need a connection (they re-check the
// active program and any in-progress workout against the server first, and
// a delete can't be undone). The delete is ONE batch — program, days and the
// program's own runs go together or not at all — committed through the
// admin-reset generation guard (it removes programRuns).
import {
  doc, writeBatch, updateDoc, serverTimestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';
import { getProgramWithDays, getActiveProgramRun, listProgramRuns } from './programService.js';
import { getInProgressWorkout } from './workoutService.js';
import { commitTrainingBatch } from './trainingGenerationService.js';
import { checkProgramManageable, planDeleteProgram } from '../utils/programManage.js';

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const offline = (what) => ({ ok: false, reason: 'offline', message: `${what} a program needs an internet connection. Nothing was changed.` });

async function check(uid, programId) {
  const [{ program, days }, activeRun, inProgress] = await Promise.all([
    getProgramWithDays(uid, programId), getActiveProgramRun(uid), getInProgressWorkout(uid),
  ]);
  return { program, days, verdict: checkProgramManageable({ program, activeProgramId: activeRun?.programId ?? null, inProgressWorkout: inProgress }) };
}

/** Hide (true) or unhide (false). Resolves {ok: true} | {ok: false, reason, message}. */
export async function setProgramHidden(uid, programId, hidden) {
  if (isOffline()) return offline(hidden ? 'Hiding' : 'Unhiding');
  if (hidden) {
    const { verdict } = await check(uid, programId);
    if (!verdict.ok) return verdict;
  }
  await trackWrite(() => updateDoc(doc(db, 'users', uid, 'programs', programId), {
    hidden: hidden ? true : deleteField(),
    updatedAt: serverTimestamp(),
  }));
  return { ok: true };
}

/** Permanently deletes an inactive program. Resolves {ok: true, deleted: n} | {ok: false, reason, message}. */
export async function deleteProgram(uid, programId) {
  if (isOffline()) return offline('Deleting');
  const { program, days, verdict } = await check(uid, programId);
  if (!verdict.ok) return verdict;
  const runs = await listProgramRuns(uid);
  const paths = planDeleteProgram({ uid, programId: program.id, days, runs });
  await trackWrite(() => {
    const batch = writeBatch(db);
    paths.forEach((p) => batch.delete(doc(db, p)));
    return commitTrainingBatch(uid, batch);
  });
  return { ok: true, deleted: paths.length };
}
