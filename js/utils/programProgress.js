// ─────────────────────────────────────────────────────────────────────────
// Pure program-navigation logic (Phase 3C). No Firebase/DOM imports on
// purpose — this only ever reasons about the ORDERED DAYS and WEEKS actually
// present in a program's own data, never a hardcoded day-per-week count, so
// it works unchanged for a 3-day, 4-day, 5-day, or edited-by-a-future-
// Program-Editor structure.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Given the program's ordered days (the same days subcollection reused
 * across every week — see workoutSnapshot.js) and its weeks metadata,
 * computes the next {week, dayOrder} position after `currentWeek` /
 * `currentDayOrder`.
 *
 * Rules, deliberately with no assumption about how many days are in a week:
 *   - If there is a next day (by array position, not by assuming dayOrder
 *     values are contiguous integers) in the SAME week, advance to it.
 *   - Otherwise, that was the last day of the week: advance to the first
 *     day of the next week, UNLESS this was also the last week of the
 *     program (per the program's own `weeks` metadata) — in which case
 *     this does NOT wrap back to week 1 / day 1. It returns
 *     `programCompleted: true` and a `{week, dayOrder}` that deliberately
 *     does not correspond to any real day (week = totalWeeks + 1, the
 *     first day's order), so nothing downstream mistakes it for a real
 *     position while still giving callers a concrete, storable value.
 *
 * @param {{days: Array<{order:number}>, weeks: Array<{week:number}>, currentWeek:number, currentDayOrder:number}} args
 * @returns {{week:number, dayOrder:number, programCompleted:boolean}}
 */
export function computeNextPosition({ days, weeks, currentWeek, currentDayOrder }) {
  const orderedDays = [...(days ?? [])].sort((a, b) => a.order - b.order);
  if (orderedDays.length === 0) {
    throw new Error('Program has no days to advance through.');
  }

  const idx = orderedDays.findIndex((d) => d.order === currentDayOrder);
  // Defensive: if the current day can't be located (shouldn't happen in
  // practice), treat it as the start of the week rather than guessing how
  // far through it we are.
  const safeIdx = idx === -1 ? 0 : idx;

  const totalWeeks = Array.isArray(weeks) && weeks.length > 0
    ? Math.max(...weeks.map((w) => w.week))
    : currentWeek;

  if (safeIdx + 1 < orderedDays.length) {
    return { week: currentWeek, dayOrder: orderedDays[safeIdx + 1].order, programCompleted: false };
  }

  // Last day of the week.
  const nextWeek = currentWeek + 1;
  if (nextWeek > totalWeeks) {
    return { week: totalWeeks + 1, dayOrder: orderedDays[0].order, programCompleted: true };
  }
  return { week: nextWeek, dayOrder: orderedDays[0].order, programCompleted: false };
}
