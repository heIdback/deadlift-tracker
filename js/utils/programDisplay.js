// Phase 4 UI/presentation correction pass: pure, Firebase-free display
// formatting for Program Day Detail (extracted out of
// js/views/programDayEditor.js so the label logic that had a real bug is
// directly unit-testable, matching this codebase's usual pure-utils/
// Firebase-boundary split — see js/utils/programProgress.js and friends).
//
// Phase 4 warm-up correction pass: these functions now all take an already
// RESOLVED load (workoutSnapshot.js's resolvePrescription/
// buildResolvedExerciseList output) rather than a raw one. That is a
// deliberate architectural fix, not just a refactor: resolvePrescription is
// the ONE place that computes a load's basis exercise (`basisExerciseId`)
// and its resolved kg — the original percentage-basis-label bug existed
// because the view layer used to RE-DERIVE a basis id itself, separately,
// and got it wrong for a cosmetic sub-entry name. Now there is exactly one
// place a basis is ever computed, and everything here just formats what
// that place already produced — nothing here resolves a load against a
// 1RM itself (that stays resolveLoad/resolvePrescription) and nothing here
// touches Firestore.
import { REQUIRED_STARTER_LIFTS } from './requiredLifts.js';

/**
 * Human-readable name for a percentage/percent-range/warm-up basis exercise.
 *
 * ROOT CAUSE this fixes: the old version preferred the raw internal
 * `exerciseId` slug over the exercise's own display name whenever the id
 * wasn't one of the four canonical starter lifts — showing e.g. "No current
 * 1RM on file for leg-press-high-foot" instead of "...for Leg Press (High
 * Foot Placement)". Canonical starter lifts (Deadlift/Squat/RDL/Bench)
 * always resolve to their REQUIRED_STARTER_LIFTS label; anything else falls
 * back to that basis exercise's own human-readable display name, never the
 * slug.
 */
export function basisLabel(exerciseId, ownDisplayName) {
  const known = REQUIRED_STARTER_LIFTS.find((l) => l.id === exerciseId);
  if (known) return known.label;
  return ownDisplayName || exerciseId || 'this exercise';
}

/** 1 decimal place — matches the program's own stored percentage precision (e.g. 0.7317 -> 73.2) without rounding away a meaningful digit. */
export function formatPercent(fraction) {
  return Math.round((fraction ?? 0) * 1000) / 10;
}

export function formatReps(reps) {
  if (reps == null) return '—';
  if (typeof reps === 'number') return `${reps}`;
  if (typeof reps === 'object') return `${reps.min}–${reps.max}`;
  return '—';
}

/**
 * Plain-text (caller escapes for HTML) description of an already-RESOLVED
 * load, e.g. "90.2% of Deadlift 1RM" or "40 kg/hand". `load.basisExerciseId`
 * comes straight from resolvePrescription's own single, canonical basis
 * computation — this never re-derives or guesses one.
 */
export function describeResolvedLoad(load, ownDisplayName) {
  switch (load?.type) {
    case 'fixed': return `${load.kg ?? '—'} kg${load.perHand ? '/hand' : ''}`;
    case 'percent': return `${formatPercent(load.percent)}% of ${basisLabel(load.basisExerciseId, ownDisplayName)} 1RM`;
    case 'percentRange': return `${formatPercent(load.min)}–${formatPercent(load.max)}% of ${basisLabel(load.basisExerciseId, ownDisplayName)} 1RM`;
    case 'bodyweight': return 'Bodyweight';
    // Genuinely distinct from 'bodyweight': the schema simply prescribes no
    // load at all here (self-selected-weight machine/cable accessory work).
    // Never conflate the two, and never leave a bare "—" when a real,
    // accurate label exists (Small UI Quality Audit).
    case 'none': return 'No prescribed load (choose your own weight)';
    case 'sets': return ''; // rendered as the warm-up ramp list instead (see warmupStepsText)
    default: return '—';
  }
}

/**
 * The "≈ X kg at current Y 1RM Z kg" / "no current 1RM" line for a resolved
 * percent/percentRange load — purely from the fields resolvePrescription
 * already computed (basisExerciseId, basisMissing, basisOneRepMax,
 * displayTargetKg/displayRangeKg). No second resolveLoad call here.
 */
export function resolvedTargetLine(load, ownDisplayName) {
  if (load?.type !== 'percent' && load?.type !== 'percentRange') return '';
  const label = basisLabel(load.basisExerciseId, ownDisplayName);
  if (load.basisMissing) return `No current 1RM on file for ${label} yet — resolves once one is recorded.`;
  if (load.type === 'percent') return `≈ ${load.displayTargetKg} kg at current ${label} 1RM ${load.basisOneRepMax} kg`;
  return `≈ ${load.displayRangeKg[0]}–${load.displayRangeKg[1]} kg at current ${label} 1RM ${load.basisOneRepMax} kg`;
}

/**
 * Renders a resolved warm-up ramp (`load.type === 'sets'`, as produced by
 * workoutSnapshot.js's resolveWarmupRampLoad/resolvePrescription) as one
 * line per set — or, if the ramp's basis 1RM is missing, the same
 * human-readable "no current 1RM" wording used elsewhere. This is the
 * SAME resolved data a real Start Workout would snapshot — never a
 * separate preview-only calculation.
 */
export function warmupStepsText(load, ownDisplayName) {
  if (load?.type !== 'sets') return null;
  if (load.basisMissing) {
    return { missing: true, message: `No current 1RM on file for ${basisLabel(load.basisExerciseId, ownDisplayName)} yet — the warm-up resolves once one is recorded.` };
  }
  return {
    missing: false,
    steps: (load.sets ?? []).map((s) => ({ kg: s.kg ?? null, reps: s.reps ?? null })),
  };
}
