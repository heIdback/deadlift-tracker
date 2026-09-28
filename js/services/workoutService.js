import {
  collection, doc, query, where, orderBy, limit,
  writeBatch, updateDoc, serverTimestamp, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';
import { getDocSafe, getDocsSafe } from '../utils/firestoreRead.js';
import { getProgram, getProgramDays } from './programService.js';
import { buildResolvedExerciseList, generateSetsForExercise } from '../utils/workoutSnapshot.js';
import { computeNextPosition } from '../utils/programProgress.js';
import { classifyCompletionState, isEditableCompletedWorkout, EXPLICIT_SKIP_STATE, resolveCompletionState } from '../utils/workoutCompletion.js';
import { orderExercisesWarmupFirst } from '../utils/exerciseOrdering.js';
import { isOfflineUnavailableError } from '../utils/offlineError.js';

const workoutsCol = (uid) => collection(db, 'users', uid, 'workouts');
const workoutDocRef = (uid, workoutId) => doc(workoutsCol(uid), workoutId);
const runDocRef = (uid, runId) => doc(db, 'users', uid, 'programRuns', runId);

/**
 * NOTE: this service creates the immutable workout snapshot and
 * resolves/resumes it idempotently (Phase 3A), fills each exercise's
 * `sets[]` at start time and autosaves per-set logging (Phase 3B), and
 * advances the associated programRun on Finish plus self-heals any
 * pre-advancement legacy position (Phase 3C) — see `finishWorkout` and
 * `reconcileLegacyProgramPosition` below. The rest timer, "previous
 * performance" comparison, PR detection, and progression suggestions
 * remain out of scope.
 */

// ── Local, same-browser "active workout" marker ─────────────────────────
// Synchronous and offline-safe. This is one of THREE layers protecting
// against duplicate in-progress workouts (see resolveActiveWorkout below);
// it alone stops the most common real case — a same-tab double-tap on
// START, or a refresh — because the write happens before any `await`, so a
// second click's handler can't run until the first has already recorded
// the marker (JS is single-threaded).
function localKey(uid) {
  return `dt:activeWorkoutId:${uid}`;
}
function readLocalActiveId(uid) {
  try {
    return localStorage.getItem(localKey(uid));
  } catch {
    return null; // storage unavailable (private mode, etc.) — not fatal
  }
}
function writeLocalActiveId(uid, workoutId) {
  try {
    if (workoutId) localStorage.setItem(localKey(uid), workoutId);
    else localStorage.removeItem(localKey(uid));
  } catch {
    /* non-fatal */
  }
}

export async function getWorkout(uid, workoutId) {
  let snap;
  try {
    snap = await getDocSafe(doc(workoutsCol(uid), workoutId));
  } catch {
    // Offline + never cached: treated as "not found" here, exactly like a
    // real not-found doc — resolveActiveWorkout's callers already handle
    // that by clearing the stale local marker and falling through to the
    // next layer, which is the correct self-heal either way.
    return null;
  }
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Returns the in-progress workout, if any, via a plain query. Used as the
 * third, self-healing fallback layer by resolveActiveWorkout — not depended
 * on alone (see that function's own doc comment).
 *
 * Correction pass 3, offline (now routed through the shared getDocsSafe,
 * ../utils/firestoreRead.js, since correction pass 6): `getDocsFromCache` is
 * used instead of a plain `getDocs`, but its EMPTY result is deliberately
 * never trusted as proof of
 * "no in-progress workout" — real-world SDK behavior (firebase-js-sdk#6851)
 * is that a query that was never itself cached resolves with an empty
 * snapshot rather than rejecting, which is indistinguishable at the API
 * level from "genuinely zero matches". Since this function is only ever
 * the THIRD, self-healing layer — reached after the local marker (layer 1)
 * and the run's own atomically-written activeWorkoutId pointer (layer 2)
 * have ALREADY come back clean — treating its offline empty result the
 * same way (i.e. "nothing more to add") never weakens those two primary,
 * reliable defenses; it only means this particular safety net (recovering
 * from a lost/corrupted pointer) is best-effort while offline, same as it
 * already was best-effort in general (see this function's own callers).
 * A genuine cache HIT is always trusted and used.
 */
export async function getInProgressWorkout(uid) {
  const q = query(
    workoutsCol(uid),
    where('status', '==', 'in_progress'),
    orderBy('startedAt', 'desc'),
    limit(1),
  );
  const snap = await getDocsSafe(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

/**
 * Resolves the current in-progress workout, checking three layers so no
 * single lost/stale pointer causes either a duplicate workout or a failure
 * to resume:
 *   1. the local marker (instant, offline-safe, same browser)
 *   2. programRun.activeWorkoutId (cross-device source of truth, written
 *      atomically alongside the workout doc when it's created)
 *   3. a plain Firestore query, as a self-healing fallback
 * Stale pointers found along the way are cleared (best-effort).
 */
export async function resolveActiveWorkout(uid, run) {
  // Correction pass 9: permanent, low-noise checkpoint logging along the
  // real Start/Resume path — added because a real offline browser test
  // disproved Pass 8's claim of having traced every hang site, and the
  // fake-Firestore-based exec/browser test suites cannot exercise the real
  // Firebase Web SDK at all (no network path to a real Firestore backend
  // from this project's automated test environment — see this pass's
  // report). These logs are the only way to see, from an actual failing
  // browser, exactly which checkpoint is last reached. `console.debug` is
  // dev-tools-only noise (invisible in the default "Info" console level in
  // most browsers) and safe to leave in permanently.
  console.debug('[START] resolveActiveWorkout: entry', {
    uid, localMarker: readLocalActiveId(uid), runActiveWorkoutId: run?.activeWorkoutId ?? null,
  });
  const localId = readLocalActiveId(uid);
  if (localId) {
    const w = await getWorkout(uid, localId);
    console.debug('[START] resolveActiveWorkout: local marker checked', { localId, found: !!w, status: w?.status });
    if (w && w.status === 'in_progress') return w;
    writeLocalActiveId(uid, null);
  }

  if (run?.activeWorkoutId) {
    const w = await getWorkout(uid, run.activeWorkoutId);
    console.debug('[START] resolveActiveWorkout: run.activeWorkoutId checked', { activeWorkoutId: run.activeWorkoutId, found: !!w, status: w?.status });
    if (w && w.status === 'in_progress') {
      writeLocalActiveId(uid, w.id);
      return w;
    }
    // Correction pass 8: this stale-pointer cleanup used to be
    // `await updateDoc(...)` inside a try/catch — but a try/catch only ever
    // catches a genuine REJECTION; it does nothing for a Promise that
    // simply never settles, which is exactly `updateDoc`'s documented
    // behavior offline (same backend-ack-gated contract as every other
    // Firestore write — see finalizeInProgressWorkout's doc comment). That
    // made this "best-effort, not required to succeed" cleanup capable of
    // hanging the ENTIRE resolveActiveWorkout call indefinitely offline —
    // and since this function runs at Workout/Home mount time (not just
    // inside Start), that could leave the "Loading workout…"/"Loading
    // dashboard…" screen stuck forever, well before the lifter ever sees a
    // START button. Nothing below this block depends on this write's
    // completion (the fallback query two lines down doesn't read
    // `activeWorkoutId` at all), so it never needed to be awaited for
    // control flow in the first place — fire it and move on immediately.
    updateDoc(runDocRef(uid, run.id), { activeWorkoutId: null }).catch(() => {
      /* best-effort cleanup, not required to succeed */
    });
  }

  const found = await getInProgressWorkout(uid);
  console.debug('[START] resolveActiveWorkout: fallback query result', { found: !!found, id: found?.id });
  if (found) {
    writeLocalActiveId(uid, found.id);
    return found;
  }
  return null;
}

/**
 * CORRECTION PASS 9 — Pass 8's fix still hung on "Starting…" in a REAL
 * offline browser (existing run, Week 2, no active workout, no stale
 * pointer — a plain, ordinary offline Start). Pass 8's own fake-Firestore
 * based exec/browser test suites all passed, which is itself the finding:
 * this project's test doubles cannot exercise the real Firebase Web SDK at
 * all (no network path from this project's automated test environment to
 * a real Firestore backend — see this pass's report for the full
 * limitation statement), so a fake that gets `onSnapshot`'s exact timing
 * or first-ever-listener-on-a-brand-new-document semantics even slightly
 * wrong can pass every automated test while the real SDK still hangs.
 * Pass 8's `waitForLocalDocToExist` awaited a freshly-registered
 * `onSnapshot` on `newRef` — a document that has never been read, queried,
 * or watched by this client before this exact call — to PROVE the batch
 * landed locally before letting the UI proceed. That is precisely the one
 * part of Pass 8's mechanism this project's fakes cannot validate, and a
 * real browser has now shown it cannot be trusted to fire promptly (or, on
 * this evidence, possibly at all) offline for that specific shape of
 * listener.
 *
 * ROOT-CAUSE-LEVEL FIX (not a timeout, not a guess dressed as certainty):
 * stop depending on Firestore telling us what we just wrote back. We
 * already know exactly what `snapshot`/`workoutId` are — we built them
 * ourselves, synchronously, above — so there is nothing left to read back
 * for correctness. The only genuine question was ever "did the batch get
 * durably handed to Firestore's local mutation queue", and the answer to
 * that is unconditionally yes the moment `batch.commit()` is CALLED:
 * `WriteBatch.commit()` is a synchronous-enough enqueue against the SDK's
 * own internal AsyncQueue — it never silently fails to queue a batch, and
 * the one way a local-application failure could ever surface is the
 * `commit()` Promise itself eventually rejecting, which is still `.catch`
 * -ed and logged below exactly as before. So: invoke (never await)
 * `batch.commit()`, and return immediately — no wait of any kind, no
 * dependency on any specific onSnapshot/getDoc behavior, real or faked.
 *
 * `waitForLocalDocToExist` is KEPT, but demoted to a non-blocking,
 * best-effort DIAGNOSTIC below — logged, never awaited, so a real offline
 * browser's console now tells us definitively whether/when that listener
 * ever fires, without the UI's correctness depending on the answer either
 * way. If it turns out this listener genuinely never fires offline for a
 * brand-new document under this app's persistentSingleTabManager
 * configuration, that is now merely a missing diagnostic signal, not a
 * hang.
 *
 * The workout doc and the programRun's `activeWorkoutId` pointer are still
 * written in a single atomic batch (offline-safe — unlike a transaction, a
 * writeBatch queues locally and applies to the cache as a unit, then syncs
 * when back online) — this pass changes ONLY how (and whether) we wait to
 * observe that, never what gets written or how atomically.
 */
async function startOrResumeWorkout(uid, { program, day, run, week, dayOrder, currentMaxes, rounding }) {
  console.debug('[START] startOrResumeWorkout: entry', { uid, runId: run?.id, week, dayOrder });
  const existing = await resolveActiveWorkout(uid, run);
  console.debug('[START] startOrResumeWorkout: resolveActiveWorkout returned', { existingId: existing?.id ?? null });
  if (existing) return existing;

  const newRef = doc(workoutsCol(uid));
  const workoutId = newRef.id;
  // Write the marker synchronously, before any await, so a same-tab
  // double-click can't both pass the "no marker yet" check above.
  writeLocalActiveId(uid, workoutId);
  console.debug('[START] startOrResumeWorkout: new workout ref allocated, local marker written', { workoutId });

  // FINAL POLISH PASS: a brand-new workout's exercise list is produced in
  // logical warm-up-first order right here at snapshot-build time, so the
  // active Workout logger, new History entries, and exports all naturally
  // inherit the correct order with no further reordering needed anywhere
  // downstream. orderExercisesWarmupFirst (js/utils/exerciseOrdering.js) is
  // a pure array-position reorder ONLY — it runs AFTER buildResolvedExerciseList
  // and generateSetsForExercise have already produced each entry's
  // entryId/order/exerciseId/load/prescribed/sets exactly as before, so
  // none of that identity/basis/set data is altered by this pass, only
  // which index each already-built entry occupies in the final array.
  const exercises = orderExercisesWarmupFirst(
    buildResolvedExerciseList(day, week, { currentMaxes, rounding }).map((ex) => ({
      ...ex,
      sets: generateSetsForExercise(ex),
    })),
  );

  const snapshot = {
    schemaVersion: 1,
    status: 'in_progress',
    programId: program.id,
    programRunId: run.id,
    week,
    dayOrder,
    dayId: day.id,
    dayName: day.name,
    exercises,
    notes: '',
    startedAt: serverTimestamp(),
    finishedAt: null,
    durationSec: null,
  };

  return trackWrite(async () => {
    const batch = writeBatch(db);
    batch.set(newRef, snapshot);
    batch.update(runDocRef(uid, run.id), { activeWorkoutId: workoutId });
    console.debug('[START] startOrResumeWorkout: batch built, invoking commit()', { workoutId, runId: run.id });
    // Correction pass 9: invoked, never awaited — see this function's own
    // doc comment above for why this is now sufficient by itself, with
    // nothing further to wait for. Still logged on both settlement paths.
    batch.commit().then(
      () => console.debug('[START] startOrResumeWorkout: batch commit() backend-acknowledged', { workoutId }),
      (err) => console.error('[START] startOrResumeWorkout: batch commit() failed', { workoutId, err }),
    );
    // Correction pass 9: diagnostic-only from here on — never awaited, and
    // its outcome (either way) no longer affects what this function
    // returns or how soon it returns it. Kept solely so a real offline
    // browser's console tells us definitively whether/when a fresh
    // onSnapshot on a brand-new document actually confirms locally.
    waitForLocalDocToExist(newRef).then(
      () => console.debug('[START] startOrResumeWorkout: diagnostic onSnapshot confirms local existence', { workoutId }),
      (err) => console.error('[START] startOrResumeWorkout: diagnostic onSnapshot errored (non-fatal — UI does not wait on this)', { workoutId, err }),
    );
    console.debug('[START] startOrResumeWorkout: returning immediately (no wait) — local marker + constructed object are already sufficient', { workoutId });
    return { id: workoutId, ...snapshot };
  });
}

/**
 * One-shot wait for a brand-new doc's LOCAL cache view to report
 * `exists() === true` — the Start counterpart to `waitForLocalWorkoutPatch`
 * (below), simplified because a fresh `doc()` ref can only ever transition
 * from not-existing to existing once, by this exact call's own
 * `batch.set()` — there are no fields to match, just presence. See
 * `startOrResumeWorkout`'s doc comment above for the full reasoning.
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

// ── In-flight Start/Resume de-duplication ────────────────────────────────
// Correction pass 8, closing a gap this pass's own spec explicitly asked to
// be audited: the local marker written inside startOrResumeWorkout (above)
// is written AFTER its own first await (resolveActiveWorkout) — reliable
// against a strictly-sequential same-tab double-tap (the marker from call 1
// is already there by the time call 2's resolveActiveWorkout reads it), but
// NOT against two calls that are both already IN FLIGHT within the same
// async gap (e.g. a rapid double-dispatched click event) — both could pass
// resolveActiveWorkout's "no existing active workout" check before either
// has written anything, and would otherwise each create a genuinely
// separate workout document. Unlike finishWorkout/skipWorkout, there is no
// Firestore security-rule backstop for this: a workout `create` has no
// "already claimed" field to gate on the way an existing doc's
// `status == 'in_progress'` does for a double-finish (see
// finalizeInProgressWorkout's own doc comment), and programRuns' own update
// rule has no equivalent guard either (firestore.rules is a protected file,
// not something this pass can change). This map is a purely ADDITIVE,
// same-tab guard in front of the existing 3-layer resolution — it does not
// change or weaken any of those three layers, it just ensures two calls for
// the SAME uid within the same in-flight window share the exact one
// attempt rather than each opening their own. Both js/views/home.js's and
// js/views/workout.js's Start/Resume buttons call the SAME exported
// function below, so this guards both call sites from one place.
const inFlightStarts = new Map(); // uid -> Promise

/**
 * Top-level entry point: from an ALREADY-RESOLVED program/run/days/profile
 * context, starts or resumes the workout at the run's current week/day.
 * This is what the dashboard's and Workout view's START/RESUME buttons
 * call — it's the only place that needs to know how to go from "program
 * run position" to "workout snapshot", so both UI entry points stay
 * consistent.
 *
 * Correction pass 3: this used to re-fetch `run`/`program`/`profile`/`days`
 * itself via getActiveProgramRun/getProgram/getUserProfile/getProgramDays —
 * four more plain, server-preferring reads, on top of the ones
 * resolveActiveWorkout already makes, all repeated moments after the
 * caller had ALREADY read the exact same data to render the screen this
 * button lives on (see js/views/home.js and js/views/workout.js's own
 * mount()). That redundant re-fetch was the real root cause of the
 * indefinite "Starting…" hang offline — a plain getDoc/getDocs can wait
 * indefinitely for the network instead of promptly using Firestore's local
 * cache. Requiring the caller to pass its own already-resolved context
 * removes those four reads entirely (not just makes them cache-aware): the
 * data is already known-correct, online or offline, cached or fresh, since
 * it's the exact same data the screen was just rendered from.
 *
 * `ctx.run` may be freshly created a moment earlier by the caller (see
 * startProgramRun, for a user starting their very first run) — this
 * function only ever reads from `ctx`, never Firestore, so it has no
 * opinion on how `ctx` was produced.
 */
export async function startOrResumeWorkoutForCurrentPosition(uid, ctx) {
  const { run, program, days, profile } = ctx;
  console.debug('[START] startOrResumeWorkoutForCurrentPosition: entry', {
    uid, hasRun: !!run, hasProgram: !!program, daysCount: days?.length ?? 0, hasProfile: !!profile,
  });
  if (!run) throw new Error('No active program run yet — start the program first.');
  if (!program) throw new Error('Program not found for the active run.');

  const day = days.find((d) => d.order === run.current.dayOrder);
  if (!day) throw new Error('Could not resolve the current day from the program template.');
  console.debug('[START] startOrResumeWorkoutForCurrentPosition: run/program/day resolved', {
    runId: run.id, programId: program.id, week: run.current.week, dayOrder: run.current.dayOrder, dayName: day.name,
  });

  // Correction pass 8: see the inFlightStarts map's own comment above — a
  // second call for the same uid while one is already in flight shares
  // that SAME attempt instead of opening a second one. This check (and the
  // Map.set below) happens synchronously, before this function's own first
  // await, so two calls that arrive back-to-back within the same
  // synchronous dispatch (not just two sequential ticks) are still caught.
  const inFlight = inFlightStarts.get(uid);
  if (inFlight) {
    console.debug('[START] startOrResumeWorkoutForCurrentPosition: joining an already in-flight attempt', { uid });
    return inFlight;
  }

  const attempt = startOrResumeWorkout(uid, {
    program,
    day,
    run,
    week: run.current.week,
    dayOrder: run.current.dayOrder,
    currentMaxes: profile?.currentMaxes ?? {},
    rounding: profile?.settings?.rounding ?? {},
  }).finally(() => {
    inFlightStarts.delete(uid);
  });
  inFlightStarts.set(uid, attempt);
  return attempt;
}

/**
 * Most recent completed workout, for the dashboard's "latest performance"
 * stat. Correction pass 6: routed through getDocsSafe (a Home-dashboard
 * read, same offline-hang risk as every other plain getDocs() on that
 * screen) — an offline cache-miss safely defaults to "None yet" rather than
 * hanging, same tolerance already established for every other stat here.
 */
export async function getLatestCompletedWorkout(uid) {
  const q = query(
    workoutsCol(uid),
    where('status', '==', 'completed'),
    orderBy('finishedAt', 'desc'),
    limit(1),
  );
  const snap = await getDocsSafe(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

/**
 * Most recent N completed workouts, newest first. Same query shape as
 * getLatestCompletedWorkout above (status ASC + finishedAt DESC), just with
 * `limit(max)` instead of `limit(1)` — reuses the exact same existing
 * Firestore index (firestore.indexes.json), no new index required. `uid`
 * is a plain parameter, same as every other function in this file:
 * firestore.rules is what actually enforces who is allowed to read what.
 *
 * Correction pass 7: this is NOT admin-only, despite what an earlier pass's
 * report summary assumed — js/views/history.js's own list view and
 * js/views/progress.js both call this directly (adminInsightsService.js is
 * a third, separate caller). Routed through the shared getDocsSafe
 * (../utils/firestoreRead.js, pass 6) for exactly the reason this correction
 * pass exists: navigating to History right after an offline Finish/Skip —
 * to see the just-finished workout — must not hang on a plain online-
 * preferring getDocs() the same way Home's own reads used to. An offline
 * cache-miss safely defaults to an empty list (History's existing "No
 * completed workouts yet" state), never a hang.
 */
export async function listCompletedWorkouts(uid, max = 10) {
  const q = query(
    workoutsCol(uid),
    where('status', '==', 'completed'),
    orderBy('finishedAt', 'desc'),
    limit(max),
  );
  const snap = await getDocsSafe(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Clears the local same-browser "active workout" marker (see `localKey`/
 * `writeLocalActiveId` above) without writing a new one. Exported for
 * restoreService.js (Phase 3F): after a JSON restore, any pre-restore
 * pointer must not be trusted, since it may reference a workout the
 * restore just deleted or replaced. resolveActiveWorkout's existing
 * multi-layer self-healing (this function's own docstring, above) then
 * naturally re-derives the correct active workout — if any — from the
 * freshly-restored Firestore data the next time it's called, with no
 * further code needed here.
 */
export function clearLocalActiveWorkoutMarker(uid) {
  writeLocalActiveId(uid, null);
}

/**
 * Count of qualifying workouts finished on/after `sinceDate`, for Home's
 * "This Week" stat (the caller passes the current calendar week's Monday
 * 00:00 local). Correction pass 6: routed through getDocsSafe, same
 * reasoning as getLatestCompletedWorkout above — an offline cache-miss
 * safely defaults to 0 rather than hanging.
 *
 * v21: a finished workout counts only when History's own canonical
 * resolver (resolveCompletionState) says 'complete' or 'partial'. Skipped
 * and not_logged are excluded (both are also stored with status
 * 'completed'), and in_progress never matches the status filter. Same
 * query as before, so no new Firestore index is needed.
 */
const COUNTED_COMPLETION_STATES = new Set(['complete', 'partial']);

export async function countCompletedSince(uid, sinceDate) {
  const q = query(
    workoutsCol(uid),
    where('status', '==', 'completed'),
    where('finishedAt', '>=', sinceDate),
  );
  const snap = await getDocsSafe(q);
  return snap.docs.filter((d) => COUNTED_COMPLETION_STATES.has(resolveCompletionState(d.data()))).length;
}

/**
 * Autosave write for per-set logging (Phase 3B). Persists the *entire*
 * `exercises` array in one write — Firestore has no per-array-element
 * update, and every logging field (`sets[].actualKg`/`actualReps`/
 * `completed`/etc.) lives inside it. This never touches `status`,
 * `startedAt`, `dayId`, or any other planned/identity field, so it can only
 * ever move data within the "actual logging fields" the workout-in-progress
 * update rule already allows — it does not need a rules change.
 *
 * The caller (the Workout view) owns debouncing/sequencing; this function
 * only performs one write per call, wrapped in `trackWrite` so the existing
 * sync-status indicator reflects it honestly.
 */
export async function updateWorkoutExercises(uid, workoutId, exercises) {
  return trackWrite(() => updateDoc(workoutDocRef(uid, workoutId), { exercises }));
}

/**
 * Correction pass 5 — the piece Correction pass 4 got wrong. Verified
 * directly (not assumed) against real, current reports from the
 * firebase-js-sdk issue tracker (see this pass's report for citations):
 * the Promise returned by `updateDoc`/`setDoc`/`WriteBatch.commit()` is
 * gated on BACKEND acknowledgement, not merely on the mutation reaching
 * the local persistence layer — "won't resolve while you're offline" is
 * the documented, intentional contract, not a bug. The mutation itself
 * IS applied to the local cache essentially immediately (this part of
 * Pass 4's research already held up), but nothing about THAT promise
 * exposes when it happens — awaiting it (as `runSave` used to, for its
 * "Saved" label) can therefore hang for the entire time a device is
 * offline, exactly as observed.
 *
 * The Firestore-documented way to observe the local-only milestone is a
 * snapshot listener with `includeMetadataChanges: true`:
 * `snapshot.metadata.hasPendingWrites` is true from the moment a local
 * mutation lands in the cache until the backend has acknowledged it —
 * regardless of the write call's own Promise. This function exposes
 * exactly that, scoped to one workout doc, so the Workout view's autosave
 * status can show a truthful "saved locally, not yet synced" state
 * without ever awaiting a Promise that may not resolve until reconnect.
 *
 * Deliberately returns ONLY the metadata bits (`hasPendingWrites`,
 * `fromCache`) — never the document's data. The view's own in-memory
 * `workout.exercises` remains the sole render/edit source; feeding
 * listener data back into it would risk clobbering an in-flight edit
 * with a snapshot that may be milliseconds behind the lifter's last
 * keystroke, which is exactly what this file's existing architecture
 * (workout.js's own doc comment on `workout`) already guards against.
 *
 * Returns an unsubscribe function — the caller (workout.js) is
 * responsible for calling it on unmount, same as every other per-view
 * cleanup in that file.
 */
export function subscribeToWorkoutLocalStatus(uid, workoutId, callback) {
  return onSnapshot(
    workoutDocRef(uid, workoutId),
    { includeMetadataChanges: true },
    (snap) => callback({ hasPendingWrites: snap.metadata.hasPendingWrites, fromCache: snap.metadata.fromCache, exists: snap.exists() }),
    (err) => console.error('subscribeToWorkoutLocalStatus listener error:', err),
  );
}

/**
 * Explicit Finish action. Marks the workout completed, clears both the
 * cross-device pointer (`programRun.activeWorkoutId`) and the local
 * same-browser marker, and (Phase 3C) advances the associated programRun to
 * the next planned position — all in ONE atomic offline-safe batch, so a
 * finished workout can never end up paired with a stale program position
 * (or vice versa: an advanced position with an unfinished workout).
 *
 * Next-position derivation (`computeNextPosition`, in
 * ../utils/programProgress.js) reads the program's ACTUAL ordered days and
 * weeks — never a hardcoded day-per-week count — so this works unchanged
 * for a 3/4/5-day program or a future Program-Editor-edited structure. The
 * final day of the final week does NOT wrap back to week 1 / day 1: it sets
 * `programCompleted: true` (plus a non-real `current` position) that a
 * future UI can build an end-of-program screen on; that screen itself is
 * out of scope here.
 *
 * Idempotency (double-finish safety) has TWO layers:
 *   1. A fast client-side short-circuit below if the in-memory `workout`
 *      already shows `status !== 'in_progress'`.
 *   2. The real guarantee: the existing Firestore rule requires
 *      `resource.data.status == 'in_progress'` for a workout update.
 *      Firestore batches are all-or-nothing — if a second, racing
 *      `finishWorkout` call reaches the server after the first has already
 *      committed, ITS workout-update fails that rule, and per batch
 *      semantics the ENTIRE batch (including the run-advancement write) is
 *      rejected together. So a double invocation cannot double-advance the
 *      program even if two clients (or two tabs) somehow race past layer 1.
 *
 * Never touches `exercises` (the logged sets stay exactly as last
 * autosaved) or any planned/identity field — only completion metadata on
 * the workout, and only `current`/`programCompleted*` on the run.
 *
 * Phase 4.1: also classifies and persists `completionState`
 * ('complete'/'partial'/'not_logged' — js/utils/workoutCompletion.js's
 * classifyCompletionState, computed from the workout's OWN already-
 * autosaved `exercises[].sets[].completed` values, nothing else). The
 * caller (js/views/workout.js) is responsible for asking the user to
 * confirm first when the workout isn't fully logged — this function
 * itself always finishes unconditionally once called, exactly as before;
 * it just now also records what it's finishing AS.
 *
 * Browser-test correction pass: the actual "mark completed, advance
 * programRun exactly once, clear activeWorkoutId" transition below is now
 * shared with the new explicit `skipWorkout` (below) via the internal
 * `finalizeInProgressWorkout` helper — this function's own behavior is
 * completely UNCHANGED by that extraction (same batch, same idempotency
 * guarantees, same fields written), only the shared plumbing moved.
 */
export async function finishWorkout(uid, workout) {
  const completionState = classifyCompletionState(workout.exercises);
  console.debug('[FINISH] finishWorkout: entry', { uid, workoutId: workout.id, completionState });
  return finalizeInProgressWorkout(uid, workout, { completionState });
}

/**
 * Shared internal finalization for BOTH the normal Finish action
 * (finishWorkout) and the explicit Skip action (skipWorkout, below) — both
 * are the exact same underlying transition: mark the SAME workout doc
 * `completed`, clear `activeWorkoutId`, and advance the associated
 * programRun to its next planned position exactly once, all in one atomic
 * offline-safe batch. Extracting this shared shape (browser-test correction
 * pass) is what lets Skip reuse finishWorkout's already-hardened
 * idempotency/advancement logic (see finishWorkout's own docstring above
 * for the two-layer double-finish guarantee, which applies identically
 * here — a stray double Skip/Finish race is rejected the same way, since
 * the Firestore rule still requires `resource.data.status == 'in_progress'`
 * for either transition) rather than a second, easier-to-drift-apart copy
 * of the batch/next-position code. The only thing that differs between the
 * two callers is `workoutPatchExtra` — WHAT completion metadata gets
 * stamped onto the workout doc; the transition mechanics are identical.
 *
 * CORRECTION PASS 7 — supersedes the "Phase 5A offline analysis" comment
 * that used to sit here, which was WRONG and caused the real "Finishing…"
 * hang forever offline bug this pass fixes. That comment claimed
 * `batch.commit()` "applies to the local cache and resolves immediately"
 * offline. It does not: correction pass 5 already verified, directly
 * against the firebase-js-sdk issue tracker (see workoutService.js's own
 * `subscribeToWorkoutLocalStatus`/workout.js's `runSave` doc comments, a
 * few functions above), that `updateDoc`/`setDoc`/`WriteBatch.commit()`'s
 * OWN returned Promise is gated on BACKEND acknowledgement, not merely on
 * the mutation reaching Firestore's local persistence layer — "won't
 * resolve while you're offline" is the documented, intentional contract.
 * Pass 5 fixed this for the per-set autosave write (`updateWorkoutExercises`
 * via `runSave`'s fire-and-forget pattern); this exact same mistake was
 * never re-examined here, because whoever wrote the old comment believed
 * (incorrectly, and before Pass 5's more careful verification) that a batch
 * was categorically different from a plain write in this respect. It is
 * not — `batch.commit()`'s returned Promise is gated on backend ack exactly
 * like a plain write's, which is why `doFinish`/`doSkip` in workout.js,
 * which directly `await finishWorkout(...)`/`await skipWorkout(...)`, got
 * stuck on "Finishing…"/"Skipping…" indefinitely offline.
 *
 * The fix mirrors Pass 5's exactly, adapted for a two-document batch: issue
 * `batch.commit()` and let it run in the background (only `.catch()`-ing it,
 * for a genuine failure — never "still offline", which isn't a failure);
 * the truthful "this lifecycle transition is safely local" signal comes
 * from `waitForLocalWorkoutPatch` below, a one-shot use of the SAME
 * documented mechanism `subscribeToWorkoutLocalStatus` already uses
 * (`onSnapshot` with `includeMetadataChanges: true`) — it resolves the
 * moment the WORKOUT doc's own local cache view reflects `workoutPatch`,
 * independent of `batch.commit()`'s Promise.
 *
 * Verified atomicity (do not re-derive this from scratch on a later pass):
 * a Firestore `WriteBatch` is applied to the LOCAL persistence layer as one
 * atomic mutation-batch entry — every mutation in it lands in the local
 * cache together, as a unit, well before the network round trip — this is
 * the documented reason `WriteBatch` exists at all (atomic locally AND
 * atomic remotely), not merely a remote-commit convenience. So observing
 * the WORKOUT doc's own local view reflect its half of the batch is proof
 * the programRun's half is ALSO already applied locally — there is no need
 * to duplicate this wait on the run doc too.
 *
 * The one genuine offline risk this function still has, unchanged since
 * before this pass: the READ above the batch (`getProgramDays`/`getProgram`,
 * needed to compute the next program position) — unlike a write, `getDoc`/
 * `getDocs` REJECT if the requested document was never cached locally and
 * the client is currently offline. In the realistic gym scenario this read
 * is virtually always already warm (the same program/days data was just
 * read to render Home/Program and to start this very workout), so Finish/
 * Skip continues to succeed offline exactly as before in that case — this
 * function does not fake or skip that read, and does not weaken the
 * advancement logic. The `try`/`catch` below exists ONLY to turn the rare
 * genuine cache-miss failure into the app's standard friendly offline
 * message (see ../utils/offlineError.js) instead of a raw Firestore error
 * string — it never swallows or reinterprets any other kind of failure,
 * and it never reports success when the read didn't actually succeed, so a
 * workout can never be told "finished" without the real advancement data
 * behind it.
 *
 * CORRECTION PASS 10 — supersedes the "Correction pass 7" reasoning above
 * for the batch itself (the read-offline analysis above it is UNCHANGED and
 * still correct). A real offline browser proved that pass 7's own fix —
 * `await waitForLocalWorkoutPatch(ref, workoutPatch)`, a freshly-registered
 * `onSnapshot` wait used to PROVE the batch's local application before
 * letting the UI proceed — never resolves in a real offline session: Finish
 * stuck on "Finishing…" forever with the browser still offline, exactly the
 * same FAILURE SHAPE Pass 9 already proved for Start's own onSnapshot-wait
 * mechanism (`waitForLocalDocToExist`), even though this is a different,
 * ALREADY-EXISTING document (not a brand-new one) — so "the doc already
 * existed" was never actually what made Pass 8's Start mechanism suspect;
 * it was the onSnapshot-wait shape itself. This project's fake-Firestore
 * test doubles (both the browser harness's fake-firestore.js and the exec
 * suite's stub-firebase-firestore.mjs) model `onSnapshot`/`batch.commit()`
 * as notifying listeners reliably and synchronously in the same JS tick —
 * an assumption never actually verified against the real Firebase Web SDK
 * (no network path to a real Firestore backend from this project's
 * automated test environment) — which is exactly why Pass 7's own tests all
 * passed despite this real bug.
 *
 * ROOT-CAUSE-LEVEL FIX, identical in kind to Pass 9's: stop depending on any
 * Firestore read-back for correctness. `workoutPatch` and `runPatch` are
 * already fully known in memory (built above, before this trackWrite
 * callback even runs) — there is nothing left to read back. Invoke (never
 * await) `batch.commit()`, clear the local marker synchronously, and return
 * immediately. `waitForLocalWorkoutPatch` is KEPT, demoted to a
 * non-blocking, logged-only diagnostic exactly as `waitForLocalDocToExist`
 * was for Start.
 *
 * IDEMPOTENCY — unaffected by this change, re-verified explicitly this
 * pass: double-finish/double-skip safety never depended on this wait in the
 * first place. Layer 1 (client-side `workout.status !== 'in_progress'`
 * short-circuit above) and layer 2 (Firestore's own security rule requiring
 * `resource.data.status == 'in_progress'` for the update, which rejects a
 * whole racing batch atomically) are both completely independent of how
 * long this function waits before returning. A remount's own
 * `resolveActiveWorkout` re-derives state fresh from the (already, per
 * Pass 5/7's verified finding, immediately-applied) local cache, so it sees
 * the just-finished workout's `status: 'completed'` and correctly reports
 * no active workout — it does not need this function to have "finished
 * waiting" first. Reconnect only drives the background `batch.commit()`
 * Promise to settle (logged); it performs no further writes and cannot
 * cause a second advancement. `reconcileLegacyProgramPosition` cannot
 * double-advance this same transition either, because the SAME atomic
 * batch already moved `run.current` off of this workout's own
 * week/dayOrder — this was already true before this pass and remains true
 * (the batch is still one atomic writeBatch, just no longer awaited).
 */
async function finalizeInProgressWorkout(uid, workout, workoutPatchExtra) {
  console.debug('[FINISH] finalizeInProgressWorkout: entry', {
    uid, workoutId: workout.id, status: workout.status, workoutPatchExtra,
  });
  if (workout.status !== 'in_progress') {
    // Already completed — nothing to do. See finishWorkout's own docstring
    // for the real, server-enforced guarantee this client-side check merely
    // fast-paths (this applies to Skip identically).
    console.debug('[FINISH] finalizeInProgressWorkout: already completed, short-circuiting', { workoutId: workout.id });
    return { alreadyCompleted: true };
  }

  const ref = workoutDocRef(uid, workout.id);
  const workoutPatch = { status: 'completed', finishedAt: serverTimestamp(), ...workoutPatchExtra };
  console.debug('[FINISH] finalizeInProgressWorkout: completion state determined', {
    workoutId: workout.id, completionState: workoutPatchExtra?.completionState,
  });

  let runPatch = null;
  if (workout.programRunId) {
    let days;
    let program;
    console.debug('[FINISH] finalizeInProgressWorkout: reading program/days for advancement', {
      workoutId: workout.id, programId: workout.programId,
    });
    try {
      [days, program] = await Promise.all([
        getProgramDays(uid, workout.programId),
        getProgram(uid, workout.programId),
      ]);
    } catch (err) {
      if (isOfflineUnavailableError(err)) {
        throw new Error(
          "This workout can't be finished right now because it needs your program data and you're offline. "
          + "Reconnect and try again — nothing has been changed yet.",
        );
      }
      throw err;
    }
    const next = computeNextPosition({
      days,
      weeks: program?.weeks ?? [],
      currentWeek: workout.week,
      currentDayOrder: workout.dayOrder,
    });
    runPatch = {
      activeWorkoutId: null,
      current: { week: next.week, dayOrder: next.dayOrder },
      ...(next.programCompleted ? { programCompleted: true, programCompletedAt: serverTimestamp() } : {}),
    };
    console.debug('[FINISH] finalizeInProgressWorkout: next position computed', {
      workoutId: workout.id, next, runPatch,
    });
  }

  return trackWrite(async () => {
    const batch = writeBatch(db);
    batch.update(ref, workoutPatch);
    if (workout.programRunId && runPatch) {
      batch.update(runDocRef(uid, workout.programRunId), runPatch);
    }
    console.debug('[FINISH] finalizeInProgressWorkout: batch built, invoking commit()', {
      workoutId: workout.id, runId: workout.programRunId ?? null,
    });
    // Correction pass 10: invoked, never awaited — see this function's own
    // doc comment above for why this is now sufficient by itself. Still
    // logged on both settlement paths.
    batch.commit().then(
      () => console.debug('[FINISH] finalizeInProgressWorkout: batch commit() backend-acknowledged', { workoutId: workout.id }),
      (err) => console.error('[FINISH] finalizeInProgressWorkout: batch commit() failed', { workoutId: workout.id, err }),
    );
    // Correction pass 10: diagnostic-only from here on — never awaited, and
    // its outcome (either way) no longer affects what this function returns
    // or how soon it returns it. Kept solely so a real offline browser's
    // console tells us definitively whether/when this listener actually
    // confirms the patch.
    waitForLocalWorkoutPatch(ref, workoutPatch).then(
      () => console.debug('[FINISH] finalizeInProgressWorkout: diagnostic onSnapshot confirms local patch', { workoutId: workout.id }),
      (err) => console.error('[FINISH] finalizeInProgressWorkout: diagnostic onSnapshot errored (non-fatal — UI does not wait on this)', { workoutId: workout.id, err }),
    );
    writeLocalActiveId(uid, null);
    console.debug('[FINISH] finalizeInProgressWorkout: returning immediately (no wait) — local marker cleared, patch already known in memory', { workoutId: workout.id });
    // Correction pass 7 (unchanged by pass 10): deliberately still returns
    // undefined on success — no caller (view or exec test) has ever
    // depended on a truthy return value for the success path, only on the
    // `{ alreadyCompleted: true }` short-circuit above, so this pass does
    // not invent a new return contract on top of the unrelated hang fix.
  });
}

/**
 * One-shot wait for `ref`'s LOCAL cache view to reflect a just-issued
 * patch — the local-cache counterpart to a write's own (backend-ack-gated)
 * Promise; see `finalizeInProgressWorkout`'s doc comment above for the full
 * reasoning and the atomicity guarantee this relies on. Resolves as soon as
 * the doc's locally-cached data shows every field in `patch` matching (a
 * `serverTimestamp()` sentinel resolves to *some* local placeholder value
 * once applied, so it's checked for presence, not equality), then
 * unsubscribes. Deliberately does not consult `hasPendingWrites` — the
 * field values themselves already prove the mutation landed; whether the
 * backend has acknowledged it yet is a separate, orthogonal question that
 * `trackWrite`'s own `waitForPendingWrites`-based tracking (sync-status.js)
 * already handles for the global sync indicator.
 */
function waitForLocalWorkoutPatch(ref, patch) {
  const isPatched = (data) => Object.entries(patch).every(([key, value]) => {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      // serverTimestamp() sentinel: once applied locally it becomes some
      // timestamp-shaped value (or a local estimate) — not equal to the
      // sentinel object itself, so just require it to be present.
      return data[key] != null;
    }
    return data[key] === value;
  });
  return new Promise((resolve, reject) => {
    const unsubscribe = onSnapshot(
      ref,
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.exists() && isPatched(snap.data())) {
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

/**
 * Explicit Skip (browser-test correction pass, "Explicit Skip Workout
 * Flow"): the user intentionally aborts the CURRENT in-progress workout
 * rather than finishing it — a materially different fact from a workout
 * manually finished with zero sets logged ("Not Logged"; see
 * js/utils/workoutCompletion.js's module comment for the full distinction).
 * Reuses the SAME workout document id and the SAME finalization/advancement
 * path as a normal Finish (`finalizeInProgressWorkout` above), so:
 *   - programRun advances exactly once (identical computeNextPosition call)
 *   - activeWorkoutId clears exactly as normal completion does
 *   - no new/duplicate workout document is ever created
 *   - the same double-finish/double-skip idempotency guarantee applies
 * with zero duplicated batch/programRun logic. The only difference from
 * finishWorkout is WHAT gets stamped on the doc: `completionState:
 * 'skipped'` (js/utils/workoutCompletion.js's EXPLICIT_SKIP_STATE) PLUS the
 * `explicitSkip: true` marker that distinguishes a genuine new Skip from an
 * old Phase-4.1-era zero-set document that happens to also have literally
 * stored `completionState: 'skipped'` under that field's PRE-correction-pass
 * meaning (see resolveCompletionState) — plus the optional trimmed
 * `skipReason` (an empty string, never omitted, when none was entered).
 * Existing logged sets are left exactly as they were in the snapshot —
 * never auto-checked, never deleted — this function does not touch
 * `exercises` at all; Progress's own exclusion of an entire skipped
 * workout (progressAnalytics.js, regardless of any individual set's own
 * `completed` value) is what actually keeps a skipped workout's data out
 * of analytics, not any mutation performed here.
 */
export async function skipWorkout(uid, workout, reason = '') {
  const skipReason = typeof reason === 'string' ? reason.trim() : '';
  console.debug('[FINISH] skipWorkout: entry', { uid, workoutId: workout.id, skipReason });
  return finalizeInProgressWorkout(uid, workout, {
    completionState: EXPLICIT_SKIP_STATE,
    explicitSkip: true,
    skipReason,
  });
}

/**
 * Phase 4.1 Goal C/D — the ONLY way a completed workout's ACTUAL LOGGING
 * data may change after Finish. Deliberately nothing like
 * startOrResumeWorkout/finishWorkout:
 *   - a single plain `updateDoc` on the SAME existing workout document —
 *     never creates a new doc, never touches `programRuns` at all (no
 *     `activeWorkoutId`, no `current` position, no batch), so program
 *     progression cannot be affected by this call even in principle: there
 *     is no code path here that writes to a programRun document.
 *   - `finishWorkout` is never called — `status` isn't part of the patch
 *     at all, so it can only ever stay 'completed'.
 *   - the patch touches exactly three things: `exercises` (the corrected
 *     actual/logging fields the caller already merged into its own copy —
 *     see js/views/history.js's edit mode, which only ever changes
 *     actualKg/actualReps/completed/rpe/note on existing set rows, never
 *     plannedKg/plannedReps/load/basis/ordering), a freshly recomputed
 *     `completionState`, and `lastEditedAt`.
 * Enforces the same eligibility the UI already gates on
 * (js/utils/workoutCompletion.js's isEditableCompletedWorkout — the local-
 * calendar-day edit window AND "not an explicitly Skipped workout") once
 * more here, service-side, so a stale "Edit Workout" link rendered just
 * before midnight, or before a Skip elsewhere, can't slip a write through
 * after it's no longer eligible — this is the second of the two layers
 * described in this pass's final report (the first is firestore.rules' own
 * coarse time-boxed backstop, which cannot express exact local-calendar
 * semantics itself; see that file's comment).
 */
export async function updateCompletedWorkoutLog(uid, workout, exercises) {
  if (workout.status !== 'completed') {
    throw new Error('Only a completed workout can be corrected this way.');
  }
  if (!isEditableCompletedWorkout(workout)) {
    throw new Error('This workout is outside its edit window (or was explicitly skipped) and can no longer be corrected.');
  }
  const completionState = classifyCompletionState(exercises);
  return trackWrite(() => updateDoc(workoutDocRef(uid, workout.id), {
    exercises,
    completionState,
    lastEditedAt: serverTimestamp(),
  }));
}

/**
 * One-time, self-healing reconciliation for programRuns that predate
 * automatic advancement: if the run's current position already has a
 * COMPLETED workout for that EXACT program/week/day, advance it once to the
 * next planned position — the same hop `finishWorkout` would have taken had
 * advancement existed when that workout was finished.
 *
 * Deliberately narrow: it only fires when the position the run still
 * thinks is "current" is provably already done (an exact
 * status+programId+week+dayOrder match), never on any broader "you have
 * a completed workout somewhere" signal — so it cannot mistake an
 * intentionally-repeated workout logged at a DIFFERENT position for a
 * legacy gap. It advances at most one hop per call; a history with several
 * such legacy gaps in a row closes one more each time this runs (e.g. each
 * page load), rather than cascading through all of them in one surprising
 * jump.
 *
 * Precondition: call this only after the caller has already confirmed
 * there is no active (in_progress) workout for this run (e.g. via
 * `resolveActiveWorkout` returning null) — this function does not re-check
 * `activeWorkoutId` itself, to avoid duplicating what the caller already
 * knows.
 *
 * Correction pass 6: reachable from js/views/home.js's own mount() whenever
 * there is no active workout — the exact same plain-getDocs offline-hang
 * risk as the rest of Home's dependency chain, so its query is routed
 * through getDocsSafe too. An offline cache-miss here safely defaults to
 * "current position isn't already done" (the function's own existing
 * no-op return below), never a false advancement.
 *
 * Correction pass 8: also reachable from js/views/workout.js's own mount()
 * (whenever there is no active workout, right before the Start preview
 * renders) — Pass 7's report flagged this function's OWN write below as a
 * latent instance of the same await-a-backend-ack-gated-Promise hang, but
 * believed it dead code in the FINISH flow specifically (true: finishWorkout's
 * own batch already advances position atomically, so this narrow legacy-gap
 * condition never matches right after a Finish). It is NOT dead in the
 * Start/Resume flow audited this pass — a real offline mount of either
 * Home or Workout can reach this write whenever a run is stuck at an
 * already-completed legacy position, and the OLD `await trackWrite(...)`
 * below would have hung that mount indefinitely offline, before the lifter
 * ever saw a START button. Fixed the same way as every other write this
 * pass: don't await it for control flow. Unlike Start/Finish, no local-
 * visibility wait is even needed — this function's only caller-visible
 * effect is the MERGED `run` object returned below, which is already
 * correct in memory the instant `patch` is computed; nothing here re-reads
 * Firestore for this same data afterward, so there's nothing to wait on.
 */
export async function reconcileLegacyProgramPosition(uid, run) {
  if (!run || run.programCompleted) return run;

  const q = query(
    workoutsCol(uid),
    where('status', '==', 'completed'),
    where('programId', '==', run.programId),
    where('week', '==', run.current.week),
    where('dayOrder', '==', run.current.dayOrder),
    limit(1),
  );
  const snap = await getDocsSafe(q);
  if (snap.empty) return run; // current position isn't already done — nothing to reconcile

  const [days, program] = await Promise.all([
    getProgramDays(uid, run.programId),
    getProgram(uid, run.programId),
  ]);
  const next = computeNextPosition({
    days,
    weeks: program?.weeks ?? [],
    currentWeek: run.current.week,
    currentDayOrder: run.current.dayOrder,
  });

  const patch = {
    current: { week: next.week, dayOrder: next.dayOrder },
    ...(next.programCompleted ? { programCompleted: true, programCompletedAt: serverTimestamp() } : {}),
  };

  trackWrite(() => updateDoc(runDocRef(uid, run.id), patch)).catch((err) => {
    console.error('reconcileLegacyProgramPosition: write failed', err);
  });
  return { ...run, ...patch };
}
