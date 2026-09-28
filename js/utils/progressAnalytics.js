// Phase 4 — Progress dashboard analytics. Pure, Firebase-free (matches this
// codebase's usual pure-utils/Firebase-boundary split — see
// workoutSnapshot.js and programDisplay.js) so it is directly unit-testable
// and, more importantly, so it is STRUCTURALLY IMPOSSIBLE for it to read a
// current program template, a current 1RM, or an active program run: those
// concepts simply have no import path into this file. Every function here
// takes already-fetched COMPLETED WORKOUT DOCUMENTS (immutable snapshots —
// see workoutSnapshot.js's own docstrings) and, for bodyweight, already-
// fetched measurement records, and derives analytics purely from that
// historical data. A later template edit, a duplicated program, a renamed
// program, an active-program switch, or a changed current 1RM cannot change
// any number this file produces for a past workout, because none of that
// live state is ever read here.
//
// REUSE, NOT DUPLICATION: the actual math comes from the two existing pure
// primitives in calculations.js —
//   - epleyEstimate1RM(weightKg, reps): the project's one documented
//     estimated-1RM formula (Epley), already written for this purpose and
//     never wired up to a screen yet. Reused as-is; not reimplemented here.
//   - calculateVolume(sets, {includeWarmups}): already implements
//     "kg * reps summed, excluding kind==='warmup' by default" — the exact
//     warm-up exclusion rule this pass requires. Reused as-is.
// This file's own job is new: assembling a chronological, per-exercise
// historical series across MULTIPLE completed workouts and applying the
// "meaningful completed working set" filter documented below — there was no
// existing code doing that, so nothing is being duplicated by writing it.
import { epleyEstimate1RM, calculateVolume } from './calculations.js';
import { basisLabel } from './programDisplay.js';
import { resolveCompletionState, EXPLICIT_SKIP_STATE } from './workoutCompletion.js';

/**
 * Estimated-1RM safety rule (spec: "if no existing rule exists, use a
 * reasonable rep cap... document the chosen rule"): the Epley formula
 * degrades badly past moderate rep ranges (a 25-rep accessory set would
 * "estimate" an absurd 1RM). No existing cap was found anywhere in the
 * codebase, so Phase 4 introduced one: sets above 12 reps are excluded
 * from the ESTIMATED-1RM metric specifically (they still count fully
 * toward Top Weight and Training Volume, which have no such distortion).
 */
export const EST_1RM_MAX_REPS = 12;

/**
 * Phase 5B, Package 1 real-browser acceptance correction — THE ONE, SHARED
 * "is this set eligible for the ESTIMATED 1RM metric" rule, now reused by
 * every consumer of that metric: this file's own `estimated1RMSeries`
 * (the Progress "Estimated 1RM" chart) AND js/utils/prAnalytics.js's PR
 * engine (Estimated 1RM PR detection + the "Best Estimated 1RM" summary
 * number) both call this, rather than each carrying its own copy of the
 * rep-range check.
 *
 * ROOT CAUSE this fixes: `estimated1RMSeries` below originally filtered
 * only `s.actualReps <= EST_1RM_MAX_REPS` — no LOWER bound — so a true
 * single (`actualReps === 1`) passed straight through, and
 * `epleyEstimate1RM` itself special-cases reps===1 to return the weight
 * unchanged (calculations.js: "a true single is itself, not an
 * estimate"). The net effect was a workout containing only a 100 kg
 * single still producing a 100 kg "Estimated 1RM" chart point — silently
 * re-introducing exactly the Tested/Estimated conflation Phase 5B, Package
 * 1's domain model exists to prevent (prAnalytics.js's PR engine already
 * excluded singles correctly; the OLDER, Phase-4 chart series never had
 * this lower bound applied to it, since it predates that domain model
 * entirely). Real-browser acceptance testing caught this: after logging
 * 100×1, the Progress "Estimated 1RM" chart's newest point showed 100 kg
 * even though the "Best Estimated 1RM" summary card (which already went
 * through prAnalytics.js's correct rule) still correctly showed 66.7 kg.
 *
 * This predicate assumes the caller has ALREADY applied
 * `isMeaningfulWorkingSet` (completed/non-warmup/positive kg & reps) — it
 * only adds the further reps-range narrowing, so it is never a substitute
 * for that filter, only an additional one layered on top of it.
 */
export function isEstimated1RMEligible(s) {
  return s.actualReps >= 2 && s.actualReps <= EST_1RM_MAX_REPS;
}

// Phase 5C, Package 1: exported (was module-private) so
// js/utils/maxHistoryAnalytics.js's bodyweight-association helper reuses
// this EXACT date-coercion rule (Firestore Timestamp via `.toDate()`, a
// real `Date`, or anything else `new Date(...)` can parse, with a
// malformed/missing value coercing to `0` rather than throwing) instead of
// a second, potentially-drifting copy — same "one shared predicate" pattern
// this file already established for isMeaningfulWorkingSet/
// isEstimated1RMEligible.
export function toMillis(date) {
  if (!date) return 0;
  if (typeof date?.toDate === 'function') return date.toDate().getTime();
  if (date instanceof Date) return date.getTime();
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/** Sorts any array of records oldest-first by whichever timestamp field it carries — completed workouts use `finishedAt`, bodyweight measurements use `date` (js/services/measurementService.js's own field name) — never assumes one field name for both. */
function chronologicalBy(records, dateField) {
  return [...(records ?? [])].sort((a, b) => toMillis(a[dateField]) - toMillis(b[dateField]));
}

/**
 * Correction pass — "Explicit Skip Workout Flow": an explicitly Skipped
 * workout must contribute ZERO strength/volume/1RM data, EVEN IF one or
 * more of its snapshot's sets happen to have `completed: true` (e.g. the
 * user logged one set, then chose to abort the workout) — filtered out
 * here, in the ONE shared "chronological completed-workout list" builder
 * every metric in this file goes through (topWeightSeries/
 * estimated1RMSeries/volumeSeries via perWorkoutSeries, and
 * listAvailableExercises), so no caller can forget this check and no
 * per-metric filter needs its own duplicate of it. `resolveCompletionState`
 * already handles the legacy-document fallback, so a Skipped workout is
 * excluded correctly whether or not it happens to carry a stored
 * `completionState` field. Deliberately does NOT touch bodyweightSeries —
 * bodyweight measurements have no workout/completion-state concept at all.
 */
export function chronological(completedWorkouts) {
  const eligible = (completedWorkouts ?? []).filter((w) => resolveCompletionState(w) !== EXPLICIT_SKIP_STATE);
  return chronologicalBy(eligible, 'finishedAt');
}

/**
 * The one "is this set eligible for strength/volume analytics" predicate,
 * used consistently by every metric below (Top Weight, Estimated 1RM,
 * Training Volume all share this single definition, never three separate
 * ad hoc filters):
 *   - `completed === true`      -> excludes empty/uncompleted sets
 *   - `kind !== 'warmup'`       -> excludes warm-up ramps (workoutSnapshot.js
 *                                  tags every warm-up set row `kind:'warmup'`,
 *                                  a schema field, never a displayName guess
 *                                  — see generateSetsForExercise)
 *   - `actualKg` a positive number -> excludes bodyweight-only sets (whose
 *     actualKg is null by construction) and any set with a missing actual
 *     load
 *   - `actualReps` a positive number -> excludes duration-only holds/carries
 *     and any set logged without a rep count
 *
 * Phase 5B: exported (was module-private through Phase 5A) so
 * js/utils/prAnalytics.js's PR/Baseline engine reuses this EXACT same
 * predicate rather than defining a second, potentially-drifting copy of it.
 * No behavior change, and every existing Phase 4/4.1/5A caller in this file
 * is unaffected.
 */
export function isMeaningfulWorkingSet(s) {
  return !!s
    && s.completed === true
    && s.kind !== 'warmup'
    && typeof s.actualKg === 'number' && s.actualKg > 0
    && typeof s.actualReps === 'number' && s.actualReps > 0;
}

/** All meaningful working sets for one exerciseId within one workout document, gathered across every resolved exercise ENTRY that shares that exerciseId (e.g. Deadlift's "Top Single" and "Backoff" entries both carry exerciseId 'deadlift' — see workoutSnapshot.js's selectWeekPrescriptions). */
export function workingSetsFor(workout, exerciseId) {
  return (workout.exercises ?? [])
    .filter((ex) => ex.exerciseId === exerciseId)
    .flatMap((ex) => ex.sets ?? [])
    .filter(isMeaningfulWorkingSet);
}

/**
 * Every exerciseId with at least one meaningful working set anywhere in the
 * given completed workouts, paired with a human-readable label — never a
 * raw internal slug (reuses programDisplay.js's basisLabel, the same
 * canonical-starter-lift-aware naming Program Day Detail already
 * established, so "leg-press-high-foot" still shows as "Leg Press (High
 * Foot Placement)" here too). When an exerciseId appears under more than
 * one displayNameAtStart over time (rare), the most RECENT workout's name
 * wins, so a since-renamed accessory doesn't show a stale label.
 */
export function listAvailableExercises(completedWorkouts) {
  const labelById = new Map();
  for (const workout of chronological(completedWorkouts)) {
    for (const ex of workout.exercises ?? []) {
      if (!(ex.sets ?? []).some(isMeaningfulWorkingSet)) continue;
      // Chronological iteration means the last write below always comes
      // from the most recent workout, so the label self-updates if an
      // exercise's displayNameAtStart ever changes.
      labelById.set(ex.exerciseId, basisLabel(ex.exerciseId, ex.displayNameAtStart));
    }
  }
  return [...labelById.entries()]
    .map(([exerciseId, label]) => ({ exerciseId, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * One point per completed workout that has at least one meaningful working
 * set for `exerciseId`, in chronological order — workouts with none for
 * this exercise are simply skipped (never a fabricated zero).
 *
 * Phase 5C, Package 1: `reduceSets(sets)` may now return either a plain
 * number (every pre-existing caller written before this package) or a
 * `{value, ...meta}` object — normalized here into one point shape,
 * `{date, workoutId, value, ...meta}`. This is purely additive: a plain-
 * number return still produces exactly the same `{date, workoutId, value}`
 * point shape as before (with `workoutId` newly added, harmless to every
 * existing consumer that only ever destructured `.date`/`.value`), so no
 * existing series/test/PR-analytics behavior changes. `workoutId` and any
 * `meta` fields (sourceKg/sourceReps below) exist so tooltip rendering in
 * progress.js can show real underlying values rather than reverse-
 * engineering them from SVG pixel positions.
 */
function perWorkoutSeries(completedWorkouts, exerciseId, reduceSets) {
  const points = [];
  for (const workout of chronological(completedWorkouts)) {
    const sets = workingSetsFor(workout, exerciseId);
    if (!sets.length) continue;
    const result = reduceSets(sets);
    if (result == null) continue;
    const { value, ...meta } = typeof result === 'number' ? { value: result } : result;
    if (value == null) continue;
    points.push({ date: workout.finishedAt, workoutId: workout.id, value, ...meta });
  }
  return points;
}

/** TOP WEIGHT: highest actual completed external kg for the exercise, per workout. Distinct from Estimated 1RM — a heavy low-rep single and a lighter higher-rep set can trade places between the two metrics (see this file's module comment / the final report's worked example). Phase 5C: also reports the source set's own reps (`sourceReps`) alongside the weight (`sourceKg`, always equal to `value` here) so a tooltip can show "100 kg × 1" from the real logged set, not a guess. */
export function topWeightSeries(completedWorkouts, exerciseId) {
  return perWorkoutSeries(completedWorkouts, exerciseId, (sets) => {
    const best = sets.reduce((a, b) => (b.actualKg > a.actualKg ? b : a));
    return { value: best.actualKg, sourceKg: best.actualKg, sourceReps: best.actualReps };
  });
}

/** ESTIMATED 1RM: best Epley estimate among eligible (<= EST_1RM_MAX_REPS) meaningful working sets, per workout. A workout whose only sets for this exercise exceed the rep cap contributes no point that session, rather than a fake/inflated one. Phase 5C: also reports the exact set (`sourceKg`/`sourceReps`) the winning estimate was computed FROM, so a tooltip can show "from 50 kg × 10" using the real underlying set rather than back-solving the Epley formula from the plotted value. */
export function estimated1RMSeries(completedWorkouts, exerciseId) {
  return perWorkoutSeries(completedWorkouts, exerciseId, (sets) => {
    // Phase 5B, Package 1 real-browser acceptance correction: now filtered
    // through the ONE shared isEstimated1RMEligible predicate (see its own
    // doc comment above) instead of this file's own former inline
    // `s.actualReps <= EST_1RM_MAX_REPS` check, which had no lower bound
    // and let a true single's weight appear on this chart as if it were an
    // "estimate".
    const eligible = sets.filter(isEstimated1RMEligible);
    if (!eligible.length) return null;
    let best = null;
    for (const s of eligible) {
      const est = epleyEstimate1RM(s.actualKg, s.actualReps);
      if (!best || est > best.value) best = { value: est, sourceKg: s.actualKg, sourceReps: s.actualReps };
    }
    return best;
  });
}

/** TRAINING VOLUME: actualKg * actualReps summed over meaningful working sets for the exercise, per workout. Reuses calculations.js's own calculateVolume (warm-up exclusion + arithmetic) rather than re-summing by hand — the mapped {kg, reps, kind} shape is exactly what that function already expects. */
export function volumeSeries(completedWorkouts, exerciseId) {
  return perWorkoutSeries(completedWorkouts, exerciseId, (sets) => calculateVolume(
    sets.map((s) => ({ kg: s.actualKg, reps: s.actualReps, kind: s.kind })),
    { includeWarmups: false },
  ));
}

/** Single overall number for a metric's series (its most recent point) — "the current Top Weight/Estimated 1RM/Volume", for the dashboard's headline figure above the trend line. */
export function latestValue(series) {
  return series.length ? series.at(-1).value : null;
}

/** Bodyweight history, newest-first as stored, turned into a chronological {date, value} series — no interpolation, no inference from workouts: the caller passes exactly the stored measurement records (js/services/measurementService.js's listBodyweightHistory) and nothing else. */
export function bodyweightSeries(measurementRecords) {
  return chronologicalBy(measurementRecords ?? [], 'date').map((m) => ({ date: m.date, value: m.value }));
}

/**
 * Scales a value series into a compact SVG-friendly point list (0..width,
 * 0..height, y flipped so a higher value plots higher on screen) — pure
 * layout math, kept separate from progress.js's own SVG-string building so
 * the scaling logic (including the single-point and flat-series edge
 * cases) is independently unit-testable.
 */
export function buildSparklinePoints(series, { width = 280, height = 64, padding = 6, yMin, yMax } = {}) {
  if (!series.length) return [];
  const values = series.map((p) => p.value);
  // Phase 5C, Package 1: an explicit {yMin, yMax} (from computeYAxisTicks'
  // own nice-number range, below) lets the plotted line and the Y-axis
  // gridlines share IDENTICAL scale — without this, the line would use the
  // raw data min/max while the axis used a slightly wider "nice" range,
  // visually misaligning the two. Falls back to the raw data min/max when
  // omitted, so every pre-existing caller (none currently pass these) keeps
  // its exact prior behavior.
  const min = yMin ?? Math.min(...values);
  const max = yMax ?? Math.max(...values);
  const span = max - min;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  return series.map((p, i) => {
    const x = series.length === 1
      ? width / 2
      : padding + (i / (series.length - 1)) * innerW;
    // A perfectly flat series (span === 0, incl. the single-point case)
    // plots as a level midline rather than dividing by zero.
    const y = span === 0
      ? padding + innerH / 2
      : padding + innerH - ((p.value - min) / span) * innerH;
    // Phase 5C: carry every field the point already had (workoutId,
    // sourceKg, sourceReps, …) through to the plotted point — tooltip
    // rendering needs the REAL underlying values, never back-solved from
    // (x, y) pixel positions.
    return { ...p, x, y };
  });
}

/**
 * Phase 5C, Package 1, spec section 4 — a restrained (~3-5 label), "nice
 * number" Y-axis/reference scale for a chart, computed from the SERIES'S
 * OWN data (never forced to start at 0, which would destroy resolution for
 * a tightly-clustered series like bodyweight or Current-1RM-adjacent
 * weights — the spec's own explicit instruction). Uses the standard
 * "nice numbers for graph labels" algorithm (Talbot/Heckbert-style: snap
 * the raw step to 1/2/5x10^n) so ticks land on round, readable values
 * (e.g. 160/170/180/190/200) rather than the raw data's own arbitrary
 * min/max — this is what keeps the scale "visually honest and
 * understandable" per the spec, rather than an exaggerated pixel-tight
 * crop of the actual range.
 *
 * A perfectly flat series (or a single point) gets a small symmetric pad
 * around its one value instead of a zero-height axis (an all-equal series
 * still needs a scale to plot against).
 */
export function computeYAxisTicks(values, { targetCount = 4 } = {}) {
  const nums = (values ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return { min: 0, max: 1, ticks: [0, 1] };
  const dataMin = Math.min(...nums);
  const dataMax = Math.max(...nums);
  if (dataMin === dataMax) {
    const pad = dataMin === 0 ? 1 : Math.abs(dataMin) * 0.1;
    return niceRange(dataMin - pad, dataMax + pad, targetCount);
  }
  return niceRange(dataMin, dataMax, targetCount);
}

function niceNumber(range, round) {
  if (range <= 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * 10 ** exponent;
}

function niceRange(dataMin, dataMax, targetCount) {
  const range = niceNumber(dataMax - dataMin, false);
  const step = niceNumber(range / Math.max(1, targetCount - 1), true);
  const niceMin = Math.floor(dataMin / step) * step;
  const niceMax = Math.ceil(dataMax / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) {
    // Guards against floating-point step accumulation producing a value
    // like 179.99999999999997 instead of 180.
    ticks.push(Math.round((v + Number.EPSILON) * 1000) / 1000);
  }
  return { min: niceMin, max: niceMax, ticks };
}
