// Admin → user → "Reset training data" (Spark/free plan — no Cloud Functions).
// The admin's app writes a reset REQUEST; the user's own app applies it the
// next time it is online (an admin resetting their own account: immediately).
// Model: js/utils/trainingReset.js.
//
// Safety properties of this UI:
//   - step state lives only in memory: refresh / Back / leaving the screen
//     always returns to the start — there is no URL that skips a step;
//   - step 1 (what will be reset / kept, with counts) → Cancel changes nothing;
//   - step 2 requires typing the exact displayed string (case- and
//     whitespace-exact); RESET USER DATA stays disabled until it matches;
//     the typed text is re-checked before saving and again by the user's app;
//   - one request at a time (in-flight guard + disabled controls);
//   - "requested"/"reset" is shown ONLY after the write is confirmed by the
//     server; any error shows that nothing was requested.
import {
  getResetPreview, getResetStatus, requestTrainingReset, cancelTrainingResetRequest, expectedConfirmation,
} from '../services/adminResetService.js';
import { getCurrentUser } from '../core/auth.js';
import { escapeHtml } from '../utils/dom.js';
import { formatDate } from '../utils/dates.js';

const inFlight = new Set();

function statusLine(status, who) {
  if (status.state === 'pending') {
    return `<p class="text-muted" id="reset-status-line" data-state="pending">Reset requested${status.request?.deleteBodyweight ? ' (including bodyweight log)' : ''} — waiting for ${who} to open the app online.</p>`;
  }
  if (status.state === 'invalid') {
    return `<p class="login-error" id="reset-status-line" data-state="invalid">The last reset request will not be applied: ${escapeHtml(status.reason ?? 'invalid request')} Request it again if it is still needed.</p>`;
  }
  if (status.applied?.appliedAt) {
    return `<p class="text-muted" id="reset-status-line" data-state="applied">Last reset applied ${escapeHtml(formatDate(status.applied.appliedAt))}.</p>`;
  }
  if (status.state === 'cancelled') return '<p class="text-muted" id="reset-status-line" data-state="cancelled">Last reset request was cancelled.</p>';
  return '';
}

export function mountResetPanel(container, { targetUid, access, onReload }) {
  const who = escapeHtml(access?.displayName || access?.email || targetUid);
  const required = expectedConfirmation(access, targetUid);
  const adminUid = () => getCurrentUser()?.uid;
  const isSelf = () => adminUid() === targetUid;
  let deleteBodyweight = false;

  async function idle(message = '') {
    let status = { state: 'none' };
    try { status = await getResetStatus(targetUid); } catch { /* offline — status unknown */ }
    const pending = status.state === 'pending';
    container.innerHTML = `
      <div class="card card-danger admin-reset">
        <h3>Reset training data</h3>
        <p class="text-muted">Starts this user over: workout and 1RM history are cleared from the app, current 1RMs are asked for again, and the active program restarts at Week 1. Account, access, settings and programs are kept.</p>
        ${statusLine(status, who)}
        ${pending
    ? '<button type="button" class="btn btn-secondary" id="reset-cancel-request">Cancel reset request</button>'
    : '<button type="button" class="btn btn-secondary" id="reset-start-btn">Reset training data…</button>'}
        <p class="form-status" role="status">${escapeHtml(message)}</p>
      </div>`;
    container.querySelector('#reset-start-btn')?.addEventListener('click', step1);
    container.querySelector('#reset-cancel-request')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await cancelTrainingResetRequest({ adminUid: adminUid(), targetUid });
        await idle('Reset request cancelled — nothing was changed.');
      } catch (err) {
        await idle(err.message);
      }
    });
  }

  async function step1() {
    container.innerHTML = '<div class="card card-danger admin-reset"><p class="text-muted" role="status">Checking what will be reset…</p></div>';
    let p;
    try {
      p = await getResetPreview(targetUid);
    } catch (err) {
      await idle(`Could not load this user's data: ${err.message}`);
      return;
    }
    container.innerHTML = `
      <div class="card card-danger admin-reset" id="reset-step1">
        <h3>Reset training data?</h3>
        <div class="account-row"><span class="text-muted">User</span><strong class="import-meta">${who}</strong></div>
        <div class="account-row"><span class="text-muted">Email</span><strong class="import-meta">${escapeHtml(access?.email || '—')}</strong></div>
        <div class="account-row"><span class="text-muted">User id</span><strong class="import-meta">${escapeHtml(targetUid)}</strong></div>
        <h4>Will be reset</h4>
        <ul class="notice-list">
          <li>Workouts: <strong>${p.workouts}</strong>${p.inProgressWorkouts ? ` (including ${p.inProgressWorkouts} in progress)` : ''} — completed, partial, skipped and not logged</li>
          <li>1RM history: <strong>${p.maxHistory}</strong> entries</li>
          <li>Program progress: ${p.activeProgram ? `“${escapeHtml(p.activeProgram.name)}” stays active and restarts at Week 1 / Day 1` : 'no active program; none will be started'}</li>
          <li>Current 1RMs: cleared — the user is asked for them again</li>
          <li>PR cache and progression suggestions</li>
        </ul>
        <p class="text-muted">Workout and 1RM history are archived, not erased: the app's security rules never allow deleting them, so they stay stored but are never shown again and are left out of backups.</p>
        <label class="reset-option"><input type="checkbox" id="reset-delete-bodyweight"${deleteBodyweight ? ' checked' : ''}> Also delete the bodyweight log (<strong>${p.measurements}</strong> entries) — optional</label>
        <h4>Kept</h4>
        <ul class="notice-list">
          <li>Sign-in account, access status and role</li>
          <li>Name, email, settings and training profile</li>
          <li>All ${p.programs.length} program(s), including imported ones, unchanged</li>
          <li>Bodyweight log, unless ticked above</li>
        </ul>
        <p class="text-muted">${isSelf() ? 'This is your own account — the reset is applied immediately.' : `Applied automatically the next time ${who} opens the app while online; until then you can cancel it.`}</p>
        <p><strong>This cannot be undone.</strong></p>
        <div class="btn-stack">
          <button type="button" class="btn btn-secondary" id="reset-cancel-1">Cancel</button>
          <button type="button" class="btn btn-danger" id="reset-continue">Continue</button>
        </div>
      </div>`;
    container.querySelector('#reset-delete-bodyweight').addEventListener('change', (e) => { deleteBodyweight = e.target.checked; });
    container.querySelector('#reset-cancel-1').addEventListener('click', () => { deleteBodyweight = false; idle('Cancelled — nothing was changed.'); });
    container.querySelector('#reset-continue').addEventListener('click', step2);
  }

  function step2() {
    container.innerHTML = `
      <div class="card card-danger admin-reset" id="reset-step2">
        <h3>Final confirmation</h3>
        <p>To reset <strong>${who}</strong>${deleteBodyweight ? ' <strong>and delete their bodyweight log</strong>' : ''}, type exactly:</p>
        <p class="reset-phrase"><code id="reset-required">${escapeHtml(required)}</code></p>
        <input type="text" id="reset-confirm-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Type the confirmation text">
        <div class="btn-stack">
          <button type="button" class="btn btn-danger" id="reset-final-btn" disabled>RESET USER DATA</button>
          <button type="button" class="btn btn-secondary" id="reset-cancel-2">Cancel</button>
        </div>
        <p class="form-status" id="reset-status" role="status"></p>
      </div>`;
    const input = container.querySelector('#reset-confirm-input');
    const finalBtn = container.querySelector('#reset-final-btn');
    input.addEventListener('input', () => { finalBtn.disabled = input.value !== required || inFlight.has(targetUid); });
    container.querySelector('#reset-cancel-2').addEventListener('click', () => { deleteBodyweight = false; idle('Cancelled — nothing was changed.'); });
    finalBtn.addEventListener('click', () => submit(input.value));
  }

  async function submit(typed) {
    if (typed !== required || inFlight.has(targetUid)) return;
    inFlight.add(targetUid);
    container.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    container.querySelector('#reset-status').textContent = isSelf() ? 'Resetting…' : 'Saving reset request…';
    try {
      const r = await requestTrainingReset({ adminUid: adminUid(), targetUid, confirmation: typed, deleteBodyweight });
      success(r);
    } catch (err) {
      failure(err);
    } finally {
      inFlight.delete(targetUid);
    }
  }

  function success(r) {
    const applied = r.mode === 'applied';
    const c = r.result?.counts;
    container.innerHTML = `
      <div class="card card-primary admin-reset" id="reset-result" data-result="success" data-mode="${r.mode}">
        <h3>${applied ? 'Training data reset' : 'Reset requested'}</h3>
        ${applied ? `
        <ul class="notice-list">
          <li>Workouts cleared: <strong>${c.workouts}</strong></li>
          <li>1RM history entries cleared: <strong>${c.maxHistory}</strong></li>
          <li>Bodyweight entries deleted: <strong>${c.bodyweight}</strong></li>
          <li>Active program: <strong>${r.result.activeProgram ? `${escapeHtml(r.result.activeProgram.name)} — Week ${r.result.position.week} / Day ${r.result.position.dayOrder}` : 'none'}</strong></li>
          <li>Current 1RMs: cleared — enter them again to continue</li>
        </ul>
        <p class="text-muted">Reloading…</p>` : `
        <p>Saved. ${who}'s app applies it automatically the next time it is opened online — their other devices switch over at the same time. You can cancel it until then.</p>`}
        <button type="button" class="btn btn-secondary" id="reset-reload">${applied ? 'Reload now' : 'Back to user'}</button>
      </div>`;
    container.querySelector('#reset-reload').addEventListener('click', () => (applied ? location.reload() : onReload?.()));
  }

  function failure(err) {
    container.innerHTML = `
      <div class="card card-danger admin-reset" id="reset-result" data-result="failure">
        <h3>Reset was NOT requested</h3>
        <p class="login-error">${escapeHtml(err.message)}</p>
        <div class="btn-stack">
          <button type="button" class="btn btn-secondary" id="reset-again">Start again</button>
          <button type="button" class="btn btn-secondary" id="reset-reload">Back to user</button>
        </div>
      </div>`;
    container.querySelector('#reset-again').addEventListener('click', step1);
    container.querySelector('#reset-reload').addEventListener('click', () => onReload?.());
  }

  idle();
}
