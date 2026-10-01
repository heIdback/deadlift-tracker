// Admin "Reset training data" — server-side core (Cloud Functions, Admin SDK).
// Pure logic with injected dependencies so the exact same code is unit-tested
// in Node and in the browser harness; functions/index.js only wires it to
// firebase-functions + firebase-admin.
//
// AUTHORIZATION (every check is done here, on the server, from Firestore —
// nothing the client sends about roles is trusted):
//   1. request.auth present                      → else unauthenticated
//   2. /access/{callerUid}: status 'approved' AND role 'admin'
//                                                → else permission-denied
//   3. data is exactly {targetUid, confirmation}; targetUid is a well-formed
//      uid and /access/{targetUid} exists       → else invalid-argument / not-found
//   4. confirmation === expectedConfirmation(target) ("RESET <email or uid>")
//                                                → else failed-precondition
//   Self-reset by an admin is allowed (the access model has no rule against it).
//
// WHAT IS RESET for users/{targetUid}:
//   deleted: workouts (every status), maxes (1RM history), measurements,
//            records, progressionSuggestions, programRuns
//   profile: currentMaxes := {}  → the existing onboarding gate
//            (userService.getMissingRequiredMaxes) asks the user for their
//            current 1RMs at next sign-in — the same state as a fresh account.
//            No 1RM value is invented, and currentOneRepMaxesAtImport is never
//            used.
//   run:     if an active program existed (and still exists), ONE fresh run
//            for it at Week 1 / its first day (same rule as
//            starterProgram.pickStarterPosition).
// PRESERVED: Firebase Auth user, /access (status/role), profile identity,
//   settings, trainingProfile, every program + its days (imported or not),
//   nutrition (reserved, not training state), other users, rules/config.
//
// NOT ATOMIC — and does not claim to be. Firestore batches are limited to 500
// writes, so deletions run in bounded batches. Safety comes from:
//   - a per-target lock doc (adminResets/{targetUid}, server-only path) taken
//     in a transaction → two resets of the same user can't run at once;
//   - idempotency: deleting an already-deleted doc is a no-op, and the final
//     step (runs + profile + generation) is one batch, so a
//     retry after any failure simply finishes the job;
//   - a verification pass: success is returned ONLY if every reset collection
//     is empty afterwards (except the one new run). Otherwise the call fails,
//     the lock records 'incomplete', and the admin is told to run it again.
//
// STALE DEVICES (v22 hardening): every successful reset gives the user a NEW
// training generation — users/{uid}.trainingGeneration := random token — and
// swaps the generation sentinel doc
// (progressionSuggestions/__training-generation-<token>) in the same final
// batch. The client commits every training write together with
// `update(<its generation's sentinel>)`, so a device still holding pre-reset
// state (open tab, offline queue, cached app) has every such write rejected
// by Firestore itself. Model: js/utils/trainingGeneration.js (constants
// below must match it — pinned by tests/unit/trainingGeneration.test.mjs).
// The new program run also gets a per-reset id, so no pre-reset run id ever
// exists again.

export const RESET_COLLECTIONS = ['workouts', 'maxes', 'measurements', 'records', 'progressionSuggestions'];
export const RESET_RUN_PREFIX = 'reset-run-';
export const resetRunId = (generation) => `${RESET_RUN_PREFIX}${generation}`;
export const INITIAL_GENERATION = 'initial';
export const GENERATION_SENTINEL_COLLECTION = 'progressionSuggestions';
export const GENERATION_SENTINEL_PREFIX = '__training-generation-';
export const generationSentinelId = (generation) => `${GENERATION_SENTINEL_PREFIX}${generation}`;
const isSentinelId = (id) => typeof id === 'string' && id.startsWith(GENERATION_SENTINEL_PREFIX);
const GENERATION_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
export function generationOf(profile) {
  const g = profile?.trainingGeneration;
  return typeof g === 'string' && GENERATION_TOKEN.test(g) ? g : INITIAL_GENERATION;
}
const defaultNewGeneration = () => globalThis.crypto.randomUUID().replace(/-/g, '');
export const BATCH_SIZE = 400;
export const LOCK_TTL_MS = 10 * 60 * 1000;
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class ResetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The exact string the admin must type — derived on the server from the target's own access record. */
export function expectedConfirmation(targetAccess, targetUid) {
  const email = typeof targetAccess?.email === 'string' ? targetAccess.email.trim() : '';
  return `RESET ${email || targetUid}`;
}

function validateRequest(request) {
  if (!request?.auth?.uid) throw new ResetError('unauthenticated', 'Sign in required.');
  const data = request.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ResetError('invalid-argument', 'Malformed request.');
  const keys = Object.keys(data).sort();
  if (keys.join(',') !== 'confirmation,targetUid') throw new ResetError('invalid-argument', 'Malformed request.');
  if (typeof data.targetUid !== 'string' || !UID_PATTERN.test(data.targetUid)) throw new ResetError('invalid-argument', 'Invalid user id.');
  if (typeof data.confirmation !== 'string') throw new ResetError('invalid-argument', 'Malformed request.');
  return { callerUid: request.auth.uid, targetUid: data.targetUid, confirmation: data.confirmation };
}

/** Deletes every doc in `path`; returns how many user records were removed (generation sentinels are bookkeeping, not counted). */
async function deleteAll(db, path) {
  let deleted = 0;
  for (let guard = 0; guard < 10000; guard += 1) {
    const snap = await db.collection(path).limit(BATCH_SIZE).get();
    if (snap.empty) return deleted;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.docs.filter((d) => !isSentinelId(d.id)).length;
  }
  throw new ResetError('internal', `Too many documents in ${path}.`);
}

function millis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return 0;
}

/**
 * @param {{ db, serverTimestamp: () => any, now?: () => number }} deps
 *   db: Admin-SDK-shaped Firestore (doc/collection/batch/runTransaction).
 * @returns {(request: {auth?: {uid}, data}) => Promise<object>}
 */
export function createResetHandler({ db, serverTimestamp, now = () => Date.now(), newGeneration = defaultNewGeneration }) {
  return async function adminResetUserFitness(request) {
    const { callerUid, targetUid, confirmation } = validateRequest(request);

    // (2) caller must be an approved admin — from /access, never from the request.
    const callerAccess = (await db.doc(`access/${callerUid}`).get()).data();
    if (!callerAccess || callerAccess.status !== 'approved' || callerAccess.role !== 'admin') {
      throw new ResetError('permission-denied', 'Only an approved admin can reset training data.');
    }
    // (3) target must be a known app user.
    const targetAccess = (await db.doc(`access/${targetUid}`).get()).data();
    if (!targetAccess) throw new ResetError('not-found', 'That user does not exist.');
    // (4) typed confirmation, re-checked server-side (a direct API call cannot skip it).
    if (confirmation !== expectedConfirmation(targetAccess, targetUid)) {
      throw new ResetError('failed-precondition', 'The confirmation text does not match.');
    }

    // Lock: one reset per target at a time.
    const lockRef = db.doc(`adminResets/${targetUid}`);
    await db.runTransaction(async (tx) => {
      const lock = (await tx.get(lockRef)).data();
      if (lock?.status === 'running' && now() - millis(lock.startedAt) < LOCK_TTL_MS) {
        throw new ResetError('aborted', 'A reset for this user is already running.');
      }
      tx.set(lockRef, { status: 'running', targetUid, adminUid: callerUid, startedAt: serverTimestamp() });
    });

    const base = `users/${targetUid}`;
    const counts = {};
    try {
      const profileRef = db.doc(base);
      const profileSnap = await profileRef.get();
      const oldGeneration = generationOf(profileSnap.exists ? profileSnap.data() : null);
      const generation = newGeneration();
      if (!GENERATION_TOKEN.test(generation) || generation === oldGeneration) throw new ResetError('internal', 'Could not create a new training generation.');
      const newRunId = resetRunId(generation);

      // Active program BEFORE touching runs (most recent active run wins).
      const runsSnap = await db.collection(`${base}/programRuns`).get();
      const active = runsSnap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((r) => r.status === 'active' && typeof r.programId === 'string')
        .sort((a, b) => millis(b.startDate) - millis(a.startDate))[0] ?? null;
      let activeProgram = null;
      let position = null;
      if (active) {
        const prog = await db.doc(`${base}/programs/${active.programId}`).get();
        if (prog.exists) {
          const days = (await db.collection(`${base}/programs/${active.programId}/days`).get()).docs
            .map((d) => d.data()).filter((d) => typeof d.order === 'number').sort((a, b) => a.order - b.order);
          if (days.length) {
            activeProgram = { id: active.programId, name: prog.data().name ?? null };
            position = { week: 1, dayOrder: days[0].order };
          }
        }
      }

      for (const name of RESET_COLLECTIONS) counts[name] = await deleteAll(db, `${base}/${name}`);

      // Final step, ONE batch: replace every run with one fresh run, clear
      // 1RMs, and switch the user to the new training generation (old
      // sentinels removed, new one created, profile token changed together).
      const runIds = (await db.collection(`${base}/programRuns`).get()).docs.map((d) => d.ref);
      counts.programRuns = runIds.filter((r) => !r.id.startsWith(RESET_RUN_PREFIX)).length;
      const finalBatch = db.batch();
      runIds.forEach((ref) => finalBatch.delete(ref));
      if (activeProgram) {
        finalBatch.set(db.doc(`${base}/programRuns/${newRunId}`), {
          programId: activeProgram.id, startDate: serverTimestamp(), current: position, status: 'active', overrides: {},
        });
      }
      const sentinelPath = (g) => `${base}/${GENERATION_SENTINEL_COLLECTION}/${generationSentinelId(g)}`;
      finalBatch.delete(db.doc(sentinelPath(oldGeneration)));
      finalBatch.delete(db.doc(sentinelPath(INITIAL_GENERATION)));
      const hasProfile = (await profileRef.get()).exists;
      if (hasProfile) {
        finalBatch.set(db.doc(sentinelPath(generation)), { kind: 'trainingGeneration', generation, createdAt: serverTimestamp() });
        finalBatch.update(profileRef, { currentMaxes: {}, lastTrainingResetAt: serverTimestamp(), trainingGeneration: generation });
      }
      await finalBatch.commit();

      // Verify — success only if nothing reset-able is left.
      const leftovers = {};
      const expectedSentinel = hasProfile ? generationSentinelId(generation) : null;
      for (const name of RESET_COLLECTIONS) {
        const ids = (await db.collection(`${base}/${name}`).limit(2).get()).docs.map((d) => d.id)
          .filter((id) => !(name === GENERATION_SENTINEL_COLLECTION && id === expectedSentinel));
        if (ids.length) leftovers[name] = ids.length;
      }
      const runsAfter = (await db.collection(`${base}/programRuns`).get()).docs.map((d) => d.id);
      if (runsAfter.some((id) => id !== newRunId)) leftovers.programRuns = runsAfter.length;
      if (Object.keys(leftovers).length) {
        throw new ResetError('aborted', `Reset incomplete — new data appeared during the reset (${Object.keys(leftovers).join(', ')}). Run the reset again.`);
      }

      const result = {
        ok: true,
        targetUid,
        removed: {
          workouts: counts.workouts, maxHistory: counts.maxes, measurements: counts.measurements,
          records: counts.records, progressionSuggestions: counts.progressionSuggestions, programRuns: counts.programRuns,
        },
        activeProgram,
        position,
        programRunId: activeProgram ? newRunId : null,
        trainingGeneration: hasProfile ? generation : null,
        currentMaxes: 'cleared — the user enters current 1RMs at next sign-in',
      };
      await lockRef.set({ status: 'completed', targetUid, adminUid: callerUid, finishedAt: serverTimestamp(), removed: result.removed });
      await db.collection('adminAudit').doc().set({
        type: 'training_reset', adminUid: callerUid, targetUid, at: serverTimestamp(), result: 'completed', removed: result.removed,
      });
      return result;
    } catch (err) {
      const code = err instanceof ResetError ? err.code : 'internal';
      const message = err instanceof ResetError ? err.message : 'The reset did not complete. Nothing was reported as reset; you can safely run it again.';
      try {
        await lockRef.set({ status: 'incomplete', targetUid, adminUid: callerUid, finishedAt: serverTimestamp(), partial: counts });
        await db.collection('adminAudit').doc().set({ type: 'training_reset', adminUid: callerUid, targetUid, at: serverTimestamp(), result: 'incomplete', partial: counts });
      } catch { /* the original error is what matters */ }
      throw new ResetError(code, message);
    }
  };
}
