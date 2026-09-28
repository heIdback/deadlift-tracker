// ─────────────────────────────────────────────────────────────────────────
// "Restore My Data (JSON)" (Phase 3F) — the missing counterpart to
// "Backup My Data (JSON)" (exportService.js). This is the ONLY module that
// writes data recovered from a backup FILE, and it exists specifically to
// honor the `restoreInvariants` every export already embeds (see
// exportService.js's module comment and the `restoreInvariants` array in
// every exported file):
//
//   1. Restore writes ONLY into `auth.currentUser.uid`'s own namespace —
//      `currentUser` (a real Firebase Auth user, from getCurrentUser())
//      is the ONLY source of the uid used anywhere below. The backup
//      file's `account.uid` / `exportedBy.uid` are NEVER read for this
//      purpose — grep this file: neither `account.uid` nor
//      `exportedBy.uid` appears in any `doc(...)`/`collection(...)` call.
//   2. This file never creates, deletes, or modifies a Firebase Auth user
//      — it only ever calls Firestore functions (doc/collection/batch),
//      never anything from firebase-auth.js.
//   3. The authenticated user's own uid is never changed — it is only
//      ever read (from `currentUser.uid`), never written anywhere.
//   4. `/access/{uid}` is never read or written here at all — this file
//      imports nothing from accessAdminService.js or core/access.js, and
//      contains no reference to the `access` collection anywhere. Role,
//      status, and admin privileges stay governed exclusively by the live
//      access document and firestore.rules, never by this file.
//
// The actual DECISION logic (which document gets created / overwritten /
// deleted / skipped, and why) is entirely in js/utils/restorePlan.js, kept
// pure and Firebase-free so it can be unit-tested directly. This file's
// only jobs are: (a) read the CURRENT user's existing data just enough to
// know what already exists, (b) hand that + the parsed backup to
// planRestore(), (c) execute the resulting plan in Firestore-batch-limit-
// safe chunks, reviving the portable {_type:'timestamp',...} shape
// (exportSerialize.js) back into real Firestore Timestamps immediately
// before each write, and (d) clear the local active-workout marker
// afterward so resolveActiveWorkout (workoutService.js) re-derives fresh
// state from whatever Firestore now actually contains — see that
// function's own multi-layer self-healing, unchanged and untouched here.
//
// FAILURE MODEL (client-only Firebase architecture — no Cloud Functions,
// no transactions across this many documents): operations are chunked into
// batches of BATCH_CHUNK_SIZE (well under Firestore's 500-per-batch hard
// limit) and committed SEQUENTIALLY. Each individual batch is atomic (all
// its writes succeed or none do); the restore AS A WHOLE is not — if batch
// N fails, batches 1..N-1 have already durably committed and are NOT
// rolled back. This is safe to recover from because every write in every
// batch is keyed by the backup's OWN original document id (never a freshly
// generated id): re-running the restore on the exact same file is a safe,
// idempotent retry — already-written documents are simply written again
// with the same content (or correctly skipped, for anything the plan
// already marked immutable/unchanged), never duplicated.
// ─────────────────────────────────────────────────────────────────────────
import {
  doc, getDocs, collection, writeBatch, updateDoc, Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';
import { clearLocalActiveWorkoutMarker } from './workoutService.js';
import {
  validateBackupShape, summarizeBackup, planRestore, flattenPlanToOperations, chunkOperations,
} from '../utils/restorePlan.js';

// Comfortably under Firestore's 500-operation-per-batch hard limit, so a
// single unexpectedly large collection never risks tripping it.
const BATCH_CHUNK_SIZE = 400;

function programsCol(uid) { return collection(db, 'users', uid, 'programs'); }
function daysCol(uid, programId) { return collection(db, 'users', uid, 'programs', programId, 'days'); }
function runsCol(uid) { return collection(db, 'users', uid, 'programRuns'); }
function maxesCol(uid) { return collection(db, 'users', uid, 'maxes'); }
function workoutsCol(uid) { return collection(db, 'users', uid, 'workouts'); }
function measurementsCol(uid) { return collection(db, 'users', uid, 'measurements'); }
function recordsCol(uid) { return collection(db, 'users', uid, 'records'); }
function progressionCol(uid) { return collection(db, 'users', uid, 'progressionSuggestions'); }
function nutritionCol(uid) { return collection(db, 'users', uid, 'nutrition'); }

function collectionRefFor(uid, name, programId) {
  switch (name) {
    case 'programs': return programsCol(uid);
    case 'days': return daysCol(uid, programId);
    case 'programRuns': return runsCol(uid);
    case 'maxes': return maxesCol(uid);
    case 'workouts': return workoutsCol(uid);
    case 'measurements': return measurementsCol(uid);
    case 'records': return recordsCol(uid);
    case 'progressionSuggestions': return progressionCol(uid);
    case 'nutrition': return nutritionCol(uid);
    default: throw new Error(`Unknown restore collection: ${name}`);
  }
}

/** Duck-types the portable shape exportSerialize.js's serializeForExport() produces for a Timestamp/Date. */
function isPortableTimestamp(value) {
  return value !== null && typeof value === 'object' && value._type === 'timestamp'
    && typeof value.seconds === 'number' && typeof value.nanoseconds === 'number';
}

/** Inverse of exportSerialize.js's serializeForExport(): walks a plain value and turns every portable timestamp shape back into a real Firestore Timestamp, immediately before a write. Needs the SDK's Timestamp class, which is why this lives here (the Firebase boundary) and not in the pure utils/restorePlan.js. */
function reviveTimestamps(value) {
  if (value === null || value === undefined) return value;
  if (isPortableTimestamp(value)) return new Timestamp(value.seconds, value.nanoseconds);
  if (Array.isArray(value)) return value.map(reviveTimestamps);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = reviveTimestamps(v);
    return out;
  }
  return value;
}

/**
 * Reads a File the person picked (from an <input type="file">), parses it
 * as JSON, and runs the file-level structural validation. Throws a clear,
 * specific Error for the confirmation screen to display — never partially
 * proceeds on an invalid file (Part F: "Do not partially restore an
 * invalid backup").
 */
export async function parseAndValidateBackupFile(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    throw new Error('Could not read the selected file.');
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const { valid, errors } = validateBackupShape(json);
  if (!valid) {
    throw new Error(`This doesn't look like a valid Deadlift Tracker backup:\n${errors.join('\n')}`);
  }
  return { backup: json, summary: summarizeBackup(json) };
}

/**
 * Fetches just enough of the CURRENT authenticated user's existing data —
 * document ids and (for workouts) status only, never full content — for
 * planRestore() to compute which documents to create/overwrite/delete.
 * Every getDocs() call below is a plain, unfiltered collection read (no
 * where/orderBy), so no Firestore index is required for any of them.
 */
async function fetchExistingState(uid) {
  const programsSnap = await getDocs(programsCol(uid));
  const programIds = programsSnap.docs.map((d) => d.id);

  const dayIdsByProgram = {};
  await Promise.all(programIds.map(async (programId) => {
    const daysSnap = await getDocs(daysCol(uid, programId));
    dayIdsByProgram[programId] = daysSnap.docs.map((d) => d.id);
  }));

  const [runsSnap, maxesSnap, workoutsSnap, measurementsSnap, recordsSnap, progressionSnap, nutritionSnap] = await Promise.all([
    getDocs(runsCol(uid)),
    getDocs(maxesCol(uid)),
    getDocs(workoutsCol(uid)),
    getDocs(measurementsCol(uid)),
    getDocs(recordsCol(uid)),
    getDocs(progressionCol(uid)),
    getDocs(nutritionCol(uid)),
  ]);

  return {
    programIds,
    dayIdsByProgram,
    programRunIds: runsSnap.docs.map((d) => d.id),
    maxIds: maxesSnap.docs.map((d) => d.id),
    workouts: workoutsSnap.docs.map((d) => ({ id: d.id, status: d.data().status })),
    measurementIds: measurementsSnap.docs.map((d) => d.id),
    recordIds: recordsSnap.docs.map((d) => d.id),
    progressionSuggestionIds: progressionSnap.docs.map((d) => d.id),
    nutritionIds: nutritionSnap.docs.map((d) => d.id),
  };
}

function docRefFor(uid, op) {
  const col = op.collection === 'days' ? daysCol(uid, op.programId) : collectionRefFor(uid, op.collection);
  return doc(col, op.id);
}

/**
 * Executes the restore for `currentUser` (a real Firebase Auth user
 * object — see the module comment's invariant #1: `currentUser.uid` is the
 * ONLY uid ever used below). `backup` must already have passed
 * parseAndValidateBackupFile's structural validation.
 */
export async function restoreUserData(currentUser, backup) {
  const uid = currentUser.uid;

  const existing = await fetchExistingState(uid);
  const plan = planRestore({ backup, existing });
  const ops = flattenPlanToOperations(plan);
  const chunks = chunkOperations(ops, BATCH_CHUNK_SIZE);

  let chunksCommitted = 0;
  try {
    for (const chunk of chunks) {
      await trackWrite(async () => {
        const batch = writeBatch(db);
        for (const op of chunk) {
          const ref = docRefFor(uid, op);
          if (op.type === 'delete') batch.delete(ref);
          else if (op.type === 'update') batch.update(ref, reviveTimestamps(op.data));
          else batch.set(ref, reviveTimestamps(op.data));
        }
        await batch.commit();
      });
      chunksCommitted += 1;
    }
  } catch (err) {
    // Whatever committed, committed — see this file's module comment on the
    // failure model. Clearing the local marker is always safe regardless
    // of how far the restore got: resolveActiveWorkout re-derives fresh
    // state from whatever Firestore now actually contains either way.
    clearLocalActiveWorkoutMarker(uid);
    return {
      ok: false,
      error: err.message,
      chunksCommitted,
      chunksTotal: chunks.length,
      warnings: plan.warnings,
    };
  }

  // The profile's `currentMaxes`/`settings`/`trainingProfile` cache is a
  // single small update, applied after every batched collection write has
  // committed — see restorePlan.js's planProfileUpdate for exactly which
  // fields this ever touches (never uid/email/displayName/photoURL).
  let profileUpdateApplied = false;
  if (plan.profileUpdate) {
    try {
      await trackWrite(() => updateDoc(doc(db, 'users', uid), reviveTimestamps(plan.profileUpdate)));
      profileUpdateApplied = true;
    } catch (err) {
      plan.warnings.push(`Profile settings/currentMaxes could not be updated: ${err.message}`);
    }
  }

  clearLocalActiveWorkoutMarker(uid);

  return {
    ok: true,
    chunksCommitted,
    chunksTotal: chunks.length,
    profileUpdateApplied,
    counts: {
      programsSet: plan.programs.toSet.length,
      programsDeleted: plan.programs.toDelete.length,
      daysSet: plan.days.toSet.length,
      daysDeleted: plan.days.toDelete.length,
      programRunsSet: plan.programRuns.toSet.length,
      programRunsDeleted: plan.programRuns.toDelete.length,
      maxesCreated: plan.maxes.toCreate.length,
      workoutsCreated: plan.workouts.toCreate.length,
      workoutsUpdated: plan.workouts.toUpdate.length,
      workoutsDeleted: plan.workouts.toDelete.length,
      measurementsSet: plan.measurements.toSet.length,
      measurementsDeleted: plan.measurements.toDelete.length,
    },
    warnings: plan.warnings,
  };
}
