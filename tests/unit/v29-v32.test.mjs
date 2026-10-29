// Pure logic of v29–v32 (rebuilt after the original test suite was lost):
// "Last time", skip ahead, program update, hide/delete, workout progress,
// display helpers. Run: node --test tests/unit/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const P = await import('../../js/utils/previousPerformance.js');
const K = await import('../../js/utils/skipAhead.js');
const U = await import('../../js/utils/programUpdate.js');
const M = await import('../../js/utils/programManage.js');
const W = await import('../../js/utils/workoutProgress.js');
const D = await import('../../js/utils/programDisplay.js');
const { buildResolvedExerciseList } = await import('../../js/utils/workoutSnapshot.js');
const CANON = JSON.parse(readFileSync(new URL('../fixtures/program.deadlift-210-7wk.json', import.meta.url), 'utf8'));

const set = (o = {}) => ({ kind: 'working', plannedKg: 100, actualKg: 100, plannedReps: 5, actualReps: 5, completed: false, ...o });

describe('previous performance ("Last:")', () => {
  test('newest finished, non-skipped workout where the exercise was logged; set by set', () => {
    const cur = [{ entryId: 'c', exerciseId: 'deadlift', section: 'main', sets: [set({ setId: 's1' }), set({ setId: 's2' })] }];
    const logged = (id, kg, o = {}) => ({ id, status: 'completed', completionState: 'complete', week: 1, dayName: 'D', finishedAt: new Date(), exercises: [{ exerciseId: 'deadlift', section: 'main', sets: [set({ completed: true, actualKg: kg, rpe: 8 }), set({ completed: true, actualKg: kg + 5, actualReps: 3, status: 'failed' })] }], ...o });
    const m = P.buildPreviousPerformance(cur, [logged('skip', 1, { completionState: 'skipped', explicitSkip: true }), logged('real', 160), logged('older', 150)]);
    assert.equal(m.get('c').workoutId, 'real');
    assert.deepEqual([...m.get('c').sets.values()], ['160 kg × 5 @ RPE 8', '165 kg × 3 (failed)']);
  });
});

describe('skip ahead', () => {
  const days = [1, 2, 3, 4].map((order) => ({ order, name: `Day ${order}` }));
  const weeks = [1, 2, 3].map((week) => ({ week }));
  test('forward only, up to the end of next week; skipped = current day onward', () => {
    const t = K.listSkipTargets({ days, weeks, current: { week: 1, dayOrder: 2 } });
    assert.deepEqual(t.map((x) => `${x.week}.${x.dayOrder}`), ['1.3', '1.4', '2.1', '2.2', '2.3', '2.4']);
    const p = K.planSkipAhead({ days, weeks, current: { week: 1, dayOrder: 2 }, target: { week: 2, dayOrder: 1 }, reason: '  flu ' });
    assert.deepEqual(p.skipped.map((x) => `${x.week}.${x.dayOrder}`), ['1.2', '1.3', '1.4']);
    assert.equal(p.skipReason, 'flu');
    assert.throws(() => K.planSkipAhead({ days, weeks, current: { week: 1, dayOrder: 2 }, target: { week: 1, dayOrder: 1 } }), /not available/);
  });
});

describe('program update from a file', () => {
  const day = (id, order, name) => ({ id, order, name, sections: { main: [{ exerciseId: 'deadlift', sets: '3x5' }] } });
  const target = { id: 'dl', name: 'Block', weeks: [1, 2, 3].map((week) => ({ week })), version: '1' };
  const oldDays = [day('d1', 1, 'A'), day('d2', 2, 'B')];
  const plan = (days, weeks = target.weeks, extra = {}) => ({ program: { weeks, ...extra }, days: days.map(({ id, ...data }) => ({ id, data })) });
  const base = (o) => ({ targetProgram: target, targetDays: oldDays, runs: [{ id: 'r', programId: 'dl', status: 'active', current: { week: 2, dayOrder: 2 } }], hasInProgressWorkout: false, existingProgramIds: ['dl'], now: new Date(2026, 9, 24), ...o });
  test('ok + exact copy of the old version; refusals', () => {
    const p = U.planProgramUpdate(base({ plan: plan([day('d1', 1, 'A'), { ...day('d2', 2, 'B'), name: 'B2' }]) }));
    assert.equal(p.ok, true);
    assert.equal(p.backup.program.name, 'Block (before update 2026-10-24)');
    assert.equal(U.planProgramUpdate(base({ hasInProgressWorkout: true, plan: plan(oldDays) })).reason, 'in_progress_workout');
    assert.equal(U.planProgramUpdate(base({ plan: plan([day('d1', 1, 'A')]) })).reason, 'position_missing');
    assert.equal(U.planProgramUpdate(base({ plan: plan(oldDays, target.weeks, { version: '1' }) })).reason, 'no_changes');
  });
});

describe('hide / delete programs', () => {
  test('active or in-progress program refused; delete plan never touches workouts', () => {
    assert.equal(M.checkProgramManageable({ program: { id: 'a' }, activeProgramId: 'a' }).reason, 'active');
    assert.equal(M.checkProgramManageable({ program: { id: 'b' }, activeProgramId: 'a', inProgressWorkout: { programId: 'b' } }).reason, 'in_progress_workout');
    const paths = M.planDeleteProgram({ uid: 'u', programId: 'b', days: [{ id: 'd' }], runs: [{ id: 'r', programId: 'b' }, { id: 'x', programId: 'a' }] });
    assert.deepEqual(paths, ['users/u/programs/b/days/d', 'users/u/programRuns/r', 'users/u/programs/b']);
  });
});

describe('workout progress & display helpers', () => {
  test('done/total, finished, awaiting reps, ±2.5', () => {
    const ex = { sets: [set({ completed: true }), set({ status: 'skipped' }), set({ completed: true, status: 'failed', actualReps: null })] };
    assert.deepEqual(W.exerciseProgress(ex), { done: 3, total: 3 });
    assert.equal(W.isExerciseFinished(ex), true);
    assert.equal(W.awaitsReps(ex), true);
    assert.equal(W.stepKg(null, 160, -2.5), 157.5);
    assert.equal(W.stepKg(1, null, -2.5), 0);
  });
  test('readable basis names and Home main set', () => {
    assert.equal(D.readableBasisName('romanian-deadlift'), 'Romanian Deadlift');
    assert.equal(D.readableBasisName('front-squat'), 'Front Squat');
    const day1 = CANON.days.find((d) => d.order === 1);
    const s = D.mainSetSummary(buildResolvedExerciseList(day1, 2, { currentMaxes: { deadlift: { kg: 200 } }, rounding: { barbell: 2.5 } }));
    assert.match(s, /^Deadlift 5×3 @ \d+(\.5)? kg$/);
  });
});

test('"Last:" — a warm-up ramp listed under main never takes the working sets\' place', () => {
  const ramp = { entryId: 'r', exerciseId: 'deadlift', section: 'main', load: { type: 'sets' }, sets: [set({ setId: 'w1', kind: 'warmup' })] };
  const work = { entryId: 'w', exerciseId: 'deadlift', section: 'main', load: { type: 'percent' }, sets: [set({ setId: 's1' })] };
  const prev = { id: 'p', status: 'completed', completionState: 'complete', finishedAt: new Date(), exercises: [{ exerciseId: 'deadlift', section: 'main', load: { type: 'percent' }, sets: [set({ completed: true, actualKg: 150 })] }] };
  const m = P.buildPreviousPerformance([ramp, work], [prev]);
  assert.equal(m.get('w').sets.get('s1'), '150 kg × 5');
  assert.equal(m.has('r'), false);
});
