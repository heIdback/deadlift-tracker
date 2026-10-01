// History — originally the Phase 4 "Final History Integration / Set Active
// Regression Fix" correction pass; extended by Phase 4.1 ("Workout
// Completion State + Limited Post-Completion Editing") to add a
// completion-state warning badge and a narrow, time-boxed edit mode.
//
// ROOT CAUSE this fixes (Phase 4 original): this file was still the literal
// Phase 3 placeholder ("Your completed workouts will appear here once
// Phase 3 adds workout logging.") — completed-workout logging was built in
// Phase 3B/3C, but this screen was simply never implemented against it.
// Nothing deleted or hid a completed workout; Set Active
// (js/services/programSwitchService.js) never touches the `workouts`
// collection at all — it only reads/writes `programRuns`.
//
// QUERY SEMANTICS: uses workoutService.js's existing `listCompletedWorkouts`
// — `where('status','==','completed').orderBy('finishedAt','desc')`,
// scoped ONLY by the authenticated uid's own `users/{uid}/workouts`
// subcollection. There is no `where('programId', ...)` filter anywhere in
// that query, so a workout logged under an old/inactive/duplicated program
// is returned exactly the same as one logged under the currently active
// program. Reuses the EXACT SAME composite index already declared in
// firestore.indexes.json (status ASC, finishedAt DESC) — no new index.
//
// SNAPSHOT IMMUTABILITY (still absolute for the PLAN): every field rendered
// below for the read-only view (`ex.displayNameAtStart`, `plannedKg`,
// `plannedReps`, load/basis, exercise ordering) comes straight from the
// workout document AS STORED at start time — this file still calls no
// program/template/max-resolution code at all (contrast
// js/views/programDayEditor.js's PREVIEW, which intentionally re-resolves
// against the live template). A later template edit, a duplicated program,
// a changed current max, or a different active program can never change
// what a past workout's PLAN shows here.
//
// Phase 4.1 draws the line precisely at the PLAN vs. the ACTUAL PERFORMANCE
// LOG: the plan (plannedKg/plannedReps/load/basis/ordering/programId/week/
// dayId/startedAt/finishedAt) stays exactly as immutable as before — Edit
// Workout below can only ever change `actualKg`/`actualReps`/`completed`/
// `rpe`/`note` on EXISTING set rows, via workoutService.js's
// updateCompletedWorkoutLog, which is a single plain `updateDoc` on the SAME
// workout document (no new doc, no programRun write of any kind — see that
// function's own docstring for the full non-coupling argument) gated by
// js/utils/workoutCompletion.js's isEditableCompletedWorkout. This is a
// deliberately separate, page-owned edit mode — never a call into
// js/views/workout.js's in-progress logger/Start-Workout machinery, so
// editing a completed workout structurally cannot reopen program
// progression, resolve loads against current maxes, or create/duplicate a
// workout.
//
// Browser-test correction pass adds three more things to this same file:
// (1) an explicit "⏭ Skipped" badge/state, distinct from the "⚠ Not
// Logged" warning (js/utils/workoutCompletion.js's EXPLICIT_SKIP_STATE) —
// a Skipped workout never offers Edit Workout at all, regardless of the
// edit window; (2) Europe/Zagreb local Start/Finish/Duration timing display
// (js/utils/dates.js's formatZagreb*/durationSecondsBetween/
// formatHumanDuration — a display-only concern, no timestamp storage
// changed); (3) scroll-to-top after a successful Edit-mode Save or Cancel.
import { getCurrentUser } from '../core/auth.js';
import { listCompletedWorkouts, getWorkout, updateCompletedWorkoutLog } from '../services/workoutService.js';
import { getProgram } from '../services/programService.js';
import {
  resolveCompletionState, isEditableCompletedWorkout, classifyCompletionState, EXPLICIT_SKIP_STATE,
} from '../utils/workoutCompletion.js';
import {
  formatZagrebTime, formatZagrebDate, durationSecondsBetween, formatHumanDuration,
} from '../utils/dates.js';
import { computeWarmupFirstOrder, orderExercisesWarmupFirst } from '../utils/exerciseOrdering.js';
import { escapeHtml } from '../utils/dom.js';
import {
  SET_STATUS, resolveSetStatus, setStatusLabel, plannedDifferenceText, formatWeightReps,
} from '../utils/setLogging.js';
import { setBlockHtml, wireSetBlock, statusClasses } from '../components/setResult.js';
import { basisLabel } from '../utils/programDisplay.js';
// Phase 5B, Package 1 — PR (Personal Record) detection. Purely additive,
// read-only: computeAllPrEvents derives everything from the SAME completed-
// workout documents this file already fetches (listCompletedWorkouts) — no
// new Firestore collection, no new write path, and (per prAnalytics.js's own
// module comment) structurally no way for this import to touch Current 1RM.
// If this computation ever throws (a malformed/legacy document, say), every
// call site below is wrapped so History's normal read-only rendering is
// never blocked by it — a PR badge/line simply doesn't appear that time.
import {
  computeAllPrEvents, prCountForWorkout, prEventsForWorkout, prTypeLabel, PR_TYPE,
} from '../utils/prAnalytics.js';

// A full personal history, not just the dashboard's "latest" or admin's
// "recent 10" — but still one bounded, client-side-sorted read against the
// existing index, matching this codebase's established "pragmatic
// client-side aggregation is fine at expected personal-account dataset
// size" precedent (see programService.js's listProgramRuns docstring).
const HISTORY_LIST_LIMIT = 200;

function backToHistoryLink() {
  return `<a href="#/history" class="text-muted">&larr; Back to History</a>`;
}

/**
 * Phase 4.1 Goal B (extended by the browser-test correction pass): an
 * obvious-but-not-noisy badge for a workout that wasn't (fully) logged, or
 * that was deliberately aborted — never for a normal 'complete' workout,
 * never worded as "failed" (this describes LOGGING/completion only, never
 * training performance). `resolveCompletionState` (workoutCompletion.js)
 * already handles the legacy-document fallback — including safely
 * reinterpreting an OLD Phase-4.1-era zero-set document (which literally
 * stored `completionState: 'skipped'` under that field's original, since-
 * superseded meaning) as 'not_logged' rather than an intentional Skip — so
 * this function never needs to know or care whether `workout.completionState`
 * was actually stored, or which pass wrote it.
 *   - 'partial'    -> "⚠ Partial" (a warning — some logging is missing)
 *   - 'not_logged' -> "⚠ Not Logged" (a warning — nothing was logged)
 *   - 'skipped'    -> "⏭ Skipped" (NOT a warning — an intentional, deliberate
 *                     action; visually distinct from the two above via its
 *                     own `.badge-skip` class rather than `.badge-warning`)
 */
function completionBadgeHtml(workout) {
  const state = resolveCompletionState(workout);
  if (state === EXPLICIT_SKIP_STATE) return '<span class="badge-skip">⏭ Skipped</span>';
  if (state === 'partial') return '<span class="badge-warning">⚠ Partial</span>';
  if (state === 'not_logged') return '<span class="badge-warning">⚠ Not Logged</span>';
  return '';
}

/**
 * Phase 5B, Package 1 — compact PR badge (spec: "PR" / "2 PRs", never
 * cluttering every set row). Only ever counts `kind: 'pr'` events — a
 * Baseline is deliberately not a PR (see prAnalytics.js's own module
 * comment) and never earns this badge, so a lifter's very first-ever
 * logged set for an exercise doesn't show as a "PR" when there was no
 * prior history to actually beat.
 */
function prBadgeHtml(count) {
  if (!count) return '';
  return `<span class="badge-pr">${count === 1 ? 'PR' : `${count} PRs`}</span>`;
}

/** 1-decimal rounding for a derived (Estimated 1RM) value — same convention js/views/progress.js's own formatKg already uses, so a PR line and the Progress dashboard never show two different roundings of the same underlying number. Never applied to a WEIGHT/TESTED_1RM/REP event's value, which is always the literal actualKg the lifter entered, at whatever precision that already was. */
function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * One human-readable PR line for History detail, e.g.:
 *   "Deadlift — Tested 1RM PR: 210 kg"
 *   "Bench Press — 8-rep PR: 105 kg × 8"
 *   "Deadlift — Estimated 1RM PR: 209 kg (190 × 3)"
 * The exercise label is read from THIS workout's own `displayNameAtStart`
 * (the exact same field/label rule — programDisplay.js's basisLabel —
 * every other exercise name in this file already goes through), never a
 * second guess at naming. Tested vs Estimated is unambiguous in the text
 * itself (never color-only): an Estimated line always shows both the
 * rounded estimate AND the literal set it came from in parentheses, so a
 * reader can never mistake it for an actually-lifted single.
 */
function formatPrLineHtml(event, workout) {
  const ex = (workout.exercises ?? []).find((e) => e.exerciseId === event.exerciseId);
  const label = basisLabel(event.exerciseId, ex?.displayNameAtStart);
  const typeLabel = prTypeLabel(event.type, event.repCount);
  let valueText;
  if (event.type === PR_TYPE.ESTIMATED_1RM) {
    valueText = `${round1(event.value)} kg <span class="pr-estimated-tag">(from ${event.actualKg} kg × ${event.actualReps})</span>`;
  } else if (event.type === PR_TYPE.REP) {
    valueText = `${event.actualKg} kg × ${event.actualReps}`;
  } else {
    valueText = `${event.actualKg} kg`;
  }
  return `<li>${escapeHtml(label)} — <strong>${escapeHtml(typeLabel)}</strong>: ${valueText}</li>`;
}

function prDetailListHtml(events, workout) {
  if (!events.length) return '';
  return `<ul class="pr-detail-list">${events.map((e) => formatPrLineHtml(e, workout)).join('')}</ul>`;
}

/**
 * Recomputes just THIS workout's own PR events from `completedForPr` (the
 * full completed-workout history `mount()` fetched once for this detail
 * view — see its own comment). Recomputing from that array, rather than
 * caching a `prEvents` snapshot, is what satisfies spec section 6 (edited
 * completed workouts must be reflected, never a stale/frozen PR result):
 * every call to this function re-derives from whatever `completedForPr`
 * currently contains, and Save (below) patches that array's matching entry
 * in place before calling this again — so a fresh computation, not a
 * stored flag, is what the UI shows after an edit.
 *
 * Deliberately fails open: any error here is logged and swallowed rather
 * than propagated, so a PR-analytics problem (a malformed legacy document
 * elsewhere in the fetched history, say) can never block this read-only
 * workout detail from rendering at all.
 */
function prEventsForThisWorkout(completedForPr, workout) {
  if (!completedForPr || !workout) return [];
  try {
    const { eventsByWorkoutId } = computeAllPrEvents(completedForPr);
    return prEventsForWorkout(eventsByWorkoutId, workout.id);
  } catch (err) {
    console.error('history.js: PR analytics computation failed (non-fatal — detail still renders)', err);
    return [];
  }
}

/**
 * Correction pass — skip reason display. Only ever non-empty for a
 * genuinely 'skipped' workout with a non-blank `skipReason` (an empty
 * reason renders nothing extra, per spec: "If no reason was entered: show
 * only ⏭ Skipped"). `compact` renders inline text suited to sit right after
 * the badge on one line (History list, e.g. "⏭ Skipped — Lower back
 * sore"); the non-compact form is a standalone muted line for History
 * detail.
 */
function skipReasonHtml(workout, { compact }) {
  if (resolveCompletionState(workout) !== EXPLICIT_SKIP_STATE) return '';
  const reason = (workout.skipReason ?? '').trim();
  if (!reason) return '';
  // FINAL POLISH PASS: `compact`'s only caller is now the History list's
  // one-card-per-workout layout (renderList, below), where the skip reason
  // is its own short secondary line inside the card — no "Reason:" prefix
  // (the surrounding card context already makes that obvious) and no
  // leading em-dash (that was a fit for the old single-line-of-text list
  // row this pass replaces). The non-compact branch (History detail) is
  // completely unchanged.
  return compact
    ? `<div class="history-item-reason">${escapeHtml(reason)}</div>`
    : `<p class="text-muted">Reason: ${escapeHtml(reason)}</p>`;
}

/**
 * Correction pass (CORRECTION 3) — the workout timing line, in Europe/
 * Zagreb local time via Intl.DateTimeFormat (never a hardcoded "CET", which
 * would be wrong for half the year — see js/utils/dates.js). A Skipped
 * workout has no meaningful workout duration, so it gets its own distinct
 * "Skipped <date> · <time>" line instead of a misleading Start/Finish/
 * Duration one; a zero-set "Not Logged" workout IS still a real started/
 * finished session, so it renders the normal line like 'complete'/'partial'.
 * Duration is computed directly from the two canonical timestamps
 * (`durationSecondsBetween`), never from these formatted display strings.
 */
function timingLineHtml(workout, { compact }) {
  if (resolveCompletionState(workout) === EXPLICIT_SKIP_STATE) {
    // Same "Skipped <date> · <time>" line in both list and detail — there is
    // no meaningful workout duration for an intentionally aborted session,
    // so (unlike the branch below) compact/non-compact don't need to differ.
    return `Skipped ${formatZagrebDate(workout.finishedAt)} · ${formatZagrebTime(workout.finishedAt)}`;
  }
  if (workout.status !== 'completed') return 'In progress';
  const date = formatZagrebDate(workout.finishedAt);
  const start = formatZagrebTime(workout.startedAt);
  const finish = formatZagrebTime(workout.finishedAt);
  if (compact) {
    return start && finish ? `${date} · ${start}–${finish}` : date;
  }
  const duration = formatHumanDuration(durationSecondsBetween(workout.startedAt, workout.finishedAt));
  return start && finish
    ? `Started ${start} · Finished ${finish} · Duration ${duration}`
    : date;
}

/**
 * Read-only rendering of one logged set row — field names match
 * workoutSnapshot.js's makeSetRow exactly (setNumber/kind/plannedKg/
 * actualKg/plannedReps/actualReps/rpe/note/completed), plus v1.1's optional
 * `status` (js/utils/setLogging.js). Compact set-by-set display of what was
 * ACTUALLY done, with the plan shown only when it differs:
 *   1   160 × 5   ✓
 *   3   155 × 4   ⚠ Failed      Planned 160 × 5 · note
 *   4   150 × 5   ⚠ Modified    Planned 160 × 5
 *   5             ⏭ Skipped
 * Pre-v1.1 sets (no `status`) resolve through resolveSetStatus, so old
 * workouts render exactly as logged. Planned values are only ever READ.
 */
function renderReadOnlySetRow(s) {
  const label = s.kind === 'warmup' ? `W${s.setNumber}` : String(s.setNumber);
  const status = resolveSetStatus(s);
  const actual = status === SET_STATUS.SKIPPED
    ? ''
    : (formatWeightReps(s.actualKg, s.actualReps, { durationSec: s.durationSec }) || '—');
  const { icon, text } = setStatusLabel(status);
  const statusHtml = status === SET_STATUS.COMPLETED
    ? '✓'
    : (status ? `<span class="set-status-text">${escapeHtml(icon)} ${escapeHtml(text)}</span>` : '—');
  const extras = [
    plannedDifferenceText(s),
    typeof s.rpe === 'number' ? `RPE ${s.rpe}` : '',
    s.note ? s.note : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="history-set ${status ? statusClasses(status).join(' ') : 'is-not-logged'}">
      <span class="set-index">${escapeHtml(label)}</span>
      <span class="history-set-actual">${escapeHtml(actual)}</span>
      <span class="history-set-status">${statusHtml}</span>
      ${extras ? `<span class="history-set-extra text-muted">${escapeHtml(extras)}</span>` : ''}
    </div>`;
}

function renderWorkoutDetail(root, uid, workout, completedForPr = null) {
  const prEvents = prEventsForThisWorkout(completedForPr, workout);
  if (!workout) {
    root.innerHTML = `
      <section class="history-view">
        ${backToHistoryLink()}
        <p class="empty-state">That workout could not be found.</p>
      </section>`;
    return;
  }

  // Phase 4.1 Goal C/E (extended by the browser-test correction pass):
  // "Edit Workout" is offered ONLY while this exact completed workout is
  // both still within its local-calendar-day edit window AND not an
  // explicitly Skipped workout (a deliberate terminal record — see
  // js/utils/workoutCompletion.js's isEditableCompletedWorkout, the same
  // combined check the service layer re-checks immediately before writing
  // in updateCompletedWorkoutLog, so a stale button can't slip a write
  // through either way).
  const editable = workout.status === 'completed' && isEditableCompletedWorkout(workout);

  // FINAL POLISH PASS: the exercise cards below are rendered via
  // orderExercisesWarmupFirst(workout.exercises), a presentation-only
  // reorder — nothing here is ever written back to Firestore, so
  // reordering the array used purely for this .map() render is safe even
  // for an old historical snapshot that was originally STORED in the old,
  // buggy order (see js/utils/exerciseOrdering.js for the structural
  // association rule). workout.exercises itself is never reassigned or
  // mutated by this render. (Deliberately documented here, in a real JS
  // comment, rather than as an inline HTML comment inside the template
  // literal below — an HTML comment's text is live template-literal
  // content, so a stray backtick in it would terminate the string early;
  // see this pass's regression report for the exact incident.)
  root.innerHTML = `
    <section class="history-view">
      ${backToHistoryLink()}
      <h2>${escapeHtml(workout.dayName)} ${completionBadgeHtml(workout)} ${prBadgeHtml(prEvents.length)}</h2>
      <p class="text-muted">Week ${escapeHtml(workout.week)}</p>
      <p class="text-muted">${timingLineHtml(workout, { compact: false })}</p>
      ${skipReasonHtml(workout, { compact: false })}
      ${prDetailListHtml(prEvents, workout)}
      ${editable ? '<button type="button" class="btn btn-secondary" id="edit-workout-btn">Edit Workout</button>' : ''}
      <div id="detail-body">
        ${orderExercisesWarmupFirst(workout.exercises ?? []).map((ex) => `
          <div class="card">
            <div class="card-title">${escapeHtml(ex.displayNameAtStart)}</div>
            ${typeof ex.prescribed?.targetRpe === 'number' ? `<div class="card-sub target-rpe">Target RPE ${escapeHtml(ex.prescribed.targetRpe)}</div>` : ''}
            ${ex.notes ? `<p class="text-muted">${escapeHtml(ex.notes)}</p>` : ''}
            <div class="history-set-table">
              ${(ex.sets ?? []).map(renderReadOnlySetRow).join('') || '<p class="text-muted">Nothing logged.</p>'}
            </div>
          </div>`).join('')}
      </div>
    </section>`;

  root.querySelector('#edit-workout-btn')?.addEventListener('click', () => renderEditMode(root, uid, workout, completedForPr));
}

/**
 * Editable version of one set row (the existing completed-workout
 * correction mode). v1.1: the very same set block the live logger uses
 * (js/components/setResult.js) — actual weight/reps, ✓, and ⋯ for
 * Failed / Skip set / RPE / note. Never renders or edits plannedKg/
 * plannedReps; workoutService.updateCompletedWorkoutLog additionally
 * rejects any change outside the actual/logging fields.
 */
function editableSetRowHtml(ex, s, exIndex, setIndex) {
  return setBlockHtml(s, {
    showKg: ex.load?.type !== 'bodyweight',
    showReps: s.durationSec == null,
    dataAttrs: `data-ex="${exIndex}" data-set="${setIndex}"`,
  });
}

/**
 * Phase 4.1 Goal C/D: the explicit completed-workout edit mode. Works on a
 * deep-cloned WORKING COPY of `workout.exercises` (plain-data — JSON
 * round-trips it safely, no Firestore Timestamp objects live inside a
 * set row) so Cancel can discard every unsaved change by simply re-
 * rendering the read-only detail from the original, untouched `workout`
 * object. Save calls workoutService.js's updateCompletedWorkoutLog — a
 * single updateDoc on this SAME workout id; nothing here ever calls
 * startOrResumeWorkoutForCurrentPosition, finishWorkout, or any
 * programRun-writing code, so program progression cannot move as a side
 * effect of editing (see that function's own docstring for the full
 * argument).
 *
 * FINAL POLISH PASS — CRITICAL non-mutation guarantee: `working` itself
 * stays in the array order it was cloned in (the ORIGINAL stored order,
 * whatever that happens to be for this particular historical snapshot) for
 * its entire lifetime in this function, all the way through to the Save
 * call below. It is NEVER reordered. Only the RENDER LOOP's *iteration*
 * order is warm-up-first (`displayOrder`, computed once via
 * computeWarmupFirstOrder and never mutated either) — every card and its
 * set rows are still tagged with `exIndex`, the entry's ORIGINAL index
 * into `working`, exactly as before this pass. findWorkingSet/the input
 * handlers below all still do `working[exIndex].sets[setIndex]` lookups
 * completely unchanged, so an edit to one set's actualKg/actualReps/
 * completed/rpe/note is written back onto the SAME original array
 * position it always was. Save then calls
 * `updateCompletedWorkoutLog(uid, workout, working)` with `working` in
 * that same, never-reordered, original order — so editing one set on an
 * old, oddly-ordered historical snapshot can never silently persist a
 * warm-up-first (or any other) reordering of the stored `exercises` array.
 * The presentation reorder and the saved data are structurally two
 * different things computed from the same untouched `working` array: one a
 * read-only permutation used only for `.map()` iteration order, the other
 * the array itself, always in its original identity/order.
 */
function renderEditMode(root, uid, workout, completedForPr = null) {
  const working = JSON.parse(JSON.stringify(workout.exercises ?? []));
  const displayOrder = computeWarmupFirstOrder(working);

  root.innerHTML = `
    <section class="history-view">
      <h2>${escapeHtml(workout.dayName)} — Edit</h2>
      <p class="text-muted">Correcting logged sets only. The original plan (weights prescribed, reps prescribed, exercise order) can't be changed here.</p>
      <div id="edit-body">
        ${displayOrder.map((exIndex) => {
          const ex = working[exIndex];
          return `
          <div class="card exercise-card">
            <div class="card-title">${escapeHtml(ex.displayNameAtStart)}</div>
            <div class="set-table">
              ${(ex.sets ?? []).map((s, setIndex) => editableSetRowHtml(ex, s, exIndex, setIndex)).join('') || '<p class="text-muted">Nothing to edit for this item.</p>'}
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="card">
        <div class="btn-stack">
          <button type="button" class="btn btn-primary btn-large" id="save-edit-btn">Save</button>
          <button type="button" class="btn btn-secondary" id="cancel-edit-btn">Cancel</button>
        </div>
        <p class="form-status" id="edit-status" role="status"></p>
      </div>
    </section>`;

  function findWorkingSet(exIndex, setIndex) {
    return working[exIndex]?.sets?.[setIndex] ?? null;
  }

  root.querySelectorAll('.set-block[data-ex]').forEach((blockEl) => {
    const s = findWorkingSet(Number(blockEl.dataset.ex), Number(blockEl.dataset.set));
    if (s) wireSetBlock(blockEl, s);
  });

  root.querySelector('#cancel-edit-btn').addEventListener('click', () => {
    // Discards `working` entirely — the original `workout` object was never
    // mutated, so re-rendering read-only from it is a clean, complete undo.
    renderWorkoutDetail(root, uid, workout, completedForPr);
    // CORRECTION 1: return to the top of the page on Cancel too, same as a
    // successful Save below — a long workout's edit form can leave the
    // viewport scrolled well below the top, and the read-only re-render
    // should be seen from its start either way.
    window.scrollTo({ top: 0 });
  });

  root.querySelector('#save-edit-btn').addEventListener('click', async () => {
    const status = root.querySelector('#edit-status');
    root.querySelectorAll('#edit-body button, #edit-body input, #save-edit-btn, #cancel-edit-btn').forEach((el) => { el.disabled = true; });
    status.textContent = 'Saving…';
    try {
      await updateCompletedWorkoutLog(uid, workout, working);
      // Reflect the save locally without a re-fetch — updateCompletedWorkoutLog
      // wrote exactly this `working` array plus a freshly recomputed
      // completionState; mirroring both onto the in-memory `workout` object
      // is what makes the read-only re-render below show the correction
      // immediately (History/Progress will see it from Firestore on their
      // own next read regardless).
      workout.exercises = working;
      workout.completionState = classifyCompletionState(working);
      // Phase 5B, Package 1 (spec section 6 — edited completed workouts
      // must never show a stale PR result): patch THIS workout's entry
      // inside the already-fetched `completedForPr` array in place, so the
      // next prEventsForThisWorkout() call inside renderWorkoutDetail
      // re-derives PR/Baseline status from the CORRECTED actual data —
      // still with no extra Firestore round trip, matching this same
      // function's existing "without a re-fetch" design for every other
      // field.
      if (Array.isArray(completedForPr)) {
        const entry = completedForPr.find((w) => w.id === workout.id);
        if (entry) {
          entry.exercises = working;
          entry.completionState = workout.completionState;
        }
      }
      renderWorkoutDetail(root, uid, workout, completedForPr);
      // CORRECTION 1: scroll to top ONLY after a SUCCESSFUL save — a failed
      // save (the catch branch below) deliberately does NOT scroll, so the
      // error message stays exactly where the user is already looking.
      window.scrollTo({ top: 0 });
    } catch (err) {
      console.error(err);
      status.textContent = `Error: ${err.message}`;
      root.querySelectorAll('#edit-body button, #edit-body input, #save-edit-btn, #cancel-edit-btn').forEach((el) => { el.disabled = false; });
    }
  });
}

async function renderList(root, uid) {
  const completed = await listCompletedWorkouts(uid, HISTORY_LIST_LIMIT);

  if (!completed.length) {
    root.innerHTML = `
      <section class="empty-state">
        <h2>History</h2>
        <p>No completed workouts yet.</p>
      </section>`;
    return;
  }

  // Resolve a program NAME per distinct programId, one read per unique
  // program rather than one per workout — a workout history full of
  // repeats from the same program (the common case) fetches that program
  // exactly once. A program that's since been deleted/renamed away simply
  // falls back to omitting the name, never a failed page.
  const uniqueProgramIds = [...new Set(completed.map((w) => w.programId).filter(Boolean))];
  const programEntries = await Promise.all(
    uniqueProgramIds.map(async (id) => [id, await getProgram(uid, id)]),
  );
  const programNameById = new Map(programEntries.map(([id, p]) => [id, p?.name ?? null]));

  // FINAL POLISH PASS (Polish 2) — one workout = one visually distinct
  // card, replacing the previous layout where every workout was a bare,
  // unstyled `.admin-row` packed inside ONE shared `.card` with no
  // border/background/margin between rows at all ("multiple workouts
  // visually run into each other" — the exact bug this replaces). Each
  // workout now gets its OWN `.card` (the SAME `.card` class every other
  // card in this app already uses for background/border/radius/spacing —
  // no new visual language invented), wrapped in an `<a>` so the whole
  // card is clickable and navigates to the exact same
  // `#/history?workoutId=...` URL as before — click/navigation behavior is
  // unchanged, chronological order is unchanged (still whatever order
  // `completed` already arrived in from listCompletedWorkouts), and the
  // badge/skip-reason/timing for one workout can never visually detach
  // from it since they're all inside that one workout's own card. See
  // css/views.css's "History list" section for the layout rules (mobile-
  // first flex-wrap + word-break, so a long day/program name wraps cleanly
  // with no horizontal overflow, on desktop and narrow viewports alike).
  // Phase 5B, Package 1: computed ONCE for the whole list (not once per
  // row) — same "compute once, look up per row" pattern this file's own
  // programNameById map above already uses. Fails open: a thrown error here
  // (a malformed legacy document, say) still lets the list render below
  // with prCountForWorkout simply returning 0 for every row via the empty
  // fallback Map, rather than blocking History entirely.
  let eventsByWorkoutId = new Map();
  try {
    ({ eventsByWorkoutId } = computeAllPrEvents(completed));
  } catch (err) {
    console.error('history.js: PR analytics computation failed (non-fatal — list still renders)', err);
  }

  root.innerHTML = `
    <section class="history-view">
      <h2>History</h2>
      <div class="history-list">
        ${completed.map((w) => {
          const programName = programNameById.get(w.programId);
          return `
            <a class="card history-item" href="#/history?workoutId=${encodeURIComponent(w.id)}">
              <div class="history-item-head">
                <span class="history-item-title">${escapeHtml(w.dayName)}</span>
                ${completionBadgeHtml(w)}
                ${prBadgeHtml(prCountForWorkout(eventsByWorkoutId, w.id))}
              </div>
              <div class="history-item-sub">Week ${escapeHtml(w.week)}${programName ? ` · ${escapeHtml(programName)}` : ''}</div>
              ${skipReasonHtml(w, { compact: true })}
              <div class="history-item-time">${timingLineHtml(w, { compact: true })}</div>
            </a>`;
        }).join('')}
      </div>
    </section>`;
}

export async function mount(root) {
  const uid = getCurrentUser().uid;
  root.innerHTML = `<div class="loading-state" role="status">Loading history…</div>`;

  // Same hash-query-param pattern js/views/adminUserDetail.js already
  // established for "list vs. detail within one router.js route" — no new
  // route/config/app.config.js entry needed for the read-only detail view.
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const workoutId = params.get('workoutId');

  if (workoutId) {
    const workout = await getWorkout(uid, workoutId);
    // Phase 5B, Package 1: a single-workout detail has no history of its
    // own to compare against, so PR detection here needs the FULL completed
    // history, same limit/query History's own list already uses (and the
    // exact same offline-safe getDocsSafe path underneath — no new offline
    // risk). Best-effort only: if this second read fails (or is offline and
    // never cached), the detail view still renders fully via the existing
    // `workout` — it just shows no PR line that time, rather than failing
    // the whole page.
    let completedForPr = null;
    if (workout) {
      try {
        completedForPr = await listCompletedWorkouts(uid, HISTORY_LIST_LIMIT);
      } catch (err) {
        console.error('history.js: could not load history for PR analytics (non-fatal — detail still renders)', err);
      }
    }
    renderWorkoutDetail(root, uid, workout, completedForPr);
    return;
  }

  await renderList(root, uid);
}
