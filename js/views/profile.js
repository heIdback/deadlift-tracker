import { getCurrentUser } from '../core/auth.js';
import { getAccessState } from '../core/access.js';
import { getUserProfile, recordOneRepMax } from '../services/userService.js';
import { getPrimaryProgramContext } from '../services/programService.js';
import { logBodyweight, getLatestBodyweight } from '../services/measurementService.js';
import {
  buildUserDataExport, flattenWorkoutsForCsv, flattenMeasurementsForCsv, flattenMaxHistoryForCsv,
} from '../services/exportService.js';
import { parseAndValidateBackupFile, restoreUserData } from '../services/restoreService.js';
import { buildCsv } from '../utils/csv.js';
import { downloadJson, downloadCsv } from '../utils/download.js';
import { isoOrEmpty } from '../utils/exportSerialize.js';
import { isValidWeight } from '../utils/validation.js';
import { REQUIRED_STARTER_LIFTS } from '../utils/requiredLifts.js';
import { escapeHtml, safeUrl } from '../utils/dom.js';
import { formatDate } from '../utils/dates.js';
import { APP_META } from '../../config/app.config.js';

const WORKOUT_CSV_COLUMNS = [
  { key: 'workoutId', header: 'workoutId' },
  { key: 'status', header: 'status' },
  { key: 'startedAt', header: 'startedAt' },
  { key: 'finishedAt', header: 'finishedAt' },
  { key: 'programId', header: 'programId' },
  { key: 'week', header: 'week' },
  { key: 'dayOrder', header: 'dayOrder' },
  { key: 'dayName', header: 'dayName' },
  { key: 'exerciseId', header: 'exerciseId' },
  { key: 'exerciseName', header: 'exerciseName' },
  { key: 'setId', header: 'setId' },
  { key: 'setNumber', header: 'setNumber' },
  { key: 'kind', header: 'kind' },
  { key: 'plannedKg', header: 'plannedKg' },
  { key: 'actualKg', header: 'actualKg' },
  { key: 'plannedReps', header: 'plannedReps' },
  { key: 'actualReps', header: 'actualReps' },
  { key: 'durationSec', header: 'durationSec' },
  { key: 'rpe', header: 'rpe' },
  { key: 'note', header: 'note' },
  { key: 'completed', header: 'completed' },
  { key: 'setStatus', header: 'setStatus' },
  { key: 'completedAt', header: 'completedAt' },
];

const MEASUREMENT_CSV_COLUMNS = [
  { key: 'id', header: 'id' },
  { key: 'type', header: 'type' },
  { key: 'value', header: 'value' },
  { key: 'unit', header: 'unit' },
  { key: 'date', header: 'date' },
  { key: 'note', header: 'note' },
];

const MAX_HISTORY_CSV_COLUMNS = [
  { key: 'id', header: 'id' },
  { key: 'exerciseId', header: 'exerciseId' },
  { key: 'kg', header: 'kg' },
  { key: 'kind', header: 'kind' },
  { key: 'source', header: 'source' },
  { key: 'effectiveDate', header: 'effectiveDate' },
];

// Timestamp fields in a flattened CSV row arrive in the export's
// {_type:'timestamp', iso, seconds, nanoseconds} shape — converted to a
// plain ISO string here before they reach the CSV builder (buildCsv/
// csvEscape has no reason to know about that shape).
function flattenTimestampFields(row, fields) {
  const out = { ...row };
  for (const f of fields) out[f] = isoOrEmpty(row[f]);
  return out;
}

// Same shared list the new-user onboarding gate uses (utils/requiredLifts.js)
// — kept as ONE list so they can never drift apart.
const LIFTS = REQUIRED_STARTER_LIFTS;

function formatRoleLabel(role) {
  return role === 'admin' ? 'Admin' : 'User';
}

function formatStatusLabel(status) {
  switch (status) {
    case 'approved': return 'Approved';
    case 'pending': return 'Pending';
    case 'disabled': return 'Disabled';
    default: return '—';
  }
}

// Data-quality notice for a handful of exercise mappings the packaged
// program's original normalization couldn't resolve with full confidence
// (see data/import-mapping.json) — kept regardless of the Phase 3E import
// UI removal below, since this is about the PROGRAM'S content, not a
// user-facing import action. Silent (renders nothing) once there's
// nothing left to flag.
function renderReviewFlags(program) {
  if (!program?.importReviewFlags?.length) return '';
  return `
    <div class="card-notice">
      <p><strong>Flagged for your review</strong>:</p>
      <ul class="notice-list">
        ${program.importReviewFlags.map((f) => `<li>${escapeHtml(f.exercise)} — ${escapeHtml(f.day)}${f.rawText ? ` (raw: "${escapeHtml(f.rawText)}")` : ''}</li>`).join('')}
      </ul>
    </div>`;
}

export async function mount(root) {
  const uid = getCurrentUser().uid;
  root.innerHTML = `<div class="loading-state" role="status">Loading profile…</div>`;

  const [profile, programCtx, bodyweight] = await Promise.all([
    getUserProfile(uid),
    getPrimaryProgramContext(uid),
    getLatestBodyweight(uid),
  ]);

  // getPrimaryProgramContext resolves deterministically (active programRun's
  // program, or the sole existing program, or null) rather than assuming
  // Firestore's first returned document is "the" program.
  const { program: currentProgram, multipleUnresolved } = programCtx;

  const photo = profile?.photoURL ? safeUrl(profile.photoURL) : '';

  // Reuses the access state core/access.js already resolved at sign-in/
  // startup (see router.js — this view only ever mounts once that
  // resolution is 'approved') — no extra Firestore read here. Informational
  // only: nothing on this screen writes to `/access/{uid}`, so a user has
  // no way to edit their own role/status from Profile.
  const { record: accessRecord } = getAccessState();

  root.innerHTML = `
    <section class="profile">
      <div class="profile-header">
        ${photo ? `<img class="avatar" src="${escapeHtml(photo)}" alt="" width="56" height="56">` : ''}
        <div>
          <h2>${escapeHtml(profile?.displayName) || 'Athlete'}</h2>
          <p class="text-muted">${escapeHtml(profile?.email)}</p>
        </div>
      </div>

      <div class="card">
        <h3>Account</h3>
        <div class="account-row"><span class="text-muted">Role</span><strong>${escapeHtml(formatRoleLabel(accessRecord?.role))}</strong></div>
        <div class="account-row"><span class="text-muted">Status</span><strong>${escapeHtml(formatStatusLabel(accessRecord?.status))}</strong></div>
        <p class="text-muted">Informational only — set by an administrator, not editable here.</p>
      </div>

      <div class="card">
        <h3>Current 1RM values</h3>
        <p class="text-muted">Editable here. Changing a value never alters a completed workout's saved calculation basis.</p>
        <form id="maxes-form" class="form-grid">
          ${LIFTS.map((l) => `
            <label class="field">
              <span>${escapeHtml(l.label)} (kg)</span>
              <input type="number" inputmode="decimal" step="0.5" min="0" max="500"
                name="${l.id}" value="${escapeHtml(profile?.currentMaxes?.[l.id]?.kg ?? '')}" placeholder="e.g. 205">
            </label>`).join('')}
        </form>
        <button class="btn btn-primary" id="save-maxes-btn">Save 1RM values</button>
        <p class="form-status" id="maxes-status" role="status"></p>
      </div>

      <div class="card">
        <h3>Bodyweight</h3>
        <p class="text-muted" id="bw-latest">Latest: ${bodyweight ? `${escapeHtml(bodyweight.value)} kg` : 'not logged yet'}</p>
        <form id="bw-form" class="form-row">
          <input type="number" inputmode="decimal" step="0.1" min="0" max="400" name="bw" placeholder="kg" required>
          <button class="btn btn-secondary" type="submit">Log</button>
        </form>
        <p class="form-status" id="bw-status" role="status"></p>
      </div>

      <div class="card">
        <h3>Training program</h3>
        ${currentProgram ? `
          <p>Active: <strong>${escapeHtml(currentProgram.name)}</strong></p>
          ${renderReviewFlags(currentProgram)}
        ` : multipleUnresolved ? `
          <p class="text-muted">Multiple programs exist with no active run. Start one from the Dashboard to make it active.</p>
        ` : `
          <p class="text-muted">Setting up your program… try refreshing in a moment.</p>
        `}
      </div>

      <div class="card">
        <h3>Backup &amp; Data</h3>
        <p class="text-muted">
          Download a backup of your Deadlift Tracker data. Keep the JSON file somewhere
          safe so it can be used for recovery in the future. CSV exports are provided for
          viewing or analysis in spreadsheet apps.
        </p>
        <div class="btn-stack">
          <button class="btn btn-secondary" id="backup-json-btn">Backup My Data (JSON)</button>
          <button class="btn btn-secondary" id="export-workouts-csv-btn">Export Workouts CSV</button>
          <button class="btn btn-secondary" id="export-measurements-csv-btn">Export Measurements CSV</button>
          <button class="btn btn-secondary" id="export-maxes-csv-btn">Export Max History CSV</button>
        </div>
        <p class="form-status" id="export-status" role="status"></p>
      </div>

      <div class="card card-danger">
        <h3>Restore My Data (JSON)</h3>
        <p class="text-muted">
          Restore your current training state — program, program progress, current maxes,
          and measurements — from a backup file you downloaded earlier from this same screen.
          Completed workout history and max-history records already saved to your account are
          preserved, never deleted. Your login and access permissions are never changed by a
          restore.
        </p>
        <div id="restore-panel"></div>
      </div>

      <p class="about-line">${escapeHtml(APP_META.name)} ${escapeHtml(APP_META.version)} · by ${escapeHtml(APP_META.publisher)}</p>
    </section>
  `;

  root.querySelector('#save-maxes-btn').addEventListener('click', async () => {
    const status = root.querySelector('#maxes-status');
    const form = root.querySelector('#maxes-form');
    const btn = root.querySelector('#save-maxes-btn');
    btn.disabled = true;
    status.textContent = 'Saving…';
    try {
      const entries = LIFTS.map((l) => [l.id, form.elements[l.id].value]).filter(([, v]) => v !== '');
      for (const [exerciseId, raw] of entries) {
        const kg = Number(raw);
        if (!isValidWeight(kg)) throw new Error(`Invalid weight for ${exerciseId}.`);
        await recordOneRepMax(uid, { exerciseId, kg, kind: 'training', source: 'manual' });
      }
      status.textContent = 'Saved.';
    } catch (err) {
      console.error(err);
      status.textContent = `Error: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelector('#bw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = root.querySelector('#bw-status');
    const kg = Number(e.target.elements.bw.value);
    try {
      const logged = await logBodyweight(uid, { kg });
      status.textContent = 'Logged.';
      // Update the UI immediately from the write's own result — no re-fetch,
      // no duplicate write.
      root.querySelector('#bw-latest').textContent = `Latest: ${logged.value} kg`;
      e.target.reset();
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  });

  // ── Backup & Data exports (Phase 3D, wording/scope updated Phase 3E) ──
  // All four buttons share one small pattern: disable while working, show
  // a status line, re-enable on completion or error. Each export re-reads
  // Firestore fresh (via buildUserDataExport) rather than reusing anything
  // already rendered on this page, so it always reflects current data, not
  // a stale in-memory copy — this view doesn't hold a reference to the raw
  // profile/program/workout data long enough for that to matter anyway.
  async function withExportStatus(btn, workingLabel, fn) {
    const status = root.querySelector('#export-status');
    const allButtons = root.querySelectorAll('#backup-json-btn, #export-workouts-csv-btn, #export-measurements-csv-btn, #export-maxes-csv-btn');
    allButtons.forEach((b) => { b.disabled = true; });
    status.textContent = workingLabel;
    try {
      await fn();
      status.textContent = 'Done — check your downloads.';
    } catch (err) {
      console.error(err);
      status.textContent = `Export failed: ${err.message}`;
    } finally {
      allButtons.forEach((b) => { b.disabled = false; });
    }
  }

  const dateStamp = () => new Date().toISOString().slice(0, 10);

  root.querySelector('#backup-json-btn').addEventListener('click', (e) => withExportStatus(e.target, 'Preparing backup…', async () => {
    const exportData = await buildUserDataExport(getCurrentUser());
    downloadJson(`deadlift-tracker-export-${dateStamp()}.json`, exportData);
  }));

  root.querySelector('#export-workouts-csv-btn').addEventListener('click', (e) => withExportStatus(e.target, 'Preparing CSV…', async () => {
    const exportData = await buildUserDataExport(getCurrentUser());
    const rows = flattenWorkoutsForCsv(exportData).map((r) => flattenTimestampFields(r, ['startedAt', 'finishedAt', 'completedAt']));
    downloadCsv(`deadlift-tracker-workouts-${dateStamp()}.csv`, buildCsv(WORKOUT_CSV_COLUMNS, rows));
  }));

  root.querySelector('#export-measurements-csv-btn').addEventListener('click', (e) => withExportStatus(e.target, 'Preparing CSV…', async () => {
    const exportData = await buildUserDataExport(getCurrentUser());
    const rows = flattenMeasurementsForCsv(exportData).map((r) => flattenTimestampFields(r, ['date']));
    downloadCsv(`deadlift-tracker-measurements-${dateStamp()}.csv`, buildCsv(MEASUREMENT_CSV_COLUMNS, rows));
  }));

  root.querySelector('#export-maxes-csv-btn').addEventListener('click', (e) => withExportStatus(e.target, 'Preparing CSV…', async () => {
    const exportData = await buildUserDataExport(getCurrentUser());
    const rows = flattenMaxHistoryForCsv(exportData).map((r) => flattenTimestampFields(r, ['effectiveDate']));
    downloadCsv(`deadlift-tracker-max-history-${dateStamp()}.csv`, buildCsv(MAX_HISTORY_CSV_COLUMNS, rows));
  }));

  // ── Restore My Data (JSON) (Phase 3F) ─────────────────────────────────
  // A small three-state mini-view rendered entirely inside #restore-panel,
  // never a silent restore-on-file-selection: choose file -> parse+
  // validate locally and show a summary + explicit confirm/cancel ->
  // (only on confirm) perform the restore -> show success/failure. Every
  // state re-render below fully replaces #restore-panel's innerHTML and
  // re-attaches its own listeners, the same self-contained pattern
  // admin.js's loadAndRender() already uses.
  const restorePanel = root.querySelector('#restore-panel');

  // Phase 4 polish item (carried over from the Phase 3F backlog): a failed
  // parse/validate always shows this one concise, normal-gym-user-friendly
  // headline rather than a raw thrown Error message (which can be a JSON
  // syntax error or a multi-line list of schema problems) — the detailed
  // reason is still available, just tucked into a collapsed <details> so it
  // doesn't dump a developer-style paragraph into the main UI.
  const GENERIC_INVALID_BACKUP_MESSAGE = 'This is not a valid Deadlift Tracker backup file.';

  function renderChooseFileState(message = '', detail = '') {
    restorePanel.innerHTML = `
      <div class="btn-stack">
        <input type="file" accept="application/json,.json" id="restore-file-input" style="display:none">
        <button type="button" class="btn btn-secondary" id="restore-choose-btn">Choose Backup File…</button>
      </div>
      <p class="form-status" id="restore-status" role="status">${escapeHtml(message)}</p>
      ${detail ? `<details class="text-muted"><summary>Details</summary><p>${escapeHtml(detail)}</p></details>` : ''}`;

    restorePanel.querySelector('#restore-choose-btn').addEventListener('click', () => {
      restorePanel.querySelector('#restore-file-input').click();
    });
    restorePanel.querySelector('#restore-file-input').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const status = restorePanel.querySelector('#restore-status');
      status.textContent = 'Reading and validating file…';
      try {
        const { backup, summary } = await parseAndValidateBackupFile(file);
        renderConfirmState(backup, summary);
      } catch (err) {
        console.error(err);
        renderChooseFileState(GENERIC_INVALID_BACKUP_MESSAGE, err.message);
      }
    });
  }

  function renderConfirmState(backup, summary) {
    restorePanel.innerHTML = `
      <div class="card-notice">
        <p><strong>Backup date:</strong> ${escapeHtml(summary.exportedAt ? formatDate(new Date(summary.exportedAt)) : 'unknown')}</p>
        <ul class="notice-list">
          <li>Programs: ${escapeHtml(summary.programs)}</li>
          <li>Workouts: ${escapeHtml(summary.workouts)}</li>
          <li>Max history entries: ${escapeHtml(summary.maxHistory)}</li>
          <li>Measurements: ${escapeHtml(summary.measurements)}</li>
          <li>Program runs: ${escapeHtml(summary.programRuns)}</li>
        </ul>
      </div>
      <p><strong>Your current training state will be restored from this backup. Completed
      workout history and max-history records already saved to your account are preserved.
      Login and access permissions are not changed.</strong></p>
      <div class="btn-stack">
        <button type="button" class="btn btn-danger" id="restore-confirm-btn">Yes, restore my data</button>
        <button type="button" class="btn btn-secondary" id="restore-cancel-btn">Cancel</button>
      </div>
      <p class="form-status" id="restore-status" role="status"></p>`;

    restorePanel.querySelector('#restore-cancel-btn').addEventListener('click', () => renderChooseFileState());
    restorePanel.querySelector('#restore-confirm-btn').addEventListener('click', async () => {
      const status = restorePanel.querySelector('#restore-status');
      restorePanel.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      status.textContent = 'Restoring… this can take a moment.';
      try {
        const result = await restoreUserData(getCurrentUser(), backup);
        renderResultState(result);
      } catch (err) {
        console.error(err);
        status.textContent = `Restore failed: ${err.message}`;
        restorePanel.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    });
  }

  function renderResultState(result) {
    const warningsHtml = result.warnings?.length
      ? `<div class="card-notice"><p><strong>Notes:</strong></p><ul class="notice-list">${result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
      : '';

    if (!result.ok) {
      restorePanel.innerHTML = `
        <p class="login-error">Restore did not complete: ${escapeHtml(result.error)}</p>
        <p class="text-muted">${escapeHtml(result.chunksCommitted)} of ${escapeHtml(result.chunksTotal)} batches were saved before the error.
        It is safe to try again with the same file — already-restored data will not be duplicated.</p>
        ${warningsHtml}
        <button type="button" class="btn btn-secondary" id="restore-retry-btn">Choose a file again</button>`;
      restorePanel.querySelector('#restore-retry-btn').addEventListener('click', () => renderChooseFileState());
      return;
    }

    restorePanel.innerHTML = `
      <p class="form-status">Restore complete. Your training state now reflects this backup.
      Completed workout history and max-history records already saved to your account were
      preserved, not overwritten. Login and access permissions were not changed.</p>
      ${warningsHtml}
      <p class="text-muted">Reload the app so every screen reflects your restored data.</p>
      <button type="button" class="btn btn-primary" id="restore-reload-btn">Reload App</button>`;
    restorePanel.querySelector('#restore-reload-btn').addEventListener('click', () => location.reload());
  }

  renderChooseFileState();
}
