// v30 — Program Import → "Update existing program". The planning and the
// rules live in ../utils/programUpdate.js; this is the read-before and the
// one write. Composes programService + workoutService (like
// programSwitchService), so neither of those imports the other.
//
// The write is ONE transaction (all or nothing):
//   - saves the copy of the old version as a new, inactive program;
//   - updates the program doc (same id, same name) with the file's weeks/
//     settings and replaces its days (removed days deleted);
//   - re-reads the program and every run it guards, and aborts if a run
//     moved or a workout was started in the meantime.
// It never writes a programRun, a workout, a 1RM or the profile. Needs a
// connection (transactions don't run offline). No firestore.rules change:
// owners may write their own programs/{id} and days.
import {
  doc, collection, runTransaction, serverTimestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';
import { getProgramWithDays, listPrograms, listProgramRuns } from './programService.js';
import { getInProgressWorkout } from './workoutService.js';
import { planProgramUpdate } from '../utils/programUpdate.js';

const MAX_WRITES = 450;
const programRef = (uid, id) => doc(db, 'users', uid, 'programs', id);
const dayRef = (uid, programId, dayId) => doc(collection(db, 'users', uid, 'programs', programId, 'days'), dayId);
const runRef = (uid, runId) => doc(db, 'users', uid, 'programRuns', runId);
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Everything the plan needs, read fresh. */
async function gather(uid, targetProgramId) {
  const [{ program, days }, programs, runs, inProgress] = await Promise.all([
    getProgramWithDays(uid, targetProgramId),
    listPrograms(uid),
    listProgramRuns(uid),
    getInProgressWorkout(uid),
  ]);
  return {
    targetProgram: program, targetDays: days, runs, hasInProgressWorkout: !!inProgress, existingProgramIds: programs.map((p) => p.id),
  };
}

/** What an update would do — nothing is written. Same result shape as planProgramUpdate. */
export async function previewProgramUpdate(uid, targetProgramId, plan) {
  return planProgramUpdate({ ...(await gather(uid, targetProgramId)), plan });
}

/**
 * Applies the update. Resolves {ok: true, programId, backupProgramId, diff}
 * or {ok: false, reason, message} (nothing written). Throws only on
 * unexpected errors (also with nothing written).
 */
export async function updateProgramFromImport(uid, targetProgramId, plan) {
  if (isOffline()) {
    return { ok: false, reason: 'offline', message: 'Updating a program needs an internet connection. Nothing was changed — try again when you\'re back online.' };
  }
  const p = planProgramUpdate({ ...(await gather(uid, targetProgramId)), plan });
  if (!p.ok) return p;
  const writes = 1 + p.backup.days.length + 1 + p.setDays.length + p.deleteDayIds.length;
  if (writes > MAX_WRITES) return { ok: false, reason: 'too_large', message: 'This program is too large to update in one step. Nothing was changed.' };

  return trackWrite(() => runTransaction(db, async (tx) => {
    const target = await tx.get(programRef(uid, targetProgramId));
    const backupDoc = await tx.get(programRef(uid, p.backup.programId));
    const runSnaps = await Promise.all(p.guardedRuns.map((r) => tx.get(runRef(uid, r.id))));
    if (!target.exists()) return { ok: false, reason: 'not_found', message: 'That program no longer exists. Nothing was changed.' };
    if (backupDoc.exists()) return { ok: false, reason: 'retry', message: 'Something changed while updating. Nothing was changed — please try again.' };
    for (let i = 0; i < runSnaps.length; i += 1) {
      const r = runSnaps[i].exists() ? runSnaps[i].data() : null;
      const was = p.guardedRuns[i];
      if (!r || r.activeWorkoutId || r.current?.week !== was.current?.week || r.current?.dayOrder !== was.current?.dayOrder || r.status !== was.status) {
        return { ok: false, reason: 'retry', message: 'Your program position or a workout changed while updating. Nothing was changed — please try again.' };
      }
    }

    // 1. the copy of the old version (inactive: no run is created for it)
    tx.set(programRef(uid, p.backup.programId), {
      ...p.backup.program, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), backupOfProgramId: targetProgramId,
    });
    p.backup.days.forEach((d) => tx.set(dayRef(uid, p.backup.programId, d.id), d.data));

    // 2. the program itself: same id and name, new content
    tx.update(programRef(uid, targetProgramId), {
      ...p.programData,
      ...Object.fromEntries(p.clearFields.map((f) => [f, deleteField()])),
      importedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    p.deleteDayIds.forEach((id) => tx.delete(dayRef(uid, targetProgramId, id)));
    p.setDays.forEach((d) => tx.set(dayRef(uid, targetProgramId, d.id), d.data));

    return { ok: true, programId: targetProgramId, backupProgramId: p.backup.programId, backupName: p.backup.program.name, diff: p.diff };
  }));
}
