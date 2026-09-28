// ─────────────────────────────────────────────────────────────────────────
// Application configuration — THE single place for app metadata, Firebase
// config, and global defaults. Nothing here should be hardcoded elsewhere.
// ─────────────────────────────────────────────────────────────────────────

export const APP_META = {
  name: 'Deadlift Tracker', // temporary working name, change here only
  version: '0.2.0',
  schemaVersion: 1,
};

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
  '/import': 'import',
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