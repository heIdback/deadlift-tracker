// v29 — "Last time" on the active workout. Pure (no Firebase, no DOM).
//
// For every exercise in the workout being logged, finds the most recent
// FINISHED workout in which the lifter actually logged that same exercise, and
// pairs each set with the set at the same place last time (n-th warm-up ↔ n-th
// warm-up, n-th working set ↔ n-th working set). Read-only: nothing here is
// stored, and nothing changes the workout's own planned numbers.
//
// What counts as "last time":
//   - only finished workouts that are not an explicit Skip (a skipped session
//     has nothing performed in it);
//   - the same exercise id in the same role (a warm-up ramp and the main
//     working sets of one lift are kept apart); if a workout lists the same
//     exercise twice in that role, the 1st is paired with the 1st, the 2nd
//     with the 2nd;
//   - that exercise must have at least one logged set (done, changed or
//     failed) — an exercise left untouched last time is passed over and the
//     search goes further back.
import { resolveSetStatus, SET_STATUS } from './setLogging.js';
import { resolveCompletionState, EXPLICIT_SKIP_STATE } from './workoutCompletion.js';

/** How many recent finished workouts are searched (one query, newest first). */
export const PREVIOUS_LOOKBACK = 30;

const LOGGED = new Set([SET_STATUS.COMPLETED, SET_STATUS.MODIFIED, SET_STATUS.FAILED]);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// v33: a warm-up RAMP (load type 'sets') counts as warm-up even when a program lists it under 'main'
const roleOf = (ex) => (ex?.section === 'warmup' || ex?.load?.type === 'sets' ? 'warmup' : 'main');
const keyOf = (ex) => `${ex?.exerciseId ?? ''}|${roleOf(ex)}`;
const setKind = (s) => (s?.kind === 'warmup' ? 'warmup' : 'working');

/** Each exercise's occurrence number among exercises with the same key, in list order. */
function occurrences(exercises) {
  const seen = new Map();
  return (exercises ?? []).map((ex) => {
    const k = keyOf(ex);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n;
  });
}

const hasLoggedSet = (ex) => (ex?.sets ?? []).some((s) => LOGGED.has(resolveSetStatus(s)));

/** "180 kg × 5 @ RPE 8", "12 reps", "45 s", "skipped", "not done" … for one previous set. */
export function formatPreviousSet(s) {
  const status = resolveSetStatus(s);
  if (status === SET_STATUS.SKIPPED) return 'skipped';
  if (!LOGGED.has(status)) return 'not done';
  const parts = [];
  if (isNum(s.actualKg)) parts.push(`${s.actualKg} kg`);
  if (isNum(s.actualReps)) parts.push(parts.length ? `× ${s.actualReps}` : `${s.actualReps} reps`);
  if (!parts.length) parts.push(isNum(s.durationSec) ? `${s.durationSec} s` : 'done');
  let text = parts.join(' ');
  if (isNum(s.rpe)) text += ` @ RPE ${s.rpe}`;
  if (status === SET_STATUS.FAILED) text += ' (failed)';
  return text;
}

/**
 * Pairs the current sets with last time's: n-th warm-up with n-th warm-up,
 * n-th working set with n-th working set. Sets with no counterpart are left out.
 * → Map(setId → previous set)
 */
export function matchPreviousSets(currentSets, previousSets) {
  const prevByKind = { warmup: [], working: [] };
  (previousSets ?? []).forEach((s) => prevByKind[setKind(s)].push(s));
  const used = { warmup: 0, working: 0 };
  const out = new Map();
  (currentSets ?? []).forEach((s) => {
    const kind = setKind(s);
    const prev = prevByKind[kind][used[kind]];
    used[kind] += 1;
    if (prev && s?.setId) out.set(s.setId, prev);
  });
  return out;
}

/**
 * @param {Array} currentExercises  the active workout's exercises
 * @param {Array} recentWorkouts    finished workouts, NEWEST FIRST (already
 *                                  without archived / pre-reset ones)
 * @param {{excludeWorkoutId?: string}} [opts]
 * @returns {Map<string, {workoutId, finishedAt, week, dayName, sets: Map<string, string>}>}
 *          entryId → where last time came from + setId → text
 */
export function buildPreviousPerformance(currentExercises, recentWorkouts, { excludeWorkoutId } = {}) {
  const candidates = (recentWorkouts ?? []).filter((w) => w
    && w.id !== excludeWorkoutId
    && w.status === 'completed'
    && resolveCompletionState(w) !== EXPLICIT_SKIP_STATE)
    .map((w) => ({ w, occ: occurrences(w.exercises) }));
  const currentOcc = occurrences(currentExercises);
  const result = new Map();
  (currentExercises ?? []).forEach((ex, i) => {
    if (!ex?.exerciseId || !ex.entryId) return;
    const key = keyOf(ex);
    for (const { w, occ } of candidates) {
      const idx = (w.exercises ?? []).findIndex((p, j) => keyOf(p) === key && occ[j] === currentOcc[i]);
      const prev = idx === -1 ? null : w.exercises[idx];
      if (!prev || !hasLoggedSet(prev)) continue;
      const sets = new Map();
      matchPreviousSets(ex.sets, prev.sets).forEach((p, setId) => sets.set(setId, formatPreviousSet(p)));
      result.set(ex.entryId, {
        workoutId: w.id, finishedAt: w.finishedAt ?? null, week: w.week ?? null, dayName: w.dayName ?? '', sets,
      });
      return;
    }
  });
  return result;
}
