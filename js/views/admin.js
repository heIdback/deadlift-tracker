// Admin-only screen (Phase 3C: access management; Phase 3F: dashboard +
// user list + read-only user detail). Reachable only via the Admin nav
// tab, shown only to role:'admin' (navigation.js), and gated again in
// router.js before this module is ever imported/mounted. The REAL
// protection is firestore.rules: every read/write this screen (or
// adminUserDetail.js) performs is independently rejected server-side for
// anyone who isn't an approved admin, regardless of what the frontend
// shows or hides.
import { getCurrentUser } from '../core/auth.js';
import { listAccessRecords, approveUser, disableUser } from '../services/accessAdminService.js';
import { getFitnessSummariesForApprovedUsers } from '../services/adminInsightsService.js';
import { computeUserCounts, computeTrainingStats } from '../utils/adminStats.js';
import { formatDate } from '../utils/dates.js';
import { escapeHtml, safeUrl, wireAvatarFallbacks } from '../utils/dom.js';

const RECENT_DAYS = 7;

function statTile(label, value) {
  return `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
    </div>`;
}

function renderDashboard(userCounts, trainingStats) {
  return `
    <h3>Users</h3>
    <div class="stat-grid">
      ${statTile('Total', userCounts.total)}
      ${statTile('Approved', userCounts.approved)}
      ${statTile('Pending', userCounts.pending)}
      ${statTile('Disabled', userCounts.disabled)}
    </div>

    <h3>Training</h3>
    <div class="stat-grid">
      ${statTile('Completed workouts', trainingStats.totalCompletedWorkouts)}
      ${statTile('In progress now', trainingStats.workoutsInProgress)}
      ${statTile(`Active in last ${trainingStats.recentDays}d`, trainingStats.recentlyActiveUsers)}
    </div>`;
}

/** Compact, generic training-status line for an approved user's row — "—" for anyone the caller has no summary for (pending/disabled users are never fetched, see getFitnessSummariesForApprovedUsers). */
function trainingLine(summary) {
  if (!summary) return '';
  const program = summary.programName
    ? `${escapeHtml(summary.programName)} · Week ${summary.week ?? '—'} · Day ${summary.dayOrder ?? '—'}`
    : 'No program yet';
  const active = summary.hasActiveWorkout ? ' · <strong>Workout in progress</strong>' : '';
  const last = summary.lastCompletedWorkout
    ? ` · Last completed ${formatDate(summary.lastCompletedWorkout.finishedAtDate)}`
    : ' · No completed workouts yet';
  return `<div class="text-muted admin-training-line">${program}${active}${last}</div>`;
}

function personRow(record, { showApprove, disableLabel, isSelf, summary }) {
  const photo = record.photoURL ? safeUrl(record.photoURL) : '';
  const actions = !isSelf && (showApprove || disableLabel)
    ? `
      <div class="admin-actions">
        ${showApprove ? `<button type="button" class="btn btn-primary" data-action="approve" data-uid="${escapeHtml(record.id)}">Approve</button>` : ''}
        ${disableLabel ? `<button type="button" class="btn btn-secondary" data-action="disable" data-uid="${escapeHtml(record.id)}">${escapeHtml(disableLabel)}</button>` : ''}
      </div>`
    : '';
  // Approved rows are tappable through to the read-only User Detail screen
  // (adminUserDetail.js) via a plain hash-query link — no router.js change
  // needed (see that module's own comment for why). Pending/disabled rows
  // have nothing to drill into yet (no program is installed until a user
  // is approved — see core/access.js), so they stay plain, non-linked rows.
  const detailHref = record.status === 'approved' ? `#/admin?uid=${encodeURIComponent(record.id)}` : null;

  return `
    <div class="card admin-row">
      <div class="admin-row-main">
        ${photo ? `<img class="avatar avatar-sm" data-avatar src="${escapeHtml(photo)}" alt="" width="36" height="36">` : ''}
        <div>
          <div class="card-title">
            ${detailHref ? `<a href="${detailHref}">${escapeHtml(record.displayName) || '(no name)'}</a>` : (escapeHtml(record.displayName) || '(no name)')}
            ${isSelf ? ' <span class="text-muted">(you)</span>' : ''}
          </div>
          <div class="card-sub">${escapeHtml(record.email)}${record.role === 'admin' ? ' · Admin' : ''}</div>
          ${record.requestedAt ? `<div class="text-muted">Requested ${formatDate(record.requestedAt)}</div>` : ''}
          ${trainingLine(summary)}
        </div>
      </div>
      ${actions}
    </div>`;
}

async function mountDashboardAndList(root, uid) {
  root.innerHTML = `<div class="loading-state" role="status">Loading admin…</div>`;

  async function loadAndRender() {
    const records = await listAccessRecords();
    const summaries = await getFitnessSummariesForApprovedUsers(records);

    const userCounts = computeUserCounts(records);
    const trainingStats = computeTrainingStats([...summaries.values()], { recentDays: RECENT_DAYS });

    const pending = records.filter((r) => r.status === 'pending');
    const approved = records.filter((r) => r.status === 'approved');
    const disabled = records.filter((r) => r.status === 'disabled');

    root.innerHTML = `
      <section class="admin-view">
        <h2>Admin</h2>

        ${renderDashboard(userCounts, trainingStats)}

        <h3>Pending (${pending.length})</h3>
        ${pending.length
          ? pending.map((r) => personRow(r, { showApprove: true, disableLabel: 'Reject', isSelf: r.id === uid })).join('')
          : '<p class="text-muted">No pending requests.</p>'}

        <h3>Approved</h3>
        ${approved.length
          ? approved.map((r) => personRow(r, { showApprove: false, disableLabel: 'Disable', isSelf: r.id === uid, summary: summaries.get(r.id) })).join('')
          : '<p class="text-muted">No approved users.</p>'}

        <h3>Disabled</h3>
        ${disabled.length
          ? disabled.map((r) => personRow(r, { showApprove: true, disableLabel: null, isSelf: r.id === uid })).join('')
          : '<p class="text-muted">No disabled users.</p>'}

        <p class="form-status" id="admin-status" role="status"></p>
      </section>`;

    wireAvatarFallbacks(root);

    root.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const targetUid = btn.dataset.uid;
        const action = btn.dataset.action;
        const status = root.querySelector('#admin-status');
        root.querySelectorAll('[data-action]').forEach((b) => { b.disabled = true; });
        status.textContent = 'Updating…';
        try {
          if (action === 'approve') await approveUser(uid, targetUid);
          else await disableUser(uid, targetUid);
          await loadAndRender();
        } catch (err) {
          console.error(err);
          status.textContent = `Error: ${err.message}`;
          root.querySelectorAll('[data-action]').forEach((b) => { b.disabled = false; });
        }
      });
    });
  }

  await loadAndRender();
}

export async function mount(root) {
  const uid = getCurrentUser().uid;

  // Deep-link to a specific user's read-only detail screen: `#/admin?uid=…`
  // (see personRow's detailHref above). router.js strips the query string
  // before matching the route (see its `matchRoute`), so it always mounts
  // THIS module for any `/admin*` hash; reading the query ourselves here —
  // rather than adding a second route/module — keeps router.js completely
  // unchanged for Phase 3F (see the Part D/report note on minimal blast
  // radius). Going "back" from the detail screen just sets the hash back
  // to plain `#/admin`, which re-enters this same branch and re-mounts the
  // dashboard/list fresh.
  const params = new URLSearchParams((location.hash.split('?')[1] ?? ''));
  const targetUid = params.get('uid');
  if (targetUid) {
    const { mount: mountDetail } = await import('./adminUserDetail.js');
    return mountDetail(root, { targetUid });
  }

  return mountDashboardAndList(root, uid);
}
