import { resolveLoad, roundToIncrement } from './calculations.js';

/**
 * Parses a "4x5" / "3x6-8" style string into {sets, reps}. Mirrors the
 * parser in scripts/generate_program.py so the two stay in sync; kept tiny
 * and dependency-free since it only needs to read the setsReps strings the
 * generator already produced.
 *
 * Exported (Phase 4 correction pass) so the Program Editor's week-percent-
 * range editing (js/utils/programEditModel.js — Bench Press/Back Squat's
 * `setsReps` week->string map) reads the EXACT SAME parser this file's own
 * display/snapshot code already uses, rather than a second parallel one.
 */
export function parseSetsReps(raw) {
  if (!raw) return { sets: null, reps: null };
  const s = String(raw).replace('×', 'x').trim();
  const m = /^(\d+)\s*x\s*([\d-]+)/i.exec(s);
  if (!m) return { sets: null, reps: null };
  const sets = Number(m[1]);
  const repField = m[2];
  if (repField.includes('-')) {
    const [lo, hi] = repField.split('-').map(Number);
    return { sets, reps: { min: lo, max: hi } };
  }
  return { sets, reps: Number(repField) };
}

/**
 * The exact inverse of parseSetsReps above (Phase 4 correction pass): turns
 * an edited {sets, reps} pair back into the "4x5"/"3x6-8" string format
 * `setsReps` already stores, so the Program Editor never needs a second,
 * incompatible representation for week-percent-range entries' sets/reps.
 * Round-trips through parseSetsReps unchanged for any value it can produce.
 */
export function formatSetsReps(sets, reps) {
  if (!sets || reps == null) return '';
  if (typeof reps === 'number') return `${sets}x${reps}`;
  return `${sets}x${reps.min}-${reps.max}`;
}

/**
 * Final UX polish pass — display-layer normalization of one specific,
 * documented legacy label. The imported program data (`data/
 * program.deadlift-8wk.json`, protected — not modified for this) carries
 * Day 3's accessory entries under the source spreadsheet's original
 * wording, "Deficit / Snatch-grip Deadlift" (cycle 1) and "Deficit /
 * Snatch Deadlift" (cycle 2) — both already confirmed (see
 * `data/import-mapping.json`'s own `deficit-sgdl-day3` note, and this
 * program's own per-entry `notes` field) to mean the SAME movement as the
 * block-driven Day 1 SGDL, which already displays cleanly as
 * "Snatch-Grip Deadlift" (see the `variant.sgdl` branch below). This
 * exists ONLY so a user browsing Program Day Detail, starting a NEW
 * workout, or looking at that new workout in History sees the same clean
 * "Snatch-Grip Deadlift" name Day 1's occurrence already uses, instead of
 * the confusing legacy "Deficit / ..." spreadsheet wording that reads as
 * if it were a different, Deficit-Deadlift movement.
 *
 * Deliberately narrow: matched by BOTH the exact known legacy string AND
 * `exerciseId === 'snatch-grip-deadlift'` — this can never rename any
 * other program entry, however similarly worded, and it never touches the
 * underlying JSON file or the `exerciseId` itself (only ever the display
 * string). It also cannot retroactively change any ALREADY-CREATED
 * workout's own `displayNameAtStart` — that field is written once, at
 * Start time, into an immutable snapshot document (see this file's own
 * module comment on snapshot immutability) and is never re-derived from
 * this function again; only a workout STARTED after this change picks up
 * the clean label. A historical workout logged before this change keeps
 * showing exactly what it always showed, which is correct — it is a
 * record of what actually happened, not a live view of the program.
 */
const LEGACY_SGDL_DISPLAY_NAMES = new Set(['Deficit / Snatch-grip Deadlift', 'Deficit / Snatch Deadlift']);
function normalizeLegacyDisplayName(exerciseId, displayName) {
  if (exerciseId === 'snatch-grip-deadlift' && LEGACY_SGDL_DISPLAY_NAMES.has(displayName)) {
    return 'Snatch-Grip Deadlift';
  }
  return displayName;
}

/**
 * Final production cleanup pass — display-layer suppression of internal
 * development/import-provenance text baked into a handful of `notes`
 * strings in `data/program.deadlift-8wk.json` (protected, not modified).
 * Two entries were found carrying this (see this pass's own report for the
 * full audit): Day 3's SGDL accessory ("... Snatch-Grip Deadlift — user
 * confirmed 2026-09-25 this source wording means SGDL, not a Deficit
 * Deadlift (see import-mapping.json:deficit-sgdl-day3). % calculated
 * against the standard Deadlift training 1RM (no separate SGDL max
 * exists).") and Day 4's Incline Bench Press ("... Day assignment
 * confirmed by user 2026-09-25 — see import-mapping.json:incline-bench-
 * day-assignment."). Neither belongs in front of an end user.
 *
 * Deliberately a short, explicit marker list rather than a broad keyword
 * blacklist: each marker below is text that only ever appears in an
 * internal development/import audit trail, never in a legitimate training
 * cue (technique, RPE, tempo, loading, safety/form, or programming
 * context), so a note that doesn't contain one of these is returned
 * completely unchanged — this can never accidentally swallow a real note
 * merely for containing an unrelated word. When a marker IS found, the
 * ENTIRE note is suppressed (not trimmed to a dangling fragment): the
 * known cases show this is always pure development bookkeeping tacked
 * onto (or replacing) any genuine trainee-facing content, so there is
 * nothing worth salvaging out of the same string once it's confirmed to
 * be internal provenance text.
 *
 * Same immutability guarantee as normalizeLegacyDisplayName above: this
 * only runs when a raw prescription entry is built (Program Day Detail
 * preview, or a NEW workout Start), never when re-reading an
 * already-created workout's own stored `notes` — a historical snapshot
 * that captured the old text before this fix keeps showing exactly what
 * it always showed.
 */
const INTERNAL_PROVENANCE_MARKERS = [
  /\buser confirmed\b/i,
  /\bconfirmed by user\b/i,
  /\bimport-mapping\.json\b/i,
  /\bsource wording\b/i,
  /\bsource of truth\b/i,
];
function suppressInternalProvenanceNote(notes) {
  if (typeof notes !== 'string' || !notes) return notes;
  const hasMarker = INTERNAL_PROVENANCE_MARKERS.some((re) => re.test(notes));
  return hasMarker ? null : notes;
}

/**
 * Expands one day's "main" + "accessory" sections into a flat, ordered list
 * of RAW (not-yet-1RM-resolved) prescription entries for a specific week.
 * Handles the three structural shapes the schema currently defines:
 *   - 'block-driven'       (a week's variant carries several sub-lifts:
 *                            top single / backoff / accessory-lift / warmup)
 *   - 'week-percent-range' (one lift, one %1RM-range variant per week, with
 *                            sets/reps looked up from a week->string map)
 *   - flat (no `structure` key — the item itself already has sets/reps/load
 *     and a `weeks` array saying which weeks it's active)
 * A future Program Editor that edits days/weeks in Firestore only needs to
 * keep producing one of these three shapes — nothing here is specific to
 * the current 8-week deadlift program's exercise names or values.
 *
 * @returns {Array<{exerciseId, displayName, sets, reps, durationSec, load, notes, section}>}
 */
export function selectWeekPrescriptions(day, week) {
  const entries = [];

  const pushFlatIfActive = (item, section) => {
    if (!Array.isArray(item.weeks) || !item.weeks.includes(week)) return;
    entries.push({
      exerciseId: item.exerciseId,
      displayName: normalizeLegacyDisplayName(item.exerciseId, item.displayName ?? item.exerciseId),
      sets: item.sets ?? null,
      reps: item.reps ?? null,
      durationSec: item.durationSec ?? null,
      load: item.load ?? { type: 'none' },
      notes: suppressInternalProvenanceNote(item.notes ?? null),
      // Phase 4: prescribed target RPE/RIR, additive optional fields on a
      // flat program-day exercise entry (see js/utils/programEditModel.js).
      // Absent on any day authored before Phase 4, in which case this is
      // simply null — same optional-passthrough convention `notes` already
      // used above. Distinct from a workout SET row's own `rpe` field
      // (workoutSnapshot.js's makeSetRow), which records what was actually
      // performed, entered during logging, not what was prescribed.
      rpe: item.rpe ?? null,
      rir: item.rir ?? null,
      section,
    });
  };

  for (const item of day?.sections?.main ?? []) {
    if (item.structure === 'block-driven') {
      const variant = (item.weeklyVariants ?? []).find((v) => v.week === week);
      if (!variant) continue;

      if (variant.topSingle?.load) {
        entries.push({
          exerciseId: item.exerciseId,
          displayName: `${item.displayName} — Top Single`,
          sets: variant.topSingle.sets ?? null,
          reps: variant.topSingle.reps ?? null,
          durationSec: null,
          load: variant.topSingle.load,
          // Defensive, matches pushFlatIfActive below — a no-op for every
          // entry in the current program data (neither topSingle nor
          // backoff notes currently carry any of the known internal-
          // provenance markers), kept here so this branch can't
          // independently regress the fix if a future program edit ever
          // puts development-note text on a block-driven variant.
          notes: suppressInternalProvenanceNote(variant.notes ?? null),
          section: 'main',
        });
      }
      if (variant.backoff?.sets) {
        entries.push({
          exerciseId: item.exerciseId,
          displayName: `${item.displayName} — Backoff`,
          sets: variant.backoff.sets,
          reps: variant.backoff.reps ?? null,
          durationSec: null,
          load: variant.backoff.load ?? { type: 'none' },
          notes: suppressInternalProvenanceNote(variant.backoff.note ?? null),
          section: 'main',
        });
      }
      if (variant.sgdl?.sets) {
        // Structural convention of 'block-driven': the `sgdl` sub-entry is
        // always the Snatch-Grip Deadlift accessory riding alongside the
        // day's main pull — not specific to this 8-week program.
        entries.push({
          exerciseId: 'snatch-grip-deadlift',
          displayName: 'Snatch-Grip Deadlift',
          sets: variant.sgdl.sets,
          reps: variant.sgdl.reps ?? null,
          durationSec: null,
          load: variant.sgdl.load ?? { type: 'none' },
          notes: null,
          section: 'main',
        });
      }
      if (variant.warmupSets?.length) {
        entries.push({
          exerciseId: item.exerciseId,
          displayName: `${item.displayName} — Warm-up`,
          sets: variant.warmupSets.length,
          reps: null,
          durationSec: null,
          load: {
            type: 'sets',
            sets: variant.warmupSets,
            // Phase 4 warm-up correction pass: schema-based tag identifying
            // this as a block-driven warm-up ramp anchored to THIS week's
            // imported Top Single weight — never a displayName check (see
            // resolvePrescription's 'sets' branch / resolveWarmupRampLoad
            // below, the single shared resolver both Program preview and
            // real Start Workout now go through). Absent (both null) for
            // any other, unrelated `type:'sets'` prescription, which then
            // resolves exactly as before — a static passthrough.
            dynamicAnchorKg: variant.topSingle?.sourceWeightKgAtImport ?? null,
            topSingleLoad: variant.topSingle?.load ?? null,
          },
          notes: null,
          section: 'warmup',
        });
      }
    } else if (item.structure === 'week-percent-range') {
      const variant = (item.weeklyVariants ?? []).find((v) => v.week === week);
      if (!variant) continue;
      const { sets, reps } = parseSetsReps(item.setsReps?.[String(week)]);
      entries.push({
        exerciseId: item.exerciseId,
        // Same narrow legacy-label normalization as pushFlatIfActive below
        // — a no-op for every entry in the current program data (no
        // week-percent-range item currently uses `exerciseId:
        // 'snatch-grip-deadlift'`), kept here defensively so this branch
        // can never independently regress this fix if a future program
        // edit ever moves this accessory into this structure.
        displayName: normalizeLegacyDisplayName(item.exerciseId, item.displayName),
        sets, reps,
        durationSec: null,
        load: variant.load ?? { type: 'none' },
        notes: null,
        section: 'main',
      });
    } else {
      pushFlatIfActive(item, 'main');
    }
  }

  for (const item of day?.sections?.accessory ?? []) {
    pushFlatIfActive(item, 'accessory');
  }

  return entries;
}

/**
 * THE SINGLE SHARED WARM-UP RESOLVER (Phase 4 warm-up correction pass) —
 * used by BOTH Program Day Detail's preview AND real new-workout snapshot
 * creation, because both go through resolvePrescription below, which calls
 * this for every `load.type === 'sets'` entry. There is no second, separate
 * warm-up formula anywhere in this codebase.
 *
 * ROOT CAUSE this fixes: `generateSetsForExercise`'s 'sets' branch (which
 * builds a real workout's loggable set rows) was, and structurally still
 * is, a dumb passthrough of whatever `load.sets[]` it's handed — it never
 * computed anything itself. The actual bug was one level up: nothing
 * upstream of it ever SCALED those steps, so a real Start Workout received
 * the day template's literal, frozen-at-import `warmupSets` kg values
 * completely unchanged — a Deadlift 1RM of 100 kg (Top Single 90 kg) could
 * still snapshot a warm-up ending at the legacy 185 kg. Fixing it here,
 * inside resolvePrescription — the one place both consumers already run
 * every raw entry through — means `generateSetsForExercise` needed NO
 * changes at all: by the time it sees `resolvedEx.load.sets`, those steps
 * are already correctly scaled (or, for a genuinely unrelated `type:'sets'`
 * prescription with no anchor tag, left exactly as before).
 *
 * IDENTIFICATION is schema-based, never a displayName check: this only
 * scales when the raw load carries `dynamicAnchorKg`/`topSingleLoad` — tags
 * `selectWeekPrescriptions`' block-driven branch sets ONLY on the warm-up
 * entry it builds from `variant.warmupSets`/`variant.topSingle`. Any other
 * `type:'sets'` prescription (none exist today, but nothing here assumes
 * that) simply won't carry those tags and passes through unchanged.
 *
 * SCALING: ratio = step.kg / dynamicAnchorKg (that week's own
 * `topSingle.sourceWeightKgAtImport` — the exact weight those static steps
 * were originally built around), applied against the Top Single as resolved
 * RIGHT NOW via the SAME resolveLoad + basis rule used for any other
 * percent load, then rounded with the SAME roundToIncrement rounding
 * everything else uses. Verified against the packaged program: every
 * week's LAST warm-up step already equals that week's own
 * sourceWeightKgAtImport exactly, so its ratio is always exactly 1.0 —
 * guaranteeing the final scaled step always lands exactly on the resolved
 * Top Single, whatever the current 1RM is (never the legacy weight, never
 * hard-coded to any particular week or number).
 *
 * SNAPSHOT SAFETY: this function is pure and only ever runs while
 * `resolvePrescription`/`buildResolvedExerciseList` build a BRAND NEW
 * exercise list — i.e. only when `startOrResumeWorkout` is creating a new
 * workout. An already-stored workout (in-progress or completed) is
 * returned untouched by `resolveActiveWorkout` before that code path is
 * ever reached (see workoutService.js), so this can structurally never
 * rewrite an existing snapshot's warm-up.
 *
 * @param {object} load - the raw entry's load object (from selectWeekPrescriptions)
 * @param {object} raw - the raw entry itself (for its own exerciseId, the default basis)
 * @param {Record<string,{kg:number}>} currentMaxes
 * @param {number} roundingIncrement
 */
function resolveWarmupRampLoad(load, raw, currentMaxes, roundingIncrement) {
  const steps = load.sets ?? [];
  const anchorKg = load.dynamicAnchorKg;
  const topSingleLoad = load.topSingleLoad;

  if (typeof anchorKg !== 'number' || anchorKg <= 0 || !topSingleLoad) {
    // Not a recognized dynamic ramp (or the schema data isn't present) —
    // exactly the pre-existing static passthrough, unchanged.
    return { type: 'sets', sets: steps };
  }

  const basisExerciseId = topSingleLoad.of || raw.exerciseId;
  const basisMax = currentMaxes[basisExerciseId];
  const basisOneRepMaxKg = typeof basisMax?.kg === 'number' ? basisMax.kg : null;
  const resolvedTopSingleKg = resolveLoad(topSingleLoad, basisOneRepMaxKg, roundingIncrement).displayTargetKg;

  if (resolvedTopSingleKg == null) {
    // No current 1RM on file for the basis lift — never fabricate a scaled
    // number; the caller shows the same "no current 1RM" wording used
    // elsewhere for a missing basis.
    return {
      type: 'sets',
      sets: steps.map((s) => ({ reps: typeof s.reps === 'number' ? s.reps : null, kg: null })),
      dynamicallyResolved: false,
      basisMissing: true,
      basisExerciseId,
    };
  }

  return {
    type: 'sets',
    sets: steps.map((s) => ({
      reps: typeof s.reps === 'number' ? s.reps : null,
      kg: typeof s.kg === 'number'
        ? roundToIncrement((s.kg / anchorKg) * resolvedTopSingleKg, roundingIncrement)
        : null,
    })),
    dynamicallyResolved: true,
    basisMissing: false,
    basisExerciseId,
  };
}

/**
 * Resolves ONE raw prescription entry's load against the lifter's current
 * 1RMs and rounding settings. Pure — no Firestore, no DOM.
 *
 * Basis rule (per program-design decision, not invented here): an explicit
 * `load.of` always wins; otherwise the exercise's own id is the basis. That
 * default is not a guess — every percent-based prescription in this program
 * already follows it (Bench Press's % is always of Bench Press's own 1RM),
 * so the exercise's own identity is data the program already provides, not
 * an invented one. If a basis exercise has no current 1RM on file, the
 * result carries `basisMissing: true` and no calculated kg — never a
 * fabricated number.
 *
 * @param {object} raw - one entry from selectWeekPrescriptions()
 * @param {{currentMaxes?: Record<string,{kg:number}>, rounding?: {barbell?:number, dumbbell?:number, machine?:number, bodyweight?:number}}} ctx
 */
export function resolvePrescription(raw, { currentMaxes = {}, rounding = {} } = {}) {
  const load = raw.load ?? { type: 'none' };
  const barbellIncrement = rounding.barbell ?? 2.5;
  let resolvedLoad;

  if (load.type === 'percent' || load.type === 'percentRange') {
    const basisExerciseId = load.of || raw.exerciseId;
    const basisMax = currentMaxes[basisExerciseId];
    const basisOneRepMaxKg = typeof basisMax?.kg === 'number' ? basisMax.kg : null;
    const resolved = resolveLoad(load, basisOneRepMaxKg, barbellIncrement);
    resolvedLoad = {
      ...resolved,
      basisExerciseId,
      basisMissing: basisOneRepMaxKg == null,
    };
  } else if (load.type === 'fixed') {
    // Already a specific prescribed number from the source (e.g. 40 kg/hand
    // dumbbell) — nothing to round further against a 1RM.
    resolvedLoad = { type: 'fixed', kg: load.kg ?? null, perHand: !!load.perHand };
  } else if (load.type === 'sets') {
    resolvedLoad = resolveWarmupRampLoad(load, raw, currentMaxes, barbellIncrement);
  } else if (load.type === 'bodyweight') {
    resolvedLoad = { type: 'bodyweight' };
  } else {
    resolvedLoad = { type: 'none' };
  }

  return {
    exerciseId: raw.exerciseId,
    displayNameAtStart: raw.displayName,
    section: raw.section,
    prescribed: {
      sets: raw.sets,
      reps: raw.reps,
      durationSec: raw.durationSec,
      // v1.1: the program's TARGET RPE (flat entries' `rpe`), carried into the
      // immutable snapshot as prescription metadata only — distinct from a
      // set row's own `rpe` (what was actually felt). Added only when the
      // program has one, so every snapshot without a target is unchanged.
      ...(typeof raw.rpe === 'number' && Number.isFinite(raw.rpe) ? { targetRpe: raw.rpe } : {}),
    },
    load: resolvedLoad,
    notes: raw.notes,
  };
}

/**
 * Convenience: select + resolve every prescription for a day/week in one
 * call, assigning a stable `order` and `entryId` to each. This is the
 * function the workout-start flow calls to build the snapshot's exercise
 * list; it stays pure so it can be unit-tested without Firestore.
 */
export function buildResolvedExerciseList(day, week, { currentMaxes = {}, rounding = {} } = {}) {
  return selectWeekPrescriptions(day, week).map((raw, index) => ({
    entryId: `${day.id}-w${week}-${index}-${raw.exerciseId}`,
    order: index,
    ...resolvePrescription(raw, { currentMaxes, rounding }),
  }));
}

/**
 * Picks the "actual kg" prefill for one generated set, from an already-
 * resolved load — never a fabrication, only what the load itself already
 * commits to. `percentRange` has no single target, so its `suggestedTargetKg`
 * (the midpoint default computed in calculations.js, itself documented as
 * "always editable before logging") is used rather than inventing one here.
 * `bodyweight`/`none`/`sets` loads are handled by their callers, not this
 * helper — a ramp's per-set kg comes from the set itself, and bodyweight has
 * no weight to prefill.
 */
function plannedKgForLoad(load) {
  switch (load?.type) {
    case 'percent': return load.displayTargetKg ?? null;
    case 'percentRange': return load.suggestedTargetKg ?? null;
    case 'fixed': return load.kg ?? null;
    default: return null;
  }
}

function makeSetRow({ entryId, setNumber, kind, plannedKg, plannedReps, durationSec }) {
  return {
    setId: `${entryId}-s${setNumber}`,
    setNumber,
    kind, // 'warmup' | 'working'
    plannedKg,
    // Prefilled to the planned target so a lifter can one-tap-confirm a set
    // rather than retype it — still freely editable before logging. A
    // missing plannedReps (true rep-range prescriptions) is NEVER defaulted
    // to a guessed number; the field stays blank until the lifter enters
    // what they actually did.
    actualKg: plannedKg,
    plannedReps,
    actualReps: plannedReps,
    durationSec,
    rpe: null,
    note: '',
    completed: false,
    completedAt: null,
  };
}

/**
 * Generates the loggable `sets[]` rows for one already-resolved exercise
 * entry (the shape `resolvePrescription`/`buildResolvedExerciseList`
 * produces, i.e. an item of a workout snapshot's `exercises[]`). Pure and
 * idempotent-safe to call again later (e.g. to self-heal a workout that was
 * started before this generator existed and still has an empty `sets: []`)
 * since it only reads the exercise's already-frozen prescription/load and
 * never touches anything outside the object it returns.
 *
 * Per-type handling (never fabricates a number the source didn't commit to):
 *   - load.type 'sets' (warm-up ramps): one row per ramp step, using that
 *     step's own kg/reps — NOT the exercise-level prescribed.sets/reps.
 *   - 'bodyweight': rows are generated (so the lifter can still log reps and
 *     mark sets complete) but plannedKg/actualKg stay null — never invents a
 *     bodyweight-in-kg number.
 *   - 'none' with a durationSec target (e.g. a hold/carry): rows are
 *     generated with no reps field; completion is the log, not a typed
 *     "actual duration" the spec doesn't ask for.
 *   - reps given as a {min,max} range: plannedReps/actualReps stay null on
 *     every row — a range is not a single performed rep count.
 *   - fixed per-hand loads: plannedKg/actualKg are the per-hand number
 *     as-is; the `perHand` label lives on the exercise's `load`, not
 *     duplicated onto every set row.
 */
export function generateSetsForExercise(resolvedEx) {
  const entryId = resolvedEx.entryId;
  const load = resolvedEx.load ?? { type: 'none' };
  const prescribed = resolvedEx.prescribed ?? {};

  if (load.type === 'sets') {
    return (load.sets ?? []).map((step, i) => makeSetRow({
      entryId,
      setNumber: i + 1,
      kind: 'warmup',
      plannedKg: typeof step.kg === 'number' ? step.kg : null,
      plannedReps: typeof step.reps === 'number' ? step.reps : null,
      durationSec: null,
    }));
  }

  const count = typeof prescribed.sets === 'number' ? prescribed.sets : 0;
  if (count <= 0) return [];

  const kind = resolvedEx.section === 'warmup' ? 'warmup' : 'working';
  const plannedKg = load.type === 'bodyweight' ? null : plannedKgForLoad(load);
  const plannedReps = typeof prescribed.reps === 'number' ? prescribed.reps : null;
  const durationSec = prescribed.durationSec ?? null;

  return Array.from({ length: count }, (_, i) => makeSetRow({
    entryId,
    setNumber: i + 1,
    kind,
    plannedKg,
    plannedReps,
    durationSec,
  }));
}
