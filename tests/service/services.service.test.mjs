// Real client services against the in-memory Firestore fake (NOT the real SDK,
// NOT firestore.rules). Run: node --import ./tests/support/register.mjs --test tests/service/*.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.__FAKE_SEED__ = { user: { uid: 'u1', email: 'lifter@example.com' } };
const ROOT = new URL('../../', import.meta.url);
const { __test: db, Timestamp } = await import('../fakes/firebase-firestore.js');
const ws = await import(new URL('js/services/workoutService.js', ROOT));
const ps = await import(new URL('js/services/programService.js', ROOT));
const us = await import(new URL('js/services/userService.js', ROOT));
const sw = await import(new URL('js/services/programSwitchService.js', ROOT));
const pm = await import(new URL('js/services/programManageService.js', ROOT));
const pu = await import(new URL('js/services/programUpdateService.js', ROOT));
const tg = await import(new URL('js/services/trainingGenerationService.js', ROOT));
const tr = await import(new URL('js/services/trainingResetService.js', ROOT));
const { prepareProgramImport } = await import(new URL('js/utils/programImport.js', ROOT));

const CANON = JSON.parse(readFileSync(new URL('tests/fixtures/program.deadlift-210-7wk.json', ROOT), 'utf8'));
const DAY = 86400e3;
const ts = (ms) => Timestamp.fromMillis(ms);
const flush = () => new Promise((r) => setTimeout(r, 0));
const MAXES = { deadlift: { kg: 200 }, 'back-squat': { kg: 160 }, 'romanian-deadlift': { kg: 130 }, 'bench-press': { kg: 120 } };

function seed({ current = { week: 2, dayOrder: 1 }, run = {}, extra = {} } = {}) {
  const { id, days, ...rest } = CANON;
  const s = {
    'access/u1': { uid: 'u1', status: 'approved', role: 'user', email: 'lifter@example.com' },
    'users/u1': { uid: 'u1', email: 'lifter@example.com', currentMaxes: MAXES, settings: { rounding: { barbell: 2.5 } } },
    'users/u1/programs/dl210': { ...rest },
    'users/u1/programRuns/run1': { programId: 'dl210', status: 'active', current, startDate: ts(Date.now() - 30 * DAY), overrides: {}, ...run },
    ...extra,
  };
  for (const { id: dayId, ...d } of days) s[`users/u1/programs/dl210/days/${dayId}`] = d;
  db.reset(s);
  globalThis.localStorage.clear();
  globalThis.__setOnline(true);
  tg.__resetTrainingGenerationForTests();
  tr.clearResetBoundaries();
}
beforeEach(() => seed());
async function ctx() {
  const run = await ps.getActiveProgramRun('u1');
  const program = await ps.getProgram('u1', run.programId);
  return { run, program, days: await ps.getProgramDays('u1', program.id), profile: await us.getUserProfile('u1') };
}

test('start → finish advances the run; the finished workout is listed; month range query', async () => {
  const c = await ctx();
  const w = await ws.startOrResumeWorkoutForCurrentPosition('u1', c);
  await flush();
  await ws.finishWorkout('u1', { ...(await ws.getWorkout('u1', w.id)), id: w.id });
  await flush();
  assert.deepEqual(db.get('users/u1/programRuns/run1').current, { week: 2, dayOrder: 2 });
  const listed = await ws.listCompletedWorkouts('u1', 10);
  assert.equal(listed.length, 1);
  const now = new Date();
  const inMonth = await ws.listCompletedWorkoutsBetween('u1', new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 1));
  assert.equal(inMonth.length, 1);
  const lastMonth = await ws.listCompletedWorkoutsBetween('u1', new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 1));
  assert.equal(lastMonth.length, 0);
});

test('new cycle after a finished program: old run completed, new run at Week 1, only changed 1RMs recorded — one batch', async () => {
  seed({ current: { week: 8, dayOrder: 1 }, run: { programCompleted: true } });
  const { run, program } = await ctx();
  const r = await sw.startNewCycle('u1', { run, program, newMaxes: { ...Object.fromEntries(Object.entries(MAXES).map(([k, v]) => [k, v.kg])), deadlift: 207.5 }, currentMaxes: MAXES });
  assert.equal(r.ok, true);
  assert.equal(db.get('users/u1/programRuns/run1').status, 'completed');
  const fresh = db.get(`users/u1/programRuns/${r.runId}`);
  assert.deepEqual([fresh.status, fresh.current], ['active', { week: 1, dayOrder: 1 }]);
  assert.equal(db.get('users/u1').currentMaxes.deadlift.kg, 207.5);
  assert.equal(db.paths('users/u1/maxes/').length, 1);
  assert.equal((await ps.getActiveProgramRun('u1')).id, r.runId);
});

test('new cycle refused (nothing written) with a missing 1RM or a workout in progress', async () => {
  seed({ current: { week: 8, dayOrder: 1 }, run: { programCompleted: true }, extra: { 'users/u1/workouts/wip': { status: 'in_progress', programId: 'dl210', startedAt: ts(Date.now()), exercises: [] } } });
  const before = JSON.stringify(db.dump());
  const { run, program } = await ctx();
  assert.equal((await sw.startNewCycle('u1', { run, program, newMaxes: { deadlift: 200 }, currentMaxes: MAXES })).reason, 'in_progress_workout');
  db.state.store.delete('users/u1/workouts/wip');
  const after1 = JSON.stringify(db.dump());
  assert.equal((await sw.startNewCycle('u1', { run, program, newMaxes: { deadlift: 200 }, currentMaxes: MAXES })).reason, 'invalid');
  assert.equal(JSON.stringify(db.dump()), after1);
  assert.notEqual(before, after1);
});

test('skip ahead: one batch of explicit skips + new position', async () => {
  const c = await ctx();
  const r = await ws.skipAheadToPosition('u1', { ...c, target: { week: 2, dayOrder: 3 }, reason: 'Travel' });
  await flush();
  assert.equal(r.skippedCount, 2);
  const skipped = db.paths('users/u1/workouts/').map((p) => db.get(p));
  assert.ok(skipped.every((w) => w.explicitSkip === true && w.skipReason === 'Travel'));
  assert.deepEqual(db.get('users/u1/programRuns/run1').current, { week: 2, dayOrder: 3 });
});

test('hide / unhide / delete an inactive program; the active one is refused', async () => {
  const { id, days, ...rest } = CANON;
  db.set('users/u1/programs/old', { ...rest, name: 'Old' });
  for (const { id: dayId, ...d } of days) db.set(`users/u1/programs/old/days/${dayId}`, d);
  assert.equal((await pm.setProgramHidden('u1', 'dl210', true)).reason, 'active');
  assert.equal((await pm.setProgramHidden('u1', 'old', true)).ok, true);
  assert.equal(db.get('users/u1/programs/old').hidden, true);
  assert.equal((await pm.deleteProgram('u1', 'old')).ok, true);
  assert.deepEqual(db.paths('users/u1/programs/old'), []);
});

test('program update from a file keeps the run position and saves a copy of the old version', async () => {
  const obj = JSON.parse(JSON.stringify(CANON));
  obj.days[1].name = `${obj.days[1].name} v2`;
  const v = prepareProgramImport({ fileName: 'p.json', text: JSON.stringify(obj), existingProgramIds: ['dl210'] });
  assert.ok(v.plan, JSON.stringify(v.errors));
  const r = await pu.updateProgramFromImport('u1', 'dl210', v.plan);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(db.get('users/u1/programRuns/run1').current, { week: 2, dayOrder: 1 });
  assert.ok(db.get(`users/u1/programs/${r.backupProgramId}`));
});

test('a new cycle stays at Week 1 Day 1 although the previous cycle already did W1D1 (no automatic skipping)', async () => {
  seed({ current: { week: 8, dayOrder: 1 }, run: { programCompleted: true }, extra: {
    'users/u1/workouts/old11': { status: 'completed', completionState: 'complete', programId: 'dl210', programRunId: 'run1', week: 1, dayOrder: 1, finishedAt: ts(Date.now() - 40 * DAY), exercises: [] },
    'users/u1/workouts/legacy11': { status: 'completed', completionState: 'complete', programId: 'dl210', week: 1, dayOrder: 1, finishedAt: ts(Date.now() - 41 * DAY), exercises: [] },
  } });
  const { run, program } = await ctx();
  const r = await sw.startNewCycle('u1', { run, program, newMaxes: Object.fromEntries(Object.entries(MAXES).map(([k, v]) => [k, v.kg])), currentMaxes: MAXES });
  await flush();
  for (let i = 0; i < 3; i += 1) {
    const fresh = await ps.getActiveProgramRun('u1');
    const after = await ws.reconcileLegacyProgramPosition('u1', fresh);
    await flush();
    assert.deepEqual(after.current, { week: 1, dayOrder: 1 }, `visit ${i + 1}`);
  }
  assert.deepEqual(db.get(`users/u1/programRuns/${r.runId}`).current, { week: 1, dayOrder: 1 });
});

test('reconcile still fixes a stuck position of the SAME run', async () => {
  seed({ current: { week: 2, dayOrder: 1 }, extra: {
    'users/u1/workouts/done21': { status: 'completed', completionState: 'complete', programId: 'dl210', programRunId: 'run1', week: 2, dayOrder: 1, finishedAt: ts(Date.now() - DAY), exercises: [] },
  } });
  const after = await ws.reconcileLegacyProgramPosition('u1', await ps.getActiveProgramRun('u1'));
  assert.deepEqual(after.current, { week: 2, dayOrder: 2 });
});
