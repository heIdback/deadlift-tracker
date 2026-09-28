// ─────────────────────────────────────────────────────────────────────────
// Phase 4 — pure decision logic for "Set Active" (Part P): switching which
// program a user is currently training from. No Firestore import here —
// split out from services/programSwitchService.js the same way every other
// pure/service pair in this codebase already is, so "is it safe to switch
// right now?" and "which run do we reuse/create?" are unit-testable without
// a database.
//
// The app's existing model (programService.js's getActiveProgramRun/
// getPrimaryProgramContext) assumes exactly one programRun has
// `status: 'active'` at a time. This function is what preserves that
// invariant across a switch: it always deactivates the old active run (if
// its program differs from the target) in the same plan that
// activates/creates the new one, so the two can be committed in a single
// atomic batch — never a moment with zero or two active runs.
// ─────────────────────────────────────────────────────────────────────────

function toMillis(startDate) {
  if (!startDate) return 0;
  if (typeof startDate?.toMillis === 'function') return startDate.toMillis();
  if (typeof startDate?.seconds === 'number') return startDate.seconds * 1000;
  if (startDate instanceof Date) return startDate.getTime();
  return 0;
}

/**
 * @param {{runs: Array<{id, programId, status, startDate}>, targetProgramId: string, hasInProgressWorkout: boolean}} args
 * @returns one of:
 *   - { blocked: true, reason: 'in_progress_workout' } — Part P, option A
 *     (block until the current in-progress workout is finished)
 *   - { blocked: false, alreadyActive: true, activeRunId } — no-op, the
 *     requested program is already the active one
 *   - { blocked: false, alreadyActive: false, deactivateRunId, reuseRunId,
 *       createNewRun } — the plan to execute: deactivate the old active run
 *     (if any), then either reactivate an existing run for the target
 *     program (preserving its prior progress) or create a fresh one at the
 *     program's first day.
 */
export function planSetActiveProgram({ runs, targetProgramId, hasInProgressWorkout }) {
  const allRuns = runs ?? [];
  const currentActive = allRuns.find((r) => r.status === 'active') ?? null;

  if (currentActive && currentActive.programId === targetProgramId) {
    return { blocked: false, alreadyActive: true, activeRunId: currentActive.id };
  }

  if (hasInProgressWorkout) {
    return { blocked: true, reason: 'in_progress_workout' };
  }

  const candidateRuns = allRuns
    .filter((r) => r.programId === targetProgramId)
    .sort((a, b) => toMillis(b.startDate) - toMillis(a.startDate));
  const reuseRun = candidateRuns[0] ?? null;

  return {
    blocked: false,
    alreadyActive: false,
    deactivateRunId: currentActive ? currentActive.id : null,
    reuseRunId: reuseRun ? reuseRun.id : null,
    createNewRun: !reuseRun,
  };
}
