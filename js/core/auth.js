import {
  signInWithPopup,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { auth, googleProvider } from './firebase.js';

// NOTE (Phase 3C): this module is now purely about Firebase Auth identity —
// it no longer touches fitness data. `ensureUserProfile` used to be called
// unconditionally here on every sign-in; that would have initialized a
// brand-new user's fitness data before their access request was even
// approved. Fitness-data init now happens in core/access.js, and ONLY once
// an `/access/{uid}` record confirms `status === 'approved'`. Being
// authenticated is necessary but no longer sufficient to use the app.

let currentUser = null;
let resolved = false; // becomes true after Firebase's first auth check completes
const listeners = new Set();

/**
 * Subscribe to auth state. Calls back immediately ONLY if the initial
 * Firebase auth check has already resolved — otherwise waits for the first
 * real resolution, so callers (like the router) never mistake "not checked
 * yet" for "confirmed signed out" and flash the login screen on reload.
 */
export function onAuthChange(callback) {
  listeners.add(callback);
  if (resolved) callback(currentUser);
  return () => listeners.delete(callback);
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  resolved = true;
  listeners.forEach((cb) => cb(user));
});

export function getCurrentUser() {
  return currentUser;
}

export function requireUid() {
  if (!currentUser) throw new Error('No authenticated user. Call requireUid() only after auth is resolved.');
  return currentUser.uid;
}

export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (err) {
    console.error('Google sign-in failed:', err);
    throw new Error('Sign-in failed. Please try again.');
  }
}

export async function signOut() {
  await fbSignOut(auth);
}
