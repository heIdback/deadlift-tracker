// Rendered by router.js directly (not a normal hash-navigable route) for
// the 'pending', 'error', and 'offline-unavailable' access phases —
// whatever hash a signed-in, not-yet-approved user is sitting on or types
// manually, this is what actually renders. See core/access.js for the
// state machine and firestore.rules for the real enforcement behind it.
import { getCurrentUser, signOut } from '../core/auth.js';
import { recheckAccess } from '../core/access.js';
import { escapeHtml } from '../utils/dom.js';

const COPY = {
  pending: {
    title: 'Access requested',
    body: "Your access request is waiting for administrator approval. You'll be able to use the app as soon as an admin approves your account.",
  },
  error: {
    title: "Couldn't check your access",
    body: "We couldn't verify your access status. Check your connection and try again.",
  },
  // Phase 5A correction pass 2: offline, and this UID's access record was
  // never cached on this device — distinct from 'error' (which implies a
  // real failure) since this is an expected, everyday condition with one
  // clear resolution: reconnect once.
  'offline-unavailable': {
    title: "Access status unavailable offline",
    body: "Your access status isn't available offline yet. Reconnect once to verify access.",
  },
};

export async function mount(root, { variant = 'pending' } = {}) {
  const user = getCurrentUser();
  const { title, body } = COPY[variant] ?? COPY.pending;

  root.innerHTML = `
    <div class="access-screen">
      <div class="access-card">
        <h1 class="access-title">${title}</h1>
        <p class="access-body">${body}</p>
        ${user?.email ? `<p class="text-muted access-email">${escapeHtml(user.email)}</p>` : ''}
        <button type="button" class="btn btn-primary btn-large" id="recheck-btn">Recheck access</button>
        <button type="button" class="btn btn-secondary btn-large" id="signout-btn">Sign out</button>
        <p class="form-status" id="access-status" role="status"></p>
      </div>
    </div>`;

  root.querySelector('#recheck-btn').addEventListener('click', async (e) => {
    const btn = e.target;
    const status = root.querySelector('#access-status');
    btn.disabled = true;
    status.textContent = 'Checking…';
    try {
      await recheckAccess(getCurrentUser());
      // If approval has come through, core/access.js's state change is what
      // moves the app forward (router.js is subscribed to it) — nothing to
      // do here beyond clearing the status if we're still not approved.
      status.textContent = '';
    } catch (err) {
      console.error(err);
      status.textContent = `Error: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelector('#signout-btn').addEventListener('click', async () => {
    if (confirm('Sign out?')) await signOut();
  });
}
