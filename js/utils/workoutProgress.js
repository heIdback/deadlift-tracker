// v32 — progress counts and the ±2.5 kg step on the active workout.
// Pure (no Firebase, no DOM).
//
// A set counts as "done" for progress when the lifter has dealt with it:
// logged (done / changed / failed) or explicitly skipped. An exercise is
// finished when every one of its sets is done — that is when the logger
// collapses it (it can be opened again with a tap).
import { resolveSetStatus } from './setLogging.js';

export const KG_STEP = 2.5;

export const isHandledSet = (s) => resolveSetStatus(s) != null;

/** {done, total} for one exercise. */
export function exerciseProgress(ex) {
  const sets = ex?.sets ?? [];
  return { done: sets.filter(isHandledSet).length, total: sets.length };
}

/** {done, total} over the whole workout. */
export function workoutProgress(exercises) {
  return (exercises ?? []).reduce((acc, ex) => {
    const p = exerciseProgress(ex);
    return { done: acc.done + p.done, total: acc.total + p.total };
  }, { done: 0, total: 0 });
}

/** A set marked Failed whose reps are still empty (the lifter is about to type them). */
export const awaitsReps = (ex) => (ex?.sets ?? []).some((s) => resolveSetStatus(s) === 'failed' && s.actualReps == null && s.durationSec == null);

export const isExerciseFinished = (ex) => {
  const p = exerciseProgress(ex);
  return p.total > 0 && p.done === p.total;
};

/**
 * Next kg value after a −/+ tap: from the typed value, else the planned one,
 * else 0; never below 0; no float noise (172.5, not 172.49999).
 */
export function stepKg(current, planned, delta) {
  const base = Number.isFinite(current) ? current : (Number.isFinite(planned) ? planned : 0);
  return Math.max(0, Math.round((base + delta) * 100) / 100);
}
