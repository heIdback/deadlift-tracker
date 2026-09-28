export function formatDate(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : date.toDate?.() ?? new Date(date);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDuration(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 4.1 browser-test correction pass — CORRECTION 3: History Start/
// Finish/Duration display in a real IANA timezone (Europe/Zagreb), so it
// automatically follows CET (winter) / CEST (summer) and every historical
// DST rule, rather than a hardcoded "CET" offset that would be WRONG half
// the year. `Intl.DateTimeFormat` with an explicit `timeZone` is the
// browser-native way to do this with no manual +1/+2 arithmetic and no new
// dependency; the underlying Firestore Timestamps/Dates themselves are
// untouched — this is a DISPLAY-only concern.
const HISTORY_TIMEZONE = 'Europe/Zagreb';

function toJsDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const zagrebTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: HISTORY_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
});
const zagrebDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: HISTORY_TIMEZONE, year: 'numeric', month: 'short', day: 'numeric',
});

/** 24-hour HH:mm, always in Europe/Zagreb local time regardless of the viewer's own device timezone — e.g. "18:42". */
export function formatZagrebTime(value) {
  const d = toJsDate(value);
  return d ? zagrebTimeFormatter.format(d) : '';
}

/** "Sep 26, 2026", in the Europe/Zagreb local calendar date. */
export function formatZagrebDate(value) {
  const d = toJsDate(value);
  return d ? zagrebDateFormatter.format(d) : '';
}

/**
 * Duration in seconds computed directly from the two canonical timestamps
 * (finishedAt - startedAt, in real elapsed milliseconds) — never by parsing
 * or subtracting the formatted "HH:mm" display strings, which would silently
 * produce a wrong answer for a workout that happens to cross a DST change or
 * midnight. Returns null if either timestamp is missing (never a fabricated
 * 0). `workout.durationSec` itself is never populated anywhere in this app
 * (verified: every write site sets it to `null` and no code path ever
 * assigns it a real value) — so this is the actual canonical source for a
 * human-readable duration, not a second, competing calculation.
 */
export function durationSecondsBetween(startedAt, finishedAt) {
  const start = toJsDate(startedAt);
  const end = toJsDate(finishedAt);
  if (!start || !end) return null;
  const diff = Math.round((end.getTime() - start.getTime()) / 1000);
  return diff >= 0 ? diff : null;
}

/** "47m" under an hour, "1h 14m" at/above an hour — the compact human format this pass's History display uses (distinct from the older seconds-precision formatDuration above, which no code path currently ever displays since durationSec is always null). */
export function formatHumanDuration(seconds) {
  if (seconds == null) return '—';
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function daysBetween(a, b) {
  const msPerDay = 1000 * 60 * 60 * 24;
  const da = a instanceof Date ? a : a.toDate?.() ?? new Date(a);
  const db = b instanceof Date ? b : b.toDate?.() ?? new Date(b);
  return Math.round((db - da) / msPerDay);
}

export function isWithinDays(date, days) {
  return daysBetween(date, new Date()) <= days;
}
