// v26 — "how far to my goal" helpers for the Home goal card. Pure, Firebase-free.
//
// A goal is just a number the lifter typed (kg) for one lift; it is stored on
// the user document as `goals.<exerciseId>` and is only ever used for display.
// It never changes a program, a load or a 1RM.

export const GOAL_MIN_KG = 20;
export const GOAL_MAX_KG = 500;

/** Accepts a number or numeric string (comma or dot decimal); returns a kg value rounded to 0.5, or null if it is not a usable goal. */
export function normalizeGoalKg(raw) {
  if (raw == null) return null;
  const text = String(raw).trim().replace(',', '.');
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < GOAL_MIN_KG || n > GOAL_MAX_KG) return null;
  return Math.round(n * 2) / 2;
}

/** kg → "205" / "207.5" (no trailing .0). */
export function formatKg(kg) {
  if (typeof kg !== 'number' || !Number.isFinite(kg)) return '—';
  return Number.isInteger(kg) ? String(kg) : String(Math.round(kg * 10) / 10);
}

/**
 * @returns {null | {goalKg:number, currentKg:number, remainingKg:number, percent:number, reached:boolean}}
 * `percent` is current / goal, whole number clamped to 0-100. null when there
 * is no valid goal or no current 1RM to compare against.
 */
export function computeGoalProgress({ goalKg, currentKg }) {
  if (typeof goalKg !== 'number' || !Number.isFinite(goalKg) || goalKg <= 0) return null;
  if (typeof currentKg !== 'number' || !Number.isFinite(currentKg) || currentKg <= 0) return null;
  const remainingKg = Math.max(0, Math.round((goalKg - currentKg) * 2) / 2);
  const percent = Math.max(0, Math.min(100, Math.round((currentKg / goalKg) * 100)));
  return { goalKg, currentKg, remainingKg, percent, reached: currentKg >= goalKg };
}

/**
 * The next PR-attempt week of the program at or after `currentWeek`
 * ({week, weeksAway}), or null when there is none (or none left). Reads the
 * program's own `weeks[].isPrAttempt` flag — the same flag Home already shows.
 */
export function nextPrAttempt(weeks, currentWeek) {
  if (!Array.isArray(weeks) || typeof currentWeek !== 'number') return null;
  const upcoming = weeks
    .filter((w) => w && w.isPrAttempt && typeof w.week === 'number' && w.week >= currentWeek)
    .sort((a, b) => a.week - b.week)[0];
  return upcoming ? { week: upcoming.week, weeksAway: upcoming.week - currentWeek } : null;
}
