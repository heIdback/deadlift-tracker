// v33 — "Program completed" card, shown by Home and Workout instead of a
// workout in a week that doesn't exist. Rules and the plan:
// js/utils/programCycle.js; the write: programSwitchService.startNewCycle.
import { getAllMaxHistory } from '../services/userService.js';
import { startNewCycle } from '../services/programSwitchService.js';
import { cycleComparison, CYCLE_LIFTS } from '../utils/programCycle.js';
import { escapeHtml } from '../utils/dom.js';
import { formatDate } from '../utils/dates.js';

const kg = (v) => (v == null ? '—' : `${v} kg`);
const delta = (d) => (d == null || d === 0 ? '' : ` <span class="${d > 0 ? 'cycle-up' : 'cycle-down'}">(${d > 0 ? '+' : '−'}${Math.abs(d)} kg)</span>`);

/**
 * Renders the card into `slot` and wires it. `onRestarted` runs after a new
 * cycle was started (callers re-render their screen).
 */
export async function mountProgramCompleteCard(slot, {
  uid, program, run, profile, onRestarted,
}) {
  let history = [];
  try { history = await getAllMaxHistory(uid); } catch { /* offline cache miss: "—" for the start values */ }
  const rows = cycleComparison({ history, run, currentMaxes: profile?.currentMaxes ?? {} });
  slot.innerHTML = `
    <div class="card card-primary program-complete" id="program-complete">
      <div class="card-label">Program completed${run?.programCompletedAt ? ` · ${escapeHtml(formatDate(run.programCompletedAt))}` : ''}</div>
      <h2 class="card-title">${escapeHtml(program?.name ?? 'Program')}</h2>
      <p>Every week is done. Your 1RMs at the start of this run and now:</p>
      <div class="cycle-table">
        <div class="cycle-row cycle-head"><span>Lift</span><span>Start</span><span>Now</span></div>
        ${rows.map((r) => `<div class="cycle-row"><span>${escapeHtml(r.label)}</span><span>${escapeHtml(kg(r.start))}</span><span>${escapeHtml(kg(r.now))}${delta(r.delta)}</span></div>`).join('')}
      </div>
      <div class="btn-stack">
        <button type="button" class="btn btn-primary" id="new-cycle-btn">Start a new cycle</button>
        <a class="btn btn-secondary" href="#/program" id="choose-program-link">Choose another program</a>
      </div>
      <div id="new-cycle-form" hidden></div>
      <p class="form-status" id="new-cycle-status" role="status"></p>
    </div>`;

  const form = slot.querySelector('#new-cycle-form');
  slot.querySelector('#new-cycle-btn').addEventListener('click', () => {
    form.hidden = false;
    form.innerHTML = `
      <p>Same program again from Week 1. Confirm or update your 1RMs — the loads are calculated from them:</p>
      <div class="form-grid">
        ${CYCLE_LIFTS.map((l) => `
          <label class="field">${escapeHtml(l.label)} (kg)
            <input type="number" inputmode="decimal" step="0.5" min="0" max="500" data-lift="${escapeHtml(l.id)}" value="${escapeHtml(profile?.currentMaxes?.[l.id]?.kg ?? '')}">
          </label>`).join('')}
      </div>
      <div class="btn-stack">
        <button type="button" class="btn btn-primary" id="new-cycle-confirm">Start Week 1</button>
        <button type="button" class="btn btn-secondary" id="new-cycle-cancel">Cancel</button>
      </div>`;
    form.querySelector('#new-cycle-cancel').addEventListener('click', () => { form.hidden = true; form.innerHTML = ''; });
    form.querySelector('#new-cycle-confirm').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      const status = slot.querySelector('#new-cycle-status');
      const newMaxes = Object.fromEntries([...form.querySelectorAll('input[data-lift]')].map((i) => [i.dataset.lift, i.value]));
      slot.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
      status.textContent = 'Starting the new cycle…';
      try {
        const r = await startNewCycle(uid, { run, program, newMaxes, currentMaxes: profile?.currentMaxes ?? {} });
        if (!r.ok) {
          status.textContent = r.message;
          slot.querySelectorAll('button, input').forEach((el) => { el.disabled = false; });
          return;
        }
        status.textContent = 'New cycle started.';
        try {
          await onRestarted?.();
        } catch (renderErr) {
          console.error('programCompleteCard: re-render failed', renderErr);
          status.textContent = 'New cycle started — reload the page to see Week 1.';
        }
        return;
      } catch (err) {
        console.error('programCompleteCard: new cycle failed', err);
        status.textContent = `Could not start the new cycle — nothing was changed. ${err.message}`;
        slot.querySelectorAll('button, input').forEach((el) => { el.disabled = false; });
      }
    });
  });
}
