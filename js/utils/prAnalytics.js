// Phase 5B, Package 1 — PR (Personal Record) detection + Baseline/PR domain
// model. Pure, Firebase-free derived analytics — same architectural split as
// progressAnalytics.js/workoutCompletion.js (see those files' own module
// comments): every function here takes already-fetched COMPLETED WORKOUT
// DOCUMENTS and derives everything from that immutable historical data.
// There is no import path here for a current program/template/current-1RM
// or the users/{uid}/maxes history, so this module is STRUCTURALLY INCAPABLE
// of reading — let alone writing — Current 1RM. Nothing in this file ever
// calls (or could call) recordOneRepMax/updateDoc/setDoc: it has no Firebase
// imports at all. Current 1RM stays 100% user-controlled via
// js/services/userService.js, completely untouched by this pass.
//
// REUSE, NOT DUPLICATION: the "which sets count as a meaningful completed
// working set" filter, the per-exercise set gatherer, and the "exclude
// explicitly Skipped workouts, sort oldest-first" helper are ALL the exact
// same functions progressAnalytics.js already uses for Top Weight/Estimated
// 1RM/Training Volume (isMeaningfulWorkingSet/workingSetsFor/chronological,
// now exported from that file for this reuse) — not reimplemented here.
// A Not Logged workout already has zero sets that pass this filter, so it
// naturally contributes nothing; a Skipped workout is already excluded by
// `chronological`; a Partial workout's sets that ARE completed still pass
// the filter normally — so partial/skipped/not_logged handling requires no
// special-case code in this file at all, only correct reuse.
//
// NO SECOND MUTABLE PR DATABASE: every PR/Baseline event below is derived
// fresh, on every call, from whatever `completedWorkouts` the caller passes
// in right now. Nothing is ever written back onto a workout/set document,
// and no separate Firestore collection is introduced. This means an edited
// completed workout (js/services/workoutService.js's
// updateCompletedWorkoutLog, gated by workoutCompletion.js's edit window)
// is reflected correctly the very next time History/Progress re-reads and
// re-calls this module — there is no stored PR flag that could go stale,
// because there is no stored PR flag at all.
import { epleyEstimate1RM } from './calculations.js';
import {
  chronological, workingSetsFor, isEstimated1RMEligible,
} from './progressAnalytics.js';

/**
 * The four PR categories from the spec. `REP` is parameterized by a
 * specific rep count (a "5-rep PR", an "8-rep PR", ...) — see
 * categoryKey() below; the other three are single, unparameterized
 * categories per exercise.
 */
export const PR_TYPE = {
  WEIGHT: 'weight',
  TESTED_1RM: 'tested_1rm',
  ESTIMATED_1RM: 'estimated_1rm',
  REP: 'rep',
};

function categoryKey(type, repCount) {
  return repCount != null ? `${type}:${repCount}` : type;
}

/**
 * Highest actualKg among the given sets (any rep count) — WEIGHT PR's own
 * definition, or (with a predicate) TESTED_1RM's / a specific REP count's.
 * Ties (two sets at the identical kg) keep the FIRST one encountered in the
 * workout's own stored set order, so the reported "contributing set" is
 * deterministic rather than array-sort-order-dependent.
 */
function bestByWeight(sets, predicate = () => true) {
  let best = null;
  for (const s of sets) {
    if (!predicate(s)) continue;
    if (!best || s.actualKg > best.actualKg) best = s;
  }
  return best ? { value: best.actualKg, actualKg: best.actualKg, actualReps: best.actualReps } : null;
}

/**
 * ESTIMATED_1RM's own definition: best Epley estimate among eligible sets.
 *
 * Eligibility (reps in [2, EST_1RM_MAX_REPS], deliberately EXCLUDING true
 * singles) is now the ONE shared `isEstimated1RMEligible` predicate,
 * imported from progressAnalytics.js — see that function's own doc
 * comment for the full rationale and the real-browser-acceptance bug it
 * was consolidated to fix (a prior duplicate of this same rep-range check
 * lived in progressAnalytics.js's `estimated1RMSeries` WITHOUT the lower
 * bound, so the Progress "Estimated 1RM" chart briefly disagreed with this
 * function/the "Best Estimated 1RM" summary, which already had the correct
 * bound here). Never reimplement the rep-range check separately again —
 * everything that means "is this set eligible for an Estimated 1RM number"
 * must go through that one predicate.
 *
 * Even though Epley is mathematically defined at reps===1 too
 * (calculations.js's epleyEstimate1RM already special-cases reps === 1 to
 * return the weight itself, "a true single is itself, not an estimate"),
 * excluding it here is deliberate: if a 1-rep set were eligible, its
 * "estimate" would be numerically identical to its own TESTED_1RM value,
 * and the exact same set could silently produce an "Estimated 1RM PR"
 * badge for a weight that was never estimated at all — it was actually
 * lifted. Folding reps===1 entirely into TESTED_1RM (never into
 * ESTIMATED_1RM or REP) makes that confusion structurally impossible
 * rather than relying on later UI wording to paper over it.
 */
function bestByEstimate(sets) {
  let best = null;
  for (const s of sets) {
    if (!isEstimated1RMEligible(s)) continue;
    const est = epleyEstimate1RM(s.actualKg, s.actualReps);
    if (!best || est > best.value) best = { value: est, actualKg: s.actualKg, actualReps: s.actualReps };
  }
  return best;
}

/**
 * One chronological pass over one exercise's completed-workout history,
 * producing an ORDERED list of Baseline/PR events (oldest first — same
 * order the underlying `chronological()` walk already produces).
 *
 * BASELINE VS PR (spec section 4, "My preference: first-ever performance
 * establishes a BASELINE; subsequent improvements are PRs" — implemented
 * here PER CATEGORY, not once per exercise overall): the first time ANY
 * category (WEIGHT / TESTED_1RM / ESTIMATED_1RM / a specific rep-count) has
 * a qualifying value at all, that is a 'baseline' event, not a 'pr' — there
 * is no valid prior history to compare against yet for that category
 * specifically. A later, strictly-higher value in the SAME category is a
 * 'pr' event. An equal or lower value produces no event at all. Scoping
 * Baseline per-category (rather than per-exercise) is a deliberate choice:
 * an exercise's first-ever completed set already baselines WEIGHT and
 * (if it's a single) TESTED_1RM, but its first-ever MULTI-rep set — which
 * might happen months later — still correctly baselines ESTIMATED_1RM at
 * that later point, rather than being misread as a "PR" against history
 * that was never actually there for that category. Likewise every distinct
 * rep count gets its own independent Baseline (a first-ever 8-rep set is a
 * Baseline for the 8-rep category, regardless of what 5-rep or 1-rep
 * history already exists).
 *
 * SAME-WORKOUT COLLAPSING (spec section 4's worked example: historical best
 * 180×1; a workout containing 185×1, 190×1, 190×1 must show ONE meaningful
 * PR event, 190×1, never three): this function evaluates each category
 * ONCE PER WORKOUT, using that workout's own best qualifying set for the
 * category (bestByWeight/bestByEstimate above already scan every set in the
 * workout for the category and return only the single best one) — never
 * once per individual set. A workout is compared only against the running
 * best established by STRICTLY EARLIER workouts (the runningBest map is
 * only updated AFTER a workout's events are computed), so a workout can
 * never be compared against itself, and multiple improving sets within one
 * session collapse into exactly one event per category.
 *
 * EXERCISE IDENTITY: grouped by `exerciseId` alone (workingSetsFor's own
 * contract — the same stable schema field progressAnalytics.js's own
 * per-exercise series already key on, never a displayName string match), so
 * Deadlift/Romanian Deadlift/Snatch-Grip Deadlift/Deficit Deadlift/Back
 * Squat etc. can never be accidentally combined even though their names
 * share words.
 */
/**
 * v1.1: a Tested 1RM is a SUCCESSFUL single. Failed sets are already
 * excluded from every analytic by progressAnalytics.js's
 * isMeaningfulWorkingSet (which feeds workingSetsFor below); this repeats
 * the rule at the one place that can offer "use as Current 1RM", so a
 * failed attempt can never become a stored 1RM even if that filter changes.
 */
function isSuccessfulSingle(s) {
  return s.actualReps === 1 && s.status !== 'failed';
}

export function computeExercisePrEvents(completedWorkouts, exerciseId) {
  const runningBest = new Map(); // categoryKey -> highest value seen so far
  const events = [];

  for (const workout of chronological(completedWorkouts)) {
    const sets = workingSetsFor(workout, exerciseId);
    if (!sets.length) continue;

    // Every distinct rep count present this workout, EXCLUDING 1 — reps===1
    // is handled entirely by TESTED_1RM (see bestByEstimate's own doc
    // comment above for the identical reasoning: a "1-rep PR" and a
    // "Tested 1RM PR" for the same set would be the same fact shown twice).
    const repCounts = [...new Set(
      sets.map((s) => s.actualReps).filter((r) => Number.isInteger(r) && r >= 2),
    )].sort((a, b) => a - b);

    const candidates = [
      { type: PR_TYPE.WEIGHT, repCount: null, result: bestByWeight(sets) },
      { type: PR_TYPE.TESTED_1RM, repCount: null, result: bestByWeight(sets, isSuccessfulSingle) },
      { type: PR_TYPE.ESTIMATED_1RM, repCount: null, result: bestByEstimate(sets) },
      ...repCounts.map((repCount) => ({
        type: PR_TYPE.REP,
        repCount,
        result: bestByWeight(sets, (s) => s.actualReps === repCount),
      })),
    ];

    for (const { type, repCount, result } of candidates) {
      if (!result) continue;
      const key = categoryKey(type, repCount);
      const prior = runningBest.get(key);
      if (prior === undefined) {
        events.push({
          exerciseId, type, repCount, kind: 'baseline', value: result.value,
          actualKg: result.actualKg, actualReps: result.actualReps,
          workoutId: workout.id, finishedAt: workout.finishedAt,
        });
        runningBest.set(key, result.value);
      } else if (result.value > prior) {
        events.push({
          exerciseId, type, repCount, kind: 'pr', value: result.value,
          actualKg: result.actualKg, actualReps: result.actualReps,
          workoutId: workout.id, finishedAt: workout.finishedAt,
        });
        runningBest.set(key, result.value);
      }
      // else: equal or lower — no event, running best unchanged.
    }
  }

  return events;
}

/**
 * Presentation-layer noise reduction (spec section 7, "do not clutter"):
 * when a WEIGHT event and a TESTED_1RM event in the SAME workout, for the
 * SAME exercise, are driven by the literal identical set (same actualKg AND
 * actualReps === 1), drop the WEIGHT one and keep only TESTED_1RM — a
 * single's raw weight and its "tested 1RM" are the same fact for that set,
 * and TESTED_1RM is the more specific, standard term lifters expect. This
 * is deliberately a POST-PROCESSING step over the engine's raw event list,
 * not baked into computeExercisePrEvents itself, so the underlying
 * per-category algorithm above stays simple, lossless, and independently
 * testable; only the final, UI-facing list is deduplicated.
 */
function dedupeWeightAgainstTested(events) {
  const testedKeys = new Set(
    events
      .filter((e) => e.type === PR_TYPE.TESTED_1RM)
      .map((e) => `${e.workoutId}|${e.exerciseId}|${e.actualKg}|${e.actualReps}`),
  );
  return events.filter((e) => {
    if (e.type !== PR_TYPE.WEIGHT) return true;
    return !testedKeys.has(`${e.workoutId}|${e.exerciseId}|${e.actualKg}|${e.actualReps}`);
  });
}

/**
 * The one entry point History/Progress call ONCE per screen mount (not once
 * per row/workout — same "compute once, look up per row" pattern
 * progressAnalytics.js's own per-exercise series already establish):
 * discovers every exerciseId that appears anywhere in `completedWorkouts`,
 * runs computeExercisePrEvents for each, dedupes, and indexes the result
 * both by workoutId (for History's badge/detail) and by exerciseId (for
 * Progress's "Recent PRs").
 */
export function computeAllPrEvents(completedWorkouts) {
  const exerciseIds = new Set();
  for (const w of completedWorkouts ?? []) {
    for (const ex of w.exercises ?? []) {
      if (ex?.exerciseId) exerciseIds.add(ex.exerciseId);
    }
  }

  let events = [];
  for (const exerciseId of exerciseIds) {
    events = events.concat(computeExercisePrEvents(completedWorkouts, exerciseId));
  }
  events = dedupeWeightAgainstTested(events);

  const eventsByWorkoutId = new Map();
  const eventsByExercise = new Map();
  for (const e of events) {
    if (!eventsByWorkoutId.has(e.workoutId)) eventsByWorkoutId.set(e.workoutId, []);
    eventsByWorkoutId.get(e.workoutId).push(e);
    if (!eventsByExercise.has(e.exerciseId)) eventsByExercise.set(e.exerciseId, []);
    eventsByExercise.get(e.exerciseId).push(e);
  }
  return { events, eventsByWorkoutId, eventsByExercise };
}

/** Count of genuine PR events (never Baseline events — a Baseline is not a PR, spec section 7's badge is only ever for "newly established PR(s)") for one workout, for History's compact list badge ("PR" / "2 PRs"). */
export function prCountForWorkout(eventsByWorkoutId, workoutId) {
  return (eventsByWorkoutId.get(workoutId) ?? []).filter((e) => e.kind === 'pr').length;
}

/** Just this workout's PR (not Baseline) events, in the order they were established, for History detail's per-workout breakdown. */
export function prEventsForWorkout(eventsByWorkoutId, workoutId) {
  return (eventsByWorkoutId.get(workoutId) ?? []).filter((e) => e.kind === 'pr');
}

/**
 * Phase 5B, Package 1 real-browser acceptance correction — the CURRENT
 * standing event for one category (e.g. "what is the most recent thing
 * that happened to Tested 1RM for this exercise"), including whether it
 * was a 'baseline' or a 'pr'. Because computeExercisePrEvents' running-best
 * only ever advances on a 'baseline' or 'pr' event, the LAST event of a
 * given category in an exercise's own event list always carries the exact
 * same `value` as bestTestedOneRepMax/bestEstimatedOneRepMax would compute
 * for that category — this just also tells the caller HOW that number was
 * established, which a raw max-scan cannot.
 *
 * This is what fixes the Progress suggestion bug: comparing "Best Tested >
 * Current 1RM" alone cannot distinguish a genuine PR from a first-ever
 * Baseline that simply happens to already exceed Current 1RM — this
 * function supplies the missing `kind` so the caller can word the message
 * correctly instead of unconditionally calling every such case a "PR".
 */
export function latestEventOfType(events, type, repCount = null) {
  const matches = (events ?? []).filter((e) => e.type === type && e.repCount === repCount);
  return matches.length ? matches.at(-1) : null;
}

/**
 * Most recent PR (not Baseline) events for one exercise, newest-first, for
 * Progress's "Recent PRs" list. `computeExercisePrEvents`/`computeAllPrEvents`
 * already produce events oldest-first (the same order `chronological()`
 * walks history in), so newest-first here is a plain reverse+slice — no
 * second sort/date comparison needed.
 */
export function recentPrEventsForExercise(eventsByExercise, exerciseId, count = 5) {
  const all = (eventsByExercise.get(exerciseId) ?? []).filter((e) => e.kind === 'pr');
  return all.slice(-count).reverse();
}

/**
 * All-time best TESTED 1RM for one exercise — the highest actualKg among
 * every meaningful reps===1 working set across all eligible history.
 * Independent of (and cross-checkable against) the incremental PR-event
 * running-best for the same category; implemented as its own plain max-scan
 * because Progress's "Best Tested 1RM" headline number needs only the
 * final answer, not the intermediate Baseline/PR event trail.
 */
export function bestTestedOneRepMax(completedWorkouts, exerciseId) {
  let best = null;
  for (const workout of chronological(completedWorkouts)) {
    for (const s of workingSetsFor(workout, exerciseId)) {
      if (isSuccessfulSingle(s) && (best == null || s.actualKg > best)) best = s.actualKg;
    }
  }
  return best;
}

/** All-time best ESTIMATED 1RM for one exercise — same shape as bestTestedOneRepMax above, but over the shared isEstimated1RMEligible rule (see bestByEstimate's doc comment for why this must never be reimplemented separately). */
export function bestEstimatedOneRepMax(completedWorkouts, exerciseId) {
  let best = null;
  for (const workout of chronological(completedWorkouts)) {
    for (const s of workingSetsFor(workout, exerciseId)) {
      if (!isEstimated1RMEligible(s)) continue;
      const est = epleyEstimate1RM(s.actualKg, s.actualReps);
      if (best == null || est > best) best = est;
    }
  }
  return best;
}

/** Pure text label for one PR category — no HTML, matches programDisplay.js's own plain-text-label convention (its basisLabel/describeResolvedLoad), so History/Progress each wrap this in their own markup rather than this analytics file knowing about HTML. */
export function prTypeLabel(type, repCount) {
  switch (type) {
    case PR_TYPE.WEIGHT: return 'Weight PR';
    case PR_TYPE.TESTED_1RM: return 'Tested 1RM PR';
    case PR_TYPE.ESTIMATED_1RM: return 'Estimated 1RM PR';
    case PR_TYPE.REP: return `${repCount}-rep PR`;
    default: return 'PR';
  }
}
