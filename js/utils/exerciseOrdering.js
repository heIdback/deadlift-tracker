// PHASE 4.1 — FINAL POLISH PASS: warm-up-first exercise ordering.
//
// ROOT CAUSE this fixes: selectWeekPrescriptions's 'block-driven' branch
// (js/utils/workoutSnapshot.js) pushes a main lift's Top Single, Backoff,
// and SGDL entries FIRST, then pushes that lift's warm-up entry LAST —
// because the warm-up ramp's own target (the Top Single) has to already be
// known before the ramp can be described, so it's naturally computed/pushed
// after it. That authoring-order convenience became a real-world logging
// UX bug wherever the resulting flat `exercises[]` array is rendered
// top-to-bottom: the Deadlift warm-up shows up AFTER the Deadlift Top
// Single/Backoff/SGDL working sets, which is backwards from how anyone
// actually trains (warm up, THEN lift heavy).
//
// This module is the single, shared, pure fix for that — a presentation-
// ordering helper with zero Firebase/DOM imports, directly unit-testable.
// It never mutates its input and never touches anything about an exercise
// entry OTHER than which array index it occupies afterward: no exerciseId,
// entryId, setId, load, prescribed, or set[] content is read for any
// purpose other than the association check below, let alone changed.
//
// STRUCTURAL ASSOCIATION RULE (never a display-name string match):
// An entry is a "warm-up" purely by its own `section === 'warmup'` field —
// the same structural marker selectWeekPrescriptions/resolvePrescription
// already stamp on the warmupSets-derived entry (see workoutSnapshot.js).
// A warm-up entry is associated with whichever OTHER (non-warmup) entries
// share its `exerciseId` — e.g. a Deadlift warm-up (`exerciseId:'deadlift',
// section:'warmup'`) is associated with the Deadlift Top Single and Backoff
// entries (`exerciseId:'deadlift'`), but NOT with the Snatch-Grip Deadlift
// entry (`exerciseId:'snatch-grip-deadlift'` — a different id, even though
// it's the same day's "main pull" conceptually) or any unrelated accessory.
//
// PLACEMENT RULE: a warm-up is repositioned to sit immediately before the
// FIRST (in original relative order) non-warmup entry it's associated
// with. Every other entry — every non-warmup, and any warm-up with no
// matching exerciseId anywhere in the list — keeps its original relative
// order among its own kind. This is deliberately NOT "move every warm-up
// to absolute index 0": a hypothetical future program with a warm-up
// belonging to a LATER lift would have that warm-up placed immediately
// before ITS lift, wherever that lift falls in the sequence, never yanked
// to the very front of the whole workout. An orphaned warm-up (its
// exerciseId matches nothing else in the list — not a shape any current
// program schema produces, but not assumed impossible either) is appended
// at the very end as a safety net, rather than silently dropped.
/**
 * Computes a warm-up-first presentation order for a resolved/raw exercise
 * list. Returns an array of INDICES into the original `exercises` array
 * (a permutation, i.e. `order.length === exercises.length` and every
 * original index appears exactly once) — never the reordered objects
 * themselves. Returning indices, not objects, is what lets a caller that
 * must keep a SECOND, index-paired array in sync (there is currently no
 * such caller in this codebase, but the shape is deliberately kept generic
 * for that case) apply the exact same permutation to both arrays.
 *
 * Pure and non-mutating: never reads or writes anything on the input
 * objects beyond `section`/`exerciseId`, and never modifies the input
 * array itself. A workout with no warm-up entries at all returns the
 * identity permutation (0..n-1) unchanged. Set ordering *within* one
 * exercise entry is entirely untouched by this function — it only ever
 * reorders whole exercise entries, never touches an entry's own `sets`
 * array.
 *
 * @param {Array<{exerciseId?: string, section?: string}>} exercises
 * @returns {number[]} permutation of original indices
 */
export function computeWarmupFirstOrder(exercises) {
  const list = exercises ?? [];
  const n = list.length;
  const isWarmup = (entry) => (entry?.section ?? 'main') === 'warmup';

  const warmupIdx = [];
  const nonWarmupIdx = [];
  for (let i = 0; i < n; i += 1) {
    (isWarmup(list[i]) ? warmupIdx : nonWarmupIdx).push(i);
  }

  if (warmupIdx.length === 0) {
    // No-warm-up case: unchanged, by construction — nothing to reorder.
    return Array.from({ length: n }, (_, i) => i);
  }

  const usedWarmups = new Set();
  const order = [];
  for (const ni of nonWarmupIdx) {
    // Insert every not-yet-placed warm-up that shares THIS entry's
    // exerciseId immediately before it, in the warm-ups' own original
    // relative order (stable even if a lift somehow had more than one
    // associated warm-up entry).
    for (const wi of warmupIdx) {
      if (usedWarmups.has(wi)) continue;
      if (list[wi]?.exerciseId === list[ni]?.exerciseId) {
        order.push(wi);
        usedWarmups.add(wi);
      }
    }
    order.push(ni);
  }
  // Safety net, not a case any current program schema hits: a warm-up
  // whose exerciseId matched no non-warmup entry anywhere in the list is
  // appended at the end rather than dropped.
  for (const wi of warmupIdx) {
    if (!usedWarmups.has(wi)) order.push(wi);
  }
  return order;
}

/** Applies a permutation (from computeWarmupFirstOrder) to an array, returning a NEW array — never mutates `list`. */
export function applyOrder(list, order) {
  return order.map((i) => list[i]);
}

/** Convenience wrapper for the common case: reorder one exercises array for warm-up-first presentation, without needing a second index-paired array kept in sync. Non-mutating. */
export function orderExercisesWarmupFirst(exercises) {
  const list = exercises ?? [];
  return applyOrder(list, computeWarmupFirstOrder(list));
}
