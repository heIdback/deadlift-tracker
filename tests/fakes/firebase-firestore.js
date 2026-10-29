// TEST DOUBLE of the Firebase Web SDK's Firestore module (the subset this app
// imports). In-memory, one shared "server" store; plain ESM with no Node APIs,
// so the same file runs in Node (via tests/support/register.mjs) and in
// Chromium (served by tests/browser/harness.mjs in place of gstatic.com).
//
// It is NOT the real SDK and does NOT enforce firestore.rules. What it models:
// document/collection paths, get/set/update/delete, dotted-path updates,
// serverTimestamp/deleteField, batches and transactions (all-or-nothing,
// update of a missing doc fails with not-found), queries (where/orderBy/limit,
// docs without the orderBy field are left out like in Firestore), counts and
// onSnapshot. "Offline" (__test.setOnline(false)) makes *FromServer reads and
// transactions fail with code 'unavailable'; everything else keeps working
// against the same store (a stand-in for the persistent cache).

// ── Timestamp ──────────────────────────────────────────────────────────────
export class Timestamp {
  constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)); }
  static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
  static now() { return Timestamp.fromMillis(state.now()); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  isEqual(o) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
  valueOf() { return String(this.toMillis()).padStart(16, '0'); }
}

const SERVER_TS = Object.freeze({ __serverTimestamp: true });
const DELETE_FIELD = Object.freeze({ __deleteField: true });
export const serverTimestamp = () => SERVER_TS;
export const deleteField = () => DELETE_FIELD;

const state = {
  store: new Map(),
  listeners: new Set(),
  online: true,
  autoId: 0,
  writeLog: [],
  failNext: null,
  now: () => Date.now(),
};

function clone(v) {
  if (v === SERVER_TS || v === DELETE_FIELD) return v;
  if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
    return out;
  }
  return v;
}
function resolve(v, ts) {
  if (v === SERVER_TS) return ts;
  if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
  if (v instanceof Date) return Timestamp.fromDate(v);
  if (Array.isArray(v)) return v.map((x) => resolve(x, ts));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) throw Object.assign(new Error(`Unsupported field value: undefined (found in field ${k})`), { code: 'invalid-argument' });
      if (x === DELETE_FIELD) continue;
      out[k] = resolve(x, ts);
    }
    return out;
  }
  return v;
}
function setNested(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  if (value === DELETE_FIELD) delete cur[keys.at(-1)];
  else cur[keys.at(-1)] = value;
}
function getField(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ── refs ───────────────────────────────────────────────────────────────────
const DB = { __fakeDb: true, type: 'firestore' };
function autoId() {
  state.autoId += 1;
  return `auto${String(state.autoId).padStart(6, '0')}${Math.random().toString(36).slice(2, 8)}`;
}
function makeDocRef(path) {
  const segs = path.split('/');
  return { type: 'document', path, id: segs.at(-1), get parent() { return makeColRef(segs.slice(0, -1).join('/')); }, firestore: DB };
}
function makeColRef(path) {
  return { type: 'collection', path, id: path.split('/').at(-1), firestore: DB, constraints: [] };
}
function join(base, segs) {
  const parts = [base, ...segs].filter((s) => s !== undefined && s !== null && s !== '').join('/').split('/');
  if (parts.some((p) => p === '')) throw new Error(`Invalid path "${parts.join('/')}"`);
  return parts.join('/');
}
export function collection(parent, ...segs) {
  const base = parent?.type === 'document' ? parent.path : '';
  const path = join(base, segs);
  if (path.split('/').length % 2 !== 1) throw new Error(`Invalid collection reference "${path}"`);
  return makeColRef(path);
}
export function doc(parent, ...segs) {
  if (parent?.type === 'collection' && segs.length === 0) return makeDocRef(`${parent.path}/${autoId()}`);
  const base = parent?.type === 'collection' || parent?.type === 'document' ? parent.path : '';
  const path = join(base, segs);
  if (path.split('/').length % 2 !== 0) throw new Error(`Invalid document reference "${path}"`);
  return makeDocRef(path);
}
export const where = (field, op, value) => ({ kind: 'where', field, op, value });
export const orderBy = (field, dir = 'asc') => ({ kind: 'orderBy', field, dir });
export const limit = (n) => ({ kind: 'limit', n });
export const query = (col, ...constraints) => ({ type: 'query', path: col.path, constraints: [...(col.constraints ?? []), ...constraints] });

// ── snapshots ──────────────────────────────────────────────────────────────
function docSnap(path) {
  const data = state.store.get(path);
  const ref = makeDocRef(path);
  return {
    id: ref.id, ref, metadata: { hasPendingWrites: false, fromCache: !state.online },
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : clone(data)),
    get: (f) => (data === undefined ? undefined : clone(getField(data, f))),
  };
}
const cmpVal = (a, b) => {
  const n = (v) => (v instanceof Timestamp ? v.toMillis() : v instanceof Date ? v.getTime() : v);
  const x = n(a); const y = n(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
};
function matches(data, c) {
  const v = getField(data, c.field);
  switch (c.op) {
    case '==': return v !== undefined && cmpVal(v, c.value) === 0;
    case '!=': return v !== undefined && cmpVal(v, c.value) !== 0;
    case '<': return v !== undefined && v !== null && cmpVal(v, c.value) < 0;
    case '<=': return v !== undefined && v !== null && cmpVal(v, c.value) <= 0;
    case '>': return v !== undefined && v !== null && cmpVal(v, c.value) > 0;
    case '>=': return v !== undefined && v !== null && cmpVal(v, c.value) >= 0;
    case 'in': return c.value.some((x) => cmpVal(v, x) === 0);
    case 'array-contains': return Array.isArray(v) && v.some((x) => cmpVal(x, c.value) === 0);
    default: throw new Error(`fake: unsupported operator ${c.op}`);
  }
}
function runQuery(q) {
  const prefix = `${q.path}/`;
  let rows = [...state.store.keys()]
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    .sort()
    .map((p) => ({ p, data: state.store.get(p) }));
  for (const c of q.constraints ?? []) if (c.kind === 'where') rows = rows.filter((r) => matches(r.data, c));
  const orders = (q.constraints ?? []).filter((c) => c.kind === 'orderBy');
  for (const o of orders) rows = rows.filter((r) => getField(r.data, o.field) !== undefined);
  if (orders.length) {
    rows.sort((a, b) => {
      for (const o of orders) {
        const d = cmpVal(getField(a.data, o.field), getField(b.data, o.field));
        if (d) return o.dir === 'desc' ? -d : d;
      }
      return a.p < b.p ? -1 : a.p > b.p ? 1 : 0;
    });
  }
  const lim = (q.constraints ?? []).find((c) => c.kind === 'limit');
  if (lim) rows = rows.slice(0, lim.n);
  const docs = rows.map((r) => docSnap(r.p));
  return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn), metadata: { fromCache: !state.online } };
}
const asQuery = (x) => (x.type === 'query' ? x : { type: 'query', path: x.path, constraints: x.constraints ?? [] });

function unavailable() { return Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' }); }
function maybeFail() {
  if (state.failNext) { const e = state.failNext; state.failNext = null; throw e; }
}

// ── reads ──────────────────────────────────────────────────────────────────
export async function getDoc(ref) { return docSnap(ref.path); }
export async function getDocFromCache(ref) {
  if (!state.store.has(ref.path)) throw Object.assign(new Error('Failed to get document from cache.'), { code: 'unavailable' });
  return docSnap(ref.path);
}
export async function getDocFromServer(ref) { if (!state.online) throw unavailable(); return docSnap(ref.path); }
export async function getDocs(q) { return runQuery(asQuery(q)); }
export async function getDocsFromCache(q) { return runQuery(asQuery(q)); }
export async function getDocsFromServer(q) { if (!state.online) throw unavailable(); return runQuery(asQuery(q)); }
export async function getCountFromServer(q) {
  if (!state.online) throw unavailable();
  const n = runQuery(asQuery(q)).size;
  return { data: () => ({ count: n }) };
}
export async function waitForPendingWrites() {}

// ── writes ─────────────────────────────────────────────────────────────────
function apply(ops) {
  maybeFail();
  const ts = Timestamp.now();
  const staged = new Map();
  const read = (p) => (staged.has(p) ? staged.get(p) : state.store.get(p));
  for (const op of ops) {
    const before = read(op.path);
    let after;
    if (op.type === 'delete') after = undefined;
    else if (op.type === 'set') after = op.merge && before ? { ...clone(before), ...resolve(op.data, ts) } : resolve(op.data, ts);
    else {
      if (before === undefined) throw Object.assign(new Error(`No document to update: ${op.path}`), { code: 'not-found' });
      after = clone(before);
      for (const [k, v] of Object.entries(op.data)) setNested(after, k, v === DELETE_FIELD ? v : resolve(v, ts));
    }
    staged.set(op.path, after);
  }
  for (const [p, after] of staged) {
    if (after === undefined) state.store.delete(p); else state.store.set(p, after);
    state.writeLog.push({ path: p, kind: after === undefined ? 'delete' : 'write' });
  }
  notify();
}
export async function setDoc(ref, data, opts = {}) { apply([{ type: 'set', path: ref.path, data, merge: !!opts.merge }]); }
export async function updateDoc(ref, data) { apply([{ type: 'update', path: ref.path, data }]); }
export async function deleteDoc(ref) { apply([{ type: 'delete', path: ref.path }]); }
export async function addDoc(col, data) { const ref = doc(col); apply([{ type: 'set', path: ref.path, data }]); return ref; }

export function writeBatch() {
  const ops = [];
  return {
    set(ref, data, opts = {}) { ops.push({ type: 'set', path: ref.path, data, merge: !!opts.merge }); return this; },
    update(ref, data) { ops.push({ type: 'update', path: ref.path, data }); return this; },
    delete(ref) { ops.push({ type: 'delete', path: ref.path }); return this; },
    async commit() { apply(ops); },
  };
}

export async function runTransaction(_db, fn) {
  if (!state.online) throw unavailable();
  const ops = [];
  const tx = {
    async get(ref) {
      if (ops.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
      return docSnap(ref.path);
    },
    set(ref, data, opts = {}) { ops.push({ type: 'set', path: ref.path, data, merge: !!opts.merge }); return tx; },
    update(ref, data) { ops.push({ type: 'update', path: ref.path, data }); return tx; },
    delete(ref) { ops.push({ type: 'delete', path: ref.path }); return tx; },
  };
  const result = await fn(tx);
  apply(ops);
  return result;
}

// ── listeners ──────────────────────────────────────────────────────────────
function notify() { for (const l of [...state.listeners]) setTimeout(l, 0); }
export function onSnapshot(ref, optsOrNext, nextOrErr, maybeErr) {
  const next = typeof optsOrNext === 'function' ? optsOrNext : nextOrErr;
  const run = () => {
    try { next(ref.type === 'document' ? docSnap(ref.path) : runQuery(asQuery(ref))); } catch (e) { (typeof optsOrNext === 'function' ? nextOrErr : maybeErr)?.(e); }
  };
  state.listeners.add(run);
  setTimeout(run, 0);
  return () => state.listeners.delete(run);
}

// ── setup no-ops ───────────────────────────────────────────────────────────
export function initializeFirestore() { return DB; }
export function getFirestore() { return DB; }
export function persistentLocalCache() { return {}; }
export function persistentSingleTabManager() { return {}; }
export function connectFirestoreEmulator() {}

// ── seeding & inspection (tests only) ──────────────────────────────────────
/** Seed values may encode times as {__ts: millis}. */
function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    if (Object.keys(v).length === 1 && typeof v.__ts === 'number') return Timestamp.fromMillis(v.__ts);
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = decode(x);
    return out;
  }
  return v;
}
function encode(v) {
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}
export const __test = {
  state,
  reset(seed = {}) {
    state.store = new Map(Object.entries(seed).map(([p, d]) => [p, decode(d)]));
    state.writeLog = [];
    state.online = true;
    state.failNext = null;
    notify();
  },
  get: (p) => (state.store.has(p) ? clone(state.store.get(p)) : undefined),
  set: (p, d) => { state.store.set(p, decode(d)); notify(); },
  paths: (prefix = '') => [...state.store.keys()].filter((p) => p.startsWith(prefix)).sort(),
  dump: () => Object.fromEntries([...state.store.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, d]) => [p, encode(d)])),
  setOnline: (v) => { state.online = !!v; },
  failNextWrite: (err = Object.assign(new Error('fake write failure'), { code: 'internal' })) => { state.failNext = err; },
};

const seed = globalThis.__FAKE_SEED__;
if (seed?.store) __test.reset(seed.store);
if (typeof window !== 'undefined') {
  window.__fakeFirestoreTest = {
    dump: __test.dump, get: (p) => encode(__test.get(p)), paths: __test.paths, set: __test.set,
  };
}
