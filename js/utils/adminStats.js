// ─────────────────────────────────────────────────────────────────────────
// Pure aggregation math for the Admin Dashboard (Phase 3F). No Firebase/DOM
// import on purpose, mirroring the project's established pure-logic/
// Firebase-boundary split (see js/utils/programProgress.js,
// js/utils/starterProgram.js): the actual Firestore reads live in
// js/services/adminInsightsService.js, which calls these functions with
// plain data it has already fetched. Kept here so the COUNTING logic itself
// — the part most likely to have an off-by-one or a double-count bug — is
// directly unit-testable without a database.
// ─────────────────────────────────────────────────────────────────────────
import { isWithinDays } from './dates.js';

/**
 * USERS counters — pure counting over the already-fetched `/access` records
 * list (accessAdminService.listAccessRecords()). Zero additional Firestore
 * reads: every number here comes from data the admin view already has to
 * fetch anyway to render the Pending/Approved/Disabled lists.
 */
export function computeUserCounts(accessRecords) {
  const records = accessRecords ?? [];
  return {
    total: records.length,
    approved: records.filter((r) => r.status === 'approved').length,
    pending: records.filter((r) => r.status === 'pending').length,
    disabled: records.filter((r) => r.status === 'disabled').length,
  };
}

/**
 * TRAINING counters — derived from one `summaries` array, one entry per
 * APPROVED user, already fetched by
 * adminInsightsService.getUserFitnessSummary() (which itself reuses
 * existing per-user services — see that file). Each summary entry has the
 * shape:
 *   { uid, hasActiveWorkout: boolean, completedWorkoutCount: number,
 *     lastCompletedWorkout: { finishedAtDate: Date|null } | null }
 * `recentDays` controls the "completed a workout recently" window (the
 * Admin Dashboard uses 7); passed explicitly rather than hardcoded here so
 * it stays a single, callable, testable parameter.
 */
export function computeTrainingStats(summaries, { recentDays = 7 } = {}) {
  const list = summaries ?? [];
  const totalCompletedWorkouts = list.reduce((sum, s) => sum + (s.completedWorkoutCount ?? 0), 0);
  const workoutsInProgress = list.filter((s) => s.hasActiveWorkout).length;
  const recentlyActiveUsers = list.filter((s) => {
    const d = s.lastCompletedWorkout?.finishedAtDate;
    return d instanceof Date && isWithinDays(d, recentDays);
  }).length;

  return { totalCompletedWorkouts, workoutsInProgress, recentlyActiveUsers, recentDays };
}
