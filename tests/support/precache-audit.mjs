// Checks that sw.js precaches every same-origin module reachable from
// js/app.js and the route views (config/app.config.js), and nothing missing.
// Run: node tests/support/precache-audit.mjs   (exit code 1 on a problem)
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cfg = readFileSync(path.join(root, 'config/app.config.js'), 'utf8');
const routeViews = [...cfg.matchAll(/'\/[^']*':\s*'([^']+)'/g)].map((m) => `js/views/${m[1]}.js`);
const seen = new Set();
const missing = [];
function walk(rel) {
  if (seen.has(rel)) return;
  if (!existsSync(path.join(root, rel))) { missing.push(rel); return; }
  seen.add(rel);
  const src = readFileSync(path.join(root, rel), 'utf8');
  const specs = [...src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g), ...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const s of specs) if (s.startsWith('.')) walk(path.normalize(path.join(path.dirname(rel), s)));
}
walk('js/app.js');
routeViews.forEach(walk);
const sw = readFileSync(path.join(root, 'sw.js'), 'utf8');
const start = sw.indexOf('const SHELL_MODULES');
const listed = new Set([...sw.slice(start, sw.indexOf('];', start)).matchAll(/'([^']+\.js)'/g)].map((m) => m[1]));
const notListed = [...seen].filter((m) => !listed.has(m));
const notFound = [...listed].filter((m) => !existsSync(path.join(root, m)));
console.log(`reachable ${seen.size}, precached ${listed.size}`);
if (notListed.length) console.log('reachable but NOT precached:', notListed);
if (notFound.length) console.log('precached but file missing:', notFound);
if (missing.length) console.log('imported but file missing:', missing);
process.exit(notListed.length || notFound.length || missing.length ? 1 : 0);
