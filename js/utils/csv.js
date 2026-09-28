// ─────────────────────────────────────────────────────────────────────────
// Pure CSV building helpers (Phase 3D). No Firebase/DOM dependency, so this
// is fully unit-testable in plain Node.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Escapes a single CSV field per RFC 4180: any value containing a comma, a
 * double quote, or a line break (\r or \n) is wrapped in double quotes,
 * with internal double quotes doubled. null/undefined become '' (never the
 * literal string "null"/"undefined"). Numbers and booleans are stringified
 * plainly (never quoted, since they can't contain a delimiter).
 */
export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Builds a full CSV document (header row + one row per record) from a fixed
 * column list, so field order/names are stable across exports rather than
 * depending on whatever key order an object happens to have.
 * `columns`: array of { key, header } — `key` may be a dotted path
 * ('a.b.c') for convenience since export records are nested.
 * Uses CRLF line endings (the RFC 4180 standard, and what Excel expects).
 */
export function buildCsv(columns, rows) {
  const headerLine = columns.map((c) => csvEscape(c.header)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => csvEscape(getPath(row, c.key))).join(','),
  );
  return [headerLine, ...lines].join('\r\n') + '\r\n';
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}
