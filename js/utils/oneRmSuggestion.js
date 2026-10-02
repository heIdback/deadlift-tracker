// v26 — "your 1RM may be higher than your profile says" suggestion.
//
// Pure, Firebase-free. Takes already-fetched COMPLETED workouts and returns
// at most ONE suggestion per lift, or null. It never writes anything: the
// Home card that shows the suggestion only calls recordOneRepMax when the
// lifter presses the confirm button. Nothing here (or anywhere else) changes
// a Current 1RM by itself.
//
// Evidence, strongest first:
//   1. TESTED  — a completed single (1 rep) heavier than the current 1RM.
//   2. ESTIMATED — a completed set of 2-5 reps whose Epley estimate, rounded
//      DOWN to 2.5 kg, is at least 2.5 kg above the current 1RM. Reps above 5
//      are ignored: Epley drifts too high there (the Progress charts already
//      cap their own estimate at 12 reps; this is deliberately stricter).
// Only sets that already count for analytics are used (completed or
// modified, never warm-up/failed/skipped — progressAnalytics.workingSetsFor),
// and only workouts finished AFTER the lift's current 1RM was last updated,
// so a number the lifter has already accepted or set by hand never comes back.
//
// Sanity guard: a candidate more than 15 % above the current 1RM is ignored
// (almost always a typo such as 4000 instead of 400, or a stale profile
// value) — a lifter whose profile is that far off corrects it in Profile.
import { epleyEstimate1RM } from './calculations.js';
import { chronological, workingSetsFor, toMillis } from './progressAnalytics.js';

export const EST_MIN_REPS = 2;
export const EST_MAX_REPS = 5;
export const EST_MIN_GAIN_KG = 2.5;
export const ROUND_KG = 2.5;
export const MAX_PLAUSIBLE_JUMP = 1.15;

/** Round DOWN to the increment (conservative on purpose — never suggests more than the evidence supports). */
export function floorToIncrement(value, increment = ROUND_KG) {
  return Math.floor(value / increment + 1e-9) * increment;
}

/**
 * @param {object} args
 * @param {Array}  args.completedWorkouts completed workout documents (any order)
 * @param {string} args.exerciseId        e.g. 'deadlift'
 * @param {number|null} args.currentKg    the lifter's current 1RM for this lift (null → no suggestion)
 * @param {number} [args.sinceMillis=0]   only workouts finished after this instant count
 * @returns {null | {
 *   exerciseId:string, basis:'tested'|'estimated', suggestedKg:number, currentKg:number,
 *   fromKg:number, fromReps:number, workoutId:string|null, finishedAtMillis:number
 * }}
 */
export function computeOneRmSuggestion({
  completedWorkouts, exerciseId, currentKg, sinceMillis = 0,
}) {
  if (typeof currentKg !== 'number' || !Number.isFinite(currentKg) || currentKg <= 0) return null;
  const ceiling = currentKg * MAX_PLAUSIBLE_JUMP;

  let bestTested = null;
  let bestEstimated = null;

  for (const workout of chronological(completedWorkouts)) {
    const finishedAtMillis = toMillis(workout.finishedAt);
    if (finishedAtMillis <= sinceMillis) continue;
    for (const s of workingSetsFor(workout, exerciseId)) {
      if (s.actualReps === 1) {
        if (s.actualKg > currentKg && s.actualKg <= ceiling
          && (bestTested == null || s.actualKg >= bestTested.suggestedKg)) {
          bestTested = {
            basis: 'tested', suggestedKg: s.actualKg, fromKg: s.actualKg, fromReps: 1,
            workoutId: workout.id ?? null, finishedAtMillis,
          };
        }
      } else if (s.actualReps >= EST_MIN_REPS && s.actualReps <= EST_MAX_REPS) {
        const est = floorToIncrement(epleyEstimate1RM(s.actualKg, s.actualReps));
        if (est >= currentKg + EST_MIN_GAIN_KG && est <= ceiling
          && (bestEstimated == null || est >= bestEstimated.suggestedKg)) {
          bestEstimated = {
            basis: 'estimated', suggestedKg: est, fromKg: s.actualKg, fromReps: s.actualReps,
            workoutId: workout.id ?? null, finishedAtMillis,
          };
        }
      }
    }
  }

  const pick = bestTested ?? bestEstimated;
  return pick ? { exerciseId, currentKg, ...pick } : null;
}

/** Highest completed tested single (all eligible history, no "since" cut-off) — for the goal card's "Best tested" line. */
export function bestTestedKg(completedWorkouts, exerciseId) {
  let best = null;
  for (const w of chronological(completedWorkouts)) {
    for (const s of workingSetsFor(w, exerciseId)) {
      if (s.actualReps === 1 && (best == null || s.actualKg > best)) best = s.actualKg;
    }
  }
  return best;
}

/** Highest Epley estimate from 2-5 rep sets (all eligible history), rounded down to 2.5 kg — for the goal card. */
export function bestEstimatedKg(completedWorkouts, exerciseId) {
  let best = null;
  for (const w of chronological(completedWorkouts)) {
    for (const s of workingSetsFor(w, exerciseId)) {
      if (s.actualReps < EST_MIN_REPS || s.actualReps > EST_MAX_REPS) continue;
      const est = floorToIncrement(epleyEstimate1RM(s.actualKg, s.actualReps));
      if (best == null || est > best) best = est;
    }
  }
  return best;
}
