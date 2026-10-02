import { getCurrentUser } from '../core/auth.js';
import { getUserProfile } from '../services/userService.js';
import { getPrimaryProgramContext, getProgramDays, startProgramRun } from '../services/programService.js';
import {
  resolveActiveWorkout, startOrResumeWorkoutForCurrentPosition,
  getLatestCompletedWorkout, countCompletedSince, reconcileLegacyProgramPosition,
} from '../services/workoutService.js';
import { getLatestBodyweight } from '../services/measurementService.js';
import { formatDate } from '../utils/dates.js';
import { escapeHtml } from '../utils/dom.js';
// v1.1: week count from the program's own `weeks` (an imported program need
// not be 8 weeks long) — the same helper Program view already uses.
import { totalWeeksOf } from '../utils/programEditModel.js';
import {
  loadHomeInsights, suggestionsHtml, goalCardHtml, wireInsights,
} from './homeInsights.js';

export async function mount(root) {
  const uid = getCurrentUser().uid;
  root.innerHTML = `<div class="loading-state" role="status">Loading dashboard…</div>`;

  const [profile, programCtx] = await Promise.all([
    getUserProfile(uid),
    getPrimaryProgramContext(uid),
  ]);

  const { program, multipleUnresolved } = programCtx;
  let run = programCtx.run;

  if (!program) {
    // Every approved user gets the starter program installed automatically
    // (see core/access.js -> ensureStarterProgramForUser, Phase 3E), so
    // reaching this branch means that install hasn't completed/succeeded
    // yet — not that the user needs to import anything themselves. This is
    // a defensive fallback, not the expected first-run experience.
    root.innerHTML = multipleUnresolved
      ? `
        <section class="empty-state">
          <h2>Multiple programs found</h2>
          <p>None is currently active. A program picker is coming in a later
          phase — for now, start one from Profile to make it active.</p>
          <a class="btn btn-primary" href="#/profile">Go to Profile</a>
        </section>`
      : `
        <section class="empty-state">
          <h2>Setting up your program…</h2>
          <p>This can take a moment on a slow connection. Try refreshing — if
          this keeps happening, contact an admin.</p>
        </section>`;
    return;
  }

  // resolveActiveWorkout, not a plain query — checks the local marker and
  // the programRun pointer first, so this agrees with what Start/Resume
  // itself will find (see js/services/workoutService.js).
  const inProgress = await resolveActiveWorkout(uid, run);
  // Self-heals a run stuck at an already-completed position from before
  // automatic advancement existed (Phase 3C). No-op once caught up, and
  // never runs while a workout is actually active.
  if (!inProgress) run = await reconcileLegacyProgramPosition(uid, run);

  const days = await getProgramDays(uid, program.id);
  const weekOfEight = run ? run.current.week : 1;
  const dayOrder = run ? run.current.dayOrder : 1;
  const nextDay = days.find((d) => d.order === dayOrder) ?? days[0];
  const weekMeta = program.weeks?.find((w) => w.week === weekOfEight);

  // "This Week" = current calendar week, Monday 00:00 local time through now
  // (not a rolling 7 days, not UTC midnight). Same local-midnight
  // construction as isEditableLocalWindow in js/utils/workoutCompletion.js.
  const now = new Date();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const [latestWorkout, bodyweight, completedThisWeek] = await Promise.all([
    getLatestCompletedWorkout(uid),
    getLatestBodyweight(uid),
    countCompletedSince(uid, weekStart),
  ]);

  // Never falls back to program.currentOneRepMaxesAtImport — that field is
  // the ORIGINAL importing user's own historical 1RM baked into the
  // packaged template JSON (see programService.js), not a sensible default
  // for whoever happens to be viewing this dashboard.
  const dlMax = profile?.currentMaxes?.deadlift?.kg ?? null;

  // v26: optional extras (suggested new 1RM + goal card). Advisory only — if
  // anything goes wrong reading history, Home renders exactly as before.
  let insights = null;
  try {
    insights = await loadHomeInsights({ uid, profile, program, week: weekOfEight });
  } catch (err) {
    console.warn('[HOME] insights unavailable', err);
  }

  root.innerHTML = `
    <section class="dashboard">
      <div class="card card-primary">
        <div class="card-label">Current Program</div>
        <h2 class="card-title">${escapeHtml(program.name)}</h2>
        <div class="card-sub">Week ${weekOfEight} / ${totalWeeksOf(program) || '—'}${weekMeta?.isDeload ? ' · Deload' : ''}${weekMeta?.isPrAttempt ? ' · PR attempt' : ''}</div>
      </div>

      <div class="card card-action">
        <div class="card-label">${inProgress ? 'Workout In Progress' : 'Next Workout'}</div>
        <h2 class="card-title">${inProgress ? escapeHtml(inProgress.dayName) || 'Resume session' : escapeHtml(nextDay?.name) || '—'}</h2>
        <button class="btn btn-primary btn-large" id="start-workout-btn">
          ${inProgress ? 'RESUME WORKOUT' : 'START WORKOUT'}
        </button>
        <p class="form-status" id="start-status" role="status"></p>
      </div>

      ${insights ? suggestionsHtml(insights.suggestions) : ''}

      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">Deadlift 1RM</div>
          <div class="stat-value">${dlMax != null ? `${dlMax} kg` : '—'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Latest Workout</div>
          <div class="stat-value">${latestWorkout ? formatDate(latestWorkout.finishedAt) : 'None yet'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Bodyweight</div>
          <div class="stat-value">${bodyweight ? `${bodyweight.value} kg` : '—'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">This Week</div>
          <div class="stat-value">${completedThisWeek} workout${completedThisWeek === 1 ? '' : 's'}</div>
        </div>
      </div>

      ${insights ? goalCardHtml(insights.goal) : ''}

      ${program.importReviewFlags?.length ? `
        <div class="card card-notice">
          <div class="card-label">Import needs your review</div>
          <ul class="notice-list">
            ${program.importReviewFlags.map((f) => `<li>${escapeHtml(f.exercise)} (${escapeHtml(f.day)})</li>`).join('')}
          </ul>
          <a class="btn btn-secondary" href="#/profile">Review in Profile</a>
        </div>` : ''}
    </section>
  `;

  if (insights) {
    try {
      wireInsights(root, { uid, insights, onChanged: () => mount(root) });
    } catch (err) {
      // Never let the optional cards stop the START WORKOUT button below from working.
      console.error('[HOME] insights wiring failed', err);
    }
  }

  root.querySelector('#start-workout-btn').addEventListener('click', async (e) => {
    const btn = e.target;
    // Correction pass 8: see js/views/workout.js's matching comment — a
    // disabled <button> still runs this handler for a raw/programmatic
    // click dispatch, so this explicit check (not just `btn.disabled = true`
    // below) is what stops a reentrant second invocation from double-firing
    // startProgramRun/startOrResumeWorkoutForCurrentPosition.
    if (btn.disabled) return;
    const status = root.querySelector('#start-status');
    btn.disabled = true;
    status.textContent = inProgress ? 'Resuming…' : 'Starting…';
    console.debug('[START] home.js click handler: entered', { uid, hasRun: !!run, programId: program.id });
    try {
      // Correction pass 3: pass the context this view ALREADY resolved to
      // render itself (program/run/days/profile) straight through, rather
      // than letting startOrResumeWorkoutForCurrentPosition re-fetch it —
      // see that function's own doc comment for why the re-fetch was the
      // real root cause of the offline "Starting…" hang. `run` may still be
      // null here (never started this program before); startProgramRun now
      // returns the full written run object so there's no follow-up read.
      const startRun = run ?? await startProgramRun(uid, program.id);
      console.debug('[START] home.js click handler: run resolved', { runId: startRun.id });
      const started = await startOrResumeWorkoutForCurrentPosition(uid, {
        run: startRun, program, days, profile,
      });
      console.debug('[START] home.js click handler: service returned, navigating to Workout', { workoutId: started.id });
      location.hash = '#/workout';
    } catch (err) {
      console.error('[START] home.js click handler: caught error', err);
      status.textContent = `Error: ${err.message}`;
      btn.disabled = false;
    }
  });
}
