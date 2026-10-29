// v33 end to end in Chromium (fake Firestore): finish summary, "Program
// completed" + new cycle, History calendar, Progress relative strength.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openApp, baseSeed, programDocs, CANON, T, noOverflow } from './harness.mjs';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h?.close(); });

const DAY = 86400e3;
const seed210 = ({ current = { week: 2, dayOrder: 1 }, run = {}, extra = {} } = {}) => baseSeed({
  extra: {
    ...programDocs('u1', 'dl210', CANON, { importSource: 'json' }),
    'users/u1/programRuns/run1': { programId: 'dl210', status: 'active', current, startDate: T(Date.now() - 50 * DAY), overrides: {}, ...run },
    ...extra,
  },
});

test('FINISH WORKOUT shows a summary (sets, time, volume, PRs, comparison with the same day last week); Done → Home (320px)', async () => {
  // last week's Day 1: deadlift 5 × 3 @ 140
  const prevSets = Array.from({ length: 5 }, (_, i) => ({ setId: `p${i}`, setNumber: i + 1, kind: 'working', plannedKg: 140, actualKg: 140, plannedReps: 3, actualReps: 3, completed: true }));
  const app = await openApp(h, seed210({ extra: {
    'users/u1/workouts/prev': { status: 'completed', completionState: 'complete', programId: 'dl210', programRunId: 'run1', week: 1, dayOrder: 1, dayName: 'Day 1', startedAt: T(Date.now() - 8 * DAY - 3600e3), finishedAt: T(Date.now() - 8 * DAY), exercises: [{ entryId: 'e', exerciseId: 'deadlift', section: 'main', displayNameAtStart: 'Deadlift', load: { type: 'percent' }, sets: prevSets }] },
  } }), { hash: '#/workout', viewport: { width: 320, height: 640 } });
  await app.page.waitForSelector('#start-btn', { timeout: 15000 });
  await app.page.click('#start-btn');
  const card = app.page.locator('.exercise-card.has-sets', { has: app.page.locator('.exercise-head .card-title', { hasText: /^Deadlift$/ }) }).first();
  await card.waitFor();
  for (let i = 0; i < 5; i += 1) await card.locator('.set-check').nth(i).click();
  await app.page.click('#finish-btn');
  await app.page.click('#finish-anyway-btn');
  await app.page.waitForSelector('#workout-summary', { timeout: 15000 });
  const text = (await app.page.textContent('#workout-summary')).replace(/\s+/g, ' ');
  assert.match(text, /Workout complete/);
  assert.match(text, /Sets ?\d+\/\d+/);
  assert.match(text, /Time ?\d+m/, 'duration known for a workout started this session');
  assert.doesNotMatch(text, /Warm-up/, 'lift names without the warm-up/top-single suffix');
  assert.match(text, /Volume ?[\d,]+ kg/);
  assert.match(text, /PRs/);
  assert.match(text, /Compared with last time Same day, Week 1/);
  assert.match(text, /Deadlift top set: 140 kg × 3 → \d+(\.5)? kg × 3/);
  if (process.env.SHOT) await app.page.locator('#workout-summary').screenshot({ path: process.env.SHOT });
  assert.ok(await noOverflow(app));
  await app.page.click('#summary-done');
  await app.page.waitForSelector('.dashboard', { timeout: 15000 });
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('a finished program: Home and Workout show "Program completed" (1RM start vs now), never a workout in a week that doesn\'t exist; "Start a new cycle" records changed 1RMs and restarts at Week 1', async () => {
  const s = seed210({ current: { week: 8, dayOrder: 1 }, run: { programCompleted: true, programCompletedAt: T(Date.now() - DAY) }, extra: {
    'users/u1/maxes/m1': { exerciseId: 'deadlift', kg: 190, kind: 'tested', effectiveDate: T(Date.now() - 50 * DAY + 3600e3) },
    'users/u1/maxes/m2': { exerciseId: 'deadlift', kg: 200, kind: 'tested', effectiveDate: T(Date.now() - 2 * DAY) },
  } });
  const app = await openApp(h, s, { hash: '#/home', viewport: { width: 320, height: 640 } });
  await app.page.waitForSelector('#program-complete', { timeout: 15000 });
  assert.equal(await app.page.$('#start-workout-btn'), null, 'no START for a week that does not exist');
  const t = (await app.page.textContent('#program-complete')).replace(/\s+/g, ' ');
  assert.match(t, /Program completed/);
  assert.match(t, /Deadlift\s*190 kg\s*200 kg\s*\(\+10 kg\)/);
  assert.match(await app.page.textContent('.dashboard .card-primary .card-sub'), /Completed/);
  assert.ok(await noOverflow(app));

  await app.goto('#/workout');
  await app.page.waitForSelector('#program-complete', { timeout: 15000 });
  assert.equal(await app.page.$('#start-btn'), null);

  await app.page.click('#new-cycle-btn');
  await app.page.fill('input[data-lift="deadlift"]', '205');
  await app.page.click('#new-cycle-confirm');
  await app.page.waitForSelector('#start-btn', { timeout: 15000 });
  const runs = await app.paths('users/u1/programRuns/');
  assert.equal(runs.length, 2);
  assert.equal((await app.get('users/u1/programRuns/run1')).status, 'completed');
  const fresh = await app.get(runs.find((p) => !p.endsWith('/run1')));
  assert.deepEqual([fresh.programId, fresh.status, fresh.current], ['dl210', 'active', { week: 1, dayOrder: 1 }]);
  assert.equal((await app.get('users/u1')).currentMaxes.deadlift.kg, 205);
  const maxes = await Promise.all((await app.paths('users/u1/maxes/')).map((p) => app.get(p)));
  assert.equal(maxes.filter((m) => m.source === 'new-cycle').length, 1, 'only the changed 1RM is recorded');
  assert.match(await app.page.textContent('.workout-view'), /Planned — Week 1/);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('History calendar: dots per day by state, a day with one workout opens it, month arrows (no future months)', async () => {
  const now = new Date();
  const at = (d, h) => T(new Date(now.getFullYear(), now.getMonth(), d, h).getTime());
  const day1 = Math.min(now.getDate(), 2);
  const extra = {
    'users/u1/workouts/a': { status: 'completed', completionState: 'complete', programId: 'dl210', week: 1, dayOrder: 1, dayName: 'Day A', startedAt: at(day1, 17), finishedAt: at(day1, 18), exercises: [] },
    'users/u1/workouts/b': { status: 'completed', completionState: 'skipped', explicitSkip: true, skipReason: '', programId: 'dl210', week: 1, dayOrder: 2, dayName: 'Day B', startedAt: at(day1, 19), finishedAt: at(day1, 19), exercises: [] },
    'users/u1/workouts/old': { status: 'completed', completionState: 'partial', programId: 'dl210', week: 1, dayOrder: 3, dayName: 'Old day', startedAt: T(new Date(now.getFullYear(), now.getMonth() - 1, 10, 9).getTime()), finishedAt: T(new Date(now.getFullYear(), now.getMonth() - 1, 10, 10).getTime()), exercises: [] },
  };
  const app = await openApp(h, seed210({ extra }), { hash: '#/history', viewport: { width: 320, height: 640 } });
  await app.page.waitForSelector('#history-calendar .cal-grid', { timeout: 15000 });
  assert.equal(await app.page.isDisabled('#cal-next'), true, 'no future months');
  const cell = app.page.locator(`.cal-cell[data-key$="-${String(day1).padStart(2, '0')}"]`);
  assert.deepEqual(await cell.locator('.cal-dot').evaluateAll((d) => d.map((x) => x.className.replace('cal-dot ', ''))), ['is-skipped', 'is-complete']);
  assert.ok(await noOverflow(app));
  await cell.click();
  assert.match(await app.page.textContent('#cal-day-list'), /Day B[\s\S]*Day A/);
  await app.page.click('#cal-prev');
  const oldCell = app.page.locator('.cal-cell[data-key$="-10"]');
  assert.deepEqual(await oldCell.locator('.cal-dot').evaluateAll((d) => d.map((x) => x.className.replace('cal-dot ', ''))), ['is-partial']);
  await oldCell.click();
  await app.page.waitForFunction(() => location.hash.includes('workoutId=old'));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('Progress: Deadlift relative to bodyweight (current 1RM ÷ latest bodyweight)', async () => {
  const app = await openApp(h, seed210({ extra: {
    'users/u1/measurements/b1': { type: 'bodyweight', value: 95, unit: 'kg', date: T(Date.now() - 20 * DAY) },
    'users/u1/measurements/b2': { type: 'bodyweight', value: 91.1, unit: 'kg', date: T(Date.now() - DAY) },
  } }), { hash: '#/progress', viewport: { width: 320, height: 640 } });
  await app.page.waitForSelector('#relative-strength', { timeout: 15000 });
  assert.equal(await app.page.textContent('#rs-deadlift'), '2.20× BW');
  assert.match(await app.page.textContent('#relative-strength'), /200 kg ÷ 91.1 kg bodyweight/);
  assert.ok(await noOverflow(app));
  assert.deepEqual(app.errors, []);
  await app.close();
});
