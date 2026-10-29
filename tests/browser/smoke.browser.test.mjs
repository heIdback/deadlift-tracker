// Core flows end to end in Chromium (fake Firestore): first sign-in installs
// the starter program; start → log → finish; History shows it; Program view.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openApp, baseSeed, programDocs, CANON, T, noOverflow } from './harness.mjs';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h?.close(); });

const seed210 = (current = { week: 2, dayOrder: 1 }, extra = {}) => baseSeed({
  extra: {
    ...programDocs('u1', 'dl210', CANON, { importSource: 'json' }),
    'users/u1/programRuns/run1': { programId: 'dl210', status: 'active', current, startDate: T(Date.now() - 20 * 86400e3), overrides: {} },
    ...extra,
  },
});

test('first sign-in of a new approved user installs the starter program and lands on Home', async () => {
  const app = await openApp(h, baseSeed(), { hash: '#/home' });
  await app.page.waitForSelector('#start-workout-btn', { timeout: 15000 });
  const programs = await app.paths('users/u1/programs/');
  assert.ok(programs.some((p) => p.startsWith('users/u1/programs/deadlift-focused-8wk')));
  assert.equal((await app.paths('users/u1/programRuns/')).length, 1);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('start → log every set of an exercise → finish: workout completed, run advanced, History lists it (320px)', async () => {
  const app = await openApp(h, seed210(), { hash: '#/workout', viewport: { width: 320, height: 640 } });
  await app.page.waitForSelector('#start-btn', { timeout: 15000 });
  await app.page.click('#start-btn');
  await app.page.waitForSelector('.set-check');
  const checks = app.page.locator('.set-check');
  const n = Math.min(await checks.count(), 3);
  for (let i = 0; i < n; i += 1) await checks.nth(i).click();
  assert.ok(await noOverflow(app));
  await app.page.click('#finish-btn');
  // a partly logged workout asks for confirmation first
  await app.page.click('#finish-anyway-btn');
  await app.page.waitForFunction(() => window.__fakeFirestoreTest.paths('users/u1/workouts/')
    .some((p) => window.__fakeFirestoreTest.get(p).status === 'completed'), null, { timeout: 15000 });
  const run = await app.get('users/u1/programRuns/run1');
  assert.deepEqual(run.current, { week: 2, dayOrder: 2 });
  await app.goto('#/history');
  await app.page.waitForSelector('.history-item', { timeout: 15000 });
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('Program view lists the program and its weeks', async () => {
  const app = await openApp(h, seed210(), { hash: '#/program' });
  await app.page.waitForSelector('.program-view .card-primary', { timeout: 15000 });
  assert.match(await app.page.textContent('.program-view'), /Deadlift 210/);
  assert.deepEqual(app.errors, []);
  await app.close();
});
