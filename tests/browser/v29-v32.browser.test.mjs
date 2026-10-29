// v29–v32 features end to end in Chromium (rebuilt after the original suite
// was lost): "Last:" values, skip ahead, program update from a file,
// hide/delete programs, workout progress/collapse/±2.5/wake lock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, openApp, baseSeed, programDocs, CANON, T, noOverflow } from './harness.mjs';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h?.close(); });

const DAY = 86400e3;
const seed = ({ current = { week: 2, dayOrder: 1 }, extra = {} } = {}) => baseSeed({
  extra: {
    ...programDocs('u1', 'dl210', CANON, { importSource: 'json', name: 'Deadlift 210' }),
    'users/u1/programRuns/run1': { programId: 'dl210', status: 'active', current, startDate: T(Date.now() - 20 * DAY), overrides: {} },
    ...extra,
  },
});
const mainCard = (app, name = 'Deadlift') => app.page.locator('.exercise-card.has-sets', { has: app.page.locator('.exercise-head .card-title', { hasText: new RegExp(`^${name}$`) }) }).first();

test('logger: "Last:" values, done/total + collapse, −/+2.5 saves, screen kept on and released', async () => {
  const prevSets = [0, 1, 2, 3, 4].map((i) => ({ setId: `p${i}`, setNumber: i + 1, kind: 'working', plannedKg: 140, actualKg: 145, plannedReps: 3, actualReps: 3, completed: true, rpe: 7 }));
  const app = await openApp(h, seed({ extra: {
    'users/u1/workouts/prev': { status: 'completed', completionState: 'complete', programId: 'dl210', week: 1, dayOrder: 1, dayName: 'Day 1', startedAt: T(Date.now() - 7 * DAY), finishedAt: T(Date.now() - 7 * DAY + 3600e3), exercises: [{ entryId: 'x', exerciseId: 'deadlift', section: 'main', displayNameAtStart: 'Deadlift', load: { type: 'percent' }, sets: prevSets }] },
  } }), { hash: '#/workout', viewport: { width: 320, height: 640 } });
  await app.page.waitForSelector('#start-btn', { timeout: 15000 });
  await app.page.evaluate(() => {
    window.__wake = { active: 0 };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wake.active += 1; const s = { released: false, release: async () => { if (!s.released) { s.released = true; window.__wake.active -= 1; } } }; return s; } } });
  });
  await app.page.click('#start-btn');
  await app.page.waitForFunction(() => window.__wake.active === 1);
  const card = mainCard(app);
  await card.locator('.set-prev').first().waitFor({ timeout: 15000 });
  assert.equal(await card.locator('.set-prev-value').first().textContent(), '145 kg × 3 @ RPE 7');
  assert.equal(await card.locator('.exercise-count').textContent(), '0/5');
  const first = card.locator('.set-block').first();
  const kg0 = Number(await first.locator('input.set-kg').inputValue());
  await first.locator('.btn-step[data-step="2.5"]').click();
  assert.equal(Number(await first.locator('input.set-kg').inputValue()), kg0 + 2.5);
  for (let i = 0; i < 5; i += 1) await card.locator('.set-check').nth(i).click();
  assert.match(await card.getAttribute('class'), /is-collapsed/);
  await card.locator('.exercise-head').click();
  assert.equal(await card.locator('.exercise-body').isVisible(), true);
  assert.ok(await noOverflow(app));
  await app.goto('#/home');
  await app.page.waitForFunction(() => window.__wake.active === 0);
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('skip ahead: skips the days in between as Skipped with the reason; the preview moves', async () => {
  const app = await openApp(h, seed(), { hash: '#/workout' });
  await app.page.waitForSelector('#skip-ahead-open', { timeout: 15000 });
  await app.page.click('#skip-ahead-open');
  await app.page.selectOption('#skip-ahead-target', { index: 1 });
  await app.page.fill('#skip-ahead-reason', 'Flu');
  await app.page.click('#skip-ahead-confirm');
  await app.page.waitForSelector('#skip-ahead-result', { timeout: 15000 });
  const ws = await Promise.all((await app.paths('users/u1/workouts/')).map((p) => app.get(p)));
  assert.equal(ws.length, 2);
  assert.ok(ws.every((w) => w.explicitSkip && w.skipReason === 'Flu'));
  assert.deepEqual((await app.get('users/u1/programRuns/run1')).current, { week: 2, dayOrder: 3 });
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('import → "Update a program you already have": preview, update keeps the run, saves a copy', async () => {
  const app = await openApp(h, seed(), { hash: '#/program?import=1' });
  await app.page.waitForSelector('#import-file-input', { state: 'attached', timeout: 15000 });
  const file = JSON.parse(JSON.stringify(CANON));
  file.days[1].name = `${file.days[1].name} (new)`;
  await app.page.setInputFiles('#import-file-input', { name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await app.page.waitForSelector('#import-mode-card');
  await app.page.check('input[name="import-mode"][value="update"]');
  await app.page.selectOption('#import-update-target', 'dl210');
  await app.page.waitForSelector('#import-update-preview [data-update-state="ok"]', { timeout: 15000 });
  assert.match(await app.page.textContent('#import-update-preview'), /Your place stays at Week 2 · Day 1/);
  await app.page.click('#import-confirm-btn');
  await app.page.waitForSelector('#import-update-success', { timeout: 15000 });
  assert.deepEqual((await app.get('users/u1/programRuns/run1')).current, { week: 2, dayOrder: 1 });
  const programs = await app.paths('users/u1/programs/');
  assert.ok(programs.some((p) => /before-update/.test(p)));
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('hide and delete an inactive program from the Program screen', async () => {
  const app = await openApp(h, seed({ extra: programDocs('u1', 'old', CANON, { name: 'Old block' }) }), { hash: '#/program?id=old' });
  await app.page.waitForSelector('[data-action="hide"]', { timeout: 15000 });
  await app.page.click('[data-action="hide"]');
  await app.page.waitForSelector('.badge-hidden');
  assert.equal((await app.get('users/u1/programs/old')).hidden, true);
  await app.page.click('[data-action="delete"]');
  await app.page.click('#delete-confirm-btn');
  await app.page.waitForFunction(() => location.hash === '#/program');
  assert.deepEqual(await app.paths('users/u1/programs/old'), []);
  assert.deepEqual(app.errors, []);
  await app.close();
});
