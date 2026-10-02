// v26 — the two optional cards on Home: "Suggested new 1RM" and "Deadlift goal".
//
// Everything here is advisory. Nothing changes a 1RM or a goal until the
// lifter presses the button on the card, and a failure to load (offline, no
// history yet) just means the cards are not shown — Home itself never depends
// on this module succeeding (js/views/home.js wraps the call in try/catch).
import { listCompletedWorkouts } from '../services/workoutService.js';
import { recordOneRepMax, setLiftGoal } from '../services/userService.js';
import { REQUIRED_STARTER_LIFTS } from '../utils/requiredLifts.js';
import { computeOneRmSuggestion, bestTestedKg, bestEstimatedKg } from '../utils/oneRmSuggestion.js';
import {
  computeGoalProgress, normalizeGoalKg, formatKg, nextPrAttempt,
} from '../utils/liftGoal.js';
import { toMillis } from '../utils/progressAnalytics.js';
import { escapeHtml } from '../utils/dom.js';
import { formatDate } from '../utils/dates.js';

// Newest completed workouts looked at. A 7-8 week block is ~30 sessions, so
// this comfortably covers the current block plus the one before it.
const HISTORY_WINDOW = 60;

// The one lift the goal card is about (the app is deadlift-focused).
const GOAL_LIFT = { id: 'deadlift', label: 'Deadlift' };

// ── "Not now" memory: per device, per lift, stores the suggested kg that was
// dismissed. A later, HIGHER suggestion shows again; the same one does not.
const dismissKey = (uid, exerciseId) => `dt:oneRmSuggestionDismissed:${uid}:${exerciseId}`;

function readDismissedKg(uid, exerciseId) {
  try {
    const raw = window.localStorage.getItem(dismissKey(uid, exerciseId));
    const n = raw == null ? null : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function writeDismissedKg(uid, exerciseId, kg) {
  try { window.localStorage.setItem(dismissKey(uid, exerciseId), String(kg)); } catch { /* storage unavailable — the card simply comes back next visit */ }
}

/**
 * Reads recent history once and derives both cards' data.
 * @returns {{suggestions: Array, goal: object}}
 */
export async function loadHomeInsights({ uid, profile, program, week }) {
  let workouts = [];
  try {
    workouts = await listCompletedWorkouts(uid, HISTORY_WINDOW);
  } catch (err) {
    console.warn('[HOME] insights: could not read workout history', err);
  }

  const suggestions = [];
  for (const lift of REQUIRED_STARTER_LIFTS) {
    const cur = profile?.currentMaxes?.[lift.id];
    const suggestion = computeOneRmSuggestion({
      completedWorkouts: workouts,
      exerciseId: lift.id,
      currentKg: cur?.kg ?? null,
      sinceMillis: toMillis(cur?.updatedAt),
    });
    if (!suggestion) continue;
    const dismissed = readDismissedKg(uid, lift.id);
    if (dismissed != null && suggestion.suggestedKg <= dismissed) continue;
    suggestions.push({ ...suggestion, label: lift.label });
  }

  const goalKg = normalizeGoalKg(profile?.goals?.[GOAL_LIFT.id]);
  const currentKg = profile?.currentMaxes?.[GOAL_LIFT.id]?.kg ?? null;
  const goal = {
    exerciseId: GOAL_LIFT.id,
    label: GOAL_LIFT.label,
    goalKg,
    currentKg,
    progress: goalKg != null ? computeGoalProgress({ goalKg, currentKg }) : null,
    bestTested: bestTestedKg(workouts, GOAL_LIFT.id),
    bestEstimated: bestEstimatedKg(workouts, GOAL_LIFT.id),
    prAttempt: nextPrAttempt(program?.weeks, week),
  };

  return { suggestions, goal };
}

// ── Suggestion cards ─────────────────────────────────────────────────────

function evidenceText(s) {
  const when = s.finishedAtMillis ? ` on ${formatDate(s.finishedAtMillis)}` : '';
  return s.basis === 'tested'
    ? `You lifted ${formatKg(s.fromKg)} kg for a single${when}.`
    : `You did ${formatKg(s.fromKg)} kg × ${s.fromReps}${when} — that points to about ${formatKg(s.suggestedKg)} kg (an estimate, not a tested max).`;
}

export function suggestionsHtml(suggestions) {
  return (suggestions ?? []).map((s) => `
    <div class="card card-notice one-rm-suggestion" data-lift="${escapeHtml(s.exerciseId)}">
      <div class="card-label">Suggested new 1RM</div>
      <h2 class="card-title">${escapeHtml(s.label)}: ${escapeHtml(formatKg(s.suggestedKg))} kg</h2>
      <p class="text-muted">Your profile says ${escapeHtml(formatKg(s.currentKg))} kg. ${escapeHtml(evidenceText(s))}</p>
      <p class="text-muted">If you accept, percentage-based loads in your next workouts use the new number. Finished workouts are not changed, and you can edit it any time in Profile.</p>
      <div class="btn-stack">
        <button type="button" class="btn btn-primary" data-act="accept">Update 1RM to ${escapeHtml(formatKg(s.suggestedKg))} kg</button>
        <button type="button" class="btn btn-secondary" data-act="dismiss">Not now</button>
      </div>
      <p class="form-status" data-role="status" role="status"></p>
    </div>`).join('');
}

// ── Goal card ────────────────────────────────────────────────────────────

function prAttemptText(pr) {
  if (!pr) return '';
  if (pr.weeksAway === 0) return `PR attempt: Week ${pr.week} — this week`;
  if (pr.weeksAway === 1) return `PR attempt: Week ${pr.week} — next week`;
  return `PR attempt: Week ${pr.week} — in ${pr.weeksAway} weeks`;
}

function goalFormHtml(goal, { hidden }) {
  return `
    <form id="goal-form" class="goal-form"${hidden ? ' hidden' : ''}>
      <label class="field">${escapeHtml(goal.label)} goal (kg)
        <input type="text" inputmode="decimal" name="goal" autocomplete="off" placeholder="e.g. 210" value="${escapeHtml(goal.goalKg != null ? formatKg(goal.goalKg) : '')}">
      </label>
      <div class="btn-stack">
        <button type="submit" class="btn btn-primary" id="goal-save-btn">Save goal</button>
        ${goal.goalKg != null ? '<button type="button" class="btn btn-secondary" id="goal-clear-btn">Remove goal</button>' : ''}
        ${goal.goalKg != null ? '<button type="button" class="btn btn-secondary" id="goal-cancel-btn">Cancel</button>' : ''}
      </div>
    </form>`;
}

export function goalCardHtml(goal) {
  if (goal.goalKg == null) {
    return `
      <div class="card goal-card" id="goal-card">
        <div class="card-label">${escapeHtml(goal.label)} goal</div>
        <p class="text-muted">Set a goal and this card shows how far you are from it.</p>
        ${goalFormHtml(goal, { hidden: false })}
        <p class="form-status" id="goal-status" role="status"></p>
      </div>`;
  }
  const p = goal.progress;
  const body = p
    ? `
        <div class="goal-headline"><strong>${escapeHtml(formatKg(p.currentKg))}</strong> / ${escapeHtml(formatKg(p.goalKg))} kg</div>
        <div class="goal-bar" role="progressbar" aria-label="${escapeHtml(goal.label)} progress to goal" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}">
          <div class="goal-bar-fill" style="width:${p.percent}%"></div>
        </div>
        <p class="goal-remaining">${p.reached ? 'Goal reached — time to set a new one?' : `${escapeHtml(formatKg(p.remainingKg))} kg to go`}</p>`
    : `
        <div class="goal-headline">Goal: <strong>${escapeHtml(formatKg(goal.goalKg))} kg</strong></div>
        <p class="text-muted">Add your current ${escapeHtml(goal.label)} 1RM in Profile to see your progress.</p>`;
  const evidence = [
    goal.bestTested != null ? `Best tested single: ${formatKg(goal.bestTested)} kg` : '',
    goal.bestEstimated != null ? `Best estimate: ≈ ${formatKg(goal.bestEstimated)} kg` : '',
  ].filter(Boolean).join(' · ');
  const pr = prAttemptText(goal.prAttempt);
  return `
      <div class="card goal-card" id="goal-card">
        <div class="card-label">${escapeHtml(goal.label)} goal</div>
        ${body}
        ${evidence ? `<p class="text-muted">${escapeHtml(evidence)}</p>` : ''}
        ${pr ? `<p class="text-muted">${escapeHtml(pr)}</p>` : ''}
        <button type="button" class="btn btn-secondary" id="goal-edit-btn">Change goal</button>
        ${goalFormHtml(goal, { hidden: true })}
        <p class="form-status" id="goal-status" role="status"></p>
      </div>`;
}

// ── Wiring ───────────────────────────────────────────────────────────────

const OFFLINE_MESSAGE = "You're offline — try again when you're connected.";

/**
 * @param {HTMLElement} root   the Home root
 * @param {{uid:string, insights:{suggestions:Array, goal:object}, onChanged:()=>void}} ctx
 *        onChanged re-renders Home after a successful save.
 */
export function wireInsights(root, { uid, insights, onChanged }) {
  // Suggestion cards
  root.querySelectorAll('.one-rm-suggestion').forEach((card) => {
    const suggestion = insights.suggestions.find((s) => s.exerciseId === card.dataset.lift);
    if (!suggestion) return;
    const status = card.querySelector('[data-role="status"]');
    const buttons = () => card.querySelectorAll('button');

    card.querySelector('[data-act="dismiss"]').addEventListener('click', () => {
      writeDismissedKg(uid, suggestion.exerciseId, suggestion.suggestedKg);
      card.remove();
    });

    card.querySelector('[data-act="accept"]').addEventListener('click', async (e) => {
      if (e.currentTarget.disabled) return; // a raw click still reaches a disabled button's handler
      if (!navigator.onLine) { status.textContent = OFFLINE_MESSAGE; return; }
      buttons().forEach((b) => { b.disabled = true; });
      status.textContent = 'Saving…';
      try {
        await recordOneRepMax(uid, {
          exerciseId: suggestion.exerciseId,
          kg: suggestion.suggestedKg,
          kind: suggestion.basis === 'tested' ? 'tested' : 'training',
          source: suggestion.workoutId ? `workout:${suggestion.workoutId}` : 'manual',
        });
        onChanged();
      } catch (err) {
        console.error(err);
        status.textContent = `Error: ${err.message}`;
        buttons().forEach((b) => { b.disabled = false; });
      }
    });
  });

  // Goal card
  const goalCard = root.querySelector('#goal-card');
  if (!goalCard) return;
  const form = goalCard.querySelector('#goal-form');
  const status = goalCard.querySelector('#goal-status');
  const editBtn = goalCard.querySelector('#goal-edit-btn');
  const goal = insights.goal;

  editBtn?.addEventListener('click', () => {
    form.hidden = false;
    editBtn.hidden = true;
    form.elements.goal.focus();
  });
  goalCard.querySelector('#goal-cancel-btn')?.addEventListener('click', () => {
    form.hidden = true;
    editBtn.hidden = false;
    status.textContent = '';
  });

  async function save(kgOrNull) {
    if (!navigator.onLine) { status.textContent = OFFLINE_MESSAGE; return; }
    form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    status.textContent = 'Saving…';
    try {
      await setLiftGoal(uid, goal.exerciseId, kgOrNull);
      onChanged();
    } catch (err) {
      console.error(err);
      status.textContent = `Error: ${err.message}`;
      form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const kg = normalizeGoalKg(form.elements.goal.value);
    if (kg == null) { status.textContent = 'Enter a goal between 20 and 500 kg.'; return; }
    save(kg);
  });
  goalCard.querySelector('#goal-clear-btn')?.addEventListener('click', () => save(null));
}
