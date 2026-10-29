// v33 — the summary shown right after FINISH WORKOUT. Pure (no Firebase, no
// DOM); the screen is js/views/workout.js (showFinishSummary).
//
//   - sets: done / total (done = logged or skipped, as on the logger), plus
//     how many failed and skipped;
//   - duration: start → finish;
//   - volume: Σ kg × reps over the sets that count for analytics (completed or
//     changed working sets with a weight and reps — progressAnalytics'
//     isMeaningfulWorkingSet; warm-ups, failed and skipped sets don't count);
//   - PRs set in this workout (prAnalytics, same rules as History/Progress);
//   - comparison with the PREVIOUS time this program day was done (same
//     program, same day; skipped sessions ignored): the day's main lift's top
//     set and the volume.
import { isMeaningfulWorkingSet, toMillis } from './progressAnalytics.js';
import { computeAllPrEvents, prEventsForWorkout, prTypeLabel, PR_TYPE } from './prAnalytics.js';
import { resolveCompletionState, EXPLICIT_SKIP_STATE } from './workoutCompletion.js';
import { exerciseProgress } from './workoutProgress.js';
import { resolveSetStatus } from './setLogging.js';

const workingSets = (w) => (w?.exercises ?? []).flatMap((ex) => ex.sets ?? []).filter(isMeaningfulWorkingSet);

/** Σ actualKg × actualReps over the analytics-eligible working sets, rounded to 0.1 kg. */
export function workoutVolume(workout) {
  return Math.round(workingSets(workout).reduce((sum, s) => sum + s.actualKg * s.actualReps, 0) * 10) / 10;
}

/** The day's main lift: the first MAIN exercise that isn't a warm-up ramp. */
export function mainExerciseOf(workout) {
  return (workout?.exercises ?? []).find((ex) => ex?.section === 'main' && ex.load?.type !== 'sets') ?? null;
}

/** Heaviest eligible set of `exerciseId` in a workout (most reps at that weight) → {kg, reps} | null. */
export function topSet(workout, exerciseId) {
  const sets = (workout?.exercises ?? []).filter((ex) => ex.exerciseId === exerciseId && ex.section === 'main')
    .flatMap((ex) => ex.sets ?? []).filter(isMeaningfulWorkingSet);
  if (!sets.length) return null;
  const best = sets.reduce((a, b) => (b.actualKg > a.actualKg || (b.actualKg === a.actualKg && b.actualReps > a.actualReps) ? b : a));
  return { kg: best.actualKg, reps: best.actualReps };
}

/** The most recent earlier non-skipped workout of the same program day. */
export function previousSameDay(workout, previousWorkouts) {
  return (previousWorkouts ?? [])
    .filter((w) => w && w.id !== workout.id && w.status === 'completed'
      && w.programId === workout.programId && w.dayOrder === workout.dayOrder
      && resolveCompletionState(w) !== EXPLICIT_SKIP_STATE)
    .sort((a, b) => toMillis(b.finishedAt) - toMillis(a.finishedAt))[0] ?? null;
}

/** The lift's plain name: from a working (non-ramp) entry, without " — Top Single / Backoff / Warm-up". */
const nameFor = (workout, exerciseId) => {
  const list = (workout.exercises ?? []).filter((e) => e.exerciseId === exerciseId);
  const ex = list.find((e) => e.section === 'main' && e.load?.type !== 'sets') ?? list.find((e) => e.load?.type !== 'sets') ?? list[0];
  return String(ex?.displayNameAtStart ?? exerciseId).replace(/ — (Top Single|Backoff|Warm-up)$/, '');
};

/**
 * @param {object} a
 * @param {object} a.workout           the workout just finished (in-memory copy; finishedAt may still be unset)
 * @param {Array}  a.previousWorkouts  earlier completed workouts (any order; may include this one — it is ignored)
 * @param {Date}   [a.now]
 * @param {number} [a.startedAtMs]     fallback start time when workout.startedAt isn't
 *                                     resolved yet (a workout started in this session
 *                                     still carries the pending server-time marker)
 */
export function summarizeWorkout({ workout, previousWorkouts = [], now = new Date(), startedAtMs = null }) {
  const sets = (workout.exercises ?? []).reduce((acc, ex) => {
    const p = exerciseProgress(ex);
    acc.done += p.done;
    acc.total += p.total;
    for (const s of ex.sets ?? []) {
      const st = resolveSetStatus(s);
      if (st === 'failed') acc.failed += 1;
      if (st === 'skipped') acc.skipped += 1;
    }
    return acc;
  }, { done: 0, total: 0, failed: 0, skipped: 0 });

  const startedMs = toMillis(workout.startedAt) || startedAtMs || 0;
  const durationSec = startedMs ? Math.max(0, Math.round((now.getTime() - startedMs) / 1000)) : null;
  const volumeKg = workoutVolume(workout);

  // PRs: the same engine as History, with this workout placed at "now".
  const others = (previousWorkouts ?? []).filter((w) => w?.id !== workout.id);
  let prs = [];
  try {
    const finished = { ...workout, status: 'completed', finishedAt: now };
    const { eventsByWorkoutId } = computeAllPrEvents([...others, finished]);
    prs = prEventsForWorkout(eventsByWorkoutId, workout.id).map((e) => ({
      exercise: nameFor(workout, e.exerciseId),
      label: prTypeLabel(e.type, e.repCount),
      text: e.type === PR_TYPE.ESTIMATED_1RM ? `${e.value} kg (from ${e.actualKg} kg × ${e.actualReps})` : `${e.actualKg} kg × ${e.actualReps}`,
    }));
  } catch (err) {
    console.warn('workoutSummary: PR check failed (summary still shown)', err);
  }

  let comparison = null;
  const prev = previousSameDay(workout, others);
  if (prev) {
    const main = mainExerciseOf(workout);
    const before = main ? topSet(prev, main.exerciseId) : null;
    const after = main ? topSet(workout, main.exerciseId) : null;
    const prevVolume = workoutVolume(prev);
    comparison = {
      previous: { finishedAt: prev.finishedAt ?? null, week: prev.week ?? null },
      mainSet: main && (before || after) ? {
        name: nameFor(workout, main.exerciseId), before, after,
        deltaKg: before && after ? Math.round((after.kg - before.kg) * 100) / 100 : null,
      } : null,
      volume: { before: prevVolume, after: volumeKg, delta: Math.round((volumeKg - prevVolume) * 10) / 10 },
    };
  }

  return { sets, durationSec, volumeKg, prs, comparison };
}
