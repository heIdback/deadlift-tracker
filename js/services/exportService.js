// ─────────────────────────────────────────────────────────────────────────
// "Backup My Data" / personal export (Phase 3D; free/manual-only model as
// of Phase 3E — there is no separate automated/paid cloud backup layer).
// This IS the app's canonical backup format: a user-triggered JSON
// download, kept by the user themselves, not something Firestore runs on
// a schedule (see README § Backup & Recovery). This service only ever
// reads `users/{uid}/...` and the caller's OWN `access/{uid}` doc, both
// already permitted by the existing firestore.rules (`isApprovedUser(uid)`
// / the `/access/{uid}` `allow get: if isOwner(uid) || isApprovedAdmin()`),
// so no rule change was needed to add this feature, and it can only ever
// read the signed-in user's own data: every query below is scoped by
// `uid`, taken from the Firebase Auth user object passed in, never from
// user input.
//
// KNOWN LIMITATION (documented here and in the README): the Firestore
// client SDK cannot enumerate "every subcollection under users/{uid}",
// only ones it's told to query by name. The list of collections read
// below is therefore a known list, matched to what the app actually
// writes today (see firestore.rules' `/users/{uid}/...` matches for the
// full set). Adding a new collection to this export only requires adding
// one entry to `USER_SUBCOLLECTIONS` below.
//
// CONSISTENCY: a Firestore client read is a set of independent queries,
// not a single database-wide transaction — if the user is actively
// logging a workout in another tab while this export runs, the export is
// a best-effort, not-perfectly-atomic snapshot (individual documents are
// each internally consistent; the collection reads are not guaranteed to
// be from the exact same instant as each other). This is called out here
// and in the README rather than silently implied to be a perfect
// point-in-time snapshot.
//
// RESTORE INVARIANTS (Phase 3E — no restore is implemented yet; these are
// binding constraints for whoever builds one later, and are also embedded
// as `restoreInvariants` in every exported JSON file so the invariants
// travel with the data itself, not just this source file):
//   1. A restore writes ONLY into the CURRENTLY AUTHENTICATED user's own
//      `users/{uid}/...` namespace — never a uid read from the backup
//      file. `exportedBy.uid` in the file is informational provenance
//      (whose backup this originally was), never a write target.
//   2. A restore NEVER creates, deletes, or otherwise touches a Firebase
//      Auth user. Identity/authentication is entirely out of scope for a
//      Firestore-data restore.
//   3. A restore NEVER changes the authenticated user's own uid.
//   4. A restore NEVER restores `account.role` or `account.status` (or
//      anything else access-control-related) from the backup file as
//      authoritative — `account` in this export is informational-only
//      (see fetchAccountRecord below, which already excludes
//      `approvedBy`/`disabledBy`). Role/status/admin privileges are
//      governed exclusively by the live `/access/{uid}` document and
//      firestore.rules, never by a JSON file a user could edit by hand.
// ─────────────────────────────────────────────────────────────────────────
import { doc, getDoc, getDocs, collection } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { APP_META } from '../../config/app.config.js';
import { serializeForExport, serializeDoc, serializeDocs } from '../utils/exportSerialize.js';
import { isGenerationSentinelId } from '../utils/trainingGeneration.js';
import { isArchivedWorkout, isArchivedMax, isArchivedMeasurement } from '../utils/trainingReset.js';
import { getResetBoundaries } from './trainingResetService.js';

const EXPORT_SCHEMA_VERSION = 1;

// Every users/{uid}/<name> top-level collection the app currently writes
// to (see firestore.rules for the authoritative list). `records`,
// `progressionSuggestions` and `nutrition` are already permitted by the
// rules for a future feature but nothing writes to them yet — they are
// included here for future-compatibility and will simply export as empty
// arrays until something does (see the "empty collections" test in the
// report).
const USER_SUBCOLLECTIONS = [
  'programRuns',
  'maxes',
  'workouts',
  'measurements',
  'records',
  'progressionSuggestions',
  'nutrition',
];

function userSubcollectionRef(uid, name) {
  return collection(db, 'users', uid, name);
}

async function fetchAccountRecord(uid) {
  const snap = await getDoc(doc(db, 'access', uid));
  if (!snap.exists()) return null;
  const data = snap.data();
  // Deliberately NOT a spread-everything: `approvedBy`/`disabledBy` (when
  // present) hold ANOTHER user's uid (the admin who acted), not this
  // user's own data, and requirement E explicitly excludes "admin/access
  // data the user is not entitled to receive" — the user is entitled to
  // know their own role/status (they already see it on Profile), not who
  // else's uid is attached to it.
  return {
    uid: data.uid,
    email: data.email ?? '',
    displayName: data.displayName ?? '',
    photoURL: data.photoURL ?? '',
    role: data.role ?? 'user',
    status: data.status ?? 'pending',
  };
}

async function fetchProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return null;
  const data = snap.data();
  // v22: the reset audit's requesting-admin uid is not the user's data (same reason approvedBy is never exported).
  if (data.trainingReset) {
    const { requestedBy, ...audit } = data.trainingReset;
    data.trainingReset = audit;
  }
  return serializeForExport(data);
}

async function fetchProgramsWithDays(uid) {
  const programsSnap = await getDocs(collection(db, 'users', uid, 'programs'));
  const programs = [];
  for (const programDoc of programsSnap.docs) {
    const daysSnap = await getDocs(collection(db, 'users', uid, 'programs', programDoc.id, 'days'));
    programs.push({
      ...serializeDoc(programDoc),
      days: serializeDocs(daysSnap),
    });
  }
  return programs;
}

/**
 * Builds the full portable export for the CURRENTLY SIGNED-IN user's own
 * data. `currentUser` is the Firebase Auth user object (from
 * getCurrentUser()); its `.uid` is what scopes every read below. Returns a
 * plain JSON-serializable object (already run through serializeForExport,
 * so it is safe to JSON.stringify directly and to hand to the CSV builders
 * below).
 */
export async function buildUserDataExport(currentUser) {
  const uid = currentUser.uid;
  // v22: a backup holds the CURRENT training period only — records from
  // before an admin reset are archived (kept in Firestore because the rules
  // forbid deleting them) and are left out, like everywhere else in the app.
  const { training, bodyweight } = await getResetBoundaries(uid);
  const keep = {
    workouts: (d) => !isArchivedWorkout(d.data(), training),
    maxes: (d) => !isArchivedMax(d.data(), training),
    measurements: (d) => !isArchivedMeasurement(d.data(), bodyweight),
  };

  const [account, profile, programs, ...subcollections] = await Promise.all([
    fetchAccountRecord(uid),
    fetchProfile(uid),
    fetchProgramsWithDays(uid),
    // v22: the admin-reset generation sentinel is device-sync bookkeeping,
    // not user data — never exported (so a restore can't bring an old one back).
    ...USER_SUBCOLLECTIONS.map((name) => getDocs(userSubcollectionRef(uid, name))
      .then((snap) => serializeDocs({ docs: snap.docs.filter((d) => !isGenerationSentinelId(d.id) && (keep[name]?.(d) ?? true)) }))),
  ]);

  const bySubcollection = Object.fromEntries(
    USER_SUBCOLLECTIONS.map((name, i) => [name, subcollections[i]]),
  );

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: { uid, email: currentUser.email ?? '' },
    app: { name: APP_META.name, version: APP_META.version },
    // See the module comment above: this is a best-effort, not perfectly
    // atomic, multi-query snapshot — not a single database transaction.
    consistencyNote:
      'This export is assembled from several independent Firestore reads, not a single ' +
      'database-wide transaction. If data changed in another session/tab while this export ' +
      'ran, the export may not reflect the exact same instant across every section.',
    // Additive field (schemaVersion stays 1 — this doesn't change how any
    // existing field is shaped, so a Phase 3D export and a Phase 3E export
    // are both still valid schemaVersion:1 files). See the module comment
    // above for the full reasoning behind each invariant.
    restoreInvariants: [
      'Restore into the CURRENTLY AUTHENTICATED user’s own namespace only — never a uid read from this file.',
      'Never recreate, delete, or otherwise modify a Firebase Auth user.',
      'Never change the authenticated user’s own uid.',
      'Never restore role/status/admin privileges or any other access-control authority from account/access metadata in this file — that is governed only by the live /access/{uid} document.',
    ],
    account, // informational only — see restoreInvariants above; never authoritative for access control
    profile,
    programs, // each: { id, ...fields, days: [{ id, ...fields }] }
    programRuns: bySubcollection.programRuns,
    workouts: bySubcollection.workouts, // includes immutable snapshot + logged sets, as-is
    maxHistory: bySubcollection.maxes,
    measurements: bySubcollection.measurements,
    records: bySubcollection.records,
    progressionSuggestions: bySubcollection.progressionSuggestions,
    nutrition: bySubcollection.nutrition,
  };
}

// CSV row-flattening lives in ../utils/exportFlatten.js — pure, no Firebase
// import, so it can be unit-tested in plain Node against a hand-built
// export object. Re-exported here so existing callers (profile.js) can
// import everything export-related from one place if they prefer; either
// import path works.
export { flattenWorkoutsForCsv, flattenMeasurementsForCsv, flattenMaxHistoryForCsv } from '../utils/exportFlatten.js';
