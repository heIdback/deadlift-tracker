// ─────────────────────────────────────────────────────────────────────────
// Firebase initialization. Single place the rest of the app imports
// `auth` and `db` from. Enables Firestore offline persistence so a workout
// can keep being logged through a temporary connectivity loss.
// ─────────────────────────────────────────────────────────────────────────
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { FIREBASE_CONFIG } from '../../config/app.config.js';

export const app = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Persistent (IndexedDB) cache + single-tab manager: simplest offline story
// for a personal training app used from one device/tab at a time. If you
// open the app in two tabs simultaneously, only one will sync live; this
// is an accepted trade-off documented in the README.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
});

// Uncomment for local emulator testing:
// connectFirestoreEmulator(db, 'localhost', 8080);
