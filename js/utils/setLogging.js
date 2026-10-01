// ─────────────────────────────────────────────────────────────────────────
// v1.1 — Actual-set logging: per-set result status. Pure (no Firebase, no
// DOM), same split as workoutCompletion.js.
//
// DATA MODEL (additive — no migration, schemaVersion unchanged)
// Every workout set row (workoutSnapshot.js's makeSetRow) already stores
// the plan and the actual result side by side, and the plan is never
// overwritten:
//   plannedKg / plannedReps   — frozen at Start from the prescription
//   actualKg  / actualReps    — what was lifted (prefilled to the plan)
//   rpe, note, completed, completedAt
// v1.1 adds ONE optional field:
//   status: 'completed' | 'modified' | 'failed' | 'skipped' | null
//     completed — done as planned            (completed: true)
//     modified  — done, but weight/reps differ from the plan (completed: true)
//     failed    — attempted, planned target not achieved; actualKg/actualReps
//                 record what WAS achieved   (completed: true)
//     skipped   — deliberately not performed (completed: false)
//     null      — not logged yet             (completed: false)
//
// `completed` keeps its existing meaning — "this set was logged" — so
// workoutCompletion.js's complete/partial/not_logged classification and
// Home's counter keep working unchanged: a failed or modified set is logged
// work; a skipped set is not.
//
// PERFORMANCE ANALYTICS (Progress, PRs, e1RM — progressAnalytics.js's
// isMeaningfulWorkingSet): only completed and modified sets are eligible.
// Failed and skipped sets are kept as training records but never produce a
// performance/e1RM point, even with actual values entered.
//
// completed vs. modified is DERIVED from actual vs. planned whenever values
// change (never a separate thing the lifter has to remember to set).
// failed and skipped are explicit choices.
//
// BACKWARD COMPATIBILITY: a set written before v1.1 has no `status`.
// resolveSetStatus derives it: completed → 'completed' or 'modified'
// (from its own values); not completed → null (not logged). Old documents
// are never rewritten.
// ─────────────────────────────────────────────────────────────────────────

export const SET_STATUS = Object.freeze({
  COMPLETED: 'completed',
  MODIFIED: 'modified',
  FAILED: 'failed',
  SKIPPED: 'skipped',
});

const VALID_STATUSES = new Set(Object.values(SET_STATUS));

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 'modified' if the logged weight or reps differ from a concrete planned
 * value, else 'completed'. A planned value that isn't a single number (a
 * rep RANGE, a %-range with no single target, bodyweight, a timed hold) has
 * nothing to differ from, so it never makes a set "modified" by itself.
 */
export function deriveLoggedStatus(set) {
  if (!set) return SET_STATUS.COMPLETED;
  if (isNum(set.plannedKg) && isNum(set.actualKg) && set.actualKg !== set.plannedKg) return SET_STATUS.MODIFIED;
  if (isNum(set.plannedReps) && isNum(set.actualReps) && set.actualReps !== set.plannedReps) return SET_STATUS.MODIFIED;
  return SET_STATUS.COMPLETED;
}

/** The set's result status, for any set old or new. `null` = not logged. */
export function resolveSetStatus(set) {
  if (!set) return null;
  if (set.status === SET_STATUS.SKIPPED) return SET_STATUS.SKIPPED;
  if (set.completed !== true) return null;
  if (set.status === SET_STATUS.FAILED) return SET_STATUS.FAILED;
  return deriveLoggedStatus(set);
}

/**
 * Status part of the performance-analytics rule (Progress/PR/e1RM):
 * completed and modified sets only — failed and skipped never. Pre-v1.1
 * sets resolve through resolveSetStatus. (progressAnalytics.js's
 * isMeaningfulWorkingSet applies the same rule plus its kg/reps/warm-up
 * checks.)
 */
export function isAnalyticsEligibleSet(set) {
  const status = resolveSetStatus(set);
  return status === SET_STATUS.COMPLETED || status === SET_STATUS.MODIFIED;
}

/**
 * Pure set-row transitions for the logger / History edit mode. Each returns
 * a NEW set object; planned fields are never touched.
 *
 *   'toggleDone'    ✓ — not logged/skipped → logged (completed|modified);
 *                   logged (incl. failed) → not logged.
 *   'toggleFailed'  mark/unmark failed. Marking failed keeps the set logged.
 *                   If actual reps still equal the planned reps (i.e. the
 *                   lifter hasn't entered what they actually got), they are
 *                   CLEARED, so an untouched failed set can never be mistaken
 *                   for a successful rep count in analytics (a failed 1-rep
 *                   top single must not read as a tested 1RM). The lifter
 *                   types the reps they did achieve.
 *   'toggleSkipped' mark/unmark skipped (skipped is never "completed").
 */
export function applySetAction(set, action, now = Date.now()) {
  const next = { ...set };
  const status = resolveSetStatus(set);
  switch (action) {
    case 'toggleDone':
      if (status === SET_STATUS.COMPLETED || status === SET_STATUS.MODIFIED || status === SET_STATUS.FAILED) {
        next.completed = false;
        next.completedAt = null;
        next.status = null;
      } else {
        next.completed = true;
        next.completedAt = now;
        next.status = deriveLoggedStatus(next);
      }
      return next;
    case 'toggleFailed':
      if (status === SET_STATUS.FAILED) {
        next.status = deriveLoggedStatus(next);
        return next;
      }
      next.completed = true;
      next.completedAt = set.completed === true && set.completedAt ? set.completedAt : now;
      next.status = SET_STATUS.FAILED;
      if (isNum(next.plannedReps) && next.actualReps === next.plannedReps) next.actualReps = null;
      return next;
    case 'toggleSkipped':
      if (status === SET_STATUS.SKIPPED) {
        next.status = null;
        return next;
      }
      next.completed = false;
      next.completedAt = null;
      next.status = SET_STATUS.SKIPPED;
      return next;
    default:
      return next;
  }
}

/**
 * After the lifter edits actual weight/reps, keep a LOGGED set's
 * completed/modified status in step with its values. A failed or skipped
 * set keeps its explicit status; a not-yet-logged set stays not logged.
 */
export function refreshStatusAfterValueEdit(set) {
  const status = resolveSetStatus(set);
  if (status === SET_STATUS.COMPLETED || status === SET_STATUS.MODIFIED) {
    return { ...set, status: deriveLoggedStatus(set) };
  }
  return { ...set };
}

/** Short label/icon for display. */
export function setStatusLabel(status) {
  switch (status) {
    case SET_STATUS.COMPLETED: return { icon: '✓', text: 'Done' };
    case SET_STATUS.MODIFIED: return { icon: '⚠', text: 'Modified' };
    case SET_STATUS.FAILED: return { icon: '⚠', text: 'Failed' };
    case SET_STATUS.SKIPPED: return { icon: '⏭', text: 'Skipped' };
    default: return { icon: '—', text: 'Not logged' };
  }
}

function fmtKg(v) {
  return isNum(v) ? `${Math.round(v * 100) / 100}` : null;
}

/** "160 × 5", "160 kg", "× 8", "30s" … from a weight/reps pair, or '' if neither. */
export function formatWeightReps(kg, reps, { durationSec = null } = {}) {
  const k = fmtKg(kg);
  const r = isNum(reps) ? `${reps}` : null;
  if (k && r) return `${k} × ${r}`;
  if (k) return `${k} kg`;
  if (r) return `× ${r}`;
  if (isNum(durationSec)) return `${durationSec}s`;
  return '';
}

/** "Planned 160 × 5" line, only when the set was logged with values that differ from the plan (or failed). */
export function plannedDifferenceText(set) {
  const status = resolveSetStatus(set);
  if (status !== SET_STATUS.MODIFIED && status !== SET_STATUS.FAILED) return '';
  const planned = formatWeightReps(set.plannedKg, set.plannedReps);
  return planned ? `Planned ${planned}` : '';
}

// ── Completed-workout correction guard ───────────────────────────────────

/** The ONLY set fields a correction may change. Everything else on a set, and everything on an exercise other than its `sets` array, is plan/identity data. */
export const ACTUAL_SET_FIELDS = Object.freeze(['actualKg', 'actualReps', 'rpe', 'note', 'completed', 'completedAt', 'status']);

/** Key-order-independent JSON, so two copies of the same map compare equal regardless of property order. */
function stableStringify(v) {
  if (v === undefined || v === null) return 'null';
  // A Firestore Timestamp and its JSON copy ({seconds, nanoseconds}) — what
  // History's edit mode holds after deep-cloning — compare as equal.
  if (typeof v?.toMillis === 'function' && typeof v.seconds === 'number') {
    return stableStringify({ nanoseconds: v.nanoseconds, seconds: v.seconds });
  }
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function sameValue(a, b) {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Validates a proposed corrected `exercises` array against the stored one:
 * same exercises in the same order with identical plan/identity fields,
 * same sets with identical plan fields — only ACTUAL_SET_FIELDS may differ,
 * and their values must be sane. Firestore Rules can pin top-level fields
 * but cannot iterate an array, so this is the enforcement point for the
 * inside of `exercises` (see workoutService.updateCompletedWorkoutLog).
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function checkActualOnlyCorrection(originalExercises, nextExercises) {
  const errors = [];
  const orig = originalExercises ?? [];
  const next = nextExercises ?? [];
  if (!Array.isArray(next) || next.length !== orig.length) {
    return { ok: false, errors: ['The list of exercises cannot be changed when correcting a workout.'] };
  }
  next.forEach((ex, i) => {
    const o = orig[i];
    const keys = new Set([...Object.keys(o ?? {}), ...Object.keys(ex ?? {})]);
    for (const k of keys) {
      if (k === 'sets') continue;
      if (!sameValue(o?.[k], ex?.[k])) errors.push(`Exercise ${i + 1}: "${k}" is part of the plan and cannot be changed.`);
    }
    const oSets = o?.sets ?? [];
    const nSets = ex?.sets ?? [];
    if (nSets.length !== oSets.length) {
      errors.push(`Exercise ${i + 1}: sets cannot be added or removed when correcting a workout.`);
      return;
    }
    nSets.forEach((s, j) => {
      const os = oSets[j];
      const setKeys = new Set([...Object.keys(os ?? {}), ...Object.keys(s ?? {})]);
      for (const k of setKeys) {
        if (ACTUAL_SET_FIELDS.includes(k)) continue;
        if (!sameValue(os?.[k], s?.[k])) errors.push(`Exercise ${i + 1}, set ${j + 1}: "${k}" is part of the plan and cannot be changed.`);
      }
      // Sanity-check only values the correction actually changes, so a value
      // already stored during live logging never blocks an unrelated fix.
      const changed = (k) => !sameValue(os?.[k], s?.[k]);
      if (changed('actualKg') && s.actualKg != null && !(isNum(s.actualKg) && s.actualKg >= 0 && s.actualKg <= 1000)) errors.push(`Exercise ${i + 1}, set ${j + 1}: weight must be between 0 and 1000 kg.`);
      if (changed('actualReps') && s.actualReps != null && !(Number.isInteger(s.actualReps) && s.actualReps >= 0 && s.actualReps <= 200)) errors.push(`Exercise ${i + 1}, set ${j + 1}: reps must be a whole number between 0 and 200.`);
      if (changed('rpe') && s.rpe != null && !(isNum(s.rpe) && s.rpe >= 0 && s.rpe <= 10)) errors.push(`Exercise ${i + 1}, set ${j + 1}: RPE must be between 0 and 10.`);
      if (changed('note') && s.note != null && !(typeof s.note === 'string' && s.note.length <= 200)) errors.push(`Exercise ${i + 1}, set ${j + 1}: note must be text of at most 200 characters.`);
      if (changed('status') && s.status != null && !VALID_STATUSES.has(s.status)) errors.push(`Exercise ${i + 1}, set ${j + 1}: unknown set status.`);
      if (typeof s.completed !== 'boolean' && s.completed != null) errors.push(`Exercise ${i + 1}, set ${j + 1}: completed must be true or false.`);
      if (s.status === SET_STATUS.SKIPPED && s.completed === true) errors.push(`Exercise ${i + 1}, set ${j + 1}: a skipped set cannot also be completed.`);
    });
  });
  return { ok: errors.length === 0, errors };
}
