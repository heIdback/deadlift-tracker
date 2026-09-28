// ─────────────────────────────────────────────────────────────────────────
// Pure decision logic for "Restore My Data (JSON)" (Phase 3F). No Firebase
// import at all — mirrors the project's established pure-logic/Firebase-
// boundary split (js/utils/programProgress.js, js/utils/starterProgram.js,
// js/utils/workoutSnapshot.js): this file only ever reasons about plain
// JS objects (the parsed backup file, and a plain "what already exists"
// snapshot the caller fetched), so the trickiest part of restore — exactly
// which documents get created/overwritten/deleted/skipped, and why — is
// directly unit-testable without a database, exactly like this project's
// existing pure utils.
//
// The actual Firestore reads (to build `existing`), the actual writes (to
// execute the plan this file returns), and the Firestore `Timestamp`
// conversion for the portable {_type:'timestamp',...} shape all live in
// js/services/restoreService.js — never here.
//
// ── WHY MAXES AND COMPLETED WORKOUTS ARE NOT FULLY "REPLACED" ────────────
// A true backup restore would make Firestore's restorable state match the
// backup exactly, including removing anything present now but absent from
// the backup. firestore.rules deliberately makes two collections
// append-only/immutable from the client:
//   - users/{uid}/maxes/{maxId}: `allow update, delete: if false;` — 1RM
//     history can never be rewritten once logged, by design (see that
//     rule's own comment).
//   - users/{uid}/workouts/{workoutId}: a COMPLETED workout can never be
//     updated or deleted (`allow delete: if ... status == 'in_progress'`)
//     — completed workout history is permanent, by design.
// Loosening either rule just to make restore "more complete" would weaken
// a real data-integrity guarantee the app was already built around, for a
// feature (restore) that exists to protect data, not to relax its
// protections. So this planner treats those two collections specially:
//   - maxes: ADD any backup entry not already present, by id. Never
//     deletes an existing entry. The profile's `currentMaxes` cache (a
//     plain, fully-owner-writable field) IS fully overwritten to match the
//     backup exactly, so the CURRENT values a restore is really meant to
//     recover always end up correct even though the underlying history
//     list is additive-only.
//   - workouts: an id not in the backup is deleted ONLY if it is currently
//     'in_progress' (rule-permitted); an existing 'completed' workout with
//     no matching backup id is left in place and reported as kept. A
//     backup workout is created if its id doesn't exist yet, updated if
//     the existing doc is still 'in_progress', or skipped (reported) if
//     the existing doc is already 'completed' (immutable).
// Every other restorable collection (programs+days, programRuns,
// measurements, records, progressionSuggestions, nutrition) has no such
// rule restriction for the owner, so those get a true replace: every
// existing id absent from the backup is deleted, every backup id is set.
// ─────────────────────────────────────────────────────────────────────────

export const SUPPORTED_BACKUP_SCHEMA_VERSION = 1;

/** Field whitelists — never spread a backup object's fields onto a write blindly; only ever write fields this app itself defines for that document shape (see each write site elsewhere in the app for the matching shape). */
const PROGRAM_FIELDS = ['schemaVersion', 'name', 'sourceFile', 'roundingRules', 'weeks', 'exerciseLibrary', 'importReviewFlags', 'createdAt', 'updatedAt'];
const PROGRAM_RUN_FIELDS = ['programId', 'startDate', 'current', 'status', 'overrides', 'activeWorkoutId', 'programCompleted', 'programCompletedAt'];
// Phase 4.1: 'completionState'/'lastEditedAt' added — both purely additive
// (an old backup simply won't have them; History/Progress already treat a
// missing completionState as "derive it live from exercises[]", see
// js/utils/workoutCompletion.js's resolveCompletionState), so restoring an
// old backup is unaffected and a NEW export/restore cycle now round-trips
// them instead of silently dropping them.
//
// Browser-test correction pass: 'explicitSkip'/'skipReason' added — the two
// fields skipWorkout (workoutService.js) stamps onto an intentionally
// Skipped workout. Also purely additive: an old backup won't have them
// (resolveCompletionState's fallback already treats their absence as "not
// an explicit skip" correctly), and omitting them from this whitelist would
// otherwise silently drop a genuine Skip record's distinguishing marker and
// reason on a restore round-trip.
const WORKOUT_FIELDS = ['schemaVersion', 'status', 'programId', 'programRunId', 'week', 'dayOrder', 'dayId', 'dayName', 'exercises', 'notes', 'startedAt', 'finishedAt', 'durationSec', 'completionState', 'lastEditedAt', 'explicitSkip', 'skipReason'];
const MEASUREMENT_FIELDS = ['type', 'value', 'unit', 'date', 'note'];
const MAX_FIELDS = ['exerciseId', 'kg', 'kind', 'effectiveDate', 'source'];
const PROFILE_FIELDS = ['settings', 'trainingProfile', 'currentMaxes', 'schemaVersion'];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

/**
 * File-level (structural) validation only — the "before writing anything…
 * reject clearly malformed/incompatible files" gate. Deliberately does NOT
 * deep-validate every nested document here; a bad INDIVIDUAL entry inside
 * an otherwise-valid file is caught later, per-collection, and skipped
 * (see planRestore below) rather than failing the whole file — this
 * function only decides "is this recognizably a Deadlift Tracker export at
 * all", never "is every single row inside it perfect".
 */
export function validateBackupShape(json) {
  const errors = [];
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { valid: false, errors: ['File is not a JSON object.'] };
  }
  if (json.schemaVersion !== SUPPORTED_BACKUP_SCHEMA_VERSION) {
    errors.push(`Unsupported backup schema version: ${JSON.stringify(json.schemaVersion)} (expected ${SUPPORTED_BACKUP_SCHEMA_VERSION}).`);
  }
  if (typeof json.exportedAt !== 'string') errors.push('Missing or invalid "exportedAt".');
  const arrayFields = ['programs', 'programRuns', 'workouts', 'maxHistory', 'measurements', 'records', 'progressionSuggestions', 'nutrition'];
  for (const f of arrayFields) {
    if (!Array.isArray(json[f])) errors.push(`Missing or invalid "${f}" (expected an array).`);
  }
  if (json.profile !== null && typeof json.profile !== 'object') {
    errors.push('Invalid "profile" (expected an object or null).');
  }
  return { valid: errors.length === 0, errors };
}

/** A short, human-readable summary for the Restore confirmation screen — counts only, no content. */
export function summarizeBackup(backup) {
  return {
    exportedAt: backup.exportedAt ?? null,
    programs: backup.programs?.length ?? 0,
    workouts: backup.workouts?.length ?? 0,
    maxHistory: backup.maxHistory?.length ?? 0,
    measurements: backup.measurements?.length ?? 0,
    programRuns: backup.programRuns?.length ?? 0,
  };
}

function planReplaceCollection({ backupEntries, existingIds, fields, validate, spreadWhole = false }) {
  const toSet = [];
  const skipped = [];
  const seen = new Set();
  for (const entry of backupEntries ?? []) {
    const reason = validate ? validate(entry) : null;
    if (reason) {
      skipped.push({ id: entry?.id ?? '(unknown)', reason });
      continue;
    }
    seen.add(entry.id);
    let data;
    if (spreadWhole) {
      // Firestore's client SDK rejects an explicit `undefined` field value
      // by default, so the wrapper `id` key must be actually removed
      // (destructured away), never merely set to undefined.
      const { id: _drop, ...rest } = entry;
      data = rest;
    } else {
      data = pick(entry, fields);
    }
    toSet.push({ id: entry.id, data });
  }
  const toDelete = [...(existingIds ?? [])].filter((id) => !seen.has(id));
  return { toSet, toDelete, skipped };
}

/** Programs + their days subcollection — one level deeper than the generic helper above, so it gets its own function. */
function planPrograms({ backupPrograms, existingProgramIds, existingDayIdsByProgram }) {
  const programs = { toSet: [], toDelete: [], skipped: [] };
  const days = { toSet: [], toDelete: [], skipped: [] };
  const seenProgramIds = new Set();

  for (const p of backupPrograms ?? []) {
    if (!p || typeof p.id !== 'string' || !Array.isArray(p.days)) {
      programs.skipped.push({ id: p?.id ?? '(unknown)', reason: 'Missing id or days array.' });
      continue;
    }
    seenProgramIds.add(p.id);
    programs.toSet.push({ id: p.id, data: pick(p, PROGRAM_FIELDS) });

    const seenDayIds = new Set();
    for (const d of p.days) {
      if (!d || typeof d.id !== 'string' || typeof d.order !== 'number') {
        days.skipped.push({ id: d?.id ?? '(unknown)', programId: p.id, reason: 'Missing id or order.' });
        continue;
      }
      seenDayIds.add(d.id);
      // Days are written as their whole exported shape (minus the
      // wrapper `id` key, which becomes the doc id — actually removed via
      // destructuring, not set to `undefined`, since Firestore's client SDK
      // rejects an explicit `undefined` field value) — matching exactly
      // how seedDeadliftProgramForUser (programService.js) already writes
      // days from the packaged JSON: `{ ...day }`, no field whitelist,
      // because a day's own nested `sections.main[]/accessory[]` structure
      // isn't a flat field list to whitelist against. It is still JSON
      // data, not executable content, and every reader of it
      // (workoutSnapshot.js's selectWeekPrescriptions) already defensively
      // handles missing/odd fields with optional chaining — see this
      // file's module comment.
      const { id: _dropDayId, ...dayRest } = d;
      days.toSet.push({ programId: p.id, id: d.id, data: dayRest });
    }
    const existingForThisProgram = existingDayIdsByProgram?.[p.id] ?? [];
    for (const existingDayId of existingForThisProgram) {
      if (!seenDayIds.has(existingDayId)) days.toDelete.push({ programId: p.id, id: existingDayId });
    }
  }

  for (const existingId of existingProgramIds ?? []) {
    if (!seenProgramIds.has(existingId)) {
      programs.toDelete.push(existingId);
      // Any day under a program that's being removed entirely is removed
      // with it — every existing day id for that program becomes a delete.
      for (const existingDayId of existingDayIdsByProgram?.[existingId] ?? []) {
        days.toDelete.push({ programId: existingId, id: existingDayId });
      }
    }
  }

  return { programs, days };
}

/** maxes: ADD missing entries only, never delete/update — see this file's module comment for why. */
function planMaxesAdditive({ backupMaxHistory, existingIds }) {
  const toCreate = [];
  const skipped = [];
  const existing = new Set(existingIds ?? []);
  for (const m of backupMaxHistory ?? []) {
    if (!m || typeof m.id !== 'string') { skipped.push({ id: m?.id ?? '(unknown)', reason: 'Missing id.' }); continue; }
    if (existing.has(m.id)) continue; // already present — additive only, never re-written
    if (typeof m.exerciseId !== 'string' || typeof m.kg !== 'number' || !(m.kg > 0 && m.kg <= 500)) {
      skipped.push({ id: m.id, reason: 'Invalid exercise or weight value (must be a lift name and a weight between 0–500 kg) — not added.' });
      continue;
    }
    toCreate.push({ id: m.id, data: pick(m, MAX_FIELDS) });
  }
  return { toCreate, skipped };
}

/** workouts: create if new, update only if the existing doc is still in_progress, otherwise skip (immutable) — see this file's module comment for why. */
function planWorkouts({ backupWorkouts, existingWorkouts }) {
  const toCreate = [];
  const toUpdate = [];
  const skipped = [];
  const existingById = new Map((existingWorkouts ?? []).map((w) => [w.id, w.status]));
  const seen = new Set();

  for (const w of backupWorkouts ?? []) {
    if (!w || typeof w.id !== 'string' || !['in_progress', 'completed'].includes(w.status)) {
      skipped.push({ id: w?.id ?? '(unknown)', reason: 'Missing id or invalid status.' });
      continue;
    }
    seen.add(w.id);
    const data = pick(w, WORKOUT_FIELDS);
    if (!existingById.has(w.id)) {
      toCreate.push({ id: w.id, data });
    } else if (existingById.get(w.id) === 'in_progress') {
      toUpdate.push({ id: w.id, data });
    } else {
      skipped.push({ id: w.id, reason: 'Already saved as a completed workout in your account — preserved as-is, not overwritten.' });
    }
  }

  // Only a currently in_progress workout absent from the backup may be
  // deleted (rule-permitted); a completed one absent from the backup is
  // kept and reported, never silently dropped from the summary.
  const toDelete = [];
  const kept = [];
  for (const [id, status] of existingById.entries()) {
    if (seen.has(id)) continue;
    if (status === 'in_progress') toDelete.push(id);
    else kept.push({ id, reason: 'A completed workout already in your account was not in this backup — preserved, not deleted.' });
  }

  return { toCreate, toUpdate, toDelete, skipped: [...skipped, ...kept] };
}

function planProfileUpdate(backupProfile) {
  if (!backupProfile || typeof backupProfile !== 'object') return null;
  return pick(backupProfile, PROFILE_FIELDS);
}

/**
 * Computes the full restore plan. `existing` is a plain snapshot of what
 * restoreService.js already found in Firestore for the CURRENT
 * authenticated user (never for any uid read from the backup — see
 * restoreService.js's own module comment for that invariant):
 *   {
 *     programIds: string[],
 *     dayIdsByProgram: Record<programId, string[]>,
 *     programRunIds: string[],
 *     maxIds: string[],
 *     workouts: Array<{id, status}>,
 *     measurementIds: string[],
 *     recordIds: string[],
 *     progressionSuggestionIds: string[],
 *     nutritionIds: string[],
 *   }
 */
export function planRestore({ backup, existing }) {
  const { programs, days } = planPrograms({
    backupPrograms: backup.programs,
    existingProgramIds: existing.programIds,
    existingDayIdsByProgram: existing.dayIdsByProgram,
  });

  const programRuns = planReplaceCollection({
    backupEntries: backup.programRuns,
    existingIds: existing.programRunIds,
    fields: PROGRAM_RUN_FIELDS,
    validate: (r) => (!r || typeof r.id !== 'string' || typeof r.programId !== 'string' ? 'Missing id or programId.' : null),
  });

  const maxes = planMaxesAdditive({ backupMaxHistory: backup.maxHistory, existingIds: existing.maxIds });
  const workouts = planWorkouts({ backupWorkouts: backup.workouts, existingWorkouts: existing.workouts });

  const measurements = planReplaceCollection({
    backupEntries: backup.measurements,
    existingIds: existing.measurementIds,
    fields: MEASUREMENT_FIELDS,
    validate: (m) => (!m || typeof m.id !== 'string' || typeof m.value !== 'number' || !(m.value >= 0 && m.value <= 500) ? 'Missing id or invalid value (0–500).' : null),
  });

  // records/progressionSuggestions/nutrition: nothing in the app writes to
  // these yet (see exportService.js's own comment), so there is no
  // established field shape to whitelist against — every backup entry is
  // written as its whole exported shape (minus the wrapper `id`), the same
  // "no shape to whitelist yet" treatment as program days above.
  const genericReplace = (entries, existingIds) => planReplaceCollection({
    backupEntries: entries,
    existingIds,
    validate: (e) => (!e || typeof e.id !== 'string' ? 'Missing id.' : null),
    spreadWhole: true,
  });
  const records = genericReplace(backup.records, existing.recordIds);
  const progressionSuggestions = genericReplace(backup.progressionSuggestions, existing.progressionSuggestionIds);
  const nutrition = genericReplace(backup.nutrition, existing.nutritionIds);

  const profileUpdate = planProfileUpdate(backup.profile);

  const warnings = [
    ...programs.skipped.map((s) => `Program ${s.id}: ${s.reason}`),
    ...days.skipped.map((s) => `Day ${s.id} (program ${s.programId}): ${s.reason}`),
    ...programRuns.skipped.map((s) => `Program run ${s.id}: ${s.reason}`),
    ...maxes.skipped.map((s) => `Max history entry ${s.id}: ${s.reason}`),
    ...workouts.skipped.map((s) => `Workout ${s.id}: ${s.reason}`),
    ...measurements.skipped.map((s) => `Measurement ${s.id}: ${s.reason}`),
    ...records.skipped.map((s) => `Record ${s.id}: ${s.reason}`),
    ...progressionSuggestions.skipped.map((s) => `Progression suggestion ${s.id}: ${s.reason}`),
    ...nutrition.skipped.map((s) => `Nutrition entry ${s.id}: ${s.reason}`),
  ];

  return { profileUpdate, programs, days, programRuns, maxes, workouts, measurements, records, progressionSuggestions, nutrition, warnings };
}

/**
 * Flattens a plan into one ordered list of Firestore operations, each
 * tagged with which collection it belongs to (restoreService.js maps this
 * onto real collection refs) — kept as a separate pure step so
 * restoreService.js's chunking logic never has to know the plan's
 * per-collection shape, only "a flat list of ops to batch".
 */
export function flattenPlanToOperations(plan) {
  const ops = [];
  const pushSet = (collection, items, extra = {}) => {
    for (const item of items) ops.push({ type: 'set', collection, id: item.id, data: item.data, ...extra, programId: item.programId ?? extra.programId });
  };
  const pushDelete = (collection, ids, extra = {}) => {
    for (const id of ids) ops.push({ type: 'delete', collection, id: typeof id === 'object' ? id.id : id, ...extra, programId: typeof id === 'object' ? id.programId : extra.programId });
  };

  pushSet('programs', plan.programs.toSet);
  pushDelete('programs', plan.programs.toDelete);
  pushSet('days', plan.days.toSet);
  pushDelete('days', plan.days.toDelete);
  pushSet('programRuns', plan.programRuns.toSet);
  pushDelete('programRuns', plan.programRuns.toDelete);
  pushSet('maxes', plan.maxes.toCreate);
  pushSet('workouts', plan.workouts.toCreate);
  for (const item of plan.workouts.toUpdate) ops.push({ type: 'update', collection: 'workouts', id: item.id, data: item.data });
  pushDelete('workouts', plan.workouts.toDelete);
  pushSet('measurements', plan.measurements.toSet);
  pushDelete('measurements', plan.measurements.toDelete);
  pushSet('records', plan.records.toSet);
  pushDelete('records', plan.records.toDelete);
  pushSet('progressionSuggestions', plan.progressionSuggestions.toSet);
  pushDelete('progressionSuggestions', plan.progressionSuggestions.toDelete);
  pushSet('nutrition', plan.nutrition.toSet);
  pushDelete('nutrition', plan.nutrition.toDelete);

  return ops;
}

/** Splits a flat operation list into batches no larger than `chunkSize` (Firestore's writeBatch hard limit is 500; the service calls this with a safety margin below that). */
export function chunkOperations(ops, chunkSize) {
  const chunks = [];
  for (let i = 0; i < ops.length; i += chunkSize) chunks.push(ops.slice(i, i + chunkSize));
  return chunks;
}
