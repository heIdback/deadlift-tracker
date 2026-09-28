// ─────────────────────────────────────────────────────────────────────────
// Pure, Firebase-free serialization helpers for the user data export
// (Phase 3D). Kept separate from exportService.js (which does the actual
// Firestore reads) so the tricky part — turning whatever Firestore handed
// back into stable, portable JSON — can be unit-tested without a database.
//
// The one type Firestore returns that JSON.stringify cannot handle safely
// is Timestamp: it has a .toDate()/.seconds/.nanoseconds shape, and simply
// letting JSON.stringify call its .toJSON() would silently produce a
// `{seconds, nanoseconds}` object with no indication it's a timestamp at
// all. Every Timestamp is instead converted to an explicit, unambiguous,
// future-import-friendly shape:
//   { _type: 'timestamp', iso: '2026-09-26T10:00:00.000Z', seconds, nanoseconds }
// `iso` is what a human reads in the JSON file; `seconds`/`nanoseconds` are
// kept alongside it so a future importer can reconstruct the exact
// Firestore Timestamp without any precision loss from the ISO string's
// millisecond rounding.
// ─────────────────────────────────────────────────────────────────────────

/** Duck-types a Firestore Timestamp instance without importing the SDK here. */
function isFirestoreTimestamp(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.toDate === 'function' &&
    typeof value.seconds === 'number' &&
    typeof value.nanoseconds === 'number'
  );
}

function serializeTimestamp(ts) {
  return {
    _type: 'timestamp',
    iso: ts.toDate().toISOString(),
    seconds: ts.seconds,
    nanoseconds: ts.nanoseconds,
  };
}

/**
 * Recursively walks any value returned from a Firestore document (or a
 * plain JS value) and returns a version safe to JSON.stringify:
 *   - Firestore Timestamp -> the explicit shape above
 *   - Date -> the same explicit shape (defensive: a service occasionally
 *     hands back a client-side `new Date()` in place of a not-yet-resolved
 *     serverTimestamp(), e.g. logBodyweight's optimistic return value)
 *   - array -> each element serialized, order preserved
 *   - plain object -> each own-enumerable key serialized, key order
 *     preserved (insertion order, as Firestore returns it)
 *   - undefined -> null (Firestore never actually stores `undefined`, but
 *     this keeps the function total/safe for any input)
 *   - number/string/boolean/null -> returned as-is, so numeric kg/reps/RPE
 *     values are never coerced to strings
 */
export function serializeForExport(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (isFirestoreTimestamp(value)) return serializeTimestamp(value);
  if (value instanceof Date) {
    return {
      _type: 'timestamp',
      iso: value.toISOString(),
      seconds: Math.floor(value.getTime() / 1000),
      nanoseconds: (value.getTime() % 1000) * 1e6,
    };
  }
  if (Array.isArray(value)) return value.map(serializeForExport);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = serializeForExport(v);
    }
    return out;
  }
  // number | string | boolean
  return value;
}

/** Firestore doc snapshot -> plain `{ id, ...serialized fields }`. */
export function serializeDoc(docSnap) {
  return { id: docSnap.id, ...serializeForExport(docSnap.data()) };
}

/** Convenience for a whole `getDocs()` snapshot. */
export function serializeDocs(querySnap) {
  return querySnap.docs.map(serializeDoc);
}

/**
 * Reads the `iso` string back out of a value serialized by
 * serializeForExport, for the CSV builders (which want a plain string
 * column, not the {_type,iso,seconds,nanoseconds} object). Returns '' for
 * anything that isn't one of our timestamp shapes or a plain string/number,
 * so a missing/null date field never produces "undefined"/"[object
 * Object]" in a CSV cell.
 */
export function isoOrEmpty(value) {
  if (value && typeof value === 'object' && value._type === 'timestamp') return value.iso;
  if (typeof value === 'string') return value;
  return '';
}
