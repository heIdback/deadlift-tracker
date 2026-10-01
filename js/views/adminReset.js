// Admin → user → "Reset training data". Two deliberate confirmations, then the
// server does the work (js/services/adminResetService.js → Cloud Function).
//
// Safety properties of this UI (the server enforces the important ones too):
//   - step state lives only in memory: refresh / Back / leaving the screen
//     always returns to the start — there is no URL that skips a step;
//   - step 1 (what will be reset / preserved, with counts) → Cancel changes nothing;
//   - step 2 requires typing the exact displayed string (case- and
//     whitespace-exact); RESET USER DATA stays disabled until it matches;
//   - one request per target at a time (in-flight guard + disabled button),
//     and the server additionally locks per target;
//   - success is shown ONLY from the server's confirmed result; any error
//     shows "did not complete" and never a success message.
import { getResetPreview, runAdminReset, expectedConfirmation } from '../services/adminResetService.js';
import { escapeHtml } from '../utils/dom.js';

const inFlight = new Set();

export function mountResetPanel(container, { targetUid, access, onReload }) {
  const who = escapeHtml(access?.displayName || access?.email || targetUid);
  const required = expectedConfirmation(access, targetUid);

  function idle(message = '') {
    container.innerHTML = `
      <div class="card card-danger admin-reset">
        <h3>Reset training data</h3>
        <p class="text-muted">Deletes this user's workout history, 1RM history and bodyweight log, and restarts their program at Week 1. Their account, access and programs are kept.</p>
        <button type="button" class="btn btn-secondary" id="reset-start-btn">Reset training data…</button>
        <p class="form-status" role="status">${escapeHtml(message)}</p>
      </div>`;
    container.querySelector('#reset-start-btn').addEventListener('click', step1);
  }

  async function step1() {
    container.innerHTML = '<div class="card card-danger admin-reset"><p class="text-muted" role="status">Checking what will be reset…</p></div>';
    let p;
    try {
      p = await getResetPreview(targetUid);
    } catch (err) {
      idle(`Could not load this user's data: ${err.message}`);
      return;
    }
    container.innerHTML = `
      <div class="card card-danger admin-reset" id="reset-step1">
        <h3>Reset training data?</h3>
        <div class="account-row"><span class="text-muted">User</span><strong class="import-meta">${who}</strong></div>
        <div class="account-row"><span class="text-muted">Email</span><strong class="import-meta">${escapeHtml(access?.email || '—')}</strong></div>
        <div class="account-row"><span class="text-muted">User id</span><strong class="import-meta">${escapeHtml(targetUid)}</strong></div>
        <h4>Will be permanently deleted or reset</h4>
        <ul class="notice-list">
          <li>Workouts: <strong>${p.workouts}</strong>${p.inProgressWorkouts ? ` (including ${p.inProgressWorkouts} in progress)` : ''} — completed, partial, skipped and not logged</li>
          <li>1RM history: <strong>${p.maxHistory}</strong> entries</li>
          <li>Bodyweight / measurements: <strong>${p.measurements}</strong></li>
          <li>Program progress: <strong>${p.programRuns}</strong> run(s) — ${p.activeProgram ? `“${escapeHtml(p.activeProgram.name)}” stays active and restarts at Week 1 / Day 1` : 'no active program; none will be started'}</li>
          <li>Current 1RMs: cleared — the user is asked for them at next sign-in</li>
          <li>PR cache and progression suggestions</li>
        </ul>
        <h4>Kept</h4>
        <ul class="notice-list">
          <li>Sign-in account, access status and role</li>
          <li>Name, email and settings</li>
          <li>All ${p.programs.length} program(s), including imported ones, unchanged</li>
        </ul>
        <p><strong>This cannot be undone</strong> (only a Backup My Data file the user downloaded earlier could restore it).</p>
        <div class="btn-stack">
          <button type="button" class="btn btn-secondary" id="reset-cancel-1">Cancel</button>
          <button type="button" class="btn btn-danger" id="reset-continue">Continue</button>
        </div>
      </div>`;
    container.querySelector('#reset-cancel-1').addEventListener('click', () => idle('Cancelled — nothing was changed.'));
    container.querySelector('#reset-continue').addEventListener('click', step2);
  }

  function step2() {
    container.innerHTML = `
      <div class="card card-danger admin-reset" id="reset-step2">
        <h3>Final confirmation</h3>
        <p>To reset <strong>${who}</strong>, type exactly:</p>
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
    container.querySelector('#reset-cancel-2').addEventListener('click', () => idle('Cancelled — nothing was changed.'));
    finalBtn.addEventListener('click', () => submit(input.value));
  }

  async function submit(typed) {
    if (typed !== required || inFlight.has(targetUid)) return;
    inFlight.add(targetUid);
    container.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    const status = container.querySelector('#reset-status');
    status.textContent = 'Resetting… keep this screen open.';
    try {
      const r = await runAdminReset(targetUid, typed);
      success(r);
    } catch (err) {
      failure(err);
    } finally {
      inFlight.delete(targetUid);
    }
  }

  function success(r) {
    container.innerHTML = `
      <div class="card card-primary admin-reset" id="reset-result" data-result="success">
        <h3>Training data reset</h3>
        <p>${who}'s training data was reset and confirmed by the server.</p>
        <ul class="notice-list">
          <li>Workouts removed: <strong>${r.removed.workouts}</strong></li>
          <li>1RM history entries removed: <strong>${r.removed.maxHistory}</strong></li>
          <li>Measurements removed: <strong>${r.removed.measurements}</strong></li>
          <li>Program runs replaced: <strong>${r.removed.programRuns}</strong></li>
          <li>Other records removed: <strong>${r.removed.records + r.removed.progressionSuggestions}</strong></li>
          <li>Active program: <strong>${r.activeProgram ? `${escapeHtml(r.activeProgram.name ?? r.activeProgram.id)} — Week ${r.position.week} / Day ${r.position.dayOrder}` : 'none'}</strong></li>
          <li>Current 1RMs: cleared — the user enters them at next sign-in</li>
        </ul>
        <button type="button" class="btn btn-secondary" id="reset-reload">Reload user</button>
      </div>`;
    container.querySelector('#reset-reload').addEventListener('click', () => onReload?.());
  }

  function failure(err) {
    container.innerHTML = `
      <div class="card card-danger admin-reset" id="reset-result" data-result="failure">
        <h3>Reset did NOT complete</h3>
        <p class="login-error">${escapeHtml(err.message)}</p>
        <p class="text-muted">This is not a success. Some records may already have been deleted. Running the reset again is safe and finishes the job.</p>
        <div class="btn-stack">
          <button type="button" class="btn btn-secondary" id="reset-again">Start again</button>
          <button type="button" class="btn btn-secondary" id="reset-reload">Reload user</button>
        </div>
      </div>`;
    container.querySelector('#reset-again').addEventListener('click', step1);
    container.querySelector('#reset-reload').addEventListener('click', () => onReload?.());
  }

  idle();
}
