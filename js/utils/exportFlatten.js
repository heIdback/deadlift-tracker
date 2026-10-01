// ─────────────────────────────────────────────────────────────────────────
// Pure CSV row-flattening for the user data export (Phase 3D). Split out
// from services/exportService.js (which does the actual Firestore reads)
// specifically so this logic can be unit-tested in plain Node against a
// hand-built export object, with no Firebase import in the loop at all.
// ─────────────────────────────────────────────────────────────────────────

import { resolveSetStatus } from './setLogging.js';

/**
 * Flattens `export.workouts` into one row per logged SET (not one row per
 * workout), which is what's actually useful for spreadsheet analysis —
 * "how did my top set progress week over week" needs one row per set, not
 * a JSON blob in a cell. A workout with zero exercises/sets (e.g. an
 * abandoned in-progress session with nothing logged yet) contributes zero
 * rows, which is correct, not a bug — buildCsv still produces a valid
 * header-only CSV when `rows` ends up empty.
 */
export function flattenWorkoutsForCsv(exportData) {
  const rows = [];
  for (const w of exportData.workouts ?? []) {
    for (const ex of w.exercises ?? []) {
      for (const set of ex.sets ?? []) {
        rows.push({
          workoutId: w.id,
          status: w.status,
          startedAt: w.startedAt,
          finishedAt: w.finishedAt,
          programId: w.programId,
          week: w.week,
          dayOrder: w.dayOrder,
          dayName: w.dayName,
          exerciseId: ex.exerciseId,
          exerciseName: ex.name ?? ex.exerciseId,
          setId: set.setId,
          setNumber: set.setNumber,
          kind: set.kind,
          plannedKg: set.plannedKg,
          actualKg: set.actualKg,
          plannedReps: set.plannedReps,
          actualReps: set.actualReps,
          durationSec: set.durationSec,
          rpe: set.rpe,
          note: set.note,
          completed: set.completed,
          completedAt: set.completedAt,
          // v1.1: completed | modified | failed | skipped ('' = not logged),
          // resolved the same way History shows it (old sets included).
          setStatus: resolveSetStatus(set) ?? '',
        });
      }
    }
  }
  return rows;
}

export function flattenMeasurementsForCsv(exportData) {
  return (exportData.measurements ?? []).map((m) => ({
    id: m.id,
    type: m.type,
    value: m.value,
    unit: m.unit,
    date: m.date,
    note: m.note,
  }));
}

export function flattenMaxHistoryForCsv(exportData) {
  return (exportData.maxHistory ?? []).map((m) => ({
    id: m.id,
    exerciseId: m.exerciseId,
    kg: m.kg,
    kind: m.kind,
    source: m.source,
    effectiveDate: m.effectiveDate,
  }));
}
