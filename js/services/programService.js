import {
  doc, setDoc, getDoc, getDocs, collection, query, where,
  serverTimestamp, writeBatch, updateDoc, orderBy, limit, onSnapshot, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';
import { getDocSafe, getDocsSafe } from '../utils/firestoreRead.js';
import { shouldInstallStarterProgram, pickStarterPosition } from '../utils/starterProgram.js';
import { planDuplicateProgram, generateProgramId } from '../utils/programEditModel.js';
import { commitTrainingBatch } from './trainingGenerationService.js';

const programsCol = (uid) => collection(db, 'users', uid, 'programs');
const daysCol = (uid, programId) => collection(db, 'users', uid, 'programs', programId, 'days');
const runsCol = (uid) => collection(db, 'users', uid, 'programRuns');

// Fixed id of the packaged Deadlift Focused starter program (see
// scripts/generate_program.py and data/program.deadlift-8wk.json's own
// `id` field, which this must match). Exported for any future code that
// needs to recognize "is this program the built-in starter" without a
// full Program Editor to compare against instead.
export const DEADLIFT_SEED_PROGRAM_ID = 'deadlift-focused-8wk';

/**
 * Fetches the packaged, pre-normalized program JSON (see
 * data/program.deadlift-8wk.json and scripts/generate_program.py) and
 * writes it into Firestore as a USER-OWNED program template + its days
 * subcollection under `users/{uid}/programs/{programId}/...` — a separate
 * document per user even though the id string is shared, so one user's
 * future edits (Program Editor, a later phase) can never affect another's.
 *
 * This is the underlying template-install engine, reused by BOTH the
 * automatic new-user starter installer (`ensureStarterProgramForUser`,
 * below — the only caller as of Phase 3E, since the manual "Import"/
 * "Update imported program" Profile buttons were removed) and, in
 * principle, any future "reset my program back to the packaged
 * defaults" action. It is idempotent by deterministic ID: the program
 * and day document IDs come from the JSON itself (program.id, day.id per
 * day), so calling this again overwrites the existing template in place —
 * it never creates a duplicate program or duplicate day docs — and
 * removes any day doc that exists in Firestore but is no longer present
 * in the current seed JSON, so a re-run reflects the packaged program
 * exactly without leaving stale days behind.
 *
 * Deliberately does NOT touch currentMaxes or maxes history (Phase 3E
 * fix): the JSON's `currentOneRepMaxesAtImport` field is a historical
 * record of what the ORIGINAL importing user's own maxes were at the time
 * their spreadsheet was converted — it must never be copied into another
 * user's `currentMaxes` as if it were a sensible default. A brand-new
 * user's required maxes are collected explicitly via the onboarding gate
 * (js/views/onboarding.js) and saved through the normal
 * `recordOneRepMax` path instead. This function only ever installs
 * program/day structure, never personal training data.
 */
export async function seedDeadliftProgramForUser(uid, jsonPath = '../../data/program.deadlift-8wk.json') {
  const res = await fetch(new URL(jsonPath, import.meta.url));
  if (!res.ok) throw new Error(`Could not load seed program JSON (${res.status})`);
  const program = await res.json();

  return trackWrite(async () => {
    const [existingProgramSnap, existingDaySnaps] = await Promise.all([
      getDoc(doc(programsCol(uid), program.id)),
      getDocs(daysCol(uid, program.id)),
    ]);
    const isFirstImport = !existingProgramSnap.exists();

    const batch = writeBatch(db);

    const programRef = doc(programsCol(uid), program.id);
    batch.set(programRef, {
      schemaVersion: program.schemaVersion,
      name: program.name,
      sourceFile: program.sourceFile,
      roundingRules: program.roundingRules,
      weeks: program.weeks,
      exerciseLibrary: program.exerciseLibrary,
      importReviewFlags: program.importReviewFlags,
      // Preserve the original createdAt on an update; only set it once.
      createdAt: isFirstImport ? serverTimestamp() : existingProgramSnap.data().createdAt,
      updatedAt: serverTimestamp(),
    });

    const currentDayIds = new Set(program.days.map((d) => d.id));
    for (const day of program.days) {
      const dayRef = doc(daysCol(uid, program.id), day.id);
      batch.set(dayRef, { ...day });
    }
    // Remove any day the packaged program no longer has, so the template
    // matches the current seed exactly rather than accumulating stale days.
    for (const existingDay of existingDaySnaps.docs) {
      if (!currentDayIds.has(existingDay.id)) {
        batch.delete(existingDay.ref);
      }
    }

    await batch.commit();
    return program.id;
  });
}

// Fixed, deterministic id for the programRun the automatic starter
// installer creates. Using a constant id here (rather than an auto-ID, the
// way the manual startProgramRun() below does for a user-initiated "start
// a new run" action) is what makes ensureStarterProgramForUser safe to
// call more than once: two calls can only ever read/write the SAME run
// document, never create a second one — see its docstring.
const STARTER_RUN_ID = 'starter-run';

/**
 * Automatic new-user onboarding (Phase 3E): installs a user-owned copy of
 * the built-in Deadlift Focused starter program and starts its first
 * programRun (Week 1 / the first actual ordered training day — never a
 * hardcoded day-order value), but ONLY for a user who currently has NO
 * program AND NO active programRun at all. A user who already has ANY
 * program — this starter, or anything else — is left completely
 * untouched; this is what protects an existing account (see the Phase 3E
 * report's "existing users protected" section) and is why the check below
 * is "any program exists" rather than "this specific starter program
 * exists" (a user with a different program should never get a second one
 * silently added either).
 *
 * Idempotent by construction, not merely by the pre-check: the program
 * keeps its usual deterministic id (seedDeadliftProgramForUser upserts,
 * never duplicates), and the run uses the fixed STARTER_RUN_ID rather
 * than an auto-generated one — so even if this were invoked twice
 * concurrently (a slow-network double page-load, two tabs racing on first
 * sign-in), both calls can only ever upsert the SAME two documents, never
 * create a second program or a second run. The pre-check exists to skip
 * the work entirely for the overwhelmingly common case (an existing user
 * signing in again), not to be the sole guarantee against duplicates.
 *
 * Called from core/access.js, only once access status is confirmed
 * 'approved' — never for a pending/disabled user (see that module).
 */
export async function ensureStarterProgramForUser(uid) {
  const [existingPrograms, activeRun] = await Promise.all([
    listPrograms(uid),
    getActiveProgramRun(uid),
  ]);
  if (!shouldInstallStarterProgram({ existingProgramsCount: existingPrograms.length, hasActiveRun: !!activeRun })) {
    return { installed: false };
  }

  const programId = await seedDeadliftProgramForUser(uid);
  const days = await getProgramDays(uid, programId); // already ordered by `order`
  const position = pickStarterPosition(days);
  if (!position) return { installed: false }; // defensive: an empty/malformed template can't be positioned

  const runRef = doc(runsCol(uid), STARTER_RUN_ID);
  const runSnap = await getDoc(runRef);
  if (!runSnap.exists()) {
    await trackWrite(() => {
      const batch = writeBatch(db);
      batch.set(runRef, {
        programId,
        startDate: serverTimestamp(),
        current: position,
        status: 'active',
        overrides: {},
      });
      return commitTrainingBatch(uid, batch); // v22: admin-reset generation guard
    });
  }
  return { installed: true, programId, runId: STARTER_RUN_ID };
}

/**
 * Correction pass 6: listPrograms/getProgram/getProgramDays/
 * getActiveProgramRun (below) were all plain, online-preferring reads with
 * zero offline handling — called directly by js/views/home.js's mount()
 * (via getPrimaryProgramContext and its own getProgramDays call) and by
 * js/views/workout.js's mount() (via getPrimaryProgramContext), these were
 * the exact reads that left both screens stuck on their "Loading…" state
 * indefinitely when reached while offline (see this pass's report). Now
 * routed through the shared getDocSafe/getDocsSafe (../utils/firestoreRead.js)
 * — identical behavior online; offline, falls back to Firestore's local
 * cache instead of hanging. seedDeadliftProgramForUser's own reads (above)
 * are deliberately left as plain getDoc/getDocs — that write-preparation
 * path is only ever reached while online (gated by core/access.js), so
 * converting it would add offline-cache-miss ambiguity with no benefit.
 */
export async function listPrograms(uid) {
  const snap = await getDocsSafe(programsCol(uid));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getProgram(uid, programId) {
  const snap = await getDocSafe(doc(programsCol(uid), programId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getProgramDays(uid, programId) {
  const snap = await getDocsSafe(query(daysCol(uid, programId), orderBy('order')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Phase 4: convenience for Program Overview/Editor — one program plus its ordered days in one call. */
export async function getProgramWithDays(uid, programId) {
  const [program, days] = await Promise.all([getProgram(uid, programId), getProgramDays(uid, programId)]);
  return { program, days };
}

/** Get the single active programRun for a user, if any. */
export async function getActiveProgramRun(uid) {
  const q = query(runsCol(uid), where('status', '==', 'active'), limit(1));
  const snap = await getDocsSafe(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

/**
 * Phase 4: every programRun a user has, regardless of status — a plain,
 * unfiltered collection read (no query filter, no orderBy), so it needs no
 * new Firestore index, matching the "pragmatic client-side aggregation is
 * acceptable for a small current user base" precedent already used by
 * adminInsightsService.js's own per-user reads. Used by Program view
 * (Part P, to know which programs are active/inactive) and
 * setActiveProgram (Part P, to decide whether to reuse a prior run for
 * the target program).
 */
export async function listProgramRuns(uid) {
  const snap = await getDocs(runsCol(uid));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Deterministically resolves "the" program to show, instead of assuming
 * Firestore's first returned document is the active one:
 *   1. an active programRun's programId, if one exists
 *   2. the sole existing program, if exactly one exists and no run is active
 *   3. null (with multipleUnresolved: true) if more than one program exists
 *      and none is active yet — a program picker is deferred to a later
 *      phase, so callers should show a neutral state rather than guess.
 */
export async function getPrimaryProgramContext(uid) {
  const run = await getActiveProgramRun(uid);
  if (run) {
    const program = await getProgram(uid, run.programId);
    return { program, run, multipleUnresolved: false };
  }
  const programs = await listPrograms(uid);
  if (programs.length === 1) {
    return { program: programs[0], run: null, multipleUnresolved: false };
  }
  if (programs.length > 1) {
    return { program: null, run: null, multipleUnresolved: true };
  }
  return { program: null, run: null, multipleUnresolved: false };
}

/**
 * Starts a new run of a program, at week 1 / day 1. Does not delete history.
 *
 * Correction pass 3: returns the full written run object (previously just
 * `ref.id`) so a caller that's about to start/resume a workout for a
 * brand-new run (js/views/home.js, js/views/workout.js) can use it directly
 * without a follow-up read — additive/backward-compatible, since both
 * existing callers previously discarded the return value entirely.
 *
 * Correction pass 8 (Phase 5A, "Starting…" hangs forever offline — the
 * never-started-run branch): this used to `await setDoc(ref, runData)`
 * directly for control flow — that Promise is gated on BACKEND
 * acknowledgement exactly like every other Firestore write, so it never
 * resolved while offline.
 *
 * Correction pass 9: Pass 8's follow-up fix (`await
 * waitForLocalDocToExist(ref)`, a fresh `onSnapshot` on this brand-new
 * doc) was STILL found hanging in a real offline browser for the sibling
 * case in workoutService.js's `startOrResumeWorkout` — see that
 * function's own doc comment for the full root-cause analysis (this
 * project's fake-Firestore test doubles cannot exercise the real Firebase
 * Web SDK, so they could not have ruled this out, and did not). The
 * identical reasoning and identical fix apply here: `setDoc(ref, runData)`
 * is invoked (never awaited) and this function returns immediately,
 * constructed straight from `runData`/`ref.id` — data we already hold in
 * memory, not something that needs reading back from Firestore.
 * `waitForLocalDocToExist` is kept only as a non-blocking, logged
 * diagnostic.
 *
 * Also closes the same double-invocation gap workoutService.js's
 * `inFlightStarts` map closes for workout creation: two concurrent calls
 * for the same uid (e.g. a rapid double-dispatched click, or Home's and
 * Workout's Start buttons racing) would otherwise each create a SEPARATE
 * programRun, since a fresh auto-ID has no natural dedup the way an
 * existing doc's status field gives finishWorkout/skipWorkout. This guard
 * is purely additive — it does not change anything about what gets
 * written, only ensures only ONE attempt is ever in flight per uid.
 */
const inFlightProgramRunStarts = new Map(); // uid -> Promise

export async function startProgramRun(uid, programId) {
  console.debug('[START] startProgramRun: entry', { uid, programId });
  const inFlight = inFlightProgramRunStarts.get(uid);
  if (inFlight) {
    console.debug('[START] startProgramRun: joining an already in-flight attempt', { uid });
    return inFlight;
  }

  const attempt = trackWrite(async () => {
    const ref = doc(runsCol(uid));
    const runData = {
      programId,
      startDate: serverTimestamp(),
      current: { week: 1, dayOrder: 1 },
      status: 'active',
      overrides: {},
    };
    console.debug('[START] startProgramRun: invoking setDoc()', { uid, runId: ref.id, programId });
    // Correction pass 9: invoked, never awaited — see this function's doc
    // comment above. Nothing below depends on Firestore reading this back.
    const batch = writeBatch(db);
    batch.set(ref, runData);
    commitTrainingBatch(uid, batch).then( // v22: admin-reset generation guard
      () => console.debug('[START] startProgramRun: setDoc() backend-acknowledged', { runId: ref.id }),
      (err) => console.error('[START] startProgramRun: setDoc() failed', { runId: ref.id, err }),
    );
    // Diagnostic-only — never awaited; see workoutService.js's identical
    // pattern for why.
    waitForLocalDocToExist(ref).then(
      () => console.debug('[START] startProgramRun: diagnostic onSnapshot confirms local existence', { runId: ref.id }),
      (err) => console.error('[START] startProgramRun: diagnostic onSnapshot errored (non-fatal)', { runId: ref.id, err }),
    );
    console.debug('[START] startProgramRun: returning immediately (no wait)', { runId: ref.id });
    return { id: ref.id, ...runData };
  }).finally(() => {
    inFlightProgramRunStarts.delete(uid);
  });
  inFlightProgramRunStarts.set(uid, attempt);
  return attempt;
}

/**
 * One-shot wait for a brand-new doc's LOCAL cache view to report
 * `exists() === true` — see startProgramRun's own doc comment above and
 * workoutService.js's `waitForLocalDocToExist` (the identical helper,
 * duplicated here rather than imported to keep each service module
 * self-contained, matching this project's existing per-file structure).
 */
function waitForLocalDocToExist(ref) {
  return new Promise((resolve, reject) => {
    const unsubscribe = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.exists()) {
          unsubscribe();
          resolve(snap);
        }
      },
      (err) => {
        unsubscribe();
        reject(err);
      },
    );
  });
}

/** Manual navigation controls, per the "skip / repeat / move / advance / go back" requirement. */
export async function advanceProgramRun(uid, runId, { week, dayOrder }) {
  await trackWrite(() => {
    const batch = writeBatch(db);
    batch.update(doc(runsCol(uid), runId), { current: { week, dayOrder } });
    return commitTrainingBatch(uid, batch); // v22: admin-reset generation guard
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 4 — Program Management: rename and duplicate. Both are owner-only
// writes to `programs/{programId}` (+ its `days` subcollection for
// duplicate), already covered by firestore.rules' existing
// `allow write: if isApprovedUser(uid)` on those paths — no rules change
// needed (see the Phase 4 final report's Firestore-rules item).
// ─────────────────────────────────────────────────────────────────────────

/** Part O — Rename Program. Only the name changes; every other field is untouched. */
export async function renameProgram(uid, programId, newName) {
  await trackWrite(() => updateDoc(doc(programsCol(uid), programId), {
    name: newName,
    updatedAt: serverTimestamp(),
  }));
}

/**
 * Part O — Duplicate Program: a full independent copy under a new program
 * id, using the pure plan from js/utils/programEditModel.js (which is what
 * actually decides what gets copied — see its docstring for why
 * programRuns/workouts are never touched). Written as a single batch so the
 * new program and all of its days appear atomically or not at all.
 * Returns the new program's id.
 */
export async function duplicateProgram(uid, programId, newName) {
  const [source, existingPrograms] = await Promise.all([
    getProgramWithDays(uid, programId),
    listPrograms(uid),
  ]);
  if (!source.program) throw new Error('Program not found.');

  const newProgramId = generateProgramId(newName, existingPrograms.map((p) => p.id));
  const plan = planDuplicateProgram({
    sourceProgram: source.program,
    sourceDays: source.days,
    newProgramId,
    newName,
  });

  return trackWrite(async () => {
    const batch = writeBatch(db);
    const programRef = doc(programsCol(uid), plan.programId);
    batch.set(programRef, {
      ...plan.program,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    for (const day of plan.days) {
      batch.set(doc(daysCol(uid, plan.programId), day.id), day.data);
    }
    await batch.commit();
    return plan.programId;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// v1.1 — Program Import (JSON/CSV). The plan comes from
// js/utils/programImport.js's validateProgramDefinition (already
// validated, sanitized and whitelisted there); this is the one write.
//
// Guarantees, by construction:
//   - NEVER overwrites: a transaction re-reads `programs/{id}` and aborts
//     with ProgramIdConflictError if it exists — even if another tab/device
//     created that id after the preview was shown.
//   - All-or-nothing: the program doc and every day doc are written in the
//     same transaction, so a failure leaves nothing partially imported.
//   - Only ever touches `users/{uid}/programs/{newId}` and its `days` — the
//     uid is the signed-in caller's (never anything from the file), and
//     programRuns/workouts/maxes/measurements/profile are never read or
//     written. Setting the new program active is a separate, explicit
//     user action (Program → Set Active).
//   - Needs a connection: Firestore transactions don't run offline, so an
//     offline attempt fails cleanly with nothing written.
// ─────────────────────────────────────────────────────────────────────────

export class ProgramIdConflictError extends Error {
  constructor(programId) {
    super(`A program with id "${programId}" already exists. Nothing was imported.`);
    this.name = 'ProgramIdConflictError';
    this.programId = programId;
  }
}

/** Program-doc fields an import may write (defense in depth on top of the validator's own whitelist). */
const IMPORTED_PROGRAM_FIELDS = ['schemaVersion', 'name', 'version', 'sourceFile', 'roundingRules', 'weeks', 'exerciseLibrary', 'importReviewFlags', 'importSource', 'notes', 'decisionRules', 'generatedBy', 'currentOneRepMaxesAtImport'];

export async function importProgram(uid, plan) {
  if (!uid) throw new Error('Not signed in.');
  if (!plan || typeof plan.programId !== 'string' || !Array.isArray(plan.days) || plan.days.length === 0) {
    throw new Error('Nothing to import.');
  }
  const programData = {};
  for (const f of IMPORTED_PROGRAM_FIELDS) {
    if (plan.program?.[f] !== undefined) programData[f] = plan.program[f];
  }
  const programRef = doc(programsCol(uid), plan.programId);

  return trackWrite(() => runTransaction(db, async (tx) => {
    const existing = await tx.get(programRef);
    if (existing.exists()) throw new ProgramIdConflictError(plan.programId);
    tx.set(programRef, {
      ...programData,
      importedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    for (const day of plan.days) {
      tx.set(doc(daysCol(uid, plan.programId), day.id), day.data);
    }
    return plan.programId;
  }));
}
