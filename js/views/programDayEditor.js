// Phase 4 — Program Day Detail (read-only, Part C) and Edit Day (Part D-M).
// Dynamically imported by js/views/program.js whenever a `day` hash-query
// param is present (`#/program?id=X&day=Y[&week=N][&edit=1]`) — the same
// pattern js/views/admin.js/adminUserDetail.js already established in
// Phase 3F, so no router.js change is needed here either.
//
// CORE SAFETY NOTE (Part G/H): this file only ever reads/writes
// `programs/{programId}/days/{dayId}` — the TEMPLATE. It has no code path
// to a `workouts/{workoutId}` document at all. That is what makes editing
// here structurally unable to mutate an in-progress or completed workout:
// see js/services/workoutService.js's resolveActiveWorkout/
// startOrResumeWorkout, which only ever builds a NEW snapshot from the
// template when no existing workout is found, and otherwise returns the
// already-stored workout doc completely untouched.
import { getCurrentUser } from '../core/auth.js';
import { getProgramWithDays } from '../services/programService.js';
import { saveDay } from '../services/programEditService.js';
import { getUserProfile } from '../services/userService.js';
import {
  selectWeekPrescriptions, buildResolvedExerciseList, parseSetsReps, formatSetsReps,
} from '../utils/workoutSnapshot.js';
import {
  formatReps, describeResolvedLoad, resolvedTargetLine, warmupStepsText,
} from '../utils/programDisplay.js';
import { REQUIRED_STARTER_LIFTS } from '../utils/requiredLifts.js';
import {
  totalWeeksOf, classifyEntryShape, createFlatEntry, isWarmupRampLoad,
  validateFlatEntry, validateDayBeforeSave, validateRequiredName,
  moveEntry, removeEntryAt, appendEntry, uniqueId, LOAD_TYPES,
  getBlockDrivenWeekValues, applyBlockDrivenWeekEdit, validateBlockDrivenWeekPatch,
  getWeekPercentRangeValues, applyWeekPercentRangeEdit, validateWeekPercentRangePatch,
} from '../utils/programEditModel.js';
import { escapeHtml } from '../utils/dom.js';

function parseExtraParams() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  return { week: Number(params.get('week')) || 1, editRequested: params.get('edit') === '1' };
}

// basisLabel/formatReps/describeResolvedLoad/resolvedTargetLine/
// warmupStepsText now live in ../utils/programDisplay.js (Phase 4 UI/warm-up
// correction passes) — pure, Firebase-free, and directly unit-tested there.
// Phase 4 warm-up correction pass: this file's read-only render no longer
// derives a basis or a warm-up ramp itself at all — it calls
// workoutSnapshot.js's buildResolvedExerciseList, THE SAME function
// startOrResumeWorkout calls to build a real workout's exercise list, and
// just formats whatever that already-resolved data says. There is no
// preview-only calculation left to drift out of sync with a real snapshot.

function warmupSectionHtml(p) {
  const result = warmupStepsText(p.load, p.displayNameAtStart);
  if (result.missing) return `<p class="text-muted">${escapeHtml(result.message)}</p>`;
  return `<div class="program-warmup-preview">${result.steps.map((s, i) => `
    <p class="card-sub">W${i + 1} &nbsp; ${s.kg != null ? `${s.kg} kg` : '—'} × ${s.reps ?? '—'}</p>`).join('')}</div>`;
}

// ── Read-only Day Detail (Part C) ──────────────────────────────────────────

function sectionLabel(section) {
  return section === 'warmup' ? 'Warm-up' : section === 'accessory' ? 'Accessory' : 'Main';
}

function renderReadOnly(root, { program, day, week, totalWeeks, currentMaxes, rounding, uid }) {
  // The exact same call startOrResumeWorkout makes to build a real
  // workout's exercise list (see workoutService.js) — same currentMaxes,
  // same rounding source (the user's profile settings, not program
  // defaults), same shared warm-up resolver. Program preview and a real
  // future snapshot can never drift apart because they're the same call.
  const resolved = buildResolvedExerciseList(day, week, { currentMaxes, rounding });
  // Raw prescriptions are read ONLY for prescribed RPE/RIR — display-only
  // metadata that resolvePrescription deliberately does not carry onto a
  // real workout snapshot's resolved exercise list (see workoutSnapshot.js).
  // `raw[i]` and `resolved[i]` always correspond 1:1 — buildResolvedExerciseList
  // is defined as `selectWeekPrescriptions(...).map(resolvePrescription)`.
  const raw = selectWeekPrescriptions(day, week);

  const bySection = { warmup: [], main: [], accessory: [] };
  resolved.forEach((p, i) => {
    const section = p.section ?? 'main';
    (bySection[section] ?? bySection.main).push({ ...p, rpe: raw[i]?.rpe ?? null, rir: raw[i]?.rir ?? null });
  });

  const weekOptions = Array.from({ length: totalWeeks || 1 }, (_, i) => i + 1)
    .map((w) => `<option value="${w}" ${w === week ? 'selected' : ''}>Week ${w}</option>`).join('');

  root.innerHTML = `
    <section class="program-view">
      <a href="#/program?id=${encodeURIComponent(program.id)}" class="text-muted">&larr; Back to Program</a>
      <h2>${escapeHtml(day.name) || `Day ${day.order}`}</h2>

      <div class="form-row">
        <label class="field" style="flex:1">
          Week
          <select id="week-select">${weekOptions}</select>
        </label>
      </div>

      ${['warmup', 'main', 'accessory'].map((section) => {
        const list = bySection[section];
        if (!list.length) return '';
        return `
          <h3>${sectionLabel(section)}</h3>
          ${list.map((p) => (p.load?.type === 'sets' ? `
            <div class="card">
              <div class="card-title">${escapeHtml(p.displayNameAtStart)}</div>
              ${warmupSectionHtml(p)}
              ${p.notes ? `<p class="text-muted">${escapeHtml(p.notes)}</p>` : ''}
            </div>` : `
            <div class="card">
              <div class="card-title">${escapeHtml(p.displayNameAtStart)}</div>
              <p class="card-sub">${p.prescribed.sets ?? '—'} × ${formatReps(p.prescribed.reps)}${p.prescribed.durationSec ? ` · ${p.prescribed.durationSec}s` : ''}</p>
              <p>${escapeHtml(describeResolvedLoad(p.load, p.displayNameAtStart))}</p>
              ${resolvedTargetLine(p.load, p.displayNameAtStart) ? `<p class="text-muted">${escapeHtml(resolvedTargetLine(p.load, p.displayNameAtStart))}</p>` : ''}
              ${(p.rpe != null || p.rir != null) ? `<p class="text-muted">${p.rpe != null ? `RPE ${p.rpe}` : ''}${p.rpe != null && p.rir != null ? ' · ' : ''}${p.rir != null ? `RIR ${p.rir}` : ''}</p>` : ''}
              ${p.notes ? `<p class="text-muted">${escapeHtml(p.notes)}</p>` : ''}
            </div>`)).join('')}
        `;
      }).join('')}

      ${resolved.length === 0 ? '<p class="text-muted">Nothing is prescribed for this day in this week.</p>' : ''}

      <button type="button" class="btn btn-primary" id="edit-day-btn">Edit Day</button>
    </section>`;

  root.querySelector('#week-select').addEventListener('change', (e) => {
    location.hash = `#/program?id=${encodeURIComponent(program.id)}&day=${encodeURIComponent(day.id)}&week=${e.target.value}`;
  });
  root.querySelector('#edit-day-btn').addEventListener('click', () => {
    location.hash = `#/program?id=${encodeURIComponent(program.id)}&day=${encodeURIComponent(day.id)}&edit=1`;
  });
}

// ── Edit Day (Part D-M) ────────────────────────────────────────────────────

function allEntryIds(day) {
  return [...(day.sections?.main ?? []), ...(day.sections?.accessory ?? [])].map((e) => e.exerciseId);
}

function basisSelectHtml(selectedOf, idPrefix) {
  const options = [`<option value="">(this exercise's own 1RM)</option>`]
    .concat(REQUIRED_STARTER_LIFTS.map((l) => `<option value="${l.id}" ${selectedOf === l.id ? 'selected' : ''}>${escapeHtml(l.label)}</option>`));
  return `<select id="${idPrefix}-basis">${options.join('')}</select>`;
}

function loadFieldsHtml(load, idPrefix) {
  const type = load?.type ?? 'none';
  return `
    <div class="form-row">
      <label class="field" style="flex:1">Load type
        <select id="${idPrefix}-loadtype">
          ${LOAD_TYPES.map((t) => `<option value="${t}" ${t === type ? 'selected' : ''}>${{
            none: 'None', bodyweight: 'Bodyweight', fixed: 'Fixed weight',
            percent: 'Percentage', percentRange: 'Percentage range',
          }[t]}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="${idPrefix}-loadfields">
      ${type === 'fixed' ? `
        <div class="form-row">
          <label class="field" style="flex:1">Weight (kg)<input type="number" step="0.5" min="0" max="500" id="${idPrefix}-kg" value="${load.kg ?? ''}"></label>
          <label class="field"><input type="checkbox" id="${idPrefix}-perhand" ${load.perHand ? 'checked' : ''}> Per hand</label>
        </div>` : ''}
      ${type === 'percent' ? `
        <div class="form-row">
          <label class="field" style="flex:1">Basis ${basisSelectHtml(load.of, idPrefix)}</label>
          <label class="field" style="flex:1">Percentage (%)<input type="number" step="0.1" min="0" max="300" id="${idPrefix}-percent" value="${load.percent != null ? load.percent * 100 : ''}"></label>
        </div>` : ''}
      ${type === 'percentRange' ? `
        <div class="form-row">
          <label class="field" style="flex:1">Basis ${basisSelectHtml(load.of, idPrefix)}</label>
        </div>
        <div class="form-row">
          <label class="field" style="flex:1">Min (%)<input type="number" step="0.1" min="0" max="300" id="${idPrefix}-min" value="${load.min != null ? load.min * 100 : ''}"></label>
          <label class="field" style="flex:1">Max (%)<input type="number" step="0.1" min="0" max="300" id="${idPrefix}-max" value="${load.max != null ? load.max * 100 : ''}"></label>
        </div>` : ''}
    </div>`;
}

/**
 * Reads the load fields currently in the DOM for one entry. Guarded against
 * a just-changed <select> whose type-specific sub-fields (kg/percent/etc.)
 * haven't been re-rendered into the DOM yet (the change handler commits the
 * draft, including this function's result, BEFORE re-rendering) — an
 * absent field reads as `null`, never `NaN`, so a mid-switch draft renders
 * a blank input on the next paint instead of the literal text "NaN", and
 * validateFlatEntry still correctly flags a genuinely never-filled-in field
 * as invalid at Save time.
 */
function readLoadFromForm(container, idPrefix) {
  const typeEl = container.querySelector(`#${idPrefix}-loadtype`);
  const type = typeEl ? typeEl.value : 'none';
  const numOrNull = (el) => {
    if (!el || el.value === '') return null;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : null;
  };

  if (type === 'none') return { type: 'none' };
  if (type === 'bodyweight') return { type: 'bodyweight' };
  if (type === 'fixed') {
    return {
      type: 'fixed',
      kg: numOrNull(container.querySelector(`#${idPrefix}-kg`)),
      perHand: !!container.querySelector(`#${idPrefix}-perhand`)?.checked,
    };
  }
  if (type === 'percent') {
    const of = container.querySelector(`#${idPrefix}-basis`)?.value || null;
    const pct = numOrNull(container.querySelector(`#${idPrefix}-percent`));
    return { type: 'percent', percent: pct != null ? pct / 100 : null, ...(of ? { of } : {}) };
  }
  if (type === 'percentRange') {
    const of = container.querySelector(`#${idPrefix}-basis`)?.value || null;
    const min = numOrNull(container.querySelector(`#${idPrefix}-min`));
    const max = numOrNull(container.querySelector(`#${idPrefix}-max`));
    return {
      type: 'percentRange',
      min: min != null ? min / 100 : null,
      max: max != null ? max / 100 : null,
      ...(of ? { of } : {}),
    };
  }
  return { type: 'none' };
}

function weeksCheckboxesHtml(selectedWeeks, totalWeeks, idPrefix) {
  const selected = new Set(selectedWeeks ?? []);
  return Array.from({ length: totalWeeks || 1 }, (_, i) => i + 1).map((w) => `
    <label class="field" style="display:inline-flex;flex-direction:row;align-items:center;gap:4px;width:auto;margin-right:8px;">
      <input type="checkbox" class="${idPrefix}-week" value="${w}" ${selected.has(w) ? 'checked' : ''}> ${w}
    </label>`).join('');
}

// ── Complex-shape specialized editor cards (Phase 4 correction pass) ───────
// Deadlift's 'block-driven' and Bench/Squat's 'week-percent-range' entries
// don't fit the flat per-week-independent form above (their prescriptions
// are keyed by week, on a shared weeklyVariants structure) — a specialized
// section edits ONLY the currently-selected week's real, existing fields,
// per "Add schema-aware editor controls for the editable values already
// present in those structures... Do not invent a parallel schema."

function subLiftFieldsHtml(label, key, idPrefix, sub) {
  if (!sub) return `<p class="text-muted">${escapeHtml(label)}: not prescribed in this week.</p>`;
  return `
    <div class="form-row">
      <label class="field" style="flex:1">${escapeHtml(label)} sets<input type="number" min="1" step="1" id="${idPrefix}-${key}-sets" value="${sub.sets ?? ''}"></label>
      <label class="field" style="flex:1">${escapeHtml(label)} reps<input type="number" min="1" step="1" id="${idPrefix}-${key}-reps" value="${sub.reps ?? ''}"></label>
      <label class="field" style="flex:1">${escapeHtml(label)} % of 1RM<input type="number" step="0.1" min="0" max="300" id="${idPrefix}-${key}-percent" value="${sub.percent != null ? sub.percent * 100 : ''}"></label>
    </div>`;
}

function blockDrivenEditorHtml(entry, idPrefix, editWeek) {
  const values = getBlockDrivenWeekValues(entry, editWeek);
  if (!values) {
    return `<p class="text-muted">No Deadlift block prescription is defined for Week ${editWeek}.</p>`;
  }
  return `
    <p class="text-muted">Editing Week ${editWeek}'s Deadlift block prescription. Other weeks are untouched.</p>
    ${subLiftFieldsHtml('Top Single', 'ts', idPrefix, values.topSingle)}
    ${subLiftFieldsHtml('Backoff', 'bo', idPrefix, values.backoff)}
    ${values.backoff ? `
    <div class="form-row">
      <label class="field" style="flex:1">Backoff note (optional)<input type="text" id="${idPrefix}-bo-note" value="${escapeHtml(values.backoff.note) || ''}"></label>
    </div>` : ''}
    ${subLiftFieldsHtml('Snatch-Grip Deadlift', 'sgdl', idPrefix, values.sgdl)}
    <div class="form-row">
      <label class="field" style="flex:1">Week notes (optional — RPE is recorded here as text, e.g. "RPE 7-7.5")<input type="text" id="${idPrefix}-week-notes" value="${escapeHtml(values.notes) || ''}"></label>
    </div>`;
}

function weekPercentRangeEditorHtml(entry, idPrefix, editWeek) {
  const values = getWeekPercentRangeValues(entry, editWeek, parseSetsReps);
  if (!values) {
    return `<p class="text-muted">No prescription is defined for Week ${editWeek}.</p>`;
  }
  const isRange = values.reps != null && typeof values.reps === 'object';
  return `
    <p class="text-muted">Editing Week ${editWeek}'s percentage-range prescription. Other weeks are untouched. RPE/RIR/notes can't be set for this kind of prescription.</p>
    <div class="form-row">
      <label class="field" style="flex:1">Sets<input type="number" min="1" step="1" id="${idPrefix}-wpr-sets" value="${values.sets ?? ''}"></label>
      <label class="field" style="flex:1">Reps<input type="number" min="1" step="1" id="${idPrefix}-wpr-reps" value="${isRange ? '' : (values.reps ?? '')}" ${isRange ? 'disabled' : ''}></label>
    </div>
    <div class="form-row">
      <label class="field"><input type="checkbox" id="${idPrefix}-wpr-isrange" ${isRange ? 'checked' : ''}> Use a rep range instead</label>
    </div>
    <div class="form-row" id="${idPrefix}-wpr-reprange-row" style="${isRange ? '' : 'display:none'}">
      <label class="field" style="flex:1">Min reps<input type="number" min="1" step="1" id="${idPrefix}-wpr-repmin" value="${isRange ? values.reps.min : ''}"></label>
      <label class="field" style="flex:1">Max reps<input type="number" min="1" step="1" id="${idPrefix}-wpr-repmax" value="${isRange ? values.reps.max : ''}"></label>
    </div>
    <div class="form-row">
      <label class="field" style="flex:1">Min (%)<input type="number" step="0.1" min="0" max="300" id="${idPrefix}-wpr-min" value="${values.min != null ? values.min * 100 : ''}"></label>
      <label class="field" style="flex:1">Max (%)<input type="number" step="0.1" min="0" max="300" id="${idPrefix}-wpr-max" value="${values.max != null ? values.max * 100 : ''}"></label>
    </div>`;
}

function entryEditorHtml(entry, index, section, totalWeeks, editWeek) {
  const idPrefix = `${section}-${index}`;
  const shape = classifyEntryShape(entry);
  const reps = entry.reps;
  const isRange = reps != null && typeof reps === 'object';

  let body;
  if (shape === 'block-driven') {
    body = blockDrivenEditorHtml(entry, idPrefix, editWeek);
  } else if (shape === 'week-percent-range') {
    body = weekPercentRangeEditorHtml(entry, idPrefix, editWeek);
  } else {
    body = `
      <div class="form-row">
        <label class="field" style="flex:1">Sets<input type="number" min="1" step="1" id="${idPrefix}-sets" value="${entry.sets ?? ''}"></label>
        <label class="field" style="flex:1">Reps<input type="number" min="1" step="1" id="${idPrefix}-reps" value="${isRange ? '' : (reps ?? '')}" ${isRange ? 'disabled' : ''}></label>
      </div>
      <div class="form-row">
        <label class="field"><input type="checkbox" id="${idPrefix}-isrange" ${isRange ? 'checked' : ''}> Use a rep range instead</label>
      </div>
      <div class="form-row" id="${idPrefix}-reprange-row" style="${isRange ? '' : 'display:none'}">
        <label class="field" style="flex:1">Min reps<input type="number" min="1" step="1" id="${idPrefix}-repmin" value="${isRange ? reps.min : ''}"></label>
        <label class="field" style="flex:1">Max reps<input type="number" min="1" step="1" id="${idPrefix}-repmax" value="${isRange ? reps.max : ''}"></label>
      </div>
      ${isWarmupRampLoad(entry.load)
        ? `<p class="text-muted">Warm-up ramp: ${escapeHtml((entry.load.sets ?? []).map((st) => `${st.kg}×${st.reps}`).join(', '))} — kept exactly as imported (not editable here).</p>`
        : loadFieldsHtml(entry.load ?? { type: 'none' }, idPrefix)}
      <div class="form-row">
        <label class="field" style="flex:1">RPE (optional)<input type="number" min="0" max="10" step="0.5" id="${idPrefix}-rpe" value="${entry.rpe ?? ''}"></label>
        <label class="field" style="flex:1">RIR (optional)<input type="number" min="0" max="10" step="1" id="${idPrefix}-rir" value="${entry.rir ?? ''}"></label>
      </div>
      <div class="field">Weeks active<div>${weeksCheckboxesHtml(entry.weeks, totalWeeks, idPrefix)}</div></div>
      <div class="form-row">
        <label class="field" style="flex:1">Notes (optional)<input type="text" id="${idPrefix}-notes" value="${escapeHtml(entry.notes) || ''}"></label>
      </div>`;
  }

  return `
    <div class="card" data-entry-section="${section}" data-entry-index="${index}">
      <div class="form-row">
        <label class="field" style="flex:1">Exercise name
          <input type="text" id="${idPrefix}-name" value="${escapeHtml(entry.displayName) || ''}">
        </label>
      </div>

      ${body}

      <div class="admin-actions">
        <button type="button" class="btn btn-secondary" data-reorder="up" data-section="${section}" data-index="${index}">&uarr; Move up</button>
        <button type="button" class="btn btn-secondary" data-reorder="down" data-section="${section}" data-index="${index}">&darr; Move down</button>
        <button type="button" class="btn btn-danger" data-remove data-section="${section}" data-index="${index}">Remove</button>
      </div>
    </div>`;
}

// Reads one sub-lift's fields for a block-driven week card. Returns `null`
// (not a zeroed-out object) when that sub-lift's inputs weren't rendered at
// all — i.e. it wasn't prescribed that week — so applyBlockDrivenWeekEdit
// and validateBlockDrivenWeekPatch both correctly treat it as still absent
// rather than as a newly-invented, invalid prescription.
function readSubLiftFromForm(container, idPrefix, key) {
  const setsEl = container.querySelector(`#${idPrefix}-${key}-sets`);
  if (!setsEl) return null;
  const numOrNull = (el) => {
    if (!el || el.value === '') return null;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : null;
  };
  const pct = numOrNull(container.querySelector(`#${idPrefix}-${key}-percent`));
  return {
    sets: numOrNull(setsEl),
    reps: numOrNull(container.querySelector(`#${idPrefix}-${key}-reps`)),
    percent: pct != null ? pct / 100 : null,
  };
}

function readBlockDrivenPatchFromForm(container, idPrefix) {
  const topSingle = readSubLiftFromForm(container, idPrefix, 'ts');
  const backoff = readSubLiftFromForm(container, idPrefix, 'bo');
  if (backoff) backoff.note = container.querySelector(`#${idPrefix}-bo-note`)?.value.trim() || null;
  const sgdl = readSubLiftFromForm(container, idPrefix, 'sgdl');
  const notesEl = container.querySelector(`#${idPrefix}-week-notes`);
  const notes = notesEl ? (notesEl.value.trim() || null) : null;
  return { topSingle, backoff, sgdl, notes };
}

function readWeekPercentRangePatchFromForm(container, idPrefix) {
  const numOrNull = (el) => {
    if (!el || el.value === '') return null;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : null;
  };
  const isRange = container.querySelector(`#${idPrefix}-wpr-isrange`)?.checked;
  const reps = isRange
    ? { min: numOrNull(container.querySelector(`#${idPrefix}-wpr-repmin`)), max: numOrNull(container.querySelector(`#${idPrefix}-wpr-repmax`)) }
    : numOrNull(container.querySelector(`#${idPrefix}-wpr-reps`));
  const min = numOrNull(container.querySelector(`#${idPrefix}-wpr-min`));
  const max = numOrNull(container.querySelector(`#${idPrefix}-wpr-max`));
  return {
    sets: numOrNull(container.querySelector(`#${idPrefix}-wpr-sets`)),
    reps,
    min: min != null ? min / 100 : null,
    max: max != null ? max / 100 : null,
  };
}

function readEntryFromForm(container, entry, index, section, totalWeeks, editWeek) {
  const idPrefix = `${section}-${index}`;
  const el = (id) => container.querySelector(`#${idPrefix}-${id}`);
  const displayName = el('name').value.trim();
  const shape = classifyEntryShape(entry);

  if (shape === 'block-driven') {
    const patch = readBlockDrivenPatchFromForm(container, idPrefix);
    return { ...applyBlockDrivenWeekEdit(entry, editWeek, patch), displayName };
  }
  if (shape === 'week-percent-range') {
    const patch = readWeekPercentRangePatchFromForm(container, idPrefix);
    return { ...applyWeekPercentRangeEdit(entry, editWeek, patch, formatSetsReps), displayName };
  }

  const isRange = el('isrange').checked;
  const reps = isRange
    ? { min: Number(el('repmin').value), max: Number(el('repmax').value) }
    : (el('reps').value === '' ? null : Number(el('reps').value));
  const weeks = [...container.querySelectorAll(`.${idPrefix}-week:checked`)].map((c) => Number(c.value));

  return createFlatEntry({
    exerciseId: entry.exerciseId,
    displayName,
    sets: Number(el('sets').value),
    reps,
    durationSec: entry.durationSec ?? null,
    // v1.1: a warm-up ramp has no load controls — keep it exactly as stored.
    load: isWarmupRampLoad(entry.load) ? entry.load : readLoadFromForm(container, idPrefix),
    notes: el('notes').value.trim() || null,
    rpe: el('rpe').value === '' ? null : Number(el('rpe').value),
    rir: el('rir').value === '' ? null : Number(el('rir').value),
    weeks,
  });
}

function renderEdit(root, ctx) {
  const { program, originalDay, uid } = ctx;
  const totalWeeks = totalWeeksOf(program);
  // A fresh, deep, independent draft every time renderEdit is (re-)entered
  // from scratch (mount time) — NOT on every re-render within the same
  // editing session (see renderFromDraft below, which reuses `ctx.draft`).
  if (!ctx.draft) ctx.draft = JSON.parse(JSON.stringify(originalDay));
  // Which week's values the complex-shape (block-driven / week-percent-range)
  // editor cards show and edit. Defaults to whatever week Day Detail was
  // showing when "Edit Day" was pressed. Switching it here is local UI state
  // only (never touches location.hash), so it never triggers a router
  // remount that would discard the in-progress draft above.
  if (ctx.editWeek == null) ctx.editWeek = Math.min(Math.max(ctx.initialWeek || 1, 1), totalWeeks || 1);

  function renderFromDraft() {
    const draft = ctx.draft;
    const weekOptions = Array.from({ length: totalWeeks || 1 }, (_, i) => i + 1)
      .map((w) => `<option value="${w}" ${w === ctx.editWeek ? 'selected' : ''}>Week ${w}</option>`).join('');
    root.innerHTML = `
      <section class="program-view">
        <div class="card card-notice">
          <p><strong>Changes affect future workouts only.</strong> Workouts already
          started or completed keep their original plan.</p>
        </div>

        <h2>Edit Day</h2>
        <div class="form-row">
          <label class="field" style="flex:1">Day name<input type="text" id="day-name-input" value="${escapeHtml(draft.name) || ''}"></label>
          <label class="field" style="flex:1">Editing week (for main-lift prescriptions below)
            <select id="edit-week-select">${weekOptions}</select>
          </label>
        </div>

        <div class="admin-actions">
          <button type="button" class="btn btn-primary" id="save-top-btn">Save Changes</button>
          <button type="button" class="btn btn-secondary" id="cancel-top-btn">Cancel</button>
        </div>

        <p class="form-status" id="edit-status" role="status"></p>

        <h3>Main</h3>
        <div id="main-list">${(draft.sections?.main ?? []).map((e, i) => entryEditorHtml(e, i, 'main', totalWeeks, ctx.editWeek)).join('') || '<p class="text-muted">No main exercises.</p>'}</div>
        <button type="button" class="btn btn-secondary" data-add="main">+ Add Exercise to Main</button>

        <h3>Accessory</h3>
        <div id="accessory-list">${(draft.sections?.accessory ?? []).map((e, i) => entryEditorHtml(e, i, 'accessory', totalWeeks, ctx.editWeek)).join('') || '<p class="text-muted">No accessory exercises.</p>'}</div>
        <button type="button" class="btn btn-secondary" data-add="accessory">+ Add Exercise to Accessory</button>

        <div class="admin-actions">
          <button type="button" class="btn btn-primary" id="save-bottom-btn">Save Changes</button>
          <button type="button" class="btn btn-secondary" id="cancel-bottom-btn">Cancel</button>
        </div>
      </section>`;

    const statusEl = root.querySelector('#edit-status');
    const setStatus = (lines) => {
      statusEl.innerHTML = Array.isArray(lines) && lines.length
        ? `<span class="login-error">${lines.map((l) => escapeHtml(l)).join('<br>')}</span>`
        : '';
    };

    function commitFieldEdits() {
      // Reads every currently-rendered entry's form fields back into the
      // draft BEFORE any structural change (reorder/remove/add) or Save,
      // so in-progress edits on other cards in the same section are never
      // silently lost by an unrelated action elsewhere on the screen.
      draft.name = root.querySelector('#day-name-input').value.trim();
      for (const section of ['main', 'accessory']) {
        const list = draft.sections?.[section] ?? [];
        draft.sections[section] = list.map((entry, i) => {
          const card = root.querySelector(`[data-entry-section="${section}"][data-entry-index="${i}"]`);
          return card ? readEntryFromForm(root, entry, i, section, totalWeeks, ctx.editWeek) : entry;
        });
      }
    }

    root.querySelector('#edit-week-select').addEventListener('change', (e) => {
      commitFieldEdits();
      ctx.editWeek = Number(e.target.value);
      renderFromDraft();
    });

    root.querySelectorAll('[data-reorder]').forEach((btn) => {
      btn.addEventListener('click', () => {
        commitFieldEdits();
        const { section, index } = btn.dataset;
        const i = Number(index);
        const dir = btn.dataset.reorder === 'up' ? -1 : 1;
        draft.sections[section] = moveEntry(draft.sections[section], i, i + dir);
        renderFromDraft();
      });
    });

    root.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!confirm('Remove this exercise from the program day? This only affects the template — it never removes it from any existing workout history.')) return;
        commitFieldEdits();
        const { section, index } = btn.dataset;
        draft.sections[section] = removeEntryAt(draft.sections[section], Number(index));
        renderFromDraft();
      });
    });

    root.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('click', () => {
        commitFieldEdits();
        const section = btn.dataset.add;
        const existingIds = allEntryIds(draft);
        const name = 'New Exercise';
        const entry = createFlatEntry({
          exerciseId: uniqueId(name, existingIds),
          displayName: name,
          sets: 3,
          reps: 8,
          load: { type: 'none' },
          weeks: Array.from({ length: totalWeeks || 1 }, (_, i) => i + 1),
        });
        draft.sections[section] = appendEntry(draft.sections[section], entry);
        renderFromDraft();
      });
    });

    root.querySelectorAll('input[id$="-isrange"], input[id$="-wpr-isrange"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        commitFieldEdits();
        renderFromDraft();
      });
    });
    root.querySelectorAll('select[id$="-loadtype"]').forEach((sel) => {
      sel.addEventListener('change', () => {
        commitFieldEdits();
        // Re-read the changed select's own new value before re-rendering,
        // since commitFieldEdits() above just re-derived the load from the
        // OLD DOM (readLoadFromForm reads whatever <select> is showing at
        // the moment it's called, i.e. the just-changed value) — draft is
        // already correct at this point.
        renderFromDraft();
      });
    });

    function doSave() {
      commitFieldEdits();
      const errors = [];
      errors.push(...validateRequiredName(draft.name, 'Day name').errors);
      for (const section of ['main', 'accessory']) {
        for (const entry of draft.sections?.[section] ?? []) {
          const shape = classifyEntryShape(entry);
          const label = entry.displayName || 'Exercise';
          if (shape === 'flat') {
            errors.push(...validateFlatEntry(entry, { totalWeeks, knownBasisIds: REQUIRED_STARTER_LIFTS.map((l) => l.id) }).errors);
          } else if (shape === 'block-driven') {
            const values = getBlockDrivenWeekValues(entry, ctx.editWeek);
            if (values) errors.push(...validateBlockDrivenWeekPatch(values).errors.map((e) => `${label} (Week ${ctx.editWeek}): ${e}`));
          } else if (shape === 'week-percent-range') {
            const values = getWeekPercentRangeValues(entry, ctx.editWeek, parseSetsReps);
            if (values) errors.push(...validateWeekPercentRangePatch(values).errors.map((e) => `${label} (Week ${ctx.editWeek}): ${e}`));
          }
        }
      }
      errors.push(...validateDayBeforeSave(draft).errors.filter((e) => !errors.includes(e)));
      if (errors.length) { setStatus([...new Set(errors)]); return; }

      setStatus([]);
      statusEl.textContent = 'Saving…';
      root.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      saveDay(uid, program.id, originalDay.id, draft).then(() => {
        location.hash = `#/program?id=${encodeURIComponent(program.id)}&day=${encodeURIComponent(originalDay.id)}`;
      }).catch((err) => {
        console.error(err);
        setStatus([`Save failed: ${err.message}`]);
        root.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      });
    }

    root.querySelector('#save-top-btn').addEventListener('click', doSave);
    root.querySelector('#save-bottom-btn').addEventListener('click', doSave);

    function doCancel() {
      if (confirm('Discard your unsaved changes to this day?')) {
        location.hash = `#/program?id=${encodeURIComponent(program.id)}&day=${encodeURIComponent(originalDay.id)}`;
      }
    }
    root.querySelector('#cancel-top-btn').addEventListener('click', doCancel);
    root.querySelector('#cancel-bottom-btn').addEventListener('click', doCancel);
  }

  renderFromDraft();
}

export async function mount(root, { programId, dayId }) {
  root.innerHTML = '<div class="loading-state" role="status">Loading day…</div>';
  const uid = getCurrentUser().uid;
  const { editRequested, week } = parseExtraParams();

  const [{ program, days }, profile] = await Promise.all([
    getProgramWithDays(uid, programId),
    getUserProfile(uid),
  ]);

  if (!program) {
    root.innerHTML = '<div class="empty-state"><p>That program could not be found.</p></div>';
    return;
  }
  const day = days.find((d) => d.id === dayId);
  if (!day) {
    root.innerHTML = `
      <div class="empty-state"><p>That day could not be found.</p></div>
      <a href="#/program?id=${encodeURIComponent(programId)}" class="text-muted">&larr; Back to Program</a>`;
    return;
  }

  const totalWeeks = totalWeeksOf(program);
  const clampedWeek = Math.min(Math.max(week || 1, 1), totalWeeks || 1);

  if (editRequested) {
    renderEdit(root, { program, originalDay: day, uid, initialWeek: clampedWeek });
  } else {
    renderReadOnly(root, {
      program, day, week: clampedWeek, totalWeeks,
      currentMaxes: profile?.currentMaxes ?? {},
      // Phase 4 warm-up correction pass: the SAME rounding source
      // startOrResumeWorkout uses (js/views/workout.js passes
      // `profile?.settings?.rounding`) — not program.roundingRules, which
      // the real snapshot path never actually reads. Using the same source
      // here is part of guaranteeing preview and snapshot never disagree.
      rounding: profile?.settings?.rounding ?? {},
      uid,
    });
  }
}
