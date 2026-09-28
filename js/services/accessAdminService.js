// Admin-only access-record management (Phase 3C). Kept separate from
// core/access.js (which only ever resolves the CURRENT user's own record)
// so "administer other people's access" and "resolve my own access on
// startup" stay conceptually distinct, mirroring the rest of the app's
// core/ vs services/ split. Every write here is also independently
// enforced by firestore.rules (`isApprovedAdmin()`) — a non-admin calling
// these functions directly would simply have the write rejected.
import {
  collection, doc, getDoc, getDocs, updateDoc, serverTimestamp, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from '../core/firebase.js';
import { trackWrite } from '../core/sync-status.js';

const accessCol = () => collection(db, 'access');
const accessDocRef = (uid) => doc(db, 'access', uid);

/** All access records, newest request first. Requires the caller to be an approved admin (enforced by firestore.rules' `allow list`). */
export async function listAccessRecords() {
  const snap = await getDocs(query(accessCol(), orderBy('requestedAt', 'desc')));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * One target user's own access record (Phase 3F: Admin User Detail's
 * profile/role/status card). A single `get`, not the `list` above —
 * firestore.rules already allows this for any approved admin
 * (`allow get: if isOwner(uid) || isApprovedAdmin();`), independent of and
 * unchanged by Phase 3F.
 */
export async function getAccessRecord(targetUid) {
  const snap = await getDoc(accessDocRef(targetUid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Approves a pending user, or re-enables a previously disabled one — both
 * are the same underlying transition. Does NOT touch `/users/{targetUid}`
 * in any way: fitness-data initialization stays a separate concern that
 * happens naturally the next time that user's own session resolves its
 * (now-approved) access status (see core/access.js).
 */
export async function approveUser(adminUid, targetUid) {
  await trackWrite(() => updateDoc(accessDocRef(targetUid), {
    status: 'approved',
    approvedAt: serverTimestamp(),
    approvedBy: adminUid,
  }));
}

/** Disables a pending or approved user. Never deletes/touches their historical fitness data. */
export async function disableUser(adminUid, targetUid) {
  await trackWrite(() => updateDoc(accessDocRef(targetUid), {
    status: 'disabled',
    disabledAt: serverTimestamp(),
    disabledBy: adminUid,
  }));
}
