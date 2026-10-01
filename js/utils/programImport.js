// ─────────────────────────────────────────────────────────────────────────
// v1.1 — Program Import (JSON + CSV). Pure, Firebase-free and DOM-free, the
// same pure-logic / Firebase-boundary split as programEditModel.js,
// restorePlan.js and workoutSnapshot.js: everything that decides WHAT would
// be written lives here and is unit-testable in plain Node; the one actual
// write (an all-or-nothing transaction) lives in
// js/services/programService.js's importProgram.
//
// NOT Backup/Restore. "Restore My Data" (restorePlan.js) restores a whole
// account backup. Program Import only ever ADDS one new training program
// (a `programs/{id}` doc + its `days` subcollection). It never reads or
// writes workouts, maxes, measurements, programRuns, the profile, or any
// existing program — see validateProgramDefinition's output shape: a plan
// contains nothing but the new program and its days.
//
// FORMATS
//   JSON — the native format: exactly the shape data/program.deadlift-8wk.json
//     already uses (schemaVersion/id/name/weeks/days/sections, and the three
//     exercise-entry shapes documented in programEditModel.js: flat,
//     'week-percent-range', 'block-driven'). Optional additive field:
//     `version` (free-text label, e.g. "2" or "2026-10"). `programId` is
//     accepted as an alias of `id`.
//   CSV — a simpler, normalized, human-editable format: one row per
//     week × day × exercise prescription. It produces FLAT exercise entries
//     only (see CSV_COLUMNS below); the complex block-driven/percent-range
//     shapes stay JSON-only, so CSV is never more powerful than JSON.
//
// UNTRUSTED INPUT
//   Every value is re-built from a whitelist: nothing from the file is ever
//   spread into a Firestore write. Unknown fields are dropped (reported as a
//   warning); security-sensitive fields (uid, role, status, permissions, …)
//   are a hard error. Ids are strict lowercase slugs, so a file can never
//   inject a Firestore path segment. Text is length-capped and stripped of
//   control characters; it is stored as plain text and every view renders
//   it through escapeHtml (js/utils/dom.js), so markup in a name/note is
//   displayed literally, never interpreted.
// ─────────────────────────────────────────────────────────────────────────

import { parseCsv } from './csv.js';
import { parseSetsReps } from './workoutSnapshot.js';
import { validateFlatEntry, generateProgramId, slugify } from './programEditModel.js';

export const PROGRAM_IMPORT_SCHEMA_VERSION = 1;

export const IMPORT_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxCsvRows: 5000,
  maxWeeks: 52,
  maxDays: 14,
  maxEntriesPerSection: 60,
  maxErrors: 50,
  nameLength: 120,
  versionLength: 40,
  dayNameLength: 80,
  exerciseNameLength: 100,
  notesLength: 500,
  sectionTextLength: 1000,
  programNotesLength: 2000,
  decisionRules: 30,
  decisionRuleLength: 300,
};

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Fields that describe ownership / access / database location. A program file has no business carrying any of them. */
const FORBIDDEN_KEYS = new Set([
  'uid', 'userid', 'ownerid', 'owner', 'createdby', 'role', 'roles', 'status', 'access',
  'permissions', 'isadmin', 'admin', 'approvedby', 'disabledby', 'path', 'ref',
  'programrunid', 'activeworkoutid', 'email',
]);

const KNOWN_TOP_LEVEL = new Set([
  'schemaVersion', 'id', 'programId', 'name', 'version', 'sourceFile', 'generatedBy',
  'roundingRules', 'currentOneRepMaxesAtImport', 'weeks', 'days', 'exerciseLibrary',
  'importReviewFlags', 'createdAt', 'updatedAt', 'notes', 'decisionRules',
]);

const LOAD_TYPES = ['none', 'bodyweight', 'fixed', 'percent', 'percentRange'];

// ── small helpers ─────────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}
function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Strips control characters (keeping \n and \t), trims. Non-strings are not coerced. */
function scrubText(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

/** Human-readable location for an error. */
function loc(parts) {
  return parts.filter(Boolean).join(' · ');
}

class Collector {
  constructor() { this.errors = []; this.warnings = []; this.ignored = new Set(); }
  error(where, message) { this.errors.push({ where, message }); }
  warn(where, message) { this.warnings.push({ where, message }); }
  get ok() { return this.errors.length === 0; }
}

/**
 * Optional text field. Returns the cleaned string, `null` for absent/blank,
 * or `undefined` (after recording an error) for an invalid value.
 */
function optionalText(c, value, where, label, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    c.error(where, `${label} must be text.`);
    return undefined;
  }
  const cleaned = scrubText(value);
  if (!cleaned) return null;
  if (cleaned.length > maxLength) {
    c.error(where, `${label} is too long (max ${maxLength} characters).`);
    return undefined;
  }
  return cleaned;
}

function requiredText(c, value, where, label, maxLength) {
  const v = optionalText(c, value, where, label, maxLength);
  if (v === null) c.error(where, `${label} is required.`);
  return v ?? undefined;
}

function checkId(c, value, where, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    c.error(where, `${label} "${String(value ?? '')}" is not valid — use lowercase letters, numbers and hyphens only (e.g. "bench-press").`);
    return undefined;
  }
  return value;
}

/** Records forbidden keys (error) and unknown keys (warning, dropped) on an object. */
function screenKeys(c, obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      c.error(where, `Field "${key}" is not allowed in a program file (ownership, access and database fields are never imported).`);
    } else if (!allowed.has(key) && !key.startsWith('_')) {
      c.ignored.add(key);
    }
  }
}

// ── load objects ──────────────────────────────────────────────────────────

/** Whitelists one load object. Returns a clean load or undefined (errors recorded). */
function cleanLoad(c, load, where, { allowedTypes = LOAD_TYPES } = {}) {
  if (load === undefined || load === null) return { type: 'none' };
  if (!isPlainObject(load)) {
    c.error(where, 'Load must be an object with a "type".');
    return undefined;
  }
  if (!allowedTypes.includes(load.type)) {
    c.error(where, `Load type "${String(load.type)}" is not supported here (expected one of: ${allowedTypes.join(', ')}).`);
    return undefined;
  }
  const basis = (of) => {
    if (of === undefined || of === null || of === '') return {};
    const id = checkId(c, of, where, 'Percentage basis ("of")');
    return id ? { of: id } : {};
  };
  switch (load.type) {
    case 'none':
    case 'bodyweight':
      return { type: load.type };
    case 'fixed': {
      if (!(isFiniteNumber(load.kg) && load.kg >= 0 && load.kg <= 500)) {
        c.error(where, 'Fixed load needs "kg" between 0 and 500.');
        return undefined;
      }
      const out = { type: 'fixed', kg: load.kg };
      if (load.perHand !== undefined) {
        if (typeof load.perHand !== 'boolean') { c.error(where, '"perHand" must be true or false.'); return undefined; }
        out.perHand = load.perHand;
      }
      const note = optionalText(c, load.note, where, 'Load note', 200);
      if (note === undefined) return undefined;
      if (note) out.note = note;
      return out;
    }
    case 'percent': {
      if (!(isFiniteNumber(load.percent) && load.percent > 0 && load.percent <= 3)) {
        c.error(where, 'Percent load needs "percent" as a fraction of 1RM between 0 and 3 (e.g. 0.75 = 75%).');
        return undefined;
      }
      return { type: 'percent', percent: load.percent, ...basis(load.of) };
    }
    case 'sets': {
      // Explicit warm-up ramp on a flat entry (see programEditModel.js's
      // isWarmupRampLoad). Steps kept exactly, in order.
      if (!Array.isArray(load.sets) || load.sets.length === 0 || load.sets.length > 15) {
        c.error(where, 'A warm-up ramp ("sets" load) needs 1 to 15 steps.');
        return undefined;
      }
      const steps = [];
      for (const [j, st] of load.sets.entries()) {
        if (!isPlainObject(st) || !(isFiniteNumber(st.kg) && st.kg >= 0 && st.kg <= 500) || !isPositiveInt(st.reps) || st.reps > 50) {
          c.error(where, `Warm-up step ${j + 1} needs "kg" (0–500) and "reps" (1–50).`);
          return undefined;
        }
        steps.push({ kg: st.kg, reps: st.reps });
      }
      return { type: 'sets', sets: steps };
    }
    case 'percentRange': {
      const okMin = isFiniteNumber(load.min) && load.min > 0 && load.min <= 3;
      const okMax = isFiniteNumber(load.max) && load.max > 0 && load.max <= 3;
      if (!okMin || !okMax) {
        c.error(where, 'Percent range needs "min" and "max" as fractions of 1RM between 0 and 3 (e.g. 0.70–0.75).');
        return undefined;
      }
      if (load.min > load.max) {
        c.error(where, 'Percent range "min" cannot be greater than "max".');
        return undefined;
      }
      return { type: 'percentRange', min: load.min, max: load.max, ...basis(load.of) };
    }
    default:
      return undefined;
  }
}

// ── exercise entries (the three shapes) ───────────────────────────────────

const FLAT_KEYS = new Set(['exerciseId', 'displayName', 'sets', 'reps', 'durationSec', 'load', 'notes', 'rpe', 'rir', 'weeks']);

function cleanFlatEntry(c, raw, where, totalWeeks) {
  screenKeys(c, raw, FLAT_KEYS, where);
  const exerciseId = checkId(c, raw.exerciseId, where, 'exerciseId');
  const displayName = requiredText(c, raw.displayName, where, 'Exercise name', IMPORT_LIMITS.exerciseNameLength);
  const load = cleanLoad(c, raw.load, where, { allowedTypes: [...LOAD_TYPES, 'sets'] });
  const notes = optionalText(c, raw.notes, where, 'Notes', IMPORT_LIMITS.notesLength);

  let reps = raw.reps ?? null;
  if (isPlainObject(reps)) reps = { min: reps.min, max: reps.max };
  const weeks = Array.isArray(raw.weeks) ? raw.weeks : raw.weeks;
  const candidate = {
    exerciseId,
    displayName: displayName ?? 'x',
    sets: raw.sets,
    reps,
    durationSec: raw.durationSec ?? null,
    load: load ?? { type: 'none' },
    notes: notes ?? null,
    rpe: raw.rpe ?? null,
    rir: raw.rir ?? null,
    weeks,
  };
  // Reuse the Program Editor's own flat-entry rules — one definition of "a
  // valid flat entry" for both editing and importing.
  const { errors } = validateFlatEntry(candidate, { totalWeeks });
  for (const e of errors) {
    if (e === 'Exercise name is required.') continue; // already reported above
    c.error(where, e === 'Select at least one week this exercise applies to.'
      ? '"weeks" must list at least one week this exercise is used in (e.g. [1, 2, 3]).'
      : e);
  }
  if (isPositiveInt(raw.sets) && raw.sets > 50) c.error(where, 'Sets must be 50 or fewer.');
  if (typeof reps === 'number' && reps > 200) c.error(where, 'Reps must be 200 or fewer.');
  if (isFiniteNumber(raw.durationSec) && raw.durationSec > 3600) c.error(where, 'Duration must be 3600 seconds or less.');
  if (Array.isArray(weeks) && new Set(weeks).size !== weeks.length) c.error(where, 'The same week is listed twice.');
  if (!exerciseId || displayName === undefined || load === undefined || notes === undefined) return undefined;
  return {
    exerciseId,
    displayName,
    sets: raw.sets,
    reps,
    durationSec: raw.durationSec ?? null,
    load,
    notes: notes ?? null,
    rpe: raw.rpe ?? null,
    rir: raw.rir ?? null,
    weeks: Array.isArray(weeks) ? [...weeks].sort((a, b) => a - b) : [],
  };
}

const WPR_KEYS = new Set(['exerciseId', 'displayName', 'structure', 'weeklyVariants', 'setsReps']);

function cleanWeekPercentRangeEntry(c, raw, where, weekSet) {
  screenKeys(c, raw, WPR_KEYS, where);
  const exerciseId = checkId(c, raw.exerciseId, where, 'exerciseId');
  const displayName = requiredText(c, raw.displayName, where, 'Exercise name', IMPORT_LIMITS.exerciseNameLength);
  if (!Array.isArray(raw.weeklyVariants) || raw.weeklyVariants.length === 0) {
    c.error(where, '"weeklyVariants" must list at least one week.');
    return undefined;
  }
  const setsRepsIn = isPlainObject(raw.setsReps) ? raw.setsReps : null;
  if (!setsRepsIn) c.error(where, '"setsReps" must map each week to a value like "4x5".');
  const seen = new Set();
  const weeklyVariants = [];
  const setsReps = {};
  let ok = !!exerciseId && displayName !== undefined && !!setsRepsIn;
  for (const [i, v] of raw.weeklyVariants.entries()) {
    const vWhere = loc([where, `week variant ${i + 1}`]);
    if (!isPlainObject(v) || !isPositiveInt(v.week) || !weekSet.has(v.week)) {
      c.error(vWhere, 'Each week variant needs a "week" that exists in the program\'s weeks list.');
      ok = false;
      continue;
    }
    if (seen.has(v.week)) { c.error(vWhere, `Week ${v.week} is listed twice.`); ok = false; continue; }
    seen.add(v.week);
    const load = cleanLoad(c, v.load, loc([where, `week ${v.week}`]), { allowedTypes: ['percent', 'percentRange'] });
    if (!load) { ok = false; continue; }
    weeklyVariants.push({ week: v.week, load });
    if (setsRepsIn) {
      const rawSR = setsRepsIn[String(v.week)];
      const parsed = parseSetsReps(rawSR);
      const repsOk = typeof parsed.reps === 'number'
        ? isPositiveInt(parsed.reps)
        : (parsed.reps && isPositiveInt(parsed.reps.min) && isPositiveInt(parsed.reps.max) && parsed.reps.min <= parsed.reps.max);
      if (typeof rawSR !== 'string' || !isPositiveInt(parsed.sets) || !repsOk) {
        c.error(loc([where, `week ${v.week}`]), `"setsReps" for week ${v.week} must look like "4x5" or "3x6-8".`);
        ok = false;
      } else {
        setsReps[String(v.week)] = scrubText(rawSR);
      }
    }
  }
  if (!ok) return undefined;
  weeklyVariants.sort((a, b) => a.week - b.week);
  return { exerciseId, displayName, structure: 'week-percent-range', weeklyVariants, setsReps };
}

const BLOCK_KEYS = new Set(['exerciseId', 'displayName', 'structure', 'weeklyVariants']);
const BLOCK_VARIANT_KEYS = new Set(['week', 'isDeload', 'isPrAttempt', 'topSingle', 'backoff', 'sgdl', 'notes', 'warmupSets']);

/**
 * One block-driven sub-lift (topSingle / backoff / sgdl). The native data
 * marks a sub-lift that is NOT prescribed in a given week with `sets: null`
 * or `sets: 0` (e.g. week 8's PR day has no backoff) — selectWeekPrescriptions
 * already skips those — so an inactive sub-lift is accepted and kept as
 * inactive rather than rejected, which keeps the packaged program itself a
 * valid import file.
 */
function cleanSubLift(c, sub, where, label, { allowSourceWeight = false } = {}) {
  if (sub === undefined || sub === null) return null;
  if (!isPlainObject(sub)) { c.error(where, `${label} must be an object.`); return undefined; }
  let ok = true;
  const inactive = sub.sets === null || sub.sets === undefined || sub.sets === 0;
  if (!inactive && (!isPositiveInt(sub.sets) || sub.sets > 50)) { c.error(where, `${label} sets must be a whole number from 1 to 50 (or 0/null when not prescribed that week).`); ok = false; }
  if (sub.reps != null && (!isPositiveInt(sub.reps) || sub.reps > 200)) { c.error(where, `${label} reps must be a whole number from 1 to 200.`); ok = false; }
  let load = null;
  if (sub.load != null || !inactive) {
    // A prescribed sub-lift is always % of 1RM. One that is NOT prescribed
    // this week keeps whatever placeholder load the file carries (e.g. the
    // Deadlift 210 W7 backoff's {type:'none'}) — stored as-is, never used.
    load = cleanLoad(c, sub.load, loc([where, label]), { allowedTypes: inactive ? LOAD_TYPES : ['percent'] });
    if (!load) ok = false;
  }
  const out = { sets: inactive ? (sub.sets ?? null) : sub.sets };
  if ('reps' in sub || !inactive) out.reps = sub.reps ?? null;
  if (load) out.load = load;
  const note = optionalText(c, sub.note, where, `${label} note`, 200);
  if (note === undefined) ok = false;
  if (note !== null || 'note' in sub) out.note = note ?? null;
  if (allowSourceWeight && sub.sourceWeightKgAtImport != null) {
    if (!(isFiniteNumber(sub.sourceWeightKgAtImport) && sub.sourceWeightKgAtImport > 0 && sub.sourceWeightKgAtImport <= 500)) {
      c.error(where, `${label} "sourceWeightKgAtImport" must be a weight between 0 and 500 kg.`);
      ok = false;
    } else {
      out.sourceWeightKgAtImport = sub.sourceWeightKgAtImport;
    }
  }
  return ok ? out : undefined;
}

function cleanBlockDrivenEntry(c, raw, where, weekSet) {
  screenKeys(c, raw, BLOCK_KEYS, where);
  const exerciseId = checkId(c, raw.exerciseId, where, 'exerciseId');
  const displayName = requiredText(c, raw.displayName, where, 'Exercise name', IMPORT_LIMITS.exerciseNameLength);
  if (!Array.isArray(raw.weeklyVariants) || raw.weeklyVariants.length === 0) {
    c.error(where, '"weeklyVariants" must list at least one week.');
    return undefined;
  }
  let ok = !!exerciseId && displayName !== undefined;
  const seen = new Set();
  const weeklyVariants = [];
  for (const [i, v] of raw.weeklyVariants.entries()) {
    const vWhere = loc([where, isPlainObject(v) && isPositiveInt(v.week) ? `week ${v.week}` : `week variant ${i + 1}`]);
    if (!isPlainObject(v) || !isPositiveInt(v.week) || !weekSet.has(v.week)) {
      c.error(vWhere, 'Each week variant needs a "week" that exists in the program\'s weeks list.');
      ok = false;
      continue;
    }
    screenKeys(c, v, BLOCK_VARIANT_KEYS, vWhere);
    if (seen.has(v.week)) { c.error(vWhere, `Week ${v.week} is listed twice.`); ok = false; continue; }
    seen.add(v.week);
    const topSingle = cleanSubLift(c, v.topSingle, vWhere, 'Top Single', { allowSourceWeight: true });
    const backoff = cleanSubLift(c, v.backoff, vWhere, 'Backoff');
    const sgdl = cleanSubLift(c, v.sgdl, vWhere, 'Snatch-Grip Deadlift');
    const notes = optionalText(c, v.notes, vWhere, 'Notes', IMPORT_LIMITS.notesLength);
    if (topSingle === undefined || backoff === undefined || sgdl === undefined || notes === undefined) { ok = false; continue; }
    const active = (sub) => !!sub && isPositiveInt(sub.sets) && !!sub.load;
    if (!active(topSingle) && !active(backoff) && !active(sgdl)) {
      c.error(vWhere, 'A week variant needs at least one prescribed topSingle, backoff or sgdl (with sets and a load).');
      ok = false;
      continue;
    }
    let warmupSets = null;
    if (v.warmupSets != null) {
      if (!Array.isArray(v.warmupSets) || v.warmupSets.length > 15) {
        c.error(vWhere, '"warmupSets" must be a list of at most 15 steps.');
        ok = false;
      } else {
        warmupSets = [];
        for (const [j, step] of v.warmupSets.entries()) {
          if (!isPlainObject(step) || !(isFiniteNumber(step.kg) && step.kg >= 0 && step.kg <= 500) || !isPositiveInt(step.reps) || step.reps > 50) {
            c.error(vWhere, `Warm-up step ${j + 1} needs "kg" (0–500) and "reps" (1–50).`);
            ok = false;
          } else {
            warmupSets.push({ kg: step.kg, reps: step.reps });
          }
        }
      }
    }
    for (const flag of ['isDeload', 'isPrAttempt']) {
      if (v[flag] !== undefined && typeof v[flag] !== 'boolean') { c.error(vWhere, `"${flag}" must be true or false.`); ok = false; }
    }
    const variant = {
      week: v.week,
      isDeload: v.isDeload === true,
      isPrAttempt: v.isPrAttempt === true,
      topSingle,
      backoff,
      sgdl,
      notes: notes ?? null,
    };
    if (warmupSets && warmupSets.length) variant.warmupSets = warmupSets;
    weeklyVariants.push(variant);
  }
  if (!ok) return undefined;
  weeklyVariants.sort((a, b) => a.week - b.week);
  return { exerciseId, displayName, structure: 'block-driven', weeklyVariants };
}

function cleanEntry(c, raw, where, ctx) {
  if (!isPlainObject(raw)) {
    c.error(where, 'Each exercise must be an object.');
    return undefined;
  }
  if (raw.structure === 'block-driven') return cleanBlockDrivenEntry(c, raw, where, ctx.weekSet);
  if (raw.structure === 'week-percent-range') return cleanWeekPercentRangeEntry(c, raw, where, ctx.weekSet);
  if (raw.structure !== undefined && raw.structure !== null) {
    c.error(where, `Exercise structure "${String(raw.structure)}" is not supported (use a flat entry, "week-percent-range" or "block-driven").`);
    return undefined;
  }
  return cleanFlatEntry(c, raw, where, ctx.totalWeeks);
}

/** Every week a cleaned entry is active in. */
function entryWeeks(entry) {
  if (entry.structure === 'block-driven' || entry.structure === 'week-percent-range') {
    return entry.weeklyVariants.map((v) => v.week);
  }
  return entry.weeks ?? [];
}

// ── weeks / days ──────────────────────────────────────────────────────────

const WEEK_KEYS = new Set(['week', 'cycle', 'isDeload', 'isPrAttempt', 'focusFromOverview', 'deadliftNotesFromBlock', 'notes']);

function cleanWeeks(c, raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    c.error('Weeks', '"weeks" must be a non-empty list (e.g. [{"week": 1}, {"week": 2}]).');
    return null;
  }
  if (raw.length > IMPORT_LIMITS.maxWeeks) {
    c.error('Weeks', `A program can have at most ${IMPORT_LIMITS.maxWeeks} weeks.`);
    return null;
  }
  const weeks = [];
  const seen = new Set();
  for (const [i, w] of raw.entries()) {
    const where = isPlainObject(w) && isPositiveInt(w.week) ? `Week ${w.week}` : `Weeks list, item ${i + 1}`;
    if (!isPlainObject(w) || !isPositiveInt(w.week)) {
      c.error(where, 'Each week needs a positive whole-number "week".');
      continue;
    }
    screenKeys(c, w, WEEK_KEYS, where);
    if (seen.has(w.week)) { c.error(where, `Week ${w.week} is listed twice.`); continue; }
    seen.add(w.week);
    const out = { week: w.week, isDeload: false, isPrAttempt: false };
    for (const flag of ['isDeload', 'isPrAttempt']) {
      if (w[flag] === undefined || w[flag] === null) continue;
      if (typeof w[flag] !== 'boolean') c.error(where, `"${flag}" must be true or false.`);
      else out[flag] = w[flag];
    }
    if (w.cycle != null) {
      if (!isPositiveInt(w.cycle)) c.error(where, '"cycle" must be a positive whole number.');
      else out.cycle = w.cycle;
    }
    for (const field of ['focusFromOverview', 'deadliftNotesFromBlock', 'notes']) {
      const t = optionalText(c, w[field], where, field, 300);
      if (t) out[field] = t;
    }
    weeks.push(out);
  }
  weeks.sort((a, b) => a.week - b.week);
  weeks.forEach((w, i) => {
    if (w.week !== i + 1) {
      c.error('Weeks', `Weeks must be numbered 1, 2, 3… with no gaps (found week ${w.week} where week ${i + 1} was expected).`);
    }
  });
  return weeks;
}

const DAY_KEYS = new Set(['id', 'order', 'name', 'sections']);
const SECTION_KEYS = new Set(['warmup', 'main', 'accessory', 'cooldown']);

function cleanSectionText(c, raw, where, label) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) { c.error(where, `${label} must be an object like {"text": "…"}.`); return undefined; }
  const text = optionalText(c, raw.text, where, `${label} text`, IMPORT_LIMITS.sectionTextLength);
  const source = optionalText(c, raw.source, where, `${label} source`, 40);
  if (text === undefined || source === undefined) return undefined;
  return { source: source ?? 'import', text: text ?? null };
}

function cleanDays(c, raw, { weeks }) {
  if (!Array.isArray(raw) || raw.length === 0) {
    c.error('Days', '"days" must be a non-empty list.');
    return null;
  }
  if (raw.length > IMPORT_LIMITS.maxDays) {
    c.error('Days', `A program can have at most ${IMPORT_LIMITS.maxDays} training days.`);
    return null;
  }
  const weekSet = new Set((weeks ?? []).map((w) => w.week));
  const totalWeeks = weeks?.length ? Math.max(...weeks.map((w) => w.week)) : 0;
  const days = [];
  const seenOrders = new Set();
  const seenIds = new Set();

  for (const [i, d] of raw.entries()) {
    const dayLabel = isPlainObject(d) && typeof d.name === 'string' && d.name.trim()
      ? `Day ${isPositiveInt(d.order) ? d.order : i + 1} (${scrubText(d.name).slice(0, 40)})`
      : `Day ${isPlainObject(d) && isPositiveInt(d.order) ? d.order : i + 1}`;
    if (!isPlainObject(d)) { c.error(dayLabel, 'Each day must be an object.'); continue; }
    screenKeys(c, d, DAY_KEYS, dayLabel);

    if (!isPositiveInt(d.order) || d.order > 99) {
      c.error(dayLabel, 'Each day needs an "order" (1, 2, 3…).');
    } else if (seenOrders.has(d.order)) {
      c.error(dayLabel, `Day order ${d.order} is used twice.`);
    } else {
      seenOrders.add(d.order);
    }
    const name = requiredText(c, d.name, dayLabel, 'Day name', IMPORT_LIMITS.dayNameLength);

    let id = d.id;
    if (id === undefined || id === null || id === '') {
      id = `day${isPositiveInt(d.order) ? d.order : i + 1}-${slugify(name ?? 'day')}`.slice(0, 64).replace(/-+$/, '');
    }
    id = checkId(c, id, dayLabel, 'Day id');
    if (id && seenIds.has(id)) { c.error(dayLabel, `Day id "${id}" is used twice.`); id = undefined; }
    if (id) seenIds.add(id);

    const sectionsIn = d.sections;
    if (!isPlainObject(sectionsIn)) {
      c.error(dayLabel, 'Each day needs "sections" with "main" and/or "accessory" exercise lists.');
      continue;
    }
    screenKeys(c, sectionsIn, SECTION_KEYS, loc([dayLabel, 'sections']));
    const sections = {};
    let dayOk = true;
    for (const sectionName of ['main', 'accessory']) {
      const list = sectionsIn[sectionName] ?? [];
      if (!Array.isArray(list)) {
        c.error(dayLabel, `"${sectionName}" must be a list of exercises.`);
        dayOk = false;
        continue;
      }
      if (list.length > IMPORT_LIMITS.maxEntriesPerSection) {
        c.error(dayLabel, `"${sectionName}" has too many exercises (max ${IMPORT_LIMITS.maxEntriesPerSection}).`);
        dayOk = false;
        continue;
      }
      sections[sectionName] = [];
      for (const [j, entry] of list.entries()) {
        const exLabel = `${sectionName === 'main' ? 'Main' : 'Accessory'} exercise ${j + 1}${isPlainObject(entry) && typeof entry.exerciseId === 'string' ? ` (${entry.exerciseId.slice(0, 40)})` : ''}`;
        const cleaned = cleanEntry(c, entry, loc([dayLabel, exLabel]), { weekSet, totalWeeks });
        if (cleaned === undefined) dayOk = false;
        else sections[sectionName].push(cleaned);
      }
    }
    for (const textSection of ['warmup', 'cooldown']) {
      const cleaned = cleanSectionText(c, sectionsIn[textSection], dayLabel, textSection === 'warmup' ? 'Warm-up' : 'Cool-down');
      if (cleaned === undefined) dayOk = false;
      else if (cleaned) sections[textSection] = cleaned;
    }
    if (dayOk && (sections.main?.length ?? 0) + (sections.accessory?.length ?? 0) === 0) {
      c.error(dayLabel, 'A day must have at least one exercise.');
      dayOk = false;
    }
    if (!dayOk || !id || !name || !isPositiveInt(d.order)) continue;
    days.push({ id, order: d.order, name, sections });
  }
  days.sort((a, b) => a.order - b.order);
  return days;
}

// ── roundingRules / exerciseLibrary ───────────────────────────────────────

function cleanRounding(c, raw) {
  const out = { barbell: 2.5, dumbbell: 1, machine: 2.5, bodyweight: 0 };
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) { c.error('Rounding rules', '"roundingRules" must be an object.'); return out; }
  for (const key of Object.keys(out)) {
    if (raw[key] === undefined || raw[key] === null) continue;
    if (!(isFiniteNumber(raw[key]) && raw[key] >= 0 && raw[key] <= 50)) {
      c.error('Rounding rules', `"${key}" must be a number between 0 and 50.`);
    } else {
      out[key] = raw[key];
    }
  }
  return out;
}

function cleanLibrary(c, raw, days) {
  const lib = [];
  const seen = new Set();
  if (Array.isArray(raw)) {
    for (const [i, item] of raw.entries()) {
      const where = `Exercise library, item ${i + 1}`;
      if (!isPlainObject(item)) { c.error(where, 'Each exercise library item must be an object.'); continue; }
      const id = checkId(c, item.id, where, 'Exercise id');
      const name = requiredText(c, item.name, where, 'Exercise name', IMPORT_LIMITS.exerciseNameLength);
      const cue = optionalText(c, item.cue, where, 'Cue', 300);
      let aliases = [];
      if (item.aliases != null) {
        if (!Array.isArray(item.aliases) || item.aliases.length > 20) {
          c.error(where, '"aliases" must be a list of at most 20 names.');
        } else {
          aliases = item.aliases
            .map((a) => (typeof a === 'string' ? scrubText(a).slice(0, IMPORT_LIMITS.exerciseNameLength) : null))
            .filter(Boolean);
        }
      }
      if (!id || !name || cue === undefined || seen.has(id)) continue;
      seen.add(id);
      lib.push({ id, name, aliases, cue: cue ?? null });
    }
  } else if (raw !== undefined && raw !== null) {
    c.error('Exercise library', '"exerciseLibrary" must be a list.');
  }
  // Only when the file has NO library: derive one from the exercises used,
  // so a file's own library is always stored exactly as given.
  if (Array.isArray(raw)) return lib;
  for (const day of days ?? []) {
    for (const entry of [...(day.sections.main ?? []), ...(day.sections.accessory ?? [])]) {
      if (!seen.has(entry.exerciseId)) {
        seen.add(entry.exerciseId);
        lib.push({ id: entry.exerciseId, name: entry.displayName, aliases: [entry.displayName], cue: null });
      }
    }
  }
  return lib; // file order kept; derived entries appended
}

// ── the single validator both formats go through ──────────────────────────

/**
 * Validates and sanitizes a program definition (the parsed JSON object, or
 * the object parseProgramCsvText builds). Never throws for bad input.
 *
 * @param {object} raw
 * @param {{existingProgramIds?: string[], sourceFormat?: 'json'|'csv', fileName?: string, programIdOverride?: string}} [opts]
 * @returns {{ ok: boolean, errors: Array<{where,message}>, warnings: Array<{where,message}>,
 *   conflict: null | { programId: string, suggestion: string },
 *   plan: null | { programId: string, program: object, days: Array<{id, data}> } }}
 *   `ok` is true only when there are no errors AND no id conflict.
 */
export function validateProgramDefinition(raw, {
  existingProgramIds = [], sourceFormat = 'json', fileName = null, programIdOverride = null,
} = {}) {
  const c = new Collector();
  const result = (plan = null, conflict = null) => ({
    ok: c.ok && !conflict && !!plan,
    errors: c.errors.slice(0, IMPORT_LIMITS.maxErrors),
    moreErrors: Math.max(0, c.errors.length - IMPORT_LIMITS.maxErrors),
    warnings: c.warnings,
    conflict,
    plan: c.ok ? plan : null,
  });

  if (!isPlainObject(raw)) {
    c.error('File', 'The file must contain one program object.');
    return result();
  }
  if (looksLikeBackup(raw)) {
    c.error('File', 'This looks like a "Backup My Data" file, not a program. Use Profile → Restore My Data for account backups; Program Import only accepts program files.');
    return result();
  }

  screenKeys(c, raw, KNOWN_TOP_LEVEL, 'Program');

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== PROGRAM_IMPORT_SCHEMA_VERSION) {
    c.error('Program', `Program schemaVersion ${String(raw.schemaVersion)} is not supported (this app reads schemaVersion ${PROGRAM_IMPORT_SCHEMA_VERSION}).`);
  }

  const name = requiredText(c, raw.name, 'Program', 'Program name', IMPORT_LIMITS.nameLength);
  let version = null;
  if (raw.version !== undefined && raw.version !== null) {
    if (typeof raw.version === 'number' && Number.isFinite(raw.version)) version = String(raw.version);
    else version = optionalText(c, raw.version, 'Program', 'Version', IMPORT_LIMITS.versionLength);
  }

  if (raw.id !== undefined && raw.programId !== undefined && raw.id !== raw.programId) {
    c.error('Program', `"id" ("${String(raw.id)}") and "programId" ("${String(raw.programId)}") disagree — use one of them.`);
  }
  let rawId = programIdOverride ?? raw.id ?? raw.programId;
  if ((rawId === undefined || rawId === null || rawId === '') && typeof name === 'string') {
    rawId = generateProgramId(name, []);
    c.warn('Program', `No program id in the file — using "${rawId}" (from the program name).`);
  }
  const programId = checkId(c, rawId, 'Program', 'Program id');

  const weeks = cleanWeeks(c, raw.weeks);
  const days = weeks ? cleanDays(c, raw.days, { weeks }) : null;
  const roundingRules = cleanRounding(c, raw.roundingRules);
  const exerciseLibrary = cleanLibrary(c, raw.exerciseLibrary, days);
  // The file's own provenance wins (e.g. the spreadsheet it was generated
  // from); the uploaded file's name is the fallback.
  const ownSource = optionalText(c, raw.sourceFile, 'Program', 'sourceFile', 120);
  const sourceFile = ownSource
    ?? (typeof fileName === 'string' && fileName ? scrubText(fileName).slice(0, 120) : null);

  // v1.1: optional program-level text — general notes and decision rules
  // (e.g. "If the top single is above RPE 8, drop the backoff 5%"). Shown on
  // the Program screen; never interpreted or executed.
  const programNotes = optionalText(c, raw.notes, 'Program', 'Program notes', IMPORT_LIMITS.programNotesLength);
  let decisionRules = [];
  if (raw.decisionRules !== undefined && raw.decisionRules !== null) {
    const list = typeof raw.decisionRules === 'string' ? [raw.decisionRules] : raw.decisionRules;
    if (!Array.isArray(list) || list.length > IMPORT_LIMITS.decisionRules) {
      c.error('Program', `"decisionRules" must be a list of at most ${IMPORT_LIMITS.decisionRules} rules.`);
    } else {
      list.forEach((rule, i) => {
        const t = optionalText(c, rule, `Decision rule ${i + 1}`, 'Rule', IMPORT_LIMITS.decisionRuleLength);
        if (t) decisionRules.push(t);
      });
    }
  }

  // Provenance, stored for reference only: the tool that generated the file,
  // and the 1RMs the program was written against. Import 1RMs are NEVER
  // applied to the user's own 1RMs (profile/maxes are never written) — every
  // % load resolves against the user's current 1RMs at workout start.
  const generatedBy = optionalText(c, raw.generatedBy, 'Program', 'generatedBy', 120);
  let importMaxes = null;
  if (raw.currentOneRepMaxesAtImport !== undefined && raw.currentOneRepMaxesAtImport !== null) {
    if (!isPlainObject(raw.currentOneRepMaxesAtImport) || Object.keys(raw.currentOneRepMaxesAtImport).length > 40) {
      c.error('Program', '"currentOneRepMaxesAtImport" must map exercise ids to kg values.');
    } else {
      importMaxes = {};
      for (const [id, kg] of Object.entries(raw.currentOneRepMaxesAtImport)) {
        if (!ID_PATTERN.test(id) || !(isFiniteNumber(kg) && kg > 0 && kg <= 500)) {
          c.error('Program', `"currentOneRepMaxesAtImport.${id.slice(0, 40)}" must be a kg value between 0 and 500 for a valid exercise id.`);
        } else {
          importMaxes[id] = kg;
        }
      }
    }
  }
  if (c.ignored.size) {
    c.warn('Program', `Ignored unrecognized field(s): ${[...c.ignored].sort().slice(0, 12).join(', ')}${c.ignored.size > 12 ? '…' : ''}.`);
  }

  if (weeks && days && c.ok) {
    for (const w of weeks) {
      const used = days.some((d) => [...(d.sections.main ?? []), ...(d.sections.accessory ?? [])]
        .some((e) => entryWeeks(e).includes(w.week)));
      if (!used) c.warn(`Week ${w.week}`, 'No exercises are scheduled in this week.');
    }
  }

  if (!c.ok || !programId || !weeks || !days) return result();

  const plan = {
    programId,
    program: {
      schemaVersion: PROGRAM_IMPORT_SCHEMA_VERSION,
      name,
      ...(version ? { version } : {}),
      sourceFile,
      roundingRules,
      weeks,
      exerciseLibrary,
      importReviewFlags: [],
      importSource: sourceFormat === 'csv' ? 'csv' : 'json',
      ...(programNotes ? { notes: programNotes } : {}),
      ...(decisionRules.length ? { decisionRules } : {}),
      ...(generatedBy ? { generatedBy } : {}),
      ...(importMaxes && Object.keys(importMaxes).length ? { currentOneRepMaxesAtImport: importMaxes } : {}),
    },
    days: days.map(({ id, ...data }) => ({ id, data })),
  };

  const conflict = existingProgramIds.includes(programId)
    ? { programId, suggestion: generateProgramId(programId, existingProgramIds) }
    : null;
  return result(plan, conflict);
}

/** A plan with its program id replaced (conflict resolution). Validates the new id; never mutates the input. */
export function withProgramId(validation, newId, existingProgramIds = []) {
  const id = typeof newId === 'string' ? newId.trim() : '';
  if (!ID_PATTERN.test(id)) {
    return { ok: false, error: 'Use lowercase letters, numbers and hyphens only (e.g. "my-program-v2").' };
  }
  if (existingProgramIds.includes(id)) {
    return { ok: false, error: `A program with id "${id}" already exists. Choose another id.` };
  }
  return {
    ok: true,
    validation: {
      ...validation,
      ok: validation.errors.length === 0,
      conflict: null,
      plan: { ...validation.plan, programId: id },
    },
  };
}

function looksLikeBackup(raw) {
  return typeof raw.exportedAt === 'string'
    && (Array.isArray(raw.programs) || Array.isArray(raw.workouts) || isPlainObject(raw.account));
}

// ── JSON entry point ──────────────────────────────────────────────────────

export function parseProgramJsonText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, data: null, errors: [{ where: 'File', message: 'The file is empty.' }] };
  }
  try {
    return { ok: true, data: JSON.parse(text.replace(/^﻿/, '')), errors: [] };
  } catch (err) {
    return { ok: false, data: null, errors: [{ where: 'File', message: `Not valid JSON: ${err.message}` }] };
  }
}

// ── CSV ───────────────────────────────────────────────────────────────────

/**
 * The documented CSV schema (one row = one exercise prescription in one
 * week on one day). Column names are case-insensitive; order doesn't matter.
 */
export const CSV_COLUMNS = [
  { name: 'programId', required: true, help: 'Program id — lowercase letters, numbers, hyphens. Same on every row.' },
  { name: 'programName', required: true, help: 'Program name. Same on every row (may be left blank after the first row).' },
  { name: 'version', required: false, help: 'Optional version label, e.g. 2 or 2026-10.' },
  { name: 'week', required: true, help: 'Week number, 1, 2, 3… with no gaps.' },
  { name: 'deload', required: false, help: 'Optional: true on a deload week (same value on every row of that week).' },
  { name: 'prAttempt', required: false, help: 'Optional: true on a PR-attempt week.' },
  { name: 'dayOrder', required: true, help: 'Training day number within the week, 1, 2, 3…' },
  { name: 'dayName', required: true, help: 'Day name, e.g. "Lower A". Same for a dayOrder in every week.' },
  { name: 'dayId', required: false, help: 'Optional stable day id; generated from dayOrder + dayName if blank.' },
  { name: 'section', required: false, help: 'main (default) or accessory. Main exercises are listed first.' },
  { name: 'exerciseOrder', required: true, help: 'Position of the exercise within the day, 1, 2, 3…' },
  { name: 'exerciseId', required: true, help: 'Exercise id, e.g. deadlift, bench-press. Used to link 1RMs and progress.' },
  { name: 'exerciseName', required: true, help: 'Name shown in the app.' },
  { name: 'sets', required: true, help: 'Number of sets (1–50).' },
  { name: 'reps', required: false, help: 'Reps: 5, or a range like 6-8. Leave blank for timed holds.' },
  { name: 'durationSec', required: false, help: 'Seconds per set for timed holds (e.g. 30).' },
  { name: 'loadType', required: true, help: 'none | bodyweight | fixed | percent | percentRange' },
  { name: 'loadValue', required: false, help: 'fixed: kg (e.g. 40). percent: % of 1RM (e.g. 75). percentRange: e.g. 70-75.' },
  { name: 'loadUnit', required: false, help: 'kg (default for fixed), kg/hand (per-hand dumbbells), or % (default for percent types).' },
  { name: 'percentOf', required: false, help: 'Optional exerciseId whose 1RM a % is based on (default: the exercise itself).' },
  { name: 'rpe', required: false, help: 'Optional target RPE (0–10).' },
  { name: 'rir', required: false, help: 'Optional target reps in reserve (0–10).' },
  { name: 'notes', required: false, help: 'Optional notes shown with the exercise.' },
];

export const CSV_TEMPLATE = [
  'programId,programName,version,week,deload,dayOrder,dayName,section,exerciseOrder,exerciseId,exerciseName,sets,reps,durationSec,loadType,loadValue,loadUnit,percentOf,rpe,notes',
  'my-strength-block,My Strength Block,1,1,,1,Lower A,main,1,deadlift,Deadlift,4,5,,percent,75,%,,7,',
  'my-strength-block,,,1,,1,Lower A,accessory,2,romanian-deadlift,Romanian Deadlift,3,8,,percentRange,55-60,%,deadlift,,Controlled eccentric',
  'my-strength-block,,,1,,1,Lower A,accessory,3,core-plank,Plank,3,,45,bodyweight,,,,,',
  'my-strength-block,,,1,,2,Upper A,main,1,bench-press,Bench Press,4,6-8,,percent,72.5,%,,,',
  'my-strength-block,,,1,,2,Upper A,accessory,2,db-row,DB Row,3,10,,fixed,30,kg/hand,,,',
  'my-strength-block,,,2,true,1,Lower A,main,1,deadlift,Deadlift,3,5,,percent,65,%,,6,Deload',
  'my-strength-block,,,2,true,1,Lower A,accessory,2,romanian-deadlift,Romanian Deadlift,2,8,,percentRange,50-55,%,deadlift,,',
  'my-strength-block,,,2,true,2,Upper A,main,1,bench-press,Bench Press,3,6,,percent,65,%,,,Deload',
  'my-strength-block,,,2,true,2,Upper A,accessory,2,db-row,DB Row,2,10,,fixed,30,kg/hand,,,',
].join('\r\n') + '\r\n';

const IGNORED_CSV_COLUMNS = new Set(['restsec']);

/** Strict number parse for a CSV cell; accepts "72,5" as a decimal comma. Returns NaN for anything else. */
function csvNumber(cell) {
  const s = String(cell).trim().replace(/^(\d+),(\d+)$/, '$1.$2');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}
function csvRange(cell) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*$/.exec(String(cell));
  return m ? [csvNumber(m[1]), csvNumber(m[2])] : null;
}
function csvBool(cell) {
  const s = String(cell ?? '').trim().toLowerCase();
  if (s === '') return null;
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return undefined;
}

/**
 * Parses the CSV text into the SAME program-definition object shape the
 * JSON format uses (flat entries only), for validateProgramDefinition to
 * validate exactly like a JSON file. Row-level problems are returned as
 * errors with the row number (spreadsheet line) and week/day/exercise.
 */
export function parseProgramCsvText(text) {
  const c = new Collector();
  const fail = () => ({ ok: false, data: null, errors: c.errors.slice(0, IMPORT_LIMITS.maxErrors), moreErrors: Math.max(0, c.errors.length - IMPORT_LIMITS.maxErrors), warnings: c.warnings });

  const { rows, error } = parseCsv(text);
  if (error) { c.error('File', `Not valid CSV: ${error}`); return fail(); }
  if (rows.length < 2) { c.error('File', 'The CSV needs a header row and at least one data row.'); return fail(); }
  if (rows.length - 1 > IMPORT_LIMITS.maxCsvRows) { c.error('File', `Too many rows (max ${IMPORT_LIMITS.maxCsvRows}).`); return fail(); }

  const header = rows[0].map((h) => scrubText(h));
  const index = new Map();
  const known = new Map(CSV_COLUMNS.map((col) => [col.name.toLowerCase(), col.name]));
  header.forEach((h, i) => {
    const key = h.toLowerCase();
    if (known.has(key)) {
      if (index.has(known.get(key))) c.error('Header', `Column "${h}" appears twice.`);
      else index.set(known.get(key), i);
    } else if (IGNORED_CSV_COLUMNS.has(key)) {
      index.set(`__ignored:${key}`, i);
    } else if (key) {
      c.warn('Header', `Unknown column "${h.slice(0, 40)}" was ignored.`);
    }
  });
  const missing = CSV_COLUMNS.filter((col) => col.required && !index.has(col.name)).map((col) => col.name);
  if (missing.length) c.error('Header', `Missing required column(s): ${missing.join(', ')}.`);
  if (!c.ok) return fail();

  const cell = (row, name) => {
    const i = index.get(name);
    return i === undefined ? '' : scrubText(String(row[i] ?? ''));
  };

  let programId = null;
  let programName = null;
  let version = null;
  const weekFlags = new Map(); // week -> {isDeload, isPrAttempt}
  const dayInfo = new Map(); // dayOrder -> {name, id}
  const occupied = new Set(); // week|day|order
  const parsedRows = [];
  let restSecWarned = false;

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const line = r + 1;
    if (row.every((v) => scrubText(String(v ?? '')) === '')) continue;
    if (row.length > header.length) {
      c.error(`Row ${line}`, `Has ${row.length} values but the header has ${header.length} columns (check for an unquoted comma).`);
      continue;
    }

    const weekCell = cell(row, 'week');
    const dayCell = cell(row, 'dayOrder');
    const orderCell = cell(row, 'exerciseOrder');
    const exIdCell = cell(row, 'exerciseId');
    const where = `Row ${line} (week ${weekCell || '?'}, day ${dayCell || '?'}, exercise ${orderCell || '?'}${exIdCell ? ` ${exIdCell.slice(0, 40)}` : ''})`;
    const before = c.errors.length;
    const bad = (msg) => c.error(where, msg);

    // Program-level values: first non-blank wins; later non-blank must match.
    const pid = cell(row, 'programId');
    if (pid) {
      if (programId === null) programId = pid;
      else if (pid !== programId) bad(`programId "${pid}" differs from "${programId}" on an earlier row.`);
    }
    const pname = cell(row, 'programName');
    if (pname) {
      if (programName === null) programName = pname;
      else if (pname !== programName) bad(`programName "${pname}" differs from "${programName}" on an earlier row.`);
    }
    const ver = cell(row, 'version');
    if (ver) {
      if (version === null) version = ver;
      else if (ver !== version) bad(`version "${ver}" differs from "${version}" on an earlier row.`);
    }

    const week = csvNumber(weekCell);
    if (!isPositiveInt(week) || week > IMPORT_LIMITS.maxWeeks) bad(`"week" must be a whole number from 1 to ${IMPORT_LIMITS.maxWeeks}.`);
    const dayOrder = csvNumber(dayCell);
    if (!isPositiveInt(dayOrder) || dayOrder > 99) bad('"dayOrder" must be a whole number from 1 to 99.');
    const exerciseOrder = csvNumber(orderCell);
    if (!isPositiveInt(exerciseOrder) || exerciseOrder > 999) bad('"exerciseOrder" must be a whole number from 1 to 999.');

    if (isPositiveInt(week)) {
      const flags = weekFlags.get(week) ?? { isDeload: null, isPrAttempt: null };
      for (const [col, key] of [['deload', 'isDeload'], ['prAttempt', 'isPrAttempt']]) {
        const v = csvBool(cell(row, col));
        if (v === undefined) bad(`"${col}" must be true or false.`);
        else if (v !== null) {
          if (flags[key] !== null && flags[key] !== v) bad(`"${col}" disagrees with another row of week ${week}.`);
          flags[key] = v;
        }
      }
      weekFlags.set(week, flags);
    }

    const dayName = cell(row, 'dayName');
    const dayId = cell(row, 'dayId');
    if (isPositiveInt(dayOrder)) {
      const info = dayInfo.get(dayOrder) ?? { name: null, id: null };
      if (dayName) {
        if (info.name === null) info.name = dayName;
        else if (info.name !== dayName) bad(`dayName "${dayName}" differs from "${info.name}" used for day ${dayOrder} on an earlier row.`);
      }
      if (dayId) {
        if (info.id === null) info.id = dayId;
        else if (info.id !== dayId) bad(`dayId "${dayId}" differs from "${info.id}" used for day ${dayOrder} on an earlier row.`);
      }
      dayInfo.set(dayOrder, info);
    }

    if (isPositiveInt(week) && isPositiveInt(dayOrder) && isPositiveInt(exerciseOrder)) {
      const key = `${week}|${dayOrder}|${exerciseOrder}`;
      if (occupied.has(key)) bad(`Week ${week}, day ${dayOrder} already has an exercise at position ${exerciseOrder}.`);
      occupied.add(key);
    }

    const sectionRaw = cell(row, 'section').toLowerCase();
    const section = sectionRaw === '' ? 'main' : sectionRaw;
    if (!['main', 'accessory'].includes(section)) bad('"section" must be main or accessory.');

    if (!exIdCell) bad('"exerciseId" is required.');
    else if (!ID_PATTERN.test(exIdCell)) bad(`exerciseId "${exIdCell.slice(0, 40)}" is not valid — use lowercase letters, numbers and hyphens (e.g. bench-press).`);
    const exerciseName = cell(row, 'exerciseName');
    if (!exerciseName) bad('"exerciseName" is required.');

    const sets = csvNumber(cell(row, 'sets'));
    if (!isPositiveInt(sets) || sets > 50) bad('"sets" must be a whole number from 1 to 50.');

    const repsCell = cell(row, 'reps');
    let reps = null;
    if (repsCell) {
      const range = csvRange(repsCell);
      if (range) {
        if (!isPositiveInt(range[0]) || !isPositiveInt(range[1]) || range[0] > range[1]) bad('"reps" range must be like 6-8 (whole numbers, low to high).');
        else reps = { min: range[0], max: range[1] };
      } else {
        const n = csvNumber(repsCell);
        if (!isPositiveInt(n) || n > 200) bad('"reps" must be a whole number (1–200) or a range like 6-8.');
        else reps = n;
      }
    }
    const durCell = cell(row, 'durationSec');
    let durationSec = null;
    if (durCell) {
      const n = csvNumber(durCell);
      if (!(n > 0 && n <= 3600)) bad('"durationSec" must be a number of seconds from 1 to 3600.');
      else durationSec = n;
    }

    const loadType = cell(row, 'loadType');
    const loadValue = cell(row, 'loadValue');
    const loadUnit = cell(row, 'loadUnit').toLowerCase();
    const percentOf = cell(row, 'percentOf');
    let load = null;
    switch (loadType) {
      case 'none':
      case 'bodyweight':
        if (loadValue) bad(`"loadValue" must be blank for loadType ${loadType}.`);
        load = { type: loadType };
        break;
      case 'fixed': {
        const kg = csvNumber(loadValue);
        if (!(kg >= 0 && kg <= 500)) bad('fixed load needs "loadValue" in kg from 0 to 500.');
        if (!['', 'kg', 'kg/hand'].includes(loadUnit)) bad('"loadUnit" for a fixed load must be kg or kg/hand.');
        load = { type: 'fixed', kg, ...(loadUnit === 'kg/hand' ? { perHand: true } : {}) };
        break;
      }
      case 'percent': {
        const pct = csvNumber(loadValue);
        if (!(pct > 0 && pct <= 300)) bad('percent load needs "loadValue" as a percentage of 1RM (e.g. 75).');
        if (!['', '%'].includes(loadUnit)) bad('"loadUnit" for a percent load must be %.');
        load = { type: 'percent', percent: Math.round((pct / 100) * 10000) / 10000 };
        break;
      }
      case 'percentRange': {
        const range = csvRange(loadValue);
        if (!range || !(range[0] > 0 && range[1] <= 300 && range[0] <= range[1])) bad('percentRange load needs "loadValue" like 70-75 (percent of 1RM, low to high).');
        if (!['', '%'].includes(loadUnit)) bad('"loadUnit" for a percentRange load must be %.');
        load = range ? {
          type: 'percentRange',
          min: Math.round((range[0] / 100) * 10000) / 10000,
          max: Math.round((range[1] / 100) * 10000) / 10000,
        } : null;
        break;
      }
      default:
        bad(`"loadType" must be one of: ${LOAD_TYPES.join(', ')}.`);
    }
    if (percentOf) {
      if (!load || !['percent', 'percentRange'].includes(load.type)) bad('"percentOf" only applies to percent or percentRange loads.');
      else if (!ID_PATTERN.test(percentOf)) bad(`percentOf "${percentOf.slice(0, 40)}" is not a valid exerciseId.`);
      else load.of = percentOf;
    }

    let rpe = null;
    const rpeCell = cell(row, 'rpe');
    if (rpeCell) { rpe = csvNumber(rpeCell); if (!(rpe > 0 && rpe <= 10)) bad('"rpe" must be a number from 0 to 10.'); }
    let rir = null;
    const rirCell = cell(row, 'rir');
    if (rirCell) { rir = csvNumber(rirCell); if (!(rir >= 0 && rir <= 10)) bad('"rir" must be a number from 0 to 10.'); }
    const notes = cell(row, 'notes') || null;

    if (!restSecWarned && index.has('__ignored:restsec') && scrubText(String(row[index.get('__ignored:restsec')] ?? ''))) {
      c.warn('Header', '"restSec" is not part of this app\'s program model (rest times are a global setting), so it was ignored.');
      restSecWarned = true;
    }

    if (c.errors.length === before) {
      parsedRows.push({ line, week, dayOrder, exerciseOrder, section, exerciseId: exIdCell, exerciseName, sets, reps, durationSec, load, rpe, rir, notes });
    }
  }

  if (!programId) c.error('File', '"programId" is blank on every row.');
  if (!programName) c.error('File', '"programName" is blank on every row.');
  for (const [order, info] of dayInfo) {
    if (!info.name) c.error(`Day ${order}`, '"dayName" is blank on every row for this day.');
  }
  if (!parsedRows.length && c.ok) c.error('File', 'No exercise rows found.');
  if (!c.ok) return fail();

  const weekNumbers = [...weekFlags.keys()].sort((a, b) => a - b);
  const maxWeek = weekNumbers.at(-1);
  for (let w = 1; w <= maxWeek; w += 1) {
    if (!weekFlags.has(w)) c.error(`Week ${w}`, `No rows for week ${w} — weeks must be 1…${maxWeek} with no gaps.`);
  }
  if (!c.ok) return fail();

  // Group identical prescriptions across weeks into ONE flat entry with a
  // `weeks` list — exactly how the native JSON represents a lift that
  // repeats unchanged week to week.
  const days = [...dayInfo.keys()].sort((a, b) => a - b).map((order) => {
    const info = dayInfo.get(order);
    const groups = new Map();
    for (const row of parsedRows.filter((pr) => pr.dayOrder === order)) {
      const signature = JSON.stringify([row.section, row.exerciseOrder, row.exerciseId, row.exerciseName, row.sets, row.reps, row.durationSec, row.load, row.rpe, row.rir, row.notes]);
      const g = groups.get(signature) ?? { ...row, weeks: [] };
      g.weeks.push(row.week);
      groups.set(signature, g);
    }
    const toEntry = (g) => ({
      exerciseId: g.exerciseId,
      displayName: g.exerciseName,
      sets: g.sets,
      reps: g.reps,
      durationSec: g.durationSec,
      load: g.load,
      notes: g.notes,
      rpe: g.rpe,
      rir: g.rir,
      weeks: g.weeks.sort((a, b) => a - b),
    });
    const sortKey = (a, b) => (a.exerciseOrder - b.exerciseOrder) || (a.weeks[0] - b.weeks[0]);
    const all = [...groups.values()];

    for (const w of weekNumbers) {
      const inWeek = parsedRows.filter((pr) => pr.dayOrder === order && pr.week === w);
      if (!inWeek.length) c.warn(`Week ${w} · Day ${order} (${info.name})`, 'No exercises in this week — that session will have nothing to log.');
      const maxMain = Math.max(0, ...inWeek.filter((pr) => pr.section === 'main').map((pr) => pr.exerciseOrder));
      const minAcc = Math.min(Infinity, ...inWeek.filter((pr) => pr.section === 'accessory').map((pr) => pr.exerciseOrder));
      if (maxMain > minAcc) c.warn(`Week ${w} · Day ${order} (${info.name})`, 'A main exercise is ordered after an accessory; main exercises are always shown first.');
    }

    return {
      ...(info.id ? { id: info.id } : {}),
      order,
      name: info.name,
      sections: {
        main: all.filter((g) => g.section === 'main').sort(sortKey).map(toEntry),
        accessory: all.filter((g) => g.section === 'accessory').sort(sortKey).map(toEntry),
      },
    };
  });

  const data = {
    schemaVersion: PROGRAM_IMPORT_SCHEMA_VERSION,
    id: programId,
    name: programName,
    ...(version ? { version } : {}),
    weeks: weekNumbers.map((w) => ({
      week: w,
      isDeload: weekFlags.get(w).isDeload === true,
      isPrAttempt: weekFlags.get(w).isPrAttempt === true,
    })),
    days,
  };
  return { ok: true, data, errors: [], warnings: c.warnings };
}

// ── format detection + one-call entry point ───────────────────────────────

export function detectImportFormat(fileName, text) {
  const lower = String(fileName ?? '').toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.csv')) return 'csv';
  const head = String(text ?? '').replace(/^﻿/, '').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (head) return 'csv';
  return null;
}

/**
 * Parse + validate in one call: what the Import screen runs on a chosen
 * file. Never throws; never touches Firestore.
 */
export function prepareProgramImport({ fileName, text, byteLength = null, existingProgramIds = [] }) {
  const size = byteLength ?? (typeof text === 'string' ? new TextEncoder().encode(text).length : 0);
  const failed = (where, message, format = null) => ({
    ok: false, format, errors: [{ where, message }], moreErrors: 0, warnings: [], conflict: null, plan: null,
  });
  if (size > IMPORT_LIMITS.maxFileBytes) return failed('File', `The file is too large (max ${Math.round(IMPORT_LIMITS.maxFileBytes / 1024)} KB).`);
  const format = detectImportFormat(fileName, text);
  if (!format) return failed('File', 'The file is empty.');

  const parsed = format === 'json' ? parseProgramJsonText(text) : parseProgramCsvText(text);
  if (!parsed.ok) {
    return {
      ok: false, format, errors: parsed.errors, moreErrors: parsed.moreErrors ?? 0, warnings: parsed.warnings ?? [], conflict: null, plan: null,
    };
  }
  const validation = validateProgramDefinition(parsed.data, {
    existingProgramIds, sourceFormat: format, fileName,
  });
  return { ...validation, format, warnings: [...(parsed.warnings ?? []), ...validation.warnings] };
}

// ── preview summary ───────────────────────────────────────────────────────

function percentBasesOfEntry(entry) {
  const bases = [];
  const add = (load, fallbackId) => {
    if (load && (load.type === 'percent' || load.type === 'percentRange')) bases.push(load.of || fallbackId);
  };
  if (entry.structure === 'block-driven') {
    for (const v of entry.weeklyVariants) {
      add(v.topSingle?.load, entry.exerciseId);
      add(v.backoff?.load, entry.exerciseId);
      add(v.sgdl?.load, 'snatch-grip-deadlift');
    }
  } else if (entry.structure === 'week-percent-range') {
    for (const v of entry.weeklyVariants) add(v.load, entry.exerciseId);
  } else {
    add(entry.load, entry.exerciseId);
  }
  return bases;
}

function loadTypesOfEntry(entry) {
  if (entry.structure === 'block-driven') return ['percent'];
  if (entry.structure === 'week-percent-range') return entry.weeklyVariants.map((v) => v.load.type);
  return [entry.load?.type ?? 'none'];
}

/**
 * Everything the preview step shows, derived from a validated plan only.
 * `currentMaxes` (the user's profile currentMaxes) is read to tell the user
 * which % loads will be computable right away — it is never written.
 */
export function summarizeImportPlan(plan, { currentMaxes = {} } = {}) {
  const { program, days } = plan;
  const exercises = new Map();
  const loadTypeCounts = {};
  const bases = new Map();
  let rpeTargets = 0;
  let warmupRamps = 0;
  const daySummaries = days.map(({ id, data }) => {
    const entries = [...(data.sections.main ?? []), ...(data.sections.accessory ?? [])];
    for (const e of entries) {
      if (!exercises.has(e.exerciseId)) exercises.set(e.exerciseId, e.displayName);
      for (const t of loadTypesOfEntry(e)) loadTypeCounts[t] = (loadTypeCounts[t] ?? 0) + 1;
      for (const b of percentBasesOfEntry(e)) bases.set(b, (bases.get(b) ?? 0) + 1);
      if (e.rpe != null) rpeTargets += 1;
      if (e.structure === 'block-driven' && e.weeklyVariants.some((v) => v.warmupSets?.length)) warmupRamps += 1;
    }
    return {
      id,
      order: data.order,
      name: data.name,
      exerciseNames: [...new Set(entries.map((e) => e.displayName))],
      entryCount: entries.length,
    };
  });
  return {
    programId: plan.programId,
    name: program.name,
    version: program.version,
    format: program.importSource,
    weekCount: program.weeks.length,
    deloadWeeks: program.weeks.filter((w) => w.isDeload).map((w) => w.week),
    prWeeks: program.weeks.filter((w) => w.isPrAttempt).map((w) => w.week),
    dayCount: days.length,
    days: daySummaries,
    exercises: [...exercises.entries()].map(([exerciseId, name]) => ({ exerciseId, name })),
    loadTypeCounts,
    percentBases: [...bases.keys()].sort().map((exerciseId) => ({
      exerciseId,
      name: exercises.get(exerciseId) ?? null,
      hasCurrentMax: typeof currentMaxes?.[exerciseId]?.kg === 'number',
    })),
    rpeTargets,
    warmupRamps,
    roundingRules: program.roundingRules,
    programNotes: program.notes ?? null,
    decisionRules: program.decisionRules ?? [],
    importMaxes: program.currentOneRepMaxesAtImport ?? null,
    generatedBy: program.generatedBy ?? null,
    sourceFile: program.sourceFile ?? null,
  };
}
