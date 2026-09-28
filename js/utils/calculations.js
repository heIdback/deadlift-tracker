// ─────────────────────────────────────────────────────────────────────────
// Pure, framework-free calculation helpers. No Firebase imports here on
// purpose — these are unit-testable independent of the backend, and reused
// by any future exercise/program, not just the deadlift.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Round a weight to the nearest increment (e.g. 2.5 kg for barbells).
 * increment = 0 means "no rounding" (bodyweight exercises).
 */
export function roundToIncrement(value, increment) {
  if (!increment) return value;
  return Math.round(value / increment) * increment;
}

/**
 * Resolve a `load` spec (as stored in a program day) against a current 1RM,
 * returning both the raw (unrounded) and displayed (rounded) target.
 * Reusable for ANY exercise/program, not hardcoded to deadlift.
 *
 * @param {{type:string, percent?:number, min?:number, max?:number, kg?:number}} load
 * @param {number|null} oneRepMax - current 1RM for the referenced lift, if load.type is percent-based
 * @param {number} roundingIncrement
 */
export function resolveLoad(load, oneRepMax, roundingIncrement = 2.5) {
  switch (load?.type) {
    case 'percent': {
      const raw = oneRepMax != null ? oneRepMax * load.percent : null;
      return {
        type: 'percent',
        percent: load.percent,
        basisOneRepMax: oneRepMax,
        rawTargetKg: raw,
        displayTargetKg: raw != null ? roundToIncrement(raw, roundingIncrement) : null,
      };
    }
    case 'percentRange': {
      const rawMin = oneRepMax != null ? oneRepMax * load.min : null;
      const rawMax = oneRepMax != null ? oneRepMax * load.max : null;
      const rawMid = rawMin != null && rawMax != null ? (rawMin + rawMax) / 2 : null;
      return {
        type: 'percentRange',
        min: load.min,
        max: load.max,
        basisOneRepMax: oneRepMax,
        rawRangeKg: rawMin != null ? [rawMin, rawMax] : null,
        displayRangeKg: rawMin != null
          ? [roundToIncrement(rawMin, roundingIncrement), roundToIncrement(rawMax, roundingIncrement)]
          : null,
        // Default suggestion only — always editable before logging.
        suggestedTargetKg: rawMid != null ? roundToIncrement(rawMid, roundingIncrement) : null,
      };
    }
    case 'fixed':
      return {
        type: 'fixed',
        displayTargetKg: load.kg,
        perHand: !!load.perHand,
      };
    case 'sets':
      return { type: 'sets', sets: load.sets };
    case 'bodyweight':
      return { type: 'bodyweight' };
    default:
      return { type: 'none' };
  }
}

/**
 * Estimated 1RM using the Epley formula: 1RM = w * (1 + reps/30).
 * Documented, standard formula — kept separate from tested (actual) 1RM.
 */
export function epleyEstimate1RM(weightKg, reps) {
  if (reps <= 0) return weightKg;
  if (reps === 1) return weightKg; // a true single is itself, not an estimate
  return weightKg * (1 + reps / 30);
}

/** Total working volume for a set list. Excludes warm-up sets unless included explicitly. */
export function calculateVolume(sets, { includeWarmups = false } = {}) {
  return sets
    .filter((s) => includeWarmups || s.kind !== 'warmup')
    .reduce((total, s) => total + (s.kg || 0) * (s.reps || 0), 0);
}

/** Best set by estimated 1RM, used for PR detection. */
export function bestEstimated1RM(sets) {
  let best = null;
  for (const s of sets) {
    if (s.kind === 'warmup' || !s.kg || !s.reps) continue;
    const est = epleyEstimate1RM(s.kg, s.reps);
    if (!best || est > best.estimated1RM) {
      best = { estimated1RM: est, fromSet: s };
    }
  }
  return best;
}
