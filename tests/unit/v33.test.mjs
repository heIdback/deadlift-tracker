// v33 pure logic: finish summary, program completion / new cycle, History
// calendar, relative strength. Run: node --test tests/unit/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const S = await import('../../js/utils/workoutSummary.js');
const C = await import('../../js/utils/programCycle.js');
const H = await import('../../js/utils/historyCalendar.js');
const { relativeStrength } = await import('../../js/utils/maxHistoryAnalytics.js');
const { REQUIRED_STARTER_LIFTS } = await import('../../js/utils/requiredLifts.js');

const done = (kg, reps, o = {}) => ({ kind: 'working', plannedKg: kg, actualKg: kg, plannedReps: reps, actualReps: reps, completed: true, ...o });
const open = (kg, reps) => ({ kind: 'working', plannedKg: kg, actualKg: kg, plannedReps: reps, actualReps: reps, completed: false });
const day = (ms) => new Date(ms);
const workout = (id, finishedMs, exercises, o = {}) => ({ id, status: 'completed', programId: 'p', dayOrder: 1, week: 1, finishedAt: day(finishedMs), startedAt: day(finishedMs - 3600e3), exercises, ...o });
const dl = (sets) => ({ exerciseId: 'deadlift', section: 'main', displayNameAtStart: 'Deadlift', load: { type: 'percent' }, sets });
const row = (sets) => ({ exerciseId: 'row', section: 'accessory', displayNameAtStart: 'Row', load: { type: 'fixed' }, sets });

describe('summarizeWorkout', () => {
  const prev = workout('prev', 1_000_000_000, [dl([done(150, 3), done(150, 3)]), row([done(60, 10)])]);
  const now = new Date(2_000_000_000);
  const current = workout('cur', null, [
    { exerciseId: 'deadlift', section: 'warmup', load: { type: 'sets' }, sets: [{ ...done(60, 5), kind: 'warmup' }] },
    dl([done(155, 3), done(155, 3), done(160, 2, { status: 'failed' }), { ...open(155, 3), status: 'skipped' }]),
    row([done(60, 10), open(60, 10)]),
  ], { week: 2, startedAt: day(2_000_000_000 - 52 * 60e3), finishedAt: undefined });

  test('sets, duration, volume (warm-ups, failed and skipped sets excluded)', () => {
    const s = S.summarizeWorkout({ workout: current, previousWorkouts: [prev], now });
    assert.deepEqual(s.sets, { done: 6, total: 7, failed: 1, skipped: 1 });
    assert.equal(s.durationSec, 52 * 60);
    assert.equal(s.volumeKg, 155 * 3 * 2 + 600);
  });
  test('PRs from the same engine as History; the comparison uses the previous same program day', () => {
    const s = S.summarizeWorkout({ workout: current, previousWorkouts: [prev], now });
    assert.ok(s.prs.some((p) => p.exercise === 'Deadlift' && /155 kg × 3/.test(p.text)), JSON.stringify(s.prs));
    assert.deepEqual(s.comparison.mainSet, { name: 'Deadlift', before: { kg: 150, reps: 3 }, after: { kg: 155, reps: 3 }, deltaKg: 5 });
    assert.deepEqual(s.comparison.volume, { before: 1500, after: 1530, delta: 30 });
  });
  test('first time on this day / skipped previous / other day → no comparison; no history → no PR crash', () => {
    assert.equal(S.summarizeWorkout({ workout: current, previousWorkouts: [], now }).comparison, null);
    const skipped = { ...prev, completionState: 'skipped', explicitSkip: true };
    assert.equal(S.summarizeWorkout({ workout: current, previousWorkouts: [skipped], now }).comparison, null);
    assert.equal(S.summarizeWorkout({ workout: current, previousWorkouts: [{ ...prev, dayOrder: 2 }], now }).comparison, null);
    assert.ok(Array.isArray(S.summarizeWorkout({ workout: current, now }).prs));
  });
});

describe('program completion & new cycle', () => {
  const program = { weeks: [{ week: 1 }, { week: 2 }] };
  test('completed = position past the last week (finishing the last day sets week = total + 1)', () => {
    assert.equal(C.isRunCompleted({ programCompleted: true, current: { week: 3, dayOrder: 1 } }, program), true);
    assert.equal(C.isRunCompleted({ current: { week: 3, dayOrder: 1 } }, program), true);
    assert.equal(C.isRunCompleted({ current: { week: 2, dayOrder: 4 } }, program), false);
    assert.equal(C.isRunCompleted(null, program), false);
  });
  test('1RM at start: latest entry up to a day after the run start, else the earliest', () => {
    const start = day(10 * 86400e3);
    const h = [
      { exerciseId: 'deadlift', kg: 190, effectiveDate: day(5 * 86400e3) },
      { exerciseId: 'deadlift', kg: 195, effectiveDate: day(10 * 86400e3 + 3600e3) },
      { exerciseId: 'deadlift', kg: 205, effectiveDate: day(40 * 86400e3) },
      { exerciseId: 'bench-press', kg: 120, effectiveDate: day(20 * 86400e3) },
    ];
    assert.equal(C.oneRmAtStart(h, 'deadlift', start), 195);
    assert.equal(C.oneRmAtStart(h, 'bench-press', start), 120);
    assert.equal(C.oneRmAtStart(h, 'back-squat', start), null);
    const rows = C.cycleComparison({ history: h, run: { startDate: start }, currentMaxes: { deadlift: { kg: 205 } } });
    assert.deepEqual(rows.find((r) => r.id === 'deadlift'), { id: 'deadlift', label: 'Deadlift', start: 195, now: 205, delta: 10 });
  });
  test('new cycle: every lift needs a valid kg; only changed ones are recorded; starts at Week 1 / first day', () => {
    const days = [{ order: 2 }, { order: 1 }];
    const cur = { deadlift: { kg: 200 }, 'back-squat': { kg: 160 }, 'romanian-deadlift': { kg: 130 }, 'bench-press': { kg: 120 } };
    const p = C.planNewCycle({ days, newMaxes: { deadlift: '207,5', 'back-squat': 160, 'romanian-deadlift': '130', 'bench-press': 122.5 }, currentMaxes: cur });
    assert.equal(p.ok, true);
    assert.deepEqual(p.position, { week: 1, dayOrder: 1 });
    assert.deepEqual(p.maxesToRecord, [{ exerciseId: 'deadlift', kg: 207.5 }, { exerciseId: 'bench-press', kg: 122.5 }]);
    assert.equal(C.planNewCycle({ days, newMaxes: { ...cur, deadlift: '' }, currentMaxes: cur }).ok, false);
    assert.equal(C.planNewCycle({ days, newMaxes: { deadlift: 900, 'back-squat': 1, 'romanian-deadlift': 1, 'bench-press': 1 }, currentMaxes: cur }).ok, false);
    assert.equal(C.planNewCycle({ days: [], newMaxes: {}, currentMaxes: cur }).ok, false);
  });
});

describe('History calendar', () => {
  test('month grid starts on Monday; October 2026 starts on a Thursday and has 31 days', () => {
    const g = H.monthGrid(2026, 9);
    assert.equal(g[0].slice(0, 3).every((c) => c === null), true);
    assert.equal(g[0][3].day, 1);
    assert.equal(g.flat().filter(Boolean).length, 31);
    assert.ok(g.every((w) => w.length === 7));
  });
  test('workouts grouped by local day with a dot per state; unfinished ones left out', () => {
    const at = (d, h) => new Date(2026, 9, d, h);
    const m = H.workoutsByDay([
      { id: 'a', finishedAt: at(5, 18), completionState: 'complete' },
      { id: 'b', finishedAt: at(5, 20), completionState: 'partial' },
      { id: 'c', finishedAt: at(7, 9), completionState: 'skipped', explicitSkip: true },
      { id: 'd', finishedAt: null },
    ]);
    assert.deepEqual(m.get('2026-10-05').map((x) => [x.id, x.dot]), [['b', 'is-partial'], ['a', 'is-complete']]);
    assert.deepEqual(m.get('2026-10-07').map((x) => x.dot), ['is-skipped']);
    assert.equal(m.size, 2);
  });
  test('month navigation across years', () => {
    assert.deepEqual(H.shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
    assert.deepEqual(H.shiftMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
  });
});

describe('relative strength', () => {
  test('current 1RM ÷ latest bodyweight, rounded; missing numbers → null', () => {
    const rs = relativeStrength({
      currentMaxes: { deadlift: { kg: 205 }, 'bench-press': { kg: 120 } },
      bodyweightRecords: [{ value: 95, date: day(1) }, { value: 91.1, date: day(5) }, { value: 0, date: day(9) }],
      lifts: REQUIRED_STARTER_LIFTS,
    });
    assert.equal(rs.bodyweight.kg, 91.1);
    assert.equal(rs.rows.find((r) => r.id === 'deadlift').ratio, 2.25);
    assert.equal(rs.rows.find((r) => r.id === 'back-squat').ratio, null);
    assert.equal(relativeStrength({ currentMaxes: {}, bodyweightRecords: [], lifts: REQUIRED_STARTER_LIFTS }).bodyweight, null);
  });
});

test('a run marked completed continues when the program was extended with more weeks', () => {
  assert.equal(C.isRunCompleted({ programCompleted: true, current: { week: 3, dayOrder: 1 } }, { weeks: [1, 2, 3, 4].map((week) => ({ week })) }), false);
  assert.equal(C.isRunCompleted({ programCompleted: true, current: { week: 3, dayOrder: 1 } }, { weeks: [] }), true);
});
