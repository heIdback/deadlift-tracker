// Admin "Reset training data" — Spark/free-plan design. PURE logic only
// (no Firebase import) so every decision is unit-testable.
//
// Why it works this way (firestore.rules are unchanged):
//   - An admin can READ another user's data but can WRITE only that user's
//     /access/{uid} document. So the admin writes a reset REQUEST there
//     (access.trainingResetRequest); the rules guarantee only an approved
//     admin can (and they pin approvedBy to the writing admin).
//   - The target user's OWN app applies the request with the owner's normal
//     permissions, in one Firestore transaction (services/trainingResetService.js).
//   - Completed workouts and 1RM history can't be deleted by anyone under the
//     rules, so they are ARCHIVED: the profile gets trainingResetAt (server
//     time) and every read hides anything older (see isArchived* below).
//     Runs, in-progress workouts, PR cache and suggestions are deleted;
//     bodyweight is deleted only if the admin ticked that option.
//   - A new training generation (utils/trainingGeneration.js) is started in the
//     same transaction, so the user's other devices can't write old state back.
import {
  GENERATION_SENTINEL_COLLECTION, INITIAL_GENERATION, generationSentinelId, generationOf,
} from './trainingGeneration.js';

export const RESET_RUN_PREFIX = 'reset-run-';
export const MAX_RESET_WRITES = 450; // one transaction; Firestore's hard limit is 500
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const isValidResetId = (id) => typeof id === 'string' && ID.test(id);
export const newResetId = () => globalThis.crypto.randomUUID().replace(/-/g, '');

/** The exact text the admin types; the target's app re-checks it before applying. */
export function expectedResetConfirmation(email, uid) {
  const e = typeof email === 'string' ? email.trim() : '';
  return `RESET ${e || uid}`;
}

/**
 * State of the reset request on an access record, from the TARGET's point of view.
 * @returns {{state: 'none'|'cancelled'|'applied'|'invalid'|'pending', reason?: string, request?: object}}
 */
export function evaluateResetRequest({ access, profile, uid }) {
  const request = access?.trainingResetRequest;
  if (!request || typeof request !== 'object') return { state: 'none' };
  if (!isValidResetId(request.id)) return { state: 'invalid', reason: 'Malformed request id.', request };
  if (profile?.trainingReset?.appliedRequestId === request.id) return { state: 'applied', request };
  // A request older than the last reset applied on this account (e.g. the user
  // later reset their own data) is already covered — never applied again.
  const requested = toMillis(request.requestedAt);
  const lastReset = toMillis(profile?.trainingResetAt);
  if (requested != null && lastReset != null && requested <= lastReset) return { state: 'applied', request };
  if (request.status === 'cancelled') return { state: 'cancelled', request };
  if (access.status !== 'approved') return { state: 'invalid', reason: 'Account is not approved.', request };
  const approved = toMillis(access.approvedAt);
  if (requested != null && approved != null && approved > requested) {
    return { state: 'invalid', reason: 'The account was re-approved after this request — request the reset again.', request };
  }
  // approvedBy is pinned by the rules to the admin who last wrote this record.
  if (typeof request.requestedBy !== 'string' || request.requestedBy !== access.approvedBy) {
    return { state: 'invalid', reason: 'Requesting admin could not be verified.', request };
  }
  if (request.confirmation !== expectedResetConfirmation(access.email, uid)) {
    return { state: 'invalid', reason: 'Confirmation text does not match this account.', request };
  }
  return { state: 'pending', request };
}

export function toMillis(v) {
  if (v == null) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds ?? 0) / 1e6);
  return null;
}

/**
 * Is a record from before the reset? Strictly-earlier time → yes. A server
 * time still PENDING on this device (the SDK reports it as null) → never.
 * A record with NO time field at all (legacy data; every writer since v1 sets
 * one) → yes, once the account has been reset.
 */
export function isArchived(ts, boundary) {
  const b = toMillis(boundary);
  if (b == null) return false;
  if (ts === undefined) return true;
  const t = toMillis(ts);
  return t != null && t < b;
}
export const isArchivedWorkout = (w, boundary) => isArchived(w?.finishedAt != null ? w.finishedAt : w?.startedAt, boundary);
export const isArchivedMax = (m, boundary) => isArchived(m?.effectiveDate, boundary);
export const isArchivedMeasurement = (m, boundary) => isArchived(m?.date, boundary);
export const isArchivedRun = (r, boundary) => isArchived(r?.startDate, boundary);

export const trainingBoundaryOf = (profile) => profile?.trainingResetAt ?? null;
export const bodyweightBoundaryOf = (profile) => profile?.bodyweightResetAt ?? null;

/**
 * The program that stays active after the reset: the most recently started
 * active run whose program still exists with days → its first day, Week 1.
 */
export function pickResetPosition({ runs, programs, daysByProgram }) {
  const active = (runs ?? [])
    .filter((r) => r?.status === 'active' && typeof r.programId === 'string')
    .sort((a, b) => (toMillis(b.startDate) ?? 0) - (toMillis(a.startDate) ?? 0));
  for (const run of active) {
    const program = (programs ?? []).find((p) => p.id === run.programId);
    const days = (daysByProgram?.[run.programId] ?? []).filter((d) => typeof d?.order === 'number').sort((a, b) => a.order - b.order);
    if (program && days.length) return { activeProgram: { id: program.id, name: program.name ?? program.id }, position: { week: 1, dayOrder: days[0].order } };
    return { activeProgram: null, position: null }; // the active program no longer exists → none is started
  }
  return { activeProgram: null, position: null };
}

/**
 * Everything the target's transaction writes. `serverTime` is the SDK's
 * serverTimestamp() sentinel (passed in to keep this module pure).
 */
export function planTrainingReset({
  uid, profile, request, generation, serverTime,
  runIds = [], inProgressWorkoutIds = [], recordIds = [], progressionSuggestionIds = [],
  activeProgram = null, position = null, current = {},
}) {
  if (!isValidResetId(generation)) throw new Error('Invalid training generation.');
  const base = `users/${uid}`;
  const oldGeneration = generationOf(profile);
  const newRunId = activeProgram ? `${RESET_RUN_PREFIX}${generation}` : null;
  const deleteBodyweight = request?.deleteBodyweight === true;

  const deletes = new Set([
    ...runIds.map((id) => `${base}/programRuns/${id}`),
    ...inProgressWorkoutIds.map((id) => `${base}/workouts/${id}`),
    ...recordIds.map((id) => `${base}/records/${id}`),
    ...progressionSuggestionIds.map((id) => `${base}/${GENERATION_SENTINEL_COLLECTION}/${id}`),
    `${base}/${GENERATION_SENTINEL_COLLECTION}/${generationSentinelId(oldGeneration)}`,
    `${base}/${GENERATION_SENTINEL_COLLECTION}/${generationSentinelId(INITIAL_GENERATION)}`,
  ]);
  const sets = [[`${base}/${GENERATION_SENTINEL_COLLECTION}/${generationSentinelId(generation)}`, { kind: 'trainingGeneration', generation, createdAt: serverTime }]];
  if (newRunId) {
    sets.push([`${base}/programRuns/${newRunId}`, { programId: activeProgram.id, startDate: serverTime, current: position, status: 'active', overrides: {} }]);
  }
  for (const [p] of sets) deletes.delete(p);

  const counts = {
    workouts: current.workouts ?? 0,
    maxHistory: current.maxHistory ?? 0,
    bodyweight: deleteBodyweight ? (current.bodyweight ?? 0) : 0,
    programRuns: runIds.length,
    inProgressWorkouts: inProgressWorkoutIds.length,
  };
  const profileUpdate = {
    currentMaxes: {},
    trainingGeneration: generation,
    trainingResetAt: serverTime,
    ...(deleteBodyweight ? { bodyweightResetAt: serverTime } : {}),
    trainingReset: {
      appliedRequestId: request.id,
      requestedBy: request.requestedBy,
      requestedAt: request.requestedAt ?? null,
      appliedAt: serverTime,
      generation,
      deleteBodyweight,
      // keep an earlier reset's unfinished bodyweight cleanup pending
      bodyweightCleanupDone: deleteBodyweight ? false : (profile?.trainingReset?.bodyweightCleanupDone ?? true),
      activeProgramId: activeProgram?.id ?? null,
      programRunId: newRunId,
      counts,
    },
  };
  const writes = deletes.size + sets.length + 1;
  if (writes > MAX_RESET_WRITES) throw new Error(`Reset needs ${writes} writes in one step (limit ${MAX_RESET_WRITES}).`);
  return { deletes: [...deletes], sets, profileUpdate, newRunId, activeProgram, position, counts, oldGeneration };
}
