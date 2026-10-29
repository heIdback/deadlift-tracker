// Phase 3B scope: turns the Phase 3A read-only workout snapshot into an
// interactive, mobile-first per-set logger with autosave. The rest timer,
// "previous performance" comparison, PR detection, progression suggestions,
// and a full history/analytics redesign remain out of scope — see the
// Phase 3B report for the explicit deferral list.
import { getCurrentUser } from '../core/auth.js';
import { getUserProfile } from '../services/userService.js';
import { getPrimaryProgramContext, getProgramDays, startProgramRun } from '../services/programService.js';
import {
  resolveActiveWorkout, startOrResumeWorkoutForCurrentPosition,
  updateWorkoutExercises, subscribeToWorkoutLocalStatus, finishWorkout, skipWorkout, reconcileLegacyProgramPosition,
  skipAheadToPosition, updateWorkoutNote, MAX_WORKOUT_NOTE_LENGTH, getPreviousPerformance, listCompletedWorkouts,
} from '../services/workoutService.js';
import { listSkipTargets, MAX_SKIP_REASON_LENGTH } from '../utils/skipAhead.js';
import { buildResolvedExerciseList, generateSetsForExercise } from '../utils/workoutSnapshot.js';
import { countLoggableSets } from '../utils/workoutCompletion.js';
import { setBlockHtml, wireSetBlock } from '../components/setResult.js';
import { resolveSetStatus, SET_STATUS } from '../utils/setLogging.js';
import { orderExercisesWarmupFirst } from '../utils/exerciseOrdering.js';
import { escapeHtml } from '../utils/dom.js';
import { readableBasisName } from '../utils/programDisplay.js';
// v32: progress counts, finished-exercise collapse, ±2.5 kg, screen kept on.
import { exerciseProgress, workoutProgress, isExerciseFinished, awaitsReps, stepKg, KG_STEP } from '../utils/workoutProgress.js';
import { keepScreenOn } from '../core/wakeLock.js';
import { formatDate, formatHumanDuration } from '../utils/dates.js';
// v33: summary after FINISH WORKOUT.
import { summarizeWorkout } from '../utils/workoutSummary.js';
import { isRunCompleted } from '../utils/programCycle.js';
import { mountProgramCompleteCard } from './programCompleteCard.js';

const AUTOSAVE_DEBOUNCE_MS = 600;

// Only one Workout view is ever mounted at a time (single-outlet SPA), so a
// module-level slot for "how to flush the currently-active logger's pending
// autosave" is enough — the router calls whatever `mount()` returns on the
// way out, and that wrapper always reads this variable at call time rather
// than at mount time, so it works whether or not logging had even started
// yet when the view was left.
let pendingFlush = null;

// Correction pass 4 ("OFFLINE SET AUTOSAVE DOES NOT SURVIVE F5"): a real F5
// reload (or tab close) never runs the router's own teardownCurrentView —
// that only fires for IN-APP navigation (a hashchange, or an access-state
// transition — see router.js's render()). So `pendingFlush` alone was never
// invoked for the one case that matters here, leaving the active logger's
// up-to-`AUTOSAVE_DEBOUNCE_MS`-wide debounce window (plus whatever real
// latency the in-flight write itself takes to settle into Firestore's local
// mutation queue) as the only thing standing between "the lifter just
// edited a set" and a reload discarding it. `mountActiveWorkout` registers
// its own page-lifecycle cleanup here (mirroring `pendingFlush`'s existing
// single-slot pattern — only one logger is ever mounted at a time), so
// `unmount` can detach it on a normal in-app navigation away from Workout
// too, and it never leaks a second set of listeners across repeated visits.
let pendingHideCleanup = null;

// One-line result of a "Choose another day" jump, shown once on the freshly
// re-rendered Start preview (the view re-mounts itself after the jump).
let pendingNotice = '';

function formatReps(reps, durationSec) {
  if (reps != null && typeof reps === 'object') return `${reps.min}-${reps.max}`;
  if (reps != null) return String(reps);
  if (durationSec != null) return `${durationSec}s`;
  return '—';
}

function formatLoad(load, ex) {
  if (!load) return '—';
  const of = () => readableBasisName(load.basisExerciseId, ex); // v32: a name, never the internal id
  switch (load.type) {
    case 'percent':
      return load.displayTargetKg != null
        ? `${load.displayTargetKg} kg (${Math.round(load.percent * 100)}% of ${of()} @ ${load.basisOneRepMax} kg)`
        : `${Math.round(load.percent * 100)}% of ${of()} — no 1RM on file yet`;
    case 'percentRange':
      return load.displayRangeKg
        ? `${load.displayRangeKg[0]}–${load.displayRangeKg[1]} kg (${Math.round(load.min * 100)}–${Math.round(load.max * 100)}% of ${of()})`
        : `${Math.round(load.min * 100)}–${Math.round(load.max * 100)}% of ${of()} — no 1RM on file yet`;
    case 'fixed':
      return load.kg != null ? `${load.kg} kg${load.perHand ? ' / hand' : ''}` : '—';
    case 'sets':
      return (load.sets ?? []).map((s) => `${s.kg}×${s.reps}`).join(', ') || '—';
    case 'bodyweight':
      return 'Bodyweight';
    default:
      return '—';
  }
}

function repsPlaceholder(ex) {
  const r = ex.prescribed?.reps;
  if (r != null && typeof r === 'object') return `${r.min}-${r.max}`;
  if (r != null) return String(r);
  return '—';
}

/** v1.1: "Target RPE 6" line for a snapshot that carries one (prescription only — never an actual RPE). */
function targetRpeHtml(ex) {
  const t = ex.prescribed?.targetRpe;
  return typeof t === 'number' ? `<div class="card-sub target-rpe">Target RPE ${escapeHtml(t)}</div>` : '';
}

function renderExercisePreview(ex) {
  return `
    <div class="card">
      <div class="card-title">${escapeHtml(ex.displayNameAtStart)}</div>
      <div class="card-sub">${ex.prescribed.sets ?? '—'} × ${escapeHtml(formatReps(ex.prescribed.reps, ex.prescribed.durationSec))} @ ${escapeHtml(formatLoad(ex.load, ex))}</div>
      ${targetRpeHtml(ex)}
      ${ex.notes ? `<p class="text-muted">${escapeHtml(ex.notes)}</p>` : ''}
    </div>`;
}

export async function mount(root) {
  const uid = getCurrentUser().uid;
  const notice = pendingNotice; // shown once, on THIS render only
  pendingNotice = '';
  root.innerHTML = `<div class="loading-state" role="status">Loading workout…</div>`;

  // Whatever happens below, this is what the router calls on the way out.
  // It reads `pendingFlush` at call time (not capture time), so it works
  // whether the active logger existed from the start or only started via
  // the START WORKOUT button below.
  const unmount = () => {
    if (pendingFlush) {
      const flush = pendingFlush;
      pendingFlush = null;
      flush();
    }
    if (pendingHideCleanup) {
      const cleanup = pendingHideCleanup;
      pendingHideCleanup = null;
      cleanup();
    }
  };

  const programCtx = await getPrimaryProgramContext(uid);
  const { program } = programCtx;
  let run = programCtx.run;

  if (!program) {
    // See home.js's matching fallback: every approved user gets a starter
    // program installed automatically (Phase 3E), so this means that
    // install hasn't completed yet, not that the user needs to import one.
    root.innerHTML = `
      <section class="empty-state">
        <h2>Setting up your program…</h2>
        <p>This can take a moment on a slow connection. Try refreshing — if
        this keeps happening, contact an admin.</p>
      </section>`;
    return unmount;
  }

  console.debug('[START] workout.js mount: before resolveActiveWorkout', { uid, runId: run?.id ?? null });
  const active = await resolveActiveWorkout(uid, run);
  console.debug('[START] workout.js mount: after resolveActiveWorkout', { activeId: active?.id ?? null });
  if (active) {
    mountActiveWorkout(root, uid, active);
    return unmount;
  }

  // Self-heals a run stuck at an already-completed position from before
  // automatic advancement existed (Phase 3C). No-op once caught up.
  run = await reconcileLegacyProgramPosition(uid, run);

  // v33: a finished program offers no workout in a week that doesn't exist —
  // the "Program completed" card instead (new cycle / another program).
  if (isRunCompleted(run, program)) {
    root.innerHTML = '<section class="workout-view"><div id="program-complete-slot"></div></section>';
    await mountProgramCompleteCard(root.querySelector('#program-complete-slot'), {
      uid, program, run, profile: await getUserProfile(uid), onRestarted: () => mount(root),
    });
    return unmount;
  }

  // No active workout: show a live, NOT-yet-saved preview of the current
  // (or would-be Week 1 Day 1) position, computed straight from the
  // editable program template + the lifter's current 1RMs — nothing here
  // is persisted until START WORKOUT is pressed. No per-set logging UI
  // belongs here since there is nothing yet to log against.
  const days = await getProgramDays(uid, program.id);
  const week = run ? run.current.week : 1;
  const dayOrder = run ? run.current.dayOrder : 1;
  const day = days.find((d) => d.order === dayOrder) ?? days[0];
  const profile = await getUserProfile(uid);
  // FINAL POLISH PASS: presentation-only warm-up-first order for this
  // not-yet-started preview — nothing here is persisted (see the comment
  // above), so this is purely cosmetic and carries zero snapshot-safety
  // risk either way.
  const preview = orderExercisesWarmupFirst(buildResolvedExerciseList(day, week, {
    currentMaxes: profile?.currentMaxes ?? {},
    rounding: profile?.settings?.rounding ?? {},
  }));

  // v23: days the lifter may jump ahead to (needs a started run; none left → no button).
  const skipTargets = run ? listSkipTargets({ days, weeks: program.weeks ?? [], current: run.current }) : [];

  root.innerHTML = `
    <section class="workout-view">
      ${notice ? `<p class="form-status" id="skip-ahead-result" role="status">${escapeHtml(notice)}</p>` : ''}
      <div class="card card-primary">
        <div class="card-label">Planned — Week ${week}</div>
        <h2 class="card-title">${escapeHtml(day.name)}</h2>
        <div class="card-sub">Nothing is saved until you start.</div>
      </div>
      ${preview.map(renderExercisePreview).join('')}
      <button class="btn btn-primary btn-large" id="start-btn">START WORKOUT</button>
      <p class="form-status" id="start-status" role="status"></p>
      ${skipTargets.length ? `
      <div id="skip-ahead-section">
        <button type="button" class="btn btn-secondary" id="skip-ahead-open">Choose another day…</button>
        <div id="skip-ahead-panel" hidden></div>
      </div>` : ''}
    </section>`;

  if (skipTargets.length) {
    root.querySelector('#skip-ahead-open').addEventListener('click', () => openSkipAhead({
      root, uid, run, program, days, profile, targets: skipTargets,
    }));
  }

  root.querySelector('#start-btn').addEventListener('click', async (e) => {
    const btn = e.target;
    // Correction pass 8: a genuinely disabled <button> still runs this
    // handler for a raw/programmatic click dispatch (only a real user
    // gesture is blocked by the disabled state) — this explicit check is
    // what actually stops a second, reentrant invocation from reaching
    // startProgramRun/startOrResumeWorkoutForCurrentPosition a second time
    // and double-mounting the result; see workoutService.js's
    // `inFlightStarts` map for the deeper, service-level guarantee this
    // backs up.
    if (btn.disabled) return;
    const status = root.querySelector('#start-status');
    btn.disabled = true;
    status.textContent = 'Starting…';
    console.debug('[START] workout.js click handler: entered', { uid, hasRun: !!run, programId: program.id });
    try {
      // Correction pass 3: see js/views/home.js's matching comment and
      // startOrResumeWorkoutForCurrentPosition's own doc comment — this
      // view already resolved program/run/days/profile to render its own
      // preview above, so that same context is passed straight through
      // instead of being silently re-fetched (the real root cause of the
      // offline "Starting…" hang).
      const startRun = run ?? await startProgramRun(uid, program.id);
      console.debug('[START] workout.js click handler: run resolved', { runId: startRun.id });
      const started = await startOrResumeWorkoutForCurrentPosition(uid, {
        run: startRun, program, days, profile,
      });
      console.debug('[START] workout.js click handler: service returned, mounting active workout', { workoutId: started.id });
      mountActiveWorkout(root, uid, started);
    } catch (err) {
      console.error('[START] workout.js click handler: caught error', err);
      status.textContent = `Error: ${err.message}`;
      btn.disabled = false;
    }
  });

  return unmount;
}

/**
 * v23 — "Choose another day…": jump forward in the program. The sessions in
 * between (the current day included) are written to History as Skipped in one
 * atomic step (workoutService.skipAheadToPosition). The panel itself is the
 * confirmation: it lists exactly what will be skipped and says it can't be
 * undone. Cancel closes it without changing anything.
 */
function openSkipAhead({
  root, uid, run, program, days, profile, targets,
}) {
  const panel = root.querySelector('#skip-ahead-panel');
  const opener = root.querySelector('#skip-ahead-open');
  const label = (p) => `Week ${p.week} · ${p.dayName}`;
  opener.hidden = true;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="card">
      <h3 class="card-title">Choose another day</h3>
      <p class="text-muted">Jump ahead in the program. The sessions you skip are saved to History as Skipped, so you don't have to skip them one by one.</p>
      <label class="field">Go to
        <select id="skip-ahead-target">${targets.map((t, i) => `<option value="${i}">${escapeHtml(label(t))}</option>`).join('')}</select>
      </label>
      <div id="skip-ahead-summary"></div>
      <label class="field">Reason (optional — shown on each skipped workout)
        <textarea id="skip-ahead-reason" rows="2" maxlength="${MAX_SKIP_REASON_LENGTH}"></textarea>
      </label>
      <p><strong>This can't be undone.</strong> Skipped sessions stay in your History.</p>
      <div class="btn-stack">
        <button type="button" class="btn btn-danger" id="skip-ahead-confirm"></button>
        <button type="button" class="btn btn-secondary" id="skip-ahead-cancel">Cancel</button>
      </div>
      <p class="form-status" id="skip-ahead-status" role="status"></p>
    </div>`;

  const select = panel.querySelector('#skip-ahead-target');
  const confirm = panel.querySelector('#skip-ahead-confirm');
  const status = panel.querySelector('#skip-ahead-status');
  const current = () => targets[Number(select.value)];

  function refresh() {
    const t = current();
    const n = t.skipped.length;
    panel.querySelector('#skip-ahead-summary').innerHTML = `
      <p>Skipping <strong>${n}</strong> session${n === 1 ? '' : 's'}:</p>
      <ul class="notice-list">${t.skipped.map((p) => `<li>${escapeHtml(label(p))}</li>`).join('')}</ul>
      <p>Then continue with <strong>${escapeHtml(label(t))}</strong>.</p>`;
    confirm.textContent = `Skip ${n} and go to ${t.dayName}`;
  }
  select.addEventListener('change', refresh);
  refresh();

  panel.querySelector('#skip-ahead-cancel').addEventListener('click', () => {
    panel.hidden = true;
    panel.innerHTML = '';
    opener.hidden = false;
  });

  confirm.addEventListener('click', async () => {
    if (confirm.disabled) return; // a raw click still reaches a disabled button's handler
    const t = current();
    const reason = panel.querySelector('#skip-ahead-reason').value;
    panel.querySelectorAll('button, select, textarea').forEach((el) => { el.disabled = true; });
    root.querySelector('#start-btn').disabled = true;
    status.textContent = 'Skipping…';
    let result;
    try {
      result = await skipAheadToPosition(uid, {
        run, program, days, profile, target: { week: t.week, dayOrder: t.dayOrder }, reason,
      });
    } catch (err) {
      console.error('[SKIP-AHEAD] failed', err);
      status.textContent = `Nothing was skipped: ${err.message}`;
      panel.querySelectorAll('button, select, textarea').forEach((el) => { el.disabled = false; });
      root.querySelector('#start-btn').disabled = false;
      return;
    }
    // From here the jump HAS been applied (locally, synced when online): the
    // controls stay disabled whatever happens next — `run` and `targets` above
    // are now stale and must never be used for a second jump.
    const n = result.skippedCount;
    pendingNotice = `Skipped ${n} session${n === 1 ? '' : 's'}. Now at ${label(result.target)}.`;
    try {
      await mount(root); // re-render the Start preview from the new position
    } catch (err) {
      console.error('[SKIP-AHEAD] re-render failed', err);
      pendingNotice = '';
      status.textContent = `Skipped ${n} session${n === 1 ? '' : 's'} — reload the page to continue.`;
    }
  });
}

/**
 * Self-healing backfill: a workout whose `sets[]` is still empty (either
 * because it was started before this generator existed, or because a future
 * load-type change left one exercise short) gets its rows generated now,
 * from the exact same pure generator the start flow uses. Returns a new
 * exercises array either way; `changed` tells the caller whether anything
 * actually needed persisting.
 */
function backfillSets(exercises) {
  let changed = false;
  const next = exercises.map((ex) => {
    if (Array.isArray(ex.sets) && ex.sets.length > 0) return ex;
    const generated = generateSetsForExercise(ex);
    if (generated.length === 0) return ex;
    changed = true;
    return { ...ex, sets: generated };
  });
  return { exercises: next, changed };
}

/**
 * v1.1: each set is now a "set block" (js/components/setResult.js) — the
 * same [index | kg | reps | ✓] row as before, plus a small ⋯ button that
 * opens Failed / Skip set / RPE / note for that set, and a one-line status
 * summary ("⚠ Failed · Planned 160 × 5"). Actual weight/reps are still
 * prefilled to the plan, so the normal flow is unchanged: tap ✓. Changing
 * the weight or reps of a done set marks it Modified automatically.
 */
function renderSetRow(ex, s) {
  return setBlockHtml(s, {
    showKg: ex.load?.type !== 'bodyweight',
    showReps: s.durationSec == null,
    repsPlaceholder: repsPlaceholder(ex),
    dataAttrs: `data-set-id="${escapeHtml(s.setId)}"`,
  });
}

/**
 * Phase 3E.1: deliberately does NOT render a "N × reps @ load" prescription
 * summary here (renderExercisePreview, above, still does — the pre-start
 * preview has no set rows below it, so that summary is the only place that
 * information exists yet). Once a workout is active, the set-table rendered
 * right below already shows each set's actual weight/reps/warm-up label, so
 * repeating the generic prescription/load text here was pure duplication —
 * removed for every exercise/load type generically (no exercise-specific
 * branching), never by touching `ex.prescribed`/`ex.load` themselves, which
 * still come straight from the immutable snapshot untouched. `ex.notes`
 * (which is how RPE targets like "RPE 7-7.5" already reach this card — see
 * data/program.deadlift-8wk.json's weekly-variant `notes` field and
 * workoutSnapshot.js's selectWeekPrescriptions) is untouched and still
 * rendered.
 */
function renderExerciseBlock(ex) {
  const rows = (ex.sets ?? []).map((s) => renderSetRow(ex, s)).join('');
  if (!rows) {
    return `
    <div class="card exercise-card" data-entry-id="${escapeHtml(ex.entryId ?? '')}">
      <div class="card-title">${escapeHtml(ex.displayNameAtStart)}</div>
      <div class="exercise-body">
        ${targetRpeHtml(ex)}
        ${ex.notes ? `<p class="text-muted">${escapeHtml(ex.notes)}</p>` : ''}
        <p class="text-muted">Nothing to log for this item.</p>
      </div>
    </div>`;
  }
  // v32: the header shows "done/total" and opens/closes the exercise; a
  // finished exercise is collapsed by mountActiveWorkout (tap to open again).
  const p = exerciseProgress(ex);
  return `
    <div class="card exercise-card has-sets" data-entry-id="${escapeHtml(ex.entryId ?? '')}">
      <button type="button" class="exercise-head" aria-expanded="true">
        <span class="card-title">${escapeHtml(ex.displayNameAtStart)}</span>
        <span class="exercise-count" aria-label="sets done">${p.done}/${p.total}</span>
        <span class="exercise-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="exercise-body">
        ${targetRpeHtml(ex)}
        ${ex.notes ? `<p class="text-muted">${escapeHtml(ex.notes)}</p>` : ''}
        <div class="set-table">${rows}</div>
      </div>
    </div>`;
}

/**
 * v29 — adds what was done LAST TIME under each set (and where it came from
 * under the exercise title) to the already-rendered logger. Inserted into the
 * live DOM (the logger is rendered once and never re-rendered), as plain text.
 * Read-only: the inputs keep their own planned prefill.
 */
function showPreviousPerformance(root, prev) {
  if (!prev?.size) return;
  root.querySelectorAll('.exercise-card[data-entry-id]').forEach((card) => {
    const info = prev.get(card.dataset.entryId);
    if (!info) return;
    card.querySelectorAll('.prev-session, .set-prev').forEach((el) => el.remove());
    const head = document.createElement('div');
    head.className = 'card-sub prev-session';
    head.textContent = ['Last time', formatDate(info.finishedAt), info.week != null ? `Week ${info.week}` : '', info.dayName]
      .filter(Boolean).join(' · ').replace('Last time · ', 'Last time: ');
    const body = card.querySelector('.exercise-body');
    if (body) body.prepend(head); else card.querySelector('.card-title')?.after(head);
    card.querySelectorAll('.set-block[data-set-id]').forEach((block) => {
      const text = info.sets.get(block.dataset.setId);
      if (!text) return;
      const line = document.createElement('div');
      line.className = 'set-prev';
      // v30: grey "Last:" label + the values in bold, near-white (easier to read mid-set).
      const label = document.createElement('span');
      label.className = 'set-prev-label';
      label.textContent = 'Last:';
      const value = document.createElement('strong');
      value.className = 'set-prev-value';
      value.textContent = text;
      line.append(label, ' ', value);
      // v32: shares one row with the −/+ buttons when the set has them
      const sub = block.querySelector('.set-sub');
      if (sub) sub.prepend(line); else block.querySelector('.set-row')?.after(line);
    });
  });
}

// same depth as History, so the summary and History agree on what is a PR
const SUMMARY_LOOKBACK = 200;
const fmtKg = (v) => `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })} kg`;
const signed = (v, unit = ' kg') => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 1 })}${unit}`;
const setText = (t) => (t ? `${t.kg} kg × ${t.reps}` : '—');

/** v33 — the screen shown after FINISH WORKOUT (read-only; Done → Home). */
function showFinishSummary(root, sum, workout, { offline }) {
  const c = sum.comparison;
  root.innerHTML = `
    <section class="workout-view workout-summary" id="workout-summary">
      <div class="card card-primary">
        <div class="card-label">Workout complete${offline ? ' — will sync when back online' : ''}</div>
        <h2 class="card-title">${escapeHtml(workout.dayName)} · Week ${escapeHtml(workout.week)}</h2>
        <div class="summary-stats">
          <div class="stat-card"><div class="stat-label">Sets</div><div class="stat-value">${sum.sets.done}/${sum.sets.total}</div></div>
          <div class="stat-card"><div class="stat-label">Time</div><div class="stat-value">${sum.durationSec != null ? escapeHtml(formatHumanDuration(sum.durationSec)) : '—'}</div></div>
          <div class="stat-card"><div class="stat-label">Volume</div><div class="stat-value">${escapeHtml(fmtKg(sum.volumeKg))}</div></div>
        </div>
        ${sum.sets.failed || sum.sets.skipped ? `<p class="text-muted">${[sum.sets.failed ? `${sum.sets.failed} failed` : '', sum.sets.skipped ? `${sum.sets.skipped} skipped` : ''].filter(Boolean).join(' · ')}</p>` : ''}
      </div>
      <div class="card" id="summary-prs">
        <h3>PRs</h3>
        ${sum.prs.length ? `<ul class="notice-list">${sum.prs.map((p) => `<li><span class="badge-pr">${escapeHtml(p.label)}</span> ${escapeHtml(p.exercise)} — <strong>${escapeHtml(p.text)}</strong></li>`).join('')}</ul>`
    : '<p class="text-muted">No new PRs this time.</p>'}
      </div>
      <div class="card" id="summary-compare">
        <h3>Compared with last time</h3>
        ${c ? `
          <p class="text-muted">Same day, ${c.previous.week != null ? `Week ${escapeHtml(c.previous.week)}, ` : ''}${escapeHtml(formatDate(c.previous.finishedAt))}</p>
          <ul class="notice-list">
            ${c.mainSet ? `<li>${escapeHtml(c.mainSet.name)} top set: ${escapeHtml(setText(c.mainSet.before))} → <strong>${escapeHtml(setText(c.mainSet.after))}</strong>${c.mainSet.deltaKg != null && c.mainSet.deltaKg !== 0 ? ` (${escapeHtml(signed(c.mainSet.deltaKg))})` : ''}</li>` : ''}
            <li>Volume: ${escapeHtml(fmtKg(c.volume.before))} → <strong>${escapeHtml(fmtKg(c.volume.after))}</strong> (${escapeHtml(signed(c.volume.delta))})</li>
          </ul>` : '<p class="text-muted">First time on this program day — nothing to compare yet.</p>'}
      </div>
      <a class="btn btn-primary btn-large" href="#/home" id="summary-done">Done</a>
    </section>`;
  window.scrollTo?.(0, 0);
}

function renderWorkoutHtml(workout) {
  return `
    <section class="workout-view">
      <div class="card card-primary">
        <div class="card-label">In Progress — Week ${workout.week}</div>
        <h2 class="card-title">${escapeHtml(workout.dayName)}</h2>
        <div class="workout-progress" id="workout-progress" role="status"></div>
        <div class="card-sub">Tap ✓ once you've done a set. Change the weight or reps if you did something different, or tap ⋯ to mark a set failed or skipped. Everything saves automatically.</div>
      </div>
      ${workout.exercises.map(renderExerciseBlock).join('')}
      <div class="card" id="workout-note-card">
        <label class="field">Workout note (optional)
          <textarea id="workout-note-input" rows="3" maxlength="${MAX_WORKOUT_NOTE_LENGTH}" placeholder="How did it feel? Anything to remember for next time?">${escapeHtml(workout.notes ?? '')}</textarea>
        </label>
        <p class="text-muted">Saved with this workout. It can't be changed after you finish.</p>
      </div>
      <div class="card" id="finish-panel">
        <button type="button" class="btn btn-primary btn-large" id="finish-btn">FINISH WORKOUT</button>
        <p class="form-status" id="finish-status" role="status"></p>
      </div>
      <div class="card" id="skip-panel">
        <button type="button" class="btn btn-secondary" id="skip-btn">Skip Workout</button>
      </div>
      <p class="form-status" id="autosave-status" role="status"></p>
    </section>`;
}

/**
 * Mounts the interactive per-set logger for an active (in_progress)
 * workout, wires up autosave, and registers this logger's flush as the
 * module-level `pendingFlush` so navigating away doesn't drop the last
 * pending edit. `workout` is treated as this view's own in-memory working
 * copy — Firestore's offline cache remains the durable store; this object
 * exists so taps/keystrokes can update the UI and queue a save without a
 * round trip per keystroke.
 */
function mountActiveWorkout(root, uid, workoutInput) {
  // v32: a logger mounted earlier (e.g. a slow mount that finished after
  // navigating) must not keep its listeners / screen lock alive.
  if (pendingHideCleanup) {
    const previous = pendingHideCleanup;
    pendingHideCleanup = null;
    previous();
  }
  let progressEl = null;
  const sessionStartedAt = Date.now(); // v33: duration fallback while startedAt is still a pending server time
  const { exercises: backfilled, changed } = backfillSets(workoutInput.exercises);
  // FINAL POLISH PASS: `workout.exercises` here is both the render source
  // AND the exact array autosaved back via updateWorkoutExercises below —
  // there is no separate "stored" vs. "displayed" copy for an in-progress
  // workout the way there is for a completed one (see history.js's edit
  // mode for that distinction). A brand-new workout already arrives in
  // warm-up-first order from startOrResumeWorkout's snapshot build, so this
  // is a no-op identity reorder for the normal case; it only ever changes
  // anything for a workout started before this ordering fix existed, and
  // even then only reorders whole exercise entries — never an entry's own
  // exerciseId/entryId/load/sets content.
  const exercises = orderExercisesWarmupFirst(backfilled);
  const workout = { ...workoutInput, exercises };

  let dirty = false;
  // v26: the workout-level note is saved by the same debounce/flush machinery
  // as the sets, but as its own write (a different field of the same doc).
  let noteDirty = false;
  let debounceTimer = null;
  // A resolved-promise-based mutex: every save chains onto the previous
  // one, so saves are strictly sequential and each one always reads
  // `workout.exercises` at the moment IT runs (not at the moment it was
  // scheduled) — a fast edit made while a save is already in flight is
  // never lost or overwritten by an older response, and no transaction or
  // per-keystroke write is needed.
  //
  // Correction pass 5: this chain no longer waits for each write's own
  // Promise to fully settle (see runSave below for why) — it now only
  // sequences the SYNCHRONOUS "capture workout.exercises, hand it to
  // Firestore" step of each save in issue order. That's all it ever
  // needed to guarantee: Firestore's own local mutation queue preserves
  // per-document write order regardless of when each individual write's
  // Promise resolves, so issuing writes in the right order (not waiting
  // for each one's round trip before issuing the next) is sufficient.
  let saveChain = Promise.resolve();
  // Whether the local-status listener below has fired at least once yet.
  // Gates ONLY the very first snapshot after mount, so an untouched,
  // already-fully-synced workout never flashes "Saved" out of nowhere.
  // It deliberately does NOT gate on "did this session issue an edit" —
  // an offline edit made before a reload can leave a genuinely pending
  // write sitting in the local cache with no edit happening in the new
  // page instance at all, and that truthful state (and its later
  // transition to "Saved" on reconnect) must still surface.
  let receivedLocalStatusSnapshot = false;

  function setAutosaveStatus(text) {
    const el = root.querySelector('#autosave-status');
    if (el) el.textContent = text;
  }

  /**
   * Correction pass 5 root cause fix: verified (see this pass's report,
   * citing firebase-js-sdk issue #1497 and a real developer's own
   * confirmation) that the Promise returned by updateDoc/setDoc/
   * WriteBatch.commit() is DOCUMENTED to stay pending until the BACKEND
   * acknowledges the write — "won't resolve while you're offline" — not
   * merely until the mutation reaches Firestore's local persistence layer
   * (that part still happens essentially immediately, online or off; it
   * just isn't what this Promise reports). Correction pass 4 assumed
   * otherwise and awaited this Promise directly for the "Saved" label,
   * which is exactly why a real offline browser got stuck on "Saving…"
   * indefinitely — the awaited Promise was correctly, by design, never
   * going to resolve until reconnect.
   *
   * The fix: issue the write and let it run in the background (only
   * `.catch()`ing it, for genuine failures — a permission error, say —
   * never "still offline", which isn't a failure at all); the truthful
   * "this edit is safely local" signal comes from the OFFICIAL, documented
   * mechanism for exactly that — `subscribeToWorkoutLocalStatus`'s
   * snapshot listener, wired up below, whose `hasPendingWrites` reflects
   * the local mutation queue directly, independent of any write's own
   * Promise.
   */
  async function runSave() {
    if ((!dirty && !noteDirty) || workout.status !== 'in_progress') return;
    const saveExercises = dirty;
    const saveNote = noteDirty;
    dirty = false;
    noteDirty = false;
    setAutosaveStatus('Saving…');
    if (saveExercises) {
      const exercisesSnapshot = workout.exercises;
      updateWorkoutExercises(uid, workout.id, exercisesSnapshot).catch((err) => {
        console.error(err);
        dirty = true; // nothing is lost — the next trigger (or flush) retries
        setAutosaveStatus(`Save failed, will retry — ${err.message}`);
      });
    }
    if (saveNote) {
      const noteSnapshot = workout.notes ?? '';
      updateWorkoutNote(uid, workout.id, noteSnapshot).catch((err) => {
        console.error(err);
        noteDirty = true;
        setAutosaveStatus(`Save failed, will retry — ${err.message}`);
      });
    }
  }

  function triggerSave() {
    debounceTimer = null;
    saveChain = saveChain.then(runSave, runSave);
    return saveChain;
  }

  function queueSave(immediate, { noteOnly = false } = {}) {
    if (noteOnly) noteDirty = true; else dirty = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (immediate) {
      triggerSave();
    } else {
      debounceTimer = setTimeout(triggerSave, AUTOSAVE_DEBOUNCE_MS);
    }
  }

  /**
   * Cancels any pending debounce and forces an immediate save; returns the
   * settling promise so a caller (Finish, Skip, unmount) can wait on it.
   * Correction pass 5: that promise now settles as soon as the write has
   * been ISSUED to Firestore (synchronous local enqueue), not once the
   * backend has acknowledged it — so this is safe to await from a
   * pagehide handler or from doFinish/doSkip even while fully offline,
   * where it previously could have hung indefinitely (see runSave above).
   */
  function flushNow() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      return triggerSave();
    }
    return saveChain;
  }

  pendingFlush = flushNow;

  // Correction pass 5: the truthful "is my last edit safely local yet"
  // signal — see runSave's doc comment above for why this cannot be the
  // write's own Promise. `hasPendingWrites` is true from the moment the
  // mutation lands in Firestore's local cache until the backend
  // acknowledges it (online or off), so this listener is what actually
  // drives the autosave-status label from here on; `runSave` only ever
  // sets the transient "Saving…" text. Deliberately never touches
  // `workout.exercises`/`workout.status` from the snapshot itself — only
  // its metadata — so it can never clobber an in-flight edit with a
  // possibly-stale read (see subscribeToWorkoutLocalStatus's own doc
  // comment).
  const unsubscribeLocalStatus = subscribeToWorkoutLocalStatus(uid, workout.id, ({ hasPendingWrites, exists }) => {
    const isFirstSnapshot = !receivedLocalStatusSnapshot;
    receivedLocalStatusSnapshot = true;
    if (!exists || workout.status !== 'in_progress') return;
    // Only the very first snapshot is suppressed, and only when it has
    // nothing pending to report — this is what keeps a freshly-mounted,
    // already-synced workout from flashing "Saved" before any edit. A
    // first snapshot that DOES already show a pending write (e.g. an
    // offline edit that survived a reload, with no fresh edit made in
    // this page instance) is a genuine truthful state and must still be
    // shown immediately, and its later transition to "Saved" — driven by
    // a later, non-first snapshot once the backend acknowledges it, even
    // after a reconnect with zero new edits — must not be suppressed.
    if (isFirstSnapshot && !hasPendingWrites) return;
    if (hasPendingWrites) {
      setAutosaveStatus(navigator.onLine ? 'Saved — syncing…' : 'Saved locally — will sync when back online');
    } else if (!dirty && !noteDirty && !debounceTimer) {
      // No pending local write and nothing queued right now: the backend
      // has genuinely acknowledged the last edit.
      setAutosaveStatus('Saved');
    }
    // else: an edit is queued/debouncing and hasn't reached the local
    // cache yet — leave whatever status is currently showing rather than
    // claim "Saved" a moment before a newer edit supersedes it.
  });

  // Correction pass 4: fire the flush as early as the browser gives ANY
  // signal that this page may be going away — a real F5/reload, a tab
  // close, and (mobile) the app being backgrounded all reliably fire
  // `visibilitychange` to 'hidden', and a reload/close additionally fires
  // `pagehide` — both run to completion (including their own microtask
  // checkpoint) before the browsing context is actually torn down, so
  // calling `flushNow()` here hands any still-debounced edit to Firestore
  // immediately instead of leaving it waiting out the rest of the up-to-
  // `AUTOSAVE_DEBOUNCE_MS` window. Deliberately NOT `beforeunload`: it
  // cannot reliably run async work and is increasingly restricted by
  // browsers for exactly that reason (this pass's own spec calls that out).
  // This is a best-effort reduction of the loss window, not a hard
  // guarantee — no browser API can promise an in-flight async write
  // finishes before a page is discarded — but it removes the debounce
  // delay itself as an avoidable cause, which is the one gap that was
  // entirely within this app's control.
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') flushNow();
  }
  function onPageHide() {
    flushNow();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  const findExercise = (entryId) => workout.exercises.find((ex) => ex.entryId === entryId);
  const wasFinished = new Map(); // entryId → finished at the last refresh
  // v32: keep the phone's screen on while this workout is open (released when
  // leaving the logger — Finish/Skip navigate away, which runs this cleanup).
  const stopKeepingScreenOn = keepScreenOn(() => progressEl === null || progressEl.isConnected); // not yet rendered, or still on screen
  pendingHideCleanup = () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    unsubscribeLocalStatus();
    stopKeepingScreenOn();
  };

  root.innerHTML = renderWorkoutHtml(workout);
  progressEl = root.querySelector('#workout-progress'); // v32: this logger's own element — gone = logger gone
  addKgStepButtons();
  wireEvents();
  refreshProgress({ initial: true });
  // v29: "Last time" lines — loaded after the logger is already usable (never
  // delays it; nothing shown if unavailable, e.g. offline with nothing cached).
  getPreviousPerformance(uid, workout).then((prev) => showPreviousPerformance(root, prev));

  // Any exercise that needed its sets backfilled just now must be persisted
  // once, promptly — otherwise a refresh before the lifter touches anything
  // would regenerate (and could re-render, though not lose data) the same
  // rows again for no benefit.
  if (changed) queueSave(true);

  function findSet(setId) {
    for (const ex of workout.exercises) {
      const s = ex.sets.find((row) => row.setId === setId);
      if (s) return s;
    }
    return null;
  }

  // ── v32: progress, collapse, ±2.5 kg ─────────────────────────────────

  function setCollapsed(card, collapsed) {
    card.classList.toggle('is-collapsed', collapsed);
    card.querySelector('.exercise-head')?.setAttribute('aria-expanded', String(!collapsed));
  }

  /**
   * Updates "done/total" on every exercise and the workout total. An exercise
   * that BECOMES finished collapses (on first render: every finished one);
   * one the lifter re-opened stays open until it changes state again.
   */
  function refreshProgress({ initial = false, kind = 'action' } = {}) {
    root.querySelectorAll('.exercise-card.has-sets').forEach((card) => {
      const ex = findExercise(card.dataset.entryId);
      if (!ex) return;
      const p = exerciseProgress(ex);
      const count = card.querySelector('.exercise-count');
      if (count) count.textContent = `${p.done}/${p.total}`;
      const finished = isExerciseFinished(ex);
      card.classList.toggle('is-finished', finished);
      // Collapse only when nothing is left to type: a set just marked Failed
      // has its reps cleared and waits for the reps actually done.
      const ready = finished && !awaitsReps(ex);
      // never while typing (a tap — ✓ / Failed / Skip — finishes an exercise; typing doesn't fold it away under the fingers)
      if (ready && (initial || (kind === 'action' && wasFinished.get(ex.entryId) === false))) setCollapsed(card, true);
      wasFinished.set(ex.entryId, ready);
    });
    const total = workoutProgress(workout.exercises);
    const el = root.querySelector('#workout-progress');
    if (el) el.textContent = total.total ? `${total.done}/${total.total} sets` : '';
  }

  /** −2.5 / +2.5 under the kg field of every WORKING set that has a weight. */
  function addKgStepButtons() {
    root.querySelectorAll('.set-block[data-set-id]').forEach((blockEl) => {
      const set = findSet(blockEl.dataset.setId);
      const input = blockEl.querySelector('input.set-kg');
      // only where there IS a weight to adjust (a planned or typed kg) — not on
      // exercises the program leaves without a load ("—")
      if (!set || !input || set.kind === 'warmup') return;
      if (!Number.isFinite(set.plannedKg) && !Number.isFinite(set.actualKg)) return;
      const sub = document.createElement('div');
      sub.className = 'set-sub';
      sub.innerHTML = `
        <span class="set-adjust">
          <button type="button" class="btn-step" data-step="-${KG_STEP}" aria-label="${KG_STEP} kg less">−${KG_STEP}</button>
          <button type="button" class="btn-step" data-step="${KG_STEP}" aria-label="${KG_STEP} kg more">+${KG_STEP}</button>
        </span>`;
      blockEl.querySelector('.set-row')?.after(sub);
      sub.querySelectorAll('.btn-step').forEach((btn) => btn.addEventListener('click', () => {
        const typed = input.value === '' ? null : Number(input.value);
        input.value = String(stepKg(typed, set.plannedKg, Number(btn.dataset.step)));
        // the same path as typing: updates the set, its status and autosaves
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }));
    });
  }

  function wireEvents() {
    root.querySelectorAll('.exercise-head').forEach((head) => head.addEventListener('click', () => {
      const card = head.closest('.exercise-card');
      setCollapsed(card, !card.classList.contains('is-collapsed'));
    }));
    root.querySelectorAll('.set-block[data-set-id]').forEach((blockEl) => {
      const set = findSet(blockEl.dataset.setId);
      if (!set) return;
      // Typing gets the debounced save; taps (✓ / Failed / Skip) get prompt
      // persistence — same cadence split as before v1.1. v32: + progress.
      wireSetBlock(blockEl, set, (kind) => { queueSave(kind === 'action'); refreshProgress({ kind }); });
    });

    root.querySelector('#workout-note-input')?.addEventListener('input', (e) => {
      workout.notes = e.target.value.slice(0, MAX_WORKOUT_NOTE_LENGTH);
      queueSave(false, { noteOnly: true });
    });

    root.querySelector('#finish-btn')?.addEventListener('click', onFinish);
    root.querySelector('#skip-btn')?.addEventListener('click', onSkip);
  }

  /**
   * Phase 4.1 Goal A: classifies completion from the workout's OWN loggable
   * sets (js/utils/workoutCompletion.js — never inferred from display
   * names, never re-derived from a program/template) and, when it isn't
   * fully logged, shows an IN-APP confirmation panel — the same self-
   * contained "swap this card's own content, explicit Yes/Cancel buttons"
   * pattern js/views/profile.js's Restore flow already established,
   * chosen deliberately over `window.confirm()` (see this pass's spec) for
   * a mobile-friendlier, stylable prompt. Cancelling restores the plain
   * Finish button and changes nothing — the workout stays `in_progress`.
   */
  async function onFinish() {
    const panel = root.querySelector('#finish-panel');
    const { total, completed } = countLoggableSets(workout.exercises);
    const fullyLogged = total > 0 && completed === total;
    console.debug('[FINISH] workout.js onFinish: entered', { workoutId: workout.id, total, completed, fullyLogged });

    if (fullyLogged) {
      await doFinish(panel);
      return;
    }

    const isZero = completed === 0;
    const skipped = workout.exercises.flatMap((ex) => ex.sets ?? [])
      .filter((st) => resolveSetStatus(st) === SET_STATUS.SKIPPED).length;
    const skippedNote = skipped ? ` (${skipped} skipped)` : '';
    const message = isZero
      ? `No sets are marked as completed${skippedNote}. Finish anyway? It will be marked as Not Logged.`
      : `This workout has ${completed} of ${total} sets completed${skippedNote}. Finish anyway? It will be marked as Partial.`;
    console.debug('[FINISH] workout.js onFinish: confirmation required', { workoutId: workout.id, isZero, message });

    panel.innerHTML = `
      <p>${escapeHtml(message)}</p>
      <div class="btn-stack">
        <button type="button" class="btn btn-danger" id="finish-anyway-btn">Finish Anyway</button>
        <button type="button" class="btn btn-secondary" id="finish-cancel-btn">Cancel</button>
      </div>
      <p class="form-status" id="finish-status" role="status"></p>`;

    panel.querySelector('#finish-cancel-btn').addEventListener('click', () => {
      // Cancel: workout stays in_progress, nothing changes — just restore
      // the plain Finish button so the lifter can keep logging.
      panel.innerHTML = `
        <button type="button" class="btn btn-primary btn-large" id="finish-btn">FINISH WORKOUT</button>
        <p class="form-status" id="finish-status" role="status"></p>`;
      panel.querySelector('#finish-btn').addEventListener('click', onFinish);
    });
    panel.querySelector('#finish-anyway-btn').addEventListener('click', () => doFinish(panel));
  }

  async function doFinish(panel) {
    const btn = panel.querySelector('#finish-btn, #finish-anyway-btn');
    const status = panel.querySelector('#finish-status');
    if (btn) btn.disabled = true;
    panel.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    status.textContent = 'Finishing…';
    console.debug('[FINISH] workout.js doFinish: entered', { uid, workoutId: workout.id });
    try {
      await flushNow(); // make sure the last edits are durably queued first
      console.debug('[FINISH] workout.js doFinish: flush complete, invoking finishWorkout', { workoutId: workout.id });
      await finishWorkout(uid, workout);
      console.debug('[FINISH] workout.js doFinish: finishWorkout returned', { workoutId: workout.id });
      workout.status = 'completed';
      pendingFlush = null;
      // Phase 5A: the write above is already durably queued locally by this
      // point (Firestore's own offline persistence — see
      // finalizeInProgressWorkout's doc comment) even if the device is
      // offline right now; this just tells the lifter honestly that the
      // server sync itself is still pending, rather than implying it's
      // already confirmed there.
      status.textContent = navigator.onLine
        ? 'Workout completed.'
        : 'Workout completed — will sync when back online.';
      // v33: a short summary instead of jumping straight to Home.
      stopKeepingScreenOn();
      const finishedAt = new Date();
      let previous = [];
      try { previous = await listCompletedWorkouts(uid, SUMMARY_LOOKBACK); } catch { /* offline/cache miss: summary without PRs/comparison */ }
      // The lifter may have left this screen while history was loading: never
      // draw the summary over another screen.
      if (!progressEl?.isConnected) return;
      try {
        showFinishSummary(root, summarizeWorkout({ workout, previousWorkouts: previous, now: finishedAt, startedAtMs: sessionStartedAt }), workout, { offline: navigator.onLine === false });
      } catch (summaryErr) {
        // the workout IS finished — never leave it on a live logger
        console.error('[FINISH] summary failed, going Home', summaryErr);
        location.hash = '#/home';
      }
    } catch (err) {
      console.error('[FINISH] workout.js doFinish: caught error', err);
      status.textContent = `Error: ${err.message}`;
      panel.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  }

  /**
   * Correction pass — "Explicit Skip Workout Flow": a DELIBERATE abort of
   * the CURRENT in-progress workout, distinct from a manually-Finished
   * zero-set workout ("Not Logged" — see js/utils/workoutCompletion.js's
   * module comment for the full distinction this app now draws). Same
   * in-app confirmation-panel pattern as onFinish/profile.js's Restore flow
   * (never `window.confirm()`), with an optional reason textarea. Cancel
   * changes nothing: the workout stays `in_progress` and any sets already
   * logged are left exactly as they were — Skip never auto-checks or
   * deletes set data (see skipWorkout's own docstring for why Progress
   * still correctly excludes a skipped workout's data without needing
   * any of that).
   */
  function onSkip() {
    const panel = root.querySelector('#skip-panel');
    console.debug('[FINISH] workout.js onSkip: entered', { workoutId: workout.id });
    panel.innerHTML = `
      <p>Skip this workout?</p>
      <p class="text-muted">It will be recorded in History and the program will advance to the next workout.</p>
      <label class="field" style="margin-bottom: var(--space-3);">Reason for skipping (optional)
        <textarea id="skip-reason-input" rows="2" maxlength="300"></textarea>
      </label>
      <div class="btn-stack">
        <button type="button" class="btn btn-danger" id="skip-confirm-btn">Skip Workout</button>
        <button type="button" class="btn btn-secondary" id="skip-cancel-btn">Cancel</button>
      </div>
      <p class="form-status" id="skip-status" role="status"></p>`;

    panel.querySelector('#skip-cancel-btn').addEventListener('click', () => {
      // Cancel: workout stays in_progress, existing logged sets untouched —
      // just restore the plain Skip Workout button.
      panel.innerHTML = `<button type="button" class="btn btn-secondary" id="skip-btn">Skip Workout</button>`;
      panel.querySelector('#skip-btn').addEventListener('click', onSkip);
    });
    panel.querySelector('#skip-confirm-btn').addEventListener('click', () => doSkip(panel));
  }

  async function doSkip(panel) {
    const reason = panel.querySelector('#skip-reason-input')?.value ?? '';
    const status = panel.querySelector('#skip-status');
    panel.querySelectorAll('button, textarea').forEach((el) => { el.disabled = true; });
    status.textContent = 'Skipping…';
    console.debug('[FINISH] workout.js doSkip: entered', { uid, workoutId: workout.id });
    try {
      await flushNow(); // whatever was already logged stays in the snapshot, as-is
      console.debug('[FINISH] workout.js doSkip: flush complete, invoking skipWorkout', { workoutId: workout.id });
      await skipWorkout(uid, workout, reason);
      console.debug('[FINISH] workout.js doSkip: skipWorkout returned', { workoutId: workout.id });
      workout.status = 'completed';
      pendingFlush = null;
      // Phase 5A: same honest pending-sync note as doFinish above.
      status.textContent = navigator.onLine
        ? 'Workout skipped.'
        : 'Workout skipped — will sync when back online.';
      console.debug('[FINISH] workout.js doSkip: navigating to Home', { workoutId: workout.id });
      setTimeout(() => { location.hash = '#/home'; }, 600);
    } catch (err) {
      console.error('[FINISH] workout.js doSkip: caught error', err);
      status.textContent = `Error: ${err.message}`;
      panel.querySelectorAll('button, textarea').forEach((el) => { el.disabled = false; });
    }
  }
}
