/**
 * Phase 5A — shared helper for telling a genuine "this data was never
 * cached and the device is currently offline" Firestore failure apart from
 * any other error, so those two cases can be shown differently:
 *   - genuinely-uncached-while-offline: a friendly, expected message
 *     ("This data isn't available offline yet. Reconnect to load it."),
 *     since this is a normal, anticipated condition, not a bug.
 *   - anything else (a real bug, a permissions error, a rules rejection,
 *     an online failure): left exactly as before — this helper must never
 *     mask a genuine problem behind a generic "just reconnect" message.
 *
 * Deliberately conservative: `navigator.onLine === false` is required in
 * addition to an offline-shaped error, since `navigator.onLine` is itself
 * only a connectivity hint (see js/core/sync-status.js's own header
 * comment) — but here it is used only to CONFIRM a plausible explanation
 * for an already-thrown error, never as the sole basis for a decision, so
 * that imprecision is acceptable in this narrow, presentation-only role.
 *
 * Zero Firebase/DOM imports — pure, directly unit-testable via import().
 */

export const OFFLINE_UNAVAILABLE_MESSAGE = "This data isn't available offline yet. Reconnect to load it.";

export function isOfflineUnavailableError(err) {
  if (!err) return false;
  if (typeof navigator !== 'undefined' && navigator && navigator.onLine === true) return false;
  const code = err.code ?? '';
  const message = err.message ?? '';
  return code === 'unavailable' || /client is offline/i.test(message) || /failed to get document because the client is offline/i.test(message);
}
