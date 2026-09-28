// Phase 5C, Package 1 — "Current 1RM History" + bodyweight association +
// strength/bodyweight ratio. Pure, Firebase-free (same split as
// progressAnalytics.js/workoutSnapshot.js): every function here takes
// already-fetched data (max-history entries from js/services/
// userService.js's getMaxHistory, and bodyweight records from
// measurementService.js's listBodyweightHistory) and derives its result
// purely from that — no Firestore reads, no DOM, independently unit-
// testable without either.
//
// SOURCE DISCIPLINE (spec section 7/14): this file is handed ONLY
// getMaxHistory's own entries for one exerciseId — the append-only
// `users/{uid}/maxes` history the existing recordOneRepMax mechanism
// already writes (Package 2's own write path, and Profile's manual edits
// before it). It has no import path to js/utils/prAnalytics.js's Tested/
// Estimated PR events at all, so a Tested PR or an Estimated 1RM value can
// never end up in the "Current 1RM History" this file builds — not because
// of a filter that could be forgotten, but because that data simply never
// reaches this file in the first place.
import { toMillis } from './progressAnalytics.js';

/**
 * Spec section 8 — the bodyweight association rule, verbatim:
 * "for a historical Current 1RM entry at timestamp T, use the most recent
 * valid bodyweight measurement whose timestamp is <= T. Never use a
 * bodyweight measurement from AFTER the 1RM entry. If there is no
 * bodyweight measurement on or before T, display '—'. Do NOT interpolate.
 * Do NOT infer."
 *
 * Malformed bodyweight records (non-numeric/zero/negative `value`, or a
 * `date` that doesn't parse to a real instant) are silently ignored, same
 * "fail open, never fabricate, never throw" discipline as
 * isMeaningfulWorkingSet/isEstimated1RMEligible use for workout sets.
 *
 * @param {*} timestamp - the 1RM entry's own effectiveDate
 * @param {Array<{date:*, value:number}>} bodyweightRecords
 * @returns {number|null} the associated bodyweight in kg, or null if none qualifies
 */
export function associateBodyweightAtOrBefore(timestamp, bodyweightRecords) {
  const t = toMillis(timestamp);
  if (!t) return null; // a malformed/missing 1RM timestamp can't be associated against anything
  let best = null; // {t, value} — the LATEST qualifying record seen so far
  for (const r of bodyweightRecords ?? []) {
    if (!r || typeof r.value !== 'number' || !Number.isFinite(r.value) || r.value <= 0) continue; // malformed value ignored
    const rt = toMillis(r.date);
    if (!rt) continue; // malformed/missing timestamp ignored
    if (rt > t) continue; // NEVER a future measurement, however close
    if (best === null || rt > best.t) best = { t: rt, value: r.value }; // latest prior measurement wins — never interpolated between two
  }
  return best ? best.value : null;
}

/**
 * Spec section 9 — strength/bodyweight ratio for one historical Current
 * 1RM entry: `kg / associatedBodyweightKg`, or `null` if no bodyweight is
 * associated (never a fabricated/zero ratio). Descriptive only — this file
 * computes a plain number; progress.js decides how (or whether) to word it,
 * and nothing here ranks, scores, or classifies the result.
 */
export function strengthToBodyweightRatio(kg, bodyweightKg) {
  if (typeof kg !== 'number' || !Number.isFinite(kg) || kg <= 0) return null;
  if (typeof bodyweightKg !== 'number' || !Number.isFinite(bodyweightKg) || bodyweightKg <= 0) return null;
  return kg / bodyweightKg;
}

/**
 * Builds the "Current 1RM History" rows for ONE exercise: newest-first,
 * each carrying its own associated bodyweight (per the rule above, applied
 * independently per entry — never the CURRENT bodyweight, never today's)
 * and ratio. Malformed max-history entries (missing/non-positive `kg`) are
 * silently dropped rather than shown as a broken row — legacy data safety,
 * same discipline the PR engine already applies to malformed workout sets.
 *
 * Deliberately does NOT fabricate a row for a Current 1RM that has no
 * matching history entry at all (spec section 11: "do not create fake
 * history records merely to populate the UI") — a caller with
 * `rows.length === 0` but a non-null Current 1RM should say history is
 * unavailable, never invent a date.
 *
 * @param {Array<{kg:number, effectiveDate:*, kind?:string, source?:string, exerciseId?:string}>} maxHistoryEntries
 * @param {Array<{date:*, value:number}>} bodyweightRecords
 */
export function buildCurrentMaxHistoryRows(maxHistoryEntries, bodyweightRecords) {
  return (maxHistoryEntries ?? [])
    .filter((e) => e && typeof e.kg === 'number' && Number.isFinite(e.kg) && e.kg > 0)
    .map((e) => {
      const bodyweightKg = associateBodyweightAtOrBefore(e.effectiveDate, bodyweightRecords);
      return {
        date: e.effectiveDate,
        kg: e.kg,
        kind: e.kind ?? null,
        source: e.source ?? null,
        bodyweightKg,
        ratio: strengthToBodyweightRatio(e.kg, bodyweightKg),
      };
    })
    .sort((a, b) => toMillis(b.date) - toMillis(a.date)); // newest first — spec section 10
}
