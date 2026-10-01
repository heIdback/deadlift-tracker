// Read-only Admin User Detail (Phase 3F). Reached only from admin.js's
// user-list rows, via `#/admin?uid=…` (see admin.js's `mount` for why this
// is a hash-query param rather than a new router.js route). Everything
// rendered here is READ-ONLY by construction: this module contains no
// <input>/<button data-action> wiring at all for another user's fitness
// data — the only interactive elements are plain navigation links (Back,
// and into a specific completed workout's detail). Approve/Disable remain
// exclusively on the admin.js list screen, which already belonged to
// access management before Phase 3F.
//
// All data comes from js/services/adminInsightsService.js (composition
// over existing, already-uid-parametrized service functions) and
// accessAdminService.getAccessRecord — both enforced read-only by
// firestore.rules regardless of what this file does or doesn't render.
import { getAccessRecord } from '../services/accessAdminService.js';
import { getUserDetailData, getUserWorkoutDetail } from '../services/adminInsightsService.js';
import { REQUIRED_STARTER_LIFTS } from '../utils/requiredLifts.js';
import { formatDate, formatDuration } from '../utils/dates.js';
import { escapeHtml, safeUrl, wireAvatarFallbacks } from '../utils/dom.js';

function backToAdminLink() {
  return `<a href="#/admin" class="text-muted">&larr; Back to Admin</a>`;
}
function backToUserLink(targetUid) {
  return `<a href="#/admin?uid=${encodeURIComponent(targetUid)}" class="text-muted">&larr; Back to user</a>`;
}

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

/** Read-only rendering of one logged set row. Deliberately NOT reused from js/views/workout.js's editable renderSetRow — this file must never grow any coupling that could let admin viewing accidentally mutate another user's workout (see this file's module comment and the Phase 3F report's Part C note). */
function renderReadOnlySetRow(s) {
  const label = s.kind === 'warmup' ? `W${s.setNumber}` : String(s.setNumber);
  const kg = s.actualKg != null ? `${s.actualKg} kg` : (s.durationSec != null ? `${s.durationSec}s` : '—');
  const reps = s.actualReps != null ? `${s.actualReps} reps` : '';
  return `
    <div class="admin-readonly-set${s.completed ? ' is-complete' : ''}">
      <span class="set-index">${escapeHtml(label)}</span>
      <span>${escapeHtml(kg)}</span>
      <span>${escapeHtml(reps)}</span>
      <span>${s.completed ? '✓' : '—'}</span>
      ${s.rpe != null ? `<span class="text-muted">RPE ${escapeHtml(s.rpe)}</span>` : ''}
      ${s.note ? `<span class="text-muted">${escapeHtml(s.note)}</span>` : ''}
    </div>`;
}

function renderWorkoutDetail(root, targetUid, workout) {
  if (!workout) {
    root.innerHTML = `
      <section class="admin-view">
        ${backToUserLink(targetUid)}
        <p class="empty-state">That workout could not be found.</p>
      </section>`;
    return;
  }

  root.innerHTML = `
    <section class="admin-view">
      ${backToUserLink(targetUid)}
      <h2>${escapeHtml(workout.dayName)}</h2>
      <p class="text-muted">
        Week ${escapeHtml(workout.week)} · ${workout.status === 'completed' ? 'Completed' : 'In progress'}
        ${workout.finishedAt ? ` ${formatDate(workout.finishedAt)}` : ''}
        ${workout.durationSec != null ? ` · ${formatDuration(workout.durationSec)}` : ''}
      </p>
      ${(workout.exercises ?? []).map((ex) => `
        <div class="card">
          <div class="card-title">${escapeHtml(ex.displayNameAtStart)}</div>
          ${ex.notes ? `<p class="text-muted">${escapeHtml(ex.notes)}</p>` : ''}
          <div class="admin-readonly-set-table">
            ${(ex.sets ?? []).map(renderReadOnlySetRow).join('') || '<p class="text-muted">Nothing logged.</p>'}
          </div>
        </div>`).join('')}
    </section>`;
}

function renderUserDetail(root, targetUid, access, detail) {
  const { summary, currentMaxes, bodyweight, recentWorkouts } = detail;
  const photo = access?.photoURL ? safeUrl(access.photoURL) : '';

  root.innerHTML = `
    <section class="admin-view">
      ${backToAdminLink()}
      <div class="profile-header">
        ${photo ? `<img class="avatar" data-avatar src="${escapeHtml(photo)}" alt="" width="56" height="56">` : ''}
        <div>
          <h2>${escapeHtml(access?.displayName) || '(no name)'}</h2>
          <p class="text-muted">${escapeHtml(access?.email)}</p>
        </div>
      </div>

      <div class="card">
        <h3>Account</h3>
        <div class="account-row"><span class="text-muted">Role</span><strong>${escapeHtml(formatRoleLabel(access?.role))}</strong></div>
        <div class="account-row"><span class="text-muted">Status</span><strong>${escapeHtml(formatStatusLabel(access?.status))}</strong></div>
      </div>

      <div class="card">
        <h3>Current training</h3>
        ${summary.programName ? `
          <p>Program: <strong>${escapeHtml(summary.programName)}</strong></p>
          <p class="text-muted">Week ${summary.week ?? '—'} · ${escapeHtml(summary.dayName) || `Day ${summary.dayOrder ?? '—'}`}</p>
        ` : '<p class="text-muted">No program installed yet.</p>'}
        <p class="text-muted">${summary.hasActiveWorkout ? 'A workout is currently in progress.' : 'No workout currently in progress.'}</p>
      </div>

      <div class="card">
        <h3>Current maxes</h3>
        <div class="form-grid">
          ${REQUIRED_STARTER_LIFTS.map((l) => `
            <div class="account-row">
              <span class="text-muted">${escapeHtml(l.label)}</span>
              <strong>${currentMaxes?.[l.id]?.kg != null ? `${escapeHtml(currentMaxes[l.id].kg)} kg` : '—'}</strong>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <h3>Bodyweight</h3>
        <p class="text-muted">${bodyweight ? `${escapeHtml(bodyweight.kg)} kg (${formatDate(bodyweight.date)})` : 'Not logged yet.'}</p>
      </div>

      <div class="card">
        <h3>Workout history</h3>
        ${recentWorkouts.length ? recentWorkouts.map((w) => `
          <div class="admin-row">
            <a href="#/admin?uid=${encodeURIComponent(targetUid)}&workoutId=${encodeURIComponent(w.id)}">
              ${escapeHtml(w.dayName)} — Week ${escapeHtml(w.week)}
            </a>
            <div class="text-muted">${formatDate(w.finishedAt)}</div>
          </div>`).join('') : '<p class="text-muted">No completed workouts yet.</p>'}
      </div>
      <div id="admin-reset-slot"></div>
    </section>`;
  wireAvatarFallbacks(root);
}

export async function mount(root, { targetUid }) {
  root.innerHTML = `<div class="loading-state" role="status">Loading user…</div>`;

  const params = new URLSearchParams((location.hash.split('?')[1] ?? ''));
  const workoutId = params.get('workoutId');

  if (workoutId) {
    const workout = await getUserWorkoutDetail(targetUid, workoutId);
    renderWorkoutDetail(root, targetUid, workout);
    return;
  }

  const [access, detail] = await Promise.all([
    getAccessRecord(targetUid),
    getUserDetailData(targetUid),
  ]);

  if (!access) {
    root.innerHTML = `
      <section class="admin-view">
        ${backToAdminLink()}
        <p class="empty-state">That user could not be found.</p>
      </section>`;
    return;
  }

  renderUserDetail(root, targetUid, access, detail);

  // v22: permanent "Reset training data" (admin-only screen). The admin's
  // app only writes a reset request to /access/{uid} (firestore.rules allow
  // only approved admins to); the user's own app applies it. Loaded on demand
  // so this read-only screen's own module graph is unchanged.
  const slot = root.querySelector('#admin-reset-slot');
  if (slot) {
    try {
      const { mountResetPanel } = await import('./adminReset.js');
      mountResetPanel(slot, { targetUid, access, onReload: () => mount(root, { targetUid }) });
    } catch (err) {
      // Never break the read-only detail (e.g. offline before the module is cached).
      console.warn('adminUserDetail: reset panel unavailable', err);
      slot.innerHTML = '<p class="text-muted">Reset training data is unavailable right now (needs a connection).</p>';
    }
  }
}
