// Skip ahead — pure planning (no Firebase, no DOM).
//
// By default the program runs in a fixed order. When several sessions have to
// be missed (illness, travel), the lifter may jump FORWARD to a later day: the
// sessions in between are written to History as explicit Skips, in one atomic
// batch (services/workoutService.js → skipAheadToPosition), so nobody has to
// press Skip once per missed day. Forward only: a single position pointer per
// program run is kept, so a day is never logged twice.
//
// A skipped session is permanent (the rules and the app treat an explicit
// Skip as a terminal record; completed workouts can't be deleted), which is
// why the UI shows exactly what will be skipped and warns that it can't be
// undone.

/** Hard ceiling on sessions skipped in one action (a batch stays far below Firestore's 500-write limit). */
export const MAX_SKIP_AHEAD = 14;
/** How far past the current week a jump may reach: the rest of this week and all of next week. */
export const SKIP_HORIZON_WEEKS = 1;
export const MAX_SKIP_REASON_LENGTH = 300;

export const normalizeSkipReason = (reason) => (typeof reason === 'string' ? reason.trim().slice(0, MAX_SKIP_REASON_LENGTH) : '');

/**
 * Ordered positions from the current one onward, as far as the horizon allows
 * (never past the program's last week):
 * [{week, dayOrder, dayName}] — element 0 is the current position itself.
 * Day order comes from the days' own `order` values (no assumption about how
 * many days a week has), the same way utils/programProgress.js walks them.
 */
export function upcomingPositions({ days, weeks, current, horizonWeeks = SKIP_HORIZON_WEEKS }) {
  const ordered = [...(days ?? [])].sort((a, b) => a.order - b.order);
  if (!ordered.length || !current) return [];
  const totalWeeks = Array.isArray(weeks) && weeks.length ? Math.max(...weeks.map((w) => w.week)) : current.week;
  if (current.week > totalWeeks) return []; // program already completed — no real day left
  const startIdx = Math.max(0, ordered.findIndex((d) => d.order === current.dayOrder));
  const lastWeek = Math.min(totalWeeks, current.week + horizonWeeks);
  const out = [];
  for (let week = current.week; week <= lastWeek; week += 1) {
    ordered.slice(week === current.week ? startIdx : 0).forEach((d) => out.push({ week, dayOrder: d.order, dayName: d.name ?? `Day ${d.order}` }));
  }
  return out;
}

/**
 * Days the lifter may jump to. Each target lists the sessions that would be
 * skipped (the current day first, then every one before the target).
 * [{week, dayOrder, dayName, skipped: [{week, dayOrder, dayName}, ...]}]
 */
export function listSkipTargets(args) {
  const positions = upcomingPositions(args);
  return positions.slice(1, MAX_SKIP_AHEAD + 1).map((p, i) => ({ ...p, skipped: positions.slice(0, i + 1) }));
}

/**
 * Validates a requested jump and returns what to write. Throws when the
 * target is not one of the offered, strictly-forward days.
 * → { target, skipped: [...], skipReason }
 */
export function planSkipAhead({ days, weeks, current, target, reason }) {
  const t = listSkipTargets({ days, weeks, current }).find((x) => x.week === target?.week && x.dayOrder === target?.dayOrder);
  if (!t) throw new Error('That day is not available to skip ahead to.');
  return {
    target: { week: t.week, dayOrder: t.dayOrder, dayName: t.dayName },
    skipped: t.skipped,
    skipReason: normalizeSkipReason(reason),
  };
}

/**
 * Sessions skipped together are stamped with the same server time, so a
 * newest-first list would show them in arbitrary order. Reorders each run of
 * consecutive entries with an identical timestamp so the later program
 * position comes first (Week 2 · Day 3 above Week 2 · Day 2). Entries that
 * differ in time are never moved. `millisOf` maps a workout to a number or null.
 */
export function orderTiesLatestPositionFirst(workouts, millisOf) {
  const out = [];
  for (let i = 0; i < workouts.length;) {
    let j = i + 1;
    const key = millisOf(workouts[i]);
    while (j < workouts.length && millisOf(workouts[j]) === key) j += 1;
    const group = workouts.slice(i, j);
    if (group.length > 1) group.sort((a, b) => (b.week ?? 0) - (a.week ?? 0) || (b.dayOrder ?? 0) - (a.dayOrder ?? 0));
    out.push(...group);
    i = j;
  }
  return out;
}
