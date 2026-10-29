// v33 — History month calendar. Pure (no Firebase, no DOM).
// A month grid (weeks start on Monday, local calendar days) with the
// finished workouts of each day: green = complete, yellow = partial or not
// logged, grey = skipped.
import { resolveCompletionState, EXPLICIT_SKIP_STATE } from './workoutCompletion.js';
import { toMillis } from './progressAnalytics.js';

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 'is-complete' | 'is-partial' | 'is-skipped' for a finished workout. */
export function dotClass(workout) {
  const s = resolveCompletionState(workout);
  if (s === 'complete') return 'is-complete';
  if (s === EXPLICIT_SKIP_STATE) return 'is-skipped';
  return 'is-partial';
}

/** Map dayKey → [{id, dayName, dot}] (newest first within a day). Workouts without a finish time yet are left out. */
export function workoutsByDay(workouts) {
  const map = new Map();
  [...(workouts ?? [])]
    .filter((w) => w && toMillis(w.finishedAt) > 0)
    .sort((a, b) => toMillis(b.finishedAt) - toMillis(a.finishedAt))
    .forEach((w) => {
      const k = dayKey(new Date(toMillis(w.finishedAt)));
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ id: w.id, dayName: w.dayName ?? '', week: w.week ?? null, dot: dotClass(w) });
    });
  return map;
}

/**
 * Weeks of one month: [[{date: Date|null, key, day}, … ×7], …]; leading and
 * trailing cells outside the month are null.
 */
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let d = 1; d <= days; d += 1) {
    const date = new Date(year, month, d);
    cells.push({ date, key: dayKey(date), day: d });
  }
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** [start, end) of a month as Dates (local midnight). */
export const monthRange = (year, month) => [new Date(year, month, 1), new Date(year, month + 1, 1)];

/** Month shifted by `delta` → {year, month}. */
export function shiftMonth({ year, month }, delta) {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}
