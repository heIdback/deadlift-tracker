// Rendered by router.js directly, the same way pending.js is, whenever the
// current user's access status is 'disabled'.
import { getCurrentUser, signOut } from '../core/auth.js';
import { escapeHtml } from '../utils/dom.js';

export async function mount(root) {
  const user = getCurrentUser();

  root.innerHTML = `
    <div class="access-screen">
      <div class="access-card">
        <h1 class="access-title">Access disabled</h1>
        <p class="access-body">An administrator has disabled access to this account. Your training history is kept and untouched — it's just not accessible while access is disabled.</p>
        ${user?.email ? `<p class="text-muted access-email">${escapeHtml(user.email)}</p>` : ''}
        <button type="button" class="btn btn-secondary btn-large" id="signout-btn">Sign out</button>
      </div>
    </div>`;

  root.querySelector('#signout-btn').addEventListener('click', async () => {
    if (confirm('Sign out?')) await signOut();
  });
}
