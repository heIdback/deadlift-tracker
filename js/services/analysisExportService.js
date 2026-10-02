// v27 — data access for "Export for analysis" (the pure builder is
// js/utils/analysisExport.js). Reads only: workouts, bodyweight, 1RM history,
// profile, active program. The one write is the small "last analysis" marker
// on the user document (`analysisExport`), done only after the lifter has
// actually saved/shared the file.
import {
  doc, updateDoc, serverTimestamp, collection, query, orderBy, limit, getDocs,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';
import { getUserProfile } from './userService.js';
import { listCompletedWorkouts } from './workoutService.js';
import { listBodyweightHistory } from './measurementService.js';
import { getPrimaryProgramContext } from './programService.js';
import { getResetBoundaries } from './trainingResetService.js';
import { isArchivedMax } from '../utils/trainingReset.js';
import { toMillis } from '../utils/progressAnalytics.js';
import { APP_META } from '../../config/app.config.js';
import { buildAnalysisExport, RANGE_MODE } from '../utils/analysisExport.js';

// Upper bounds on what one export reads. A 7-8 week block is ~30 sessions, so
// these cover years of training; if a limit is ever hit the file says so
// (range.historyMayBeTruncated).
export const MAX_WORKOUTS = 400;
export const MAX_BODYWEIGHT = 500;
export const MAX_MAX_RECORDS = 300;

/** The marker stored on the profile → {lastAtMillis, throughMillis} (zeros when none). */
export function readAnalysisMarker(profile) {
  const m = profile?.analysisExport;
  return {
    lastAtMillis: toMillis(m?.lastAt),
    throughMillis: typeof m?.lastThroughMillis === 'number' && m.lastThroughMillis > 0 ? m.lastThroughMillis : 0,
  };
}

async function listAllMaxRecords(uid) {
  const q = query(
    collection(db, 'users', uid, 'maxes'),
    orderBy('effectiveDate', 'desc'),
    limit(MAX_MAX_RECORDS),
  );
  const snap = await getDocs(q);
  const { training } = await getResetBoundaries(uid);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => !isArchivedMax(d, training));
}

/**
 * Reads everything and builds the export.
 * @param {string} uid
 * @param {{mode?: string}} opts  RANGE_MODE.SINCE_LAST (default) or RANGE_MODE.ALL
 * @returns {Promise<{data:object, json:string, bytes:number, throughMillis:number|null, workoutCount:number, marker:object}>}
 */
export async function prepareAnalysisExport(uid, { mode = RANGE_MODE.SINCE_LAST } = {}) {
  const [profile, workouts, bodyweight, maxHistory, ctx] = await Promise.all([
    getUserProfile(uid),
    listCompletedWorkouts(uid, MAX_WORKOUTS),
    listBodyweightHistory(uid, MAX_BODYWEIGHT),
    listAllMaxRecords(uid),
    getPrimaryProgramContext(uid),
  ]);
  const marker = readAnalysisMarker(profile);
  const { data, throughMillis } = buildAnalysisExport({
    completedWorkouts: workouts,
    bodyweight,
    maxHistory,
    profile,
    program: ctx?.program ?? null,
    run: ctx?.run ?? null,
    mode,
    sinceMillis: marker.throughMillis,
    nowMillis: Date.now(),
    historyTruncated: workouts.length >= MAX_WORKOUTS || bodyweight.length >= MAX_BODYWEIGHT,
    app: { name: APP_META.name, version: APP_META.version },
  });
  const json = JSON.stringify(data, null, 2);
  return {
    data,
    json,
    bytes: new Blob([json]).size,
    throughMillis,
    workoutCount: data.range.workouts,
    marker,
  };
}

/**
 * Moves the "last analysis" marker forward to `throughMillis`. Never moves it
 * backwards. Fire-and-forget on purpose: Firestore write promises only
 * resolve once the server confirms, so awaiting would hang offline; the write
 * is queued locally and syncs when the connection returns.
 */
export function markAnalysisExported(uid, throughMillis, previousThroughMillis = 0) {
  if (typeof throughMillis !== 'number' || !(throughMillis > 0)) return;
  if (throughMillis < previousThroughMillis) return;
  trackWrite(() => updateDoc(doc(db, 'users', uid), {
    analysisExport: { lastAt: serverTimestamp(), lastThroughMillis: throughMillis },
  })).catch((err) => console.warn('[ANALYSIS] could not save the last-analysis marker', err));
}
