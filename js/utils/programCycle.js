// v33 — end of a program: "Program completed" card + "Start a new cycle".
// Pure (no Firebase, no DOM). Writes: services/programSwitchService.js
// (startNewCycle); screen: views/programCompleteCard.js (Home + Workout).
//
// A run is finished when finishing its last day set `programCompleted`, or
// when its position is past the program's last week (older data). Instead of
// offering a workout in a week that doesn't exist, the app shows the card:
// each main lift's 1RM at the start of the run and now, and
//   - "Start a new cycle": the lifter confirms/enters new 1RMs; the finished
//     run is closed (status 'completed') and a NEW run of the same program
//     starts at Week 1 / first day. Changed 1RMs are recorded like any 1RM
//     update (history entry + current value). Workout history is untouched;
//   - "Choose another program": the Program tab.
import { REQUIRED_STARTER_LIFTS } from './requiredLifts.js';
import { toMillis } from './progressAnalytics.js';
import { pickStarterPosition } from './starterProgram.js';
import { totalWeeksOf } from './programEditModel.js';

export const CYCLE_LIFTS = REQUIRED_STARTER_LIFTS;
const DAY_MS = 86400e3;

export function isRunCompleted(run, program) {
  if (!run) return false;
  const total = totalWeeksOf(program);
  // Position past the last week = finished. When the program's weeks are known
  // this wins over the stored flag, so a program later extended (more weeks
  // imported) can continue where the run stopped.
  if (total > 0) return Number(run.current?.week) > total;
  return run.programCompleted === true;
}

/**
 * The 1RM in effect when the run started: the latest history entry up to a
 * day after the start (1RMs are often entered right after a run is created),
 * else the earliest entry there is. null when the lift has no history.
 */
export function oneRmAtStart(history, exerciseId, startDate) {
  const entries = (history ?? []).filter((h) => h.exerciseId === exerciseId && typeof h.kg === 'number')
    .sort((a, b) => toMillis(a.effectiveDate) - toMillis(b.effectiveDate));
  if (!entries.length) return null;
  const limitMs = toMillis(startDate) + DAY_MS;
  const before = entries.filter((h) => toMillis(h.effectiveDate) <= limitMs);
  return (before.at(-1) ?? entries[0]).kg;
}

/** Rows for the card: [{id, label, start, now, delta}]. */
export function cycleComparison({ history, run, currentMaxes }) {
  return CYCLE_LIFTS.map(({ id, label }) => {
    const start = oneRmAtStart(history, id, run?.startDate);
    const now = currentMaxes?.[id]?.kg ?? null;
    return { id, label, start, now, delta: start != null && now != null ? Math.round((now - start) * 100) / 100 : null };
  });
}

/**
 * Validates the new 1RMs and plans the new cycle.
 * newMaxes: {exerciseId: number|string}. Every lift needs a positive value ≤ 500.
 * → {ok:false, message} | {ok:true, position, maxesToRecord: [{exerciseId, kg}]}
 */
export function planNewCycle({ days, newMaxes, currentMaxes }) {
  const position = pickStarterPosition(days);
  if (!position) return { ok: false, message: 'This program has no days to start from.' };
  const maxesToRecord = [];
  for (const { id, label } of CYCLE_LIFTS) {
    const kg = Number(String(newMaxes?.[id] ?? '').replace(',', '.'));
    if (!Number.isFinite(kg) || kg <= 0 || kg > 500) return { ok: false, message: `Enter a 1RM for ${label} (kg).` };
    if (currentMaxes?.[id]?.kg !== kg) maxesToRecord.push({ exerciseId: id, kg });
  }
  return { ok: true, position, maxesToRecord };
}
