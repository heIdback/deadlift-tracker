// v27 — "Export for analysis": builds ONE compact JSON document that a person
// (or Claude, in a chat) can read to judge training progress.
//
// Pure and Firebase-free: the service (js/services/analysisExportService.js)
// fetches the raw records and hands them in; nothing here reads or writes the
// database. It reuses the app's own analytics rules (progressAnalytics.js,
// setLogging.js, prAnalytics.js, calculations.js) so the numbers in the file
// are the same numbers the Progress screen shows.
//
// Privacy: no email, no user id, no display name. Only training data.
import { epleyEstimate1RM } from './calculations.js';
import {
  chronological, isMeaningfulWorkingSet, isEstimated1RMEligible, toMillis,
  EST_1RM_MAX_REPS,
} from './progressAnalytics.js';
import { bestTestedOneRepMax, bestEstimatedOneRepMax } from './prAnalytics.js';
import { resolveSetStatus } from './setLogging.js';
import { resolveCompletionState, EXPLICIT_SKIP_STATE } from './workoutCompletion.js';
import { totalWeeksOf } from './programEditModel.js';
import { REQUIRED_STARTER_LIFTS } from './requiredLifts.js';

export const ANALYSIS_SCHEMA = 'deadlift-tracker/analysis-export';
export const ANALYSIS_SCHEMA_VERSION = 1;
export const RANGE_MODE = Object.freeze({ SINCE_LAST: 'since_last_export', ALL: 'all' });

const round1 = (n) => Math.round(n * 10) / 10;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** ms → ISO string (UTC), or null when unknown. */
export function isoOrNull(ms) {
  return isNum(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** ms → 'YYYY-MM-DD' in the given IANA time zone (the lifter's calendar day), or null. */
export function dayKey(ms, timeZone = 'Europe/Zagreb') {
  if (!isNum(ms) || ms <= 0) return null;
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * Which workouts belong in the detailed window.
 * since_last_export: finished after `sinceMillis`, plus any whose finish time
 * is not known yet (a server timestamp still pending) — those are never
 * silently dropped.
 */
export function selectWindowWorkouts(completedWorkouts, { mode, sinceMillis }) {
  const all = [...(completedWorkouts ?? [])]
    .sort((a, b) => toMillis(a.finishedAt) - toMillis(b.finishedAt));
  if (mode !== RANGE_MODE.SINCE_LAST || !isNum(sinceMillis) || sinceMillis <= 0) return all;
  return all.filter((w) => {
    const t = toMillis(w.finishedAt);
    return t === 0 || t > sinceMillis;
  });
}

function setRow(s) {
  const row = {
    n: s.setNumber ?? null,
    kind: s.kind === 'warmup' ? 'warmup' : 'working',
    plannedKg: isNum(s.plannedKg) ? s.plannedKg : null,
    plannedReps: isNum(s.plannedReps) ? s.plannedReps : null,
    kg: isNum(s.actualKg) ? s.actualKg : null,
    reps: isNum(s.actualReps) ? s.actualReps : null,
    rpe: isNum(s.rpe) ? s.rpe : null,
    status: resolveSetStatus(s) ?? 'not_logged',
  };
  if (typeof s.note === 'string' && s.note.trim()) row.note = s.note.trim();
  return row;
}

/** Best/volume summary of the counted (analytics-eligible) working sets of one exercise entry. */
function exerciseSummary(ex) {
  const counted = (ex.sets ?? []).filter(isMeaningfulWorkingSet);
  if (!counted.length) return null;
  let top = counted[0];
  let volume = 0;
  let bestE1rm = null;
  for (const s of counted) {
    if (s.actualKg > top.actualKg) top = s;
    volume += s.actualKg * s.actualReps;
    if (isEstimated1RMEligible(s)) {
      const e = epleyEstimate1RM(s.actualKg, s.actualReps);
      if (bestE1rm == null || e > bestE1rm) bestE1rm = e;
    }
  }
  return {
    countedSets: counted.length,
    topKg: top.actualKg,
    topReps: top.actualReps,
    volumeKg: round1(volume),
    bestE1rmKg: bestE1rm == null ? null : round1(bestE1rm),
  };
}

function workoutEntry(w, timeZone) {
  const finishedMs = toMillis(w.finishedAt);
  const startedMs = toMillis(w.startedAt);
  const state = resolveCompletionState(w);
  const entry = {
    id: w.id ?? null,
    date: dayKey(finishedMs || startedMs, timeZone),
    startedAt: isoOrNull(startedMs),
    finishedAt: isoOrNull(finishedMs),
    durationMin: isNum(w.durationSec) && w.durationSec > 0 ? Math.round(w.durationSec / 60) : null,
    week: w.week ?? null,
    dayOrder: w.dayOrder ?? null,
    dayName: w.dayName ?? null,
    completionState: state,
  };
  if (state === EXPLICIT_SKIP_STATE) {
    entry.skipReason = typeof w.skipReason === 'string' && w.skipReason.trim() ? w.skipReason.trim() : null;
    entry.exercises = [];
  } else {
    entry.exercises = (w.exercises ?? []).map((ex) => ({
      exerciseId: ex.exerciseId ?? null,
      name: ex.displayNameAtStart ?? ex.displayName ?? ex.exerciseId ?? null,
      prescribed: ex.prescribed ?? null,
      summary: exerciseSummary(ex),
      sets: (ex.sets ?? []).map(setRow),
    }));
  }
  if (typeof w.notes === 'string' && w.notes.trim()) entry.note = w.notes.trim();
  return entry;
}

/**
 * Compact all-history trend per exercise: one point per workout in which the
 * exercise had counted working sets. {d: day, topKg, topReps, volumeKg, e1rmKg}.
 */
export function buildTrends(completedWorkouts, timeZone = 'Europe/Zagreb') {
  const byId = new Map();
  for (const w of chronological(completedWorkouts)) {
    const perExercise = new Map();
    for (const ex of w.exercises ?? []) {
      if (!ex.exerciseId) continue;
      const counted = (ex.sets ?? []).filter(isMeaningfulWorkingSet);
      if (!counted.length) continue;
      if (!perExercise.has(ex.exerciseId)) perExercise.set(ex.exerciseId, { name: null, sets: [] });
      const slot = perExercise.get(ex.exerciseId);
      slot.name = ex.displayNameAtStart ?? slot.name;
      slot.sets.push(...counted);
    }
    for (const [exerciseId, { name, sets }] of perExercise) {
      let top = sets[0];
      let volume = 0;
      let e1rm = null;
      for (const s of sets) {
        if (s.actualKg > top.actualKg) top = s;
        volume += s.actualKg * s.actualReps;
        if (isEstimated1RMEligible(s)) {
          const e = epleyEstimate1RM(s.actualKg, s.actualReps);
          if (e1rm == null || e > e1rm) e1rm = e;
        }
      }
      if (!byId.has(exerciseId)) byId.set(exerciseId, { exerciseId, name, points: [] });
      const t = byId.get(exerciseId);
      t.name = name ?? t.name;
      t.points.push({
        d: dayKey(toMillis(w.finishedAt), timeZone),
        topKg: top.actualKg,
        topReps: top.actualReps,
        volumeKg: round1(volume),
        e1rmKg: e1rm == null ? null : round1(e1rm),
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.points.length - a.points.length || a.exerciseId.localeCompare(b.exerciseId));
}

function bodyweightRows(records, { sinceMillis, timeZone, windowed }) {
  const sorted = [...(records ?? [])]
    .filter((m) => isNum(m.value))
    .sort((a, b) => toMillis(a.date) - toMillis(b.date));
  let picked = sorted;
  if (windowed) {
    const inWindow = sorted.filter((m) => toMillis(m.date) === 0 || toMillis(m.date) > sinceMillis);
    const before = sorted.filter((m) => toMillis(m.date) !== 0 && toMillis(m.date) <= sinceMillis).at(-1);
    // One earlier point is kept as a reference to compare against — but only when there is something new to compare.
    picked = before && inWindow.length ? [before, ...inWindow] : inWindow;
  }
  return picked.map((m) => {
    const row = { date: dayKey(toMillis(m.date), timeZone), kg: m.value };
    if (typeof m.note === 'string' && m.note.trim()) row.note = m.note.trim();
    return row;
  });
}

function maxHistoryRows(records, timeZone) {
  return [...(records ?? [])]
    .sort((a, b) => toMillis(a.effectiveDate) - toMillis(b.effectiveDate))
    .map((m) => ({
      date: dayKey(toMillis(m.effectiveDate), timeZone),
      exerciseId: m.exerciseId ?? null,
      kg: isNum(m.kg) ? m.kg : null,
      kind: m.kind ?? null,
      source: typeof m.source === 'string' && m.source.startsWith('workout:') ? 'workout' : (m.source ?? null),
    }));
}

/**
 * The marker for "since last analysis": the newest instant this export
 * covers (latest known workout finish or bodyweight entry inside it).
 * null when the export holds nothing with a known time — then the marker is
 * left alone, so an empty export can never move it forward.
 */
export function computeThroughMillis(workouts, bodyweightRecords, sinceMillis) {
  let max = 0;
  for (const w of workouts ?? []) max = Math.max(max, toMillis(w.finishedAt));
  for (const m of bodyweightRecords ?? []) {
    const t = toMillis(m.date);
    if (!isNum(sinceMillis) || t > sinceMillis) max = Math.max(max, t);
  }
  return max > 0 ? max : null;
}

/**
 * @param {object} a
 * @param {Array}  a.completedWorkouts  every completed workout fetched (any order)
 * @param {Array}  a.bodyweight         bodyweight measurement records (any order)
 * @param {Array}  a.maxHistory         1RM history records (any order)
 * @param {object} a.profile            user profile doc (uses currentMaxes, goals)
 * @param {object} a.program            active program doc or null
 * @param {object} a.run                active program run or null
 * @param {string} a.mode               RANGE_MODE.*
 * @param {number} a.sinceMillis        previous marker (ms) or 0
 * @param {number} a.nowMillis
 * @param {boolean} a.historyTruncated  true when the workout fetch hit its limit
 * @param {{name:string, version:string}} a.app
 */
export function buildAnalysisExport({
  completedWorkouts, bodyweight, maxHistory, profile, program, run,
  mode = RANGE_MODE.SINCE_LAST, sinceMillis = 0, nowMillis = Date.now(),
  historyTruncated = false, app = {}, timeZone = 'Europe/Zagreb',
}) {
  const windowed = mode === RANGE_MODE.SINCE_LAST && isNum(sinceMillis) && sinceMillis > 0;
  const windowWorkouts = selectWindowWorkouts(completedWorkouts, { mode, sinceMillis });
  const windowBodyweightRecords = windowed
    ? (bodyweight ?? []).filter((m) => toMillis(m.date) === 0 || toMillis(m.date) > sinceMillis)
    : (bodyweight ?? []);

  const performed = windowWorkouts.filter((w) => resolveCompletionState(w) !== EXPLICIT_SKIP_STATE);
  const skipped = windowWorkouts.length - performed.length;

  const lifts = REQUIRED_STARTER_LIFTS.map((l) => {
    const cm = profile?.currentMaxes?.[l.id];
    return {
      exerciseId: l.id,
      label: l.label,
      currentOneRmKg: isNum(cm?.kg) ? cm.kg : null,
      currentOneRmKind: cm?.kind ?? null,
      currentOneRmSetOn: dayKey(toMillis(cm?.updatedAt), timeZone),
      bestTestedSingleKg: bestTestedOneRepMax(completedWorkouts, l.id),
      bestEstimatedOneRmKg: (() => {
        const e = bestEstimatedOneRepMax(completedWorkouts, l.id);
        return e == null ? null : round1(e);
      })(),
      goalKg: isNum(profile?.goals?.[l.id]) ? profile.goals[l.id] : null,
    };
  });

  const latestBw = [...(bodyweight ?? [])]
    .filter((m) => isNum(m.value))
    .sort((a, b) => toMillis(b.date) - toMillis(a.date))[0];

  const weeks = Array.isArray(program?.weeks) ? program.weeks : [];
  const throughMillis = computeThroughMillis(windowWorkouts, windowBodyweightRecords, windowed ? sinceMillis : 0);

  const out = {
    schema: ANALYSIS_SCHEMA,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    generatedAt: new Date(nowMillis).toISOString(),
    timeZone,
    app: { name: app.name ?? 'Deadlift Tracker', version: app.version ?? null },
    range: {
      mode: windowed ? RANGE_MODE.SINCE_LAST : RANGE_MODE.ALL,
      from: windowed ? isoOrNull(sinceMillis) : null,
      to: isoOrNull(throughMillis),
      workouts: windowWorkouts.length,
      performedWorkouts: performed.length,
      skippedWorkouts: skipped,
      newBodyweightEntries: windowBodyweightRecords.filter((m) => isNum(m.value)).length,
      historyMayBeTruncated: !!historyTruncated,
    },
    athlete: {
      unit: 'kg',
      latestBodyweightKg: latestBw ? latestBw.value : null,
      latestBodyweightDate: latestBw ? dayKey(toMillis(latestBw.date), timeZone) : null,
      lifts,
    },
    program: program ? {
      id: program.id ?? null,
      name: program.name ?? null,
      version: program.version ?? null,
      totalWeeks: totalWeeksOf(program) || null,
      currentWeek: run?.current?.week ?? null,
      currentDayOrder: run?.current?.dayOrder ?? null,
      weeks: weeks.map((w) => ({
        week: w.week,
        isDeload: !!w.isDeload,
        isPrAttempt: !!w.isPrAttempt,
        focus: w.focusFromOverview ?? w.focus ?? null,
      })),
    } : null,
    definitions: {
      units: 'kg; durations in minutes; dates are the lifter\'s calendar day in timeZone',
      setStatus: 'completed = done as planned; modified = done with a different weight/reps than planned; failed = attempted but not completed; skipped = not done; not_logged = left empty',
      countedSets: 'Only completed or modified WORKING sets with positive kg and reps count toward top weight, volume and 1RM numbers. Warm-up, failed, skipped and not-logged sets never do.',
      e1rm: `Estimated 1RM = kg × (1 + reps/30) (Epley), only from sets of 2-${EST_1RM_MAX_REPS} reps. A single (1 rep) is a tested max, not an estimate.`,
      skippedWorkouts: 'completionState "skipped" = lifter explicitly skipped the session; it carries no performance data. "partial" = some sets logged; "not_logged" = finished without logging sets.',
      trends: 'All-history, one point per workout and exercise (counted sets only), oldest first.',
      workouts: 'Full set-by-set detail for the range only.',
    },
    workouts: windowWorkouts.map((w) => workoutEntry(w, timeZone)),
    trends: buildTrends(completedWorkouts, timeZone),
    bodyweight: bodyweightRows(bodyweight, { sinceMillis, timeZone, windowed }),
    oneRepMaxHistory: maxHistoryRows(maxHistory, timeZone),
  };
  return { data: out, throughMillis };
}

/** The ready-made question to paste into Claude together with the file. */
export const ANALYSIS_PROMPT = `Priložen je izvoz iz moje aplikacije Deadlift Tracker (JSON). Molim te analiziraj moj napredak:

1. Što se promijenilo od zadnje analize (range.from → range.to): napredak, stagnacija, pad, po glavnim vježbama.
2. Procijenjeni i testirani 1RM u odnosu na moj cilj (athlete.lifts).
3. Kako je tekao program: preskočeni ili djelomični treninzi, odstupanja od plana (modified/failed setovi), RPE trend, bilješke uz treninge.
4. Tjelesna težina i njezin odnos prema snazi.
5. Konkretne preporuke za sljedeći tjedan/ciklus (opterećenja, volumen, oporavak) i što da testiram ili promijenim u programu.

Ako ti nešto u podacima nedostaje ili je dvosmisleno, reci mi prije zaključka.`;

/** Filename: deadlift-analysis-YYYY-MM-DD.json (lifter's local day). */
export function analysisFilename(nowMillis = Date.now(), timeZone = 'Europe/Zagreb') {
  return `deadlift-analysis-${dayKey(nowMillis, timeZone)}.json`;
}
