// v31 — hide / delete INACTIVE programs. Pure rules (no Firebase, no DOM);
// the writes are services/programManageService.js.
//
//   Hide   — sets `hidden: true` on the program doc: it leaves the "Your
//            Programs" list (and the import's "Update a program" list) and
//            sits under "Hidden programs", where Unhide brings it back.
//            Nothing else changes.
//   Delete — permanent: the program, its days and its own (inactive) runs.
//            Workout history stays: every finished workout carries its own
//            copy of the plan it was done with.
// The ACTIVE program can be neither hidden nor deleted, and nothing is
// deleted while a workout of that program is in progress.

export const isHiddenProgram = (p) => p?.hidden === true;
export const visiblePrograms = (programs) => (programs ?? []).filter((p) => !isHiddenProgram(p));
export const hiddenPrograms = (programs) => (programs ?? []).filter(isHiddenProgram);

/** → {ok: true} | {ok: false, reason, message} */
export function checkProgramManageable({ program, activeProgramId, inProgressWorkout }) {
  if (!program) return { ok: false, reason: 'not_found', message: 'That program no longer exists.' };
  if (program.id === activeProgramId) {
    return { ok: false, reason: 'active', message: 'This is your active program. Set another program active first.' };
  }
  if (inProgressWorkout && inProgressWorkout.programId === program.id) {
    return { ok: false, reason: 'in_progress_workout', message: 'A workout of this program is in progress. Finish or skip it first.' };
  }
  return { ok: true };
}

/** Document paths a delete removes: every day, every run of this program, then the program itself. */
export function planDeleteProgram({ uid, programId, days, runs }) {
  const base = `users/${uid}`;
  return [
    ...(days ?? []).map((d) => `${base}/programs/${programId}/days/${d.id}`),
    ...(runs ?? []).filter((r) => r.programId === programId).map((r) => `${base}/programRuns/${r.id}`),
    `${base}/programs/${programId}`,
  ];
}
