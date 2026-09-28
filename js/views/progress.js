// Progress dashboard — Phase 4 "Final Progress Dashboard Implementation"
// correction pass. Replaces the placeholder that used to say "Charts...
// are built in Phase 4."
//
// HISTORICAL SOURCE OF TRUTH: every number on this screen is derived from
// COMPLETED WORKOUT DOCUMENTS (via workoutService.js's existing
// listCompletedWorkouts — the exact same query History already uses, no
// second concept) and from stored bodyweight measurements (via
// measurementService.js's listBodyweightHistory). This file never imports
// workoutSnapshot.js, programService.js's template reads, or currentMaxes —
// there is no code path here that could re-resolve a past workout against a
// live program/template/current-max, so a later template edit, a
// duplicated program, an active-program switch, a program rename, or a
// changed current 1RM cannot change anything this screen shows for a past
// workout. See js/utils/progressAnalytics.js's own module comment for the
// full argument.
//
// CHARTS: plain inline SVG built by hand (buildSparklinePoints in
// progressAnalytics.js does the scaling math; this file turns that into a
// <polyline>/<circle> string) — no chart library, no new dependency, stays
// GitHub-Pages-friendly.
import { getCurrentUser } from '../core/auth.js';
import { listCompletedWorkouts } from '../services/workoutService.js';
import { listBodyweightHistory } from '../services/measurementService.js';
import {
  listAvailableExercises, topWeightSeries, estimated1RMSeries, volumeSeries,
  bodyweightSeries, buildSparklinePoints, latestValue, EST_1RM_MAX_REPS,
  computeYAxisTicks,
} from '../utils/progressAnalytics.js';
// Phase 5C, Package 1 — the Epley formula itself, reused ONLY to compute
// the one worked example in the "About Estimated 1RM" explanation block
// (spec section 13) from the real function every actual Estimated 1RM
// number on this screen already goes through (progressAnalytics.js's
// estimated1RMSeries), rather than a hand-typed number that could drift
// out of sync with the real formula/rounding.
import { epleyEstimate1RM } from '../utils/calculations.js';
// Phase 5C, Package 1 — "Current 1RM History" (spec section 7-11): pure,
// Firebase-free helpers that turn already-fetched max-history + bodyweight
// records into display rows, with the bodyweight-association and ratio
// rules fully unit-tested independent of this file. See that module's own
// comment for why it structurally cannot leak Tested PR/Estimated data
// into this list.
import { buildCurrentMaxHistoryRows } from '../utils/maxHistoryAnalytics.js';
// Phase 5B, Package 1 — Current 1RM is read here for side-by-side DISPLAY
// (spec section 8: "Current 1RM, if that exercise has a user-controlled
// Current 1RM") and for the passive suggestion comparison in section 9.
// getUserProfile is a plain read, and prAnalytics.js itself (the module
// every actual PR/Baseline number below comes from) has no import path to
// currentMaxes at all, so nothing there can feed back into it. This was a
// deliberate, narrow, read-only relaxation of this file's prior "never
// reads currentMaxes" invariant — see the module comment above for the
// original reasoning, which still fully holds for every derived PR/chart
// number: no code path here re-resolves a PAST workout against a live 1RM,
// and Top Weight/Estimated 1RM series/Training Volume remain exactly as
// before. Phase 5B, Package 2 adds the one narrow exception: this file now
// also WRITES a new Current 1RM, but only via recordOneRepMax, and only
// from one explicit, confirmed, user-initiated action (see
// wireUpdateAction below) — never automatically, never a second storage
// path, and never touching any already-created workout snapshot (a
// snapshot is resolved once, at Start time, from workoutSnapshot.js — see
// that module's own comment; nothing here or there re-resolves an existing
// snapshot against a changed Current 1RM).
// Phase 5B, Package 2 — recordOneRepMax is now called from here too, but
// ONLY from one explicit, confirmed, user-initiated action (see
// wireUpdateAction below): adopting an already-tested result as the new
// Current 1RM. This reuses the exact same write path Profile's "Save maxes"
// button already uses — no second Current-1RM storage mechanism, no direct
// users/{uid} field patch, no bypass of the append-only max history.
// Phase 5C, Package 1 — getMaxHistory is the EXISTING, already-shipped
// max-history read (js/services/userService.js's own append-only
// `users/{uid}/maxes` query) — the "Current 1RM History" section reuses it
// as-is, never a second history source and never a reconstruction from
// workout PRs (spec section 7).
import { getUserProfile, recordOneRepMax, getMaxHistory } from '../services/userService.js';
import {
  computeAllPrEvents, recentPrEventsForExercise, latestEventOfType, prTypeLabel, PR_TYPE,
} from '../utils/prAnalytics.js';
import { formatDate } from '../utils/dates.js';
import { escapeHtml } from '../utils/dom.js';

const HISTORY_LIMIT = 200;
const BODYWEIGHT_LIMIT = 100;

function formatKg(value) {
  if (value == null) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
}

/** 1-decimal rounding, used for the all-time headline numbers (Best Tested 1RM / Best Estimated 1RM) and for chart tooltips, so they read consistently with every other weight on this screen. */
function round1(v) {
  return Math.round(v * 10) / 10;
}

// ── Phase 5C, Package 1 — interactive charts (Y-axis + tooltips) ────────
//
// Fixed viewBox geometry, shared by every chart on this screen. AXIS_LEFT
// reserves room for the Y-axis tick labels; the plotted data (line/points)
// occupies the remaining width to its right. `.sparkline`'s own CSS
// (`width:100%; height:auto`) stretches this to the card's actual width —
// unchanged from Phase 4 — so these are viewBox UNITS, not real pixels; a
// 320px-wide card renders this at roughly 1 unit ≈ 1px, which is what the
// tick-label font size below is tuned for.
const CHART_WIDTH = 300;
const CHART_HEIGHT = 88;
const CHART_PADDING = 6;
const CHART_AXIS_LEFT = 34;
const CHART_PLOT_WIDTH = CHART_WIDTH - CHART_AXIS_LEFT;

let chartIdSeq = 0;

/** Compact axis-tick number formatting: "1.5k" instead of "1,500" once a chart's own units get large (Training Volume) — units themselves are NOT repeated on every tick (the card's own label/title already establishes "kg"; repeating it 4x in a 28px-wide margin would only crowd the numbers, never add information). */
function formatAxisNumber(v) {
  const rounded = Math.round(v * 10) / 10;
  if (Math.abs(rounded) >= 1000) {
    const kVal = rounded / 1000;
    return `${Number.isInteger(kVal) ? kVal : kVal.toFixed(1)}k`;
  }
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** Spec section 4 — the Y-axis: ~3-5 nice-number gridlines + right-aligned tick labels drawn in the reserved CHART_AXIS_LEFT margin, sharing the exact same value->y scale as the plotted line/points (via the caller passing the SAME {min,max} computeYAxisTicks already produced). */
function yAxisSvg(axis, formatTick) {
  const { min, max, ticks } = axis;
  const span = (max - min) || 1;
  const innerH = CHART_HEIGHT - CHART_PADDING * 2;
  return ticks.map((t) => {
    const y = CHART_PADDING + innerH - ((t - min) / span) * innerH;
    return `
      <line x1="${CHART_AXIS_LEFT}" y1="${y.toFixed(1)}" x2="${CHART_WIDTH - CHART_PADDING}" y2="${y.toFixed(1)}" class="chart-gridline" />
      <text x="${CHART_AXIS_LEFT - 6}" y="${(y + 2.6).toFixed(1)}" class="chart-tick-label" text-anchor="end">${escapeHtml(formatTick(t))}</text>`;
  }).join('');
}

/**
 * Builds one interactive chart: Y-axis + line + points, each point carrying
 * BOTH a small visible dot (unchanged look from Phase 4) and a much larger
 * invisible, focusable hit target (spec section 5: "use a larger invisible
 * hit target rather than making giant dots") so it stays easy to tap/hover
 * without changing the chart's visual density. `tooltipInfo(point)` builds
 * the per-point {title, lines[], aria} content shown on hover/focus/tap —
 * see the four *TooltipInfo functions below (one per chart) for the actual
 * wording, kept separate from this generic renderer so THIS function has no
 * per-metric knowledge at all.
 *
 * Returns the HTML plus enough to wire interactivity afterward (chartId +
 * the exact points array, in the SAME order the DOM circles were built in)
 * — wireChartTooltip (called after the surrounding innerHTML is set)
 * reads both.
 */
function chartSvgHtml(series, { color = 'var(--accent)', emptyMessage, tooltipInfo } = {}) {
  if (!series.length) {
    return { html: `<p class="text-muted">${escapeHtml(emptyMessage ?? 'No data yet.')}</p>`, chartId: null, points: null, tooltipInfo: null };
  }
  if (series.length === 1) {
    const only = series[0];
    return {
      html: `
        <div class="sparkline-single">
          <span class="sparkline-dot" style="background:${color}"></span>
          <span>${escapeHtml(formatDate(only.date))} — one data point so far. More workouts will draw a trend here.</span>
        </div>`,
      chartId: null,
      points: null,
      tooltipInfo: null,
    };
  }

  const chartId = `chart-${(chartIdSeq += 1)}`;
  const axis = computeYAxisTicks(series.map((p) => p.value));
  const rawPoints = buildSparklinePoints(series, {
    width: CHART_PLOT_WIDTH, height: CHART_HEIGHT, padding: CHART_PADDING, yMin: axis.min, yMax: axis.max,
  });
  // Shift every plotted x by the reserved axis margin — buildSparklinePoints
  // itself stays completely unaware of the axis (it just scales into
  // 0..CHART_PLOT_WIDTH), so this is the one place the two concerns join.
  const points = rawPoints.map((p) => ({ ...p, x: p.x + CHART_AXIS_LEFT }));
  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const first = series[0];
  const last = series.at(-1);

  const circles = points.map((p, i) => {
    const info = tooltipInfo(p);
    return `
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${color}" />
      <circle class="chart-hit" data-index="${i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="12" fill="transparent" tabindex="0" role="img" aria-label="${escapeHtml(info.aria)}"></circle>`;
  }).join('');

  const html = `
    <div class="chart-wrap" data-chart-id="${chartId}">
      <svg class="sparkline" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="Trend from ${escapeHtml(formatDate(first.date))} to ${escapeHtml(formatDate(last.date))}">
        ${yAxisSvg(axis, formatAxisNumber)}
        <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        ${circles}
      </svg>
      <div class="chart-tooltip" id="${chartId}-tooltip" role="status" aria-live="polite" hidden></div>
      <div class="sparkline-range text-muted">
        <span>${escapeHtml(formatDate(first.date))}</span>
        <span>${escapeHtml(formatDate(last.date))}</span>
      </div>
    </div>`;

  return { html, chartId, points, tooltipInfo };
}

/**
 * Wires hover/focus/tap interactivity for one already-rendered chart
 * (called once right after its container's innerHTML is set — same
 * "render then wire" convention as wireUpdateAction elsewhere in this
 * file). Spec sections 2/3/5/6:
 *   - desktop hover (mouseenter) and keyboard focus always show/update the
 *     tooltip for whichever point is hovered/focused;
 *   - a tap/click PINS the tooltip open (so it survives the pointer
 *     leaving on a touch device, which has no real hover) and moves it
 *     immediately if a DIFFERENT point is tapped next;
 *   - tapping/clicking anywhere outside this chart's own wrapper unpins
 *     and dismisses it (the click is deliberately allowed to bubble to
 *     `document`, never stopped, so every OTHER chart's own "outside
 *     click" listener also sees it and dismisses ITS pinned tooltip too —
 *     tapping chart B's point correctly dismisses chart A's open tooltip).
 * Positioning uses the hit-circle's OWN plotted (x, y) — already the real
 * data position, never reverse-engineered from a DOM query — converted to
 * on-screen pixels via the rendered SVG's own bounding rect, then clamped
 * to stay inside the chart's own card (never off-screen at 320px/384px).
 */
function wireChartTooltip(root, chart) {
  if (!chart || !chart.chartId || !chart.points) return;
  const wrap = root.querySelector(`[data-chart-id="${chart.chartId}"]`);
  const svg = wrap?.querySelector('svg.sparkline');
  const tooltip = wrap?.querySelector('.chart-tooltip');
  if (!wrap || !svg || !tooltip) return;

  let pinned = false;

  function positionAndShow(index) {
    const p = chart.points[index];
    if (!p) return;
    const info = chart.tooltipInfo(p);
    tooltip.innerHTML = `<div class="chart-tooltip-title"></div>${info.lines.map(() => '<div class="chart-tooltip-line"></div>').join('')}`;
    // textContent, never innerHTML, for the actual values/labels — Package
    // 1's own dataviz convention (untrusted-label safety), even though every
    // value here is this app's own formatted number, not external input.
    tooltip.querySelector('.chart-tooltip-title').textContent = info.title;
    const lineEls = tooltip.querySelectorAll('.chart-tooltip-line');
    info.lines.forEach((line, i) => { lineEls[i].textContent = line; });
    tooltip.hidden = false;

    const svgRect = svg.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const pxX = svgRect.left - wrapRect.left + (p.x / CHART_WIDTH) * svgRect.width;
    const pxY = svgRect.top - wrapRect.top + (p.y / CHART_HEIGHT) * svgRect.height;
    const ttWidth = tooltip.offsetWidth;
    const ttHeight = tooltip.offsetHeight;
    let left = pxX - ttWidth / 2;
    const maxLeft = Math.max(4, wrap.clientWidth - ttWidth - 4);
    left = Math.min(Math.max(4, left), maxLeft);
    let top = pxY - ttHeight - 10; // default: above the point
    if (top < 0) top = pxY + 14; // flip below if there's no room above (e.g. the very top row of points)
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hide() {
    tooltip.hidden = true;
  }

  wrap.querySelectorAll('.chart-hit').forEach((hit) => {
    const index = Number(hit.dataset.index);
    hit.addEventListener('mouseenter', () => positionAndShow(index));
    hit.addEventListener('mouseleave', () => { if (!pinned) hide(); });
    hit.addEventListener('focus', () => positionAndShow(index));
    hit.addEventListener('blur', () => { if (!pinned) hide(); });
    hit.addEventListener('click', () => {
      pinned = true;
      positionAndShow(index);
    });
  });
  document.addEventListener('click', (e) => {
    if (pinned && !wrap.contains(e.target)) {
      pinned = false;
      hide();
    }
  });
}

// ── Per-chart tooltip content (spec section 3) — real underlying values,
// never reverse-engineered from pixel positions. Each returns
// {title, lines: string[], aria} — `lines` is what's shown visually,
// `aria` is the single spoken-out-loud sentence for screen readers (spec
// section 6's own worked example format).
function estimatedTooltipInfo(p) {
  const title = formatDate(p.date);
  const valueKg = round1(p.value);
  const lines = [formatKg(valueKg)];
  let aria = `${title}, Estimated 1RM ${valueKg} kilograms`;
  if (p.sourceKg != null && p.sourceReps != null) {
    lines.push(`from ${formatKg(p.sourceKg)} × ${p.sourceReps}`);
    aria += `, from ${p.sourceKg} kilograms for ${p.sourceReps} rep${p.sourceReps === 1 ? '' : 's'}`;
  }
  return { title, lines, aria };
}
function topWeightTooltipInfo(p) {
  const title = formatDate(p.date);
  const lines = [formatKg(p.value)];
  let aria = `${title}, Top Weight ${p.value} kilograms`;
  if (p.sourceReps != null) {
    lines.push(`${p.sourceReps} rep${p.sourceReps === 1 ? '' : 's'}`);
    aria += `, ${p.sourceReps} rep${p.sourceReps === 1 ? '' : 's'}`;
  }
  return { title, lines, aria };
}
function volumeTooltipInfo(p) {
  const title = formatDate(p.date);
  const rounded = Math.round(p.value);
  return { title, lines: [`${rounded.toLocaleString()} kg`], aria: `${title}, Training Volume ${rounded} kilograms` };
}
function bodyweightTooltipInfo(p) {
  const title = formatDate(p.date);
  return { title, lines: [formatKg(p.value)], aria: `${title}, Bodyweight ${round1(p.value)} kilograms` };
}

function metricCard(title, subtitle, series, { format = formatKg, color, tooltipInfo } = {}) {
  const latest = latestValue(series);
  const chart = chartSvgHtml(series, { color, emptyMessage: 'Log a completed working set to see this trend.', tooltipInfo });
  return {
    html: `
      <div class="card">
        <div class="card-label">${escapeHtml(title)}</div>
        <div class="card-title">${escapeHtml(format(latest))}</div>
        ${subtitle ? `<p class="text-muted" style="margin-top:-4px">${subtitle}</p>` : ''}
        ${chart.html}
      </div>`,
    chart,
  };
}

/**
 * Phase 5B, Package 1, spec section 8 — the Current / Tested / Estimated
 * 1RM separation, "labels must be explicit... these values may legitimately
 * disagree... do not label estimated values simply '1RM'". Three
 * independently-sourced numbers, reusing the existing `.stat-grid`/
 * `.stat-card` layout (css/components.css) rather than inventing new
 * layout CSS:
 *   - Current 1RM: the user-controlled programming max (users/{uid}'s
 *     `currentMaxes` cache, read via getUserProfile — see this file's own
 *     import comment) — omitted entirely if this exercise has none on file,
 *     never shown as 0/blank.
 *   - Best Tested 1RM / Best Estimated 1RM: derived, historical, from
 *     prAnalytics.js — completely independent of Current 1RM and of each
 *     other. Either can be null (no qualifying history yet), rendered as
 *     "—", never fabricated.
 * Never mutates currentMaxes and never offers to — see prSuggestionHtml
 * below for the one, explicitly passive, suggestion this package allows.
 */
function maxesSummaryHtml({ currentKg, testedEvent, estimatedEvent }) {
  const cards = [];
  if (currentKg != null) {
    cards.push(`<div class="stat-card"><div class="stat-label">Current 1RM</div><div class="stat-value">${formatKg(currentKg)}</div></div>`);
  }
  cards.push(`<div class="stat-card"><div class="stat-label">Best Tested 1RM</div><div class="stat-value">${testedEvent ? formatKg(testedEvent.value) : '—'}</div></div>`);
  cards.push(`<div class="stat-card"><div class="stat-label">Best Estimated 1RM</div><div class="stat-value">${estimatedEvent ? formatKg(round1(estimatedEvent.value)) : '—'}</div></div>`);
  return `<div class="stat-grid">${cards.join('')}</div>`;
}

/**
 * Spec section 9 — a PASSIVE suggestion only: text, never a form/button
 * (Package 1: "If this adds too much scope, defer the action and only show
 * the suggestion" — deliberately taken then, to keep Package 1's scope to
 * PR detection/display). Package 2, spec section 6, keeps this function
 * exactly as-is and adds the one sanctioned action SEPARATELY, in
 * wireUpdateAction below, gated only on the Tested comparison (never
 * Estimated — Estimated stays passive-only text here in Package 2 too).
 * Shown only when a Tested or Estimated result actually exceeds the
 * CURRENT on-file value (never when there's no Current 1RM to compare
 * against at all, and never when Tested/Estimated is merely equal to or
 * below it) — comparisons are always on the raw numeric kg values, never
 * formatted/rounded strings, per spec section 10.
 *
 * REAL-BROWSER ACCEPTANCE CORRECTION: this used to fire "New tested PR: …"
 * whenever Best Tested > Current 1RM, full stop — but a first-ever Tested
 * result can legitimately exceed Current 1RM while still being a BASELINE,
 * not a PR (e.g. Current 1RM manually set to 40 kg, then the very first
 * logged Bench single ever, 55×1, correctly becomes a Baseline in the PR
 * engine — it has no prior Tested history to beat — yet 55 > 40). Calling
 * that a "PR" was wrong: there was nothing to break a record against.
 * `testedEvent`/`estimatedEvent` (from prAnalytics.js's
 * `latestEventOfType`, the exact same events History's own badges/detail
 * lines are built from) now carry a `kind` ('baseline' | 'pr'), so the
 * wording is chosen from THAT, never inferred a second time from a bare
 * number comparison — the useful Current-vs-Tested/Estimated information
 * is still always shown when it exceeds Current 1RM, just never
 * mislabeled as a PR when it was actually a Baseline.
 */
function prSuggestionHtml({ currentKg, testedEvent, estimatedEvent }) {
  if (currentKg == null) return '';
  const notes = [];
  if (testedEvent && testedEvent.value > currentKg) {
    notes.push(testedEvent.kind === 'pr'
      ? `New tested PR: ${formatKg(testedEvent.value)}. Current 1RM is ${formatKg(currentKg)}.`
      : `Best tested 1RM is ${formatKg(testedEvent.value)}. Current 1RM is ${formatKg(currentKg)}.`);
  }
  if (estimatedEvent && estimatedEvent.value > currentKg) {
    notes.push(estimatedEvent.kind === 'pr'
      ? `Estimated 1RM reached ${formatKg(round1(estimatedEvent.value))}. Current 1RM is ${formatKg(currentKg)}.`
      : `Best estimated 1RM is ${formatKg(round1(estimatedEvent.value))}. Current 1RM is ${formatKg(currentKg)}.`);
  }
  if (!notes.length) return '';
  return `<div class="pr-suggestion">${notes.map((n) => `<p style="margin:0">${escapeHtml(n)}</p>`).join('')}</div>`;
}

/** Spec section 8, "useful PR information/trend where practical" — a short, restrained list (never a full second chart system: this package explicitly does not redesign Progress), newest-first, PR events only (never Baseline — see prAnalytics.js's own module comment for why a Baseline isn't a PR). */
function recentPrsHtml(events) {
  if (!events.length) return '';
  const lines = events.map((e) => {
    const typeLabel = prTypeLabel(e.type, e.repCount);
    const valueText = e.type === PR_TYPE.ESTIMATED_1RM
      ? `${formatKg(round1(e.value))} <span class="pr-estimated-tag">(from ${e.actualKg} kg × ${e.actualReps})</span>`
      : (e.type === PR_TYPE.REP ? `${e.actualKg} kg × ${e.actualReps}` : formatKg(e.actualKg));
    return `<li><strong>${escapeHtml(typeLabel)}</strong>: ${valueText} — ${escapeHtml(formatDate(e.finishedAt))}</li>`;
  });
  return `
    <div class="card">
      <div class="card-label">Recent PRs</div>
      <ul class="pr-recent-list">${lines.join('')}</ul>
    </div>`;
}

/**
 * Phase 5B, Package 2, spec sections 1-14 — the ONE explicit action this
 * package adds: adopting an already-Tested result as the new Current 1RM.
 *
 * Deliberately separate from prSuggestionHtml (which stays exactly as it
 * was in Package 1 — a passive TEXT note, covering Tested AND Estimated
 * alike). This function renders ONLY the actionable button/confirmation,
 * and ONLY for Tested results (spec section 6: Estimated stays passive-only
 * in this package, no exceptions) — gated purely on
 * `testedEvent.value > currentKg`, regardless of whether that testedEvent
 * is a Baseline or a PR (section 6: "adopting a real completed single as a
 * programming max is not about whether it beat a previous single").
 *
 * State (idle / confirming / saving / error) lives only in this container's
 * DOM + closure for the lifetime of one renderExerciseSection() call — a
 * fresh call (exercise switch, online/offline flip, or the post-success
 * rerender this function itself triggers) always starts back at idle. That
 * is correct, not a bug: switching exercises mid-confirmation should not
 * carry a stale confirmation over to a different lift.
 */
function wireUpdateAction(container, { uid, exerciseId, exerciseLabel, currentKg, testedEvent, currentMaxes, rerender }) {
  if (!container) return;
  const eligible = currentKg != null && testedEvent && testedEvent.value > currentKg;
  if (!eligible) {
    container.innerHTML = '';
    return;
  }
  const newKg = testedEvent.value;

  function renderIdle() {
    const online = navigator.onLine;
    container.innerHTML = `
      <div class="pr-suggestion">
        <button type="button" class="btn btn-primary" id="update-1rm-btn"${online ? '' : ' disabled'}>Update Current 1RM to ${formatKg(newKg)}</button>
        ${online ? '' : '<p class="form-status" role="status">Updating Current 1RM requires an internet connection.</p>'}
      </div>`;
    container.querySelector('#update-1rm-btn')?.addEventListener('click', () => {
      if (!navigator.onLine) { renderIdle(); return; }
      renderConfirm();
    });
  }

  function renderConfirm() {
    container.innerHTML = `
      <div class="pr-suggestion">
        <p style="margin:0 0 8px"><strong>Update ${escapeHtml(exerciseLabel)} Current 1RM?</strong></p>
        <p style="margin:0 0 8px">${formatKg(currentKg)} → ${formatKg(newKg)}</p>
        <p class="text-muted" style="margin:0 0 12px">Future percentage-based prescriptions will use the new Current 1RM. Existing, in-progress, and completed workout snapshots will not change.</p>
        <div class="btn-stack">
          <button type="button" class="btn btn-primary" id="confirm-1rm-btn">Update 1RM</button>
          <button type="button" class="btn btn-secondary" id="cancel-1rm-btn">Cancel</button>
        </div>
        <p class="form-status" id="update-1rm-status" role="status"></p>
      </div>`;
    container.querySelector('#cancel-1rm-btn').addEventListener('click', renderIdle);
    container.querySelector('#confirm-1rm-btn').addEventListener('click', async () => {
      if (!navigator.onLine) { renderIdle(); return; }
      const status = container.querySelector('#update-1rm-status');
      const buttons = container.querySelectorAll('button');
      buttons.forEach((b) => { b.disabled = true; }); // spec section 10: guard against a duplicate write mid-flight
      status.textContent = 'Updating…';
      try {
        // Spec section 3: the EXACT same write mechanism as Profile's
        // "Save maxes" button — recordOneRepMax(uid, {...}) — no second
        // Current-1RM storage path. kind: 'tested' is the existing,
        // already-documented enum value describing a genuinely tested
        // result (as opposed to Profile's manual 'training' edits).
        // source: 'tested_pr' is a new but schema-compatible free-text
        // value (see js/services/userService.js's own comment; confirmed
        // against firestore.rules — no enum restriction on this field).
        await recordOneRepMax(uid, { exerciseId, kg: newKg, kind: 'tested', source: 'tested_pr' });
        // Spec section 7/10: reflect the save locally (same convention as
        // history.js's edit-mode save) rather than a full profile re-fetch,
        // then re-render the WHOLE exercise section so the stat-card and
        // suggestion text immediately pick up the new Current 1RM with no
        // gap and no manual reload.
        currentMaxes[exerciseId] = { kg: newKg, kind: 'tested', updatedAt: new Date() };
        status.textContent = 'Updated.';
        rerender?.();
      } catch (err) {
        console.error('progress.js: Current 1RM update failed', err);
        status.textContent = `Error: ${err.message}`;
        buttons.forEach((b) => { b.disabled = false; }); // spec section 10: old Current 1RM is untouched, allow retry
      }
    });
  }

  renderIdle();
}

// Spec sections 7-11 & 10 — default visible rows before "Show all"; no
// pagination infrastructure (spec explicitly says not to build one unless
// truly necessary — this app's own history is small enough that a single
// expand toggle is all that's warranted).
const CURRENT_MAX_HISTORY_INITIAL = 5;

/**
 * Phase 5C, Package 1 — "Current 1RM History" (spec sections 7-11).
 * Fetches the EXISTING, already-shipped append-only max-history for this
 * one exercise (getMaxHistory — the same `users/{uid}/maxes` documents
 * Package 2's own Update-Current-1RM action, and Profile's manual "Save
 * maxes" button before it, already write) and renders it newest-first with
 * each entry's own associated bodyweight and strength/bodyweight ratio,
 * both computed by maxHistoryAnalytics.js (pure, independently unit-
 * tested — see that file). This is deliberately the one async piece of an
 * otherwise fully-synchronous exercise-section render: everything else on
 * this screen already sits in memory from mount()'s own Promise.all, but
 * per-exercise max history has never previously been fetched by this file
 * at all, so it gets its own small loading state rather than blocking the
 * rest of the section on it.
 */
function wireCurrentMaxHistory(container, { uid, exerciseId, exerciseLabel, bodyweightRecords }) {
  if (!container) return;
  container.innerHTML = `<h3>Current 1RM History</h3><p class="text-muted" role="status">Loading history…</p>`;

  getMaxHistory(uid, exerciseId).then((entries) => {
    // Each call to renderExerciseSection rebuilds #current-1rm-history from
    // scratch (it's part of that one section.innerHTML write), so a slower
    // fetch from a PREVIOUS exercise/render finishing after a newer one has
    // already replaced this container would otherwise paint stale history
    // over the current selection. isConnected catches exactly that case —
    // a fast exercise switch, or the online/offline listener's rerender —
    // without needing any cancellation plumbing.
    if (!container.isConnected) return;
    renderRows(buildCurrentMaxHistoryRows(entries, bodyweightRecords));
  }).catch((err) => {
    console.error('progress.js: Current 1RM history fetch failed (non-fatal — rest of Progress is unaffected)', err);
    if (!container.isConnected) return;
    container.innerHTML = `<h3>Current 1RM History</h3><p class="text-muted">History unavailable right now.</p>`;
  });

  function renderRows(rows) {
    if (!rows.length) {
      // Spec section 11: a legacy/incomplete account may have a Current 1RM
      // with no matching history entry at all (it predates this feature, or
      // predates recordOneRepMax being called for this lift). The stat card
      // above already shows the current value normally — this section simply
      // says history isn't available, and never fabricates a row/date to
      // populate the table.
      container.innerHTML = `
        <h3>Current 1RM History</h3>
        <p class="text-muted">No Current 1RM history recorded yet for ${escapeHtml(exerciseLabel)}.</p>`;
      return;
    }

    let expanded = false;

    function renderTable() {
      const shown = expanded ? rows : rows.slice(0, CURRENT_MAX_HISTORY_INITIAL);
      // A real <table> is deliberately avoided here — this codebase's own
      // established convention for tabular data at mobile widths is a CSS
      // Grid built from plain divs (see css/views.css's .set-table/.set-row,
      // used by the workout logger), which guarantees column widths that
      // never force horizontal scroll at 320px the way a native <table>'s
      // auto layout can. `.history-row`'s own grid-template-columns is
      // tuned for exactly these four columns.
      container.innerHTML = `
        <h3>Current 1RM History</h3>
        <div class="history-table" role="table" aria-label="${escapeHtml(exerciseLabel)} Current 1RM history">
          <div class="history-row history-row-head" role="row">
            <span role="columnheader">Date</span>
            <span role="columnheader">Current 1RM</span>
            <span role="columnheader">Bodyweight</span>
            <span role="columnheader">1RM : BW</span>
          </div>
          ${shown.map((r) => `
            <div class="history-row" role="row">
              <span role="cell">${escapeHtml(formatDate(r.date))}</span>
              <span role="cell">${escapeHtml(formatKg(r.kg))}</span>
              <span role="cell">${r.bodyweightKg == null ? '—' : escapeHtml(formatKg(r.bodyweightKg))}</span>
              <span role="cell">${r.ratio == null ? '—' : `${r.ratio.toFixed(2)}×`}</span>
            </div>`).join('')}
        </div>
        ${rows.length > CURRENT_MAX_HISTORY_INITIAL ? `
          <button type="button" class="btn btn-secondary" id="history-toggle-btn" style="margin-top:8px">${expanded ? 'Show fewer' : `Show all (${rows.length})`}</button>` : ''}
        <p class="text-muted" style="margin-top:6px">Ratio is descriptive only (Current 1RM ÷ bodyweight at that time) — it isn't a score or ranking.</p>`;
      container.querySelector('#history-toggle-btn')?.addEventListener('click', () => {
        expanded = !expanded;
        renderTable();
      });
    }

    renderTable();
  }
}

function renderExerciseSection(root, { exercises, selectedId, completed, currentMaxes, eventsByExercise, uid, rerender, bodyweightRecords }) {
  const section = root.querySelector('#exercise-metrics');
  if (!exercises.length) {
    section.innerHTML = `
      <div class="empty-state">
        <p>No weighted working-set history yet. Complete a workout with a logged weight to see Strength, Top Weight, and Training Volume here.</p>
      </div>`;
    return;
  }

  const topWeight = topWeightSeries(completed, selectedId);
  const est1RM = estimated1RMSeries(completed, selectedId);
  const volume = volumeSeries(completed, selectedId);

  const currentKg = typeof currentMaxes?.[selectedId]?.kg === 'number' ? currentMaxes[selectedId].kg : null;
  // Phase 5B, Package 1 real-browser acceptance correction: Best Tested/
  // Estimated 1RM and the suggestion's Baseline-vs-PR wording now come from
  // the SAME already-computed event list (eventsByExercise, from
  // computeAllPrEvents at mount) via latestEventOfType — a single source
  // of truth for "what is the current best, and how was it established" —
  // rather than a separate bestTestedOneRepMax/bestEstimatedOneRepMax scan
  // that had no way to report `kind`.
  const exerciseEvents = eventsByExercise.get(selectedId) ?? [];
  const testedEvent = latestEventOfType(exerciseEvents, PR_TYPE.TESTED_1RM);
  const estimatedEvent = latestEventOfType(exerciseEvents, PR_TYPE.ESTIMATED_1RM);
  const recentPrs = recentPrEventsForExercise(eventsByExercise, selectedId, 5);
  const exerciseLabel = exercises.find((e) => e.exerciseId === selectedId)?.label ?? selectedId;

  const estCard = metricCard(
    'Estimated 1RM',
    `Estimated from actual completed sets (Epley formula, working sets ≤ ${EST_1RM_MAX_REPS} reps) — not a tested 1RM.`,
    est1RM,
    { tooltipInfo: estimatedTooltipInfo },
  );
  const topWeightCard = metricCard('Top Weight', 'Highest actual completed working weight.', topWeight, { tooltipInfo: topWeightTooltipInfo });
  const volumeCard = metricCard(
    'Training Volume',
    'Working sets only — warm-up ramps are excluded.',
    volume,
    { format: (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()} kg`), tooltipInfo: volumeTooltipInfo },
  );

  section.innerHTML = `
    ${maxesSummaryHtml({ currentKg, testedEvent, estimatedEvent })}
    ${prSuggestionHtml({ currentKg, testedEvent, estimatedEvent })}
    <div id="current-1rm-action"></div>
    ${estCard.html}
    ${topWeightCard.html}
    ${volumeCard.html}
    <div id="current-1rm-history"></div>
    ${recentPrsHtml(recentPrs)}`;

  // Wire tooltip interactivity AFTER the HTML above lands in the DOM — each
  // chartSvgHtml() call above returned a null `chart` for an empty/single-
  // point series (chartId stays null), which wireChartTooltip already
  // no-ops on, so this is safe to call unconditionally for all three.
  [estCard.chart, topWeightCard.chart, volumeCard.chart].forEach((chart) => wireChartTooltip(section, chart));

  wireUpdateAction(section.querySelector('#current-1rm-action'), {
    uid, exerciseId: selectedId, exerciseLabel, currentKg, testedEvent, currentMaxes, rerender,
  });

  wireCurrentMaxHistory(section.querySelector('#current-1rm-history'), { uid, exerciseId: selectedId, exerciseLabel, bodyweightRecords });
}

function renderBodyweight(root, records) {
  const section = root.querySelector('#bodyweight-section');
  const series = bodyweightSeries(records);

  if (!series.length) {
    section.innerHTML = `
      <div class="card">
        <div class="card-label">Bodyweight</div>
        <p class="text-muted">No bodyweight logged yet. Log your bodyweight from Profile to see it here.</p>
      </div>`;
    return;
  }

  const card = metricCard('Bodyweight', null, series, { color: 'var(--success)', tooltipInfo: bodyweightTooltipInfo });
  section.innerHTML = card.html;
  wireChartTooltip(section, card.chart);
}

/**
 * Spec section 13 — a small, visually secondary explanation of what
 * "Estimated 1RM" means, placed once at the bottom of Progress (not
 * repeated per-exercise, since the formula itself never changes per lift).
 * Deliberately short — "do not make this a giant educational section" —
 * and its one worked example calls the REAL epleyEstimate1RM function
 * (the exact same one estimated1RMSeries uses for every actual number on
 * this screen) rather than a hand-typed value, so the example can never
 * drift out of sync with the real formula or its rounding.
 */
function aboutEstimated1RMHtml() {
  const example = round1(epleyEstimate1RM(100, 5));
  return `
    <details class="text-muted" style="margin-top:24px">
      <summary style="cursor:pointer">About Estimated 1RM</summary>
      <p style="margin:8px 0 0">
        Estimated 1RM uses the Epley formula — <code>e1RM = weight × (1 + reps ÷ 30)</code> —
        applied only to completed working sets (warm-up ramps and incomplete sets are excluded).
        For example, ${formatKg(100)} × 5 reps → an estimated ${formatKg(example)} 1RM.
        A completed single rep is shown as a Tested 1RM, not an estimate.
      </p>
    </details>`;
}

export async function mount(root) {
  const uid = getCurrentUser().uid;
  root.innerHTML = `<div class="loading-state" role="status">Loading progress…</div>`;

  const [completed, bodyweightRecords, profile] = await Promise.all([
    listCompletedWorkouts(uid, HISTORY_LIMIT),
    listBodyweightHistory(uid, BODYWEIGHT_LIMIT),
    // Phase 5B, Package 1: read-only, for Current 1RM display/suggestion
    // only (see this file's own import comment). getUserProfile already
    // falls back to `null` on a genuine offline cache-miss rather than
    // throwing (js/services/userService.js's own doc comment) — treated
    // the same way skipping bodyweight would be: the summary card row
    // simply omits "Current 1RM" for a lift with none loaded, never blocks
    // the rest of the page.
    getUserProfile(uid),
  ]);
  const currentMaxes = profile?.currentMaxes ?? {};

  // Phase 5B, Package 1: computed ONCE per mount (not once per exercise
  // switch) — same "compute once, look up per row/selection" pattern this
  // file's own series functions already establish. Fails open: if PR
  // analytics throws on some malformed legacy document, `eventsByExercise`
  // stays an empty Map and every other section on this page (Top Weight,
  // Estimated 1RM, Training Volume, Bodyweight) is completely unaffected.
  let eventsByExercise = new Map();
  try {
    ({ eventsByExercise } = computeAllPrEvents(completed));
  } catch (err) {
    console.error('progress.js: PR analytics computation failed (non-fatal — rest of Progress still renders)', err);
  }

  const exercises = listAvailableExercises(completed);
  // Deadlift first if it has data (the app's flagship lift); otherwise the
  // alphabetically-first eligible exercise. Never hardcoded as the ONLY
  // option — every exercise with meaningful weighted history is selectable.
  const defaultExercise = exercises.find((e) => e.exerciseId === 'deadlift') ?? exercises[0] ?? null;

  root.innerHTML = `
    <section class="progress-view">
      <h2>Progress</h2>

      ${exercises.length ? `
        <div class="form-row">
          <label class="field" style="flex:1">
            Exercise
            <select id="exercise-select">
              ${exercises.map((e) => `<option value="${escapeHtml(e.exerciseId)}"${e.exerciseId === defaultExercise?.exerciseId ? ' selected' : ''}>${escapeHtml(e.label)}</option>`).join('')}
            </select>
          </label>
        </div>` : ''}

      <h3>Strength</h3>
      <div id="exercise-metrics"></div>

      <h3>Bodyweight</h3>
      <div id="bodyweight-section"></div>

      ${aboutEstimated1RMHtml()}
    </section>`;

  const select = root.querySelector('#exercise-select');

  // Phase 5B, Package 2 — a single named re-render entry point so the
  // Update-Current-1RM action (on success) and the live online/offline
  // listener below (on a connectivity flip) can both refresh the exercise
  // section the exact same way exercise-switching already does, without
  // re-fetching anything: currentMaxes/completed/eventsByExercise are
  // already fully in memory.
  function rerenderSection() {
    renderExerciseSection(root, {
      exercises,
      selectedId: select?.value ?? defaultExercise?.exerciseId ?? null,
      completed,
      currentMaxes,
      eventsByExercise,
      uid,
      rerender: rerenderSection,
      bodyweightRecords,
    });
  }

  rerenderSection();
  renderBodyweight(root, bodyweightRecords);

  select?.addEventListener('change', rerenderSection);

  // Phase 5B, Package 2, spec section 11 — the Update-Current-1RM action is
  // blocked while offline (recordOneRepMax has never been given the
  // zero-wait/offline-safe treatment Phase 5A gave workout Start/Finish/
  // Skip — see js/services/userService.js; "prefer correctness over
  // pretending success"). A live listener keeps that button's
  // enabled/disabled state in sync with real connectivity without
  // requiring the person to switch exercises or reload. This is a genuinely
  // new use of js/core/router.js's existing (previously unused)
  // mount-returns-unmount-function convention — see the return below.
  const handleConnectivityChange = () => rerenderSection();
  window.addEventListener('online', handleConnectivityChange);
  window.addEventListener('offline', handleConnectivityChange);

  return () => {
    window.removeEventListener('online', handleConnectivityChange);
    window.removeEventListener('offline', handleConnectivityChange);
  };
}
