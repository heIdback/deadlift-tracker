// Phase 4.1 — Workout Completion State + Limited Post-Completion Editing.
// Pure, Firebase-free (same split as workoutSnapshot.js/progressAnalytics.js)
// so completion classification and edit-window eligibility are directly
// unit-testable and, just as importantly, cannot accidentally read a
// current program/template/1RM — there is no import path here for any of
// that.
//
// COMPLETION STATE — which sets count as "loggable":
// Every set row across every exercise (`ex.sets[]`) is "loggable" — this
// includes warm-up rows (`kind:'warmup'`), because the logger UI
// (js/views/workout.js's renderSetRow) puts a ✓ checkbox on every set row
// it renders, warm-up included, with no distinction. "Loggable" therefore
// means exactly "has a completed checkbox the user could tap", read
// straight from the schema (`s.completed`) — never inferred from an
// exercise's displayName, and never re-derived from a program/template.
// This is intentionally a DIFFERENT question from Progress's own "which
// sets count as a meaningful WORKING set for strength analytics" (see
// progressAnalytics.js's isMeaningfulWorkingSet, which excludes warm-ups —
// left completely unchanged by this file, per this pass's Goal F).
/** {total, completed} loggable-set counts across every exercise's own sets[] — the one place both classifyCompletionState and any future UI that wants "X of Y" reads from. */
export function countLoggableSets(exercises) {
  const allSets = (exercises ?? []).flatMap((ex) => ex.sets ?? []);
  return {
    total: allSets.length,
    completed: allSets.filter((s) => s?.completed === true).length,
  };
}

/**
 * Classifies a workout's own logged completion — purely from its stored
 * `exercises[].sets[].completed` values, nothing else:
 *   - 'complete':   every loggable set is completed (and at least one exists)
 *   - 'partial':    at least one, but not all, loggable sets are completed
 *   - 'not_logged': zero loggable sets are completed (also covers the
 *                   degenerate case of a workout with no loggable sets at
 *                   all) — the user manually pressed Finish without
 *                   checking anything off. This is ONLY ever the result of
 *                   the ordinary Finish action; it is never used for an
 *                   INTENTIONAL abort — see the 'skipped' state below and
 *                   this module's own header note on the two-concept split.
 *
 * NOTE — browser-test correction pass ("Explicit Skip Workout Flow"): the
 * very first Phase 4.1 pass used the string 'skipped' for exactly this
 * zero-completed-set case. Browser testing surfaced that a workout the user
 * manually finished having logged nothing ("Not Logged") is a materially
 * different fact from a workout the user explicitly, deliberately aborted
 * mid-session ("Skipped") — so this function no longer ever RETURNS the
 * string 'skipped' itself; that string is now reserved exclusively for the
 * new, separate explicit-skip action (js/services/workoutService.js's
 * skipWorkout), which stamps `completionState: 'skipped'` PLUS an explicit
 * `explicitSkip: true` marker directly, bypassing this classifier entirely
 * (skipWorkout never calls classifyCompletionState). See
 * resolveCompletionState below for how an OLD document that already has
 * `completionState: 'skipped'` from before this rename (written by the
 * first Phase 4.1 pass, always WITHOUT `explicitSkip: true`) is safely
 * reinterpreted as 'not_logged' rather than suddenly becoming an intentional
 * Skipped record — no bulk rewrite of those documents is ever performed.
 */
export function classifyCompletionState(exercises) {
  const { total, completed } = countLoggableSets(exercises);
  if (total === 0 || completed === 0) return 'not_logged';
  if (completed === total) return 'complete';
  return 'partial';
}

/** The one, single place the literal enum value for an intentional Skip is defined — cited by workoutService.js's skipWorkout and by history.js's badge/edit-eligibility logic, so no second copy of this string exists anywhere. */
export const EXPLICIT_SKIP_STATE = 'skipped';

/**
 * Backward-compatible read: prefers a workout document's own persisted
 * `completionState` (written by finishWorkout/updateCompletedWorkoutLog/
 * skipWorkout), and falls back to deriving it live from the stored sets for
 * any EXISTING completed workout that predates this field entirely (a
 * pre-Phase-4.1 document). Never bulk-migrates/rewrites old documents —
 * this is a read-time fallback only, called by History (list + detail) and
 * Progress's analytics filter, nowhere else needs it.
 *
 * The one extra wrinkle (browser-test correction pass): a document written
 * by the FIRST Phase 4.1 pass may already have `completionState: 'skipped'`
 * stored literally, under that pass's OLD meaning ("zero sets completed,
 * manually finished") — before 'skipped' was reserved for an intentional
 * abort. Such a document was written by ordinary `finishWorkout`, never by
 * `skipWorkout`, so it never carries `explicitSkip: true`. This resolver
 * treats that specific combination (`completionState === 'skipped'` AND NOT
 * `explicitSkip === true`) as the modern 'not_logged' state, so a workout a
 * user genuinely just forgot to log sets for never suddenly displays as an
 * intentionally Skipped record. A document written by the NEW skipWorkout
 * always has `explicitSkip: true` alongside `completionState: 'skipped'`,
 * so it resolves to the real 'skipped' state as intended.
 */
export function resolveCompletionState(workout) {
  const stored = workout?.completionState;
  if (stored != null) {
    if (stored === EXPLICIT_SKIP_STATE && workout?.explicitSkip !== true) {
      return 'not_logged';
    }
    return stored;
  }
  return classifyCompletionState(workout?.exercises);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** YYYY-MM-DD in the LOCAL calendar, for logging/debugging only — the eligibility check below compares local midnights directly rather than string keys, but this is handy for tests/diagnostics. */
export function localDateKey(value) {
  const d = toDate(value);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * A completed workout is editable on its own local calendar date AND the
 * entire following local calendar date — deliberately calendar-day based,
 * never "N hours after completion" (a workout finished at 11:59pm is
 * editable for nearly two more full days; one finished at 12:01am is
 * editable for barely more than one). Comparing local-midnight `Date`
 * objects (via the platform's own Date arithmetic, which already handles
 * month/year rollover correctly) is what makes this exact rather than an
 * approximation — no manual day-of-month/leap-year math here.
 *
 * `now` is an explicit parameter (defaulting to `new Date()`) purely so
 * this stays a pure, deterministic function for tests — every real caller
 * simply omits it.
 */
export function isEditableLocalWindow(finishedAt, now = new Date()) {
  const finished = toDate(finishedAt);
  if (!finished) return false;
  const finishedMidnight = new Date(finished.getFullYear(), finished.getMonth(), finished.getDate());
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((nowMidnight.getTime() - finishedMidnight.getTime()) / 86400000);
  return diffDays >= 0 && diffDays <= 1;
}

/**
 * A conservative, always-SUFFICIENT (never falsely narrower than the real
 * local-calendar rule above) server-side backstop duration, in
 * milliseconds — see firestore.rules and this pass's final report for the
 * full explanation of why an exact local-calendar boundary cannot be
 * expressed in Firestore Rules (rules have no concept of the client's
 * timezone) and why 72 hours is safely wider than the true worst-case
 * ~48-hour local-calendar window for any timezone offset. This is exported
 * so the rules comment and any future service-layer check can cite the
 * exact same number rather than a second hardcoded copy of it.
 */
export const RULES_BACKSTOP_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * The single, complete eligibility check for the completed-workout edit
 * flow — combines BOTH conditions that must hold, so `history.js` (the
 * "Edit Workout" button) and `workoutService.js`'s `updateCompletedWorkoutLog`
 * (the service-layer re-check immediately before writing) share exactly one
 * definition rather than two copies that could drift apart:
 *   1. still within the local-calendar edit window (isEditableLocalWindow)
 *   2. NOT an explicitly Skipped workout — a Skip is a deliberate terminal
 *      record (browser-test correction pass, Goal "Explicit Skip Workout
 *      Flow"); it never exposes the normal per-set logging-correction UI at
 *      all, regardless of how recently it happened.
 */
export function isEditableCompletedWorkout(workout, now = new Date()) {
  return resolveCompletionState(workout) !== EXPLICIT_SKIP_STATE
    && isEditableLocalWindow(workout?.finishedAt, now);
}
