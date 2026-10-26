// Phase 4 — Program Management: the new "Program" nav tab. Read-only
// browsing of the active (or any) program by default (Part A/B), plus
// Rename/Duplicate/Set Active (Part O/P). Day Detail and the Edit Day flow
// live in js/views/programDayEditor.js, dynamically imported below when a
// `day` hash-query param is present — the exact same hash-query-param
// pattern js/views/admin.js already established in Phase 3F for its own
// User Detail sub-screen, so this needed zero router.js changes either.
import { getCurrentUser } from '../core/auth.js';
import {
  listPrograms, getProgramWithDays, getActiveProgramRun,
  renameProgram, duplicateProgram,
} from '../services/programService.js';
import { setActiveProgram } from '../services/programSwitchService.js';
// v31: hide / delete inactive programs.
import { setProgramHidden, deleteProgram } from '../services/programManageService.js';
import { visiblePrograms, hiddenPrograms, isHiddenProgram } from '../utils/programManage.js';
import { totalWeeksOf, validateRequiredName } from '../utils/programEditModel.js';
import { escapeHtml } from '../utils/dom.js';

function parseParams() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  return {
    programId: params.get('id') || null,
    dayId: params.get('day') || null,
    importMode: params.get('import') === '1',
  };
}

// v1.1: small "v2 · imported" line for a program that carries the
// additive `version`/`importSource` fields (js/services/programService.js's
// importProgram). Absent on every pre-v1.1 program, which renders as before.
function programMetaBits(p) {
  const bits = [];
  if (p.version) bits.push(`v${escapeHtml(String(p.version).replace(/^v/i, ''))}`);
  if (p.importSource) bits.push(`imported from ${escapeHtml(String(p.importSource).toUpperCase())}`);
  return bits;
}

// v1.1: optional program-level notes / decision rules (plain text, escaped).
function programNotesHtml(p) {
  const rules = Array.isArray(p.decisionRules) ? p.decisionRules : [];
  if (!p.notes && rules.length === 0) return '';
  return `
    <div class="card">
      <h3>Program notes</h3>
      ${p.notes ? `<p class="program-notes">${escapeHtml(p.notes)}</p>` : ''}
      ${rules.length ? `
        <div class="card-label">Decision rules</div>
        <ul class="notice-list">${rules.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
    </div>`;
}

function importButtonHtml() {
  return '<a class="btn btn-secondary" href="#/program?import=1" id="import-program-link">Import Program</a>';
}

function programListSection(allPrograms, activeProgramId) {
  const programs = visiblePrograms(allPrograms);
  const hidden = hiddenPrograms(allPrograms);
  if (programs.length < 2 && hidden.length === 0) return '';
  return `
    <h3>Your Programs</h3>
    ${programs.map((p) => `
      <div class="card admin-row">
        <div class="admin-row-main">
          <div>
            <div class="card-title">
              <a href="#/program?id=${encodeURIComponent(p.id)}">${escapeHtml(p.name) || '(untitled program)'}</a>
              ${p.id === activeProgramId ? ' <span class="badge-active">Active</span>' : ''}
            </div>
            <div class="card-sub">${(p.weeks?.length ?? 0)} week${(p.weeks?.length ?? 0) === 1 ? '' : 's'}${programMetaBits(p).map((b) => ` · ${b}`).join('')}</div>
          </div>
        </div>
        ${p.id !== activeProgramId ? `
          <div class="admin-actions">
            <button type="button" class="btn btn-secondary" data-action="set-active" data-program-id="${escapeHtml(p.id)}">Set Active</button>
          </div>` : ''}
      </div>`).join('')}
    ${hidden.length ? `
      <details class="card" id="hidden-programs">
        <summary>Hidden programs (${hidden.length})</summary>
        ${hidden.map((p) => `
          <div class="admin-row hidden-program-row">
            <a href="#/program?id=${encodeURIComponent(p.id)}">${escapeHtml(p.name) || '(untitled program)'}</a>
            <button type="button" class="btn btn-secondary" data-action="unhide" data-program-id="${escapeHtml(p.id)}">Unhide</button>
          </div>`).join('')}
      </details>` : ''}
  `;
}

function weekSummary(w) {
  const bits = [];
  if (w.isDeload) bits.push('Deload');
  if (w.isPrAttempt) bits.push('PR attempt');
  return bits.length ? ` · ${bits.join(', ')}` : '';
}

function overviewSection(program, days, { isActive, currentPos, totalWeeks }) {
  const weeks = program.weeks?.length ? [...program.weeks].sort((a, b) => a.week - b.week) : [];
  const currentDay = isActive && currentPos ? days.find((d) => d.order === currentPos.dayOrder) : null;

  return `
    <div class="card card-primary">
      <div class="card-title">${escapeHtml(program.name) || '(untitled program)'}${isHiddenProgram(program) ? ' <span class="badge-hidden">Hidden</span>' : ''}</div>
      ${programMetaBits(program).length ? `<p class="card-sub">${programMetaBits(program).join(' · ')}</p>` : ''}
      ${isActive
        ? `<p class="card-sub">Current position: Week ${currentPos?.week ?? '—'} · ${escapeHtml(currentDay?.name) || `Day ${currentPos?.dayOrder ?? '—'}`}</p>`
        : '<p class="text-muted">This program is not currently active.</p>'}
      <div class="admin-actions">
        ${!isActive ? `<button type="button" class="btn btn-primary" data-action="set-active" data-program-id="${escapeHtml(program.id)}">Set Active</button>` : ''}
        <button type="button" class="btn btn-secondary" data-action="rename">Rename</button>
        <button type="button" class="btn btn-secondary" data-action="duplicate">Duplicate</button>
        ${!isActive ? `
        ${isHiddenProgram(program)
    ? `<button type="button" class="btn btn-secondary" data-action="unhide" data-program-id="${escapeHtml(program.id)}">Unhide</button>`
    : `<button type="button" class="btn btn-secondary" data-action="hide" data-program-id="${escapeHtml(program.id)}">Hide</button>`}
        <button type="button" class="btn btn-danger" data-action="delete">Delete</button>` : ''}
      </div>
      <div id="program-inline-form"></div>
    </div>
    ${programNotesHtml(program)}

    <div id="weeks-list">
      ${weeks.length === 0 ? '<p class="text-muted">This program has no weeks defined.</p>' : weeks.map((w) => {
        const isCurrentWeek = isActive && currentPos?.week === w.week;
        return `
        <details class="card" ${isCurrentWeek ? 'open' : ''}>
          <summary>Week ${w.week}${weekSummary(w)}</summary>
          ${w.notes ? `<p class="text-muted">${escapeHtml(w.notes)}</p>` : ''}
          <div class="program-day-list">
            ${days.length === 0 ? '<p class="text-muted">No days in this program yet.</p>' : days.map((d) => {
              const isCurrentDay = isCurrentWeek && currentPos?.dayOrder === d.order;
              return `
              <a class="program-day-row${isCurrentDay ? ' is-current' : ''}"
                 href="#/program?id=${encodeURIComponent(program.id)}&day=${encodeURIComponent(d.id)}&week=${w.week}">
                ${escapeHtml(d.name) || `Day ${d.order}`}${isCurrentDay ? ' <span class="badge-active">Current</span>' : ''}
              </a>`;
            }).join('')}
          </div>
        </details>`;
      }).join('')}
    </div>
    <p class="form-status" id="program-status" role="status"></p>
  `;
}

export async function mount(root, { path } = {}) {
  // v1.1: legacy `#/import` (see config/app.config.js ROUTES) → the Program
  // Import screen. replace() keeps the dead URL out of Back-button history.
  if (path === '/import') {
    location.replace('#/program?import=1');
    return undefined;
  }
  const { programId, dayId, importMode } = parseParams();

  if (importMode) {
    const mod = await import('./programImport.js');
    return mod.mount(root);
  }

  if (dayId) {
    if (!programId) {
      root.innerHTML = '<div class="empty-state"><p>Missing program reference.</p></div>';
      return;
    }
    const mod = await import('./programDayEditor.js');
    return mod.mount(root, { programId, dayId });
  }

  root.innerHTML = '<div class="loading-state" role="status">Loading program…</div>';
  const uid = getCurrentUser().uid;

  async function loadAndRender() {
    const [programs, activeRun] = await Promise.all([
      listPrograms(uid),
      getActiveProgramRun(uid),
    ]);

    if (programs.length === 0) {
      root.innerHTML = `
        <section class="program-view">
          <h2>Program</h2>
          <div class="empty-state"><p>No program installed yet.</p></div>
          ${importButtonHtml()}
        </section>`;
      return;
    }

    const activeProgramId = activeRun?.programId ?? null;
    const openId = programId ?? activeProgramId ?? programs[0].id;
    const { program, days } = await getProgramWithDays(uid, openId);

    if (!program) {
      root.innerHTML = `
        <section class="program-view">
          <h2>Program</h2>
          <div class="empty-state"><p>That program could not be found.</p></div>
          <a href="#/program" class="text-muted">&larr; Back to Program</a>
        </section>`;
      return;
    }

    const isActive = program.id === activeProgramId;
    const totalWeeks = totalWeeksOf(program);

    root.innerHTML = `
      <section class="program-view">
        <h2>Program</h2>
        ${programListSection(programs, activeProgramId)}
        ${overviewSection(program, days, { isActive, currentPos: isActive ? activeRun.current : null, totalWeeks })}
        <div class="program-import-entry">${importButtonHtml()}</div>
      </section>`;

    const status = root.querySelector('#program-status');
    const setStatus = (msg) => { if (status) status.textContent = msg; };

    async function handleSetActive(targetProgramId, btn) {
      const originalLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Switching…';
      try {
        const result = await setActiveProgram(uid, targetProgramId);
        if (!result.ok && result.reason === 'in_progress_workout') {
          setStatus('Finish your current in-progress workout before switching to a different program.');
          btn.disabled = false;
          btn.textContent = originalLabel;
          return;
        }
        await loadAndRender();
      } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`);
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    }

    root.querySelectorAll('[data-action="set-active"]').forEach((btn) => {
      btn.addEventListener('click', () => handleSetActive(btn.dataset.programId, btn));
    });

    // v31: Hide / Unhide (reversible) — list rows and the overview card share one handler.
    root.querySelectorAll('[data-action="hide"], [data-action="unhide"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        const hide = btn.dataset.action === 'hide';
        btn.disabled = true;
        try {
          const r = await setProgramHidden(uid, btn.dataset.programId, hide);
          if (!r.ok) { setStatus(r.message); btn.disabled = false; return; }
          await loadAndRender();
          // the view was re-rendered: write into the NEW status line
          const fresh = root.querySelector('#program-status');
          if (fresh) fresh.textContent = hide ? 'Program hidden — find it under “Hidden programs”.' : 'Program is back in your list.';
        } catch (err) {
          console.error(err);
          setStatus(`Error: ${err.message}`);
          btn.disabled = false;
        }
      });
    });

    const inlineForm = root.querySelector('#program-inline-form');

    const renameBtn = root.querySelector('[data-action="rename"]');
    renameBtn?.addEventListener('click', () => {
      inlineForm.innerHTML = `
        <div class="form-row">
          <input type="text" id="rename-input" value="${escapeHtml(program.name) || ''}" placeholder="Program name">
          <button type="button" class="btn btn-primary" id="rename-save-btn">Save</button>
        </div>
        <button type="button" class="btn btn-secondary" id="rename-cancel-btn">Cancel</button>`;
      inlineForm.querySelector('#rename-cancel-btn').addEventListener('click', () => { inlineForm.innerHTML = ''; });
      inlineForm.querySelector('#rename-save-btn').addEventListener('click', async () => {
        const newName = inlineForm.querySelector('#rename-input').value.trim();
        const { valid, errors } = validateRequiredName(newName, 'Program name');
        if (!valid) { setStatus(errors[0]); return; }
        try {
          await renameProgram(uid, program.id, newName);
          await loadAndRender();
        } catch (err) {
          console.error(err);
          setStatus(`Error: ${err.message}`);
        }
      });
    });

    // v31: Delete (permanent) — inline confirmation, inactive programs only.
    root.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      inlineForm.innerHTML = `
        <div class="card card-danger" id="delete-confirm">
          <p><strong>Delete “${escapeHtml(program.name || program.id)}” permanently?</strong></p>
          <p class="text-muted">The program, its days and any paused progress in it are removed. Your workout history is kept —
          each finished workout keeps its own copy of the plan. This can't be undone. (To just tidy the list, use Hide instead.)</p>
          <div class="btn-stack">
            <button type="button" class="btn btn-danger" id="delete-confirm-btn">Delete permanently</button>
            <button type="button" class="btn btn-secondary" id="delete-cancel-btn">Cancel</button>
          </div>
          <p class="form-status" id="delete-status" role="status"></p>
        </div>`;
      inlineForm.querySelector('#delete-cancel-btn').addEventListener('click', () => { inlineForm.innerHTML = ''; });
      inlineForm.querySelector('#delete-confirm-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        inlineForm.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        const st = inlineForm.querySelector('#delete-status');
        st.textContent = 'Deleting…';
        try {
          const r = await deleteProgram(uid, program.id);
          if (!r.ok) {
            st.textContent = r.message;
            inlineForm.querySelectorAll('button').forEach((b) => { b.disabled = false; });
            return;
          }
          if (location.hash === '#/program') await loadAndRender();
          else location.hash = '#/program';
        } catch (err) {
          console.error(err);
          st.textContent = `Delete failed — nothing was deleted. ${err.message}`;
          inlineForm.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        }
      });
    });

    const duplicateBtn = root.querySelector('[data-action="duplicate"]');
    duplicateBtn?.addEventListener('click', () => {
      inlineForm.innerHTML = `
        <div class="form-row">
          <input type="text" id="duplicate-input" value="${escapeHtml(program.name) || ''} (copy)" placeholder="New program name">
          <button type="button" class="btn btn-primary" id="duplicate-save-btn">Duplicate</button>
        </div>
        <button type="button" class="btn btn-secondary" id="duplicate-cancel-btn">Cancel</button>
        <p class="text-muted">Creates an independent copy of every week/day/exercise. Workout history and program progress are never copied, and your active program does not change unless you Set Active on the copy afterward.</p>`;
      inlineForm.querySelector('#duplicate-cancel-btn').addEventListener('click', () => { inlineForm.innerHTML = ''; });
      inlineForm.querySelector('#duplicate-save-btn').addEventListener('click', async () => {
        const newName = inlineForm.querySelector('#duplicate-input').value.trim();
        const { valid, errors } = validateRequiredName(newName, 'Program name');
        if (!valid) { setStatus(errors[0]); return; }
        try {
          const newProgramId = await duplicateProgram(uid, program.id, newName);
          location.hash = `#/program?id=${encodeURIComponent(newProgramId)}`;
        } catch (err) {
          console.error(err);
          setStatus(`Error: ${err.message}`);
        }
      });
    });
  }

  await loadAndRender();
}
