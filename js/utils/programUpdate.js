// v30 — Program Import → "Update existing program". Pure planning (no
// Firebase, no DOM); the one write is services/programUpdateService.js.
//
// Importing a file normally ADDS a new program (and using it means Set
// Active → a new run from Week 1). Updating instead replaces the CONTENT of a
// program the lifter already has — its weeks and days — under the SAME
// program id, so its program run keeps going from where it is.
//
// Agreed rules:
//   - refused while any workout is in progress (finish or skip it first);
//   - refused when a run of this program (the active one, or one that
//     "Set Active" would resume later) sits on a position that doesn't exist
//     in the new file — the app never guesses where to continue;
//   - before anything changes, a copy of the old version is saved as a
//     separate, inactive program ("<name> (before update <date>)"), in the
//     same all-or-nothing write.
// Kept: the program's id and name, every run and its position, all workout
// history (each finished workout carries its own copy of its plan), 1RMs.
// Days are matched by their order (Day 1, Day 2, …) because a run remembers
// its position as {week, dayOrder}.
import { generateProgramId } from './programEditModel.js';

/** Program-doc fields an update takes from the file (the name is kept; see above). */
export const UPDATED_PROGRAM_FIELDS = ['schemaVersion', 'version', 'sourceFile', 'roundingRules', 'weeks', 'exerciseLibrary', 'importReviewFlags', 'importSource', 'notes', 'decisionRules', 'generatedBy', 'currentOneRepMaxesAtImport'];

/** Program-level settings a lifter can see or that shape the plan — a change here alone is a real update. */
const COMPARED_PROGRAM_FIELDS = [
  ['version', 'Version label'], ['notes', 'Program notes'], ['decisionRules', 'Decision rules'],
  ['roundingRules', 'Rounding'], ['exerciseLibrary', 'Exercise library'],
];

/** Fields that only describe the old file and must not survive into the new version when the file lacks them. */
const CLEARED_WHEN_ABSENT = ['version', 'notes', 'decisionRules', 'generatedBy', 'currentOneRepMaxesAtImport'];

const totalWeeksOf = (weeks) => (Array.isArray(weeks) && weeks.length ? Math.max(...weeks.map((w) => Number(w?.week) || 0)) : 0);

/**
 * Key-order-independent JSON, so "same content" doesn't depend on how a file or
 * Firestore orders fields. Empty (null/missing) fields and `_comment` keys are
 * ignored: the import normalizes the former and drops the latter, so neither
 * is a real change.
 */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] != null && !k.startsWith('_')).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const dayContent = (d) => {
  const { id, order, ...rest } = d ?? {};
  return stable(rest);
};

/** Is {week, dayOrder} a real position in a program with these days/weeks? */
export function isPositionInProgram(position, { days, weeks }) {
  if (!position) return false;
  const total = totalWeeksOf(weeks);
  return Number.isInteger(position.week) && position.week >= 1 && position.week <= total
    && (days ?? []).some((d) => d.order === position.dayOrder);
}

/**
 * What changes, day by day (matched by order) and in week count.
 * → { weeks: {from, to}, days: [{order, status: 'added'|'removed'|'changed'|'unchanged', from, to}], changedCount }
 */
export function diffProgram({ oldDays, oldWeeks, newDays, newWeeks, oldProgram = {}, newProgram = {} }) {
  const orders = [...new Set([...(oldDays ?? []), ...(newDays ?? [])].map((d) => d.order))].sort((a, b) => a - b);
  const days = orders.map((order) => {
    const before = (oldDays ?? []).find((d) => d.order === order);
    const after = (newDays ?? []).find((d) => d.order === order);
    let status = 'unchanged';
    if (!before) status = 'added';
    else if (!after) status = 'removed';
    else if (dayContent(before) !== dayContent(after)) status = 'changed';
    return { order, status, from: before?.name ?? null, to: after?.name ?? null };
  });
  const weeks = { from: totalWeeksOf(oldWeeks), to: totalWeeksOf(newWeeks) };
  const weeksChanged = stable(oldWeeks ?? []) !== stable(newWeeks ?? []);
  const programFields = COMPARED_PROGRAM_FIELDS
    .filter(([f]) => stable(oldProgram?.[f]) !== stable(newProgram?.[f]))
    .map(([, label]) => label);
  return {
    weeks: { ...weeks, changed: weeksChanged },
    days,
    programFields,
    changedCount: days.filter((d) => d.status !== 'unchanged').length + (weeksChanged ? 1 : 0) + programFields.length,
  };
}

const pad = (n) => String(n).padStart(2, '0');
export const backupNameFor = (name, now) => `${name} (before update ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())})`;

/**
 * @param {object} a
 * @param {object} a.targetProgram   {id, name, ...} the program being updated
 * @param {Array}  a.targetDays      its current days [{id, order, name, ...}]
 * @param {object} a.plan            validated import plan {program, days: [{id, data}]}
 * @param {Array}  a.runs            every programRun of the user
 * @param {boolean} a.hasInProgressWorkout
 * @param {Array<string>} a.existingProgramIds
 * @param {Date}   [a.now]
 * @returns {{ok:false, reason, message, details?} | {ok:true, diff, backup, programData, setDays, deleteDayIds, guardedRuns}}
 */
export function planProgramUpdate({
  targetProgram, targetDays, plan, runs, hasInProgressWorkout, existingProgramIds, now = new Date(),
}) {
  if (!targetProgram?.id) return { ok: false, reason: 'not_found', message: 'That program no longer exists.' };
  if (!plan?.program || !Array.isArray(plan.days) || !plan.days.length) {
    return { ok: false, reason: 'empty', message: 'Nothing to import.' };
  }
  if (hasInProgressWorkout) {
    return { ok: false, reason: 'in_progress_workout', message: 'A workout is in progress. Finish or skip it first, then update the program.' };
  }
  const newDays = plan.days.map((d) => ({ id: d.id, ...d.data }));
  const newWeeks = plan.program.weeks ?? [];

  // Every run of this program that is (or can become again) the place you train from.
  const guardedRuns = (runs ?? []).filter((r) => r.programId === targetProgram.id
    && (r.status === 'active' || r.status === 'switched-away')
    && r.programCompleted !== true);
  const lost = guardedRuns.filter((r) => !isPositionInProgram(r.current, { days: newDays, weeks: newWeeks }));
  if (lost.length) {
    const r = lost.find((x) => x.status === 'active') ?? lost[0];
    return {
      ok: false,
      reason: 'position_missing',
      message: `You are at Week ${r.current?.week} · Day ${r.current?.dayOrder} of this program${r.status === 'active' ? '' : ' (paused run)'}, `
        + `and that day doesn't exist in the new file (${totalWeeksOf(newWeeks)} weeks, days ${newDays.map((d) => d.order).sort((a, b) => a - b).join(', ')}). Nothing was changed.`,
      details: lost.map((x) => ({ runId: x.id, status: x.status, current: x.current })),
    };
  }

  const diff = diffProgram({
    oldDays: targetDays, oldWeeks: targetProgram.weeks, newDays, newWeeks, oldProgram: targetProgram, newProgram: plan.program,
  });
  if (diff.changedCount === 0) {
    return { ok: false, reason: 'no_changes', message: 'This file is the same as the program you already have — nothing to update.', diff };
  }

  const backupName = backupNameFor(targetProgram.name ?? targetProgram.id, now);
  const backupId = generateProgramId(`${targetProgram.id}-before-update`, existingProgramIds ?? []);
  // An exact copy of the old version (every field and day as stored), renamed;
  // only its own id/timestamps are new. Shallow copies: nothing here mutates them.
  const { id: _oldId, createdAt: _c, updatedAt: _u, ...oldFields } = targetProgram;
  const backup = {
    programId: backupId,
    program: { ...oldFields, name: backupName },
    days: (targetDays ?? []).map(({ id, ...data }) => ({ id, data })),
  };

  const programData = {};
  for (const f of UPDATED_PROGRAM_FIELDS) if (plan.program[f] !== undefined) programData[f] = plan.program[f];
  const clearFields = CLEARED_WHEN_ABSENT.filter((f) => plan.program[f] === undefined && targetProgram[f] !== undefined);

  const newIds = new Set(plan.days.map((d) => d.id));
  return {
    ok: true,
    diff,
    backup,
    programData,
    clearFields,
    setDays: plan.days.map((d) => ({ id: d.id, data: d.data })),
    deleteDayIds: (targetDays ?? []).map((d) => d.id).filter((id) => !newIds.has(id)),
    guardedRuns: guardedRuns.map((r) => ({ id: r.id, current: r.current, status: r.status })),
  };
}
