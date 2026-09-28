// ─────────────────────────────────────────────────────────────────────────
// Phase 4 — Part P "Set Active": the only place that decides which of a
// user's programRuns is the active one. Composes existing services
// (programService.js, workoutService.js) rather than importing either
// direction into the other, the same one-way-composition pattern
// js/services/adminInsightsService.js already established in Phase 3F —
// this is what avoids a circular import between programService.js and
// workoutService.js (which already imports FROM programService.js).
//
// All writes are owner-scoped programRuns/{runId} updates or creates,
// already covered by firestore.rules' existing
// `allow write: if isApprovedUser(uid)` on that path — no rules change.
// ─────────────────────────────────────────────────────────────────────────
import {
  doc, serverTimestamp, writeBatch, collection,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';
import { listProgramRuns, getProgramDays } from './programService.js';
import { getInProgressWorkout } from './workoutService.js';
import { planSetActiveProgram } from '../utils/programSwitch.js';
import { pickStarterPosition } from '../utils/starterProgram.js';

const runsCol = (uid) => collection(db, 'users', uid, 'programRuns');

/**
 * Attempts to make `programId` the user's active program (Part P).
 * Returns one of:
 *   - { ok: false, reason: 'in_progress_workout' } — blocked; the spec's
 *     preferred safe behavior (Part P, option A) is to block rather than
 *     attempt anything clever with a workout mid-flight.
 *   - { ok: true, alreadyActive: true } — no-op, already the active program.
 *   - { ok: true, runId } — switched; `runId` is the (reused or newly
 *     created) run that is now active.
 */
export async function setActiveProgram(uid, programId) {
  const [runs, inProgress] = await Promise.all([
    listProgramRuns(uid),
    getInProgressWorkout(uid),
  ]);

  const plan = planSetActiveProgram({
    runs,
    targetProgramId: programId,
    hasInProgressWorkout: !!inProgress,
  });

  if (plan.blocked) {
    return { ok: false, reason: plan.reason };
  }
  if (plan.alreadyActive) {
    return { ok: true, alreadyActive: true, runId: plan.activeRunId };
  }

  return trackWrite(async () => {
    const batch = writeBatch(db);

    if (plan.deactivateRunId) {
      // Not 'completed'/'abandoned' — this run's OWN program isn't
      // finished or given up on, the user is just training a different
      // program right now. getActiveProgramRun's `where('status','==',
      // 'active')` query is what actually matters here: any non-'active'
      // string keeps this run out of that query, which is all switching
      // needs, and 'switched-away' says plainly in the data what happened.
      batch.update(doc(runsCol(uid), plan.deactivateRunId), { status: 'switched-away' });
    }

    let runId = plan.reuseRunId;
    if (plan.reuseRunId) {
      batch.update(doc(runsCol(uid), plan.reuseRunId), { status: 'active' });
    } else {
      const days = await getProgramDays(uid, programId);
      const position = pickStarterPosition(days) ?? { week: 1, dayOrder: 1 };
      const newRef = doc(runsCol(uid));
      runId = newRef.id;
      batch.set(newRef, {
        programId,
        startDate: serverTimestamp(),
        current: position,
        status: 'active',
        overrides: {},
      });
    }

    await batch.commit();
    return { ok: true, alreadyActive: false, runId };
  });
}
