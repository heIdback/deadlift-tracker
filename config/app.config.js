// ─────────────────────────────────────────────────────────────────────────
// Application configuration — THE single place for app metadata, Firebase
// config, and global defaults. Nothing here should be hardcoded elsewhere.
// ─────────────────────────────────────────────────────────────────────────

export const APP_META = {
  name: 'Deadlift Tracker', // change here only
  // v1.1: the maker/brand, shown quietly (login byline, footer, Profile
  // "About") — never repeated as a hardcoded string anywhere else.
  publisher: 'heldback',
  copyrightYear: 2026,
  // 1.1.0: first feature release after the v1 production build (Program
  // Import, actual-set logging, heldback branding). Tracks the app, not the
  // service-worker cache name (sw.js CACHE_VERSION).
  version: '1.1.0',
  // Unchanged on purpose: v1.1's new data (set `status`, program `version`/
  // `importSource`/`importedAt`/`notes`/`decisionRules`) is purely additive
  // and optional — every
  // existing document still reads correctly without migration.
  schemaVersion: 1,
};

/** "Deadlift Tracker · heldback" — browser tab title. */
export const APP_TITLE = `${APP_META.name} · ${APP_META.publisher}`;

// Replace with your Firebase project's web config (Firebase Console →
// Project Settings → General → Your apps → SDK setup and configuration).
// These values are safe to expose client-side; security is enforced by
// Firestore Security Rules + Authentication, not by hiding this object.
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBINvQ8-c8WleimmPwa22ZCfKgXEwJbPbI',
  authDomain: 'dltracker-8bed3.firebaseapp.com',
  projectId: 'dltracker-8bed3',
  storageBucket: 'dltracker-8bed3.firebasestorage.app',
  messagingSenderId: '623009406316',
  appId: '1:623009406316:web:27a8863c06aaa1ad82e749',
};

// Global defaults. Per-user overrides live in users/{uid}.settings.
export const DEFAULTS = {
  units: 'kg',
  rounding: {
    barbell: 2.5,
    dumbbell: 1,
    machine: 2.5,
    bodyweight: 0,
  },
  restPresetsSec: [60, 90, 120, 180, 300],
  epleyFormula: (weight, reps) => weight * (1 + reps / 30),
};

// Hash-routes → view module map. Adding a new screen only touches this file
// and js/views/<name>.js.
export const ROUTES = {
  '/login': 'login',
  '/': 'home',
  '/home': 'home',
  '/workout': 'workout',
  '/history': 'history',
  '/progress': 'progress',
  '/profile': 'profile',
  '/nutrition': 'nutrition',
  // v1.1: the old placeholder route (its view file never existed) now opens
  // Program → Import Program — js/views/program.js redirects it there.
  '/import': 'program',
  '/admin': 'admin',
  '/program': 'program', // Phase 4: Program Management & Program Editor
};

export const NAV_ITEMS = [
  { route: '/home', label: 'Home', icon: 'home' },
  { route: '/workout', label: 'Workout', icon: 'dumbbell' },
  { route: '/history', label: 'History', icon: 'clock' },
  { route: '/progress', label: 'Progress', icon: 'chart' },
  { route: '/program', label: 'Program', icon: 'program' }, // Phase 4
  { route: '/profile', label: 'Profile', icon: 'user' },
];