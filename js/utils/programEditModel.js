// ─────────────────────────────────────────────────────────────────────────
// Phase 4 — pure, Firebase-free logic for the Program Editor: draft
// mutation (add/remove/reorder/rename), validation, id generation, and the
// Duplicate Program plan. No Firestore import here on purpose, matching
// every other pure/service split in this codebase (programProgress.js,
// starterProgram.js, restorePlan.js) — this is what makes the editor's
// trickiest logic unit-testable without a database.
//
// SCHEMA NOTE (read this before changing validation/editing behavior):
// data/program.deadlift-8wk.json's exercise entries come in three shapes
// (see js/utils/workoutSnapshot.js's selectWeekPrescriptions, which already
// documents and flattens all three for display/logging):
//   - 'flat'               (no `structure` key) — sets/reps/load/weeks live
//     directly on the entry. 40 of the packaged program's 43 exercise
//     entries (all accessories + one day's main lifts) are this shape.
//     THIS is the shape the Program Editor can deeply edit field-by-field.
//   - 'week-percent-range' (Bench Press, Back Squat) — a `weeklyVariants`
//     array (one %1RM-range per week) plus a `setsReps` week->string map.
//   - 'block-driven'       (Deadlift only) — a `weeklyVariants` array where
//     each week carries THREE named sub-lifts (topSingle/backoff/sgdl) plus
//     its own warm-up ramp.
// The Editor deliberately does NOT expose deep per-week/per-sub-lift field
// editing for the latter two shapes in Phase 4 — reducing an 8-week,
// 3-sub-lift block program to one generic "sets/reps/load" form per entry
// would be exactly the kind of incompatible-parallel-field flattening the
// Phase 4 spec says not to do. What Phase 4 DOES support for those two
// shapes: rename (displayName), notes, reorder, and remove — all of which
// operate on the exercise-ENTRY level (the array element itself), not its
// internal per-week load data, so they're safe and meaningful regardless of
// shape. This is a deliberate, disclosed scope decision — see the Phase 4
// final report's "known limitations".
// ─────────────────────────────────────────────────────────────────────────

export const LOAD_TYPES = ['none', 'bodyweight', 'fixed', 'percent', 'percentRange'];

/**
 * v1.1: an explicit warm-up ramp on a FLAT entry — `load: {type:'sets',
 * sets:[{kg, reps}, …]}` (e.g. the Deadlift 210 program's weekly
 * "Deadlift — Warm-up" rows). The workout generator already supports it
 * (workoutSnapshot.js resolvePrescription → static ramp). It is not one of
 * the editor's selectable LOAD_TYPES: the Day editor shows it read-only and
 * always keeps it exactly as stored, never converting it to another type.
 */
export function isWarmupRampLoad(load) {
  return load?.type === 'sets';
}

/** How many weeks a program's own `weeks` metadata actually defines — never a hardcoded 8. */
export function totalWeeksOf(program) {
  const weeks = program?.weeks ?? [];
  return weeks.length ? Math.max(...weeks.map((w) => w.week)) : 0;
}

/** Which of the three schema shapes (see module comment) one exercise entry is. */
export function classifyEntryShape(entry) {
  if (entry?.structure === 'block-driven') return 'block-driven';
  if (entry?.structure === 'week-percent-range') return 'week-percent-range';
  return 'flat';
}

/** Only 'flat' entries support deep field-by-field editing in Phase 4 — see module comment. */
export function isDeeplyEditable(entry) {
  return classifyEntryShape(entry) === 'flat';
}

/** Every entry, regardless of shape, supports these entry-level edits. */
export function supportsEntryLevelEdit() {
  return true; // rename/notes/reorder/remove are always safe — see module comment
}

/** Turns a free-typed exercise name into a safe, lowercase, hyphenated id fragment. Never empty. */
export function slugify(name) {
  const base = String(name ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'exercise';
}

/** A slug guaranteed not to collide with any id already present in `existingIds`. */
export function uniqueId(name, existingIds) {
  const base = slugify(name);
  const taken = new Set(existingIds ?? []);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Builds a well-formed flat exercise entry (Part I — Add Exercise). */
export function createFlatEntry({
  exerciseId, displayName, sets, reps = null, durationSec = null,
  load = { type: 'none' }, notes = null, rpe = null, rir = null, weeks,
}) {
  return {
    exerciseId,
    displayName,
    sets,
    reps,
    durationSec,
    load,
    notes: notes || null,
    rpe: rpe ?? null,
    rir: rir ?? null,
    weeks: [...(weeks ?? [])].map(Number).sort((a, b) => a - b),
  };
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

/**
 * Validates one FLAT entry draft before it's saved (Part M). Errors are
 * plain English, never a stack trace or a raw schema-key name — a normal
 * gym user reads these directly.
 */
export function validateFlatEntry(entry, { totalWeeks = 8, knownBasisIds = null } = {}) {
  const errors = [];

  if (!entry.displayName || !String(entry.displayName).trim()) {
    errors.push('Exercise name is required.');
  }

  if (!isPositiveInt(entry.sets)) {
    errors.push('Sets must be a positive whole number.');
  }

  const reps = entry.reps;
  if (reps != null) {
    if (typeof reps === 'number') {
      if (!isPositiveInt(reps)) errors.push('Reps must be a positive whole number.');
    } else if (typeof reps === 'object' && reps !== null) {
      if (!isPositiveInt(reps.min) || !isPositiveInt(reps.max)) {
        errors.push('Rep range must use positive whole numbers.');
      } else if (reps.min > reps.max) {
        errors.push('Rep range minimum cannot be greater than its maximum.');
      }
    } else {
      errors.push('Reps value is not understood.');
    }
  }

  if (entry.durationSec != null && !(Number.isFinite(entry.durationSec) && entry.durationSec > 0)) {
    errors.push('Duration must be a positive number of seconds.');
  }

  const load = entry.load ?? { type: 'none' };
  if (isWarmupRampLoad(load)) {
    const steps = load.sets;
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 15) {
      errors.push('A warm-up ramp needs 1 to 15 steps.');
    } else if (steps.some((st) => !(st && typeof st.kg === 'number' && st.kg >= 0 && st.kg <= 500 && isPositiveInt(st.reps) && st.reps <= 50))) {
      errors.push('Each warm-up step needs a weight between 0 and 500 kg and 1–50 reps.');
    }
  } else if (!LOAD_TYPES.includes(load.type)) {
    errors.push('Unknown load type.');
  } else if (load.type === 'fixed') {
    if (!(typeof load.kg === 'number' && load.kg >= 0 && load.kg <= 500)) {
      errors.push('Fixed weight must be a number between 0 and 500 kg.');
    }
  } else if (load.type === 'percent') {
    if (!(typeof load.percent === 'number' && load.percent > 0 && load.percent <= 3)) {
      errors.push('Percentage must be a sensible positive value (up to 300%).');
    }
    if (load.of && knownBasisIds && !knownBasisIds.includes(load.of)) {
      errors.push('Unknown percentage basis.');
    }
  } else if (load.type === 'percentRange') {
    const minOk = typeof load.min === 'number' && load.min > 0 && load.min <= 3;
    const maxOk = typeof load.max === 'number' && load.max > 0 && load.max <= 3;
    if (!minOk || !maxOk) {
      errors.push('Percentage range must use sensible positive values (up to 300%).');
    } else if (load.min > load.max) {
      errors.push('Percentage range minimum cannot be greater than its maximum.');
    }
    if (load.of && knownBasisIds && !knownBasisIds.includes(load.of)) {
      errors.push('Unknown percentage basis.');
    }
  }

  if (entry.rpe != null && !(Number.isFinite(entry.rpe) && entry.rpe > 0 && entry.rpe <= 10)) {
    errors.push('RPE must be a number between 0 and 10.');
  }
  if (entry.rir != null && !(Number.isFinite(entry.rir) && entry.rir >= 0 && entry.rir <= 10)) {
    errors.push('RIR must be a number between 0 and 10.');
  }

  if (!Array.isArray(entry.weeks) || entry.weeks.length === 0) {
    errors.push('Select at least one week this exercise applies to.');
  } else if (entry.weeks.some((w) => !Number.isInteger(w) || w < 1 || w > totalWeeks)) {
    errors.push(`Weeks must be between 1 and ${totalWeeks}.`);
  }

  return { valid: errors.length === 0, errors };
}

/** Shared required-name check for both "Rename Day" and "Rename Program". */
export function validateRequiredName(name, label = 'Name') {
  const errors = [];
  if (!name || !String(name).trim()) errors.push(`${label} is required.`);
  return { valid: errors.length === 0, errors };
}

export function countTotalEntries(day) {
  return (day?.sections?.main?.length ?? 0) + (day?.sections?.accessory?.length ?? 0);
}

/**
 * Whole-day guard before a Save actually writes (Part M: "no empty day
 * after accidental destructive edits unless explicitly supported"). Phase 4
 * does not explicitly support an intentionally-empty day, so this simply
 * requires at least one exercise entry left across both sections.
 */
export function validateDayBeforeSave(day) {
  const errors = [];
  errors.push(...validateRequiredName(day?.name, 'Day name').errors);
  if (countTotalEntries(day) === 0) {
    errors.push('A day must have at least one exercise — add one before saving, or cancel your changes.');
  }
  return { valid: errors.length === 0, errors };
}

// ── Pure array-level draft edits (Parts I/J/K) ─────────────────────────────
// All of these return a NEW array; none mutate their input, so a view can
// freely keep a previous draft around for Cancel without it being clobbered.

export function moveEntry(list, fromIndex, toIndex) {
  const copy = [...(list ?? [])];
  if (fromIndex < 0 || fromIndex >= copy.length || toIndex < 0 || toIndex >= copy.length) return copy;
  const [item] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, item);
  return copy;
}

export function removeEntryAt(list, index) {
  return (list ?? []).filter((_, i) => i !== index);
}

export function replaceEntryAt(list, index, newEntry) {
  return (list ?? []).map((e, i) => (i === index ? newEntry : e));
}

export function appendEntry(list, newEntry) {
  return [...(list ?? []), newEntry];
}

// ── Duplicate Program (Part O) ─────────────────────────────────────────────

/** A program id guaranteed not to collide with any id in `existingIds`. */
// ── Complex-shape editing (Phase 4 correction pass) ────────────────────────
// Schema-aware editing for the 3 non-flat exercise entries (Deadlift's
// 'block-driven', Bench Press/Back Squat's 'week-percent-range' — see this
// file's top module comment for the full shape reference). These edit ONE
// WEEK's values at a time, in place, on the entry's EXISTING `weeklyVariants`
// (and, for week-percent-range, `setsReps`) structure — no parallel schema,
// no new top-level fields invented. A field that genuinely does not exist
// in the shape (e.g. a separate structured RPE on week-percent-range, which
// the packaged program never represents outside free text) is never
// fabricated here; see each function's own comment for exactly what is and
// isn't editable, and why.

/**
 * Reads week `week`'s current editable values out of a 'block-driven' entry
 * (Deadlift). Each sub-lift (topSingle/backoff/sgdl) is returned as `null`
 * if that week's variant doesn't define it at all (e.g. a deload week that
 * skips the accessory pull) — the caller shows "not prescribed this week"
 * rather than inventing zeros. RPE is not a separate field in this shape;
 * it lives inside the week-variant's own free-text `notes` (e.g.
 * "RPE 7-7.5"), which this returns as-is for editing — never split into a
 * fabricated numeric field the schema doesn't have.
 */
export function getBlockDrivenWeekValues(entry, week) {
  const variant = (entry.weeklyVariants ?? []).find((v) => v.week === week) ?? null;
  if (!variant) return null;
  const sub = (s) => (s ? { sets: s.sets ?? null, reps: s.reps ?? null, percent: s.load?.percent ?? null, of: s.load?.of ?? null } : null);
  return {
    topSingle: sub(variant.topSingle),
    backoff: variant.backoff ? { ...sub(variant.backoff), note: variant.backoff.note ?? null } : null,
    sgdl: sub(variant.sgdl),
    notes: variant.notes ?? null,
  };
}

/**
 * Pure: returns a NEW entry with ONLY week `week`'s variant patched from
 * `patch` (the shape getBlockDrivenWeekValues returns, edited) — every
 * other week's variant, and every other field on the entry (exerciseId,
 * displayName, structure, etc.), is untouched. A sub-lift that was `null`
 * in the original variant (not prescribed that week) is left exactly as it
 * was, even if `patch` carries stale values for it — never adds a sub-lift
 * that week's variant didn't already have.
 */
export function applyBlockDrivenWeekEdit(entry, week, patch) {
  const weeklyVariants = (entry.weeklyVariants ?? []).map((v) => {
    if (v.week !== week) return v;
    const patchSub = (original, p) => (original ? {
      ...original,
      sets: p.sets,
      reps: p.reps,
      load: { ...original.load, type: 'percent', percent: p.percent, ...(p.of ? { of: p.of } : {}) },
    } : original);
    return {
      ...v,
      topSingle: patchSub(v.topSingle, patch.topSingle ?? {}),
      backoff: v.backoff ? { ...patchSub(v.backoff, patch.backoff ?? {}), note: patch.backoff?.note ?? null } : v.backoff,
      sgdl: patchSub(v.sgdl, patch.sgdl ?? {}),
      notes: patch.notes ?? null,
    };
  });
  return { ...entry, weeklyVariants };
}

function validateSubLift(label, sub, errors) {
  if (!sub) return;
  if (!isPositiveInt(sub.sets)) errors.push(`${label} sets must be a positive whole number.`);
  if (sub.reps != null && !isPositiveInt(sub.reps)) errors.push(`${label} reps must be a positive whole number.`);
  if (!(typeof sub.percent === 'number' && sub.percent > 0 && sub.percent <= 3)) {
    errors.push(`${label} percentage must be a sensible positive value (up to 300%).`);
  }
}

/** Validates a block-driven week patch (only the sub-lifts actually present in it are checked). */
export function validateBlockDrivenWeekPatch(patch) {
  const errors = [];
  validateSubLift('Top Single', patch.topSingle, errors);
  validateSubLift('Backoff', patch.backoff, errors);
  validateSubLift('Snatch-Grip Deadlift', patch.sgdl, errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Reads week `week`'s current editable values out of a 'week-percent-range'
 * entry (Bench Press/Back Squat): sets/reps parsed from the existing
 * `setsReps` week->string map (via workoutSnapshot.js's own parseSetsReps —
 * the same parser Start Workout uses, never a second one) plus the week's
 * percent range. This shape has no RPE/RIR/notes field at all in the
 * packaged program — none is returned or made editable here; adding one
 * would be inventing a field the schema doesn't have.
 */
export function getWeekPercentRangeValues(entry, week, parseSetsReps) {
  const variant = (entry.weeklyVariants ?? []).find((v) => v.week === week) ?? null;
  if (!variant) return null;
  const { sets, reps } = parseSetsReps(entry.setsReps?.[String(week)]);
  return {
    sets, reps,
    min: variant.load?.min ?? null,
    max: variant.load?.max ?? null,
    of: variant.load?.of ?? null,
  };
}

/** Pure: patches ONLY week `week`'s percent range + setsReps string; every other week and field is untouched. */
export function applyWeekPercentRangeEdit(entry, week, patch, formatSetsReps) {
  const weeklyVariants = (entry.weeklyVariants ?? []).map((v) => (v.week !== week ? v : {
    ...v,
    load: { ...v.load, type: 'percentRange', min: patch.min, max: patch.max, ...(patch.of ? { of: patch.of } : {}) },
  }));
  const setsReps = { ...(entry.setsReps ?? {}) };
  setsReps[String(week)] = formatSetsReps(patch.sets, patch.reps);
  return { ...entry, weeklyVariants, setsReps };
}

export function validateWeekPercentRangePatch(patch) {
  const errors = [];
  if (!isPositiveInt(patch.sets)) errors.push('Sets must be a positive whole number.');
  if (patch.reps == null) {
    errors.push('Reps are required.');
  } else if (typeof patch.reps === 'number') {
    if (!isPositiveInt(patch.reps)) errors.push('Reps must be a positive whole number.');
  } else if (typeof patch.reps === 'object') {
    if (!isPositiveInt(patch.reps.min) || !isPositiveInt(patch.reps.max)) {
      errors.push('Rep range must use positive whole numbers.');
    } else if (patch.reps.min > patch.reps.max) {
      errors.push('Rep range minimum cannot be greater than its maximum.');
    }
  } else {
    errors.push('Reps value is not understood.');
  }
  const minOk = typeof patch.min === 'number' && patch.min > 0 && patch.min <= 3;
  const maxOk = typeof patch.max === 'number' && patch.max > 0 && patch.max <= 3;
  if (!minOk || !maxOk) {
    errors.push('Percentage range must use sensible positive values (up to 300%).');
  } else if (patch.min > patch.max) {
    errors.push('Percentage range minimum cannot be greater than its maximum.');
  }
  return { valid: errors.length === 0, errors };
}

/** A program id guaranteed not to collide with any id in `existingIds`. */
export function generateProgramId(baseName, existingIds) {
  const base = slugify(baseName) || 'program';
  const taken = new Set(existingIds ?? []);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Pure plan for "Duplicate Program": a full independent copy of the source
 * program's own fields plus every one of its days, under a NEW program id
 * and a user-given name. Deliberately never receives or touches
 * programRuns/workouts — duplication cannot copy what it never sees, which
 * is exactly the spec's "not copy workout history / not copy programRun
 * progress automatically" requirement enforced by construction rather than
 * by a flag. Day ids are reused as-is from the source: safe, since days
 * live in a subcollection scoped under the (new) program id, so the same
 * day-id string under two different programId parents never collides —
 * exactly how the packaged starter's own fixed day ids already work across
 * every different user.
 */
export function planDuplicateProgram({ sourceProgram, sourceDays, newProgramId, newName }) {
  if (!sourceProgram) throw new Error('Source program is required to duplicate.');
  if (!newProgramId) throw new Error('A new program id is required to duplicate.');
  if (!newName || !String(newName).trim()) throw new Error('A name is required to duplicate a program.');

  const program = {
    schemaVersion: sourceProgram.schemaVersion ?? 1,
    name: newName,
    sourceFile: sourceProgram.sourceFile ?? null,
    roundingRules: sourceProgram.roundingRules ?? null,
    weeks: JSON.parse(JSON.stringify(sourceProgram.weeks ?? [])),
    exerciseLibrary: JSON.parse(JSON.stringify(sourceProgram.exerciseLibrary ?? [])),
    // A fresh copy starts with no import-review backlog of its own — that
    // list described issues with the ORIGINAL spreadsheet import, not
    // anything about this new copy.
    importReviewFlags: [],
    // v1.1: an imported program's version label, notes and decision rules
    // are part of the program itself, so a copy keeps them (only when set).
    ...(sourceProgram.version ? { version: sourceProgram.version } : {}),
    ...(sourceProgram.notes ? { notes: sourceProgram.notes } : {}),
    ...(Array.isArray(sourceProgram.decisionRules) && sourceProgram.decisionRules.length
      ? { decisionRules: [...sourceProgram.decisionRules] } : {}),
  };

  const days = (sourceDays ?? []).map((d) => {
    const { id, ...rest } = d;
    return { id, data: JSON.parse(JSON.stringify(rest)) };
  });

  return { programId: newProgramId, program, days };
}
