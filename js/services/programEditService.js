// ─────────────────────────────────────────────────────────────────────────
// Phase 4 — Program Editor's Firestore boundary. Deliberately thin: every
// decision about WHAT the new day content should be (validation, add/
// remove/reorder, id generation) already happened in the view using the
// pure helpers in js/utils/programEditModel.js, so this file only ever
// writes a day document that's already known-valid.
//
// A day is written wholesale (the entire `sections.main[]`/`accessory[]`
// content, not a per-field patch) — matching exactly how
// programService.js's seedDeadliftProgramForUser already writes days
// (`{ ...day }`, no field whitelist) and how restoreService.js's restore
// path writes them too (see restorePlan.js's planPrograms comment: "a
// day's own nested sections.main[]/accessory[] structure isn't a flat
// field list to whitelist against"). This keeps ONE convention for how a
// day document's shape is written, everywhere in the app.
//
// Owner-only write, already covered by firestore.rules' existing
// `allow write: if isApprovedUser(uid)` on `programs/{programId}/days/
// {dayId}` — no rules change needed.
// ─────────────────────────────────────────────────────────────────────────
import { doc, setDoc, collection } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';

const daysCol = (uid, programId) => collection(db, 'users', uid, 'programs', programId, 'days');

/**
 * Overwrites one program day's content with `dayData` (the full day
 * object, id excluded — the id is the doc id, passed separately). This can
 * ONLY ever affect the program TEMPLATE (`programs/{programId}/days/
 * {dayId}`) — it has no path to a workout snapshot
 * (`users/{uid}/workouts/{workoutId}`) at all, which is the structural
 * reason editing a day can never mutate an in-progress or completed
 * workout (see workoutService.js's resolveActiveWorkout/
 * startOrResumeWorkout: a workout, once created, is read from its OWN
 * document and never re-derived from this one again).
 */
export async function saveDay(uid, programId, dayId, dayData) {
  const { id: _drop, ...rest } = dayData;
  await trackWrite(() => setDoc(doc(daysCol(uid, programId), dayId), rest));
}
