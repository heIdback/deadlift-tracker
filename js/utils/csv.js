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

/**
 * v1.1 Program Import — the READ side of this module's RFC 4180 support
 * (buildCsv/csvEscape above are the write side). Pure, no DOM/Firebase.
 *
 * Handles: an optional UTF-8 BOM, quoted fields (with embedded commas,
 * doubled "" quotes and line breaks), CRLF / LF / CR line endings, and a
 * trailing newline. Fully blank lines are dropped. Returns
 * `{ rows: string[][], error: string|null }` — never throws, so a caller
 * treating the file as untrusted input can always report a plain message.
 * An unterminated quoted field is reported as an error (never guessed at).
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStartedQuoted = false;
  let line = 1;
  let quoteOpenedOnLine = 0;

  const endField = () => { row.push(field); field = ''; fieldStartedQuoted = false; };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field === '' && !fieldStartedQuoted) {
        inQuotes = true;
        fieldStartedQuoted = true;
        quoteOpenedOnLine = line;
      } else {
        return { rows: [], error: `Line ${line}: unexpected quote character inside an unquoted value.` };
      }
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
    } else {
      if (fieldStartedQuoted) {
        return { rows: [], error: `Line ${line}: unexpected text after a closing quote.` };
      }
      field += ch;
    }
  }
  if (inQuotes) {
    return { rows: [], error: `Line ${quoteOpenedOnLine}: a quoted value is never closed.` };
  }
  if (field !== '' || row.length > 0 || fieldStartedQuoted) endRow();
  return { rows, error: null };
}
