// ─────────────────────────────────────────────────────────────────────────
// The four lifts the built-in Deadlift Focused starter program needs a
// current 1RM for (its percent/percentRange-based loads are computed from
// these). Shared between Profile's "Current 1RM values" form and the
// new-user onboarding gate (js/views/onboarding.js, js/core/access.js) so
// the two can never drift out of sync with each other or with which lifts
// the packaged program actually prescribes loads from.
//
// OHP/Overhead Press is deliberately absent (see data/program.deadlift-8wk.
// json / README) and must stay absent here.
// ─────────────────────────────────────────────────────────────────────────
export const REQUIRED_STARTER_LIFTS = [
  { id: 'deadlift', label: 'Deadlift' },
  { id: 'back-squat', label: 'Back Squat' },
  { id: 'romanian-deadlift', label: 'Romanian Deadlift' },
  { id: 'bench-press', label: 'Bench Press' },
];
