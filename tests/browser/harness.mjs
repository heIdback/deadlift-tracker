// Chromium harness: serves the app from the project folder, replaces the
// Firebase CDN modules with tests/fakes/*, blocks service workers and web
// fonts, and seeds the fake store/user per page (globalThis.__FAKE_SEED__).
//
// Needs Playwright. Resolution order: the `playwright` / `playwright-core`
// package (npm i -D playwright, then npx playwright install chromium), else
// PLAYWRIGHT_CORE (a path to a playwright-core folder).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FAKES = new URL('../fakes/', import.meta.url);
const fakeBodies = Object.fromEntries(await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js']
  .map(async (n) => [n, await readFile(new URL(n, FAKES), 'utf8')])));

export const PACKAGED = JSON.parse(await readFile(path.join(ROOT, 'data/program.deadlift-8wk.json'), 'utf8'));
export const CANON = JSON.parse(await readFile(new URL('../fixtures/program.deadlift-210-7wk.json', import.meta.url), 'utf8'));

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const name of [process.env.PLAYWRIGHT_CORE, 'playwright', 'playwright-core', '/opt/npm-tools/node_modules/playwright-core', '/opt/node-tools/node_modules/playwright-core'].filter(Boolean)) {
    try { return require(name); } catch { /* try next */ }
  }
  throw new Error('Playwright not found: npm i -D playwright && npx playwright install chromium (or set PLAYWRIGHT_CORE).');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

export async function startHarness() {
  const pw = await loadPlaywright();
  const { server, url } = await startServer();
  const browser = await pw.chromium.launch();
  return { url, browser, async close() { await browser.close(); server.close(); } };
}

/** A signed-in, approved user with all four starter 1RMs (skips onboarding). `extra` adds/overrides docs. */
export function baseSeed({ uid = 'u1', extra = {}, role = 'user' } = {}) {
  return {
    user: { uid, email: 'lifter@example.com', displayName: 'Test Lifter', photoURL: '' },
    store: {
      [`access/${uid}`]: { uid, status: 'approved', role, email: 'lifter@example.com', displayName: 'Test Lifter', photoURL: '', requestedAt: { __ts: 1000 } },
      [`users/${uid}`]: {
        uid, displayName: 'Test Lifter', email: 'lifter@example.com', photoURL: '', schemaVersion: 1,
        settings: { units: 'kg', rounding: { barbell: 2.5, dumbbell: 1, machine: 2.5, bodyweight: 0 } },
        trainingProfile: { bodyweight: null, height: null, trainingGoal: '' },
        currentMaxes: {
          deadlift: { kg: 200, kind: 'tested' }, 'back-squat': { kg: 160, kind: 'tested' },
          'romanian-deadlift': { kg: 130, kind: 'tested' }, 'bench-press': { kg: 120, kind: 'tested' },
        },
      },
      ...extra,
    },
  };
}

/** Store docs for a program (+ days) — `source` is a program JSON (PACKAGED or CANON). */
export function programDocs(uid, programId, source, over = {}) {
  const { id, days, ...rest } = source;
  const out = { [`users/${uid}/programs/${programId}`]: { ...rest, schemaVersion: 1, ...over } };
  for (const d of days) {
    const { id: dayId, ...data } = d;
    out[`users/${uid}/programs/${programId}/days/${dayId}`] = { ...data };
  }
  return out;
}

/**
 * Opens the app. Returns { page, errors, dump(), get(path), paths(prefix), goto(hash), close() }.
 * `errors` collects page errors and console.error lines (tests assert it stays empty).
 */
export async function openApp(h, seed, { viewport = { width: 390, height: 844 }, hash = '#/home' } = {}) {
  const context = await h.browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.addInitScript((s) => { window.__FAKE_SEED__ = s; }, seed);
  await context.route('https://www.gstatic.com/firebasejs/**', (route) => {
    const body = fakeBodies[route.request().url().split('/').pop()];
    return body ? route.fulfill({ status: 200, contentType: 'text/javascript', body }) : route.abort();
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Service worker registration failed|Failed to load resource/.test(m.text())) errors.push(`console.error: ${m.text()}`);
  });
  page.on('dialog', (d) => d.dismiss());
  await page.goto(`${h.url}${hash}`);
  return {
    page, context, errors,
    dump: () => page.evaluate(() => window.__fakeFirestoreTest.dump()),
    get: (p) => page.evaluate((x) => window.__fakeFirestoreTest.get(x), p),
    paths: (p) => page.evaluate((x) => window.__fakeFirestoreTest.paths(x), p),
    goto: (x) => page.evaluate((hh) => { location.hash = hh; }, x),
    close: () => context.close(),
  };
}

export const noOverflow = (app) => app.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
export const T = (ms) => ({ __ts: ms });
