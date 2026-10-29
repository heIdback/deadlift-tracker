// TEST DOUBLE of firebase-auth.js: the signed-in user comes from
// globalThis.__FAKE_SEED__.user (null = signed out).
const auth = { currentUser: null };
const listeners = new Set();
export function getAuth() { return auth; }
export class GoogleAuthProvider {}
function emit() { for (const cb of listeners) setTimeout(() => cb(auth.currentUser), 0); }
export function onAuthStateChanged(_auth, cb) {
  listeners.add(cb);
  setTimeout(() => cb(auth.currentUser), 0);
  return () => listeners.delete(cb);
}
export async function signInWithPopup() { auth.currentUser = globalThis.__FAKE_SEED__?.user ?? null; emit(); return { user: auth.currentUser }; }
export async function signOut() { auth.currentUser = null; emit(); }
const u = globalThis.__FAKE_SEED__?.user;
if (u) auth.currentUser = { ...u, getIdToken: async () => 'fake-token' };
