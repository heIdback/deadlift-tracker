// v1.1 — shared UI for logging a set's ACTUAL result (status / RPE / note)
// alongside its planned values. Used by both the live logger
// (js/views/workout.js) and History's existing completed-workout edit mode
// (js/views/history.js), so the two can never drift into two different
// set-logging behaviors. All state transitions come from the pure
// js/utils/setLogging.js; this file only renders and wires DOM.
//
// Every user-entered string (note) is rendered through escapeHtml.
import { escapeHtml } from '../utils/dom.js';
import {
  SET_STATUS, resolveSetStatus, applySetAction, refreshStatusAfterValueEdit,
  setStatusLabel, plannedDifferenceText, formatWeightReps,
} from '../utils/setLogging.js';

export function setLabel(s) {
  return s.kind === 'warmup' ? `W${s.setNumber}` : String(s.setNumber);
}

/** Row modifier classes for a status (kept compatible with the existing `.is-complete`). */
export function statusClasses(status) {
  switch (status) {
    case SET_STATUS.COMPLETED: return ['is-complete'];
    case SET_STATUS.MODIFIED: return ['is-complete', 'is-modified'];
    case SET_STATUS.FAILED: return ['is-failed'];
    case SET_STATUS.SKIPPED: return ['is-skipped'];
    default: return [];
  }
}
const ALL_STATUS_CLASSES = ['is-complete', 'is-modified', 'is-failed', 'is-skipped'];

function checkGlyph(status) {
  if (status === SET_STATUS.COMPLETED || status === SET_STATUS.MODIFIED) return '✓';
  if (status === SET_STATUS.FAILED) return '!';
  return '';
}

/** One compact line under the row: "⚠ Failed · Planned 160 × 5 · RPE 9 · note". Empty for a plain completed / not-logged set with no extras. */
export function statusLineText(s) {
  const status = resolveSetStatus(s);
  const bits = [];
  if (status === SET_STATUS.MODIFIED || status === SET_STATUS.FAILED || status === SET_STATUS.SKIPPED) {
    const { icon, text } = setStatusLabel(status);
    bits.push(`${icon} ${text}`);
  }
  const planned = plannedDifferenceText(s);
  if (planned) bits.push(planned);
  if (typeof s.rpe === 'number') bits.push(`RPE ${s.rpe}`);
  if (s.note) bits.push(s.note);
  return bits.join(' · ');
}

/** The ⋯ detail panel's inner HTML (hidden by default). */
function detailPanelHtml(s) {
  const status = resolveSetStatus(s);
  const planned = formatWeightReps(s.plannedKg, s.plannedReps, { durationSec: s.durationSec });
  return `
    <div class="set-row-detail" hidden>
      <div class="set-detail-planned text-muted">Planned: ${escapeHtml(planned || '—')}</div>
      <div class="set-detail-actions">
        <button type="button" class="chip set-fail-btn" aria-pressed="${status === SET_STATUS.FAILED}">Failed</button>
        <button type="button" class="chip set-skip-btn" aria-pressed="${status === SET_STATUS.SKIPPED}">Skip set</button>
      </div>
      <div class="set-detail-fields">
        <input class="set-input set-rpe" type="number" inputmode="decimal" step="0.5" min="0" max="10" placeholder="RPE" value="${s.rpe ?? ''}" aria-label="Actual RPE">
        <input class="set-input set-note" type="text" maxlength="200" placeholder="Note (optional)" value="${escapeHtml(s.note ?? '')}" aria-label="Set note">
      </div>
    </div>`;
}

/**
 * A full set block: the usual [index | kg | reps | ✓] row plus a ⋯ button,
 * a compact status line, and the hidden detail panel.
 * `opts.showKg` / `opts.showReps` mirror the logger's existing bodyweight /
 * timed-hold handling; `opts.dataAttrs` adds identifying data-* attributes.
 */
export function setBlockHtml(s, { showKg = true, showReps = true, repsPlaceholder = '—', dataAttrs = '' } = {}) {
  const label = setLabel(s);
  const status = resolveSetStatus(s);
  const classes = statusClasses(status).join(' ');
  const kgField = showKg
    ? `<input class="set-input set-kg" type="number" inputmode="decimal" step="0.5" min="0"
        value="${s.actualKg ?? ''}" placeholder="${escapeHtml(String(s.plannedKg ?? '—'))}" aria-label="Actual weight in kg">`
    : '<span class="set-input set-kg set-input-disabled">BW</span>';
  const repsField = showReps
    ? `<input class="set-input set-reps" type="number" inputmode="numeric" step="1" min="0"
        value="${s.actualReps ?? ''}" placeholder="${escapeHtml(String(s.plannedReps ?? repsPlaceholder))}" aria-label="Actual reps">`
    : `<span class="set-input set-reps set-input-disabled">${escapeHtml(s.durationSec)}s</span>`;
  const line = statusLineText(s);
  const logged = status === SET_STATUS.COMPLETED || status === SET_STATUS.MODIFIED || status === SET_STATUS.FAILED;
  return `
    <div class="set-block" ${dataAttrs}>
      <div class="set-row has-more ${classes}">
        <span class="set-index">${escapeHtml(label)}</span>
        ${kgField}
        ${repsField}
        <button type="button" class="set-check ${classes}" aria-pressed="${logged}" aria-label="Mark set ${escapeHtml(label)} done">${checkGlyph(status)}</button>
        <button type="button" class="set-more" aria-expanded="false" aria-label="More options for set ${escapeHtml(label)}">⋯</button>
      </div>
      <div class="set-row-status text-muted" ${line ? '' : 'hidden'}>${escapeHtml(line)}</div>
      ${detailPanelHtml(s)}
    </div>`;
}

/** Re-syncs a rendered block's classes/text with the set's current values (no re-render, so input focus is kept). */
export function updateSetBlock(blockEl, s) {
  const status = resolveSetStatus(s);
  const classes = statusClasses(status);
  const row = blockEl.querySelector('.set-row');
  const check = blockEl.querySelector('.set-check');
  for (const el of [row, check]) {
    if (!el) continue;
    el.classList.remove(...ALL_STATUS_CLASSES);
    el.classList.add(...classes);
  }
  if (check) {
    const logged = status === SET_STATUS.COMPLETED || status === SET_STATUS.MODIFIED || status === SET_STATUS.FAILED;
    check.setAttribute('aria-pressed', String(logged));
    check.textContent = checkGlyph(status);
  }
  const line = statusLineText(s);
  const lineEl = blockEl.querySelector('.set-row-status');
  if (lineEl) {
    lineEl.textContent = line;
    lineEl.hidden = !line;
  }
  blockEl.querySelector('.set-fail-btn')?.setAttribute('aria-pressed', String(status === SET_STATUS.FAILED));
  blockEl.querySelector('.set-skip-btn')?.setAttribute('aria-pressed', String(status === SET_STATUS.SKIPPED));
  const repsInput = blockEl.querySelector('input.set-reps');
  if (repsInput && document.activeElement !== repsInput) repsInput.value = s.actualReps ?? '';
}

/**
 * Wires one block to its (mutable) set object. `onChange(kind)` is called
 * after every change with 'value' (typing) or 'action' (a tap) so the caller
 * can pick its save cadence. The set object is updated IN PLACE (the
 * callers keep references into their exercises array).
 */
export function wireSetBlock(blockEl, set, onChange) {
  const commit = (next, kind) => {
    Object.assign(set, next);
    updateSetBlock(blockEl, set);
    onChange?.(kind);
  };

  const kgInput = blockEl.querySelector('input.set-kg');
  kgInput?.addEventListener('input', () => {
    const v = kgInput.value;
    commit(refreshStatusAfterValueEdit({ ...set, actualKg: v === '' ? null : Number(v) }), 'value');
  });
  const repsInput = blockEl.querySelector('input.set-reps');
  repsInput?.addEventListener('input', () => {
    const v = repsInput.value;
    commit(refreshStatusAfterValueEdit({ ...set, actualReps: v === '' ? null : Number(v) }), 'value');
  });
  blockEl.querySelector('.set-check')?.addEventListener('click', () => {
    commit(applySetAction(set, 'toggleDone'), 'action');
  });
  const more = blockEl.querySelector('.set-more');
  const panel = blockEl.querySelector('.set-row-detail');
  more?.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  });
  blockEl.querySelector('.set-fail-btn')?.addEventListener('click', () => {
    commit(applySetAction(set, 'toggleFailed'), 'action');
    if (set.status === SET_STATUS.FAILED && set.actualReps == null) repsInput?.focus();
  });
  blockEl.querySelector('.set-skip-btn')?.addEventListener('click', () => {
    commit(applySetAction(set, 'toggleSkipped'), 'action');
  });
  const rpeInput = blockEl.querySelector('.set-rpe');
  rpeInput?.addEventListener('input', () => {
    const v = rpeInput.value;
    const n = Number(v);
    commit({ ...set, rpe: v === '' || !Number.isFinite(n) ? null : Math.min(10, Math.max(0, n)) }, 'value');
  });
  const noteInput = blockEl.querySelector('.set-note');
  noteInput?.addEventListener('input', () => {
    commit({ ...set, note: noteInput.value.slice(0, 200) }, 'value');
  });
}
