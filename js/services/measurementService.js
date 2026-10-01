import {
  collection, doc, writeBatch, query, where, orderBy, limit, getDocs, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';
import { getDocsSafe } from '../utils/firestoreRead.js';
import { sanitizeText, isValidWeight } from '../utils/validation.js';
import { commitTrainingBatch } from './trainingGenerationService.js';
import { getResetBoundaries } from './trainingResetService.js';
import { isArchivedMeasurement } from '../utils/trainingReset.js';

// v22: if an admin reset included the bodyweight log, entries older than
// bodyweightResetAt are hidden (and deleted in the background).
async function hideArchived(uid, entries) {
  const { bodyweight } = await getResetBoundaries(uid);
  return bodyweight ? entries.filter((e) => !isArchivedMeasurement(e, bodyweight)) : entries;
}

const measurementsCol = (uid) => collection(db, 'users', uid, 'measurements');

/** Returns the entry actually written, so callers can update the UI without a re-fetch. */
export async function logBodyweight(uid, { kg, note = '' }) {
  if (!isValidWeight(kg)) throw new Error('Enter a valid bodyweight in kg.');
  const entry = {
    type: 'bodyweight',
    value: kg,
    unit: 'kg',
    note: sanitizeText(note, 200),
  };
  // v22: committed with the admin-reset generation guard (trainingGenerationService.js).
  await trackWrite(() => {
    const batch = writeBatch(db);
    batch.set(doc(measurementsCol(uid)), { ...entry, date: serverTimestamp() });
    return commitTrainingBatch(uid, batch);
  });
  // serverTimestamp() resolves later on the server; give the caller a
  // client-side Date so it can render immediately without waiting on a
  // round trip or re-querying (and without writing a second document).
  return { ...entry, date: new Date() };
}

/**
 * Correction pass 6: routed through getDocsSafe (../utils/firestoreRead.js)
 * — a plain Home-dashboard read, same offline-hang risk as the rest of that
 * screen's dependency chain. An offline cache-miss safely defaults to "—"
 * (already how the existing null case renders), never a hang.
 */
export async function getLatestBodyweight(uid) {
  const q = query(
    measurementsCol(uid),
    where('type', '==', 'bodyweight'),
    orderBy('date', 'desc'),
    limit(1),
  );
  const snap = await getDocsSafe(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return (await hideArchived(uid, [{ id: d.id, ...d.data() }]))[0] ?? null;
}

/**
 * Phase 4 Progress dashboard: the full (bounded) bodyweight history, newest
 * first, for the Progress screen's trend. Same query shape as
 * getLatestBodyweight above (type ASC + date DESC), just with `limit(max)`
 * instead of `limit(1)` — reuses the EXACT SAME existing composite index
 * already declared in firestore.indexes.json (measurements: type ASC,
 * date DESC); no new index needed. js/utils/progressAnalytics.js's
 * bodyweightSeries() re-sorts these chronologically for charting — this
 * function itself stays newest-first, consistent with every other list*
 * function in this codebase (listCompletedWorkouts, etc.).
 */
export async function listBodyweightHistory(uid, max = 50) {
  const q = query(
    measurementsCol(uid),
    where('type', '==', 'bodyweight'),
    orderBy('date', 'desc'),
    limit(max),
  );
  const snap = await getDocs(q);
  return hideArchived(uid, snap.docs.map((d) => ({ id: d.id, ...d.data() })));
}
