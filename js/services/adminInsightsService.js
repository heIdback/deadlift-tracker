// ─────────────────────────────────────────────────────────────────────────
// Admin-only, READ-ONLY cross-user data access (Phase 3F). This is the
// ONLY module in the app that reads another user's fitness data — every
// function below is a `get`/`list`/count query, never a write. That is a
// structural guarantee, not just a comment: this file imports no
// `setDoc`/`updateDoc`/`addDoc`/`deleteDoc`/`writeBatch` from the Firestore
// SDK at all (see the Part C admin-detail test, which asserts this by
// reading this file's own source).
//
// Every read here is also independently enforced by firestore.rules: the
// cross-user `isApprovedAdmin()` OR-clause added in Phase 3F only ever
// grants READ (get + list), never write, on the collections used below
// (see firestore.rules' `/users/{uid}` block). A non-admin calling these
// functions directly would simply have every read rejected server-side.
//
// Wherever possible this file REUSES the exact same generic, uid-
// parametrized functions the user's own screens already call (programService
// .getPrimaryProgramContext/getProgramDays, workoutService.getInProgressWorkout
// /getLatestCompletedWorkout/listCompletedWorkouts/getWorkout, userService
// .getUserProfile, measurementService.getLatestBodyweight) — none of those
// functions touch localStorage or assume "the current signed-in user"; they
// were already written to take an explicit `uid` (see each file's own
// comments), so calling them with a DIFFERENT user's uid, from an admin
// session, requires no new Firestore-reading code duplicated here. This
// file's own job is composition (bundling several existing reads into the
// shapes the Admin screens want) and the one genuinely new read
// (`getCountFromServer` for a lightweight completed-workout count).
// ─────────────────────────────────────────────────────────────────────────
import { collection, query, where, getCountFromServer } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { getUserProfile } from './userService.js';
import { getPrimaryProgramContext, getProgramDays } from './programService.js';
import { getInProgressWorkout, getLatestCompletedWorkout, listCompletedWorkouts, getCurrentPeriodWorkout } from './workoutService.js';
import { getLatestBodyweight } from './measurementService.js';
import { getResetBoundaries } from './trainingResetService.js';

const workoutsCol = (uid) => collection(db, 'users', uid, 'workouts');

/**
 * One user's training summary, for BOTH the Admin User List row and (with
 * `includeDayName: true`) the Admin User Detail screen. Deliberately reads
 * less for the list case: resolving a human-readable day NAME needs an
 * extra `getProgramDays` fetch, which is only worth paying for a SINGLE
 * user (the Detail screen) — the List renders every approved user at once,
 * so it shows week/day as plain numbers instead (Part E: "avoid obvious
 * N+1 query explosions where reasonably possible").
 *
 * Read cost per call: ~4 Firestore operations (getPrimaryProgramContext's
 * 1-2 + getInProgressWorkout's 1 + getLatestCompletedWorkout's 1 + one
 * lightweight getCountFromServer), plus one more (getProgramDays) when
 * `includeDayName` is requested. For the current small user base this is
 * the "pragmatic client-side aggregation" Part E explicitly accepts rather
 * than expensive new infrastructure; see the Phase 3F report's query/index
 * section for the exact cost model and why no new Firestore indexes are
 * needed (every query shape here already exists elsewhere in the app).
 */
export async function getUserFitnessSummary(uid, { includeDayName = false } = {}) {
  // v22: after an admin reset, count only workouts since the reset
  // (server-side count; uses the existing status+finishedAt index).
  const { training } = await getResetBoundaries(uid);
  const [programCtx, activeWorkout, lastCompleted, completedCountSnap] = await Promise.all([
    getPrimaryProgramContext(uid),
    getInProgressWorkout(uid),
    getLatestCompletedWorkout(uid),
    getCountFromServer(training
      ? query(workoutsCol(uid), where('status', '==', 'completed'), where('finishedAt', '>=', training))
      : query(workoutsCol(uid), where('status', '==', 'completed'))),
  ]);

  const { program, run } = programCtx;
  const week = run?.current?.week ?? null;
  const dayOrder = run?.current?.dayOrder ?? null;

  let dayName = null;
  if (includeDayName && program && dayOrder != null) {
    const days = await getProgramDays(uid, program.id);
    dayName = days.find((d) => d.order === dayOrder)?.name ?? null;
  }

  const finishedAtDate = lastCompleted?.finishedAt?.toDate?.() ?? null;

  return {
    uid,
    programName: program?.name ?? null,
    week,
    dayOrder,
    dayName,
    hasActiveWorkout: !!activeWorkout,
    activeWorkoutId: activeWorkout?.id ?? null,
    completedWorkoutCount: completedCountSnap.data().count,
    lastCompletedWorkout: lastCompleted
      ? {
        id: lastCompleted.id,
        finishedAtDate,
        week: lastCompleted.week ?? null,
        dayOrder: lastCompleted.dayOrder ?? null,
        dayName: lastCompleted.dayName ?? null,
      }
      : null,
  };
}

/** Fitness summaries for every APPROVED record in `accessRecords`, in parallel. Pending/disabled users have no program yet (see core/access.js), so they are skipped entirely — zero reads spent on accounts the app has never initialized. */
export async function getFitnessSummariesForApprovedUsers(accessRecords) {
  const approved = (accessRecords ?? []).filter((r) => r.status === 'approved');
  const summaries = await Promise.all(approved.map((r) => getUserFitnessSummary(r.id)));
  return new Map(summaries.map((s) => [s.uid, s]));
}

/**
 * Everything the Admin User Detail screen shows beyond the list-row
 * summary: current 1RM maxes (from the profile's denormalized cache — the
 * same field Profile's own "Current 1RM values" card reads), latest
 * bodyweight, and recent completed-workout history. Read-only; no part of
 * this (or any other function in this file) can be reached from an editing
 * control — js/views/adminUserDetail.js renders this data with no inputs
 * at all (see that file).
 */
export async function getUserDetailData(targetUid) {
  const [summary, profile, bodyweight, recentWorkouts] = await Promise.all([
    getUserFitnessSummary(targetUid, { includeDayName: true }),
    getUserProfile(targetUid),
    getLatestBodyweight(targetUid),
    listCompletedWorkouts(targetUid, 10),
  ]);

  return {
    summary,
    currentMaxes: profile?.currentMaxes ?? {},
    bodyweight: bodyweight ? { kg: bodyweight.value, date: bodyweight.date?.toDate?.() ?? null } : null,
    recentWorkouts, // already newest-first, see listCompletedWorkouts
  };
}

/** Read-only fetch of one specific workout snapshot, for the Admin "Workout Detail" drill-down. Identical read to what the owning user's own (future) History screen will use — see workoutService.getWorkout. */
export async function getUserWorkoutDetail(targetUid, workoutId) {
  return getCurrentPeriodWorkout(targetUid, workoutId); // v22: archived (pre-reset) → not found
}
